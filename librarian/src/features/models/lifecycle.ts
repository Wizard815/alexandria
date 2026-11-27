// Game night: the model lifecycle tied to the game session.
//
// "Session live" is decided in ONE place, sessionLive():
//     a GM pressed "Start game night"   (models_meta 'gamenight', cleared by "End game night")
//  OR an audio recording is running     (audio_sessions.stopped_at IS NULL)
//  OR a session chat session is open    (sessionchat_sessions.ended_at IS NULL)
// (rows older than a day are ignored: a crashed recording must not hold models forever).
//
// Live: every job set to "keep loaded" gets its model held through the backend adapter
// (backends.ts): loaded at once, checked every minute, reloaded when it went away, and
// refreshed before a ttl runs out where the server needs that. Not live: a grace period
// (default 10 minutes, so a break or a restarted recording does not unload anything),
// then each held model is released. Not live and nothing held: this module does nothing,
// no request is made.
//
// State survives a restart (models_meta 'lifecycle'): restarted mid-session it re-warms,
// restarted after a session it releases what was still held.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { one } from '../../core/db.ts';
import { gmOnly, type EventHub } from '../../core/events.ts';
import { activeJobs, inferLocation, jobConfig, type Job } from '../../core/ai.ts';
import { getProvider, guessKind, metaGet, metaSet } from './providers.ts';
import { backendOf, inspect, isHosted, load, ping, providerSettings, release, type ActResult, type Backend, type Target } from './backends.ts';

// ---- settings -------------------------------------------------------------------------

export type Policy = 'hold' | 'ondemand';
/** Defaults: the models a table actually waits on stay loaded; voice and rerank load when needed. */
export const POLICY_DEFAULTS: Record<Job, Policy> = { chat: 'hold', audit: 'hold', audio: 'hold', extra: 'hold', voice: 'ondemand', rerank: 'ondemand', gm: 'hold', player: 'hold', bible: 'ondemand', helper: 'hold' };

export function getPolicy(db: DB, job: Job): Policy {
  const v = metaGet(db, `policy:${job}`);
  return v === 'hold' || v === 'ondemand' ? v : POLICY_DEFAULTS[job];
}
export const setPolicy = (db: DB, job: Job, p: Policy) => metaSet(db, `policy:${job}`, p);

export interface LifecycleSettings { graceMinutes: number }
export function getLifecycleSettings(db: DB): LifecycleSettings {
  try { const g = Number(JSON.parse(metaGet(db, 'lifecycle_settings') ?? '{}')?.graceMinutes); return { graceMinutes: Number.isFinite(g) && g >= 0 ? Math.min(240, g) : 10 }; } catch { return { graceMinutes: 10 }; }
}
export function setLifecycleSettings(db: DB, patch: Record<string, unknown>): LifecycleSettings {
  const cur = getLifecycleSettings(db);
  const g = Number(patch.graceMinutes);
  const next = { graceMinutes: patch.graceMinutes !== undefined && Number.isFinite(g) && g >= 0 ? Math.min(240, Math.round(g)) : cur.graceMinutes };
  metaSet(db, 'lifecycle_settings', JSON.stringify(next));
  return next;
}

// ---- the one definition of "session live" ------------------------------------------------

const DAY = 24 * 3600_000;
export interface Live { live: boolean; reasons: ('manual' | 'recording' | 'chat')[] }

export function sessionLive(d: Deps, at = Date.now()): Live {
  const since = new Date(at - DAY).toISOString();
  const reasons: Live['reasons'] = [];
  try { const m = JSON.parse(metaGet(d.db, 'gamenight') ?? 'null'); if (m?.on === true && Date.now() - Date.parse(m.at) < DAY) reasons.push('manual'); } catch { /* none */ }
  try { if (one(d.db, 'SELECT 1 FROM audio_sessions WHERE stopped_at IS NULL AND started_at > ?', since)) reasons.push('recording'); } catch { /* no audio feature */ }
  try { if (one(d.db, 'SELECT 1 FROM sessionchat_sessions WHERE ended_at IS NULL AND started_at > ?', since)) reasons.push('chat'); } catch { /* no session chat */ }
  return { live: reasons.length > 0, reasons };
}
export const gameSessionRunning = (d: Deps) => sessionLive(d).live;

export function setManual(d: Deps, on: boolean): void {
  metaSet(d.db, 'gamenight', JSON.stringify({ on, at: new Date().toISOString() }));
}

// ---- targets ------------------------------------------------------------------------------------

const locationOf = (loc: string | undefined, baseUrl: string) => (loc === 'cloud' || loc === 'local' ? loc : inferLocation(baseUrl));

/** One target per provider + model, with the jobs that use it. Primary models only (a fallback is not held). */
export function targetsFor(d: Deps, only?: (job: Job) => boolean): Target[] {
  const out = new Map<string, Target>();
  for (const job of activeJobs(d)) {
    if (only && !only(job)) continue;
    const c = jobConfig(d, job);
    if (!c || !c.model || c.model === 'default') continue;
    const p = c.providerId ? getProvider(d.db, c.providerId) : undefined;
    const providerId = p?.id ?? `url:${c.baseUrl}`;
    const kind = p?.kind ?? guessKind(c.baseUrl);
    const key = `${providerId}\n${c.model}`;
    const e = out.get(key);
    if (e) { e.jobs.push(job); continue; }
    out.set(key, { key, providerId, provider: p?.name ?? c.baseUrl, baseUrl: c.baseUrl, apiKey: c.apiKey, location: locationOf(p?.location ?? c.location, c.baseUrl), kind, model: c.model, jobs: [job] });
  }
  return [...out.values()];
}

/** The jobs with a model on a local provider (for the table page card). */
export function localJobs(d: Deps): Job[] {
  return targetsFor(d).filter((t) => t.location === 'local').flatMap((t) => t.jobs);
}

/** Models to hold during a game night: policy "keep loaded", never hosted; a plain local server only when a ping interval is set. */
async function holdTargets(d: Deps): Promise<{ t: Target; backend: Backend }[]> {
  const out: { t: Target; backend: Backend }[] = [];
  for (const t of targetsFor(d, (j) => getPolicy(d.db, j) === 'hold')) {
    if (isHosted(t)) continue;
    const { backend } = await backendOf(d, t);
    if (backend === 'hosted') continue;
    if (backend === 'generic' && providerSettings(d, t.providerId).pingMinutes <= 0) continue;
    out.push({ t, backend });
  }
  return out;
}

// ---- state --------------------------------------------------------------------------------------------

export type Phase = 'off' | 'warming' | 'ready' | 'releasing';
export type HoldState = 'loading' | 'ready' | 'failed' | 'lost';
export interface Hold {
  t: Target; backend: Backend; state: HoldState; ms?: number; error?: string;
  /** ms epochs */ lastRequest: number; nextCheck: number; ttl?: number; unverified?: boolean; losses?: number[];
}
interface Mem { phase: Phase; holds: Map<string, Hold>; graceUntil?: number; busy: Promise<void> | null; again: boolean; resumed: boolean; worlds: Set<string>; lastRelease?: { at: string; results: { model: string; ok: boolean; note?: string; error?: string }[] }; pending: Set<Promise<unknown>> }
const mems = new WeakMap<DB, Mem>();
const memOf = (d: Deps): Mem => { let m = mems.get(d.db); if (!m) { m = { phase: 'off', holds: new Map(), busy: null, again: false, resumed: false, worlds: new Set(), pending: new Set() }; mems.set(d.db, m); } return m; };

const envMs = (d: Deps, name: string, dflt: number) => Math.max(0, Number(d.env[name] ?? dflt) || dflt);
const checkEvery = (d: Deps) => envMs(d, 'ALX_MODELS_CHECK_MS', 60_000);

function persist(d: Deps) {
  const m = memOf(d);
  metaSet(d.db, 'lifecycle', JSON.stringify({ phase: m.phase, graceUntil: m.graceUntil ?? null, holds: [...m.holds.values()].map((h) => ({ providerId: h.t.providerId, model: h.t.model, backend: h.backend, jobs: h.t.jobs })) }));
}

const emit = (d: Deps) => {
  const m = memOf(d);
  const snap = warmSnapshot(d);
  for (const w of m.worlds) d.hub.emit(w, 'models-warm', { jobs: snap }, gmOnly);
};

export type WarmState = 'idle' | 'loading' | 'ready' | 'failed';
export interface WarmEntry { state: WarmState; ms?: number; error?: string }

/**
 * Per local job set to "keep loaded": idle until held, then loading, ready or failed. While models are held only the
 * held jobs are listed: a job on a server that cannot hold a model (plain OpenAI-compatible) is never "ready".
 */
export function warmSnapshot(d: Deps): Record<string, WarmEntry> {
  const m = memOf(d);
  const out: Record<string, WarmEntry> = {};
  if (!m.holds.size) for (const j of localJobs(d)) if (getPolicy(d.db, j) === 'hold') out[j] = { state: 'idle' };
  for (const h of m.holds.values()) for (const j of h.t.jobs) {
    if (h.t.location !== 'local') continue;
    out[j] = { state: h.state === 'ready' ? 'ready' : h.state === 'failed' ? 'failed' : 'loading', ...(h.ms !== undefined ? { ms: h.ms } : {}), ...(h.error ? { error: h.error } : {}) };
  }
  return out;
}

// ---- the loop -----------------------------------------------------------------------------------------------

async function start(d: Deps, h: Hold, at: number) {
  h.state = 'loading'; h.error = undefined;
  emit(d);
  const r = await load(d, h.backend, h.t);
  settle(d, h, r, at);
  if (r.ok) await verify(d, h);
}

function settle(d: Deps, h: Hold, r: ActResult, at: number) {
  h.ms = r.ms;
  h.lastRequest = at;
  h.nextCheck = at + checkEvery(d);
  if (r.ok) { h.state = 'ready'; h.error = undefined; } else { h.state = 'failed'; h.error = r.error; }
  emit(d);
}

/** After a load, the server should list the model. If it never does (an alias), stop treating "not listed" as "lost". */
async function verify(d: Deps, h: Hold) {
  const s = await inspect(d, h.backend, h.t);
  if (!s) return;
  if (!s.present && !s.error) h.unverified = true;
  if (s.ttl !== undefined) h.ttl = s.ttl;
}

async function maintain(d: Deps, h: Hold, at: number) {
  if (h.state === 'failed') { if (at >= h.nextCheck) await start(d, h, at); return; }
  const ttlMs = (): number => (h.backend === 'llama-swap' ? providerSettings(d, h.t.providerId).ttl : h.backend === 'argos' ? h.ttl ?? 0 : 0) * 1000;
  if (h.backend === 'generic') {
    const every = providerSettings(d, h.t.providerId).pingMinutes * 60_000;
    if (every > 0 && at - h.lastRequest >= every) settle(d, h, await ping(d, h.backend, h.t), at);
    return;
  }
  // Ask the server when it is time to look, or a ttl is about to run out.
  const ttl = ttlMs();
  const pingDue = ttl > 0 && at - h.lastRequest >= ttl * 0.6;
  if (at < h.nextCheck && !pingDue) return;
  const s = h.unverified ? null : await inspect(d, h.backend, h.t);
  h.nextCheck = at + (ttl > 0 ? Math.min(checkEvery(d), Math.max(5_000, ttl * 0.3)) : checkEvery(d));
  if (s && s.error) return; // server unreachable right now: try again at the next check
  if (s && !s.present) { // unloaded or crashed: bring it back, unless it keeps happening (one model at a time on the server?)
    h.losses = [...(h.losses ?? []).filter((x) => at - x < 10 * 60_000), at];
    if (h.losses.length > 3) {
      h.state = 'failed'; h.nextCheck = at + 10 * 60_000; h.losses = [];
      h.error = 'The server keeps unloading this model, probably to make room for another. Let the models run side by side (see docs/MODELS.md), then this is held again.';
      emit(d); return;
    }
    h.state = 'lost'; await start(d, h, at); return;
  }
  if (s?.ttl !== undefined) h.ttl = s.ttl;
  if (h.backend === 'ollama' && s && !s.forever) { settle(d, h, await load(d, h.backend, h.t), at); return; }
  const ttl2 = ttlMs();
  if (ttl2 > 0 && at - h.lastRequest >= ttl2 * 0.6) settle(d, h, await ping(d, h.backend, h.t), at);
}

async function releaseAll(d: Deps) {
  const m = memOf(d);
  const holds = [...m.holds.values()];
  const results = await Promise.all(holds.map(async (h) => ({ h, r: await release(d, h.backend, h.t) })));
  m.lastRelease = { at: new Date().toISOString(), results: results.map(({ h, r }) => ({ model: h.t.model, ok: r.ok, ...(r.note ? { note: r.note } : {}), ...(r.error ? { error: r.error } : {}) })) };
  m.holds.clear();
  m.graceUntil = undefined;
  m.phase = 'off';
}

async function round(d: Deps, at: number) {
  const m = memOf(d);
  const live = sessionLive(d, at);
  if (live.live) {
    m.graceUntil = undefined;
    const want = await holdTargets(d);
    const keys = new Set(want.map((w) => w.t.key));
    for (const [k, h] of [...m.holds]) if (!keys.has(k)) { m.holds.delete(k); await release(d, h.backend, h.t); } // a job was switched to "load when needed"
    const fresh: Hold[] = [];
    for (const w of want) {
      const cur = m.holds.get(w.t.key);
      if (cur) { cur.t = w.t; cur.backend = w.backend; continue; }
      const h: Hold = { t: w.t, backend: w.backend, state: 'loading', lastRequest: at, nextCheck: at };
      m.holds.set(w.t.key, h); fresh.push(h);
    }
    m.phase = 'warming';
    persist(d);
    await Promise.all([...fresh.map((h) => start(d, h, at)), ...[...m.holds.values()].filter((h) => !fresh.includes(h)).map((h) => maintain(d, h, at))]);
    m.phase = [...m.holds.values()].every((h) => h.state === 'ready' || h.state === 'failed') ? 'ready' : 'warming';
    persist(d);
    emit(d);
    return;
  }
  if (!m.holds.size) { if (m.phase !== 'off') { m.phase = 'off'; m.graceUntil = undefined; persist(d); } return; } // idle: no request at all
  if (m.graceUntil === undefined) { m.graceUntil = at + getLifecycleSettings(d.db).graceMinutes * 60_000; m.phase = 'releasing'; persist(d); emit(d); }
  if (at >= m.graceUntil) { await releaseAll(d); persist(d); emit(d); }
}

/** One pass of the lifecycle. Calls overlap safely: one runs, a request made meanwhile runs once more after it. */
export function lifecycleTick(d: Deps, at = Date.now()): Promise<void> {
  const m = memOf(d);
  if (m.busy) { m.again = true; return m.busy; }
  const run = (async () => {
    try { await round(d, at); } catch { /* the next tick tries again */ }
    finally {
      m.busy = null;
      if (m.again) { m.again = false; await lifecycleTick(d, at); }
    }
  })();
  m.busy = run;
  return run;
}

/** Skip the grace period: release what is held now (the "End game night" test button, and a reboot after a session). */
export async function releaseNow(d: Deps): Promise<void> {
  const m = memOf(d);
  if (m.busy) await m.busy;
  if (sessionLive(d).live) return;
  m.busy = (async () => { try { await releaseAll(d); persist(d); emit(d); } finally { m.busy = null; } })();
  await m.busy;
}

/** Manual "Release models now": every held or not job model on a backend that can unload, regardless of any session. */
export async function unloadEverything(d: Deps): Promise<{ model: string; provider: string; backend: Backend; ok: boolean; note?: string; error?: string }[]> {
  const m = memOf(d);
  if (m.busy) await m.busy;
  const out: { model: string; provider: string; backend: Backend; ok: boolean; note?: string; error?: string }[] = [];
  const targets = targetsFor(d).filter((t) => !isHosted(t));
  await Promise.all(targets.map(async (t) => {
    const { backend } = await backendOf(d, t);
    if (backend === 'generic' || backend === 'hosted') return;
    const r = await release(d, backend, t);
    out.push({ model: t.model, provider: t.provider, backend, ok: r.ok, ...(r.note ? { note: r.note } : {}), ...(r.error ? { error: r.error } : {}) });
  }));
  for (const h of m.holds.values()) h.state = 'lost';
  emit(d);
  return out;
}

/** After a restart: re-warm a session that is still on, release what an ended one left held. */
export async function resume(d: Deps, at = Date.now()): Promise<void> {
  const m = memOf(d);
  if (m.resumed) return;
  m.resumed = true;
  let saved: any = null;
  try { saved = JSON.parse(metaGet(d.db, 'lifecycle') ?? 'null'); } catch { /* none */ }
  if (sessionLive(d, at).live) { await lifecycleTick(d, at); return; }
  const holds: any[] = Array.isArray(saved?.holds) ? saved.holds : [];
  if (!holds.length) return;
  for (const t of targetsFor(d)) {
    const h = holds.find((x) => x.providerId === t.providerId && x.model === t.model);
    if (h && !isHosted(t)) m.holds.set(t.key, { t, backend: (h.backend as Backend) ?? 'generic', state: 'ready', lastRequest: at, nextCheck: at });
  }
  await releaseNow(d);
}

// ---- view ---------------------------------------------------------------------------------------------------------

export interface HoldView { key: string; provider: string; model: string; jobs: Job[]; backend: Backend; state: HoldState; ms?: number; error?: string; ttl?: number }
export function lifecycleView(d: Deps, at = Date.now()) {
  const m = memOf(d);
  const live = sessionLive(d, at);
  const holds: HoldView[] = [...m.holds.values()].map((h) => ({ key: h.t.key, provider: h.t.provider, model: h.t.model, jobs: h.t.jobs, backend: h.backend, state: h.state, ...(h.ms !== undefined ? { ms: h.ms } : {}), ...(h.error ? { error: h.error } : {}), ...(h.ttl !== undefined ? { ttl: h.ttl } : {}) }));
  const ready = holds.filter((h) => h.state === 'ready').length;
  return {
    phase: m.phase, live: live.live, reasons: live.reasons,
    graceUntil: m.graceUntil ? new Date(m.graceUntil).toISOString() : null,
    graceMinutes: getLifecycleSettings(d.db).graceMinutes,
    progress: { ready, total: holds.length },
    holds, lastRelease: m.lastRelease ?? null,
    policies: Object.fromEntries(activeJobs(d).map((j) => [j, getPolicy(d.db, j)])),
  };
}

// ---- events and the timer ------------------------------------------------------------------------------------

const attached = new WeakSet<EventHub>();
/** Resolves when work started by session events has finished (for tests). */
export const settled = async (d: Deps) => { const m = memOf(d); while (m.pending.size || m.busy) await Promise.allSettled([...m.pending, ...(m.busy ? [m.busy] : [])]); };

/** A recording or a session chat session starting or ending triggers a pass at once; the timer covers everything else. */
export function attachSessionEvents(d: Deps): void {
  if (attached.has(d.hub)) return;
  attached.add(d.hub);
  const m = memOf(d);
  d.hub.tap((worldId, type) => {
    if (type !== 'chat-session' && type !== 'recording') return;
    m.worlds.add(worldId);
    const p = lifecycleTick(d);
    m.pending.add(p);
    void p.catch(() => {}).finally(() => m.pending.delete(p));
  });
}

export function startLifecycle(d: Deps): () => void {
  const every = Math.max(1000, envMs(d, 'ALX_MODELS_TICK_MS', 20_000));
  const first = resume(d).catch(() => {});
  memOf(d).pending.add(first);
  void first.finally(() => memOf(d).pending.delete(first));
  const t = setInterval(() => { void lifecycleTick(d).catch(() => {}); }, every);
  t.unref?.();
  return () => clearInterval(t);
}
