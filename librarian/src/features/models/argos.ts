// Argos (the user's own model gateway) answers every model job at one address
// and routes by model name. These helpers read what it says about itself:
//
//   GET /v1/models            per model: id, name, description, status.value
//                             (loaded | unloaded), architecture.input_modalities /
//                             output_modalities, capabilities (vision, tools,
//                             reranker ...), context_length
//   GET /v1/audio/voices      ?model=<tts model>: the preset voice names
//
// discover() turns that into a suggestion per job. It leaves a job unset
// (with the reason) whenever the metadata does not make the answer clear.
import type { Deps } from '../../app.ts';
import { JOBS, type Job } from '../../core/ai.ts';

export type ModelStatus = 'loaded' | 'unloaded' | 'unknown';

export interface DiscoveredModel {
  id: string;
  name: string;
  description: string;
  status: ModelStatus;
  inputModalities: string[];
  outputModalities: string[];
  vision: boolean;
  tools: boolean;
  reranker: boolean;
  contextLength: number | null;
  /** What this model looks like it is for, from its metadata alone. */
  role: 'chat' | 'text' | 'audio' | 'voice' | 'extra' | 'rerank' | 'other' | 'unknown';
}

export interface Suggestion { model: string | null; reason: string }
export type Suggestions = Record<Job, Suggestion>;

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : []);

/** One /v1/models record, tolerant of servers that send less than Argos does. */
export function normalizeModel(r: any): DiscoveredModel | null {
  const id = typeof r?.id === 'string' ? r.id : '';
  if (!id) return null;
  const caps = r?.capabilities && typeof r.capabilities === 'object' ? r.capabilities : {};
  const st = String(r?.status?.value ?? r?.status ?? '').toLowerCase();
  const ctx = Number(r?.context_length ?? r?.context_window ?? r?.meta?.n_ctx);
  const m: DiscoveredModel = {
    id,
    name: typeof r.name === 'string' && r.name ? r.name : id,
    description: typeof r.description === 'string' ? r.description : '',
    status: st === 'loaded' || st === 'unloaded' ? st : 'unknown',
    inputModalities: strs(r?.architecture?.input_modalities),
    outputModalities: strs(r?.architecture?.output_modalities),
    vision: !!caps.vision,
    tools: !!(caps.tools || caps.function_calling),
    reranker: !!caps.reranker,
    contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
    role: 'unknown',
  };
  m.role = roleOf(m);
  return m;
}

const hint = (m: DiscoveredModel) => `${m.id} ${m.name} ${m.description}`.toLowerCase();
const EMBED = /embed/;
const RERANK = /rerank/;
const STT_NAME = /whisper|stt|transcri|parakeet|canary|speech.to.text/;
const AUDITOR = /audit|classif|moderat|guard|router/;

function roleOf(m: DiscoveredModel): DiscoveredModel['role'] {
  const h = hint(m);
  const hasArch = m.inputModalities.length > 0 || m.outputModalities.length > 0;
  if (m.reranker || RERANK.test(h)) return 'rerank';
  if (m.outputModalities.includes('audio')) return 'voice';
  if (m.inputModalities.includes('audio') && m.outputModalities.includes('text') && (!m.tools || STT_NAME.test(h))) return 'audio';
  if (EMBED.test(h)) return 'extra';
  if (m.outputModalities.includes('image') || m.outputModalities.includes('video')) return 'other';
  if (m.inputModalities.includes('text') && m.outputModalities.includes('text')) return m.tools ? 'chat' : 'text';
  return hasArch ? 'other' : 'unknown';
}

/** "Qwen3-4B" is 4, "gemma-3-27b-it" is 27: a size in billions when the name has one. */
const SIZE = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i;
const sizeB = (m: DiscoveredModel): number | null => {
  const x = SIZE.exec(m.id) ?? SIZE.exec(m.name);
  return x ? Number(x[1]) : null;
};

const pickBest = (ms: DiscoveredModel[]): DiscoveredModel =>
  [...ms].sort((a, b) => Number(b.status === 'loaded') - Number(a.status === 'loaded') || (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.id.localeCompare(b.id))[0];

const alsoNote = (ms: DiscoveredModel[], picked: DiscoveredModel) => {
  const rest = ms.filter((x) => x.id !== picked.id).map((x) => x.id);
  return rest.length ? ` Other candidates: ${rest.slice(0, 4).join(', ')}.` : '';
};

/** A suggested model for every job, from the metadata only. A job it cannot decide stays null, with the reason. */
export function suggestJobs(models: DiscoveredModel[]): Suggestions {
  const out = {} as Suggestions;
  const by = (role: DiscoveredModel['role']) => models.filter((m) => m.role === role);
  const unset = (reason: string): Suggestion => ({ model: null, reason });

  const chats = by('chat');
  const chatPick = chats.length ? pickBest(chats) : null;
  out.chat = chatPick
    ? { model: chatPick.id, reason: `Text in and out with tool calling${chatPick.contextLength ? `, ${chatPick.contextLength} token context` : ''}.${alsoNote(chats, chatPick)}` }
    : unset(models.some((m) => m.role === 'text' || m.role === 'unknown')
      ? 'No text model says it can call tools, which the assistant needs. Choose the chat model yourself.'
      : 'No text chat model was listed.');

  const pool = models.filter((m) => (m.role === 'text' || m.role === 'chat') && m.id !== chatPick?.id);
  const named = pool.filter((m) => AUDITOR.test(hint(m)));
  if (named.length) {
    const p = pickBest(named);
    out.audit = { model: p.id, reason: `Named like an auditor or classifier.${alsoNote(named, p)}` };
  } else if (pool.length) {
    const sized = pool.map((m) => ({ m, s: sizeB(m) ?? Infinity, c: m.contextLength ?? Infinity }));
    sized.sort((a, b) => a.s - b.s || a.c - b.c || a.m.id.localeCompare(b.m.id));
    const best = sized[0];
    out.audit = best.s === Infinity && best.c === Infinity && pool.length > 1
      ? unset('Several text models and nothing says which is smallest. Choose the audit model yourself.')
      : { model: best.m.id, reason: `The smallest text model${best.s !== Infinity ? ` (${best.s}B)` : ''}.${alsoNote(pool, best.m)}` };
  } else {
    out.audit = unset(chatPick ? 'Only one text model, and it is the chat model. Add a small one, or point audit at the chat model yourself.' : 'No text model was listed.');
  }

  const one = (job: Job, role: DiscoveredModel['role'], what: string, none: string) => {
    const ms = by(role);
    if (!ms.length) { out[job] = unset(none); return; }
    let p = pickBest(ms);
    if (job === 'audio') { const named = ms.filter((m) => STT_NAME.test(hint(m))); if (named.length) p = pickBest(named); }
    out[job] = { model: p.id, reason: `${what}.${alsoNote(ms, p)}` };
  };
  one('audio', 'audio', 'Audio in, text out (speech to text)', 'No speech to text model (audio in, text out) was listed.');
  one('voice', 'voice', 'Audio out (text to speech)', 'No text to speech model (audio out) was listed.');
  one('extra', 'extra', 'Its name or description says it makes embeddings', 'No embeddings model was listed (none mentions "embed").');
  one('rerank', 'rerank', 'Marked as a reranker', 'No reranker was listed. Search keeps its keyword order, which is fine.');
  for (const j of JOBS) out[j] ??= unset('Not decided.');
  return out;
}

// ---- talking to Argos --------------------------------------------------------

export interface ProviderLike { baseUrl: string; apiKey?: string }

/** Add /v1 to a bare address ("http://argos:8080"); Argos always serves under /v1. */
export function normalizeArgosUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  return /\/v1$/i.test(s) ? s : `${s}/v1`;
}
/** The Argos web page: the address without /v1. */
export const argosWebUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') || baseUrl;

const authHeaders = (p: ProviderLike): Record<string, string> => (p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {});

async function getJson(d: Deps, p: ProviderLike, path: string, ms = 8000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await d.fetch(p.baseUrl.replace(/\/+$/, '') + path, { headers: authHeaders(p), signal: ctl.signal });
    const text = await r.text();
    if (!r.ok) {
      let said = text.trim().slice(0, 160);
      try { const j = JSON.parse(text); said = String(j?.error?.message ?? j?.error ?? j?.message ?? said).slice(0, 160); } catch { /* plain text */ }
      if (r.status === 401 || r.status === 403) throw new Error(`The server rejected the API key (${r.status}). ${said}`.trim());
      throw new Error(`The server answered ${r.status}${said ? `: ${said}` : ''}`);
    }
    try { return JSON.parse(text); } catch { throw new Error('The server did not answer with JSON. Is this the right address?'); }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error(`No answer within ${Math.round(ms / 1000)} seconds`);
    if (err?.cause?.code || /fetch failed/i.test(String(err?.message))) throw new Error(`Could not reach ${p.baseUrl}: ${String(err?.cause?.message ?? err?.message).slice(0, 120)}`);
    throw err;
  } finally { clearTimeout(t); }
}

export async function listModels(d: Deps, p: ProviderLike): Promise<DiscoveredModel[]> {
  const j = await getJson(d, p, '/models');
  const rows: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
  return rows.map(normalizeModel).filter((m): m is DiscoveredModel => !!m);
}

/** The preset voice names of a text to speech model, from GET /v1/audio/voices. Throws when the server has no such endpoint. */
export async function fetchVoices(d: Deps, p: ProviderLike, model?: string): Promise<string[]> {
  const j = await getJson(d, p, `/audio/voices${model ? `?model=${encodeURIComponent(model)}` : ''}`);
  const rows: any[] = Array.isArray(j) ? j : Array.isArray(j?.voices) ? j.voices : Array.isArray(j?.data) ? j.data : [];
  const names = rows.map((v) => (typeof v === 'string' ? v : String(v?.id ?? v?.voice_id ?? v?.name ?? ''))).filter(Boolean);
  return [...new Set(names)];
}

export interface Discovery {
  models: DiscoveredModel[];
  suggestions: Suggestions;
  /** Preset voices of the suggested voice model, when the server lists them. */
  voices: string[];
}

/** List the models and suggest one per job. Voices are best effort: a server without /audio/voices just has none. */
export async function discover(d: Deps, p: ProviderLike): Promise<Discovery> {
  const models = await listModels(d, p);
  const suggestions = suggestJobs(models);
  let voices: string[] = [];
  const vm = suggestions.voice.model;
  if (vm) { try { voices = await fetchVoices(d, p, vm); } catch { /* no voices endpoint */ } }
  return { models, suggestions, voices };
}
