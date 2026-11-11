// The world mirror: library pages stored in SQLite, two search indexes
// (DM and party), relations read from frontmatter, and an on-disk Markdown
// vault per world that Obsidian-style editors can open.
import fs from 'node:fs';
import path from 'node:path';
import { type DB, one, all, run, tx } from './db.ts';
import { type FM, type FMValue, joinFrontmatter, splitFrontmatter } from './frontmatter.ts';
import { normVisibility, playerCopy, redactMarkdown, scrubHiddenLinks, scrubHiddenValues, secretHints, type Viewer } from './policy.ts';
import { type Block, type Entry, type Mention, type PropertyGroup, blocksToMarkdown, markdownToBlocks, mentionsIn } from '../intake/model.ts';
import { playerBlocks, playerProperties } from '../intake/player.ts';
import { createHash } from 'node:crypto';
import { HttpError, id, now } from './util.ts';

export interface PageInput {
  path: string;
  title?: string;
  body: string;
  frontmatter?: FM;
  visibility?: string;
  sourceId?: string | null;
}

export function safePagePath(p: string): string {
  const parts = String(p).replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..' || /[\x00-\x1f]/.test(x) || x.startsWith('.'))) {
    throw new HttpError(400, 'Bad page path');
  }
  let out = parts.join('/');
  if (!out.toLowerCase().endsWith('.md')) out += '.md';
  if (out.length > 300) throw new HttpError(400, 'Page path too long');
  return out;
}

const REL_KEYS: Record<string, string> = {
  parent: 'parent of', parents: 'child of', mother: 'child of', father: 'child of',
  children: 'parent of', child: 'parent of',
  spouse: 'spouse of', spouses: 'spouse of', partner: 'partner of', partners: 'partner of',
  siblings: 'sibling of', sibling: 'sibling of',
  allies: 'ally of', enemies: 'enemy of', rivals: 'rival of',
  member_of: 'member of', house: 'member of', family: 'member of', faction: 'member of',
  lovers: 'lover of', lover: 'lover of',
};

function names(v: FMValue): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(names);
  if (typeof v === 'object') return [];
  const s = String(v).trim();
  const links = [...s.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
  return links.length ? links : s ? [s] : [];
}

/** Relations declared in frontmatter. Anything under secret: is DM-only. */
export function relationsFromFrontmatter(title: string, fm: FM): { to: string; kind: string; secret: boolean }[] {
  const out: { to: string; kind: string; secret: boolean }[] = [];
  const scan = (obj: FM, secret: boolean) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if ((key === 'secret' || key === 'secrets' || key === 'dm') && v && typeof v === 'object' && !Array.isArray(v)) {
        scan(v as FM, true);
        continue;
      }
      if (key === 'relations' && Array.isArray(v)) {
        for (const r of v) {
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            const o = r as { [k: string]: FMValue };
            const to = names(o.to ?? o.target ?? null)[0];
            if (to) out.push({ to, kind: String(o.kind ?? o.type ?? 'related to'), secret: secret || o.secret === true || o.visibility === 'dm' });
          } else {
            const m = /^\s*([^:]+):\s*(.+)$/.exec(String(r));
            if (m) for (const to of names(m[2])) out.push({ to, kind: m[1].trim(), secret });
          }
        }
        continue;
      }
      if (REL_KEYS[key]) for (const to of names(v)) if (to !== title) out.push({ to, kind: REL_KEYS[key], secret });
    }
  };
  scan(fm, false);
  return out;
}

export class Library {
  db: DB;
  dataDir: string | null;
  constructor(db: DB, dataDir: string | null) {
    this.db = db;
    this.dataDir = dataDir;
  }

  /**
   * Save a Markdown page (written by the DM, a request, or the MCP). In batch
   * mode (imports) the player copy is left empty until rebuildPlayerCopies
   * runs, so players never see a half-scrubbed page during a sync.
   */
  save(worldId: string, input: PageInput, by: string | null, opts: { batch?: boolean } = {}) {
    const p = safePagePath(input.path);
    const fm: FM = { ...(input.frontmatter ?? {}) };
    const visibility = normVisibility(input.visibility ?? fm.visibility ?? null);
    const title = String(input.title || fm.title || path.basename(p, '.md')).slice(0, 200);
    const body = input.body ?? '';
    if (body.length > 2_000_000) throw new HttpError(413, 'Page too large');
    const existing = one<any>(this.db, 'SELECT id, title, visibility FROM pages WHERE world_id = ? AND path = ?', worldId, p);
    const pid = existing?.id ?? id('pg_');
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? fm.tags.split(/\s*,\s*/) : [];
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
    const k = String(fm.knowledge ?? '').toLowerCase();
    tx(this.db, () => {
      if (existing) {
        run(this.db, `UPDATE pages SET title = ?, visibility = ?, frontmatter = ?, body = ?, blocks = ?, origin = 'markdown', tags = ?, aliases = ?, knowledge = ?,
          player_frontmatter = NULL, player_body = NULL, player_blocks = NULL, player_properties = NULL, source_id = COALESCE(?, source_id), updated_at = ?, updated_by = ? WHERE id = ?`,
          title, visibility, JSON.stringify(fm), body, JSON.stringify(markdownToBlocks(body)), JSON.stringify(tags), JSON.stringify(aliases), ['common', 'local', 'deep'].includes(k) ? k : null, input.sourceId ?? null, now(), by, pid);
      } else {
        run(this.db, `INSERT INTO pages (id, world_id, path, title, visibility, frontmatter, body, blocks, origin, tags, aliases, knowledge, source_id, folder, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?)`,
          pid, worldId, p, title, visibility, JSON.stringify(fm), body, JSON.stringify(markdownToBlocks(body)), JSON.stringify(tags), JSON.stringify(aliases), ['common', 'local', 'deep'].includes(k) ? k : null, input.sourceId ?? null, JSON.stringify(p.split('/').slice(0, -1)), now(), by);
      }
      this.reindexDm(worldId, pid, title, body);
      this.saveRelations(worldId, pid, title, fm, visibility);
    });
    if (!opts.batch) {
      // Hiding or renaming a page changes what other pages may say about it.
      const linksChanged = !existing || existing.title !== title || existing.visibility !== visibility;
      this.rebuildPlayerCopies(worldId, linksChanged ? undefined : [pid]);
    }
    return { id: pid, path: p, title, visibility };
  }

  /** Save an entry from a source connector. Always batch: the sync rebuilds player copies at the end. */
  saveEntry(worldId: string, sourceId: string, prefix: string | null, e: Entry, by: string | null) {
    const existing = one<any>(this.db, 'SELECT id, path FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, sourceId, e.externalId);
    const title = String(e.title || 'Untitled').slice(0, 200);
    const isMd = typeof e.markdown === 'string';
    let p = existing?.path as string | undefined;
    if (!p) {
      const short = createHash('sha1').update(e.externalId).digest('hex').slice(0, 6);
      const rel = isMd && /\.md$/i.test(e.externalId) ? e.externalId : [...(e.folder ?? []).map(slugPart), `${slugPart(title)}-${short}.md`].join('/');
      p = safePagePath(prefix ? `${prefix}/${rel}` : rel);
      if (one(this.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', worldId, p)) p = p.replace(/\.md$/i, `-${short}.md`);
    }
    const blocks: Block[] = isMd ? markdownToBlocks(e.markdown!) : e.blocks;
    const body = isMd ? e.markdown! : blocksToMarkdown(blocks);
    if (body.length > 2_000_000) throw new HttpError(413, `Page too large: ${title}`);
    const fm = e.frontmatter ?? {};
    const vis = e.visibility === 'party' ? 'party' : 'dm';
    const vals = [title, vis, JSON.stringify(fm), body, JSON.stringify(blocks), isMd ? 'markdown' : 'blocks', e.parentExternalId ?? null, JSON.stringify(e.folder ?? []),
      JSON.stringify(e.aliases ?? []), JSON.stringify(e.tags ?? []), e.type ?? 'page', e.icon ? JSON.stringify(e.icon) : null, e.banner ?? null, e.url ?? null,
      e.knowledge ?? null, JSON.stringify(e.properties ?? []), e.updatedAt || now(), by];
    let pid: string;
    tx(this.db, () => {
      if (existing) {
        pid = existing.id;
        run(this.db, `UPDATE pages SET title = ?, visibility = ?, frontmatter = ?, body = ?, blocks = ?, origin = ?, parent_external = ?, folder = ?, aliases = ?, tags = ?, kind = ?, icon = ?, banner = ?, url = ?,
          knowledge = ?, properties = ?, updated_at = ?, updated_by = ?, player_frontmatter = NULL, player_body = NULL, player_blocks = NULL, player_properties = NULL WHERE id = ?`, ...vals, pid);
      } else {
        pid = id('pg_');
        run(this.db, `INSERT INTO pages (title, visibility, frontmatter, body, blocks, origin, parent_external, folder, aliases, tags, kind, icon, banner, url, knowledge, properties, updated_at, updated_by, id, world_id, path, source_id, external_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, pid, worldId, p, sourceId, e.externalId);
      }
      this.reindexDm(worldId, pid, title, body);
      this.saveRelations(worldId, pid, title, fm as FM, vis);
    });
    return { id: pid!, path: p };
  }

  /** After a full listing: remove this source's pages that the source no longer has. */
  removeMissing(worldId: string, sourceId: string, seen: Set<string>) {
    const gone = all<any>(this.db, 'SELECT id, path, external_id FROM pages WHERE world_id = ? AND source_id = ? AND external_id IS NOT NULL', worldId, sourceId).filter((r) => !seen.has(r.external_id));
    tx(this.db, () => {
      for (const g of gone) {
        run(this.db, 'DELETE FROM fts_dm WHERE page_id = ?', g.id);
        run(this.db, 'DELETE FROM fts_party WHERE page_id = ?', g.id);
        run(this.db, 'DELETE FROM pages WHERE id = ?', g.id);
      }
    });
    const dir = this.worldDir(worldId);
    if (dir) for (const g of gone) for (const sub of ['vault', 'party']) fs.rmSync(path.join(dir, sub, g.path), { force: true });
    return gone.length;
  }

  private reindexDm(worldId: string, pid: string, title: string, body: string) {
    run(this.db, 'DELETE FROM fts_dm WHERE page_id = ?', pid);
    run(this.db, 'DELETE FROM fts_party WHERE page_id = ?', pid);
    run(this.db, 'INSERT INTO fts_dm (page_id, world_id, title, body) VALUES (?, ?, ?, ?)', pid, worldId, title, body);
  }

  private saveRelations(worldId: string, pid: string, title: string, fm: FM, visibility: string) {
    run(this.db, 'DELETE FROM relations WHERE page_id = ?', pid);
    for (const r of relationsFromFrontmatter(title, fm)) {
      run(this.db, 'INSERT INTO relations (id, world_id, from_title, to_title, kind, visibility, page_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id('rel_'), worldId, title, r.to, r.kind, !r.secret && visibility === 'party' ? 'party' : 'dm', pid);
    }
  }

  /** Shared pages whose player copy still reads like it has DM notes in it. */
  lint(worldId: string) {
    return all<any>(this.db, `SELECT id, path, title, player_body FROM pages WHERE world_id = ? AND player_body IS NOT NULL`, worldId)
      .map((p) => ({ id: p.id, path: p.path, title: p.title, hints: secretHints(p.player_body) }))
      .filter((p) => p.hints.length);
  }

  /** Titles (lower case) of pages players must not learn about. */
  hiddenTitles(worldId: string): Set<string> {
    return new Set(all<{ t: string }>(this.db, `SELECT lower(title) AS t FROM pages WHERE world_id = ? AND visibility <> 'party'`, worldId).map((r) => r.t));
  }

  /** Resolve mentions in a world: by source ref first, then by title or alias. */
  private resolver(worldId: string) {
    const rows = all<any>(this.db, 'SELECT id, title, aliases, visibility, source_id, external_id FROM pages WHERE world_id = ?', worldId);
    const byRef = new Map<string, any>();
    const byName = new Map<string, any>();
    for (const r of rows) {
      if (r.external_id) byRef.set(`${r.source_id}|${r.external_id}`, r);
      for (const n of [r.title, ...JSON.parse(r.aliases || '[]')]) {
        const k = String(n).toLowerCase();
        const prev = byName.get(k);
        // When names repeat, prefer the shared page so a DM-only twin can't hide it, and vice versa can't leak.
        if (!prev || (prev.visibility !== 'party' && r.visibility === 'party')) byName.set(k, r);
      }
    }
    const find = (m: Mention, sourceId: string | null) => (m.ref ? byRef.get(`${sourceId}|${m.ref}`) : m.name ? byName.get(m.name.toLowerCase()) : undefined);
    return { find, rows };
  }

  /**
   * Recompute player copies: redact DM parts, drop unknown blocks, and replace
   * links to DM-only pages. Runs after each sync and after DM saves that hide,
   * share or rename a page; `only` limits it to pages whose links didn't change.
   */
  rebuildPlayerCopies(worldId: string, only?: string[]) {
    const hidden = this.hiddenTitles(worldId);
    const R = this.resolver(worldId);
    const sel = only?.length ? `AND id IN (${only.map(() => '?').join(',')})` : '';
    const pages = all<any>(this.db, `SELECT id, path, title, visibility, frontmatter, body, blocks, origin, properties, source_id FROM pages WHERE world_id = ? ${sel}`, worldId, ...(only ?? []));
    tx(this.db, () => {
      if (!only?.length) run(this.db, 'DELETE FROM fts_party WHERE world_id = ?', worldId);
      for (const pg of pages) {
        if (only?.length) run(this.db, 'DELETE FROM fts_party WHERE page_id = ?', pg.id);
        const fm = JSON.parse(pg.frontmatter || '{}');
        const isHidden = (m: Mention) => {
          const t = R.find(m, pg.source_id);
          // A ref that resolves to nothing may be a page we were not allowed to import: hide it.
          if (!t) return !!m.ref;
          return t.visibility !== 'party';
        };
        const titleOf = (m: Mention) => {
          const t = R.find(m, pg.source_id);
          return t ? t.title : m.name ?? null;
        };
        let pBlocks: Block[] | null = null;
        let pBody: string | null = null;
        let pFm: FM | null = null;
        let pProps: PropertyGroup[] | null = null;
        if (pg.visibility === 'party') {
          if (pg.origin === 'markdown') {
            const pc = playerCopy('party', fm, pg.body)!;
            pFm = scrubHiddenValues(pc.fm, hidden);
            pBlocks = playerBlocks(markdownToBlocks(pc.body), isHidden);
          } else {
            pFm = {};
            pBlocks = playerBlocks(JSON.parse(pg.blocks || '[]'), isHidden);
          }
          pProps = playerProperties(JSON.parse(pg.properties || '[]'), isHidden);
          // The Markdown copy is made from the player blocks, then redacted again as a second guard.
          pBody = scrubHiddenLinks(redactMarkdown(blocksToMarkdown(pBlocks, (m) => (isHidden(m) ? null : titleOf(m)))), hidden);
        }
        run(this.db, 'UPDATE pages SET player_frontmatter = ?, player_body = ?, player_blocks = ?, player_properties = ? WHERE id = ?',
          pFm ? JSON.stringify(pFm) : null, pBody, pBlocks ? JSON.stringify(pBlocks) : null, pProps ? JSON.stringify(pProps) : null, pg.id);
        if (pBody !== null) run(this.db, 'INSERT INTO fts_party (page_id, world_id, title, body) VALUES (?, ?, ?, ?)', pg.id, worldId, pg.title, pBody);
        this.mirror(worldId, pg.path, fm, pg.body, pg.visibility, pBody !== null ? { fm: pFm ?? {}, body: pBody, blocks: pBlocks, properties: pProps } : null);
      }
    });
  }

  remove(worldId: string, pageId: string) {
    const pg = one<{ path: string }>(this.db, 'SELECT path FROM pages WHERE id = ? AND world_id = ?', pageId, worldId);
    if (!pg) throw new HttpError(404, 'Page not found');
    tx(this.db, () => {
      run(this.db, 'DELETE FROM fts_dm WHERE page_id = ?', pageId);
      run(this.db, 'DELETE FROM fts_party WHERE page_id = ?', pageId);
      run(this.db, 'DELETE FROM pages WHERE id = ?', pageId);
    });
    const dir = this.worldDir(worldId);
    if (dir) for (const sub of ['vault', 'party']) fs.rmSync(path.join(dir, sub, pg.path), { force: true });
    this.rebuildPlayerCopies(worldId);
  }

  /** The file list for the Library browser. Players only ever see shared pages. */
  list(worldId: string, viewer: Viewer) {
    const cols = 'p.id, p.path, p.title, p.kind, p.tags, p.folder, p.icon, p.source_id, p.external_id, p.parent_external, p.updated_at, s.name AS source_name';
    const rows = viewer.role === 'dm'
      ? all<any>(this.db, `SELECT ${cols}, p.visibility FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.world_id = ? ORDER BY p.path`, worldId)
      : all<any>(this.db, `SELECT ${cols} FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.world_id = ? AND p.visibility = 'party' AND p.player_body IS NOT NULL ORDER BY p.path`, worldId);
    const shown = new Set(rows.map((r) => `${r.source_id}|${r.external_id}`));
    return rows.map((r) => {
      const parent = r.parent_external && shown.has(`${r.source_id}|${r.parent_external}`) ? rows.find((x) => x.source_id === r.source_id && x.external_id === r.parent_external)?.id ?? null : null;
      const out: any = { id: r.id, path: r.path, title: r.title, kind: r.kind, tags: JSON.parse(r.tags || '[]'), folder: JSON.parse(r.folder || '[]'), icon: r.icon ? JSON.parse(r.icon) : null, parentId: parent, source: r.source_name ?? null, updated_at: r.updated_at };
      if (viewer.role === 'dm') out.visibility = r.visibility;
      return out;
    });
  }

  /**
   * One page. DMs get the full page; players get only the player copy of a
   * shared page. `links` maps each mention to the page it opens (only pages
   * this viewer may open).
   */
  get(worldId: string, pageId: string, viewer: Viewer) {
    const pg = one<any>(this.db, 'SELECT p.*, s.name AS source_name FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.world_id = ? AND (p.id = ? OR p.path = ?)', worldId, pageId, pageId);
    if (!pg) throw new HttpError(404, 'Page not found');
    const dm = viewer.role === 'dm';
    if (!dm && (pg.visibility !== 'party' || pg.player_body === null)) throw new HttpError(404, 'Page not found');
    const blocks: Block[] = JSON.parse((dm ? pg.blocks : pg.player_blocks) || '[]');
    const properties: PropertyGroup[] = JSON.parse((dm ? pg.properties : pg.player_properties) || '[]');
    const R = this.resolver(worldId);
    const links: Record<string, string> = {};
    for (const m of mentionsIn(blocks, properties)) {
      const t = R.find(m, pg.source_id);
      if (t && (dm || t.visibility === 'party')) links[m.ref ? `ref:${m.ref}` : `name:${String(m.name).toLowerCase()}`] = t.id;
    }
    const children = all<any>(this.db, `SELECT id, title, icon FROM pages WHERE world_id = ? AND source_id IS ? AND parent_external = ? ${dm ? '' : "AND visibility = 'party' AND player_body IS NOT NULL"} ORDER BY title`, worldId, pg.source_id, pg.external_id ?? '\u0000')
      .map((c) => ({ id: c.id, title: c.title, icon: c.icon ? JSON.parse(c.icon) : null }));
    const base = {
      id: pg.id, path: pg.path, title: pg.title, kind: pg.kind, tags: JSON.parse(pg.tags || '[]'), aliases: JSON.parse(pg.aliases || '[]'),
      icon: pg.icon ? JSON.parse(pg.icon) : null, banner: pg.banner, folder: JSON.parse(pg.folder || '[]'), source: pg.source_name ?? null,
      blocks, properties, links, children, updated_at: pg.updated_at,
    };
    if (dm) return { ...base, visibility: pg.visibility, origin: pg.origin, knowledge: pg.knowledge, url: pg.url, frontmatter: JSON.parse(pg.frontmatter || '{}'), body: pg.body };
    return { ...base, frontmatter: JSON.parse(pg.player_frontmatter || '{}'), body: pg.player_body };
  }

  search(worldId: string, q: string, viewer: Viewer, limit = 20) {
    const terms = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.slice(0, 12).map((t) => `"${t}"*`).join(' ');
    const table = viewer.role === 'dm' ? 'fts_dm' : 'fts_party';
    return all(this.db, `SELECT f.page_id AS id, p.path, f.title, snippet(${table}, 3, '[', ']', '…', 16) AS snippet
      FROM ${table} f JOIN pages p ON p.id = f.page_id
      WHERE ${table} MATCH ? AND f.world_id = ? ORDER BY rank LIMIT ?`, match, worldId, Math.min(limit, 200));
  }

  relations(worldId: string, viewer: Viewer) {
    if (viewer.role === 'dm') return all(this.db, 'SELECT id, from_title, to_title, kind, visibility FROM relations WHERE world_id = ? ORDER BY from_title', worldId);
    // A shared relation that points at a DM-only page would leak that
    // page's name, so drop it.
    return all(this.db, `SELECT r.id, r.from_title, r.to_title, r.kind FROM relations r
      WHERE r.world_id = ? AND r.visibility = 'party'
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.world_id = r.world_id AND p.title = r.to_title COLLATE NOCASE AND p.visibility <> 'party')
      ORDER BY r.from_title`, worldId);
  }

  /** Import a folder of Markdown files (kept for older callers; sources use the sync engine). */
  importFolder(worldId: string, dir: string, sourceId: string | null, defaultVisibility: string, by: string | null) {
    const root = path.resolve(dir);
    let count = 0;
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
        const full = path.join(d, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) walk(full);
        else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
          const { fm, body } = splitFrontmatter(fs.readFileSync(full, 'utf8'));
          const rel = path.relative(root, full).split(path.sep).join('/');
          this.save(worldId, { path: rel, body, frontmatter: fm, visibility: (fm.visibility as string) ?? defaultVisibility, sourceId }, by, { batch: true });
          count++;
        }
      }
    };
    try {
      walk(root);
    } finally {
      this.rebuildPlayerCopies(worldId);
    }
    return count;
  }

  private worldDir(worldId: string): string | null {
    if (!this.dataDir) return null;
    const w = one<{ slug: string }>(this.db, 'SELECT slug FROM worlds WHERE id = ?', worldId);
    return w ? path.join(this.dataDir, 'worlds', w.slug) : null;
  }

  private mirror(worldId: string, p: string, fm: FM, body: string, visibility: string, pc: { fm: FM; body: string; blocks?: Block[] | null; properties?: PropertyGroup[] | null } | null) {
    const dir = this.worldDir(worldId);
    if (!dir) return;
    const write = (sub: string, rel: string, text: string) => {
      const f = path.join(dir, sub, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    };
    write('vault', p, joinFrontmatter({ ...fm, visibility }, body));
    const partyFile = path.join(dir, 'party', p);
    if (pc) {
      write('party', p, joinFrontmatter(pc.fm, pc.body));
      write('_api', p.replace(/\.md$/i, '.json'), JSON.stringify({ path: p, frontmatter: pc.fm, body: pc.body, blocks: pc.blocks ?? [], properties: pc.properties ?? [] }, null, 2));
    } else {
      fs.rmSync(partyFile, { force: true });
      fs.rmSync(path.join(dir, '_api', p.replace(/\.md$/i, '.json')), { force: true });
    }
  }
}

function slugPart(s: string) {
  return String(s).normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/^\.+/, '').trim().slice(0, 80) || 'page';
}
