// The WorldLore workspace: one part of a world's source (or of the library)
// that the AI may read, write, move and delete without asking. Everything
// else stays as it is. All writes go through here, and every write
//   1. checks the target is inside the workspace root (the connector checks
//      the source itself; the library checks the path prefix),
//   2. records who wrote it and at what level,
//   3. re-syncs that one page so the library and the broker see it,
//   4. is audited.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { safePagePath } from '../../core/library.ts';
import { mergeSettings, type WorldSettings, DEFAULT_SETTINGS } from '../../core/policy.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import type { Connector, ConnectorContext, WriteLevel } from '../../intake/connector.ts';
import { WriteRefused } from '../../intake/connector.ts';
import { connectorFor, workspaceMcpFactory } from '../../intake/registry.ts';
import { prefixFor, runSync } from '../../intake/sync.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS worldlore_pages (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL,
  written_by TEXT NOT NULL,
  account_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, ref)
);
`;

export const LEVELS: readonly WriteLevel[] = ['party', 'broker', 'dm', 'classified'];
export const DEFAULT_LEVELS = ['dm', 'broker', 'party'] as const;
/** The tools that change the workspace. Enabling WorldLore adds them to agentAutoApprove. */
export const LORE_WRITE_TOOLS = ['lore_write', 'lore_move', 'lore_delete'] as const;
export const LORE_TOOLS = ['lore_list', 'lore_read', ...LORE_WRITE_TOOLS] as const;
export const LIBRARY_ROOT = 'WorldLore';

export interface LoreConfig {
  kind: 'source' | 'library';
  sourceId?: string;
  /** A source's externalId (LegendKeeper resource id) or folder path (Markdown); the library folder for `library`. */
  root: string;
  defaultLevel: 'dm' | 'broker' | 'party';
  /** The DM's own link to the workspace, when the app can't work it out. */
  url?: string;
}

/** Settings validator, and the shape check for PUT /config. */
export function validateConfig(v: unknown): asserts v is LoreConfig | null {
  if (v === null || v === undefined) return;
  const c = v as any;
  if (typeof c !== 'object' || Array.isArray(c)) throw new Error('worldLore must be an object or null');
  if (c.kind !== 'source' && c.kind !== 'library') throw new Error('worldLore.kind must be source or library');
  if (c.kind === 'source' && (typeof c.sourceId !== 'string' || !c.sourceId || c.sourceId.length > 80)) throw new Error('worldLore.sourceId is required');
  if (typeof c.root !== 'string' || !c.root.trim() || c.root.length > 300 || /[\x00-\x1f]/.test(c.root) || c.root.split(/[\\/]/).includes('..')) throw new Error('worldLore.root must be an id or folder path');
  if (!DEFAULT_LEVELS.includes(c.defaultLevel)) throw new Error('worldLore.defaultLevel must be dm, broker or party');
  if (c.url !== undefined && (typeof c.url !== 'string' || !/^https?:\/\/\S{1,500}$/.test(c.url))) throw new Error('worldLore.url must be a link');
}

export const configOf = (s: WorldSettings): LoreConfig | null => ((s as any).worldLore ?? null) as LoreConfig | null;

/** What a requested level becomes. `party` only when the DM chose party as the workspace default; anything unknown is DM-only. */
export function effectiveLevel(cfg: LoreConfig, asked: unknown): WriteLevel {
  if (asked === undefined || asked === null || asked === '') return cfg.defaultLevel;
  if (!LEVELS.includes(asked as WriteLevel)) throw new HttpError(400, `level must be one of ${LEVELS.join(', ')}`);
  if (asked === 'party' && cfg.defaultLevel !== 'party') return 'dm';
  return asked as WriteLevel;
}

const audit = (d: Deps, worldId: string, who: string | null, action: string, detail: string) =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, who, action, detail.slice(0, 500), now());

export function worldSettings(d: Deps, worldId: string): WorldSettings {
  return { ...DEFAULT_SETTINGS, ...parseJson(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) };
}

// ---- configuration ------------------------------------------------------------------

/** Save the workspace (null turns it off) and add or remove the lore tools in agentAutoApprove. */
export function setConfig(d: Deps, worldId: string, next: LoreConfig | null, who: string | null): WorldSettings {
  try { validateConfig(next); } catch (err: any) { throw new HttpError(400, err.message); }
  if (next?.kind === 'source') {
    const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', next.sourceId, worldId);
    if (!src) throw new HttpError(404, 'Source not found in this world');
    const c = connectorFor(src.kind, parseJson(src.config, {}));
    if (!c?.write) throw new HttpError(400, `${c?.label ?? src.kind} cannot be written to; pick a LegendKeeper source or a Markdown folder, or use the library`);
  }
  if (next?.kind === 'library') next = { ...next, root: LIBRARY_ROOT, sourceId: undefined };
  const cur = worldSettings(d, worldId);
  const auto = ((cur as any).agentAutoApprove ?? []) as string[];
  const rest = auto.filter((t) => !(LORE_TOOLS as readonly string[]).includes(t));
  const merged = mergeSettings(cur, { worldLore: next, agentAutoApprove: next ? [...rest, ...LORE_TOOLS] : rest });
  run(d.db, 'UPDATE worlds SET settings = ? WHERE id = ?', JSON.stringify(merged), worldId);
  audit(d, worldId, who, 'worldlore.config', next ? `${next.kind} ${next.sourceId ?? ''} ${next.root} level ${next.defaultLevel}` : 'off');
  d.hub.emit(worldId, 'settings', merged, () => true);
  return merged;
}

// ---- the workspace -------------------------------------------------------------------

interface Workspace {
  cfg: LoreConfig;
  src: any | null;
  connector: Connector | null;
  srcCfg: Record<string, any>;
  /** The ids of pages as the library keeps them: the source's externalId, or the library path. */
  ctx: ConnectorContext | null;
  close: () => void;
}

export function workspace(d: Deps, worldId: string): Workspace {
  const cfg = configOf(worldSettings(d, worldId));
  if (!cfg) throw new HttpError(409, 'WorldLore is not set up for this world. The DM sets it in World settings.');
  if (cfg.kind === 'library') return { cfg, src: null, connector: null, srcCfg: {}, ctx: null, close: () => {} };
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', cfg.sourceId, worldId);
  if (!src) throw new HttpError(409, 'The WorldLore source is gone. Pick another in World settings.');
  if (!src.enabled) throw new HttpError(409, 'The WorldLore source is switched off');
  const srcCfg = parseJson<Record<string, any>>(src.config, {});
  const connector = connectorFor(src.kind, srcCfg);
  if (!connector?.write) throw new HttpError(409, 'The WorldLore source cannot be written to');
  const mcp = workspaceMcpFactory(connector, srcCfg, d.env, d.fetch, d.testMcp);
  const ctx: ConnectorContext = {
    fetch: d.fetch, env: d.env, dataDir: d.dataDir, vaultsDir: d.vaultsDir, signal: AbortSignal.timeout(90_000), log: () => {},
    mcp: mcp.factory, sourceId: src.id, shareVisible: src.default_visibility === 'party', incomplete: new Set(),
  };
  return { cfg, src, connector, srcCfg, ctx, close: mcp.close };
}

const isMarkdown = (w: Workspace) => w.connector?.id === 'markdown-folder';

/** Page rows inside the workspace, as the library has them. */
function inside(d: Deps, worldId: string, w: Workspace): any[] {
  if (w.cfg.kind === 'library') {
    return all<any>(d.db, `SELECT * FROM pages WHERE world_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path`, worldId, `${LIBRARY_ROOT.replace(/[%_\\]/g, '\\$&')}/%`);
  }
  const rows = all<any>(d.db, 'SELECT * FROM pages WHERE world_id = ? AND source_id = ?', worldId, w.src.id);
  if (isMarkdown(w)) {
    const pre = w.cfg.root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    return rows.filter((r) => String(r.external_id ?? '').startsWith(pre)).sort((a, b) => a.path.localeCompare(b.path));
  }
  // Tree sources: descendants of the root through parent links.
  const kids = new Map<string, any[]>();
  for (const r of rows) if (r.parent_external) (kids.get(r.parent_external) ?? kids.set(r.parent_external, []).get(r.parent_external)!).push(r);
  const out: any[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (depth > 64) return;
    for (const k of kids.get(id) ?? []) { if (seen.has(k.id)) continue; seen.add(k.id); out.push(k); if (k.external_id) walk(k.external_id, depth + 1); }
  };
  walk(w.cfg.root, 0);
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

const refOfRow = (w: Workspace, r: any): string => (w.cfg.kind === 'library' ? r.path : r.external_id);

export interface LorePage {
  id: string; ref: string; title: string; path: string; level: string; writtenBy: 'agent' | 'dm'; updatedAt: string; parentId: string | null;
}

export function listPages(d: Deps, worldId: string, opts: { forAI?: boolean } = {}): LorePage[] {
  const w = workspace(d, worldId);
  try {
    const marks = new Map(all<any>(d.db, 'SELECT * FROM worldlore_pages WHERE world_id = ?', worldId).map((m) => [m.ref, m]));
    const rows = inside(d, worldId, w);
    const byExt = new Map(rows.map((r) => [r.external_id, r]));
    return rows.map((r) => {
      const m = marks.get(refOfRow(w, r));
      return {
        id: r.id, ref: refOfRow(w, r), title: r.title, path: r.path, level: r.visibility, writtenBy: (m?.written_by === 'agent' ? 'agent' : 'dm') as 'agent' | 'dm',
        updatedAt: r.updated_at, parentId: r.parent_external ? byExt.get(r.parent_external)?.id ?? null : null,
      };
    }).filter((p) => !(opts.forAI && p.level === 'classified'));
  } finally { w.close(); }
}

/** The page the caller names (library id, source ref or library path), as a ref for the connector. The connector or the path check decides whether it is inside. */
function refFor(d: Deps, worldId: string, w: Workspace, arg: unknown): string {
  const a = String(arg ?? '').trim();
  if (!a) throw new HttpError(400, 'Say which page (id)');
  const row = one<any>(d.db, 'SELECT * FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', worldId, a, a);
  if (row) {
    if (w.cfg.kind === 'library') return row.path;
    if (row.source_id !== w.src.id || !row.external_id) throw new HttpError(403, 'That page is outside the WorldLore workspace');
    return row.external_id;
  }
  return a;
}

function libPath(rel: string): string {
  const p = safePagePath(rel.startsWith(LIBRARY_ROOT + '/') ? rel : `${LIBRARY_ROOT}/${rel}`);
  if (!p.startsWith(LIBRARY_ROOT + '/')) throw new HttpError(403, 'That path is outside the WorldLore workspace');
  return p;
}

/** A library path the page was given (id or path) that must be in the workspace. */
function libRow(d: Deps, worldId: string, arg: string): any {
  const row = one<any>(d.db, 'SELECT * FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', worldId, arg, arg);
  if (!row) throw new HttpError(404, 'No such page');
  if (!String(row.path).startsWith(LIBRARY_ROOT + '/')) throw new HttpError(403, 'That page is outside the WorldLore workspace');
  return row;
}

const toHttp = (err: any): never => {
  if (err instanceof WriteRefused) throw new HttpError(err.status, err.message);
  throw err;
};

/** Record who wrote a page and at what level. */
function mark(d: Deps, worldId: string, ref: string, title: string, level: WriteLevel, by: 'agent' | 'dm', who: string | null) {
  run(d.db, `INSERT INTO worldlore_pages (world_id, ref, title, level, written_by, account_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (world_id, ref) DO UPDATE SET title = excluded.title, level = excluded.level, written_by = excluded.written_by, account_id = excluded.account_id, updated_at = excluded.updated_at`,
  worldId, ref, title, level, by, who, now());
}

/** Set a page's level in the library (the source can't hold broker or classified) and rebuild player copies. */
function applyLevel(d: Deps, worldId: string, pageId: string, level: WriteLevel) {
  run(d.db, 'UPDATE pages SET visibility = ?, player_frontmatter = NULL, player_body = NULL, player_blocks = NULL, player_properties = NULL, broker_frontmatter = NULL, broker_body = NULL, broker_blocks = NULL, broker_properties = NULL, ai_frontmatter = NULL, ai_body = NULL, ai_blocks = NULL, ai_properties = NULL WHERE id = ? AND world_id = ?', level, pageId, worldId);
  d.library.touchClassified();
}

/** Re-sync one page into the library; the whole source when the connector can't read one page. */
async function resyncOne(d: Deps, worldId: string, w: Workspace, ref: string, level: WriteLevel, by: string | null): Promise<string | null> {
  const entry = await w.connector!.write!.readPage?.(w.srcCfg, w.ctx!, { root: w.cfg.root, id: ref }).catch((err) => { if (err instanceof WriteRefused) throw err; return null; });
  if (!entry) {
    await runSync({ db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp }, w.src.id, by);
    const pg = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, w.src.id, ref);
    if (pg) { applyLevel(d, worldId, pg.id, level); d.library.rebuildPlayerCopies(worldId); }
    return pg?.id ?? null;
  }
  const saved = d.library.saveEntry(worldId, w.src.id, prefixFor(w.connector!.id, w.src.name), entry, by);
  applyLevel(d, worldId, saved.id, level);
  d.library.rebuildPlayerCopies(worldId);
  return saved.id;
}

const slugPart = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';

export interface WriteInput { id?: string; path?: string; title?: string; markdown?: string; level?: unknown; parent?: string; by?: string }

export async function writePage(d: Deps, worldId: string, who: string | null, a: WriteInput): Promise<{ id: string | null; ref: string; level: WriteLevel; created: boolean; note?: string }> {
  const w = workspace(d, worldId);
  const by = a.by === 'agent' ? 'agent' : 'dm';
  try {
    const markdown = a.markdown === undefined ? undefined : String(a.markdown);
    if (markdown !== undefined && markdown.length > 500_000) throw new HttpError(413, 'Page too large');
    const title = a.title === undefined ? undefined : String(a.title).trim().slice(0, 200);
    if (!a.id && markdown === undefined) throw new HttpError(400, 'markdown is required');
    const updating = !!a.id;
    const level = updating && a.level === undefined ? undefined : effectiveLevel(w.cfg, a.level);
    const note = a.level === 'party' && level !== 'party' ? 'party is only allowed when the workspace default is party; saved DM-only' : undefined;
    let ref: string;
    let created = false;

    if (w.cfg.kind === 'library') {
      if (updating) {
        const row = libRow(d, worldId, String(a.id));
        d.library.save(worldId, { path: row.path, title: title ?? row.title, body: markdown ?? row.body, frontmatter: parseJson(row.frontmatter, {}), visibility: level ?? row.visibility }, who);
        ref = row.path;
      } else {
        const p = libPath(String(a.path || slugPart(title ?? '')));
        if (one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', worldId, p)) throw new HttpError(409, 'A page with that path already exists. Pass its id to change it.');
        d.library.save(worldId, { path: p, title: title || p.split('/').pop()!.replace(/\.md$/i, ''), body: markdown!, frontmatter: {}, visibility: level }, who);
        ref = p;
        created = true;
      }
      const pg = one<any>(d.db, 'SELECT id, title FROM pages WHERE world_id = ? AND path = ?', worldId, ref)!;
      if (level) { applyLevel(d, worldId, pg.id, level); d.library.rebuildPlayerCopies(worldId); }
      const lv = (level ?? pg.visibility ?? 'dm') as WriteLevel;
      mark(d, worldId, ref, pg.title, level ?? lv, by, who);
      finish(d, worldId, who, by, updating ? 'update' : 'create', `${pg.title} [${lv}] ${ref}`);
      return { id: pg.id, ref, level: lv, created, note };
    }

    const wr = w.connector!.write!;
    if (updating) {
      ref = (await wr.updatePage(w.srcCfg, w.ctx!, { root: w.cfg.root, id: refFor(d, worldId, w, a.id), title, markdown, level }).catch(toHttp)).externalId;
    } else if (isMarkdown(w)) {
      const rel = String(a.path || slugPart(title ?? ''));
      ref = (await wr.createPage(w.srcCfg, w.ctx!, { root: w.cfg.root, path: rel, title: title || rel.split('/').pop()!.replace(/\.md$/i, ''), markdown: markdown!, level: level! }).catch(toHttp)).externalId;
      created = true;
    } else {
      // Tree sources: the last part of a path is the title, the rest are folders (made when missing).
      const parts = String(a.path ?? '').split('/').map((x) => x.trim()).filter(Boolean);
      const name = title || parts.pop() || '';
      if (title) parts.pop();
      if (!name) throw new HttpError(400, 'Give a title or a path');
      let parent = a.parent ? refFor(d, worldId, w, a.parent) : w.cfg.root;
      const kids = () => inside(d, worldId, w).filter((r) => r.parent_external === parent);
      for (const folder of parts) {
        const have = kids().find((r) => r.title.toLowerCase() === folder.toLowerCase());
        parent = have ? have.external_id : (await wr.createPage(w.srcCfg, w.ctx!, { root: w.cfg.root, parent, title: folder, markdown: '', level: level! }).catch(toHttp)).externalId;
        if (!have) await resyncOne(d, worldId, w, parent, level!, who);
      }
      if (kids().some((r) => r.title.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'A page with that name already exists there. Pass its id to change it.');
      ref = (await wr.createPage(w.srcCfg, w.ctx!, { root: w.cfg.root, parent, title: name, markdown: markdown!, level: level! }).catch(toHttp)).externalId;
      created = true;
    }
    const existing = one<any>(d.db, 'SELECT level FROM worldlore_pages WHERE world_id = ? AND ref = ?', worldId, ref);
    const lv = (level ?? existing?.level ?? w.cfg.defaultLevel) as WriteLevel;
    const pid = await resyncOne(d, worldId, w, ref, lv, who);
    const pg = pid ? one<any>(d.db, 'SELECT title FROM pages WHERE id = ?', pid) : null;
    mark(d, worldId, ref, pg?.title ?? title ?? '', lv, by, who);
    finish(d, worldId, who, by, updating ? 'update' : 'create', `${pg?.title ?? title} [${lv}] ${ref}`);
    return { id: pid, ref, level: lv, created, note };
  } finally { w.close(); }
}

export async function movePage(d: Deps, worldId: string, who: string | null, a: { id: string; to?: string | null; by?: string }) {
  const w = workspace(d, worldId);
  const by = a.by === 'agent' ? 'agent' : 'dm';
  try {
    if (w.cfg.kind === 'library') {
      const row = libRow(d, worldId, String(a.id));
      if (!a.to) throw new HttpError(400, 'Say the new path');
      const p = libPath(String(a.to));
      if (one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', worldId, p)) throw new HttpError(409, 'A page with that path already exists');
      const lv = row.visibility as WriteLevel;
      d.library.save(worldId, { path: p, title: row.title, body: row.body, frontmatter: parseJson(row.frontmatter, {}), visibility: lv }, who);
      const moved = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND path = ?', worldId, p)!;
      applyLevel(d, worldId, moved.id, lv);
      d.library.remove(worldId, row.id);
      run(d.db, 'DELETE FROM worldlore_pages WHERE world_id = ? AND ref = ?', worldId, row.path);
      mark(d, worldId, p, row.title, lv, by, who);
      finish(d, worldId, who, by, 'move', `${row.path} -> ${p}`);
      return { id: moved.id, ref: p };
    }
    const ref = refFor(d, worldId, w, a.id);
    const to = a.to ? (isMarkdown(w) ? String(a.to) : refFor(d, worldId, w, a.to)) : null;
    const out = (await w.connector!.write!.movePage(w.srcCfg, w.ctx!, { root: w.cfg.root, id: ref, to }).catch(toHttp)).externalId;
    const old = one<any>(d.db, 'SELECT * FROM worldlore_pages WHERE world_id = ? AND ref = ?', worldId, ref);
    const oldRow = one<any>(d.db, 'SELECT visibility FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, w.src.id, ref);
    const lv = (old?.level ?? oldRow?.visibility ?? w.cfg.defaultLevel) as WriteLevel;
    if (out !== ref) {
      const pg = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, w.src.id, ref);
      if (pg) d.library.remove(worldId, pg.id);
      run(d.db, 'DELETE FROM worldlore_pages WHERE world_id = ? AND ref = ?', worldId, ref);
    }
    const pid = await resyncOne(d, worldId, w, out, lv, who);
    mark(d, worldId, out, old?.title ?? '', lv, old?.written_by ?? by, who);
    finish(d, worldId, who, by, 'move', `${ref} -> ${out}`);
    return { id: pid, ref: out };
  } finally { w.close(); }
}

export async function deletePage(d: Deps, worldId: string, who: string | null, a: { id: string; by?: string }) {
  const w = workspace(d, worldId);
  const by = a.by === 'agent' ? 'agent' : 'dm';
  try {
    if (w.cfg.kind === 'library') {
      const row = libRow(d, worldId, String(a.id));
      d.library.remove(worldId, row.id);
      run(d.db, 'DELETE FROM worldlore_pages WHERE world_id = ? AND ref = ?', worldId, row.path);
      finish(d, worldId, who, by, 'delete', `${row.title} ${row.path}`);
      return { ok: true };
    }
    const ref = refFor(d, worldId, w, a.id);
    await w.connector!.write!.deletePage(w.srcCfg, w.ctx!, { root: w.cfg.root, id: ref }).catch(toHttp);
    const pg = one<any>(d.db, 'SELECT id, title FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, w.src.id, ref);
    if (pg) d.library.remove(worldId, pg.id);
    run(d.db, 'DELETE FROM worldlore_pages WHERE world_id = ? AND ref = ?', worldId, ref);
    finish(d, worldId, who, by, 'delete', `${pg?.title ?? ''} ${ref}`);
    return { ok: true };
  } finally { w.close(); }
}

/** One page for the agent: its text, unless it is classified. */
export function readPage(d: Deps, worldId: string, viewer: { accountId: string; role: 'dm' }, arg: string) {
  const w = workspace(d, worldId);
  try {
    const row = one<any>(d.db, 'SELECT * FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', worldId, arg, arg);
    const ok = row && inside(d, worldId, w).some((r) => r.id === row.id);
    if (!ok) throw new HttpError(row ? 403 : 404, row ? 'That page is outside the WorldLore workspace' : 'No such page');
    if (row.visibility === 'classified') throw new HttpError(403, 'Classified pages are never shown to an AI');
    const pg = d.library.get(worldId, row.id, { ...viewer, audience: 'ai' } as any);
    return { id: pg.id, ref: refOfRow(w, row), title: pg.title, path: pg.path, level: row.visibility, markdown: (pg as any).body, tags: pg.tags, updatedAt: pg.updated_at };
  } finally { w.close(); }
}

function finish(d: Deps, worldId: string, who: string | null, by: string, action: string, detail: string) {
  audit(d, worldId, who, `worldlore.${action}`, `${by === 'agent' ? 'agent' : 'DM'}: ${detail}`);
  d.hub.emit(worldId, 'page', { worldlore: action }, dmOnly);
}

// ---- pickers and links ----------------------------------------------------------------

/** What the DM can pick as the workspace: each writable source with its top-level resources or folders, and the library. */
export async function options(d: Deps, worldId: string) {
  const out: any[] = [];
  for (const src of all<any>(d.db, 'SELECT * FROM sources WHERE world_id = ? ORDER BY name', worldId)) {
    const cfg = parseJson<Record<string, any>>(src.config, {});
    const c = connectorFor(src.kind, cfg);
    if (!c?.write) continue;
    const mcp = workspaceMcpFactory(c, cfg, d.env, d.fetch, d.testMcp);
    const ctx: ConnectorContext = { fetch: d.fetch, env: d.env, dataDir: d.dataDir, vaultsDir: d.vaultsDir, signal: AbortSignal.timeout(30_000), log: () => {}, mcp: mcp.factory, sourceId: src.id, shareVisible: false, incomplete: new Set() };
    try {
      out.push({ id: src.id, name: src.name, kind: c.id, label: c.label, roots: (await c.write.roots?.(cfg, ctx)) ?? [] });
    } catch (err: any) {
      out.push({ id: src.id, name: src.name, kind: c.id, label: c.label, roots: [], error: String(err.message).slice(0, 160) });
    } finally { mcp.close(); }
  }
  return { sources: out, library: { root: LIBRARY_ROOT } };
}

/** Where the DM can open the workspace: a source link when known, and the library. */
export function links(d: Deps, worldId: string) {
  const cfg = configOf(worldSettings(d, worldId));
  if (!cfg) return null;
  if (cfg.kind === 'library') return { source: null, sourceName: 'Library', url: null, guess: false, libraryFolder: LIBRARY_ROOT };
  const src = one<any>(d.db, 'SELECT name, kind, config FROM sources WHERE id = ? AND world_id = ?', cfg.sourceId, worldId);
  if (!src) return { source: cfg.sourceId, sourceName: null, url: null, guess: false, libraryFolder: null };
  const sc = parseJson<Record<string, any>>(src.config, {});
  let url: string | null = cfg.url ?? null;
  let guess = false;
  if (!url && (src.kind.startsWith('legendkeeper') || src.kind === 'mcp')) {
    const project = /\/projects\/([^/?#]+)/.exec(String(sc.apiUrl ?? ''))?.[1];
    if (project) { url = `https://www.legendkeeper.com/app/project/${project}/resource/${cfg.root}`; guess = true; }
  }
  return { source: cfg.sourceId, sourceName: src.name, url, guess, libraryFolder: null };
}
