// Roll20 ↔ Alexandria: the rules for what moves between a Roll20 game and a
// world, kept apart from the routes so they can be tested on their own.
//
// - HP, max HP and temporary HP: a change on either side is copied to the
//   other. Each link remembers the last numbers both sides agreed on
//   (last_*); Alexandria pushes only what changed here since then, so a
//   change that came from Roll20 is never sent back to it.
// - Conditions ↔ token status markers, through a name map the DM can edit.
//   Conditions with no marker, and markers with no condition, are left alone.
// - Rolls made in Roll20 land in the table chat (and the other way, if on).
import { type DB, all, one, run } from '../../core/db.ts';
import { now, parseJson } from '../../core/util.ts';
import { vitalsOf, type Vitals } from '../sheet/vitals.ts';

/** The 5e conditions and the Roll20 status marker each one shows as. */
export const DEFAULT_MARKERS: Record<string, string> = {
  Blinded: 'bleeding-eye',
  Charmed: 'chained-heart',
  Deafened: 'edge-crack',
  Frightened: 'screaming',
  Grappled: 'grab',
  Incapacitated: 'interdiction',
  Invisible: 'ninja-mask',
  Paralyzed: 'padlock',
  Petrified: 'white-tower',
  Poisoned: 'chemical-bolt',
  Prone: 'back-pain',
  Restrained: 'fishing-net',
  Stunned: 'pummeled',
  Unconscious: 'sleepy',
  Exhaustion: 'tread',
  Concentrating: 'stopwatch',
  Dead: 'dead',
};

/** The DM's map (setting roll20Markers) over the defaults; an empty marker turns a default off. */
export function markerMap(custom: unknown): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_MARKERS };
  if (custom && typeof custom === 'object') {
    for (const [cond, marker] of Object.entries(custom as Record<string, unknown>)) {
      const key = Object.keys(out).find((k) => k.toLowerCase() === cond.toLowerCase()) ?? cond;
      if (typeof marker === 'string' && marker.trim()) out[key] = marker.trim();
      else delete out[key];
    }
  }
  return out;
}

export function validateMarkers(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('roll20Markers must be an object of condition: marker');
  const e = Object.entries(v as Record<string, unknown>);
  if (e.length > 60) throw new Error('roll20Markers: at most 60 conditions');
  for (const [k, m] of e) {
    if (!k.trim() || k.length > 40) throw new Error('roll20Markers: condition names are 1 to 40 characters');
    if (typeof m !== 'string' || m.length > 60) throw new Error('roll20Markers: each marker is a name of up to 60 characters ("" turns it off)');
  }
}

const lc = (s: string) => s.trim().toLowerCase();

/** The markers a list of conditions shows as (only conditions that have one). */
export function markersFor(conditions: string[], map: Record<string, string>): string[] {
  const out: string[] = [];
  for (const c of conditions) {
    const k = Object.keys(map).find((x) => lc(x) === lc(c));
    if (k && !out.includes(map[k])) out.push(map[k]);
  }
  return out;
}

/**
 * New conditions after Roll20 reports a token's markers: every condition the
 * map knows follows the markers; the rest (conditions with no marker) stay.
 */
export function conditionsFromMarkers(current: string[], markers: string[], map: Record<string, string>): string[] {
  const managed = new Set(Object.keys(map).map(lc));
  const have = new Set(markers.map(lc));
  const on = Object.entries(map).filter(([, m]) => have.has(lc(m))).map(([c]) => c);
  // A marker named like a condition (a custom marker set) counts too.
  for (const m of markers) {
    const k = Object.keys(map).find((x) => lc(x) === lc(m));
    if (k && !on.includes(k)) on.push(k);
  }
  const onSet = new Set(on.map(lc));
  // Kept in their order: conditions with no marker, and managed ones still on; then the new ones.
  const keep = current.filter((c) => !managed.has(lc(c)) || onSet.has(lc(c)));
  return [...keep, ...on.filter((c) => !keep.some((x) => lc(x) === lc(c)))];
}

export interface Link {
  world_id: string; r20_id: string; r20_name: string; controlled_by: string; account_id: string | null;
  last_hp: number | null; last_max: number | null; last_temp: number | null; last_conditions: string | null; seen_at: string;
}

export const linksOf = (db: DB, worldId: string) => all<Link>(db, 'SELECT * FROM roll20_links WHERE world_id = ? ORDER BY r20_name COLLATE NOCASE', worldId);
export const linkOf = (db: DB, worldId: string, r20Id: string) => one<Link>(db, 'SELECT * FROM roll20_links WHERE world_id = ? AND r20_id = ?', worldId, r20Id);

/** Remember what both sides now agree on, so it is not pushed back. */
export function agree(db: DB, worldId: string, r20Id: string, v: Vitals) {
  run(db, 'UPDATE roll20_links SET last_hp = ?, last_max = ?, last_temp = ?, last_conditions = ? WHERE world_id = ? AND r20_id = ?',
    v.hp, v.maxHp, v.tempHp, JSON.stringify(v.conditions), worldId, r20Id);
}

/** Forget what was agreed: the next sync pushes Alexandria's numbers for these links. */
export function forget(db: DB, worldId: string, r20Id?: string) {
  run(db, `UPDATE roll20_links SET last_hp = NULL, last_max = NULL, last_temp = NULL, last_conditions = NULL WHERE world_id = ? ${r20Id ? 'AND r20_id = ?' : ''}`, worldId, ...(r20Id ? [r20Id] : []));
}

export interface Push { id: string; name: string; hp?: number | null; maxHp?: number | null; tempHp?: number; markers?: string[] }

/**
 * What Roll20 should change: for each linked character, the fields that
 * differ from what was last agreed. Marks them agreed (they are on their way).
 */
export function pendingPushes(db: DB, worldId: string, map: Record<string, string>, opts: { hp: boolean; conditions: boolean }): Push[] {
  const out: Push[] = [];
  for (const l of linksOf(db, worldId)) {
    if (!l.account_id) continue;
    const v = vitalsOf(db, worldId, l.account_id);
    const p: Push = { id: l.r20_id, name: l.r20_name };
    let any = false;
    if (opts.hp) {
      if (v.hp !== null && v.hp !== l.last_hp) { p.hp = v.hp; any = true; }
      if (v.maxHp !== null && v.maxHp !== l.last_max) { p.maxHp = v.maxHp; any = true; }
      if (v.tempHp !== (l.last_temp ?? -1)) { p.tempHp = v.tempHp; any = true; }
    }
    if (opts.conditions) {
      const was = l.last_conditions === null ? null : parseJson<string[]>(l.last_conditions, []);
      const a = markersFor(v.conditions, map).sort().join(',');
      if (was === null || markersFor(was, map).sort().join(',') !== a) { p.markers = markersFor(v.conditions, map); any = true; }
    }
    if (any) { out.push(p); agree(db, worldId, l.r20_id, v); }
  }
  return out;
}

/** Link a Roll20 character to the player whose character (or display) name matches, when exactly one does. */
export function guessAccount(db: DB, worldId: string, name: string, controlledBy: string[]): string | null {
  const players = all<any>(db, "SELECT m.account_id, m.character_name, a.display_name, a.username FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId);
  const byChar = players.filter((p) => p.character_name && lc(p.character_name) === lc(name));
  if (byChar.length === 1) return byChar[0].account_id;
  const owners = new Set(controlledBy.map(lc));
  const byOwner = players.filter((p) => [p.display_name, p.username].some((x) => typeof x === 'string' && owners.has(lc(x))));
  if (byOwner.length === 1) return byOwner[0].account_id;
  return null;
}

/** One line in the DM's Roll20 activity list (newest 100 kept). */
export function activity(db: DB, worldId: string, dir: 'in' | 'out', text: string) {
  run(db, 'INSERT INTO roll20_activity (world_id, dir, text, at) VALUES (?, ?, ?, ?)', worldId, dir, text.slice(0, 300), now());
  run(db, 'DELETE FROM roll20_activity WHERE world_id = ? AND id NOT IN (SELECT id FROM roll20_activity WHERE world_id = ? ORDER BY id DESC LIMIT 100)', worldId, worldId);
}

/** True the first time a key is seen (an event the Mod might send twice). */
export function firstTime(db: DB, worldId: string, key: string): boolean {
  if (one(db, 'SELECT 1 FROM roll20_seen WHERE world_id = ? AND key = ?', worldId, key)) return false;
  run(db, 'INSERT INTO roll20_seen (world_id, key, at) VALUES (?, ?, ?)', worldId, key, now());
  return true;
}

/** A Roll20 roll as Alexandria's chat roll (the same shape /roll makes). */
export interface R20Roll { expr: string; total: number; dice: number[] }
export function rollFrom(rolls: R20Roll[], label: string) {
  const [first, ...rest] = rolls;
  const extra = rest.map((r) => `${r.expr} = ${r.total}`).join(' · ');
  return {
    expr: first.expr.slice(0, 80),
    terms: [{ term: first.expr.slice(0, 80), dice: first.dice.slice(0, 100), sum: first.total }],
    total: first.total,
    note: [label, extra].filter(Boolean).join(' · ').slice(0, 120),
  };
}
