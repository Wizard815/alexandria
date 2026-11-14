// Session mode for Argos: get the local models ready when a game session starts,
// keep them loaded while it runs, and (optionally) unload them when it ends.
//
// The setting is global, not per world: the models are one set of GPUs shared by
// every world on this server, so a world setting would have two worlds disagree
// about the same hardware. It lives in models_meta ("session_mode") and is edited in
// Admin → Models.
//
//   loadOnStart   when a session starts (a session chat session opens, or an audio
//                 recording starts) send one tiny request to every enabled local job,
//                 in parallel
//   keepLoaded    while a session runs, the keep-warm ping goes to every local job
//                 (not only the ones with their own keep-warm switch)
//   unloadOnEnd   when the last running session ends, POST /api/models/unload/{model}
//                 to Argos for each job model that is on an Argos provider (default off)
//
// Every request here is a fixed string (see probe.ts) or a bodiless unload call:
// no world text is sent anywhere.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { one } from '../../core/db.ts';
import { dmOnly, type EventHub } from '../../core/events.ts';
import { JOBS, inferLocation, jobConfig, pinned, type Job, type JobConfig } from '../../core/ai.ts';
import { argosWebUrl } from './argos.ts';
import { testJob } from './probe.ts';
import { getProvider, metaGet, metaSet } from './providers.ts';

export interface SessionSettings { loadOnStart: boolean; keepLoaded: boolean; unloadOnEnd: boolean }
export const SESSION_DEFAULTS: SessionSettings = { loadOnStart: false, keepLoaded: false, unloadOnEnd: false };

export function getSessionSettings(db: DB): SessionSettings {
  try {
    const j = JSON.parse(metaGet(db, 'session_mode') ?? '{}');
    return { loadOnStart: j?.loadOnStart === true, keepLoaded: j?.keepLoaded === true, unloadOnEnd: j?.unloadOnEnd === true };
  } catch { return { ...SESSION_DEFAULTS }; }
}

export function setSessionSettings(db: DB, patch: Record<string, unknown>): SessionSettings {
  const cur = getSessionSettings(db);
  const next: SessionSettings = { ...cur };
  for (const k of Object.keys(SESSION_DEFAULTS) as (keyof SessionSettings)[]) if (patch[k] !== undefined) next[k] = patch[k] === true;
  metaSet(db, 'session_mode', JSON.stringify(next));
  return next;
}

const locationOf = (c: JobConfig) => c.location ?? inferLocation(c.baseUrl);

/** The jobs that have a model on a local provider right now (enabled, and not cloud). */
export function localJobs(d: Deps): Job[] {
  return JOBS.filter((j) => { const c = jobConfig(d, j); return !!c && locationOf(c) === 'local'; });
}

/** A game session is running: a session chat session is open or an audio recording is on. */
export function gameSessionRunning(d: Deps): boolean {
  try { if (one(d.db, 'SELECT 1 FROM audio_sessions WHERE stopped_at IS NULL')) return true; } catch { /* no audio feature */ }
  try { return !!one(d.db, 'SELECT 1 FROM sessionchat_sessions WHERE ended_at IS NULL'); } catch { return false; }
}

// ---- warm progress -----------------------------------------------------------------

export type WarmState = 'idle' | 'loading' | 'ready' | 'failed';
export interface WarmEntry { state: WarmState; ms?: number; error?: string; at?: string }
interface Run { jobs: Partial<Record<Job, WarmEntry>>; inflight: Promise<void> | null; unloading: Promise<unknown> | null; pending: Set<Promise<unknown>>; worlds: Set<string> }
const runs = new WeakMap<DB, Run>();
const runOf = (d: Deps): Run => { let r = runs.get(d.db); if (!r) { r = { jobs: {}, inflight: null, unloading: null, pending: new Set(), worlds: new Set() }; runs.set(d.db, r); } return r; };

/** What each local job is doing: idle until it is warmed. */
export function warmSnapshot(d: Deps): Record<string, WarmEntry> {
  const r = runOf(d);
  const out: Record<string, WarmEntry> = {};
  for (const j of localJobs(d)) out[j] = r.jobs[j] ?? { state: 'idle' };
  return out;
}

const emitWarm = (d: Deps, worlds: Iterable<string>) => {
  const snap = warmSnapshot(d);
  for (const w of worlds) d.hub.emit(w, 'models-warm', { jobs: snap }, dmOnly);
};

/** One tiny request to each enabled local job, all at once. Calling it while a round runs joins that round. */
export function warmAll(d: Deps, worldIds: string[] = []): Promise<Record<string, WarmEntry>> {
  const r = runOf(d);
  for (const w of worldIds) r.worlds.add(w);
  if (r.inflight) return r.inflight.then(() => warmSnapshot(d));
  const jobs = localJobs(d);
  r.jobs = {};
  for (const j of jobs) r.jobs[j] = { state: 'loading', at: new Date().toISOString() };
  emitWarm(d, r.worlds);
  const round = Promise.all(jobs.map(async (job) => {
    const res = await testJob(pinned(d, 'primary'), job, 120_000);
    r.jobs[job] = res.ok ? { state: 'ready', ms: res.ms, at: new Date().toISOString() } : { state: 'failed', ms: res.ms, error: res.error, at: new Date().toISOString() };
    emitWarm(d, r.worlds);
  })).then(() => { r.inflight = null; });
  r.inflight = round;
  return round.then(() => warmSnapshot(d));
}

// ---- unload ------------------------------------------------------------------------------

export interface UnloadResult { jobs: Job[]; model: string; provider: string; ok: boolean; error?: string }
interface Target { jobs: Job[]; model: string; providerId: string; baseUrl: string; apiKey?: string; provider: string }

/** The job models that sit on an Argos provider, once each: this is the only set unload ever touches. */
export function argosJobModels(d: Deps): Target[] {
  const out = new Map<string, Target>();
  for (const job of JOBS) {
    const c = jobConfig(d, job);
    const p = c?.providerId ? getProvider(d.db, c.providerId) : undefined;
    if (!c || !p || p.kind !== 'argos' || !c.model || c.model === 'default') continue;
    const k = `${p.id}\n${c.model}`;
    const e = out.get(k);
    if (e) e.jobs.push(job);
    else out.set(k, { jobs: [job], model: c.model, providerId: p.id, baseUrl: p.base_url, apiKey: p.api_key || undefined, provider: p.name });
  }
  return [...out.values()];
}

/** POST /api/models/unload/{model} on Argos for each job model on an Argos provider. Anything else is left alone. */
export async function unloadAll(d: Deps): Promise<UnloadResult[]> {
  const targets = argosJobModels(d);
  const results = await Promise.all(targets.map(async (t): Promise<UnloadResult> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30_000);
    try {
      const url = `${argosWebUrl(t.baseUrl)}/api/models/unload/${t.model.split('/').map(encodeURIComponent).join('/')}`;
      const res = await d.fetch(url, { method: 'POST', headers: t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}, signal: ctl.signal });
      await res.text().catch(() => '');
      return { jobs: t.jobs, model: t.model, provider: t.provider, ok: res.ok, ...(res.ok ? {} : { error: `Argos answered ${res.status}` }) };
    } catch (err: any) {
      return { jobs: t.jobs, model: t.model, provider: t.provider, ok: false, error: String(err?.message ?? err).slice(0, 160) };
    } finally { clearTimeout(timer); }
  }));
  const r = runOf(d);
  for (const t of targets) if (results.find((x) => x.model === t.model && x.provider === t.provider)?.ok) for (const j of t.jobs) delete r.jobs[j];
  emitWarm(d, r.worlds);
  return results;
}

// ---- session events ---------------------------------------------------------------------------

const attached = new WeakSet<EventHub>();

/** Resolves when the work started by session events has finished (for tests). */
export const settled = async (d: Deps) => { const r = runOf(d); while (r.pending.size) await Promise.allSettled([...r.pending]); };

/**
 * Listen for sessions starting and ending: a session chat session opening or closing
 * ('chat-session') and an audio recording starting or stopping ('recording'). Only the
 * event type and its on/open flag are read.
 */
export function attachSessionEvents(d: Deps): void {
  if (attached.has(d.hub)) return;
  attached.add(d.hub);
  const r = runOf(d);
  const seen = new Map<string, boolean>();
  const track = (p: Promise<unknown>) => { r.pending.add(p); void p.catch(() => {}).finally(() => r.pending.delete(p)); };
  const started = (worldId: string) => {
    if (getSessionSettings(d.db).loadOnStart) track(warmAll(d, [worldId]));
  };
  const ended = () => {
    if (!getSessionSettings(d.db).unloadOnEnd || gameSessionRunning(d) || r.unloading) return;
    const p = unloadAll(d).finally(() => { r.unloading = null; });
    r.unloading = p;
    track(p);
  };
  d.hub.tap((worldId, type, data: any) => {
    if (type === 'chat-session') {
      const s = data?.session;
      if (!s?.id) return;
      const open = !!s.open;
      if (seen.get(s.id) === open) return; // one event per member: act once
      seen.set(s.id, open);
      if (seen.size > 200) seen.delete(seen.keys().next().value as string);
      if (open) started(worldId); else ended();
    } else if (type === 'recording') {
      if (data?.on === true) started(worldId); else if (data?.on === false) ended();
    }
  });
}
