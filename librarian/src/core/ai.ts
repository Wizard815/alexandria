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
  /**
   * Extra JSON fields sent with every request (e.g. a voice name). These keys
   * are read by Alexandria and never sent: see JOB_OPTION_KEYS.
   */
  options?: Record<string, unknown>;
}

/**
 * Job options Alexandria reads itself (they are removed from the request body):
 *   maxTokensParam  'max_tokens' | 'max_completion_tokens' | 'auto' (default auto:
 *                   max_completion_tokens for api.openai.com, max_tokens elsewhere)
 *   noTemperature   true when the model rejects `temperature` (OpenAI reasoning models)
 *   jsonMode        'auto' | 'schema' | 'object' | 'off' (how structured output is asked for)
 *   timeoutMs       give up after this long without an answer (default 120000 for chat)
 */
export const JOB_OPTION_KEYS = ['maxTokensParam', 'noTemperature', 'jsonMode', 'timeoutMs'] as const;

/** No model is set for this job, or it could not be reached. Callers fall back. */
export class ModelUnavailable extends Error {
  job: Job;
  /** The HTTP status the server answered with, if it answered. */
  status?: number;
  constructor(job: Job, message: string, status?: number) { super(message); this.job = job; this.status = status; }
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

// ---- transport -------------------------------------------------------------

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_OTHER_TIMEOUT_MS = 300_000;
const MAX_429_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 15_000;

const isOpenAI = (c: JobConfig) => /^https?:\/\/api\.openai\.com(\/|$)/i.test(c.baseUrl);
const opt = (c: JobConfig, k: (typeof JOB_OPTION_KEYS)[number]) => c.options?.[k];
const timeoutFor = (job: Job, c: JobConfig): number => {
  const t = Number(opt(c, 'timeoutMs'));
  return Number.isFinite(t) && t > 0 ? t : job === 'chat' || job === 'audit' ? DEFAULT_CHAT_TIMEOUT_MS : DEFAULT_OTHER_TIMEOUT_MS;
};
/** The job's options as request fields: everything except the keys Alexandria reads itself. */
const bodyOptions = (c: JobConfig): Record<string, unknown> => {
  const o: Record<string, unknown> = { ...c.options };
  for (const k of JOB_OPTION_KEYS) delete o[k];
  return o;
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** An abort signal that also fires after `ms` without activity. touch() restarts the clock. */
class Guard {
  controller = new AbortController();
  timedOut = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  private ms: number;
  constructor(ms: number, caller?: AbortSignal) {
    this.ms = ms;
    if (caller) {
      if (caller.aborted) this.controller.abort();
      else { const f = () => this.controller.abort(); caller.addEventListener('abort', f, { once: true }); this.off = () => caller.removeEventListener('abort', f); }
    }
    this.touch();
  }
  get signal() { return this.controller.signal; }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timedOut = true; this.controller.abort(); }, this.ms);
  }
  clear() { clearTimeout(this.timer); this.off?.(); }
}

/** What the server said, in a few words (OpenAI-style { error: { message } } or plain text). */
function serverMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail;
    if (typeof m === 'string') return m.slice(0, 300);
    if (m) return JSON.stringify(m).slice(0, 300);
  } catch { /* plain text */ }
  return text.trim().slice(0, 300);
}

function failure(job: Job, c: JobConfig, status: number, text: string, retryAfterMs?: number): ModelUnavailable {
  const said = serverMessage(text);
  const tail = said ? `: ${said}` : '';
  if (status === 401 || status === 403) return new ModelUnavailable(job, `The ${job} model rejected the API key (${status}). Check the key in Admin → Models${tail}`, status);
  if (status === 404) return new ModelUnavailable(job, `The ${job} model "${c.model}" was not found at ${c.baseUrl} (404). Check the model name and base URL in Admin → Models${tail}`, status);
  if (status === 429) {
    const quota = /insufficient_quota|exceeded your current quota/i.test(text);
    return new ModelUnavailable(job, quota ? `The ${job} model's account is out of quota (429)${tail}` : `The ${job} model is rate limited (429)${retryAfterMs ? `, retry after ${Math.ceil(retryAfterMs / 1000)}s` : ''}. Try again shortly${tail}`, status);
  }
  return new ModelUnavailable(job, `The ${job} model returned ${status}${tail}`, status);
}

function retryAfter(r: globalThis.Response, attempt: number): number {
  const h = r.headers.get('retry-after');
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 1000 * 2 ** attempt;
}

interface Sent { r: globalThis.Response; guard: Guard; attempts: number; ttfbMs: number }

/**
 * POST once (retrying a 429 after Retry-After). Any other answer, ok or not,
 * is returned for the caller to look at. The guard's clock keeps running: the
 * caller clears it when the body is done (streams touch() it per chunk).
 */
async function send(d: Deps, job: Job, c: JobConfig, path: string, body: unknown, signal?: AbortSignal): Promise<Sent> {
  const headers: Record<string, string> = {};
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
  const payload = body instanceof FormData ? body : JSON.stringify(body);
  const ms = timeoutFor(job, c);
  for (let n = 0; ; n++) {
    const guard = new Guard(ms, signal);
    const t0 = performance.now();
    let r: globalThis.Response;
    try {
      r = await d.fetch(c.baseUrl + path, { method: 'POST', headers, body: payload, signal: guard.signal });
    } catch (err: any) {
      guard.clear();
      if (guard.timedOut) throw new ModelUnavailable(job, `The ${job} model did not answer within ${Math.round(ms / 1000)}s (raise timeoutMs in the job's options if it is just slow)`);
      if (err?.name === 'AbortError') throw err;
      throw new ModelUnavailable(job, `The ${job} model did not answer: ${String(err?.message ?? err).slice(0, 160)}`);
    }
    if (r.status === 429 && n < MAX_429_RETRIES) {
      const wait = Math.min(retryAfter(r, n), MAX_RETRY_WAIT_MS);
      const text = await r.text().catch(() => '');
      guard.clear();
      if (/insufficient_quota|exceeded your current quota/i.test(text)) throw failure(job, c, 429, text);
      await sleep(wait, signal);
      continue;
    }
    return { r, guard, attempts: n + 1, ttfbMs: performance.now() - t0 };
  }
}

async function post(d: Deps, job: Job, c: JobConfig, path: string, body: unknown, signal?: AbortSignal, raw = false): Promise<globalThis.Response> {
  const s = await send(d, job, c, path, body, signal);
  s.guard.clear();
  if (!s.r.ok && !raw) {
    const t = await s.r.text().catch(() => '');
    throw failure(job, c, s.r.status, t, s.r.status === 429 ? retryAfter(s.r, MAX_429_RETRIES) : undefined);
  }
  return s.r;
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
  /** 'auto' (default), 'none', 'required', or force one function by name. */
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  /** Let the model call several tools in one turn (sent only with tools). */
  parallelToolCalls?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object back (response_format json_object). */
  json?: boolean;
  /** Ask for JSON matching a schema (response_format json_schema); falls back to json_object, then to a prompt-only instruction. */
  jsonSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
}
export interface ChatTimings {
  /** Whole call, retries included. */
  totalMs: number;
  /** Until the server's response headers arrived. */
  firstByteMs: number;
  /** Until the first content token (streaming only). */
  firstTokenMs?: number;
  /** Requests sent: 1 normally, more after a 429 or an adaptation retry. */
  attempts: number;
  /** How structured output was asked for: 'schema', 'object', 'prompt' (instruction only) or 'none'. */
  jsonMode: 'schema' | 'object' | 'prompt' | 'none';
}
export interface ChatResult { content: string; toolCalls: ToolCall[]; finishReason: string | null; usage?: unknown; timings?: ChatTimings }

// What each server turned out to accept, learned from 400s and remembered per job and model.
type JsonMode = 'schema' | 'object' | 'off';
interface Learned { json?: JsonMode; tokens?: 'max_tokens' | 'max_completion_tokens'; noTemp?: boolean; noStreamOptions?: boolean; noParallel?: boolean }
const learned = new Map<string, Learned>();
const learnKey = (job: Job, c: JobConfig) => `${job}|${c.baseUrl}|${c.model}`;
const learnedFor = (job: Job, c: JobConfig): Learned => { const k = learnKey(job, c); let l = learned.get(k); if (!l) learned.set(k, (l = {})); return l; };
/** What this process has learned about a job's server (for the admin and tests). */
export function learnedModes(d: Deps, job: Job): Learned | null { const c = jobConfig(d, job); return c ? { ...learnedFor(job, c) } : null; }
/** Forget what was learned (tests; or after the admin changes a job). */
export function forgetLearned() { learned.clear(); }

const JSON_RANK: Record<JsonMode, number> = { off: 0, object: 1, schema: 2 };

function jsonModeFor(c: JobConfig, req: ChatRequest, l: Learned): JsonMode | null {
  if (!req.json && !req.jsonSchema) return null;
  let m: JsonMode = req.jsonSchema ? 'schema' : 'object';
  const o = opt(c, 'jsonMode');
  const cap: JsonMode | null = o === 'off' ? 'off' : o === 'object' ? 'object' : o === 'schema' ? 'schema' : null;
  if (cap && JSON_RANK[cap] < JSON_RANK[m]) m = cap;
  if (l.json && JSON_RANK[l.json] < JSON_RANK[m]) m = l.json;
  return m;
}

const JSON_HINT = 'Reply with a single valid JSON object and nothing else: no prose and no code fences.';

function buildBody(job: Job, c: JobConfig, req: ChatRequest, stream: boolean, l: Learned): { body: Record<string, unknown>; json: ChatTimings['jsonMode'] } {
  const jm = jsonModeFor(c, req, l);
  let messages = req.messages;
  const body: Record<string, unknown> = { ...bodyOptions(c), model: c.model, stream };
  if (jm === 'off') {
    const i = messages.findIndex((m) => m.role === 'system');
    messages = i >= 0 ? messages.map((m, j) => (j === i ? { ...m, content: `${m.content ?? ''}\n\n${JSON_HINT}` } : m)) : [{ role: 'system', content: JSON_HINT }, ...messages];
  }
  body.messages = messages;
  const noTemp = opt(c, 'noTemperature') === true || l.noTemp;
  if (!noTemp) body.temperature = req.temperature ?? (job === 'audit' ? 0 : 0.4);
  if (req.maxTokens) {
    const o = opt(c, 'maxTokensParam');
    const param = o === 'max_tokens' || o === 'max_completion_tokens' ? o : l.tokens ?? (isOpenAI(c) ? 'max_completion_tokens' : 'max_tokens');
    body[param] = req.maxTokens;
  }
  if (req.tools?.length) {
    body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = typeof req.toolChoice === 'string' ? req.toolChoice : { type: 'function', function: { name: req.toolChoice.name } };
    if (req.parallelToolCalls !== undefined && !l.noParallel) body.parallel_tool_calls = req.parallelToolCalls;
  }
  if (jm === 'schema' && req.jsonSchema) body.response_format = { type: 'json_schema', json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: req.jsonSchema.strict ?? false } };
  else if (jm === 'object' || jm === 'schema') body.response_format = { type: 'json_object' };
  if (stream && !l.noStreamOptions) body.stream_options = { include_usage: true };
  return { body, json: jm === null ? 'none' : jm === 'off' ? 'prompt' : jm };
}

/** After a 400: change what we send so the same request can work. false if there is nothing to change. */
function learnFrom400(text: string, body: Record<string, unknown>, c: JobConfig, l: Learned): boolean {
  const t = text.toLowerCase();
  const mentions = (re: RegExp) => re.test(t);
  if (mentions(/stream_options|include_usage/) && body.stream_options) { l.noStreamOptions = true; return true; }
  if (mentions(/parallel_tool_calls/) && body.parallel_tool_calls !== undefined) { l.noParallel = true; return true; }
  if (mentions(/max_completion_tokens|max_tokens/) && (body.max_tokens !== undefined || body.max_completion_tokens !== undefined)) {
    const cur = body.max_tokens !== undefined ? 'max_tokens' : 'max_completion_tokens';
    const o = opt(c, 'maxTokensParam');
    if (o === 'max_tokens' || o === 'max_completion_tokens') return false;
    l.tokens = cur === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    return true;
  }
  if (mentions(/temperature/) && body.temperature !== undefined) { l.noTemp = true; return true; }
  // llama-server, Ollama, LM Studio and vLLM word a bad response_format differently, or say nothing useful.
  const rf: any = body.response_format;
  if (rf) { l.json = rf.type === 'json_schema' ? 'object' : 'off'; return true; }
  return false;
}

/** Send a chat request, adapting to what the server accepts. */
async function chatSend(d: Deps, job: 'chat' | 'audit', c: JobConfig, req: ChatRequest, stream: boolean, signal?: AbortSignal): Promise<Sent & { jsonMode: ChatTimings['jsonMode'] }> {
  const known = learnedFor(job, c);
  // Changes learned from a 400 only stick once a retry works (a 400 can be about something else).
  const l: Learned = { ...known };
  let attempts = 0;
  for (let n = 0; n < 6; n++) {
    const { body, json } = buildBody(job, c, req, stream, l);
    const s = await send(d, job, c, '/chat/completions', body, signal);
    attempts += s.attempts;
    if (s.r.ok) { Object.assign(known, l); return { ...s, attempts, jsonMode: json }; }
    const text = await s.r.text().catch(() => '');
    s.guard.clear();
    if (s.r.status === 400 && learnFrom400(text, body, c, l)) continue;
    throw failure(job, c, s.r.status, text, s.r.status === 429 ? retryAfter(s.r, MAX_429_RETRIES) : undefined);
  }
  throw new ModelUnavailable(job, `The ${job} model kept rejecting the request (400)`, 400);
}

const callId = (i: number) => `call_${Date.now().toString(36)}${i}${Math.random().toString(36).slice(2, 6)}`;

/** Tool calls as the OpenAI API shapes them: an id, and arguments as a string (llama-server and Ollama sometimes differ). */
function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCall[] = [];
  raw.forEach((t: any, i) => {
    const name = t?.function?.name;
    if (typeof name !== 'string' || !name) return;
    const a = t.function.arguments;
    out.push({ id: typeof t.id === 'string' && t.id ? t.id : callId(i), type: 'function', function: { name, arguments: typeof a === 'string' ? a || '{}' : a && typeof a === 'object' ? JSON.stringify(a) : '{}' } });
  });
  return out;
}

export async function chat(d: Deps, job: 'chat' | 'audit', req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
  const c = need(d, job);
  const t0 = performance.now();
  const s = await chatSend(d, job, c, req, false, signal);
  let j: any;
  try { j = await s.r.json(); } catch { j = null; } finally { s.guard.clear(); }
  const m = j?.choices?.[0]?.message;
  if (!m) throw new ModelUnavailable(job, `The ${job} model sent no message`);
  const toolCalls = normalizeToolCalls(m.tool_calls);
  const totalMs = performance.now() - t0;
  return {
    content: typeof m.content === 'string' ? m.content : '', toolCalls,
    finishReason: toolCalls.length && j.choices[0].finish_reason !== 'tool_calls' ? 'tool_calls' : j.choices[0].finish_reason ?? null,
    usage: j.usage, timings: { totalMs, firstByteMs: s.ttfbMs, attempts: s.attempts, jsonMode: s.jsonMode },
  };
}

// ---- chat: streaming ---------------------------------------------------------

interface PartialCall { id: string; name: string; args: string }

/**
 * Builds a ChatResult from OpenAI-style streaming chunks. Feed it the text
 * as it arrives; it understands `data:` lines, [DONE], content deltas, tool
 * call deltas (by index, with llama-server's missing ids and indexes), usage
 * chunks and in-stream errors.
 */
export class ChunkAssembler {
  content = '';
  finishReason: string | null = null;
  usage: unknown;
  done = false;
  private calls: PartialCall[] = [];
  private buf = '';
  private fullMessage = false;
  private onDelta?: (text: string) => void;
  private job: Job;
  constructor(onDelta?: (text: string) => void, job: Job = 'chat') { this.onDelta = onDelta; this.job = job; }

  feed(text: string) {
    this.buf += text;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.line(line);
    }
  }
  end() { if (this.buf.trim()) this.line(this.buf.replace(/\r$/, '')); this.buf = ''; }

  private line(line: string) {
    if (!line.startsWith('data:')) return; // comments (": ping"), "event:", "id:" and blank lines
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { this.done = true; return; }
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j?.error) throw new ModelUnavailable(this.job, `The ${this.job} model failed mid-answer: ${serverMessage(JSON.stringify(j))}`);
    if (j?.usage) this.usage = j.usage;
    const ch = j?.choices?.[0];
    if (!ch) return;
    const delta = ch.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) { this.content += delta.content; this.onDelta?.(delta.content); }
    else if (typeof ch.text === 'string' && ch.text && !ch.delta) { this.content += ch.text; this.onDelta?.(ch.text); }
    const tcs = delta.tool_calls;
    if (Array.isArray(tcs)) for (const t of tcs) this.toolDelta(t);
    // A server that ends the stream with a whole message instead of deltas.
    if (!ch.delta && ch.message && !this.content && !this.calls.length) {
      const m = ch.message;
      if (typeof m.content === 'string' && m.content) { this.content = m.content; this.onDelta?.(m.content); }
      for (const t of normalizeToolCalls(m.tool_calls)) this.calls.push({ id: t.id, name: t.function.name, args: t.function.arguments });
      this.fullMessage = true;
    }
    if (ch.finish_reason) this.finishReason = ch.finish_reason;
  }

  private toolDelta(t: any) {
    if (!t || typeof t !== 'object') return;
    let idx: number;
    if (typeof t.index === 'number') idx = t.index;
    else if (t.id && (!this.calls.length || this.calls[this.calls.length - 1].id !== t.id)) idx = this.calls.length;
    else idx = Math.max(0, this.calls.length - 1);
    // Indexes may skip or start at 1; keep them in order of arrival.
    while (this.calls.length <= idx) this.calls.push({ id: '', name: '', args: '' });
    const e = this.calls[idx];
    if (typeof t.id === 'string' && t.id && !e.id) e.id = t.id;
    const f = t.function ?? {};
    if (typeof f.name === 'string' && f.name) { if (!e.name) e.name = f.name; else if (e.name !== f.name) e.name += f.name; }
    if (typeof f.arguments === 'string') e.args += f.arguments;
    else if (f.arguments && typeof f.arguments === 'object') e.args += JSON.stringify(f.arguments);
  }

  toolCalls(): ToolCall[] {
    return this.calls.filter((c) => c.name).map((c, i) => ({ id: c.id || callId(i), type: 'function' as const, function: { name: c.name, arguments: c.args.trim() || '{}' } }));
  }
  get assembledWhole() { return this.fullMessage; }
}

/**
 * Like chat(), but streams: onDelta gets each piece of content as it
 * arrives, and the returned ChatResult is the same one chat() would give.
 * Tool calls arrive in pieces and are assembled before returning. Pass a
 * signal to stop early (it throws AbortError; keep what onDelta gave you).
 */
export async function chatStream(d: Deps, job: 'chat' | 'audit', req: ChatRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<ChatResult> {
  const c = need(d, job);
  const t0 = performance.now();
  const s = await chatSend(d, job, c, req, true, signal);
  let firstTokenMs: number | undefined;
  const asm = new ChunkAssembler((t) => { if (firstTokenMs === undefined) firstTokenMs = performance.now() - t0; onDelta(t); }, job);
  const timings = (): ChatTimings => ({ totalMs: performance.now() - t0, firstByteMs: s.ttfbMs, firstTokenMs, attempts: s.attempts, jsonMode: s.jsonMode });
  try {
    const type = s.r.headers.get('content-type') ?? '';
    if (!s.r.body || (/json/i.test(type) && !/event-stream/i.test(type))) {
      // A server that ignored stream: true and answered with one JSON message.
      const j: any = await s.r.json().catch(() => null);
      const m = j?.choices?.[0]?.message;
      if (!m) throw new ModelUnavailable(job, `The ${job} model sent no message`);
      const toolCalls = normalizeToolCalls(m.tool_calls);
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) { firstTokenMs = performance.now() - t0; onDelta(text); }
      return { content: text, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : j.choices[0].finish_reason ?? null, usage: j.usage, timings: timings() };
    }
    const reader = s.r.body.getReader();
    const dec = new TextDecoder();
    // A stalled body must not outlive the guard (a timeout or the caller's abort), whatever fetch does with its signal.
    const gone = new Promise<never>((_, rej) => { if (s.guard.signal.aborted) rej(new DOMException('Aborted', 'AbortError')); else s.guard.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true }); });
    gone.catch(() => {});
    try {
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), gone]);
        if (done) break;
        s.guard.touch();
        asm.feed(dec.decode(value, { stream: true }));
        if (asm.done) break;
      }
    } catch (err: any) {
      if (s.guard.timedOut) throw new ModelUnavailable(job, `The ${job} model stopped sending for ${Math.round(timeoutFor(job, c) / 1000)}s (raise timeoutMs in the job's options if it is just slow)`);
      if (err?.name === 'AbortError' || signal?.aborted) throw err?.name === 'AbortError' ? err : new DOMException('Aborted', 'AbortError');
      if (err instanceof ModelUnavailable) throw err;
      throw new ModelUnavailable(job, `The ${job} model's stream broke: ${String(err?.message ?? err).slice(0, 160)}`);
    } finally {
      reader.cancel().catch(() => { /* already closed */ });
    }
    asm.feed(dec.decode());
    asm.end();
  } finally {
    s.guard.clear();
  }
  const toolCalls = asm.toolCalls();
  if (!asm.content && !toolCalls.length && asm.finishReason === null) throw new ModelUnavailable(job, `The ${job} model sent no message`);
  return { content: asm.content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : asm.finishReason, usage: asm.usage, timings: timings() };
}

/** A JSON answer from a chat job, or null if the model is missing or its reply isn't JSON. Never throws for a model problem. */
export async function chatJson<T = any>(d: Deps, job: 'chat' | 'audit', messages: ChatMessage[], signal?: AbortSignal, opts: { schema?: ChatRequest['jsonSchema']; maxTokens?: number } = {}): Promise<T | null> {
  try {
    const r = await chat(d, job, { messages, json: true, jsonSchema: opts.schema, maxTokens: opts.maxTokens, temperature: 0 }, signal);
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
  const r = await post(d, 'voice', c, '/audio/speech', { ...bodyOptions(c), model: c.model, input: text.slice(0, 4000), voice: opts.voice ?? (c.options?.voice as string) ?? 'af_heart', speed: opts.speed ?? 1, response_format: format }, signal);
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
