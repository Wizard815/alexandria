// Event hooks: lights that follow the game. Every hook is off until the GM
// turns it on for the world.
//
// The hooks compare the game's own tables against what they saw last time
// (combat, music, recording, quick events, the clock) and react to what
// changed. That makes them safe to call as often as you like: the live hub
// nudges them when it can (`d.hub.tap`), and a light poll covers events the
// hub only sends per viewer. The first look at a world only remembers; it
// never lights anything. Nothing here can throw into the game.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { scan } from '../sound/library.ts';
import { moodColor, parseColor, toHex } from './color.ts';
import { dispatch, flash, linksFor, runSceneQuiet } from './engine.ts';

export interface Hooks {
  combatStart: { on: boolean; scene: string };
  combatEnd: { on: boolean; scene: string };
  turn: { on: boolean; brightness: number; defaultColor: string; colors: Record<string, string>; transitionMs: number };
  damage: { on: boolean; color: string; ms: number; pcOnly: boolean };
  longRest: { on: boolean; scene: string };
  mood: { on: boolean; brightness: number; transitionMs: number };
  recording: { on: boolean; scene: string };
  quickEvent: { on: boolean; scene: string };
}

export const DEFAULT_HOOKS: Hooks = {
  combatStart: { on: false, scene: '' },
  combatEnd: { on: false, scene: '' },
  turn: { on: false, brightness: 80, defaultColor: '#ffffff', colors: {}, transitionMs: 300 },
  damage: { on: false, color: '#ff0000', ms: 400, pcOnly: true },
  longRest: { on: false, scene: '' },
  mood: { on: false, brightness: 60, transitionMs: 2000 },
  recording: { on: false, scene: '' },
  quickEvent: { on: false, scene: '' },
};

export function getHooks(d: Deps, worldId: string): Hooks {
  const row = one<{ config: string }>(d.db, 'SELECT config FROM lights_hooks WHERE world_id = ?', worldId);
  const cur = parseJson<any>(row?.config, {});
  const out: any = {};
  for (const k of Object.keys(DEFAULT_HOOKS)) out[k] = { ...(DEFAULT_HOOKS as any)[k], ...(cur[k] ?? {}) };
  return out as Hooks;
}

const bool = (v: unknown, f: string): boolean => { if (typeof v !== 'boolean') throw new HttpError(400, `${f} must be true or false`); return v; };
const num = (v: unknown, f: string, min: number, max: number): number => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${f} must be a number from ${min} to ${max}`); return Math.round(n); };
const colour = (v: unknown, f: string): string => { const c = parseColor(v); if (!c) throw new HttpError(400, `${f} must be a colour like #ff8800`); return toHex(c); };

/** Merge a PUT body over the stored hooks, checking every field. Unknown keys are ignored. */
export function cleanHooks(d: Deps, worldId: string, input: any, cur: Hooks): Hooks {
  const b = input && typeof input === 'object' ? input : {};
  const out: Hooks = JSON.parse(JSON.stringify(cur));
  const scene = (v: unknown, f: string): string => {
    if (v === '' || v === null) return '';
    const s = String(v);
    if (!one(d.db, 'SELECT 1 FROM lights_scenes WHERE id = ? AND world_id = ?', s, worldId)) throw new HttpError(400, `${f} must be the id of one of this world's scenes`);
    return s;
  };
  for (const k of ['combatStart', 'combatEnd', 'longRest', 'recording', 'quickEvent'] as const) {
    const x = b[k];
    if (x === undefined) continue;
    if (typeof x !== 'object' || x === null) throw new HttpError(400, `${k} must be an object`);
    if (x.on !== undefined) out[k].on = bool(x.on, `${k}.on`);
    if (x.scene !== undefined) out[k].scene = scene(x.scene, `${k}.scene`);
  }
  if (b.turn !== undefined) {
    const x = b.turn;
    if (typeof x !== 'object' || x === null) throw new HttpError(400, 'turn must be an object');
    if (x.on !== undefined) out.turn.on = bool(x.on, 'turn.on');
    if (x.brightness !== undefined) out.turn.brightness = num(x.brightness, 'turn.brightness', 1, 100);
    if (x.transitionMs !== undefined) out.turn.transitionMs = num(x.transitionMs, 'turn.transitionMs', 0, 10_000);
    if (x.defaultColor !== undefined) out.turn.defaultColor = colour(x.defaultColor, 'turn.defaultColor');
    if (x.colors !== undefined) {
      if (typeof x.colors !== 'object' || x.colors === null || Array.isArray(x.colors)) throw new HttpError(400, 'turn.colors must map account ids to colours');
      const next: Record<string, string> = {};
      for (const [acc, c] of Object.entries(x.colors)) {
        if (!one(d.db, 'SELECT 1 FROM members WHERE world_id = ? AND account_id = ?', worldId, acc)) throw new HttpError(400, 'turn.colors can only name members of this world');
        if (c) next[acc] = colour(c, `turn.colors.${acc}`);
      }
      out.turn.colors = next;
    }
  }
  if (b.damage !== undefined) {
    const x = b.damage;
    if (typeof x !== 'object' || x === null) throw new HttpError(400, 'damage must be an object');
    if (x.on !== undefined) out.damage.on = bool(x.on, 'damage.on');
    if (x.color !== undefined) out.damage.color = colour(x.color, 'damage.color');
    if (x.ms !== undefined) out.damage.ms = num(x.ms, 'damage.ms', 100, 3000);
    if (x.pcOnly !== undefined) out.damage.pcOnly = bool(x.pcOnly, 'damage.pcOnly');
  }
  if (b.mood !== undefined) {
    const x = b.mood;
    if (typeof x !== 'object' || x === null) throw new HttpError(400, 'mood must be an object');
    if (x.on !== undefined) out.mood.on = bool(x.on, 'mood.on');
    if (x.brightness !== undefined) out.mood.brightness = num(x.brightness, 'mood.brightness', 1, 100);
    if (x.transitionMs !== undefined) out.mood.transitionMs = num(x.transitionMs, 'mood.transitionMs', 0, 10_000);
  }
  return out;
}

export const saveHooks = (d: Deps, worldId: string, h: Hooks) =>
  run(d.db, 'INSERT INTO lights_hooks (world_id, config, updated_at) VALUES (?, ?, ?) ON CONFLICT (world_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at', worldId, JSON.stringify(h), now());

export const anyOn = (h: Hooks) => Object.values(h).some((x: any) => x.on);

// ---- what changed since last time ----------------------------------------------------

interface Seen { combat?: { active: boolean; current: string | null; round: number; hp: Map<string, number | null> }; music?: string | null; clockLog?: string | null; recording?: string | null; quick?: string | null }
const seen = new WeakMap<Deps, Map<string, Seen>>();
const seenOf = (d: Deps, w: string): Seen => {
  let m = seen.get(d);
  if (!m) { m = new Map(); seen.set(d, m); }
  let s = m.get(w);
  if (!s) { s = {}; m.set(w, s); }
  return s;
};

const playerColour = (d: Deps, w: string, accountId: string | null, h: Hooks): string => {
  if (accountId) {
    const own = one<{ color: string }>(d.db, 'SELECT color FROM lights_player_colors WHERE world_id = ? AND account_id = ?', w, accountId)?.color;
    if (own) return own;
    if (h.turn.colors[accountId]) return h.turn.colors[accountId];
  }
  return h.turn.defaultColor;
};

function lookCombat(d: Deps, w: string, h: Hooks, s: Seen) {
  const st = one<any>(d.db, 'SELECT * FROM combat WHERE world_id = ?', w) ?? { active: 0, round: 1, turn: 0 };
  const list = all<any>(d.db, 'SELECT id, account_id, is_pc, hp FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', w);
  const current = list.length ? list[st.turn % list.length] : null;
  const now_ = { active: !!st.active, current: current?.id ?? null, round: st.round as number, hp: new Map<string, number | null>(list.map((x) => [x.id, x.hp])) };
  const prev = s.combat;
  s.combat = now_;
  if (!prev) return;
  if (!prev.active && now_.active) { if (h.combatStart.on) runSceneQuiet(d, w, h.combatStart.scene); return; }
  if (prev.active && !now_.active) { if (h.combatEnd.on) runSceneQuiet(d, w, h.combatEnd.scene); return; }
  if (h.damage.on) {
    const pcs = new Set(list.filter((x) => x.is_pc).map((x) => x.id));
    for (const [cid, hp] of now_.hp) {
      const was = prev.hp.get(cid);
      if (typeof hp === 'number' && typeof was === 'number' && hp < was && (!h.damage.pcOnly || pcs.has(cid))) { flash(d, w, parseColor(h.damage.color) ?? [255, 0, 0], h.damage.ms); break; }
    }
  }
  if (h.turn.on && now_.active && (now_.current !== prev.current || now_.round !== prev.round) && current) {
    const c = parseColor(playerColour(d, w, current.account_id, h)) ?? [255, 255, 255];
    for (const link of linksFor(d, w)) dispatch(d, link, { on: true, color: c, brightness: h.turn.brightness, effect: '', transitionMs: h.turn.transitionMs });
  }
}

const scans = new WeakMap<Deps, { at: number; moods: Map<string, { x: number; y: number }> }>();
function moodOf(d: Deps, w: string, trackId: string): { x: number; y: number } | null {
  const over = one<any>(d.db, 'SELECT x, y FROM sound_moods WHERE world_id = ? AND track_id = ?', w, trackId);
  if (over) return { x: over.x, y: over.y };
  let c = scans.get(d);
  if (!c || Date.now() - c.at > 30_000) {
    c = { at: Date.now(), moods: new Map() };
    try { for (const t of scan(d.dataDir).music) if (t.mood) c.moods.set(t.id, { x: t.mood.x, y: t.mood.y }); } catch { /* no library yet */ }
    scans.set(d, c);
  }
  return c.moods.get(trackId) ?? null;
}

function lookMusic(d: Deps, w: string, h: Hooks, s: Seen) {
  const row = one<{ music: string | null }>(d.db, 'SELECT music FROM sound_state WHERE world_id = ?', w);
  const m = parseJson<any>(row?.music, null);
  const key = m?.id ? `${m.id}@${m.at ?? ''}` : null;
  const had = 'music' in s;
  const prev = s.music;
  s.music = key;
  if (!had || !key || key === prev || !h.mood.on) return;
  const spot = moodOf(d, w, String(m.id));
  if (!spot) return;
  const c = moodColor(spot.x, spot.y);
  for (const link of linksFor(d, w)) dispatch(d, link, { on: true, color: c, brightness: h.mood.brightness, effect: '', transitionMs: h.mood.transitionMs });
}

function lookRecording(d: Deps, w: string, h: Hooks, s: Seen) {
  const a = one<{ id: string }>(d.db, 'SELECT id FROM audio_sessions WHERE world_id = ? AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1', w)?.id ?? null;
  const had = 'recording' in s;
  const prev = s.recording;
  s.recording = a;
  if (had && a && a !== prev && h.recording.on) runSceneQuiet(d, w, h.recording.scene);
}

function lookQuick(d: Deps, w: string, h: Hooks, s: Seen) {
  const a = one<{ id: string }>(d.db, 'SELECT id FROM quick_events WHERE world_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', w)?.id ?? null;
  const had = 'quick' in s;
  const prev = s.quick;
  s.quick = a;
  if (had && a && a !== prev && h.quickEvent.on) runSceneQuiet(d, w, h.quickEvent.scene);
}

function lookClock(d: Deps, w: string, h: Hooks, s: Seen) {
  const row = one<any>(d.db, 'SELECT id, kind, reason FROM clock_log WHERE world_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', w);
  const had = 'clockLog' in s;
  const prev = s.clockLog;
  s.clockLog = row?.id ?? null;
  if (had && row && row.id !== prev && row.kind !== 'undo' && /^long rest$/i.test(row.reason) && h.longRest.on) runSceneQuiet(d, w, h.longRest.scene);
}

const LOOKS: Record<string, (d: Deps, w: string, h: Hooks, s: Seen) => void> = { combat: lookCombat, sound: lookMusic, recording: lookRecording, 'quick-event': lookQuick, clock: lookClock };

/** Look at a world for the given event types (all of them if none are named) and react to what changed. Never throws. */
export function observe(d: Deps, worldId: string, types: string[] = Object.keys(LOOKS)): void {
  try {
    const h = getHooks(d, worldId);
    const s = seenOf(d, worldId);
    for (const t of types) { try { LOOKS[t]?.(d, worldId, h, s); } catch (e) { console.error('lights: hook failed', t, (e as Error)?.message); } }
  } catch (e) {
    console.error('lights: hook failed', (e as Error)?.message);
  }
}

const installed = new WeakSet<Deps>();
/** Listen to the live hub. Safe to call more than once. */
export function installHooks(d: Deps): void {
  if (installed.has(d)) return;
  installed.add(d);
  d.hub.tap((worldId, type) => { if (LOOKS[type]) queueMicrotask(() => observe(d, worldId, [type])); });
}

/** The light poll for events the hub only sends per viewer (combat, music, quick events). Only worlds with a hook on. */
export function startPoll(d: Deps, everyMs = 750): () => void {
  const t = setInterval(() => {
    try {
      for (const r of all<{ world_id: string; config: string }>(d.db, 'SELECT world_id, config FROM lights_hooks')) {
        if (anyOn(getHooks(d, r.world_id))) observe(d, r.world_id);
      }
    } catch { /* never break the process */ }
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

