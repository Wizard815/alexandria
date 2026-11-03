// The world mirror: library pages stored in SQLite, two search indexes
// (DM and party), relations read from frontmatter, and an on-disk Markdown
// vault per world that Obsidian-style editors can open.
import fs from 'node:fs';
import path from 'node:path';
import { type DB, one, all, run, tx } from './db.ts';
import { type FM, type FMValue, joinFrontmatter, splitFrontmatter } from './frontmatter.ts';
import { normVisibility, playerCopy, type Viewer } from './policy.ts';
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

  save(worldId: string, input: PageInput, by: string | null) {
    const p = safePagePath(input.path);
    const fm: FM = { ...(input.frontmatter ?? {}) };
    const visibility = normVisibility(input.visibility ?? fm.visibility ?? null);
    const title = String(input.title || fm.title || path.basename(p, '.md')).slice(0, 200);
    const body = input.body ?? '';
    if (body.length > 2_000_000) throw new HttpError(413, 'Page too large');
    const pc = playerCopy(visibility, fm, body);
    const existing = one<{ id: string }>(this.db, 'SELECT id FROM pages WHERE world_id = ? AND path = ?', worldId, p);
    const pid = existing?.id ?? id('pg_');
    tx(this.db, () => {
      if (existing) {
        run(this.db, `UPDATE pages SET title = ?, visibility = ?, frontmatter = ?, player_frontmatter = ?, body = ?, player_body = ?, source_id = COALESCE(?, source_id), updated_at = ?, updated_by = ? WHERE id = ?`,
          title, visibility, JSON.stringify(fm), pc ? JSON.stringify(pc.fm) : null, body, pc ? pc.body : null, input.sourceId ?? null, now(), by, pid);
      } else {
        run(this.db, `INSERT INTO pages (id, world_id, path, title, visibility, frontmatter, player_frontmatter, body, player_body, source_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          pid, worldId, p, title, visibility, JSON.stringify(fm), pc ? JSON.stringify(pc.fm) : null, body, pc ? pc.body : null, input.sourceId ?? null, now(), by);
      }
      run(this.db, 'DELETE FROM fts_dm WHERE page_id = ?', pid);
      run(this.db, 'DELETE FROM fts_party WHERE page_id = ?', pid);
      run(this.db, 'INSERT INTO fts_dm (page_id, world_id, title, body) VALUES (?, ?, ?, ?)', pid, worldId, title, body);
      if (pc) run(this.db, 'INSERT INTO fts_party (page_id, world_id, title, body) VALUES (?, ?, ?, ?)', pid, worldId, title, pc.body);
      run(this.db, 'DELETE FROM relations WHERE page_id = ?', pid);
      for (const r of relationsFromFrontmatter(title, fm)) {
        run(this.db, 'INSERT INTO relations (id, world_id, from_title, to_title, kind, visibility, page_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id('rel_'), worldId, title, r.to, r.kind, !r.secret && visibility === 'party' ? 'party' : 'dm', pid);
      }
    });
    this.mirror(worldId, p, fm, body, visibility, pc);
    return { id: pid, path: p, title, visibility };
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
  }

  /** Pages for this viewer. Players only ever get the player copy. */
  list(worldId: string, viewer: Viewer) {
    if (viewer.role === 'dm') {
      return all(this.db, 'SELECT id, path, title, visibility, updated_at FROM pages WHERE world_id = ? ORDER BY path', worldId);
    }
    return all(this.db, `SELECT id, path, title, updated_at FROM pages WHERE world_id = ? AND visibility = 'party' AND player_body IS NOT NULL ORDER BY path`, worldId);
  }

  get(worldId: string, pageId: string, viewer: Viewer) {
    const pg = one<any>(this.db, 'SELECT * FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', worldId, pageId, pageId);
    if (!pg) throw new HttpError(404, 'Page not found');
    if (viewer.role === 'dm') {
      return { id: pg.id, path: pg.path, title: pg.title, visibility: pg.visibility, frontmatter: JSON.parse(pg.frontmatter), body: pg.body, updated_at: pg.updated_at };
    }
    if (pg.visibility !== 'party' || pg.player_body === null) throw new HttpError(404, 'Page not found');
    return { id: pg.id, path: pg.path, title: pg.title, frontmatter: JSON.parse(pg.player_frontmatter || '{}'), body: pg.player_body, updated_at: pg.updated_at };
  }

  search(worldId: string, q: string, viewer: Viewer, limit = 20) {
    const terms = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.slice(0, 12).map((t) => `"${t}"*`).join(' ');
    const table = viewer.role === 'dm' ? 'fts_dm' : 'fts_party';
    return all(this.db, `SELECT f.page_id AS id, p.path, f.title, snippet(${table}, 3, '[', ']', '…', 16) AS snippet
      FROM ${table} f JOIN pages p ON p.id = f.page_id
      WHERE ${table} MATCH ? AND f.world_id = ? ORDER BY rank LIMIT ?`, match, worldId, Math.min(limit, 50));
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

  /** Import a folder of Markdown files (an Obsidian/Lokus/Otterly vault or a git checkout). */
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
          this.save(worldId, { path: rel, body, frontmatter: fm, visibility: (fm.visibility as string) ?? defaultVisibility, sourceId }, by);
          count++;
        }
      }
    };
    walk(root);
    return count;
  }

  private worldDir(worldId: string): string | null {
    if (!this.dataDir) return null;
    const w = one<{ slug: string }>(this.db, 'SELECT slug FROM worlds WHERE id = ?', worldId);
    return w ? path.join(this.dataDir, 'worlds', w.slug) : null;
  }

  private mirror(worldId: string, p: string, fm: FM, body: string, visibility: string, pc: { fm: FM; body: string } | null) {
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
      write('_api', p.replace(/\.md$/i, '.json'), JSON.stringify({ path: p, frontmatter: pc.fm, body: pc.body }, null, 2));
    } else {
      fs.rmSync(partyFile, { force: true });
      fs.rmSync(path.join(dir, '_api', p.replace(/\.md$/i, '.json')), { force: true });
    }
  }
}
