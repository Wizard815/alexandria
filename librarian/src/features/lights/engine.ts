// Sending to lights without ever holding up the game: every group has its own
// small queue (at most 4 updates a second, the newest state wins), a send is
// fire-and-forget with a 1 second timeout, and a failure is only counted.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import { HttpError, parseJson as parseJsonSafe } from '../../core/util.ts';
import { type RGB, parseColor } from './color.ts';
import { type Kind, type LightState, send, withTimeout } from './drivers.ts';

/** Shortest gap between two updates to one light group (ms). 250 is four a second. */
const minGap = (d: Deps) => Math.max(0, Number(d.env.ALX_LIGHTS_MIN_MS ?? 250) || 0);

export interface Link { driverId: string; driverName: string; kind: Kind; cfg: Record<string, any>; groupId: string; groupName: string; target: Record<string, any> }

export interface SceneItem { group: string; color: string; brightness: number; effect: string; transitionMs: number; off: boolean }

interface Sink { lastAt: number; timer: ReturnType<typeof setTimeout> | null; pending: { link: Link; state: LightState } | null }
interface Stat { ok: number; failed: number; dropped: number; lastOkAt: string | null; lastErrorAt: string | null; lastError: string | null }
interface Mem { sinks: Map<string, Sink>; stats: Map<string, Stat>; last: Map<string, LightState>; scenes: Map<string, { sceneId: string | null; name: string; at: string }>; }

const mems = new WeakMap<Deps, Mem>();
export const memOf = (d: Deps): Mem => {
  let m = mems.get(d);
  if (!m) { m = { sinks: new Map(), stats: new Map(), last: new Map(), scenes: new Map() }; mems.set(d, m); }
  return m;
};

const statOf = (d: Deps, driverId: string): Stat => {
  const m = memOf(d);
  let s = m.stats.get(driverId);
  if (!s) { s = { ok: 0, failed: 0, dropped: 0, lastOkAt: null, lastErrorAt: null, lastError: null }; m.stats.set(driverId, s); }
  return s;
};

export const statusOf = (d: Deps, driverId: string) => ({ ...statOf(d, driverId) });

/** One send, counted. Never throws. */
async function fire(d: Deps, link: Link, state: LightState): Promise<void> {
  const st = statOf(d, link.driverId);
  try {
    await withTimeout(send(d, link.kind, link.cfg, link.target, state));
    st.ok++; st.lastOkAt = new Date().toISOString();
  } catch (e: any) {
    st.failed++; st.lastErrorAt = new Date().toISOString(); st.lastError = String(e?.message ?? e).slice(0, 200);
  }
}

/** Queue a state for one group. Returns at once; the send happens now or at the next free slot. */
export function dispatch(d: Deps, link: Link, state: LightState): void {
  const m = memOf(d);
  m.last.set(link.groupId, state);
  let sink = m.sinks.get(link.groupId);
  if (!sink) { sink = { lastAt: 0, timer: null, pending: null }; m.sinks.set(link.groupId, sink); }
  const gap = minGap(d);
  const t = Date.now();
  if (!sink.timer && t - sink.lastAt >= gap) {
    sink.lastAt = t;
    void fire(d, link, state);
    return;
  }
  if (sink.pending) statOf(d, link.driverId).dropped++;
  sink.pending = { link, state };
  if (!sink.timer) {
    const s = sink;
    s.timer = setTimeout(() => {
      s.timer = null;
      const p = s.pending;
      s.pending = null;
      if (p) { s.lastAt = Date.now(); void fire(d, p.link, p.state); }
    }, Math.max(1, gap - (t - sink.lastAt)));
    s.timer.unref?.();
  }
}

export function linksFor(d: Deps, worldId: string, groupId?: string): Link[] {
  const rows = all<any>(d.db, `SELECT g.id AS gid, g.name AS gname, g.target, dr.id AS did, dr.name AS dname, dr.kind, dr.config
    FROM lights_groups g JOIN lights_drivers dr ON dr.id = g.driver_id
    WHERE g.world_id = ? AND dr.enabled = 1 ${groupId ? 'AND g.id = ?' : ''} ORDER BY g.name`, ...(groupId ? [worldId, groupId] : [worldId]));
  return rows.map((r) => ({ driverId: r.did, driverName: r.dname, kind: r.kind, cfg: parseJsonSafe(r.config, {}), groupId: r.gid, groupName: r.gname, target: parseJsonSafe(r.target, {}) }));
}

export const stateOf = (i: Pick<SceneItem, 'color' | 'brightness' | 'effect' | 'transitionMs' | 'off'>): LightState => ({
  on: !i.off, color: (parseColor(i.color) ?? [255, 255, 255]) as RGB, brightness: i.brightness, effect: i.effect, transitionMs: i.transitionMs,
});

/** Apply scene items to groups (an item with no group means every group). Returns how many groups were queued. */
export function applyItems(d: Deps, worldId: string, items: SceneItem[]): number {
  const all_ = linksFor(d, worldId);
  const seen = new Set<string>();
  let n = 0;
  // Items for a named group win over an "all groups" item.
  for (const it of [...items].sort((a, b) => (a.group ? 1 : 0) - (b.group ? 1 : 0))) {
    for (const link of it.group ? all_.filter((l) => l.groupId === it.group) : all_) {
      if (!it.group && seen.has(link.groupId)) continue;
      if (it.group) seen.add(link.groupId);
      dispatch(d, link, stateOf(it));
      n++;
    }
  }
  return n;
}

export const itemsOf = (row: { items: string }): SceneItem[] => parseJsonSafe<SceneItem[]>(row.items, []);

/** Find a scene by id or (case-insensitive) name. */
export function findScene(d: Deps, worldId: string, ref: string) {
  const r = String(ref ?? '').trim();
  return one<any>(d.db, 'SELECT * FROM lights_scenes WHERE world_id = ? AND id = ?', worldId, r)
    ?? all<any>(d.db, 'SELECT * FROM lights_scenes WHERE world_id = ?', worldId).find((s) => s.name.toLowerCase() === r.toLowerCase());
}

/** Run a scene (by id or name). Throws a 404 for an unknown one; a light that is down never throws. */
export function runScene(d: Deps, worldId: string, ref: string): { scene: { id: string; name: string }; queued: number } {
  const s = findScene(d, worldId, ref);
  if (!s) throw new HttpError(404, 'Scene not found');
  const queued = applyItems(d, worldId, itemsOf(s));
  memOf(d).scenes.set(worldId, { sceneId: s.id, name: s.name, at: new Date().toISOString() });
  return { scene: { id: s.id, name: s.name }, queued };
}

/** Scene run that can never break the caller (used by hooks). */
export function runSceneQuiet(d: Deps, worldId: string, ref: string): void {
  try { if (ref) runScene(d, worldId, ref); } catch { /* an unknown scene or a down light is not a game problem */ }
}

/** Show a colour on every group (or the listed ones) for a moment, then put back what was there. */
export function flash(d: Deps, worldId: string, color: RGB, ms: number, groups: string[] = []): number {
  const m = memOf(d);
  let n = 0;
  for (const link of linksFor(d, worldId)) {
    if (groups.length && !groups.includes(link.groupId)) continue;
    const before = m.last.get(link.groupId);
    dispatch(d, link, { on: true, color, brightness: 100, effect: '', transitionMs: 0 });
    n++;
    const t = setTimeout(() => { dispatch(d, link, before ?? { on: false, color: [0, 0, 0], brightness: 0, effect: '', transitionMs: 300 }); }, ms);
    t.unref?.();
  }
  return n;
}
