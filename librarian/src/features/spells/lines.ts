// Spell lines (Spell_Plan.md §5) and the spell rules profile (step 2).
//
// A line is a DM-defined family of spells (Fire, Frost, Healing ...) with a
// colour and a short theme. A spell can be in more than one line; one in two
// or more is a hybrid. Line mastery (rules.ts) counts the known spells in a
// line.
//
// The profile is everything a world's spell rules are made of, by spell name
// so it moves between worlds: the mana settings, `spellRules`, the lines with
// their spells, and the recipes.
import { type DB, all, one, run } from '../../core/db.ts';
import { HttpError, id, now } from '../../core/util.ts';

export const LINES_SCHEMA = `
CREATE TABLE IF NOT EXISTS spells_lines (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  theme TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS spells_lines_name ON spells_lines(world_id, name_key);
CREATE TABLE IF NOT EXISTS spells_line_tags (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,
  spell_id TEXT NOT NULL,
  PRIMARY KEY (world_id, line_id, spell_id)
);
CREATE INDEX IF NOT EXISTS spells_line_tags_spell ON spells_line_tags(world_id, spell_id);
`;

export interface Line { id: string; name: string; color: string; theme: string; spells: string[] }

/** The settings a profile carries: the mana rules and the spell rules engine. */
export const PROFILE_SETTINGS = ['spellManaCosts', 'spellManaPool', 'spellManaRest', 'spellManaMaxLevel', 'spellManaOverdraw', 'spellRules'] as const;
export const PROFILE_FORMAT = 'alexandria-spell-rules';
export const MAX_LINES = 50;

const bad = (m: string) => new HttpError(400, m);
const key = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/** A line's name, colour (#rgb or #rrggbb, or empty) and theme, checked. */
export function normalizeLine(raw: any): { name: string; color: string; theme: string } {
  if (!raw || typeof raw !== 'object') throw bad('A line must be an object');
  const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) throw bad('A line needs a name of up to 40 characters');
  const color = raw.color === undefined || raw.color === null ? '' : String(raw.color).trim();
  if (color && !/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(color)) throw bad(`${name}: the colour must look like #e25822`);
  const theme = typeof raw.theme === 'string' ? raw.theme.trim().slice(0, 200) : '';
  return { name, color, theme };
}

export function lines(db: DB, worldId: string): Line[] {
  const tags = new Map<string, string[]>();
  for (const t of all<any>(db, 'SELECT line_id, spell_id FROM spells_line_tags WHERE world_id = ? ORDER BY spell_id', worldId)) tags.set(t.line_id, [...(tags.get(t.line_id) ?? []), t.spell_id]);
  return all<any>(db, 'SELECT id, name, color, theme FROM spells_lines WHERE world_id = ? ORDER BY name_key', worldId)
    .map((r) => ({ id: r.id, name: r.name, color: r.color, theme: r.theme, spells: tags.get(r.id) ?? [] }));
}

export const lineById = (db: DB, worldId: string, lid: string): Line | null => lines(db, worldId).find((l) => l.id === lid) ?? null;
export const lineByName = (db: DB, worldId: string, name: string): { id: string } | null => one<any>(db, 'SELECT id FROM spells_lines WHERE world_id = ? AND name_key = ?', worldId, key(name)) ?? null;

/** Line ids of every spell, for line mastery. */
export function linesOfSpells(db: DB, worldId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of all<any>(db, 'SELECT line_id, spell_id FROM spells_line_tags WHERE world_id = ?', worldId)) out.set(t.spell_id, [...(out.get(t.spell_id) ?? []), t.line_id]);
  return out;
}

/** Create a line, or update the one with the same name. Returns its id. */
export function saveLine(db: DB, worldId: string, x: { name: string; color: string; theme: string }, existingId?: string): string {
  const clash = lineByName(db, worldId, x.name);
  if (existingId) {
    if (clash && clash.id !== existingId) throw new HttpError(409, `There is already a line called ${x.name}`);
    run(db, 'UPDATE spells_lines SET name = ?, name_key = ?, color = ?, theme = ?, updated_at = ? WHERE world_id = ? AND id = ?', x.name, key(x.name), x.color, x.theme, now(), worldId, existingId);
    return existingId;
  }
  if (clash) {
    run(db, 'UPDATE spells_lines SET color = ?, theme = ?, updated_at = ? WHERE world_id = ? AND id = ?', x.color, x.theme, now(), worldId, clash.id);
    return clash.id;
  }
  if ((one<any>(db, 'SELECT COUNT(*) AS n FROM spells_lines WHERE world_id = ?', worldId)?.n ?? 0) >= MAX_LINES) throw bad(`At most ${MAX_LINES} lines`);
  const lid = id('line_');
  run(db, 'INSERT INTO spells_lines (world_id, id, name, name_key, color, theme, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', worldId, lid, x.name, key(x.name), x.color, x.theme, now(), now());
  return lid;
}

export function deleteLine(db: DB, worldId: string, lid: string) {
  run(db, 'DELETE FROM spells_line_tags WHERE world_id = ? AND line_id = ?', worldId, lid);
  run(db, 'DELETE FROM spells_lines WHERE world_id = ? AND id = ?', worldId, lid);
}

/** Replace the spells of a line. */
export function setLineSpells(db: DB, worldId: string, lid: string, spellIds: string[]) {
  run(db, 'DELETE FROM spells_line_tags WHERE world_id = ? AND line_id = ?', worldId, lid);
  for (const s of new Set(spellIds)) run(db, 'INSERT INTO spells_line_tags (world_id, line_id, spell_id) VALUES (?,?,?)', worldId, lid, s);
}

/** Replace the lines of a spell. */
export function setSpellLines(db: DB, worldId: string, spellId: string, lineIds: string[]) {
  run(db, 'DELETE FROM spells_line_tags WHERE world_id = ? AND spell_id = ?', worldId, spellId);
  for (const l of new Set(lineIds)) run(db, 'INSERT INTO spells_line_tags (world_id, line_id, spell_id) VALUES (?,?,?)', worldId, l, spellId);
}

/** Drop the tags of a spell that no longer exists (a deleted homebrew spell). */
export const forgetSpell = (db: DB, worldId: string, spellId: string) => run(db, 'DELETE FROM spells_line_tags WHERE world_id = ? AND spell_id = ?', worldId, spellId);

/** Read a profile from a request body: the object, or its JSON text under `profile` or `json`. */
export function readProfile(body: any): any {
  let p = body?.profile ?? body?.json ?? body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { throw bad('That is not valid JSON'); } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('A spell rules profile must be an object');
  if (p.format !== undefined && p.format !== PROFILE_FORMAT) throw bad(`This is not a spell rules profile (format ${String(p.format).slice(0, 40)})`);
  if (p.lines !== undefined && (!Array.isArray(p.lines) || p.lines.length > MAX_LINES)) throw bad(`lines must be a list of up to ${MAX_LINES}`);
  if (p.recipes !== undefined && (!Array.isArray(p.recipes) || p.recipes.length > 2000)) throw bad('recipes must be a list of up to 2000');
  if (p.settings !== undefined && (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings))) throw bad('settings must be an object');
  for (const k of Object.keys(p.settings ?? {})) if (!(PROFILE_SETTINGS as readonly string[]).includes(k)) throw bad(`A profile carries only ${PROFILE_SETTINGS.join(', ')}; not ${k.slice(0, 40)}`);
  return p;
}
