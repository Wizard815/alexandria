// Where spells live: the bundled SRD 5.2.1 list (read once), the world's own
// spells (homebrew and imports, deduplicated by name + source), the DM's
// per-spell settings (open to players, mana cost, notes), each character's
// sheet for spells (class, level, ability scores, mana) and known spells.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DB, all, one, run } from '../../core/db.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { ABILITIES, nameKey, slug, type Ability, type Spell } from './format.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS spells_custom (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'homebrew',
  attribution TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS spells_custom_name ON spells_custom(world_id, name_key, source_key);
CREATE TABLE IF NOT EXISTS spells_meta (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  spell_id TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  mana_cost INTEGER,
  dm_notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (world_id, spell_id)
);
CREATE TABLE IF NOT EXISTS spells_chars (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class TEXT NOT NULL DEFAULT '',
  level INTEGER,
  abilities TEXT NOT NULL DEFAULT '{}',
  casting_ability TEXT NOT NULL DEFAULT '',
  mana_max INTEGER,
  mana INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id)
);
CREATE TABLE IF NOT EXISTS spells_known (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  spell_id TEXT NOT NULL,
  how TEXT NOT NULL DEFAULT 'dm',
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id, spell_id)
);
CREATE TABLE IF NOT EXISTS spells_recipes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL,
  prereqs TEXT NOT NULL DEFAULT '[]',
  items TEXT NOT NULL DEFAULT '[]',
  stats TEXT NOT NULL DEFAULT '{}',
  min_level INTEGER,
  mana_cost INTEGER,
  visibility TEXT NOT NULL DEFAULT 'visible',
  dm_notes TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spells_recipes_world ON spells_recipes(world_id);
CREATE TABLE IF NOT EXISTS spells_learn (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  recipe_id TEXT NOT NULL,
  spell_id TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  consumed TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS spells_learn_world ON spells_learn(world_id, status);
CREATE TABLE IF NOT EXISTS spells_log (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  spell_id TEXT,
  amount INTEGER,
  mana_after INTEGER,
  note TEXT NOT NULL DEFAULT '',
  by_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spells_log_world ON spells_log(world_id, account_id);
`;

// ---- the bundled list -----------------------------------------------------------------------------------

export interface Bundled { id: string; name: string; version: string; license: string; attribution: string; source: string; spells: Spell[] }
const here = path.dirname(fileURLToPath(import.meta.url));
let bundled: Bundled | null = null;
export function srd(): Bundled {
  if (!bundled) bundled = JSON.parse(fs.readFileSync(path.join(here, 'data', 'srd-5.2.1-spells.json'), 'utf8')) as Bundled;
  return bundled;
}
export const SRD_SOURCE = 'SRD 5.2.1';

/** Official spells outside the SRD: name, level, school, class lists and book only (the description is in the book). */
export interface Official { books: Record<string, string>; spells: (Spell & { book?: string })[] }
let official: Official | null = null;
export function officialBooks(): Official {
  if (!official) official = JSON.parse(fs.readFileSync(path.join(here, 'data', 'official-spells.json'), 'utf8')) as Official;
  return official;
}
/** The books a world turned off (world setting spellBooks: {XGE: false, ...}). */
function booksOff(db: DB, worldId: string): Set<string> {
  const st = parseJson<Record<string, unknown>>(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {});
  const b = (st.spellBooks ?? {}) as Record<string, unknown>;
  return new Set(Object.entries(b).filter(([, v]) => v === false).map(([k]) => k));
}
const bookSpell = (s: Official['spells'][number], pub: boolean): WorldSpell => ({ ...s, builtin: true, kind: 'srd', attribution: `Facts only; the description is in ${s.book ?? s.source}.`, public: pub, manaOverride: null, dmNotes: '' });

/** A spell as the world serves it: where it came from, and the DM's settings for it. */
export interface WorldSpell extends Spell {
  builtin: boolean;
  kind: 'srd' | 'homebrew' | 'import';
  attribution: string;
  public: boolean;
  manaOverride: number | null;
  dmNotes: string;
}

export interface Meta { public: boolean; manaCost: number | null; dmNotes: string }
export function metaMap(db: DB, worldId: string): Map<string, Meta> {
  return new Map(all<any>(db, 'SELECT spell_id, public, mana_cost, dm_notes FROM spells_meta WHERE world_id = ?', worldId)
    .map((r) => [r.spell_id, { public: !!r.public, manaCost: r.mana_cost ?? null, dmNotes: r.dm_notes ?? '' }]));
}

function customRows(db: DB, worldId: string): WorldSpell[] {
  return all<any>(db, 'SELECT * FROM spells_custom WHERE world_id = ? ORDER BY name COLLATE NOCASE', worldId).map((r) => ({
    ...(parseJson<Spell>(r.data, {} as Spell)), id: r.id, name: r.name, source: r.source,
    builtin: false, kind: r.kind === 'import' ? 'import' : 'homebrew', attribution: r.attribution ?? '', public: false, manaOverride: null, dmNotes: '',
  }));
}

/** Every spell in the world, SRD first then the world's own, with the DM's settings filled in. */
export function catalog(db: DB, worldId: string, publicSrd = false): WorldSpell[] {
  const meta = metaMap(db, worldId);
  const b = srd();
  const out: WorldSpell[] = [
    ...b.spells.map((s) => ({ ...s, builtin: true, kind: 'srd' as const, attribution: b.attribution, public: publicSrd, manaOverride: null, dmNotes: '' })),
    ...(() => { const off = booksOff(db, worldId); return officialBooks().spells.filter((s) => !off.has(String(s.source))).map((s) => bookSpell(s, publicSrd)); })(),
    ...customRows(db, worldId),
  ];
  for (const s of out) {
    const m = meta.get(s.id);
    if (!m) continue;
    s.public = s.public || m.public;
    s.manaOverride = m.manaCost;
    s.dmNotes = m.dmNotes;
  }
  return out;
}

export function spellById(db: DB, worldId: string, spellId: string, publicSrd = false): WorldSpell | null {
  if (spellId.startsWith('srd:')) {
    const b = srd();
    const s = b.spells.find((x) => x.id === spellId);
    if (!s) return null;
    const m = metaMap(db, worldId).get(spellId);
    return { ...s, builtin: true, kind: 'srd', attribution: b.attribution, public: publicSrd || !!m?.public, manaOverride: m?.manaCost ?? null, dmNotes: m?.dmNotes ?? '' };
  }
  if (spellId.startsWith('book:')) {
    const s = officialBooks().spells.find((x) => x.id === spellId);
    if (!s || booksOff(db, worldId).has(String(s.source))) return null;
    const m = metaMap(db, worldId).get(spellId);
    return { ...bookSpell(s, publicSrd || !!m?.public), manaOverride: m?.manaCost ?? null, dmNotes: m?.dmNotes ?? '' };
  }
  const r = one<any>(db, 'SELECT * FROM spells_custom WHERE world_id = ? AND id = ?', worldId, spellId);
  if (!r) return null;
  const m = metaMap(db, worldId).get(spellId);
  return { ...(parseJson<Spell>(r.data, {} as Spell)), id: r.id, name: r.name, source: r.source, builtin: false, kind: r.kind === 'import' ? 'import' : 'homebrew', attribution: r.attribution ?? '', public: !!m?.public, manaOverride: m?.manaCost ?? null, dmNotes: m?.dmNotes ?? '' };
}

/** A spell by id, or by name (an exact name, case and apostrophes aside; the SRD wins a tie). */
export function findSpell(db: DB, worldId: string, ref: string): WorldSpell | null {
  const byId = spellById(db, worldId, ref);
  if (byId) return byId;
  const k = nameKey(ref);
  if (!k) return null;
  return catalog(db, worldId).find((s) => nameKey(s.name) === k) ?? null;
}

const sourceKey = (s: string) => slug(s) || 'homebrew';

/** Is there already a spell with this name from this source (the SRD counts as "SRD 5.2.1")? */
export function duplicateOf(db: DB, worldId: string, name: string, source: string): string | null {
  const nk = nameKey(name);
  if (sourceKey(source) === sourceKey(SRD_SOURCE)) {
    const s = srd().spells.find((x) => nameKey(x.name) === nk);
    if (s) return s.id;
  }
  return one<any>(db, 'SELECT id FROM spells_custom WHERE world_id = ? AND name_key = ? AND source_key = ?', worldId, nk, sourceKey(source))?.id ?? null;
}

export function saveCustom(db: DB, worldId: string, s: Omit<Spell, 'id'>, kind: 'homebrew' | 'import', attribution = '', existingId?: string): string {
  const sid = existingId ?? `w:${id('')}`;
  const dup = duplicateOf(db, worldId, s.name, s.source);
  if (dup && dup !== existingId) throw new HttpError(409, `${s.name} from ${s.source} is already in the list`);
  const data = JSON.stringify({ ...s, id: sid });
  if (existingId) {
    if (!run(db, 'UPDATE spells_custom SET name = ?, name_key = ?, source = ?, source_key = ?, data = ?, updated_at = ? WHERE world_id = ? AND id = ?', s.name, nameKey(s.name), s.source, sourceKey(s.source), data, now(), worldId, existingId)) throw new HttpError(404, 'Spell not found');
  } else {
    run(db, 'INSERT INTO spells_custom (world_id, id, name, name_key, source, source_key, kind, attribution, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', worldId, sid, s.name, nameKey(s.name), s.source, sourceKey(s.source), kind, attribution.slice(0, 1000), data, now(), now());
  }
  return sid;
}

export function setMeta(db: DB, worldId: string, spellId: string, patch: Partial<Meta>) {
  const cur = metaMap(db, worldId).get(spellId) ?? { public: false, manaCost: null, dmNotes: '' };
  const next = { ...cur, ...patch };
  run(db, 'INSERT INTO spells_meta (world_id, spell_id, public, mana_cost, dm_notes) VALUES (?,?,?,?,?) ON CONFLICT(world_id, spell_id) DO UPDATE SET public = excluded.public, mana_cost = excluded.mana_cost, dm_notes = excluded.dm_notes',
    worldId, spellId, next.public ? 1 : 0, next.manaCost, next.dmNotes);
}

// ---- characters -----------------------------------------------------------------------------------------

export interface Character {
  accountId: string;
  name: string;
  class: string;
  level: number | null;
  abilities: Partial<Record<Ability, number>>;
  castingAbility: Ability | '';
  manaMax: number | null;
  mana: number | null;
  /** Where each value came from when the spell sheet has none: the player's profile blocks. */
  from: { level?: 'profile'; abilities?: Ability[] };
  /** Levels per caster type (spell rules engine); empty when not set. */
  casterLevels?: Partial<Record<'full' | 'half' | 'third', number>>;
}

const ABBR: Record<string, Ability> = { str: 'str', strength: 'str', dex: 'dex', dexterity: 'dex', con: 'con', constitution: 'con', int: 'int', intelligence: 'int', wis: 'wis', wisdom: 'wis', cha: 'cha', charisma: 'cha' };

/**
 * Ability scores and level a player wrote on their own profile ("Me" page) in
 * blocks the DM may read (party or DM, never "only me"): a block titled
 * "Level", or "Abilities"/"Ability scores"/"Stats" with "INT 13, WIS 10", or
 * one titled "Intelligence" with "13". The spell sheet's own values win.
 */
export function profileStats(db: DB, worldId: string, accountId: string): { level: number | null; abilities: Partial<Record<Ability, number>> } {
  const out: { level: number | null; abilities: Partial<Record<Ability, number>> } = { level: null, abilities: {} };
  let rows: any[] = [];
  try { rows = all<any>(db, "SELECT title, body FROM profile_blocks WHERE world_id = ? AND account_id = ? AND visibility IN ('party', 'dm')", worldId, accountId); } catch { return out; }
  for (const r of rows) {
    const t = String(r.title ?? '').trim().toLowerCase();
    const body = String(r.body ?? '');
    if (t === 'level' || t === 'character level') { const n = parseInt(body.match(/\d+/)?.[0] ?? '', 10); if (n >= 1 && n <= 20) out.level = n; continue; }
    if (ABBR[t]) { const n = parseInt(body.match(/\d+/)?.[0] ?? '', 10); if (n >= 1 && n <= 30) out.abilities[ABBR[t]] = n; continue; }
    if (/^(abilities|ability scores|stats|attributes)$/.test(t)) {
      for (const m of body.matchAll(/\b(str(?:ength)?|dex(?:terity)?|con(?:stitution)?|int(?:elligence)?|wis(?:dom)?|cha(?:risma)?)\b\s*[:=]?\s*(\d{1,2})/gi)) {
        const k = ABBR[m[1].toLowerCase()];
        const n = Number(m[2]);
        if (k && n >= 1 && n <= 30) out.abilities[k] = n;
      }
    }
  }
  return out;
}

export function character(db: DB, worldId: string, accountId: string): Character {
  const r = one<any>(db, 'SELECT * FROM spells_chars WHERE world_id = ? AND account_id = ?', worldId, accountId);
  const m = one<any>(db, 'SELECT a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', worldId, accountId);
  const own = parseJson<Partial<Record<Ability, number>>>(r?.abilities, {});
  const prof = profileStats(db, worldId, accountId);
  const abilities: Partial<Record<Ability, number>> = {};
  const fromProfile: Ability[] = [];
  for (const k of ABILITIES) {
    if (typeof own[k] === 'number') abilities[k] = own[k];
    else if (typeof prof.abilities[k] === 'number') { abilities[k] = prof.abilities[k]; fromProfile.push(k); }
  }
  const level = r?.level ?? prof.level ?? null;
  return {
    accountId,
    name: m ? m.character_name || m.display_name : '',
    class: r?.class ?? '',
    level,
    abilities,
    castingAbility: (ABILITIES as readonly string[]).includes(r?.casting_ability) ? r.casting_ability : '',
    manaMax: r?.mana_max ?? null,
    mana: r?.mana ?? null,
    from: { ...(r?.level == null && prof.level != null ? { level: 'profile' as const } : {}), ...(fromProfile.length ? { abilities: fromProfile } : {}) },
    casterLevels: parseJson(one<any>(db, 'SELECT caster_levels FROM spells_state WHERE world_id = ? AND account_id = ?', worldId, accountId)?.caster_levels, {}),
  };
}

export function saveCharacter(db: DB, worldId: string, accountId: string, patch: { class?: string; level?: number | null; abilities?: Partial<Record<Ability, number>>; castingAbility?: string; manaMax?: number | null; mana?: number | null }) {
  const r = one<any>(db, 'SELECT * FROM spells_chars WHERE world_id = ? AND account_id = ?', worldId, accountId);
  const cur = { class: r?.class ?? '', level: r?.level ?? null, abilities: parseJson<Record<string, number>>(r?.abilities, {}), casting: r?.casting_ability ?? '', manaMax: r?.mana_max ?? null, mana: r?.mana ?? null };
  const next = {
    class: patch.class !== undefined ? patch.class : cur.class,
    level: patch.level !== undefined ? patch.level : cur.level,
    abilities: patch.abilities !== undefined ? { ...cur.abilities, ...patch.abilities } : cur.abilities,
    casting: patch.castingAbility !== undefined ? patch.castingAbility : cur.casting,
    manaMax: patch.manaMax !== undefined ? patch.manaMax : cur.manaMax,
    mana: patch.mana !== undefined ? patch.mana : cur.mana,
  };
  for (const k of Object.keys(next.abilities)) if (next.abilities[k] === null || next.abilities[k] === undefined) delete next.abilities[k];
  run(db, `INSERT INTO spells_chars (world_id, account_id, class, level, abilities, casting_ability, mana_max, mana, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(world_id, account_id) DO UPDATE SET class = excluded.class, level = excluded.level, abilities = excluded.abilities, casting_ability = excluded.casting_ability, mana_max = excluded.mana_max, mana = excluded.mana, updated_at = excluded.updated_at`,
    worldId, accountId, next.class, next.level, JSON.stringify(next.abilities), next.casting, next.manaMax, next.mana, now());
}

export const knownIds = (db: DB, worldId: string, accountId: string): Set<string> =>
  new Set(all<any>(db, 'SELECT spell_id FROM spells_known WHERE world_id = ? AND account_id = ?', worldId, accountId).map((r) => r.spell_id));

export function knownRows(db: DB, worldId: string, accountId: string): { spellId: string; how: string; at: string }[] {
  return all<any>(db, 'SELECT spell_id, how, at FROM spells_known WHERE world_id = ? AND account_id = ? ORDER BY at', worldId, accountId).map((r) => ({ spellId: r.spell_id, how: r.how, at: r.at }));
}

export function addKnown(db: DB, worldId: string, accountId: string, spellId: string, how: string): boolean {
  return run(db, 'INSERT OR IGNORE INTO spells_known (world_id, account_id, spell_id, how, at) VALUES (?,?,?,?,?)', worldId, accountId, spellId, how, now()) > 0;
}

export function logEntry(db: DB, worldId: string, accountId: string, kind: string, by: string | null, extra: { spellId?: string | null; amount?: number | null; manaAfter?: number | null; note?: string } = {}) {
  run(db, 'INSERT INTO spells_log (id, world_id, account_id, kind, spell_id, amount, mana_after, note, by_id, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id('spl_'), worldId, accountId, kind, extra.spellId ?? null, extra.amount ?? null, extra.manaAfter ?? null, (extra.note ?? '').slice(0, 500), by, now());
}

/** Accounts of the world's players (the characters). */
export const playerIds = (db: DB, worldId: string): string[] =>
  all<any>(db, "SELECT account_id FROM members WHERE world_id = ? AND role = 'player' ORDER BY account_id", worldId).map((r) => r.account_id);
