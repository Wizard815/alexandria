// The GM's templates and guides, per world, with every earlier version kept. Web research settings live here too
// (GM only: never in the world settings that players can read).
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { cleanSpec, type Kind, type Spec, type TemplateInput } from './spec.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS templates_items (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  triggers TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  spec TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS templates_items_world ON templates_items (world_id, kind, name);
CREATE TABLE IF NOT EXISTS templates_versions (
  template_id TEXT NOT NULL REFERENCES templates_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  saved_by TEXT,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);
CREATE TABLE IF NOT EXISTS templates_web (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
`;

export interface Template extends TemplateInput { id: string; worldId: string; version: number; createdAt: string; updatedAt: string }

const view = (r: any): Template => ({
  id: r.id, worldId: r.world_id, kind: r.kind as Kind, name: r.name, description: r.description, triggers: parseJson<string[]>(r.triggers, []),
  enabled: !!r.enabled, spec: cleanSpec(r.kind as Kind, parseJson<Spec | null>(r.spec, null)), version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const MAX_TEMPLATES = 300;
const MAX_VERSIONS = 50;

export const listTemplates = (db: DB, worldId: string, kind?: Kind): Template[] =>
  all<any>(db, `SELECT * FROM templates_items WHERE world_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY kind, name COLLATE NOCASE`, ...(kind ? [worldId, kind] : [worldId])).map(view);

export function getTemplate(db: DB, worldId: string, idOrName: string): Template | null {
  const r = one<any>(db, 'SELECT * FROM templates_items WHERE world_id = ? AND id = ?', worldId, idOrName) ?? one<any>(db, 'SELECT * FROM templates_items WHERE world_id = ? AND name = ? COLLATE NOCASE ORDER BY updated_at DESC', worldId, idOrName);
  return r ? view(r) : null;
}

const snapshot = (t: TemplateInput) => JSON.stringify({ kind: t.kind, name: t.name, description: t.description, triggers: t.triggers, enabled: t.enabled, spec: t.spec });

export function createTemplate(db: DB, worldId: string, t: TemplateInput, by: string | null): Template {
  if ((one<any>(db, 'SELECT COUNT(*) AS n FROM templates_items WHERE world_id = ?', worldId)?.n ?? 0) >= MAX_TEMPLATES) throw new HttpError(409, 'That is plenty of templates: remove one first');
  if (one(db, 'SELECT 1 FROM templates_items WHERE world_id = ? AND kind = ? AND name = ? COLLATE NOCASE', worldId, t.kind, t.name)) throw new HttpError(409, `A ${t.kind} template called "${t.name}" already exists`);
  const tid = id('tpl_');
  const at = now();
  run(db, 'INSERT INTO templates_items (id, world_id, kind, name, description, triggers, enabled, spec, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
    tid, worldId, t.kind, t.name, t.description, JSON.stringify(t.triggers), t.enabled ? 1 : 0, JSON.stringify(t.spec), by, at, at);
  run(db, 'INSERT INTO templates_versions (template_id, version, snapshot, saved_by, saved_at) VALUES (?, 1, ?, ?, ?)', tid, snapshot(t), by, at);
  return getTemplate(db, worldId, tid)!;
}

/** A new version (the old one stays in the history). Turning a template on or off is not a new version. */
export function updateTemplate(db: DB, worldId: string, tid: string, t: TemplateInput, by: string | null): Template {
  const cur = getTemplate(db, worldId, tid);
  if (!cur || cur.id !== tid) throw new HttpError(404, 'Template not found');
  const clash = one<any>(db, 'SELECT id FROM templates_items WHERE world_id = ? AND kind = ? AND name = ? COLLATE NOCASE AND id <> ?', worldId, t.kind, t.name, tid);
  if (clash) throw new HttpError(409, `A ${t.kind} template called "${t.name}" already exists`);
  const same = snapshot({ ...cur, enabled: true }) === snapshot({ ...t, enabled: true });
  const at = now();
  const version = same ? cur.version : cur.version + 1;
  run(db, 'UPDATE templates_items SET name = ?, description = ?, triggers = ?, enabled = ?, spec = ?, version = ?, updated_at = ? WHERE id = ?',
    t.name, t.description, JSON.stringify(t.triggers), t.enabled ? 1 : 0, JSON.stringify(t.spec), version, at, tid);
  if (!same) {
    run(db, 'INSERT OR REPLACE INTO templates_versions (template_id, version, snapshot, saved_by, saved_at) VALUES (?, ?, ?, ?, ?)', tid, version, snapshot(t), by, at);
    run(db, 'DELETE FROM templates_versions WHERE template_id = ? AND version <= ?', tid, version - MAX_VERSIONS);
  }
  return getTemplate(db, worldId, tid)!;
}

export const deleteTemplate = (db: DB, worldId: string, tid: string): boolean => run(db, 'DELETE FROM templates_items WHERE world_id = ? AND id = ?', worldId, tid) > 0;

export const templateVersions = (db: DB, tid: string) =>
  all<any>(db, 'SELECT version, snapshot, saved_by, saved_at FROM templates_versions WHERE template_id = ? ORDER BY version DESC', tid)
    .map((r) => ({ version: r.version, savedAt: r.saved_at, savedBy: r.saved_by, template: parseJson<any>(r.snapshot, {}) }));

// ---- web research settings ----

export interface WebConfig {
  enabled: boolean;
  provider: 'openrouter' | 'searxng';
  /** SearXNG: the instance address (its JSON API must be on). */
  searxUrl: string;
  /** OpenRouter: a provider saved in Admin → Models (blank: the first OpenRouter one), and the model to search with (blank: the chat job's). */
  providerId: string;
  model: string;
  /** GM-only words the GM allowed in queries (classified words can never be allowed). */
  allowTerms: string[];
  /** Results per query. */
  maxResults: number;
}
export const WEB_DEFAULTS: WebConfig = { enabled: false, provider: 'openrouter', searxUrl: '', providerId: '', model: '', allowTerms: [], maxResults: 5 };

export function webConfig(db: DB, worldId: string): WebConfig {
  const raw = parseJson<Partial<WebConfig>>(one<any>(db, 'SELECT config FROM templates_web WHERE world_id = ?', worldId)?.config, {});
  return cleanWeb({ ...WEB_DEFAULTS, ...raw });
}

export function cleanWeb(v: any): WebConfig {
  const o = { ...WEB_DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
  let searx = typeof o.searxUrl === 'string' ? o.searxUrl.trim().slice(0, 300).replace(/\/+$/, '') : '';
  if (searx) { try { const u = new URL(searx); if (!/^https?:$/.test(u.protocol)) searx = ''; } catch { throw new HttpError(400, 'The SearXNG address is not a web address'); } }
  return {
    enabled: o.enabled === true,
    provider: o.provider === 'searxng' ? 'searxng' : 'openrouter',
    searxUrl: searx,
    providerId: typeof o.providerId === 'string' ? o.providerId.slice(0, 80) : '',
    model: typeof o.model === 'string' ? o.model.trim().slice(0, 120) : '',
    allowTerms: (Array.isArray(o.allowTerms) ? o.allowTerms : typeof o.allowTerms === 'string' ? o.allowTerms.split(/[,\n]/) : [])
      .map((x: unknown) => String(x ?? '').trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 100),
    maxResults: Math.max(1, Math.min(10, Number.isFinite(Number(o.maxResults)) ? Math.round(Number(o.maxResults)) : 5)),
  };
}

export function setWebConfig(db: DB, worldId: string, patch: unknown): WebConfig {
  const next = cleanWeb({ ...webConfig(db, worldId), ...(patch && typeof patch === 'object' ? patch : {}) });
  run(db, 'INSERT INTO templates_web (world_id, config, updated_at) VALUES (?, ?, ?) ON CONFLICT(world_id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at', worldId, JSON.stringify(next), now());
  return next;
}
