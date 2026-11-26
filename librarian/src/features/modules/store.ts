// Where modules live: the two built-in ones (bundled JSON, read once) and
// the ones a DM imported (tables below). A world enables some of them in an
// order; the merged, de-duplicated term list is cached per world.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import type { Kind, ModuleDoc, Term } from './format.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS modules_imported (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, id)
);
CREATE TABLE IF NOT EXISTS modules_terms (
  world_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  id TEXT NOT NULL,
  term TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  data TEXT,
  PRIMARY KEY (world_id, module_id, id),
  FOREIGN KEY (world_id, module_id) REFERENCES modules_imported(world_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS modules_server (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  request TEXT,
  edition TEXT NOT NULL DEFAULT '',
  counts TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS modules_server_terms (
  module_id TEXT NOT NULL REFERENCES modules_server(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  term TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  data TEXT,
  PRIMARY KEY (module_id, id)
);
CREATE TABLE IF NOT EXISTS modules_left_out (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  term_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, module_id, term_id)
);
CREATE TABLE IF NOT EXISTS modules_world (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  enabled TEXT NOT NULL DEFAULT '[]'
);
`;

export const DEFAULT_MODULE = 'dnd-2024';
export const BUILTIN_IDS = ['dnd-2024', 'dnd-2014'] as const;
const FILES: Record<string, string> = { 'dnd-2024': 'srd-2024.json', 'dnd-2014': 'srd-2014.json' };
const here = path.dirname(fileURLToPath(import.meta.url));
const builtinCache = new Map<string, ModuleDoc>();

export function builtin(id: string): ModuleDoc | null {
  const file = FILES[id];
  if (!file) return null;
  let m = builtinCache.get(id);
  if (!m) {
    m = JSON.parse(fs.readFileSync(path.join(here, 'data', file), 'utf8')) as ModuleDoc;
    builtinCache.set(id, m);
  }
  return m;
}

export interface ModuleInfo {
  id: string;
  name: string;
  version: string;
  license: string;
  attribution: string;
  builtin: boolean;
  terms: number;
  source?: string;
  /** In the server's content library: pulled once by an admin, any world can turn it on. */
  server?: boolean;
  /** "2024" or "2014" when the source says which rules it is for. */
  edition?: string;
  /** Terms per kind (server library modules). */
  counts?: Record<string, number>;
}

const info = (m: ModuleDoc, isBuiltin: boolean, source?: string): ModuleInfo => ({ id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution, builtin: isBuiltin, terms: m.terms.length, ...(source ? { source } : {}) });

/** A term with its module, as the merged index serves it. */
export interface MergedTerm extends Term {
  ref: string; // `${moduleId}:${termId}`
  moduleId: string;
  moduleName: string;
  rank: number; // position of its module in the world's order
}

export interface WorldModules {
  version: number;
  enabled: ModuleInfo[];
  terms: MergedTerm[];
  byRef: Map<string, MergedTerm>;
}

// ---- the server's content library ----------------------------------------
const serverVersions = new WeakMap<DB, number>();
const serverDocs = new WeakMap<DB, Map<string, ModuleDoc>>();
const serverVer = (db: DB) => serverVersions.get(db) ?? 0;

export interface ServerModuleRow { id: string; name: string; version: string; license: string; attribution: string; source: string; request: string | null; edition: string; counts: string; created_at: string; updated_at: string }

export function serverRows(db: DB): ServerModuleRow[] {
  return all<ServerModuleRow>(db, 'SELECT * FROM modules_server ORDER BY CASE edition WHEN \'2024\' THEN 0 WHEN \'2014\' THEN 1 ELSE 2 END, name');
}

export function serverDoc(db: DB, id: string): ModuleDoc | null {
  const c = serverDocs.get(db) ?? new Map<string, ModuleDoc>();
  serverDocs.set(db, c);
  const hit = c.get(id);
  if (hit) return hit;
  const m = one<ServerModuleRow>(db, 'SELECT * FROM modules_server WHERE id = ?', id);
  if (!m) return null;
  const terms = all<any>(db, 'SELECT * FROM modules_server_terms WHERE module_id = ? ORDER BY rowid', id).map((t) => ({
    id: t.id, term: t.term, aliases: parseJson<string[]>(t.aliases, []), kind: t.kind as Kind, summary: t.summary, text: t.text, ...(t.data ? { data: parseJson<unknown>(t.data, null) } : {}),
  }));
  const doc = { id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution, terms };
  c.set(id, doc);
  return doc;
}

const serverInfo = (m: ServerModuleRow, n: number): ModuleInfo => ({ id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution, builtin: false, terms: n, source: m.source, server: true, ...(m.edition ? { edition: m.edition } : {}), counts: parseJson<Record<string, number>>(m.counts, {}) });

export function serverModules(db: DB): ModuleInfo[] {
  return serverRows(db).map((m) => serverInfo(m, Object.values(parseJson<Record<string, number>>(m.counts, {})).reduce((a, b) => a + b, 0)));
}

function serverChanged(db: DB) {
  serverVersions.set(db, serverVer(db) + 1);
  serverDocs.get(db)?.clear();
  caches.get(db)?.clear();
}

/** Save (or replace) a module in the server library. Worlds that have it on see the new copy at once. */
export function saveServer(db: DB, m: ModuleDoc, o: { source: string; request?: unknown; edition?: string; replace: boolean }) {
  if ((BUILTIN_IDS as readonly string[]).includes(m.id)) throw new HttpError(400, `The id ${m.id} is used by a built-in module. Choose another.`);
  const exists = one<{ created_at: string }>(db, 'SELECT created_at FROM modules_server WHERE id = ?', m.id);
  if (exists && !o.replace) throw new HttpError(409, `The library already has ${m.id}. Send replace: true to refresh it.`);
  const counts: Record<string, number> = {};
  for (const t of m.terms) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  tx(db, () => {
    run(db, 'DELETE FROM modules_server_terms WHERE module_id = ?', m.id);
    run(db, 'DELETE FROM modules_server WHERE id = ?', m.id);
    run(db, 'INSERT INTO modules_server (id, name, version, license, attribution, source, request, edition, counts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', m.id, m.name, m.version, m.license, m.attribution, o.source.slice(0, 500), o.request === undefined ? null : JSON.stringify(o.request), o.edition ?? '', JSON.stringify(counts), exists?.created_at ?? now(), now());
    for (const t of m.terms) {
      run(db, 'INSERT INTO modules_server_terms (module_id, id, term, aliases, kind, summary, text, data) VALUES (?,?,?,?,?,?,?,?)', m.id, t.id, t.term, JSON.stringify(t.aliases), t.kind, t.summary, t.text, t.data === undefined ? null : JSON.stringify(t.data));
    }
  });
  serverChanged(db);
}

export function removeServer(db: DB, id: string) {
  if (!one(db, 'SELECT 1 FROM modules_server WHERE id = ?', id)) throw new HttpError(404, 'Not in the content library');
  tx(db, () => { run(db, 'DELETE FROM modules_server_terms WHERE module_id = ?', id); run(db, 'DELETE FROM modules_server WHERE id = ?', id); });
  serverChanged(db);
}

const versions = new WeakMap<DB, Map<string, number>>();
const caches = new WeakMap<DB, Map<string, WorldModules>>();
const ver = (db: DB, w: string) => versions.get(db)?.get(w) ?? 0;
/** Call after anything that changes a world's modules or their order. */
export function invalidate(db: DB, worldId: string) {
  const m = versions.get(db) ?? new Map<string, number>();
  m.set(worldId, ver(db, worldId) + 1);
  versions.set(db, m);
  caches.get(db)?.delete(worldId);
}
export const moduleVersion = ver;

export function enabledIds(db: DB, worldId: string): string[] {
  const row = one<{ enabled: string }>(db, 'SELECT enabled FROM modules_world WHERE world_id = ?', worldId);
  return row ? parseJson<string[]>(row.enabled, []) : [DEFAULT_MODULE];
}

function importedDoc(db: DB, worldId: string, id: string): ModuleDoc | null {
  const m = one<any>(db, 'SELECT * FROM modules_imported WHERE world_id = ? AND id = ?', worldId, id);
  if (!m) return null;
  const terms = all<any>(db, 'SELECT * FROM modules_terms WHERE world_id = ? AND module_id = ? ORDER BY rowid', worldId, id).map((t) => ({
    id: t.id, term: t.term, aliases: parseJson<string[]>(t.aliases, []), kind: t.kind as Kind, summary: t.summary, text: t.text, ...(t.data ? { data: parseJson<unknown>(t.data, null) } : {}),
  }));
  return { id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution, terms };
}

export function moduleDoc(db: DB, worldId: string, id: string): { doc: ModuleDoc; builtin: boolean; source?: string; server?: boolean } | null {
  const b = builtin(id);
  if (b) return { doc: b, builtin: true };
  const sv = serverDoc(db, id);
  if (sv) return { doc: sv, builtin: false, server: true, source: one<{ source: string }>(db, 'SELECT source FROM modules_server WHERE id = ?', id)?.source };
  const d = importedDoc(db, worldId, id);
  if (!d) return null;
  return { doc: d, builtin: false, source: one<{ source: string }>(db, 'SELECT source FROM modules_imported WHERE world_id = ? AND id = ?', worldId, id)?.source };
}

/** Every module this world could enable: both built-in ones, the server's content library and its imports. */
export function available(db: DB, worldId: string): ModuleInfo[] {
  const out: ModuleInfo[] = BUILTIN_IDS.map((id) => info(builtin(id)!, true));
  out.push(...serverModules(db));
  for (const m of all<any>(db, 'SELECT m.*, (SELECT count(*) FROM modules_terms t WHERE t.world_id = m.world_id AND t.module_id = m.id) AS n FROM modules_imported m WHERE m.world_id = ? ORDER BY m.created_at', worldId)) {
    out.push({ id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution, builtin: false, terms: m.n, source: m.source });
  }
  return out;
}

// ---- entries a world leaves out of a module ----------------------------------
/** The term ids this world left out of one module, or of every module (keys `${moduleId}:${termId}`). */
export function leftOut(db: DB, worldId: string, moduleId?: string): Set<string> {
  const rows = moduleId
    ? all<{ term_id: string }>(db, 'SELECT term_id FROM modules_left_out WHERE world_id = ? AND module_id = ?', worldId, moduleId).map((r) => r.term_id)
    : all<{ module_id: string; term_id: string }>(db, 'SELECT module_id, term_id FROM modules_left_out WHERE world_id = ?', worldId).map((r) => `${r.module_id}:${r.term_id}`);
  return new Set(rows);
}

/** Leave entries out of (or put them back into) this world. */
export function setLeftOut(db: DB, worldId: string, moduleId: string, termIds: string[], out: boolean) {
  tx(db, () => {
    for (const t of termIds) {
      if (out) run(db, 'INSERT INTO modules_left_out (world_id, module_id, term_id, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', worldId, moduleId, t, now());
      else run(db, 'DELETE FROM modules_left_out WHERE world_id = ? AND module_id = ? AND term_id = ?', worldId, moduleId, t);
    }
  });
  invalidate(db, worldId);
}

/** The enabled modules in order, with their terms merged: earlier modules win on a clash. Entries the world left out are skipped (a later module's entry of the same name then shows). */
export function worldModules(db: DB, worldId: string): WorldModules {
  const cached = caches.get(db)?.get(worldId);
  if (cached && cached.version === ver(db, worldId) + serverVer(db) * 1e6) return cached;
  const enabled: ModuleInfo[] = [];
  const terms: MergedTerm[] = [];
  const seen = new Set<string>();
  const skip = leftOut(db, worldId);
  for (const id of enabledIds(db, worldId)) {
    const m = moduleDoc(db, worldId, id);
    if (!m) continue;
    const rank = enabled.length;
    enabled.push(m.server ? { ...info(m.doc, false, m.source), server: true } : info(m.doc, m.builtin, m.source));
    for (const t of m.doc.terms) {
      if (skip.has(`${m.doc.id}:${t.id}`)) continue;
      const key = `${t.kind}|${t.term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ ...t, ref: `${m.doc.id}:${t.id}`, moduleId: m.doc.id, moduleName: m.doc.name, rank });
    }
  }
  const w: WorldModules = { version: ver(db, worldId) + serverVer(db) * 1e6, enabled, terms, byRef: new Map(terms.map((t) => [t.ref, t])) };
  const c = caches.get(db) ?? new Map<string, WorldModules>();
  c.set(worldId, w);
  caches.set(db, c);
  return w;
}

export function setEnabled(db: DB, worldId: string, ids: string[]) {
  const known = new Set(available(db, worldId).map((m) => m.id));
  const clean: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !known.has(id)) throw new HttpError(400, `Unknown module: ${String(id).slice(0, 60)}`);
    if (!clean.includes(id)) clean.push(id);
  }
  run(db, 'INSERT INTO modules_world (world_id, enabled) VALUES (?, ?) ON CONFLICT(world_id) DO UPDATE SET enabled = excluded.enabled', worldId, JSON.stringify(clean));
  invalidate(db, worldId);
}

export function saveImported(db: DB, worldId: string, m: ModuleDoc, source: string, replace: boolean, enable: boolean) {
  if ((BUILTIN_IDS as readonly string[]).includes(m.id)) throw new HttpError(400, `The id ${m.id} is used by a built-in module. Choose another.`);
  if (one(db, 'SELECT 1 FROM modules_server WHERE id = ?', m.id)) throw new HttpError(400, `${m.name} is already in the server's content library: turn it on instead of importing it (or give this one another id).`);
  const exists = one(db, 'SELECT 1 FROM modules_imported WHERE world_id = ? AND id = ?', worldId, m.id);
  if (exists && !replace) throw new HttpError(409, `A module with the id ${m.id} is already imported. Send replace: true to overwrite it.`);
  tx(db, () => {
    run(db, 'DELETE FROM modules_imported WHERE world_id = ? AND id = ?', worldId, m.id);
    run(db, 'INSERT INTO modules_imported (world_id, id, name, version, license, attribution, source, created_at) VALUES (?,?,?,?,?,?,?,?)', worldId, m.id, m.name, m.version, m.license, m.attribution, source.slice(0, 500), now());
    for (const t of m.terms) {
      run(db, 'INSERT INTO modules_terms (world_id, module_id, id, term, aliases, kind, summary, text, data) VALUES (?,?,?,?,?,?,?,?,?)', worldId, m.id, t.id, t.term, JSON.stringify(t.aliases), t.kind, t.summary, t.text, t.data === undefined ? null : JSON.stringify(t.data));
    }
    if (enable) {
      const cur = enabledIds(db, worldId);
      if (!cur.includes(m.id)) run(db, 'INSERT INTO modules_world (world_id, enabled) VALUES (?, ?) ON CONFLICT(world_id) DO UPDATE SET enabled = excluded.enabled', worldId, JSON.stringify([...cur, m.id]));
    }
  });
  invalidate(db, worldId);
}

export function removeImported(db: DB, worldId: string, id: string) {
  if (!one(db, 'SELECT 1 FROM modules_imported WHERE world_id = ? AND id = ?', worldId, id)) throw new HttpError(404, 'Module not found');
  tx(db, () => {
    run(db, 'DELETE FROM modules_imported WHERE world_id = ? AND id = ?', worldId, id);
    const cur = enabledIds(db, worldId);
    if (cur.includes(id)) run(db, 'INSERT INTO modules_world (world_id, enabled) VALUES (?, ?) ON CONFLICT(world_id) DO UPDATE SET enabled = excluded.enabled', worldId, JSON.stringify(cur.filter((x) => x !== id)));
  });
  invalidate(db, worldId);
}
