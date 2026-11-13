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

export function moduleDoc(db: DB, worldId: string, id: string): { doc: ModuleDoc; builtin: boolean; source?: string } | null {
  const b = builtin(id);
  if (b) return { doc: b, builtin: true };
  const d = importedDoc(db, worldId, id);
  if (!d) return null;
  return { doc: d, builtin: false, source: one<{ source: string }>(db, 'SELECT source FROM modules_imported WHERE world_id = ? AND id = ?', worldId, id)?.source };
}

/** Every module this world could enable: both built-in ones and its imports. */
export function available(db: DB, worldId: string): ModuleInfo[] {
  const out: ModuleInfo[] = BUILTIN_IDS.map((id) => info(builtin(id)!, true));
  for (const m of all<any>(db, 'SELECT m.*, (SELECT count(*) FROM modules_terms t WHERE t.world_id = m.world_id AND t.module_id = m.id) AS n FROM modules_imported m WHERE m.world_id = ? ORDER BY m.created_at', worldId)) {
    out.push({ id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution, builtin: false, terms: m.n, source: m.source });
  }
  return out;
}

/** The enabled modules in order, with their terms merged: earlier modules win on a clash. */
export function worldModules(db: DB, worldId: string): WorldModules {
  const cached = caches.get(db)?.get(worldId);
  if (cached && cached.version === ver(db, worldId)) return cached;
  const enabled: ModuleInfo[] = [];
  const terms: MergedTerm[] = [];
  const seen = new Set<string>();
  for (const id of enabledIds(db, worldId)) {
    const m = moduleDoc(db, worldId, id);
    if (!m) continue;
    const rank = enabled.length;
    enabled.push(info(m.doc, m.builtin, m.source));
    for (const t of m.doc.terms) {
      const key = `${t.kind}|${t.term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ ...t, ref: `${m.doc.id}:${t.id}`, moduleId: m.doc.id, moduleName: m.doc.name, rank });
    }
  }
  const w: WorldModules = { version: ver(db, worldId), enabled, terms, byRef: new Map(terms.map((t) => [t.ref, t])) };
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
