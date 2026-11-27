// Foundry VTT ↔ Alexandria: the rules for what moves between a Foundry world
// and an Alexandria world, kept apart from the routes so they can be tested
// on their own.
//
// - HP, max HP and temporary HP of linked actors: a change on either side is
//   copied to the other. Each link remembers the last numbers both sides
//   agreed on (last_*); Alexandria pushes only what changed here since then,
//   so a change that came from Foundry is never sent back to it.
// - Conditions ↔ actor status effects, through a name map the DM can edit.
//   Conditions with no status, and statuses with no condition, are left alone.
// - Tokens on a linked scene are map marks (kind 'token') on the Alexandria
//   map the scene is linked to. Fog hides them from players like any mark.
// - Fog: Alexandria's fog of the linked map picture is drawn over the scene
//   in Foundry; player tokens that move in Foundry uncover the fog around
//   them in Alexandria.
import { type DB, all, one, run } from '../../core/db.ts';
import { now, parseJson } from '../../core/util.ts';
import { vitalsOf, type Vitals } from '../sheet/vitals.ts';

/** The 5e conditions and the Foundry status effect id each one shows as (the dnd5e system's ids). */
export const DEFAULT_STATUSES: Record<string, string> = {
  Blinded: 'blinded',
  Charmed: 'charmed',
  Deafened: 'deafened',
  Frightened: 'frightened',
  Grappled: 'grappled',
  Incapacitated: 'incapacitated',
  Invisible: 'invisible',
  Paralyzed: 'paralyzed',
  Petrified: 'petrified',
  Poisoned: 'poisoned',
  Prone: 'prone',
  Restrained: 'restrained',
  Stunned: 'stunned',
  Unconscious: 'unconscious',
  Exhaustion: 'exhaustion',
  Concentrating: 'concentrating',
  Dead: 'dead',
};

/** The DM's map (setting foundryStatuses) over the defaults; an empty id turns a default off. */
export function statusMap(custom: unknown): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_STATUSES };
  if (custom && typeof custom === 'object') {
    for (const [cond, id] of Object.entries(custom as Record<string, unknown>)) {
      const key = Object.keys(out).find((k) => k.toLowerCase() === cond.toLowerCase()) ?? cond;
      if (typeof id === 'string' && id.trim()) out[key] = id.trim();
      else delete out[key];
    }
  }
  return out;
}

export function validateStatuses(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('foundryStatuses must be an object of condition: status id');
  const e = Object.entries(v as Record<string, unknown>);
  if (e.length > 60) throw new Error('foundryStatuses: at most 60 conditions');
  for (const [k, m] of e) {
    if (!k.trim() || k.length > 40) throw new Error('foundryStatuses: condition names are 1 to 40 characters');
    if (typeof m !== 'string' || m.length > 60) throw new Error('foundryStatuses: each status is an id of up to 60 characters ("" turns it off)');
  }
}

const lc = (s: string) => s.trim().toLowerCase();

/** The status ids a list of conditions shows as (only conditions that have one). */
export function statusesFor(conditions: string[], map: Record<string, string>): string[] {
  const out: string[] = [];
  for (const c of conditions) {
    const k = Object.keys(map).find((x) => lc(x) === lc(c));
    if (k && !out.includes(map[k])) out.push(map[k]);
  }
  return out;
}

/**
 * New conditions after Foundry reports an actor's statuses: every condition
 * the map knows follows the statuses; the rest (conditions with no status) stay.
 */
export function conditionsFromStatuses(current: string[], statuses: string[], map: Record<string, string>): string[] {
  const managed = new Set(Object.keys(map).map(lc));
  const have = new Set(statuses.map(lc));
  const on = Object.entries(map).filter(([, id]) => have.has(lc(id))).map(([c]) => c);
  const onSet = new Set(on.map(lc));
  const keep = current.filter((c) => !managed.has(lc(c)) || onSet.has(lc(c)));
  return [...keep, ...on.filter((c) => !keep.some((x) => lc(x) === lc(c)))];
}

export interface Link {
  world_id: string; actor_id: string; name: string; owners: string; account_id: string | null;
  last_hp: number | null; last_max: number | null; last_temp: number | null; last_conditions: string | null; seen_at: string;
}

export const linksOf = (db: DB, worldId: string) => all<Link>(db, 'SELECT * FROM foundry_actors WHERE world_id = ? ORDER BY name COLLATE NOCASE', worldId);
export const linkOf = (db: DB, worldId: string, actorId: string) => one<Link>(db, 'SELECT * FROM foundry_actors WHERE world_id = ? AND actor_id = ?', worldId, actorId);

/** Remember what both sides now agree on, so it is not pushed back. */
export function agree(db: DB, worldId: string, actorId: string, v: Vitals) {
  run(db, 'UPDATE foundry_actors SET last_hp = ?, last_max = ?, last_temp = ?, last_conditions = ? WHERE world_id = ? AND actor_id = ?',
    v.hp, v.maxHp, v.tempHp, JSON.stringify(v.conditions), worldId, actorId);
}

/** Forget what was agreed: the next sync pushes Alexandria's numbers for these actors. */
export function forget(db: DB, worldId: string, actorId?: string) {
  run(db, `UPDATE foundry_actors SET last_hp = NULL, last_max = NULL, last_temp = NULL, last_conditions = NULL WHERE world_id = ? ${actorId ? 'AND actor_id = ?' : ''}`, worldId, ...(actorId ? [actorId] : []));
}

export interface Push { id: string; name: string; hp?: number; maxHp?: number; tempHp?: number; statuses?: string[] }

/**
 * What Foundry should change: for each linked actor, the fields that differ
 * from what was last agreed. Marks them agreed (they are on their way).
 * Max HP is only sent with pushMax (in dnd5e it is usually worked out from the class).
 */
export function pendingPushes(db: DB, worldId: string, map: Record<string, string>, opts: { hp: boolean; conditions: boolean; pushMax: boolean }): Push[] {
  const out: Push[] = [];
  for (const l of linksOf(db, worldId)) {
    if (!l.account_id) continue;
    const v = vitalsOf(db, worldId, l.account_id);
    const p: Push = { id: l.actor_id, name: l.name };
    let any = false;
    if (opts.hp) {
      if (v.hp !== null && v.hp !== l.last_hp) { p.hp = v.hp; any = true; }
      if (opts.pushMax && v.maxHp !== null && v.maxHp !== l.last_max) { p.maxHp = v.maxHp; any = true; }
      if (v.tempHp !== (l.last_temp ?? -1)) { p.tempHp = v.tempHp; any = true; }
    }
    if (opts.conditions) {
      const was = l.last_conditions === null ? null : parseJson<string[]>(l.last_conditions, []);
      const a = statusesFor(v.conditions, map).sort().join(',');
      if (was === null || statusesFor(was, map).sort().join(',') !== a) { p.statuses = statusesFor(v.conditions, map); any = true; }
    }
    if (any) { out.push(p); agree(db, worldId, l.actor_id, v); }
  }
  return out;
}

/** Link a Foundry actor to the player whose character (or display) name matches, when exactly one does; else its one owner's name. */
export function guessAccount(db: DB, worldId: string, name: string, owners: string[]): string | null {
  const players = all<any>(db, "SELECT m.account_id, m.character_name, a.display_name, a.username FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId);
  const byChar = players.filter((p) => p.character_name && lc(p.character_name) === lc(name));
  if (byChar.length === 1) return byChar[0].account_id;
  const set = new Set(owners.map(lc));
  const byOwner = players.filter((p) => [p.display_name, p.username].some((x) => typeof x === 'string' && set.has(lc(x))));
  if (byOwner.length === 1) return byOwner[0].account_id;
  return null;
}

/** One line in the DM's Foundry activity list (newest 100 kept). */
export function activity(db: DB, worldId: string, dir: 'in' | 'out', text: string) {
  run(db, 'INSERT INTO foundry_activity (world_id, dir, text, at) VALUES (?, ?, ?, ?)', worldId, dir, text.slice(0, 300), now());
  run(db, 'DELETE FROM foundry_activity WHERE world_id = ? AND id NOT IN (SELECT id FROM foundry_activity WHERE world_id = ? ORDER BY id DESC LIMIT 100)', worldId, worldId);
}

/** True the first time a key is seen (an event the module might send twice). */
export function firstTime(db: DB, worldId: string, key: string): boolean {
  if (one(db, 'SELECT 1 FROM foundry_seen WHERE world_id = ? AND key = ?', worldId, key)) return false;
  run(db, 'INSERT INTO foundry_seen (world_id, key, at) VALUES (?, ?, ?)', worldId, key, now());
  return true;
}

/** A position on the map's 0..100 grid, or null. */
export function pos(x: unknown, y: unknown): { x: number; y: number } | null {
  const a = Number(x), b = Number(y);
  if (typeof x === 'boolean' || typeof y === 'boolean' || x === null || y === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || a > 100 || b < 0 || b > 100) return null;
  return { x: Math.round(a * 100) / 100, y: Math.round(b * 100) / 100 };
}

/** Two positions are the same token spot (Foundry snaps to the grid, and both sides round). */
export const samePos = (a: { x?: number; y?: number }, b: { x?: number; y?: number }) =>
  Math.abs(Number(a.x) - Number(b.x)) < 0.05 && Math.abs(Number(a.y) - Number(b.y)) < 0.05;

/**
 * The fog circle a player token uncovers where it stands, as a fog op (0..1 coordinates, radius a fraction of the
 * picture's width), or null when reveal is off or the grid is unknown.
 */
export function revealAround(p: { x: number; y: number }, squares: number, gridFrac: number | null) {
  if (!squares || squares <= 0 || !gridFrac || !(gridFrac > 0)) return null;
  const r = Math.min(1, Math.max(0.003, squares * gridFrac));
  return { k: 'c' as const, x: Math.round(p.x * 100) / 10_000, y: Math.round(p.y * 100) / 10_000, r: Math.round(r * 10_000) / 10_000, v: 1 as const };
}

/** A Foundry roll as Alexandria's chat roll (the same shape /roll makes). */
export interface FRoll { expr: string; total: number; dice: number[] }
export function rollFrom(rolls: FRoll[], label: string) {
  const [first, ...rest] = rolls;
  const extra = rest.map((r) => `${r.expr} = ${r.total}`).join(' · ');
  return {
    expr: first.expr.slice(0, 80),
    terms: [{ term: first.expr.slice(0, 80), dice: first.dice.slice(0, 100), sum: first.total }],
    total: first.total,
    note: [label, extra].filter(Boolean).join(' · ').slice(0, 120),
  };
}

/** A map id from a scene name, the way the Map page makes them. */
export const mapIdFor = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'foundry-scene';
