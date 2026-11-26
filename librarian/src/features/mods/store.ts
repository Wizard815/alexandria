// House rules in a world: which are on, their options, the world settings a
// rule switched (to put back when it goes off), the counters per character
// and the log of every change. The routes, chat command and assistant tools
// in index.ts all go through here.
import { type DB, all, one, run, tx as dbTx } from '../../core/db.ts';
import { DEFAULT_SETTINGS, mergeSettings, type Role } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { enabledIds as gameModuleIds, invalidate as invalidateGlossary } from '../modules/store.ts';
import { VERSION } from '../../version.ts';
import { shippedMod, shippedMods, targetInfo } from './catalog.ts';
import { satisfies } from './semver.ts';
import { seedRecords } from './recstore.ts';
import { MOD_API, checkMod, toFile, okOption, presetValues, resolveOptions, val, type Action, type ModFile, type Resource } from './format.ts';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mods (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    source TEXT NOT NULL,            -- 'shipped' (comes with the app) or 'imported'
    json TEXT,                       -- the mod file (imported only)
    enabled INTEGER NOT NULL DEFAULT 0,
    options TEXT NOT NULL DEFAULT '{}',
    saved TEXT NOT NULL DEFAULT '{}', -- world settings as they were before the rule's presets
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    PRIMARY KEY (world_id, id)
  );
  CREATE TABLE IF NOT EXISTS mod_counts (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    mod_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (world_id, mod_id, account_id, resource)
  );
  CREATE TABLE IF NOT EXISTS mod_log (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    mod_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    resource TEXT NOT NULL,
    before INTEGER NOT NULL,
    after INTEGER NOT NULL,
    action TEXT NOT NULL,
    by TEXT,
    note TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mod_log_world ON mod_log(world_id, at);
`;

export interface Installed {
  mod: ModFile;
  source: 'shipped' | 'imported';
  /** The feature that ships it (shipped only). */
  feature?: string;
  enabled: boolean;
  options: Record<string, unknown>;
  saved: Record<string, unknown>;
  /** Settings the rule needs that this Alexandria does not have (e.g. the MANA engine): it cannot be turned on. */
  missing: string[];
  /** Preset settings this Alexandria does not have yet: skipped, and applied once they exist. */
  waiting: string[];
  /** Why it cannot be turned on here, in plain words (empty: it can). Filled by listMods / getMod. */
  needs: string[];
  /** Its targets and whether this world has each. */
  targets: { builtFor: { id: string; label: string; ok: boolean }[]; worksWith: { id: string; label: string; ok: boolean }[] };
}

const known = (k: string) => k in DEFAULT_SETTINGS;

// One transaction, also when a step calls another step (turning a rule on turns its group's other rule off).
const depth = new WeakMap<DB, number>();
function tx<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) { depth.set(db, d + 1); try { return fn(); } finally { depth.set(db, d); } }
  depth.set(db, 1);
  try { return dbTx(db, fn); } finally { depth.set(db, 0); }
}

function build(mod: ModFile, source: Installed['source'], row: any | undefined, feature?: string): Installed {
  return {
    mod, source, ...(feature ? { feature } : {}),
    enabled: !!row?.enabled,
    options: resolveOptions(mod, parseJson(row?.options, {})),
    saved: parseJson(row?.saved, {}),
    missing: mod.requires.settings.filter((k) => !known(k)),
    waiting: Object.keys(mod.presets).filter((k) => !known(k)),
    needs: [], targets: { builtFor: [], worksWith: [] },
  };
}

/** Work out, for every rule of a world, what it is missing: Alexandria or mod API version, settings, targets, the rules it needs. */
function annotate(db: DB, worldId: string, list: Installed[]): Installed[] {
  let games: string[] = [];
  try { games = gameModuleIds(db, worldId); } catch { /* no game modules table yet */ }
  const byId = new Map(list.map((m) => [m.mod.id, m]));
  const own = new Map<string, string[]>();
  for (const m of list) {
    const n: string[] = [];
    if (m.mod.alexandria && !satisfies(VERSION, m.mod.alexandria)) n.push(`Needs Alexandria ${m.mod.alexandria} (this server runs ${VERSION})`);
    if (m.mod.api > MOD_API) n.push(`Needs mod API ${m.mod.api} (this Alexandria offers ${MOD_API})`);
    if (m.missing.length) n.push(`Needs a part of Alexandria this server does not have yet (${m.missing.join(', ')})`);
    m.targets = { builtFor: m.mod.targets.builtFor.map((t) => targetInfo(t, games)), worksWith: m.mod.targets.worksWith.map((t) => targetInfo(t, games)) };
    for (const t of m.targets.builtFor) if (!t.ok) n.push(`Built for ${t.label}, which this world does not have`);
    for (const [rid, range] of Object.entries(m.mod.requires.mods)) {
      const r = byId.get(rid);
      if (!r) n.push(`Needs the house rule ${rid}${range !== '*' ? ` ${range}` : ''}, which this world does not have`);
      else if (!satisfies(r.mod.version, range)) n.push(`Needs ${r.mod.name} ${range} (this world has ${r.mod.version})`);
    }
    own.set(m.mod.id, n);
  }
  // A rule whose required rule cannot be turned on cannot be turned on either (followed a few steps; cycles stop).
  const blocked = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const m = byId.get(id);
    if (!m) return true;
    return own.get(id)!.length > 0 || Object.keys(m.mod.requires.mods).some((r) => blocked(r, seen));
  };
  for (const m of list) {
    const n = [...own.get(m.mod.id)!];
    for (const rid of Object.keys(m.mod.requires.mods)) {
      const r = byId.get(rid);
      if (r && !own.get(m.mod.id)!.some((x) => x.includes(r.mod.name)) && blocked(rid, new Set([m.mod.id]))) n.push(`Needs ${r.mod.name}, which cannot be turned on here`);
    }
    m.needs = n;
  }
  return list;
}

/** Every house rule this world could turn on: shipped ones, then its imports. */
export function listMods(db: DB, worldId: string): Installed[] {
  const rows = new Map(all<any>(db, 'SELECT * FROM mods WHERE world_id = ?', worldId).map((r) => [r.id, r]));
  const out = shippedMods().map((s) => build(s.mod, 'shipped', rows.get(s.mod.id), s.feature));
  for (const r of rows.values()) {
    if (r.source !== 'imported') continue;
    const { mod } = checkMod(r.json);
    if (mod) out.push(build(mod, 'imported', r));
  }
  return annotate(db, worldId, out);
}

export function getMod(db: DB, worldId: string, modId: string): Installed {
  const m = listMods(db, worldId).find((x) => x.mod.id === modId);
  if (m) return m;
  throw new HttpError(404, `No house rule ${String(modId).slice(0, 60)}`);
}

/** One rule without working out what it needs (cheap; for counters and actions). */
export function getModRaw(db: DB, worldId: string, modId: string): Installed {
  const s = shippedMod(modId);
  const row = one<any>(db, 'SELECT * FROM mods WHERE world_id = ? AND id = ?', worldId, modId);
  if (s) return build(s.mod, 'shipped', row, s.feature);
  if (row?.source === 'imported') {
    const { mod } = checkMod(row.json);
    if (mod) return build(mod, 'imported', row);
  }
  throw new HttpError(404, `No house rule ${String(modId).slice(0, 60)}`);
}

export const enabledMods = (db: DB, worldId: string) => listMods(db, worldId).filter((m) => m.enabled);

function upsert(db: DB, worldId: string, modId: string, source: string, fields: { json?: string | null; enabled?: boolean; options?: unknown; saved?: unknown }, by: string | null) {
  const cur = one<any>(db, 'SELECT * FROM mods WHERE world_id = ? AND id = ?', worldId, modId);
  const next = {
    json: fields.json !== undefined ? fields.json : cur?.json ?? null,
    enabled: fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : cur?.enabled ?? 0,
    options: fields.options !== undefined ? JSON.stringify(fields.options) : cur?.options ?? '{}',
    saved: fields.saved !== undefined ? JSON.stringify(fields.saved) : cur?.saved ?? '{}',
  };
  run(db, `INSERT INTO mods (world_id, id, source, json, enabled, options, saved, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(world_id, id) DO UPDATE SET json = excluded.json, enabled = excluded.enabled, options = excluded.options, saved = excluded.saved, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  worldId, modId, source, next.json, next.enabled, next.options, next.saved, now(), by);
}

// ---- world settings ------------------------------------------------------------------------------------------------

const worldSettings = (db: DB, worldId: string): Record<string, unknown> => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {}) });

function patchSettings(db: DB, worldId: string, patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch).filter(known);
  if (!keys.length) return false;
  let next;
  try { next = mergeSettings(worldSettings(db, worldId) as any, Object.fromEntries(keys.map((k) => [k, patch[k]]))); } catch (e: any) { throw new HttpError(400, `This house rule sets a world setting the server refuses: ${e.message}`); }
  run(db, 'UPDATE worlds SET settings = ? WHERE id = ?', JSON.stringify(next), worldId);
  return true;
}

export interface Switched { settingsChanged: boolean; turnedOff: string[]; turnedOn: string[] }

/**
 * Turn a rule on or off.
 * On: the rules it needs go on first, rules of its group or in conflict with it go off, then its presets are
 * applied (old values kept). Off: rules that need it are refused unless `cascade` turns them off too; then
 * the old setting values come back.
 */
export function setEnabled(db: DB, worldId: string, modId: string, on: boolean, by: string | null, opts: { cascade?: boolean; chain?: Set<string> } = {}): Switched {
  return tx(db, () => {
    const m = getMod(db, worldId, modId);
    const out: Switched = { settingsChanged: false, turnedOff: [], turnedOn: [] };
    if (on === m.enabled) return out;
    const merge = (r: Switched) => { out.settingsChanged ||= r.settingsChanged; out.turnedOff.push(...r.turnedOff.filter((x) => !out.turnedOff.includes(x))); out.turnedOn.push(...r.turnedOn.filter((x) => !out.turnedOn.includes(x))); };
    if (on) {
      if (m.needs.length) throw new HttpError(409, `${m.mod.name} cannot be turned on here: ${m.needs.join('; ')}`);
      const chain = opts.chain ?? new Set<string>();
      chain.add(modId);
      // The rules it builds on.
      for (const rid of Object.keys(m.mod.requires.mods)) {
        if (chain.has(rid)) continue;
        const r = getMod(db, worldId, rid);
        if (!r.enabled) { merge(setEnabled(db, worldId, rid, true, by, { chain })); out.turnedOn.push(rid); }
      }
      // Its group and its conflicts (either way round).
      for (const o of enabledMods(db, worldId)) {
        if (o.mod.id === modId || chain.has(o.mod.id)) continue;
        const clash = (m.mod.group && o.mod.group === m.mod.group) || m.mod.conflicts.includes(o.mod.id) || o.mod.conflicts.includes(modId);
        if (clash) { merge(setEnabled(db, worldId, o.mod.id, false, by, { cascade: true })); if (!out.turnedOff.includes(o.mod.id)) out.turnedOff.push(o.mod.id); }
      }
      const cur = worldSettings(db, worldId);
      const presets = presetValues(m.mod, m.options);
      const saved = Object.fromEntries(Object.keys(presets).filter(known).map((k) => [k, cur[k]]));
      out.settingsChanged = patchSettings(db, worldId, presets) || out.settingsChanged;
      upsert(db, worldId, modId, m.source, { enabled: true, saved }, by);
      seedRecords(db, worldId, m);
    } else {
      const dependents = enabledMods(db, worldId).filter((o) => o.mod.requires.mods[modId]);
      if (dependents.length && !opts.cascade) throw new HttpError(409, `${dependents.map((d) => d.mod.name).join(', ')} ${dependents.length > 1 ? 'need' : 'needs'} ${m.mod.name}: turn ${dependents.length > 1 ? 'them' : 'it'} off too`);
      for (const d of dependents) { merge(setEnabled(db, worldId, d.mod.id, false, by, { cascade: true })); if (!out.turnedOff.includes(d.mod.id)) out.turnedOff.push(d.mod.id); }
      out.settingsChanged = patchSettings(db, worldId, getMod(db, worldId, modId).saved) || out.settingsChanged;
      upsert(db, worldId, modId, m.source, { enabled: false, saved: {} }, by);
    }
    invalidateGlossary(db, worldId);
    return out;
  });
}

/** Change the DM's options. A rule that is on re-applies presets that read an option. */
export function setOptions(db: DB, worldId: string, modId: string, patch: Record<string, unknown>, by: string | null): { options: Record<string, unknown>; settingsChanged: boolean } {
  return tx(db, () => {
    const m = getMod(db, worldId, modId);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'options must be an object');
    const next = { ...m.options };
    for (const [k, v] of Object.entries(patch)) {
      const spec = m.mod.options[k];
      if (!spec) throw new HttpError(400, `${m.mod.name} has no option ${k.slice(0, 40)}`);
      if (!okOption(spec, v)) throw new HttpError(400, `${spec.label}: ${spec.type === 'int' ? `a whole number from ${spec.min} to ${spec.max}` : spec.type === 'enum' ? `one of ${spec.values.join(', ')}` : spec.type === 'boolean' ? 'true or false' : `text up to ${spec.max} characters`}`);
      next[k] = v;
    }
    upsert(db, worldId, modId, m.source, { options: next }, by);
    let settingsChanged = false;
    if (m.enabled) {
      const reads = Object.entries(m.mod.presets).filter(([, v]) => typeof v === 'string' && v.startsWith('$') && v.slice(1) in patch).map(([k]) => k);
      if (reads.length) { const all = presetValues(m.mod, next); settingsChanged = patchSettings(db, worldId, Object.fromEntries(reads.map((k) => [k, all[k]]))); }
    }
    // A lower cap clamps what players hold.
    for (const r of m.mod.resources) {
      const max = maxOf(r, next);
      if (max !== null) run(db, 'UPDATE mod_counts SET value = ? WHERE world_id = ? AND mod_id = ? AND resource = ? AND value > ?', max, worldId, modId, r.id, max);
    }
    return { options: next, settingsChanged };
  });
}

/** Add (or update) an imported rule. A shipped rule's id cannot be taken. */
export function importMod(db: DB, worldId: string, raw: unknown, by: string | null): { mod: ModFile; updated: boolean } {
  const { mod, errors } = checkMod(raw);
  if (!mod) throw new HttpError(400, `This house rule has problems: ${errors.join('; ')}`);
  if (shippedMod(mod.id)) throw new HttpError(409, `${mod.id} is the id of a house rule that comes with Alexandria; give yours another id`);
  const cur = one<any>(db, 'SELECT * FROM mods WHERE world_id = ? AND id = ?', worldId, mod.id);
  const n = all<any>(db, "SELECT 1 FROM mods WHERE world_id = ? AND source = 'imported'", worldId).length;
  if (!cur && n >= 50) throw new HttpError(409, 'A world holds at most 50 imported house rules');
  tx(db, () => {
    upsert(db, worldId, mod.id, 'imported', { json: JSON.stringify(toFile(mod)), options: resolveOptions(mod, parseJson(cur?.options, {})) }, by);
    // Counters of resources the new version dropped go; the rest are kept (clamped to the new max).
    const ids = new Set(mod.resources.map((r) => r.id));
    for (const r of all<any>(db, 'SELECT DISTINCT resource FROM mod_counts WHERE world_id = ? AND mod_id = ?', worldId, mod.id)) if (!ids.has(r.resource)) run(db, 'DELETE FROM mod_counts WHERE world_id = ? AND mod_id = ? AND resource = ?', worldId, mod.id, r.resource);
  });
  if (cur?.enabled) invalidateGlossary(db, worldId);
  return { mod, updated: !!cur };
}

export function removeMod(db: DB, worldId: string, modId: string, by: string | null) {
  const m = getMod(db, worldId, modId);
  if (m.source !== 'imported') throw new HttpError(400, 'A house rule that comes with Alexandria can be turned off, not removed');
  tx(db, () => {
    if (m.enabled) setEnabled(db, worldId, modId, false, by, { cascade: true });
    run(db, 'DELETE FROM mods WHERE world_id = ? AND id = ?', worldId, modId);
    run(db, 'DELETE FROM mod_counts WHERE world_id = ? AND mod_id = ?', worldId, modId);
    for (const t of ['mod_records', 'mod_record_log', 'mod_prompts']) run(db, `DELETE FROM ${t} WHERE world_id = ? AND mod_id = ?`, worldId, modId);
  });
}

// ---- counters ------------------------------------------------------------------------------------------------------

export const maxOf = (r: Resource, opts: Record<string, unknown>): number | null => (r.max === null ? null : Number(val(r.max, opts)));
const startOf = (r: Resource, opts: Record<string, unknown>) => Number(val(r.start, opts));

export const playerIds = (db: DB, worldId: string): string[] => all<any>(db, "SELECT account_id FROM members WHERE world_id = ? AND role = 'player' ORDER BY rowid", worldId).map((r) => r.account_id);
const roleOf = (db: DB, worldId: string, accountId: string): Role | null => (one<any>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, accountId)?.role ?? null);

export function count(db: DB, worldId: string, m: Installed, accountId: string, r: Resource): number {
  const row = one<any>(db, 'SELECT value FROM mod_counts WHERE world_id = ? AND mod_id = ? AND account_id = ? AND resource = ?', worldId, m.mod.id, accountId, r.id);
  return row ? row.value : startOf(r, m.options);
}

export interface Counter { id: string; label: string; icon: string; value: number; max: number | null; private: boolean }
export function counters(db: DB, worldId: string, m: Installed, accountId: string): Counter[] {
  return m.mod.resources.map((r) => ({ id: r.id, label: r.label, icon: r.icon, value: count(db, worldId, m, accountId, r), max: maxOf(r, m.options), private: r.private }));
}

function write(db: DB, worldId: string, m: Installed, accountId: string, r: Resource, before: number, after: number, action: string, by: string | null, note: string) {
  run(db, `INSERT INTO mod_counts (world_id, mod_id, account_id, resource, value) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(world_id, mod_id, account_id, resource) DO UPDATE SET value = excluded.value`, worldId, m.mod.id, accountId, r.id, after);
  run(db, 'INSERT INTO mod_log (id, world_id, mod_id, account_id, resource, before, after, action, by, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id('mlg_'), worldId, m.mod.id, accountId, r.id, before, after, action, by, note.slice(0, 300), now());
}

export interface Actor { accountId: string; role: Role }
export interface ActResult { modId: string; action: string; accountId: string; resource: string; before: number; after: number }

/** May `actor` run `a` on `target`'s character? */
export function mayAct(a: Action, actor: Actor, target: string): boolean {
  switch (a.by) {
    case 'dm': return actor.role === 'dm';
    case 'owner': return actor.role === 'player' && actor.accountId === target;
    case 'player': return actor.role === 'player';
    case 'any': return actor.role === 'dm' || (actor.role === 'player' && actor.accountId === target);
  }
}

/** Check an action and work out its change, without writing anything. */
export function planAct(db: DB, worldId: string, m: Installed, actionId: string, actor: Actor, target: string, resourceId?: string | null) {
  if (!m.enabled) throw new HttpError(409, `${m.mod.name} is off in this world`);
  const a = m.mod.actions.find((x) => x.id === actionId);
  if (!a) throw new HttpError(404, `${m.mod.name} has no action ${String(actionId).slice(0, 40)}`);
  if (roleOf(db, worldId, target) !== 'player') throw new HttpError(404, 'That player is not in this world');
  if (!mayAct(a, actor, target)) throw new HttpError(403, a.by === 'dm' ? 'Only the DM can do that' : a.by === 'owner' ? 'Only that character\'s player can do that' : 'You cannot do that');
  const rid = a.resource === '*' ? resourceId : a.resource;
  const r = m.mod.resources.find((x) => x.id === rid);
  if (!r) throw new HttpError(400, a.resource === '*' ? `Say which one: ${m.mod.resources.map((x) => x.id).join(', ')}` : `Unknown resource ${String(rid)}`);
  const before = count(db, worldId, m, target, r);
  const add = Number(val(a.add, m.options));
  const after = before + add;
  const max = maxOf(r, m.options);
  if (after < 0) throw new HttpError(409, `No ${r.label} left`);
  if (max !== null && after > max) throw new HttpError(409, `Already holds the most ${r.label} allowed (${max})`);
  return { a, r, before, after };
}

export function act(db: DB, worldId: string, m: Installed, actionId: string, actor: Actor, target: string, resourceId: string | null | undefined, note: string): ActResult {
  return tx(db, () => {
    const p = planAct(db, worldId, m, actionId, actor, target, resourceId);
    write(db, worldId, m, target, p.r, p.before, p.after, p.a.id, actor.accountId, note);
    return { modId: m.mod.id, action: p.a.id, accountId: target, resource: p.r.id, before: p.before, after: p.after };
  });
}

/** Run every enabled rule's triggers for a rest or a session start/end. Returns who changed. */
export function runTriggers(db: DB, worldId: string, when: string): string[] {
  const changed = new Set<string>();
  tx(db, () => {
    for (const m of enabledMods(db, worldId)) {
      for (const t of m.mod.triggers.filter((x) => x.on === when)) {
        const rs = t.resource === '*' ? m.mod.resources : m.mod.resources.filter((r) => r.id === t.resource);
        for (const aid of playerIds(db, worldId)) {
          for (const r of rs) {
            const max = maxOf(r, m.options);
            const before = count(db, worldId, m, aid, r);
            let after = t.set === 'max' ? (max ?? before) : t.set !== undefined ? Number(val(t.set, m.options)) : before;
            if (t.add !== undefined) after += Number(val(t.add, m.options));
            after = Math.max(0, max === null ? after : Math.min(max, after));
            if (after !== before) { write(db, worldId, m, aid, r, before, after, `trigger:${when}`, null, ''); changed.add(aid); }
          }
        }
      }
    }
  });
  return [...changed];
}

export interface LogLine { id: string; modId: string; accountId: string; resource: string; before: number; after: number; action: string; by: string | null; note: string; at: string }
export function readLog(db: DB, worldId: string, opts: { accountId?: string; modId?: string; limit?: number }): LogLine[] {
  const where = ['world_id = ?'];
  const args: unknown[] = [worldId];
  if (opts.accountId) { where.push('account_id = ?'); args.push(opts.accountId); }
  if (opts.modId) { where.push('mod_id = ?'); args.push(opts.modId); }
  return all<any>(db, `SELECT * FROM mod_log WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`, ...args, Math.min(200, Math.max(1, opts.limit ?? 50)))
    .map((l) => ({ id: l.id, modId: l.mod_id, accountId: l.account_id, resource: l.resource, before: l.before, after: l.after, action: l.action, by: l.by, note: l.note, at: l.at }));
}

// ---- for features that keep their own screens on a rule's counters (the player sheet's re-rolls) ----------------

/** A counter's value, whether or not the rule is on (its start value until it is first changed). */
export function readCounter(db: DB, worldId: string, modId: string, accountId: string, resource: string): number {
  const m = getModRaw(db, worldId, modId);
  const r = m.mod.resources.find((x) => x.id === resource);
  if (!r) throw new HttpError(400, `${m.mod.name} has no ${resource}`);
  return count(db, worldId, m, accountId, r);
}

/** Set a counter to `next`, logged like an action. The caller has checked who may do it and the limits. */
export function writeCounter(db: DB, worldId: string, modId: string, accountId: string, resource: string, next: number, action: string, by: string | null, note: string) {
  const m = getModRaw(db, worldId, modId);
  const r = m.mod.resources.find((x) => x.id === resource);
  if (!r) throw new HttpError(400, `${m.mod.name} has no ${resource}`);
  const before = count(db, worldId, m, accountId, r);
  if (before !== next) write(db, worldId, m, accountId, r, before, next, action, by, note);
}
