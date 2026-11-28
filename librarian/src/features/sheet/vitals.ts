// A character's health on their sheet: HP, max HP, temporary HP and
// conditions, kept between sessions. The combat tracker's row for the same
// player and the sheet stay in step: a change on either side is copied to the
// other and written to the sheet log, so the GM can see every change, who
// made it and where (the sheet, the combat tracker, the GM).
import { type DB, all, one, run } from '../../core/db.ts';
import { applyDamage, applyHeal, gainTempHp, syncDeathTags, type DeathSaves, type Effect } from '../../core/combatRules.ts';
import { id, now, parseJson } from '../../core/util.ts';

export interface Vitals { hp: number | null; maxHp: number | null; tempHp: number; conditions: string[] }
export type Source = 'sheet' | 'combat' | 'gm' | 'foundry' | 'roll20' | 'import';
export interface VitalsChange {
  damage?: number; crit?: boolean; heal?: number;
  /** Set HP outright. */
  hp?: number | null;
  maxHp?: number | null;
  /** Gain temporary HP (they do not stack: the higher amount stays). */
  tempHp?: number;
  /** Set temporary HP outright (0 clears it). */
  setTempHp?: number;
  conditions?: string[];
}

export function vitalsOf(db: DB, worldId: string, accountId: string): Vitals {
  const r = one<any>(db, 'SELECT hp, max_hp, temp_hp, conditions FROM sheets WHERE world_id = ? AND account_id = ?', worldId, accountId);
  return { hp: r?.hp ?? null, maxHp: r?.max_hp ?? null, tempHp: r?.temp_hp ?? 0, conditions: parseJson<string[]>(r?.conditions, []) };
}

function save(db: DB, worldId: string, accountId: string, v: Vitals) {
  run(db, `INSERT INTO sheets (world_id, account_id, hp, max_hp, temp_hp, conditions, modules, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT (world_id, account_id) DO UPDATE SET hp = excluded.hp, max_hp = excluded.max_hp, temp_hp = excluded.temp_hp, conditions = excluded.conditions, updated_at = excluded.updated_at`,
  worldId, accountId, v.hp, v.maxHp, v.tempHp, JSON.stringify(v.conditions), now());
}

export function logVitals(db: DB, worldId: string, accountId: string, kind: string, before: number | null, after: number | null, note: string, source: Source, by: string | null) {
  run(db, 'INSERT INTO sheet_log (id, world_id, account_id, kind, before, after, amount, note, source, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id('shl_'), worldId, accountId, kind, before, after, before !== null && after !== null ? after - before : null, note.slice(0, 300), source, by, now());
}

/** Writes one log line per field that changed. */
function logDiff(db: DB, worldId: string, accountId: string, a: Vitals, b: Vitals, note: string, source: Source, by: string | null) {
  if (a.hp !== b.hp) logVitals(db, worldId, accountId, 'hp', a.hp, b.hp, note, source, by);
  if (a.tempHp !== b.tempHp) logVitals(db, worldId, accountId, 'temp', a.tempHp, b.tempHp, note, source, by);
  if (a.maxHp !== b.maxHp) logVitals(db, worldId, accountId, 'max', a.maxHp, b.maxHp, note, source, by);
  const added = b.conditions.filter((c) => !a.conditions.some((x) => x.toLowerCase() === c.toLowerCase()));
  const gone = a.conditions.filter((c) => !b.conditions.some((x) => x.toLowerCase() === c.toLowerCase()));
  if (added.length || gone.length) logVitals(db, worldId, accountId, 'conditions', null, null, [added.length ? `+ ${added.join(', ')}` : '', gone.length ? `− ${gone.join(', ')}` : '', note].filter(Boolean).join(' · '), source, by);
}

const combatantOf = (db: DB, worldId: string, accountId: string) =>
  one<any>(db, 'SELECT * FROM combatants WHERE world_id = ? AND account_id = ? ORDER BY rowid LIMIT 1', worldId, accountId);

/**
 * Applies a change made on the sheet (by the player or the GM). When the
 * player is in the combat tracker, damage and healing follow its rules there
 * too (death saves, Stable/Dead tags) and the tracker row gets the new numbers.
 * Returns what changed and whether the tracker needs a push.
 */
export function changeVitals(db: DB, worldId: string, accountId: string, ch: VitalsChange, source: Source, by: string | null, note = ''): { before: Vitals; after: Vitals; notes: string[]; combat: boolean } {
  const before = vitalsOf(db, worldId, accountId);
  const cb = combatantOf(db, worldId, accountId);
  let hp = before.hp, maxHp = before.maxHp, tempHp = before.tempHp;
  let deathSaves: DeathSaves | null = cb ? parseJson<DeathSaves | null>(cb.death_saves, null) : null;
  const notes: string[] = [];
  if (ch.maxHp !== undefined) { maxHp = ch.maxHp; if (hp !== null && maxHp !== null && hp > maxHp) hp = maxHp; }
  if (ch.hp !== undefined) { hp = ch.hp; if (hp !== null && hp > 0) deathSaves = null; }
  if (ch.setTempHp !== undefined) tempHp = ch.setTempHp;
  if (ch.tempHp !== undefined) {
    const had = tempHp;
    tempHp = gainTempHp(had, ch.tempHp);
    notes.push(ch.tempHp > had ? `temporary HP now ${tempHp}` : `kept ${had} temporary HP (they do not stack)`);
  }
  if (ch.damage !== undefined && ch.damage > 0) {
    const hit = applyDamage({ hp, maxHp, tempHp, isPc: true, concentration: null, deathSaves }, ch.damage, !!ch.crit);
    hp = hit.hp; tempHp = hit.tempHp; deathSaves = hit.deathSaves;
    notes.push(...hit.notes);
  }
  if (ch.heal !== undefined && ch.heal > 0) {
    const h = applyHeal({ hp, maxHp, tempHp, isPc: true, concentration: null, deathSaves }, ch.heal);
    hp = h.hp; deathSaves = h.deathSaves;
    if (h.revived) notes.push('back above 0 HP: death saves reset');
  }
  const after: Vitals = { hp, maxHp, tempHp, conditions: ch.conditions ?? before.conditions };
  save(db, worldId, accountId, after);
  logDiff(db, worldId, accountId, before, after, note, source, by);
  let combat = false;
  if (cb && (after.hp !== cb.hp || after.maxHp !== cb.max_hp || after.tempHp !== (cb.temp_hp ?? 0) || ch.damage !== undefined || ch.heal !== undefined || ch.hp !== undefined)) {
    // Out of the tracker the sheet keeps no death saves; in it they follow the rules as for the GM's own changes.
    const eff = syncDeathTags(parseJson<Effect[]>(cb.effects, []), deathSaves);
    run(db, 'UPDATE combatants SET hp = ?, max_hp = ?, temp_hp = ?, death_saves = ?, effects = ? WHERE id = ?', after.hp, after.maxHp, after.tempHp, deathSaves ? JSON.stringify(deathSaves) : null, JSON.stringify(eff), cb.id);
    combat = true;
  }
  return { before, after, notes, combat };
}

/**
 * The combat tracker changed a player's row: copy HP, max HP and temporary HP
 * to the sheet and log it. True when anything changed.
 */
export function fromCombat(db: DB, worldId: string, accountId: string, v: { hp: number | null; maxHp: number | null; tempHp: number }, by: string | null, note = 'Combat tracker'): boolean {
  const before = vitalsOf(db, worldId, accountId);
  const after: Vitals = { ...before, hp: v.hp, maxHp: v.maxHp, tempHp: v.tempHp ?? 0 };
  if (after.hp === before.hp && after.maxHp === before.maxHp && after.tempHp === before.tempHp) return false;
  save(db, worldId, accountId, after);
  logDiff(db, worldId, accountId, before, after, note, 'combat', by);
  return true;
}

/** HP, max HP and temporary HP for a player joining the combat tracker with no numbers given. */
export function seedForCombat(db: DB, worldId: string, accountId: string): { hp: number | null; maxHp: number | null; tempHp: number } | null {
  const r = one<any>(db, 'SELECT hp, max_hp, temp_hp FROM sheets WHERE world_id = ? AND account_id = ?', worldId, accountId);
  if (!r || (r.hp === null && r.max_hp === null)) return null;
  return { hp: r.hp ?? r.max_hp, maxHp: r.max_hp ?? r.hp, tempHp: r.temp_hp ?? 0 };
}

export function vitalsLog(db: DB, worldId: string, accountId: string | null, limit = 200) {
  return all<any>(db, `SELECT * FROM sheet_log WHERE world_id = ? ${accountId ? 'AND account_id = ?' : ''} ORDER BY at DESC, rowid DESC LIMIT ?`, worldId, ...(accountId ? [accountId] : []), limit);
}
