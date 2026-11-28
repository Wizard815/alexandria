// Backend adapters: what a model server can do about "keep this model loaded"
// and "let it go". One adapter per server type, found by probing the server once
// (cached in models_meta, shown in Admin, overridable).
//
//   argos       the user's gateway: GET /running (state + ttl), POST /api/models/unload/{model}.
//               Argos has no runtime "pin": a model stays while its ttl has not run out
//               (ttl 0 = never unloads), so holding = reload if gone + a tiny request
//               before a non-zero ttl runs out.
//   llama-swap  GET /running, POST /api/models/unload/{model} (GET /unload for older builds).
//               No pin and no ttl in /running: tiny requests just inside the ttl the GM tells us.
//   ollama      GET /api/ps, POST /api/generate with keep_alive -1 (hold) or 0 (unload).
//   lmstudio    GET /api/v0/models (state), POST /api/v1/models/load|unload when it has them.
//   generic     a local OpenAI-compatible server (vLLM, llama.cpp, ...): nothing to load or
//               unload. An optional low-rate ping during game nights, off by default.
//   hosted      OpenRouter, OpenAI ...: always available. Never called for warming.
//
// Every request is a fixed tiny string (see probe.ts) or a bodiless management call:
// no world text is ever sent.
import type { Deps } from '../../app.ts';
import type { Job } from '../../core/ai.ts';
import { argosWebUrl } from './argos.ts';
import { metaGet, metaSet } from './providers.ts';
import { testJob } from './probe.ts';
import { pinned } from '../../core/ai.ts';

export const BACKENDS = ['argos', 'llama-swap', 'ollama', 'lmstudio', 'generic', 'hosted'] as const;
export type Backend = (typeof BACKENDS)[number];

export interface Target {
  key: string;
  providerId: string;
  provider: string;
  baseUrl: string;
  apiKey?: string;
  location: 'local' | 'cloud';
  kind: string;
  model: string;
  jobs: Job[];
}

export interface ProviderSettings { backend: Backend | 'auto'; ttl: number; pingMinutes: number }
export const PROVIDER_DEFAULTS: ProviderSettings = { backend: 'auto', ttl: 300, pingMinutes: 0 };

export function providerSettings(d: Deps, pid: string): ProviderSettings {
  try {
    const j = JSON.parse(metaGet(d.db, `pcfg:${pid}`) ?? '{}');
    const backend = (BACKENDS as readonly string[]).includes(j?.backend) ? j.backend : 'auto';
    const ttl = Number.isFinite(Number(j?.ttl)) && Number(j.ttl) >= 0 ? Number(j.ttl) : PROVIDER_DEFAULTS.ttl;
    const pingMinutes = Number.isFinite(Number(j?.pingMinutes)) && Number(j.pingMinutes) >= 0 ? Number(j.pingMinutes) : 0;
    return { backend, ttl, pingMinutes };
  } catch { return { ...PROVIDER_DEFAULTS }; }
}
export function setProviderSettings(d: Deps, pid: string, patch: Record<string, unknown>): ProviderSettings {
  const cur = providerSettings(d, pid);
  const next = { ...cur };
  if (patch.backend !== undefined && (patch.backend === 'auto' || (BACKENDS as readonly string[]).includes(String(patch.backend)))) next.backend = patch.backend as ProviderSettings['backend'];
  if (patch.ttl !== undefined && Number.isFinite(Number(patch.ttl)) && Number(patch.ttl) >= 0) next.ttl = Math.min(86400, Math.round(Number(patch.ttl)));
  if (patch.pingMinutes !== undefined && Number.isFinite(Number(patch.pingMinutes)) && Number(patch.pingMinutes) >= 0) next.pingMinutes = Math.min(240, Math.round(Number(patch.pingMinutes)));
  metaSet(d.db, `pcfg:${pid}`, JSON.stringify(next));
  return next;
}

// ---- http ---------------------------------------------------------------------------

export interface Reply { ok: boolean; status: number; json: any; error?: string }

const root = (t: { baseUrl: string }) => argosWebUrl(t.baseUrl).replace(/\/+$/, '');

export async function call(d: Deps, t: { baseUrl: string; apiKey?: string }, method: string, path: string, body?: unknown, ms = 8000): Promise<Reply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const headers: Record<string, string> = { ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    const r = await d.fetch(root(t) + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    const text = await r.text().catch(() => '');
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { ok: r.ok, status: r.status, json, ...(r.ok ? {} : { error: `${r.status} ${text.slice(0, 120)}`.trim() }) };
  } catch (err: any) {
    return { ok: false, status: 0, json: null, error: err?.name === 'AbortError' ? 'no answer in time' : String(err?.cause?.message ?? err?.message ?? err).slice(0, 160) };
  } finally { clearTimeout(timer); }
}

// ---- detection ----------------------------------------------------------------------

export interface Detected { backend: Backend; at: string; base: string }

const hintFor = (kind: string): Backend => (kind === 'argos' ? 'argos' : kind === 'ollama' ? 'ollama' : kind === 'lmstudio' ? 'lmstudio' : kind === 'openai' ? 'hosted' : 'generic');

/** Cloud locations and the OpenAI kind are hosted: never probed, never warmed. */
export const isHosted = (t: { location: string; kind: string }) => t.location === 'cloud' || t.kind === 'openai';

export function cachedBackend(d: Deps, pid: string, baseUrl: string): Detected | null {
  try { const j = JSON.parse(metaGet(d.db, `backend:${pid}`) ?? 'null'); return j && j.base === baseUrl && (BACKENDS as readonly string[]).includes(j.backend) ? j : null; } catch { return null; }
}

/** Ask the server what it is: Argos, then Ollama, LM Studio and llama-swap by their own endpoints; anything else is generic. */
export async function probeBackend(d: Deps, t: Pick<Target, 'baseUrl' | 'apiKey' | 'kind'>): Promise<Backend | null> {
  const a = await call(d, t, 'GET', '/api/models/modes', undefined, 4000);
  if (a.ok && Array.isArray(a.json?.valid)) return 'argos';
  const o = await call(d, t, 'GET', '/api/ps', undefined, 4000);
  if (o.ok && Array.isArray(o.json?.models)) return 'ollama';
  const l = await call(d, t, 'GET', '/api/v0/models', undefined, 4000);
  if (l.ok && (Array.isArray(l.json?.data) || Array.isArray(l.json))) return 'lmstudio';
  const s = await call(d, t, 'GET', '/running', undefined, 4000);
  if (s.ok && Array.isArray(s.json?.running)) return 'llama-swap';
  // Nothing answered at all: do not cache a guess about a server that may just be down.
  if (!a.status && !o.status && !l.status && !s.status) return null;
  return 'generic';
}

/** What this provider is, from the override, the cache or one probe (then cached). */
export async function backendOf(d: Deps, t: Target, force = false): Promise<{ backend: Backend; detected: Backend | null; auto: boolean }> {
  const set = providerSettings(d, t.providerId);
  if (isHosted(t)) return { backend: 'hosted', detected: 'hosted', auto: set.backend === 'auto' };
  let det = force ? null : cachedBackend(d, t.providerId, t.baseUrl);
  if (!det) {
    const b = await probeBackend(d, t);
    if (b) { det = { backend: b, at: new Date().toISOString(), base: t.baseUrl }; metaSet(d.db, `backend:${t.providerId}`, JSON.stringify(det)); }
  }
  const detected = det?.backend ?? null;
  return { backend: set.backend !== 'auto' ? set.backend : detected ?? hintFor(t.kind), detected, auto: set.backend === 'auto' };
}

export interface Capability { label: string; canHold: boolean; canUnload: boolean; summary: string }

export function describeBackend(b: Backend, s: ProviderSettings): Capability {
  switch (b) {
    case 'argos': return { label: 'Argos', canHold: true, canUnload: true, summary: 'Argos holds models for their ttl (0 = never unloads). During game nights Alexandria reloads a model that went away and refreshes it before a ttl runs out; after the night it unloads them.' };
    case 'llama-swap': return { label: 'llama-swap', canHold: true, canUnload: true, summary: `llama-swap cannot pin a model. During game nights Alexandria sends a tiny request every ${Math.max(1, Math.round(s.ttl * 0.6 / 60))} min (just inside the ${s.ttl}s ttl you set here); after the night it unloads them.` };
    case 'ollama': return { label: 'Ollama', canHold: true, canUnload: true, summary: 'Ollama holds a model with keep_alive -1. Alexandria sets it when a game night starts and sets keep_alive 0 to unload when it ends.' };
    case 'lmstudio': return { label: 'LM Studio', canHold: true, canUnload: true, summary: 'Alexandria loads models when a game night starts and unloads them after, using LM Studio\'s load and unload endpoints when it has them. Otherwise LM Studio loads on the first request and unloads on its own idle timer.' };
    case 'hosted': return { label: 'Hosted API', canHold: false, canUnload: false, summary: 'Hosted API: always available, nothing to load. Alexandria never sends warm-up requests here.' };
    default: return s.pingMinutes > 0
      ? { label: 'OpenAI-compatible', canHold: false, canUnload: false, summary: `This server can't hold models loaded; Alexandria will ping it every ${s.pingMinutes} minutes during game nights.` }
      : { label: 'OpenAI-compatible', canHold: false, canUnload: false, summary: 'This server cannot hold models loaded and has nothing to unload. Alexandria sends no warm-up requests (set a ping interval to change that).' };
  }
}

// ---- actions -----------------------------------------------------------------------------

const enc = (m: string) => m.split('/').map(encodeURIComponent).join('/');
export interface ActResult { ok: boolean; ms: number; error?: string; note?: string }
const fromTest = (r: { ok: boolean; ms: number; error?: string }): ActResult => ({ ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error } : {}) });
const fromReply = (r: Reply, t0: number): ActResult => ({ ok: r.ok, ms: Date.now() - t0, ...(r.ok ? {} : { error: r.error ?? 'failed' }) });

/** Load the model and ask the server to keep it. Always one fixed tiny request. */
export async function load(d: Deps, backend: Backend, t: Target): Promise<ActResult> {
  const t0 = Date.now();
  if (backend === 'hosted') return { ok: true, ms: 0, note: 'nothing to load' };
  if (backend === 'ollama') {
    const embeds = t.jobs.length > 0 && t.jobs.every((j) => j === 'extra');
    const r = embeds ? await call(d, t, 'POST', '/api/embed', { model: t.model, input: 'a', keep_alive: -1 }, 120_000) : await call(d, t, 'POST', '/api/generate', { model: t.model, keep_alive: -1 }, 120_000);
    if (r.ok || !t.jobs.length) return fromReply(r, t0);
    return fromTest(await testJob(pinned(d, 'primary'), t.jobs[0], 120_000)); // Ollama without these routes (audio, rerank behind a proxy)
  }
  if (backend === 'lmstudio') {
    const r = await call(d, t, 'POST', '/api/v1/models/load', { model: t.model }, 120_000);
    if (r.ok) return fromReply(r, t0);
  }
  return fromTest(await testJob(pinned(d, 'primary'), t.jobs[0] ?? 'chat', 120_000));
}

/** A tiny request to keep an idle model inside its ttl. */
export async function ping(d: Deps, backend: Backend, t: Target): Promise<ActResult> {
  if (backend === 'hosted') return { ok: true, ms: 0 };
  if (backend === 'ollama') return load(d, backend, t);
  return fromTest(await testJob(pinned(d, 'primary'), t.jobs[0] ?? 'chat', 60_000));
}

/** Let the model go. Backends that cannot unload do nothing (and say so). */
export async function release(d: Deps, backend: Backend, t: Target): Promise<ActResult> {
  const t0 = Date.now();
  if (backend === 'argos') return fromReply(await call(d, t, 'POST', `/api/models/unload/${enc(t.model)}`, undefined, 30_000), t0);
  if (backend === 'llama-swap') {
    const r = await call(d, t, 'POST', `/api/models/unload/${enc(t.model)}`, undefined, 30_000);
    if (r.ok || (r.status !== 404 && r.status !== 405)) return fromReply(r, t0);
    return fromReply(await call(d, t, 'GET', '/unload', undefined, 30_000), t0); // older builds: unloads everything
  }
  if (backend === 'ollama') return fromReply(await call(d, t, 'POST', '/api/generate', { model: t.model, keep_alive: 0 }, 30_000), t0);
  if (backend === 'lmstudio') {
    const r = await call(d, t, 'POST', '/api/v1/models/unload', { instance_id: t.model }, 30_000);
    return r.ok ? fromReply(r, t0) : { ok: true, ms: Date.now() - t0, note: 'LM Studio has no unload endpoint here; its own idle timer unloads the model' };
  }
  return { ok: true, ms: 0, note: 'nothing to unload' };
}

export type Seen = { present: boolean; ttl?: number; forever?: boolean; error?: string } | null;

/** Is the model loaded right now? null = this backend cannot say (generic, hosted) or could not be asked. */
export async function inspect(d: Deps, backend: Backend, t: Target): Promise<Seen> {
  if (backend === 'argos' || backend === 'llama-swap') {
    const r = await call(d, t, 'GET', '/running');
    if (!r.ok) return { present: false, error: r.error };
    const rows: any[] = Array.isArray(r.json?.running) ? r.json.running : [];
    const row = rows.find((x) => String(x?.model).toLowerCase() === t.model.toLowerCase() && !/stopp|shutdown|stopped/i.test(String(x?.state ?? '')));
    return { present: !!row, ...(row && Number.isFinite(Number(row.ttl)) ? { ttl: Number(row.ttl) } : {}) };
  }
  if (backend === 'ollama') {
    const r = await call(d, t, 'GET', '/api/ps');
    if (!r.ok) return { present: false, error: r.error };
    const rows: any[] = Array.isArray(r.json?.models) ? r.json.models : [];
    const row = rows.find((x) => [x?.name, x?.model].some((n) => typeof n === 'string' && (n === t.model || n === `${t.model}:latest`)));
    const exp = row?.expires_at ? Date.parse(row.expires_at) : NaN;
    return { present: !!row, forever: !!row && (!Number.isFinite(exp) || exp - Date.now() > 24 * 3600_000) };
  }
  if (backend === 'lmstudio') {
    const r = await call(d, t, 'GET', '/api/v0/models');
    if (!r.ok) return { present: false, error: r.error };
    const rows: any[] = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
    const row = rows.find((x) => x?.id === t.model);
    return { present: !!row && String(row.state ?? '').toLowerCase() === 'loaded' };
  }
  return null;
}
