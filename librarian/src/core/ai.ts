// The five model jobs (PLAN.md §10). Every feature calls models through
// here, never directly, so the admin can point each job at any
// OpenAI-compatible endpoint (Argos, Ollama, a whisper server, Kokoro, or a
// cloud provider) and tests can fake them with Deps.fetch.
//
//   chat   the one chat model (DM agent and the player harness, broker
//          answers, summaries)
//   audit  the small model: question routing, spoiler checks
//   audio  speech to text  (POST {base}/audio/transcriptions)
//   voice  text to speech  (POST {base}/audio/speech)
//   extra  embeddings      (POST {base}/embeddings)
//
// Where each job's settings come from: setJobResolver() (the models
// feature stores them, set in Admin → Models). Until one is set, the
// environment is used:
//   ALX_MODEL_<JOB>_URL, ALX_MODEL_<JOB>_MODEL, ALX_MODEL_<JOB>_KEY
//   falling back to MODEL_BASE_URL / LOCAL_LLM_URL and MODEL_API_KEY.
import type { Deps } from '../app.ts';

export type Job = 'chat' | 'audit' | 'audio' | 'voice' | 'extra';
export const JOBS: Job[] = ['chat', 'audit', 'audio', 'voice', 'extra'];

export interface JobConfig {
  /** Ends in /v1 (or wherever the OpenAI-style paths start). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Extra JSON fields sent with every request (e.g. a voice name). */
  options?: Record<string, unknown>;
}

/** No model is set for this job, or it could not be reached. Callers fall back. */
export class ModelUnavailable extends Error {
  job: Job;
  constructor(job: Job, message: string) { super(message); this.job = job; }
}

type Resolver = (d: Deps, job: Job) => JobConfig | null;

function envResolver(d: Deps, job: Job): JobConfig | null {
  const e = d.env;
  const J = job.toUpperCase();
  const base = e[`ALX_MODEL_${J}_URL`] || e.MODEL_BASE_URL || e.OPENAI_BASE_URL || (e.LOCAL_LLM_URL ? `${e.LOCAL_LLM_URL.replace(/\/$/, '')}/v1` : '');
  const model = e[`ALX_MODEL_${J}_MODEL`] || (job === 'chat' || job === 'audit' ? e.MODEL_NAME || '' : '');
  if (!base) return null;
  return { baseUrl: base.replace(/\/$/, ''), apiKey: e[`ALX_MODEL_${J}_KEY`] || e.MODEL_API_KEY || e.OPENAI_API_KEY || undefined, model: model || 'default' };
}

let resolver: Resolver = envResolver;
/** The models feature replaces the env resolver with saved settings. Pass null to go back to env only. */
export function setJobResolver(r: Resolver | null) { resolver = r ?? envResolver; }
export function jobConfig(d: Deps, job: Job): JobConfig | null { return resolver(d, job) ?? (resolver === envResolver ? null : envResolver(d, job)); }
export const hasJob = (d: Deps, job: Job) => !!jobConfig(d, job);

function need(d: Deps, job: Job): JobConfig {
  const c = jobConfig(d, job);
  if (!c) throw new ModelUnavailable(job, `No model is set for "${job}" (Admin → Models)`);
  return c;
}

async function post(d: Deps, job: Job, c: JobConfig, path: string, body: unknown, signal?: AbortSignal, raw = false): Promise<globalThis.Response> {
  const headers: Record<string, string> = {};
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
  let r: globalThis.Response;
  try {
    r = await d.fetch(c.baseUrl + path, { method: 'POST', headers, body: body instanceof FormData ? body : JSON.stringify(body), signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err;
    throw new ModelUnavailable(job, `The ${job} model did not answer: ${String(err?.message ?? err).slice(0, 160)}`);
  }
  if (!r.ok && !raw) {
    const t = await r.text().catch(() => '');
    throw new ModelUnavailable(job, `The ${job} model returned ${r.status}: ${t.slice(0, 200)}`);
  }
  return r;
}

// ---- chat ------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ChatTool[];
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object back (response_format json_object). */
  json?: boolean;
}
export interface ChatResult { content: string; toolCalls: ToolCall[]; finishReason: string | null; usage?: unknown }

export async function chat(d: Deps, job: 'chat' | 'audit', req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
  const c = need(d, job);
  const body: Record<string, unknown> = {
    ...c.options,
    model: c.model,
    messages: req.messages,
    temperature: req.temperature ?? (job === 'audit' ? 0 : 0.4),
    stream: false,
  };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  if (req.tools?.length) body.tools = req.tools;
  if (req.json) body.response_format = { type: 'json_object' };
  const r = await post(d, job, c, '/chat/completions', body, signal);
  const j: any = await r.json().catch(() => null);
  const m = j?.choices?.[0]?.message;
  if (!m) throw new ModelUnavailable(job, `The ${job} model sent no message`);
  return { content: typeof m.content === 'string' ? m.content : '', toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls : [], finishReason: j.choices[0].finish_reason ?? null, usage: j.usage };
}

/** A JSON answer from a chat job, or null if the model is missing or its reply isn't JSON. Never throws for a model problem. */
export async function chatJson<T = any>(d: Deps, job: 'chat' | 'audit', messages: ChatMessage[], signal?: AbortSignal): Promise<T | null> {
  try {
    const r = await chat(d, job, { messages, json: true, temperature: 0 }, signal);
    const t = r.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    return s >= 0 && e > s ? JSON.parse(t.slice(s, e + 1)) : null;
  } catch (err) {
    if (err instanceof ModelUnavailable || err instanceof SyntaxError) return null;
    throw err;
  }
}

// ---- audio: speech to text -------------------------------------------------

export interface TranscriptWord { word: string; start: number; end: number; probability?: number }
export interface TranscriptSegment { start: number; end: number; text: string; avgLogprob?: number; noSpeechProb?: number; words?: TranscriptWord[] }
export interface Transcript { text: string; language?: string; segments: TranscriptSegment[] }

export async function transcribe(d: Deps, audio: Uint8Array, mime: string, opts: { prompt?: string; language?: string; filename?: string } = {}, signal?: AbortSignal): Promise<Transcript> {
  const c = need(d, 'audio');
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime }), opts.filename ?? `chunk.${mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm'}`);
  fd.append('model', c.model);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  if (opts.prompt) fd.append('prompt', opts.prompt.slice(0, 900));
  if (opts.language) fd.append('language', opts.language);
  const r = await post(d, 'audio', c, '/audio/transcriptions', fd, signal);
  const j: any = await r.json().catch(() => ({}));
  const segs: TranscriptSegment[] = (Array.isArray(j.segments) ? j.segments : []).map((s: any) => ({
    start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? '').trim(),
    avgLogprob: typeof s.avg_logprob === 'number' ? s.avg_logprob : undefined,
    noSpeechProb: typeof s.no_speech_prob === 'number' ? s.no_speech_prob : undefined,
    words: Array.isArray(s.words) ? s.words.map((w: any) => ({ word: String(w.word ?? ''), start: Number(w.start) || 0, end: Number(w.end) || 0, probability: typeof w.probability === 'number' ? w.probability : undefined })) : undefined,
  }));
  // Some servers put words at the top level only.
  if (Array.isArray(j.words) && segs.length && !segs.some((s) => s.words)) {
    for (const s of segs) s.words = j.words.filter((w: any) => w.start >= s.start && w.end <= s.end + 0.01).map((w: any) => ({ word: String(w.word), start: Number(w.start), end: Number(w.end), probability: w.probability }));
  }
  if (!segs.length && j.text) segs.push({ start: 0, end: Number(j.duration) || 0, text: String(j.text).trim() });
  return { text: String(j.text ?? segs.map((s) => s.text).join(' ')).trim(), language: j.language, segments: segs };
}

// ---- voice: text to speech -------------------------------------------------

export async function speak(d: Deps, text: string, opts: { voice?: string; speed?: number; format?: 'mp3' | 'wav' | 'opus' } = {}, signal?: AbortSignal): Promise<{ audio: Uint8Array; mime: string }> {
  const c = need(d, 'voice');
  const format = opts.format ?? 'mp3';
  const r = await post(d, 'voice', c, '/audio/speech', { ...c.options, model: c.model, input: text.slice(0, 4000), voice: opts.voice ?? (c.options?.voice as string) ?? 'af_heart', speed: opts.speed ?? 1, response_format: format }, signal);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { audio: buf, mime: r.headers.get('content-type') ?? (format === 'mp3' ? 'audio/mpeg' : format === 'wav' ? 'audio/wav' : 'audio/ogg') };
}

// ---- extra: embeddings -----------------------------------------------------

export async function embed(d: Deps, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const c = need(d, 'extra');
  const r = await post(d, 'extra', c, '/embeddings', { model: c.model, input: texts }, signal);
  const j: any = await r.json().catch(() => ({}));
  return (j.data ?? []).map((x: any) => x.embedding as number[]);
}
