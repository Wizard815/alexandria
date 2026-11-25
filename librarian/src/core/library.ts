// The world mirror: library pages stored in SQLite, four copies of each page
// (player, broker, AI and DM, see core/levels.ts) with a search index per copy,
// relations read from frontmatter, and an on-disk Markdown vault per world that
// Obsidian-style editors can open.
import fs from 'node:fs';
import path from 'node:path';
import { type DB, one, all, run, tx } from './db.ts';
import { type FM, type FMValue, joinFrontmatter, splitFrontmatter } from './frontmatter.ts';
import { audienceOf, copyOfMarkdown, frontmatterFor, redactMarkdown, scrubHiddenLinks, scrubHiddenValues, secretHints, type Viewer } from './policy.ts';
import { imageVisibleTo, imagesForPage, importedRelations } from '../intake/records.ts';
import { mintTicket } from '../features/sound/ticket.ts';
import { folderLifted } from '../features/libshare/grants.ts';
import { type Block, type Entry, type Mention, type PropertyGroup, blocksToMarkdown, markdownToBlocks, mentionsIn } from '../intake/model.ts';
import { blocksFor, playerProperties, propertiesFor } from '../intake/player.ts';
import { type Audience, type Level, RANK, canSeeLevel, copyFor, isLevel, levelForAccountKey, levelWords, maxLevel, normLevel, pageLevel } from './levels.ts';
import { createHash } from 'node:crypto';
import { reconcile } from '../features/search/scopes.ts';
import { jobsOf } from './jobs.ts';
import { HttpError, id, now } from './util.ts';
import { type PageHit, type Scope, dmOnlyAliases, factsText, indexPage, playerAliases, scopeGuard, searchPages, unindexPage, unindexWorld } from './pagesearch.ts';

const CLEAR_COPIES = ['player', 'broker', 'ai'].flatMap((p) => ['frontmatter', 'body', 'blocks', 'properties'].map((c) => `${p}_${c} = NULL`)).join(', ');
const everythingOf = (opts: { only?: string[] }) => !opts.only?.length;
const normClassifiedText = (s: string) => s.toLowerCase().replace(/[*_`>#\[\]()|~-]+/g, ' ').replace(/\s+/g, ' ').trim();
const ALL_SCOPES: Scope[] = ['dm', 'party', 'broker', 'ai'];

/**
 * The level a page of a source gets. `auto`: what the source said. `dm`:
 * never lower than dm, whatever the source says. `party`: the page is
 * shareable unless it carries a broker or classified marker of its own
 * (secret blocks, broker and classified parts inside a page are still cut
 * from the player copy by the copy builders, so `party` never shows them).
 */
export function levelForAudience(audience: 'auto' | 'dm' | 'party', sourceLevel: Level, markerLevel: Level): Level {
  if (audience === 'dm') return maxLevel(sourceLevel, 'dm');
  if (audience === 'party') return markerLevel;
  return sourceLevel;
}

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

/** Bump when what a copy contains changes: every page's copies are rebuilt once on the next start. */
const LEVELS_VERSION = '1';
const COPY_AUDS = ['player', 'broker', 'ai'] as const;
type CopyAud = (typeof COPY_AUDS)[number];
const COPY_SCOPE: Record<CopyAud, Scope> = { player: 'party', broker: 'broker', ai: 'ai' };
const COPY_PREFIX: Record<CopyAud, string> = { player: 'player_', broker: 'broker_', ai: 'ai_' };
const scopeOf = (aud: Audience): Scope => (aud === 'player' ? 'party' : aud === 'dm' ? 'dm' : aud);

interface BuiltCopy { fm: FM; body: string; blocks: Block[]; properties: PropertyGroup[] }

/** 8-word runs of classified text, each with the world and page it came from. A Set, so isModelSafe takes it as is. */
export class ClassifiedIndex extends Set<string> {
  private where = new Map<string, string>();
  put(gram: string, where: string) { this.add(gram); this.where.set(gram, where); }
  /** `worldId|pageId` of a run, if known. */
  whereIs(gram: string): string | null { return this.where.get(gram) ?? null; }
}

const libraries = new WeakMap<DB, Library>();
/** The library that owns a database (for code that has the database and no Deps). */
export const libraryOf = (db: DB): Library | undefined => libraries.get(db);

export class Library {
  db: DB;
  dataDir: string | null;
  /** The versioned rebuild of the copies is waiting for finishMigrations (the server starts listening first). */
  migrationPending = false;

  /**
   * `deferMigration`: do not rebuild every page before returning. The old copies are cleared at once (nothing stale can be read: a
   * page without a copy is simply not shown) and finishMigrations rebuilds them in short steps while the server answers requests.
   */
  constructor(db: DB, dataDir: string | null, opts: { deferMigration?: boolean } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    libraries.set(db, this);
    if (opts.deferMigration) this.prepareMigration(); else this.migrateLevels();
  }

  private levelsCurrent(): boolean {
    try { return one<any>(this.db, `SELECT value FROM search_meta WHERE key = 'levels_version'`)?.value === LEVELS_VERSION; } catch { return true; }
  }

  private prepareMigration() {
    if (this.levelsCurrent()) return;
    if (!one(this.db, 'SELECT 1 FROM pages LIMIT 1')) { this.stampLevels(); return; }
    run(this.db, `UPDATE pages SET ${CLEAR_COPIES}`);
    this.migrationPending = true;
  }

  private stampLevels() {
    run(this.db, `INSERT INTO search_meta (key, value) VALUES ('levels_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, LEVELS_VERSION);
  }

  /** Finish what prepareMigration started: rebuild every world's copies, drop the old semantic chunks, then record the version. */
  async finishMigrations(): Promise<void> {
    if (!this.migrationPending) return;
    for (const w of all<{ id: string }>(this.db, 'SELECT id FROM worlds')) await this.rebuildPlayerCopiesAsync(w.id);
    try {
      run(this.db, `DELETE FROM search_chunks WHERE scope = 'dm'`);
      run(this.db, `DELETE FROM search_chunk_state WHERE scope = 'dm'`);
    } catch { /* the search tables are made by the search feature: nothing to drop yet */ }
    this.stampLevels();
    this.migrationPending = false;
  }

  /** Pages with no copies (a sync or a restart stopped before they were rebuilt): the ids per world. */
  pagesWithoutCopies(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of all<{ id: string; world_id: string }>(this.db, `SELECT id, world_id FROM pages WHERE ai_body IS NULL AND visibility <> 'classified'`)) {
      const list = out.get(r.world_id) ?? [];
      list.push(r.id);
      out.set(r.world_id, list);
    }
    return out;
  }

  /** Free what can be made again (copies of the resolver, the hidden-title sets, the classified text index): for a memory squeeze. */
  dropCaches() {
    this.resolverCache.clear();
    this.hiddenCache.clear();
    this.classifiedPagesCache.clear();
    this.cg = new ClassifiedIndex();
    this.cgBuilt = -1;
  }

  /**
   * Versioned, run once: rebuild every page's player, broker and AI copies and
   * their search indexes, and drop semantic chunks made before the AI copy
   * existed (they were cut from the full text).
   */
  private migrateLevels() {
    try {
      if (one<any>(this.db, `SELECT value FROM search_meta WHERE key = 'levels_version'`)?.value === LEVELS_VERSION) return;
    } catch { return; }
    for (const w of all<{ id: string }>(this.db, 'SELECT id FROM worlds')) this.rebuildPlayerCopies(w.id);
    try {
      run(this.db, `DELETE FROM search_chunks WHERE scope = 'dm'`);
      run(this.db, `DELETE FROM search_chunk_state WHERE scope = 'dm'`);
    } catch { /* the search tables are made by the search feature: nothing to drop yet */ }
    run(this.db, `INSERT INTO search_meta (key, value) VALUES ('levels_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, LEVELS_VERSION);
  }

  /**
   * Save a Markdown page (written by the DM, a request, or the MCP). In batch
   * mode (imports) the other copies are left empty until rebuildPlayerCopies
   * runs, so players never see a half-scrubbed page during a sync.
   */
  save(worldId: string, input: PageInput, by: string | null, opts: { batch?: boolean } = {}) {
    const p = safePagePath(input.path);
    const fm: FM = { ...(input.frontmatter ?? {}) };
    const title = String(input.title || fm.title || path.basename(p, '.md')).slice(0, 200);
    const body = input.body ?? '';
    if (body.length > 2_000_000) throw new HttpError(413, 'Page too large');
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? fm.tags.split(/\s*,\s*/) : [];
    // The level is the page's visibility raised by its tags, in the frontmatter or written as #broker / #classified in the text.
    const bodyTags = [...body.matchAll(/(?:^|\s)#(broker|classified)\b/gi)].map((m) => m[1]);
    const visibility: Level = pageLevel({ visibility: input.visibility ?? fm.visibility ?? null, tags: [...tags, ...bodyTags], frontmatter: fm });
    const aliases = Array.isArray(fm.aliases) ? fm.aliases.map(String) : [];
    const k = String(fm.knowledge ?? '').toLowerCase();
    const existing = one<any>(this.db, 'SELECT id, title, visibility FROM pages WHERE world_id = ? AND path = ?', worldId, p);
    const pid = existing?.id ?? id('pg_');
    tx(this.db, () => {
      if (existing) {
        run(this.db, `UPDATE pages SET title = ?, visibility = ?, frontmatter = ?, body = ?, blocks = ?, origin = 'markdown', tags = ?, aliases = ?, knowledge = ?,
          ${CLEAR_COPIES}, source_id = COALESCE(?, source_id), updated_at = ?, updated_by = ? WHERE id = ?`,
          title, visibility, JSON.stringify(fm), body, JSON.stringify(markdownToBlocks(body)), JSON.stringify(tags), JSON.stringify(aliases), ['common', 'local', 'deep'].includes(k) ? k : null, input.sourceId ?? null, now(), by, pid);
      } else {
        run(this.db, `INSERT INTO pages (id, world_id, path, title, visibility, frontmatter, body, blocks, origin, tags, aliases, knowledge, source_id, folder, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?)`,
          pid, worldId, p, title, visibility, JSON.stringify(fm), body, JSON.stringify(markdownToBlocks(body)), JSON.stringify(tags), JSON.stringify(aliases), ['common', 'local', 'deep'].includes(k) ? k : null, input.sourceId ?? null, JSON.stringify(p.split('/').slice(0, -1)), now(), by);
      }
      this.reindexDm(worldId, pid, title, body, [...aliases, ...dmOnlyAliases(fm)], '');
      this.saveRelations(worldId, pid, title, fm, visibility);
    });
    this.changed(worldId, [pid]);
    if (!opts.batch) {
      // Hiding or renaming a page changes what other pages may say about it.
      const linksChanged = !existing || existing.title !== title || existing.visibility !== visibility;
      this.rebuildPlayerCopies(worldId, linksChanged ? undefined : [pid]);
    }
    this.touchClassified();
    return { id: pid, path: p, title, visibility };
  }

  /**
   * Change a page's level (party, broker, dm, classified). Only for pages that
   * live in Alexandria; imported pages take their level from their source (and
   * their tags, which can raise it, never lower it).
   */
  setLevel(worldId: string, pageId: string, level: unknown, by: string | null) {
    const pg = one<any>(this.db, 'SELECT id, path, title, frontmatter, body, source_id, origin FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', worldId, pageId, pageId);
    if (!pg) throw new HttpError(404, 'Page not found');
    if (pg.source_id || pg.origin !== 'markdown') throw new HttpError(409, 'This page comes from a source: change its level there (tag it broker or classified, or hide it)');
    const l = String(level ?? '').toLowerCase();
    if (!isLevel(l)) throw new HttpError(400, 'level must be party, broker, dm or classified');
    const fm = { ...(JSON.parse(pg.frontmatter || '{}') as FM), visibility: l };
    // A level change ends the page's shares: a share made at one level must not come back on its own
    // when the page is later lowered again. Sharing it again is one click.
    if (String(JSON.parse(pg.frontmatter || '{}')?.visibility ?? '') !== l) {
      try { run(this.db, 'DELETE FROM sourcekeys_shares WHERE world_id = ? AND page_id = ?', worldId, pg.id); } catch { /* sharing not installed */ }
    }
    return this.save(worldId, { path: pg.path, title: pg.title, body: pg.body, frontmatter: fm, visibility: l }, by);
  }

  /** Save an entry from a source connector. Always batch: the sync rebuilds player copies at the end. */
  saveEntry(worldId: string, sourceId: string, prefix: string | null, e: Entry, by: string | null) {
    const existing = one<any>(this.db, `SELECT id, path, title, visibility, frontmatter, body, blocks, origin, parent_external, folder, aliases, tags, kind, icon, banner, url, knowledge, properties, position,
      source_level, marker_level, (ai_body IS NOT NULL OR visibility = 'classified') AS has_copies FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?`, worldId, sourceId, e.externalId);
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
    // A source says party or dm; a broker or classified tag (or level) raises it. The most secret wins.
    const fmLevel = normLevel((fm as any).visibility);
    const marker = (l: unknown): Level | null => (l === 'broker' || l === 'classified' ? l : null);
    const sourceLevel: Level = pageLevel({ visibility: normLevel(e.visibility), tags: e.tags, frontmatter: fm, level: maxLevel(e.level, marker(fmLevel)) });
    // Only what marks a page secret on its own (broker and classified tags or levels), not the source's party-or-dm flag.
    const markerLevel: Level = pageLevel({ visibility: 'party', tags: e.tags, frontmatter: fm, level: maxLevel(marker(e.level), marker(fmLevel)) });
    // A page only listed so far (index depth) says nothing about who may read it: sharing a whole source does not share what was never read.
    const aud = this.audienceOf(sourceId);
    const vis = e.depth === 'index' && aud === 'party' ? sourceLevel : levelForAudience(aud, sourceLevel, markerLevel);
    const vals = [title, vis, JSON.stringify(fm), body, JSON.stringify(blocks), isMd ? 'markdown' : 'blocks', e.parentExternalId ?? null, JSON.stringify(e.folder ?? []),
      JSON.stringify(e.aliases ?? []), JSON.stringify(e.tags ?? []), e.type ?? 'page', e.icon ? JSON.stringify(e.icon) : null, e.banner ?? null, safeSourceUrl(e.url),
      e.knowledge ?? null, JSON.stringify(e.properties ?? []), Number.isFinite(e.position) ? e.position : null, e.updatedAt || now(), by, sourceLevel, markerLevel];
    // Nothing the library keeps has changed (a scheduled sync of an unchanged source, or a source that gives no times): leave the page, its
    // updated_at, its copies, its index rows and its embeddings alone. A new updated_at would make every page look edited and read again.
    if (existing && existing.has_copies && this.sameEntry(existing, vals)) return { id: existing.id as string, path: existing.path as string, changed: false, linksChanged: false };
    let pid: string;
    tx(this.db, () => {
      if (existing) {
        pid = existing.id;
        run(this.db, `UPDATE pages SET title = ?, visibility = ?, frontmatter = ?, body = ?, blocks = ?, origin = ?, parent_external = ?, folder = ?, aliases = ?, tags = ?, kind = ?, icon = ?, banner = ?, url = ?,
          knowledge = ?, properties = ?, position = ?, updated_at = ?, updated_by = ?, source_level = ?, marker_level = ?, ${CLEAR_COPIES} WHERE id = ?`, ...vals, pid);
      } else {
        pid = id('pg_');
        run(this.db, `INSERT INTO pages (title, visibility, frontmatter, body, blocks, origin, parent_external, folder, aliases, tags, kind, icon, banner, url, knowledge, properties, position, updated_at, updated_by, source_level, marker_level, id, world_id, path, source_id, external_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...vals, pid, worldId, p, sourceId, e.externalId);
      }
      this.reindexDm(worldId, pid, title, body, (e.aliases ?? []).map(String), factsText(e.properties ?? []));
      this.saveRelations(worldId, pid, title, fm as FM, vis);
    });
    // A sync saves many pages and then rebuilds the copies and reconciles once (rebuildPlayerCopies calls changed): per page it would be 30 statements each.
    this.touchClassified();
    return { id: pid!, path: p, changed: true, linksChanged: !existing || existing.title !== title || existing.visibility !== vis };
  }

  /** Is the stored row what `vals` (see saveEntry) would write? Compared field by field, so nothing needs a stored hash. */
  private sameEntry(row: any, vals: any[]): boolean {
    const cols = ['title', 'visibility', 'frontmatter', 'body', 'blocks', 'origin', 'parent_external', 'folder', 'aliases', 'tags', 'kind', 'icon', 'banner', 'url', 'knowledge', 'properties', 'position'];
    for (let i = 0; i < cols.length; i++) {
      const a = row[cols[i]] ?? null;
      const b = vals[i] ?? null;
      if (a !== b) return false;
    }
    return (row.source_level ?? null) === (vals[19] ?? null) && (row.marker_level ?? null) === (vals[20] ?? null);
  }

  /** The audience a source is set to (auto when it has none, or its column is not there yet). */
  private audienceOf(sourceId: string): 'auto' | 'dm' | 'party' {
    try {
      const a = one<any>(this.db, 'SELECT audience FROM sources WHERE id = ?', sourceId)?.audience;
      return a === 'dm' || a === 'party' ? a : 'auto';
    } catch { return 'auto'; }
  }

  /**
   * A source's audience changed: work every page's level out again from what
   * the source said (source_level) and what marks the page secret on its own
   * (marker_level), then rebuild the copies. `dm` lifts everything to at
   * least dm; `party` takes the page to party unless it carries a broker or
   * classified marker; `auto` goes back to the source's own level.
   */
  applyAudience(worldId: string, sourceId: string): { pages: number; changed: number } {
    const aud = this.audienceOf(sourceId);
    const defaultParty = one<any>(this.db, 'SELECT default_visibility FROM sources WHERE id = ?', sourceId)?.default_visibility === 'party';
    // depth and source_shared are made by the tiered crawl's schema; a database that has not met it has neither.
    let rows: any[];
    try { rows = all<any>(this.db, 'SELECT id, title, visibility, source_level, marker_level, tags, frontmatter, depth, source_shared FROM pages WHERE world_id = ? AND source_id = ?', worldId, sourceId); }
    catch { rows = all<any>(this.db, 'SELECT id, title, visibility, source_level, marker_level, tags, frontmatter FROM pages WHERE world_id = ? AND source_id = ?', worldId, sourceId); }
    let changed = 0;
    tx(this.db, () => {
      for (const r of rows) {
        const fm = JSON.parse(r.frontmatter || '{}');
        let base: Level = isLevel(r.source_level) ? r.source_level : normLevel(r.visibility);
        // A page saved before audiences: what marks it on its own is read again from its tags and frontmatter, and any secret level it has stays.
        const markers: Level = isLevel(r.marker_level) ? r.marker_level : maxLevel(pageLevel({ visibility: 'party', tags: JSON.parse(r.tags || '[]'), frontmatter: fm }), r.visibility === 'broker' || r.visibility === 'classified' ? r.visibility : null);
        // A page read in full remembers that the source itself called it shared: the source's default visibility lets that through, or not,
        // without reading the page again. Pages the source hid, and pages it said nothing about (only listed), keep the level they have.
        if (r.source_shared === 1 && r.depth !== 'index') base = maxLevel(defaultParty ? 'party' : 'dm', markers);
        const idx = r.depth === 'index';
        const vis = idx && aud === 'party' ? base : levelForAudience(aud, base, markers);
        if (vis === r.visibility && isLevel(r.source_level) && isLevel(r.marker_level) && base === r.source_level) continue;
        run(this.db, `UPDATE pages SET visibility = ?, source_level = ?, marker_level = ?, ${CLEAR_COPIES} WHERE id = ?`, vis, base, markers, r.id);
        if (vis !== r.visibility) { changed++; this.saveRelations(worldId, r.id, r.title, fm as FM, vis); }
      }
    });
    this.rebuildPlayerCopies(worldId);
    return { pages: rows.length, changed };
  }

  /** After a full listing: remove this source's pages that the source no longer has. */
  removeMissing(worldId: string, sourceId: string, seen: Set<string>) {
    const gone = all<any>(this.db, 'SELECT id, path, external_id FROM pages WHERE world_id = ? AND source_id = ? AND external_id IS NOT NULL', worldId, sourceId).filter((r) => !seen.has(r.external_id));
    tx(this.db, () => {
      for (const g of gone) {
        for (const s of ALL_SCOPES) unindexPage(this.db, s, g.id);
        run(this.db, 'DELETE FROM pages WHERE id = ?', g.id);
      }
    });
    if (gone.length) this.changed(worldId, gone.map((g) => g.id));
    const dir = this.worldDir(worldId);
    if (dir) for (const g of gone) { for (const sub of ['vault', 'party']) fs.rmSync(path.join(dir, sub, g.path), { force: true }); fs.rmSync(path.join(dir, '_api', g.path.replace(/\.md$/i, '.json')), { force: true }); }
    this.touchClassified();
    return gone.length;
  }

  /** The DM index follows every save. The other indexes are dropped until rebuildPlayerCopies re-adds the page. */
  private reindexDm(worldId: string, pid: string, title: string, body: string, aliases: string[], facts: string) {
    for (const s of ['party', 'broker', 'ai'] as Scope[]) unindexPage(this.db, s, pid);
    indexPage(this.db, 'dm', pid, worldId, title, aliases, body, facts);
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

  /** Titles (lower case) of pages an audience must not learn about: the ones above its level. Players by default. */
  private hiddenCache = new Map<string, { rev: number; set: Set<string> }>();
  hiddenTitles(worldId: string, audience: Audience = 'player'): Set<string> {
    const key = `${worldId}|${audience}`;
    const hit = this.hiddenCache.get(key);
    if (hit && hit.rev === this.pagesRev) return hit.set;
    const set = new Set(all<{ t: string; v: string }>(this.db, 'SELECT lower(title) AS t, visibility AS v FROM pages WHERE world_id = ?', worldId)
      .filter((r) => !canSeeLevel(normLevel(r.v), audience)).map((r) => r.t));
    this.hiddenCache.set(key, { rev: this.pagesRev, set });
    return set;
  }

  /**
   * Does this text repeat something that is classified (a classified page, or
   * a classified part of a page)? Used on text a person typed or selected
   * before it goes to a model. Matches whole text or a sentence of at least 8
   * characters against what the DM copy has and the AI copy lacks.
   */
  containsClassified(worldId: string, text: string): boolean {
    const chunks = [normClassifiedText(text), ...text.split(/[.!?\n]+/).map(normClassifiedText)].filter((c) => c.length >= 8);
    if (!chunks.length) return false;
    const idx = this.classifiedPages(worldId);
    if (!idx.pages.length) return false;
    for (const c of chunks) {
      const known = idx.memo.get(c);
      if (known !== undefined) { if (known) return true; continue; }
      let hit = false;
      for (const p of idx.pages) if (p.dm.includes(c) && !p.ai.includes(c)) { hit = true; break; }
      if (idx.memo.size > 20_000) idx.memo.clear();
      idx.memo.set(c, hit);
      if (hit) return true;
    }
    return false;
  }

  /**
   * The only pages that can make containsClassified true: those whose DM text
   * differs from their AI text (a page with nothing classified has the same
   * words in both, so "in the DM copy and not in the AI copy" is never true).
   * Built once per change of the library, not once per line of a transcript.
   */
  private classifiedPagesCache = new Map<string, { version: number; pages: { dm: string; ai: string }[]; memo: Map<string, boolean> }>();
  private classifiedPages(worldId: string) {
    const hit = this.classifiedPagesCache.get(worldId);
    if (hit && hit.version === this.cgVersion) return hit;
    const pages: { dm: string; ai: string }[] = [];
    for (const p of all<any>(this.db, 'SELECT visibility, body, blocks, properties, ai_body, ai_blocks, ai_properties FROM pages WHERE world_id = ?', worldId)) {
      const flat = (...xs: (string | null)[]) => normClassifiedText(xs.map((x) => (x ?? '').replace(/"[a-zA-Z]+":/g, ' ')).join(' '));
      const dm = flat(p.body, p.blocks, p.properties);
      const ai = normLevel(p.visibility) === 'classified' ? '' : flat(p.ai_body, p.ai_blocks, p.ai_properties);
      if (dm !== ai) pages.push({ dm, ai });
    }
    const out = { version: this.cgVersion, pages, memo: new Map<string, boolean>() };
    this.classifiedPagesCache.set(worldId, out);
    return out;
  }

  // ---- the last line of defence: what text is classified -------------------------------
  //
  // core/ai.ts checks every model request against an index of the 8-word runs
  // of classified text in every world. Classified text is whatever the DM copy
  // of a page has that no AI copy has. The index is built on first use and
  // again after the pages change (touchClassified runs on every write here).
  /** A number that goes up with every change to the pages (cheap to compare: "has anything changed since I looked?"). */
  get rev(): number { return this.pagesRev; }

  /** The permission clean-up of `changed`, without counting as a change (for a periodic check that must not wake the caches it feeds). */
  reconcileQuietly(worldId: string) {
    try { this.pruneShares(worldId); } catch { /* sharing is not installed */ }
    try { reconcile(this, worldId); } catch { /* the stores are not there yet */ }
  }

  /** Bumped by every change to the pages (what the resolver and hidden-title caches depend on). */
  private pagesRev = 0;
  private cgVersion = 0;
  private cgBuilt = -1;
  private cg = new ClassifiedIndex();

  /** Call after anything that changes pages or their copies. */
  touchClassified() { this.cgVersion++; this.pagesRev++; }

  classifiedGrams(): ClassifiedIndex {
    if (this.cgBuilt === this.cgVersion) return this.cg;
    const built = this.cgVersion;
    const dm = new Map<string, string>();
    const ai = new Set<string>();
    const leaves = (json: string | null, out: string[]) => {
      const walk = (v: unknown) => {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) for (const x of v) walk(x);
        else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x);
      };
      if (json) { try { walk(JSON.parse(json)); } catch { out.push(json); } }
    };
    for (const p of all<any>(this.db, 'SELECT id, world_id, body, properties, frontmatter, ai_body, ai_properties, ai_frontmatter FROM pages')) {
      const a: string[] = [p.body ?? ''];
      leaves(p.properties, a); leaves(p.frontmatter, a);
      for (const g of levelWords(a.join('\n'))) if (!dm.has(g)) dm.set(g, `${p.world_id}|${p.id}`);
      const b: string[] = [p.ai_body ?? ''];
      leaves(p.ai_properties, b); leaves(p.ai_frontmatter, b);
      for (const g of levelWords(b.join('\n'))) ai.add(g);
    }
    const idx = new ClassifiedIndex();
    for (const [g, where] of dm) if (!ai.has(g)) idx.put(g, where);
    this.cg = idx;
    this.cgBuilt = built;
    return idx;
  }

  /** Does the page at this path hold anything classified (the whole page, a block, a facts group or a frontmatter key)? */
  hasClassified(worldId: string, pagePath: string): boolean {
    const pg = one<any>(this.db, 'SELECT visibility, blocks, properties, frontmatter FROM pages WHERE world_id = ? AND path = ?', worldId, pagePath);
    if (!pg) return false;
    if (normLevel(pg.visibility) === 'classified') return true;
    const none = () => false;
    const blocks = JSON.parse(pg.blocks || '[]');
    const props = JSON.parse(pg.properties || '[]');
    const fm = JSON.parse(pg.frontmatter || '{}');
    return JSON.stringify(blocksFor(blocks, 'ai', none)) !== JSON.stringify(blocks)
      || JSON.stringify(propertiesFor(props, 'ai', none)) !== JSON.stringify(props)
      || Object.keys(frontmatterFor(fm, 'ai')).length !== Object.keys(fm).filter((k) => k !== 'visibility').length;
  }

  /**
   * Resolve mentions in a world: by source ref first, then by title, alias,
   * file name or path (Obsidian links by file name). A ref "resource#document"
   * that is not stored falls back to the resource's first page.
   */
  private resolverCache = new Map<string, { rev: number; R: ReturnType<Library['buildResolver']> }>();
  private resolver(worldId: string) {
    const hit = this.resolverCache.get(worldId);
    if (hit && hit.rev === this.pagesRev) return hit.R;
    const R = this.buildResolver(worldId);
    this.resolverCache.set(worldId, { rev: this.pagesRev, R });
    return R;
  }
  private buildResolver(worldId: string) {
    const rows = all<any>(this.db, 'SELECT id, title, aliases, visibility, source_id, external_id, path, origin FROM pages WHERE world_id = ?', worldId);
    const byRef = new Map<string, any>();
    const byName = new Map<string, { r: any; weak: boolean }>();
    const put = (n: string, r: any, weak: boolean) => {
      const k = String(n).toLowerCase();
      const prev = byName.get(k);
      // A title always wins over a file name. Among equals, prefer the more shared page so a hidden twin can't hide it, and vice versa can't leak.
      if (!prev || (prev.weak && !weak) || (prev.weak === weak && RANK[normLevel(r.visibility)] < RANK[normLevel(prev.r.visibility)])) byName.set(k, { r, weak });
    };
    for (const r of rows) {
      if (r.external_id) byRef.set(`${r.source_id}|${r.external_id}`, r);
      for (const n of [r.title, ...JSON.parse(r.aliases || '[]')]) put(n, r, false);
    }
    for (const r of rows) {
      if (!/\.md$/i.test(r.path)) continue;
      const noExt = String(r.path).replace(/\.md$/i, '');
      put(noExt.split('/').pop()!, r, true);
      put(noExt, r, true);
    }
    const find = (m: Mention, sourceId: string | null) => {
      if (m.ref) {
        const hit = byRef.get(`${sourceId}|${m.ref}`);
        if (hit || !m.ref.includes('#')) return hit;
        return byRef.get(`${sourceId}|${m.ref.split('#')[0]}`);
      }
      if (!m.name) return undefined;
      const k = m.name.trim().toLowerCase();
      return (byName.get(k) ?? (k.includes('/') ? byName.get(k.split('/').pop()!.replace(/\.md$/, '')) : undefined))?.r;
    };
    return { find, rows };
  }

  /** One audience's copy of a page, or null when the page is above that audience's level. */
  private buildCopy(pg: any, fm: FM, aud: CopyAud, R: ReturnType<Library['resolver']>, hidden: Set<string>): BuiltCopy | null {
    const level = normLevel(pg.visibility);
    if (!canSeeLevel(level, aud)) return null;
    const isHidden = (m: Mention) => {
      const t = R.find(m, pg.source_id);
      // A ref that resolves to nothing may be a page we were not allowed to import: hide it.
      if (!t) return !!m.ref;
      return !canSeeLevel(normLevel(t.visibility), aud);
    };
    const titleOf = (m: Mention) => {
      const t = R.find(m, pg.source_id);
      return t ? t.title : m.name ?? null;
    };
    let blocks: Block[];
    let pFm: FM;
    if (pg.origin === 'markdown') {
      const pc = copyOfMarkdown(level, aud, fm, pg.body)!;
      pFm = scrubHiddenValues(pc.fm, hidden);
      blocks = blocksFor(markdownToBlocks(pc.body), aud, isHidden);
    } else {
      pFm = {};
      blocks = blocksFor(JSON.parse(pg.blocks || '[]'), aud, isHidden);
    }
    const props = JSON.parse(pg.properties || '[]') as PropertyGroup[];
    const properties = aud === 'player' ? playerProperties(props, isHidden) : propertiesFor(props, aud, isHidden);
    // The Markdown copy is made from the blocks, then redacted again as a second guard.
    const body = scrubHiddenLinks(redactMarkdown(blocksToMarkdown(blocks, (m) => (isHidden(m) ? null : titleOf(m))), aud), hidden);
    return { fm: pFm, body, blocks, properties };
  }

  /**
   * Recompute every page's player, broker and AI copies (and their search
   * indexes): drop what an audience may not read, drop unknown blocks, and
   * replace links to pages it may not see. Runs after each sync and after DM
   * saves; `only` limits it to pages whose links didn't change.
   */
  rebuildPlayerCopies(worldId: string, only?: string[]) {
    const hiddenBy = this.hiddenSets(worldId);
    const R = this.resolver(worldId);
    const sel = only?.length ? `AND id IN (${only.map(() => '?').join(',')})` : '';
    const pages = all<any>(this.db, `SELECT id, path, title, visibility, frontmatter, body, blocks, origin, properties, source_id, aliases, ai_body FROM pages WHERE world_id = ? ${sel}`, worldId, ...(only ?? []));
    tx(this.db, () => {
      if (!only?.length) for (const a of COPY_AUDS) unindexWorld(this.db, COPY_SCOPE[a], worldId);
      for (const pg of pages) this.rebuildOne(worldId, pg, R, hiddenBy, !!only?.length);
    });
    this.changed(worldId, only?.length ? only : undefined);
    this.touchClassified();
  }

  private hiddenSets(worldId: string): Record<CopyAud, Set<string>> {
    return { player: this.hiddenTitles(worldId, 'player'), broker: this.hiddenTitles(worldId, 'broker'), ai: this.hiddenTitles(worldId, 'ai') };
  }

  /** One page's copies, search index rows and mirror files. `unindex`: drop its old index rows first (a whole-world pass clears them all up front). */
  private rebuildOne(worldId: string, pg: any, R: ReturnType<Library['resolver']>, hiddenBy: Record<CopyAud, Set<string>>, unindex: boolean) {
    const fm = JSON.parse(pg.frontmatter || '{}');
    const sets: string[] = [];
    const vals: any[] = [];
    let playerBuilt: BuiltCopy | null = null;
    let aiBody: string | null = null;
    for (const aud of COPY_AUDS) {
      if (unindex) unindexPage(this.db, COPY_SCOPE[aud], pg.id);
      const c = this.buildCopy(pg, fm, aud, R, hiddenBy[aud]);
      const pre = COPY_PREFIX[aud];
      sets.push(`${pre}frontmatter = ?`, `${pre}body = ?`, `${pre}blocks = ?`, `${pre}properties = ?`);
      vals.push(c ? JSON.stringify(c.fm) : null, c ? c.body : null, c ? JSON.stringify(c.blocks) : null, c ? JSON.stringify(c.properties) : null);
      if (c) indexPage(this.db, COPY_SCOPE[aud], pg.id, worldId, pg.title, playerAliases(pg.origin, c.fm, JSON.parse(pg.aliases || '[]'), hiddenBy[aud]), c.body, factsText(c.properties));
      if (aud === 'player') playerBuilt = c;
      if (aud === 'ai') aiBody = c ? c.body : null;
    }
    run(this.db, `UPDATE pages SET ${sets.join(', ')} WHERE id = ?`, ...vals, pg.id);
    // The semantic index of the DM scope is cut from the AI copy: when that changes, its chunks go and are made again.
    // A page with no AI copy (classified) or no player copy (no longer shared) keeps no chunks of either: they were cut from text those readers may no longer have.
    if (aiBody !== pg.ai_body || aiBody === null) {
      try {
        run(this.db, `DELETE FROM search_chunks WHERE page_id = ? AND scope = 'dm'`, pg.id);
        run(this.db, `DELETE FROM search_chunk_state WHERE page_id = ? AND scope = 'dm'`, pg.id);
      } catch { /* no search tables yet */ }
    }
    if (!playerBuilt) {
      try {
        run(this.db, `DELETE FROM search_chunks WHERE page_id = ? AND scope = 'party'`, pg.id);
        run(this.db, `DELETE FROM search_chunk_state WHERE page_id = ? AND scope = 'party'`, pg.id);
      } catch { /* no search tables yet */ }
    }
    const pc: BuiltCopy | null = playerBuilt;
    this.mirror(worldId, pg.path, fm, pg.body, pg.visibility, pc ? { fm: pc.fm, body: pc.body, blocks: pc.blocks, properties: pc.properties } : null);
  }

  private rebuilding = new Map<string, { done: Promise<void>; again: boolean; all: boolean; ids: Set<string> }>();

  /**
   * The same as rebuildPlayerCopies for a sync, an import or a big edit, but in short steps
   * (a few dozen pages, each step its own small transaction) with the event loop free between them,
   * so a world of thousands of pages never holds the server for seconds.
   * A page waiting for its turn has no copy (a sync clears them as it saves), so nobody reads a half-scrubbed page.
   * The hidden titles are read again for every step, so a page hidden meanwhile is scrubbed from the pages built after it.
   * A pass asked for while another runs joins it (one more pass follows).
   */
  rebuildPlayerCopiesAsync(worldId: string, opts: { only?: string[]; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; sliceMs?: number } = {}): Promise<void> {
    const want = (slot: { again: boolean; all: boolean; ids: Set<string> }) => { if (opts.only?.length) for (const x of opts.only) slot.ids.add(x); else slot.all = true; };
    const running = this.rebuilding.get(worldId);
    if (running) { running.again = true; want(running); return running.done; }
    const slot = { done: Promise.resolve(), again: false, all: false, ids: new Set<string>() };
    want(slot);
    this.rebuilding.set(worldId, slot);
    const big = !opts.only?.length || opts.only.length > 50;
    const body = async (ctx?: { progress(done: number, total: number, message?: string): void }) => {
      try {
        do {
          slot.again = false;
          const everything = slot.all;
          const only = [...slot.ids];
          slot.all = false;
          slot.ids = new Set();
          const ids = !everything && only.length ? only : all<{ id: string }>(this.db, 'SELECT id FROM pages WHERE world_id = ? ORDER BY path', worldId).map((r) => r.id);
          let i = 0;
          while (i < ids.length && !opts.signal?.aborted) {
            const stepStart = performance.now();
            const hiddenBy = this.hiddenSets(worldId);
            const R = this.resolver(worldId);
            const take = ids.slice(i, i + 25);
            const rows = new Map(all<any>(this.db, `SELECT id, path, title, visibility, frontmatter, body, blocks, origin, properties, source_id, aliases, ai_body FROM pages WHERE world_id = ? AND id IN (${take.map(() => '?').join(',')})`, worldId, ...take).map((r) => [r.id, r]));
            let used = 0;
            let n = 0;
            tx(this.db, () => {
              for (const id of take) {
                used++;
                const pg = rows.get(id);
                if (!pg) continue;
                this.rebuildOne(worldId, pg, R, hiddenBy, true);
                // A step lasts about sliceMs (at least 5 pages).
                if (++n >= 5 && performance.now() - stepStart > (opts.sliceMs ?? 25)) break;
              }
            });
            i += used;
            opts.onProgress?.(Math.min(i, ids.length), ids.length);
            ctx?.progress(Math.min(i, ids.length), ids.length, `${Math.min(i, ids.length)} of ${ids.length} pages`);
            await new Promise<void>((r) => setImmediate(r));
          }
          this.changed(worldId, !everything && only.length ? only : undefined);
          this.touchClassified();
        } while (slot.again && !opts.signal?.aborted);
      } finally { this.rebuilding.delete(worldId); }
    };
    // A whole-world pass is a job the admin page lists; it cannot be cancelled (a page left without its copy would be hidden from players).
    slot.done = big ? jobsOf(this.db).track({ kind: 'rebuild', title: 'Updating the player copies', worldId, cancellable: false, resume: everythingOf(opts) ? { worldId } : undefined }, (ctx) => body(ctx)) : body();
    return slot.done;
  }

  /**
   * Something that decides who may read a page changed (its level, text, a
   * source audience, a key, a share, the page's removal): drop the semantic
   * chunks and story-bible facts the change makes wrong, at once and before
   * anything can read them (features/search/scopes.ts). They are made again in
   * the background. Never throws: the query paths check permissions again.
   */
  changed(worldId: string, ids?: string[]) {
    this.pagesRev++;
    try { this.pruneShares(worldId); } catch { /* sharing is not installed */ }
    try { reconcile(this, worldId, ids); } catch { /* the stores are not there yet */ }
  }

  /**
   * Delete shares that no longer hold, so they cannot come back on their own:
   * the page is no longer DM-level, the sharer lost sight of it (unshared, a
   * key revoked, left the world), or the recipient is no longer a player.
   * One person's loss ends what they shared onward, and so on down the chain.
   * Returns how many rows went.
   */
  pruneShares(worldId: string): number {
    let removed = 0;
    for (let round = 0; round < 8; round++) {
      let n = 0;
      const rows = all<any>(this.db, `SELECT s.page_id, s.from_id, s.to_id, s.kind, p.visibility, p.marker_level FROM sourcekeys_shares s
        LEFT JOIN pages p ON p.id = s.page_id AND p.world_id = s.world_id WHERE s.world_id = ?`, worldId);
      for (const s of rows) {
        const role = (acc: string) => one<{ role: string }>(this.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, acc)?.role ?? null;
        let ok = s.visibility !== null && normLevel(s.visibility) === 'dm' && (s.marker_level == null || s.marker_level === 'party');
        if (ok && s.to_id !== '*' && role(s.to_id) !== 'player') ok = false;
        if (ok) ok = s.kind === 'dm' ? role(s.from_id) === 'dm' : role(s.from_id) === 'player' && this.liftedInfo(worldId, s.from_id, s.page_id).has(s.page_id);
        if (ok) continue;
        run(this.db, 'DELETE FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? AND from_id = ? AND to_id = ?', worldId, s.page_id, s.from_id, s.to_id);
        n++;
      }
      removed += n;
      if (!n) break;
    }
    return removed;
  }

  /** A page's player copy as an account lifted to it would read it (built now, never stored), or null if there is none. For the semantic index. */
  liftedCopy(worldId: string, pageId: string): { title: string; body: string; props: PropertyGroup[]; updatedAt: string } | null {
    const pg = one<any>(this.db, 'SELECT * FROM pages WHERE id = ? AND world_id = ?', pageId, worldId);
    if (!pg) return null;
    const c = this.buildCopy({ ...pg, visibility: 'party' }, JSON.parse(pg.frontmatter || '{}'), 'player', this.resolver(worldId), this.hiddenTitles(worldId, 'player'));
    return c ? { title: pg.title, body: c.body, props: c.properties, updatedAt: pg.updated_at } : null;
  }

  remove(worldId: string, pageId: string) {
    const pg = one<{ path: string }>(this.db, 'SELECT path FROM pages WHERE id = ? AND world_id = ?', pageId, worldId);
    if (!pg) throw new HttpError(404, 'Page not found');
    tx(this.db, () => {
      for (const s of ALL_SCOPES) unindexPage(this.db, s, pageId);
      run(this.db, 'DELETE FROM pages WHERE id = ?', pageId);
    });
    this.changed(worldId, [pageId]);
    const dir = this.worldDir(worldId);
    if (dir) for (const sub of ['vault', 'party']) fs.rmSync(path.join(dir, sub, pg.path), { force: true });
    if (dir) fs.rmSync(path.join(dir, '_api', pg.path.replace(/\.md$/i, '.json')), { force: true });
    this.rebuildPlayerCopies(worldId);
  }

  /**
   * The file list for the Library browser. Each viewer sees only the pages
   * that have a copy for them: players the shared pages, a model or the
   * broker the pages up to their level, the DM everything.
   */
  list(worldId: string, viewer: Viewer) {
    const aud = audienceOf(viewer);
    const cols = 'p.id, p.path, p.title, p.kind, p.tags, p.folder, p.icon, p.source_id, p.external_id, p.parent_external, p.position, p.updated_at, p.visibility, s.name AS source_name';
    const rows = all<any>(this.db, `SELECT ${cols} FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.world_id = ? ${scopeGuard(scopeOf(aud), 'p')} ORDER BY p.path`, worldId);
    // A player also lists the pages their own per-user source key sees, and the ones shared with them (see liftedInfo).
    let lifted = new Map<string, string>();
    if (aud === 'player' && viewer.accountId) {
      lifted = this.liftedInfo(worldId, viewer.accountId);
      if (lifted.size) {
        const have = new Set(rows.map((r) => r.id));
        rows.push(...all<any>(this.db, `SELECT ${cols} FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.world_id = ? AND p.id IN (${[...lifted.keys()].map(() => '?').join(',')}) ORDER BY p.path`, worldId, ...lifted.keys()).filter((r) => !have.has(r.id)));
      }
    }
    const shown = new Set(rows.map((r) => `${r.source_id}|${r.external_id}`));
    return rows.map((r) => {
      const parent = r.parent_external && shown.has(`${r.source_id}|${r.parent_external}`) ? rows.find((x) => x.source_id === r.source_id && x.external_id === r.parent_external)?.id ?? null : null;
      const out: any = { id: r.id, path: r.path, title: r.title, kind: r.kind, tags: JSON.parse(r.tags || '[]'), folder: JSON.parse(r.folder || '[]'), icon: r.icon ? JSON.parse(r.icon) : null, parentId: parent, source: r.source_name ?? null, ...(aud !== 'player' ? { sourceId: r.source_id ?? '' } : {}), position: r.position ?? null, updated_at: r.updated_at };
      if (aud !== 'player') out.visibility = r.visibility;
      else if (lifted.has(r.id)) { out.via = lifted.get(r.id); out.sharedWithMe = lifted.get(r.id) !== 'key'; }
      return out;
    });
  }

  /**
   * One page, as the viewer's copy: players get the player copy of a shared
   * page, a model the AI copy (never classified), the broker the broker copy,
   * and the DM everything. `links` maps each mention to the page it opens
   * (only pages this viewer may open). Anything the viewer has no copy of is a 404.
   */
  get(worldId: string, pageId: string, viewer: Viewer) {
    const pg = one<any>(this.db, 'SELECT p.*, s.name AS source_name, s.kind AS source_kind, s.config AS source_config, s.last_sync_at AS source_synced_at FROM pages p LEFT JOIN sources s ON s.id = p.source_id WHERE p.world_id = ? AND (p.id = ? OR p.path = ?)', worldId, pageId, pageId);
    if (!pg) throw new HttpError(404, 'Page not found');
    const aud = audienceOf(viewer);
    const level = normLevel(pg.visibility);
    let copy = canSeeLevel(level, aud) ? copyFor(pg, aud) : null;
    // A page the source marks private, that this player's own per-user key sees: their player copy, built now and never stored.
    let fromKey = false;
    let via = '';
    if (!copy && aud === 'player' && viewer.accountId && (via = this.liftedInfo(worldId, viewer.accountId, pg.id).get(pg.id) ?? '')) {
      const built = this.buildCopy({ ...pg, visibility: 'party' }, JSON.parse(pg.frontmatter || '{}'), 'player', this.resolver(worldId), this.hiddenTitles(worldId, 'player'));
      if (built) { copy = { audience: 'player', blocks: built.blocks, markdown: built.body, properties: built.properties, frontmatter: built.fm }; fromKey = true; }
    }
    if (!copy) throw new HttpError(404, 'Page not found');
    const { blocks, properties } = copy;
    const R = this.resolver(worldId);
    const links: Record<string, string> = {};
    // The current title of each linked page, for links the source gave no words for.
    const linkTitles: Record<string, string> = {};
    for (const m of mentionsIn(blocks, properties)) {
      const t = R.find(m, pg.source_id);
      if (t && canSeeLevel(normLevel(t.visibility), aud)) {
        const key = m.ref ? `ref:${m.ref}` : `name:${String(m.name).toLowerCase()}`;
        links[key] = t.id;
        linkTitles[key] = t.title;
      }
    }
    const children = all<any>(this.db, `SELECT id, title, icon FROM pages WHERE world_id = ? AND source_id IS ? AND parent_external = ? ${scopeGuard(scopeOf(aud), '')} ORDER BY position IS NULL, position, title COLLATE NOCASE`, worldId, pg.source_id, pg.external_id ?? '\u0000')
      .map((c) => ({ id: c.id, title: c.title, icon: c.icon ? JSON.parse(c.icon) : null }));
    const pics = this.picturesOf(worldId, pg, aud, viewer, !!pg.banner);
    const base = {
      id: pg.id, path: pg.path, title: pg.title, kind: pg.kind, tags: JSON.parse(pg.tags || '[]'), aliases: JSON.parse(pg.aliases || '[]'),
      icon: pg.icon ? JSON.parse(pg.icon) : null, banner: pg.banner ?? pics[0]?.url ?? null, pictures: pics, folder: JSON.parse(pg.folder || '[]'), source: pg.source_name ?? null,
      blocks, properties, links, linkTitles, children, position: pg.position ?? null, updated_at: pg.updated_at,
      // Where the page came from and when it was last read from there.
      ...(pg.source_id ? { source_app: sourceApp(pg.source_kind), synced_at: pg.source_synced_at ?? null } : {}),
    };
    if (aud === 'dm') return { ...base, visibility: pg.visibility, level, origin: pg.origin, knowledge: pg.knowledge, url: pg.url, position: pg.position ?? null, frontmatter: copy.frontmatter, body: pg.body };
    // The source's own copy may hold more than the player copy, so players get the link only when the DM turned it on for the source.
    if (aud === 'player') return { ...base, ...(pg.url && playersMayOpen(pg.source_config) && !fromKey ? { url: pg.url } : {}), ...(fromKey ? { fromKey: true, via } : {}), frontmatter: copy.frontmatter, body: copy.markdown };
    return { ...base, visibility: pg.visibility, level, frontmatter: copy.frontmatter, body: copy.markdown };
  }

  /**
   * The page's own pictures, downloaded from its source (the generic API's images, Kanka and LegendKeeper maps): each a short-lived media address for
   * this viewer, the first (primary) first. A viewer other than the DM gets a picture only while that picture may follow the page and the page has a
   * player copy (imageVisibleTo): a DM-only second picture is never listed. `bannerGiven`: the page has its own banner address, so none is primary.
   */
  private picturesOf(worldId: string, pg: any, aud: string, viewer: Viewer, bannerGiven = false): { id: string; name: string; url: string; map: boolean; primary: boolean }[] {
    if (!viewer.accountId || !pg.source_id || !pg.external_id) return [];
    const out: { id: string; name: string; url: string; map: boolean; primary: boolean }[] = [];
    for (const img of imagesForPage(this.db, worldId, pg.source_id, pg.external_id)) {
      if (!imageVisibleTo(this.db, img, aud === 'dm' ? 'dm' : 'player')) continue;
      out.push({ id: img.id, name: img.name, url: `/api/media/intake/${mintTicket({ w: worldId, k: 'intake', f: img.id, a: viewer.accountId })}`, map: img.kind === 'map', primary: !bannerGiven && out.length === 0 });
    }
    return out;
  }

  /**
   * Ids of pages this account may open as a player although their source
   * marks them DM-only: the account holds a live, verified, per-user key with
   * the `library` use that sees the page (features/sourcekeys keeps the access
   * sets). `levelForAccountKey` decides: it lifts the source's own marking and
   * never a broker or classified marker. A missing table, a revoked key, a key
   * that is not `per-user` (blanket and unsure keys never count) or an account
   * that is no longer a player gives nothing. `only` limits the check to one page.
   */
  liftedInfo(worldId: string, accountId: string, only?: string, depth = 0): Map<string, 'key' | 'dm' | 'share'> {
    const out = new Map<string, 'key' | 'dm' | 'share'>();
    let rows: any[];
    try {
      rows = all<any>(this.db, `SELECT DISTINCT p.id, p.visibility, p.source_level, p.marker_level, s.audience
        FROM sourcekeys_access a
        JOIN sourcekeys_keys k ON k.id = a.key_id
        JOIN pages p ON p.id = a.page_id AND p.world_id = a.world_id
        JOIN sources s ON s.id = p.source_id AND s.id = k.source_id
        JOIN members m ON m.world_id = a.world_id AND m.account_id = a.account_id AND m.role = 'player'
        WHERE a.world_id = ? AND a.account_id = ? ${only ? 'AND p.id = ?' : ''} AND k.world_id = a.world_id AND k.revoked = 0 AND k.verified = 1 AND k.trust = 'per-user'
          AND EXISTS (SELECT 1 FROM json_each(k.uses) WHERE value = 'library')
          AND EXISTS (SELECT 1 FROM json_each(k.users) WHERE value = a.account_id)`, worldId, accountId, ...(only ? [only] : []));
    } catch { return out; }
    for (const r of rows) {
      const level = levelForAccountKey({ visibility: r.visibility, sourceLevel: r.source_level, markerLevel: r.marker_level, audience: r.audience ?? 'auto' }, true);
      if (normLevel(r.visibility) !== 'party' && canSeeLevel(level, 'player')) out.set(r.id, 'key');
    }
    // Pages the DM granted to this account (or the party), and pages another player shared with them. A grant is the same player copy:
    // only a page whose own marking is DM-only or none is eligible (never broker or classified), and a share is live only while the sharer can still see the page.
    let grants: any[] = [];
    try {
      grants = all<any>(this.db, `SELECT s.page_id, s.from_id, s.kind, p.visibility, p.marker_level FROM sourcekeys_shares s
        JOIN pages p ON p.id = s.page_id AND p.world_id = s.world_id
        JOIN members m ON m.world_id = s.world_id AND m.account_id = ? AND m.role = 'player'
        WHERE s.world_id = ? ${only ? 'AND s.page_id = ?' : ''} AND (s.to_id = ? OR s.to_id = '*')`, accountId, worldId, ...(only ? [only] : []), accountId);
    } catch { return out; }
    for (const g of grants) {
      if (out.has(g.page_id) || normLevel(g.visibility) !== 'dm' || (g.marker_level != null && g.marker_level !== 'party')) continue;
      if (g.kind === 'dm') {
        if (one(this.db, "SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'dm'", worldId, g.from_id)) out.set(g.page_id, 'dm');
      } else if (g.from_id !== accountId && depth < 3 && this.liftedInfo(worldId, g.from_id, g.page_id, depth + 1).has(g.page_id)) out.set(g.page_id, 'share');
    }
    // Pages in a folder the DM shared (a rule that also covers pages added or moved in later).
    for (const id of folderLifted(this.db, worldId, accountId, only)) if (!out.has(id)) out.set(id, 'dm');
    return out;
  }

  /** The ids of liftedInfo. */
  liftedPages(worldId: string, accountId: string, only?: string): Set<string> {
    return new Set(this.liftedInfo(worldId, accountId, only).keys());
  }

  /**
   * Ranked page search (see core/pagesearch.ts). Each viewer searches the
   * index of their own copy: the DM the DM copy, a model the AI copy, the
   * broker the broker copy, everyone else the player copies. Each hit has id,
   * path, title and snippet (plain text), plus snippetHtml (escaped HTML with
   * <mark>), titleHtml, score and matchedOn.
   */
  search(worldId: string, q: string, viewer: Viewer, limit = 20): PageHit[] {
    const hits = searchPages(this.db, worldId, q, scopeOf(audienceOf(viewer)), limit);
    if (audienceOf(viewer) !== 'player' || !viewer.accountId) return hits;
    const extra = this.liftedHits(worldId, q, viewer.accountId).filter((h) => !hits.some((x) => x.id === h.id));
    return [...hits, ...extra].slice(0, Math.max(1, Math.min(limit, 200)));
  }

  /** Search the pages lifted for one account (their key, a DM grant or a share) in their player copy, which is built now: they are in no index. */
  private liftedHits(worldId: string, q: string, accountId: string): PageHit[] {
    const info = this.liftedInfo(worldId, accountId);
    if (!info.size) return [];
    const want = (q.toLowerCase().match(/[\p{L}\p{N}']{2,}/gu) ?? []).slice(0, 8);
    if (!want.length) return [];
    const R = this.resolver(worldId);
    const hidden = this.hiddenTitles(worldId, 'player');
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const out: PageHit[] = [];
    for (const pg of all<any>(this.db, `SELECT * FROM pages WHERE world_id = ? AND id IN (${[...info.keys()].map(() => '?').join(',')})`, worldId, ...info.keys())) {
      const c = this.buildCopy({ ...pg, visibility: 'party' }, JSON.parse(pg.frontmatter || '{}'), 'player', R, hidden);
      if (!c) continue;
      const hay = `${pg.title} ${c.body}`.toLowerCase();
      if (!want.every((w) => hay.includes(w))) continue;
      const at = Math.max(0, c.body.toLowerCase().indexOf(want[0]));
      const snippet = c.body.slice(Math.max(0, at - 40), at + 160).replace(/\s+/g, ' ').trim();
      out.push({ id: pg.id, path: pg.path, title: pg.title, snippet, snippetHtml: esc(snippet), score: 1, titleHtml: esc(pg.title), matchedOn: 'text', tier: 0, relevance: 1 });
    }
    return out;
  }

  relations(worldId: string, viewer: Viewer) {
    const aud = audienceOf(viewer);
    // Relations a source gave (Kanka), shown with the ones from page frontmatter.
    const imported = () => { try { return importedRelations(this.db, worldId, viewer); } catch { return []; } };
    if (aud === 'dm') return [...all(this.db, 'SELECT id, from_title, to_title, kind, visibility FROM relations WHERE world_id = ? ORDER BY from_title', worldId), ...imported()];
    const hidden = this.hiddenTitles(worldId, aud);
    if (aud !== 'player') {
      // A model or the broker: relations of pages it may read, that name no page above its level.
      const guard = scopeGuard(scopeOf(aud), 'p');
      return [...all<any>(this.db, `SELECT r.id, r.from_title, r.to_title, r.kind, r.visibility FROM relations r JOIN pages p ON p.id = r.page_id WHERE r.world_id = ? ${guard} ORDER BY r.from_title`, worldId)
        .filter((r) => !hidden.has(String(r.to_title).toLowerCase()) && !hidden.has(String(r.from_title).toLowerCase())), ...imported()];
    }
    // A shared relation that points at a DM-only page would leak that
    // page's name, so drop it.
    return [...all(this.db, `SELECT r.id, r.from_title, r.to_title, r.kind FROM relations r
      WHERE r.world_id = ? AND r.visibility = 'party'
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.world_id = r.world_id AND p.title = r.to_title COLLATE NOCASE AND p.visibility <> 'party')
      ORDER BY r.from_title`, worldId), ...imported().map(({ id, from_title, to_title, kind }) => ({ id, from_title, to_title, kind }))];
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

  private mirrored = new Map<string, string>();

  /** Told of every copy the mirror writes (`error` null) or cannot write; the gateway status page keeps the failures. */
  mirrorSink: ((e: { worldId: string; copy: string; path: string; error: string | null }) => void) | null = null;

  /** The folder a world's mirror is written to (null: no data folder). */
  mirrorDir(worldId: string): string | null { return this.worldDir(worldId); }

  private worldDir(worldId: string): string | null {
    if (!this.dataDir) return null;
    const w = one<{ slug: string }>(this.db, 'SELECT slug FROM worlds WHERE id = ?', worldId);
    return w ? path.join(this.dataDir, 'worlds', w.slug) : null;
  }

  private mirror(worldId: string, p: string, fm: FM, body: string, visibility: string, pc: { fm: FM; body: string; blocks?: Block[] | null; properties?: PropertyGroup[] | null } | null) {
    const dir = this.worldDir(worldId);
    if (!dir) return;
    // The files on disk are a copy for people who read the folder; the database is the truth.
    // A copy that can't be written (e.g. "a/Dup.md" is a file and "a/Dup.md/Child.md" needs it as a folder)
    // is skipped, so one odd path never stops every later save.
    const write = (sub: string, rel: string, text: string) => {
      const f = path.join(dir, sub, rel);
      // What was written last is remembered (as a hash): a rebuild of pages that did not change writes nothing.
      const h = createHash('sha1').update(text).digest('base64');
      if (this.mirrored.get(f) === h && fs.existsSync(f)) return;
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); this.mirrored.set(f, h); this.mirrorSink?.({ worldId, copy: sub, path: rel, error: null }); }
      catch (e) {
        console.warn(`library: could not write the ${sub} copy of ${rel}: ${(e as Error).message}`);
        try { this.mirrorSink?.({ worldId, copy: sub, path: rel, error: (e as Error).message }); } catch { /* the status page never stops a save */ }
      }
    };
    const remove = (f: string) => { try { this.mirrored.delete(f); fs.rmSync(f, { force: true }); } catch (e) { console.warn(`library: could not remove ${f}: ${(e as Error).message}`); } };
    write('vault', p, joinFrontmatter({ ...fm, visibility }, body));
    const partyFile = path.join(dir, 'party', p);
    if (pc) {
      write('party', p, joinFrontmatter(pc.fm, pc.body));
      write('_api', p.replace(/\.md$/i, '.json'), JSON.stringify({ path: p, frontmatter: pc.fm, body: pc.body, blocks: pc.blocks ?? [], properties: pc.properties ?? [] }, null, 2));
    } else {
      remove(partyFile);
      remove(path.join(dir, '_api', p.replace(/\.md$/i, '.json')));
    }
  }
}

/** Which app a source is, for the "Open in ..." button. */
export function sourceApp(kind: string | null): string {
  const k = String(kind ?? '');
  if (k.startsWith('legendkeeper') || k === 'mcp:legendkeeper') return 'legendkeeper';
  if (k.startsWith('kanka') || k === 'mcp:kanka') return 'kanka';
  if (['markdown-folder', 'vault', 'git', 'mcp-files'].includes(k)) return 'markdown';
  return 'other';
}

/** The DM's per-source setting "players may open source pages". Off unless it is exactly true. */
function playersMayOpen(config: string | null): boolean {
  try { return JSON.parse(config || '{}')?.playersMayOpen === true; } catch { return false; }
}

/** A link back to a page in its own app: http, https or obsidian: only, never javascript: or data:. */
export function safeSourceUrl(u: unknown): string | null {
  const t = String(u ?? '').trim();
  return /^(https?|obsidian):\/\/\S+$/i.test(t) && t.length <= 2048 ? t : null;
}

function slugPart(s: string) {
  return String(s).normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/^\.+/, '').trim().slice(0, 80) || 'page';
}
