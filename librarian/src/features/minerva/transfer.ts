// Obsidian export and import of the vault (docs/MINERVA.md §9): a zip of
// Markdown files with front matter in the layout of §2. Import checks every
// path against that layout and every level (a page without one is gm; gm/ can
// never be opened to players).
import zlib from 'node:zlib';
import type { Deps } from '../../app.ts';
import { HttpError, id, now } from '../../core/util.ts';
import { readZip, type ZipLimits } from '../modules/zip.ts';
import { listMysteries, markRevelation, MIN_CLUES } from './revelations.ts';
import { all, one, run } from '../../core/db.ts';
import { audit, listArcs, openArc } from './store.ts';
import { fromMarkdown, listPages, norm, players, safeRel, sectionOf, slug, toMarkdown, vaultLevel, writePage, ROOT } from './vault.ts';
import type { FM } from '../../core/frontmatter.ts';

// ---- a minimal zip writer (stored, UTF-8 names) --------------------------------------------

export function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const stamp = new Date();
  const time = (stamp.getUTCHours() << 11) | (stamp.getUTCMinutes() << 5) | (stamp.getUTCSeconds() >> 1);
  const date = ((stamp.getUTCFullYear() - 1980) << 9) | ((stamp.getUTCMonth() + 1) << 5) | stamp.getUTCDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

interface Who { accountId: string; name: string; character: string; username: string }

/** The world's players with their sign-in names (the library's own `players()` has none). */
function whoAre(d: Deps, worldId: string): Who[] {
  const names = new Map(all<any>(d.db, 'SELECT id, username FROM accounts').map((r) => [r.id as string, String(r.username ?? '')]));
  return players(d, worldId).map((p) => ({ ...p, username: names.get(p.accountId) ?? '' }));
}

/** The folder a player's pages are exported under: a readable name, never the account id. */
function folderNames(ps: Who[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of ps) {
    let f = slug(p.character || p.name || p.username || 'player');
    if (used.has(f)) f = `${f}-${p.accountId.slice(-4).toLowerCase()}`;
    used.add(f);
    out.set(p.accountId, f);
  }
  return out;
}

/** The vault as Markdown files in the layout of §2, ready to open in Obsidian. Player folders carry a readable name; the account id is in each page's front matter. */
export function exportVault(d: Deps, worldId: string): Buffer {
  const ps = whoAre(d, worldId);
  const folder = folderNames(ps);
  const files = listPages(d, worldId).map((p) => {
    let rel = p.rel;
    let fm = p.fm;
    const note = /^gm\/players\/([^/]+)\.md$/.exec(rel)?.[1];
    const acc = /^players\/([^/]+)\//.exec(rel)?.[1] ?? note;
    const who = acc ? ps.find((x) => x.accountId === acc) : undefined;
    if (acc && who) {
      rel = note ? `gm/players/${folder.get(acc)}.md` : `players/${folder.get(acc)}/${rel.slice(`players/${acc}/`.length)}`;
      fm = { ...fm, player: acc, player_name: who.name, character: who.character, username: who.username };
    } else if (acc) fm = { ...fm, player: acc };
    return { name: rel, data: Buffer.from(toMarkdown({ fm, body: p.body }), 'utf8') };
  });
  // Every arc, even one with no pages yet, so the import can make its row.
  for (const a of listArcs(d.db, worldId)) files.push({ name: `chronicle/arcs/${a.slug}/arc.md`, data: Buffer.from(toMarkdown({ fm: { type: 'arc', level: 'gm', arc: a.slug, title: a.title, status: a.status, n: a.n }, body: `# ${a.title}\n` }), 'utf8') });
  return makeZip(files);
}

export interface UnmatchedFolder { folder: string; label: string; files: number }
export interface ImportReport {
  created: number; updated: number; skipped: { path: string; why: string }[]; mysteries: number; arcs: number;
  /** Player folders that matched nobody, for a mapping step. `players` are the choices. */
  unmatched: UnmatchedFolder[]; players: { accountId: string; label: string }[];
  /** How each player folder was matched. */
  mapped: { folder: string; accountId: string; how: string }[];
}
export interface ImportOptions {
  /** Player folder name to the account id of a player of this world, or "skip". */
  map?: Record<string, string>;
}

const LIMITS: ZipLimits = { entries: 5000, entryBytes: 1_000_000, totalBytes: 24_000_000 };

interface Folder { name: string; ids: Set<string>; usernames: Set<string>; labels: Set<string>; files: number }
interface Item { rel: string; fm: FM; body: string; title: string; folder: string | null }

/** Import a zip made by exportVault or an Obsidian vault in the same layout. */
export function importVault(d: Deps, worldId: string, buf: Buffer, by: string | null, opts: ImportOptions = {}): ImportReport {
  if (!buf?.length) throw new HttpError(400, 'Send the zip file as the request body');
  const entries = readZip(buf, LIMITS, (n) => /\.md$/i.test(n));
  const ps = whoAre(d, worldId);
  const rep: ImportReport = { created: 0, updated: 0, skipped: [], mysteries: 0, arcs: 0, unmatched: [], players: ps.map((p) => ({ accountId: p.accountId, label: p.character ? `${p.character} (${p.name})` : p.name })), mapped: [] };
  const existing = new Set(listPages(d, worldId).map((p) => p.rel));

  // Pass 1: read every file and note who each player folder is about.
  const items: Item[] = [];
  const arcInfo = new Map<string, { title: string; status: 'open' | 'closed' }>();
  const folders = new Map<string, Folder>();
  for (const e of entries) {
    // A zip of the folder itself carries its name in front of every path.
    let name = e.name.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (name.startsWith(`${ROOT}/`)) name = name.slice(ROOT.length + 1);
    if (name.endsWith('/')) continue;
    const arcMeta = /^chronicle\/arcs\/([^/]+)\/arc\.md$/.exec(name);
    if (arcMeta) {
      const fm = fromMarkdown(e.read().toString('utf8')).fm;
      arcInfo.set(arcMeta[1]!, { title: String(fm.title ?? ''), status: fm.status === 'open' ? 'open' : 'closed' });
      continue;
    }
    let rel: string;
    try { rel = safeRel(name); } catch (err: any) { rep.skipped.push({ path: e.name.slice(0, 120), why: String(err?.message ?? 'bad path') }); continue; }
    let text: string;
    try { text = e.read().toString('utf8'); } catch (err: any) { rep.skipped.push({ path: rel, why: String(err?.message ?? 'unreadable') }); continue; }
    const { fm, body } = fromMarkdown(text);
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel.split('/').pop()!.replace(/\.md$/i, '');
    const folder = /^players\/([^/]+)\//.exec(rel)?.[1] ?? /^gm\/players\/([^/]+)\.md$/.exec(rel)?.[1] ?? null;
    if (folder) {
      const f = folders.get(folder) ?? { name: folder, ids: new Set(), usernames: new Set(), labels: new Set(), files: 0 };
      f.files++;
      if (typeof fm.player === 'string' && fm.player) f.ids.add(fm.player);
      if (typeof fm.username === 'string' && fm.username) f.usernames.add(fm.username);
      for (const k of ['character', 'player_name'] as const) if (typeof fm[k] === 'string' && fm[k]) f.labels.add(String(fm[k]));
      folders.set(folder, f);
    }
    items.push({ rel, fm, body, title, folder });
  }

  // Map each player folder to a player of this world: account id, then username, then character or name.
  const target = new Map<string, string>();
  const taken = new Set<string>();
  const byId = (pid: string) => ps.find((p) => p.accountId === pid);
  const labelOf = (f: Folder) => [...f.labels][0] ?? f.name;
  const resolve = (f: Folder): { p: Who; how: string } | null => {
    const chosen = opts.map?.[f.name];
    if (chosen) { const p = byId(chosen); return p ? { p, how: 'chosen' } : null; }
    let p = byId(f.name) ?? [...f.ids].map(byId).find(Boolean);
    if (p) return { p, how: 'account id' };
    const sl = slug(f.name);
    p = ps.find((x) => x.username && ([...f.usernames].some((u) => u.toLowerCase() === x.username.toLowerCase()) || slug(x.username) === sl));
    if (p) return { p, how: 'username' };
    const cands = [f.name, ...f.labels];
    p = ps.find((x) => cands.some((c) => norm(c) && (norm(c) === norm(x.character) || norm(c) === norm(x.name) || slug(c) === slug(x.character || '\u0000') || slug(c) === slug(x.name || '\u0000'))));
    return p ? { p, how: 'character or name' } : null;
  };
  const nameMap = new Map<string, string>();
  for (const f of folders.values()) {
    if (opts.map?.[f.name] === 'skip') { rep.unmatched.push({ folder: f.name, label: labelOf(f), files: f.files }); continue; }
    const r = resolve(f);
    if (r && !taken.has(r.p.accountId)) {
      taken.add(r.p.accountId);
      target.set(f.name, r.p.accountId);
      rep.mapped.push({ folder: f.name, accountId: r.p.accountId, how: r.how });
      for (const n of [f.name, ...f.labels]) nameMap.set(norm(n), r.p.accountId);
    } else rep.unmatched.push({ folder: f.name, label: labelOf(f), files: f.files });
  }

  // Pass 2: write.
  const revs: { slug: string; title: string; body: string }[] = [];
  const theories: { player: string; text: string; title: string }[] = [];
  const sessions: { rel: string; fm: FM; title: string }[] = [];
  for (const it of items) {
    let { rel, fm } = it;
    if (it.folder) {
      const acc = target.get(it.folder);
      if (!acc) { rep.skipped.push({ path: rel, why: opts.map?.[it.folder] === 'skip' ? 'skipped by choice' : `no player of this world matches "${it.folder}"` }); continue; }
      rel = rel.startsWith('gm/') ? `gm/players/${acc}.md` : `players/${acc}/${rel.slice(`players/${it.folder}/`.length)}`;
      fm = { ...fm, player: acc };
      for (const k of ['player_name', 'character', 'username']) delete fm[k];
      if (/\/knowledge\.md$/.test(rel)) {
        const th = sectionOf(it.body, 'Theories')?.text ?? '';
        for (const m of th.matchAll(/^[-*]\s+(.+?)\s+_\((.+), not confirmed\)_\s*$/gm)) theories.push({ player: acc, text: m[1]!, title: m[2]! });
      }
    }
    // Levels: missing or unknown is gm; the GM's own folder is never opened to players.
    const lv = typeof fm.level === 'string' && ['party', 'broker', 'gm', 'classified'].includes(fm.level) ? fm.level : 'gm';
    fm.level = rel.startsWith('gm/') && lv === 'party' ? 'gm' : lv;
    delete (fm as any).visibility;
    writePage(d, worldId, rel, { title: it.title, fm, body: it.body, by, batch: true });
    if (existing.has(rel)) rep.updated++; else rep.created++;
    if (rel.startsWith('gm/revelations/')) revs.push({ slug: slug(rel.split('/').pop()!.replace(/\.md$/i, '')), title: it.title, body: it.body });
    if (/^chronicle\/arcs\/[^/]+\/(summary|sessions\/[^/]+)\.md$/.test(rel)) sessions.push({ rel, fm, title: it.title });
  }
  const ids = all<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND path LIKE 'Minerva/%'`, worldId).map((r) => r.id as string);
  d.library.rebuildPlayerCopies(worldId, ids);
  rep.arcs = restoreArcs(d, worldId, sessions, arcInfo);
  for (const r of revs) if (restoreMystery(d, worldId, r, by, nameMap)) rep.mysteries++;
  for (const t of theories) {
    const m = listMysteries(d, worldId).find((x) => norm(x.title) === norm(t.title));
    if (m) try { markRevelation(d, worldId, { mystery: m.slug, player: t.player, kind: 'theory', text: t.text, by }); } catch { /* already noted */ }
  }
  audit(d, worldId, by, 'minerva.import', `${rep.created} new, ${rep.updated} updated, ${rep.skipped.length} skipped, ${rep.arcs} arcs`);
  return rep;
}

/** Arc rows from the arc folders and session pages that came in: closed when the folder has a summary, otherwise the last one is open. */
function restoreArcs(d: Deps, worldId: string, pages: { rel: string; fm: FM; title: string }[], info: Map<string, { title: string; status: 'open' | 'closed' }>): number {
  const slugs = new Map<string, { summary?: string; sessions: { n: number; rel: string; fm: FM }[] }>();
  for (const p of pages) {
    const m = /^chronicle\/arcs\/([^/]+)\/(.+)$/.exec(p.rel)!;
    const a = slugs.get(m[1]!) ?? { sessions: [] };
    if (m[2] === 'summary.md') a.summary = p.title; else a.sessions.push({ n: Number(/session-(\d+)/.exec(m[2]!)?.[1] ?? 0), rel: p.rel, fm: p.fm });
    slugs.set(m[1]!, a);
  }
  for (const k of info.keys()) if (!slugs.has(k)) slugs.set(k, { sessions: [] });
  const have = new Set(listArcs(d.db, worldId).map((a) => a.slug));
  let made = 0;
  const order = [...slugs.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const sl of order) {
    const a = slugs.get(sl)!;
    if (!have.has(sl)) {
      const n = (one<any>(d.db, 'SELECT MAX(n) AS n FROM minerva_arcs WHERE world_id = ?', worldId)?.n ?? 0) + 1;
      const meta = info.get(sl);
      const title = meta?.title || a.summary?.replace(/:\s*summary$/i, '').trim() || sl.replace(/^\d+-/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const wantOpen = meta ? meta.status === 'open' : !a.summary && sl === order[order.length - 1];
      const status = wantOpen && !openArc(d.db, worldId) ? 'open' : 'closed';
      run(d.db, 'INSERT INTO minerva_arcs (id, world_id, n, slug, title, status, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id('arc_'), worldId, n, sl, title, status, now(), status === 'closed' ? now() : null);
      have.add(sl);
      made++;
    }
    // Session pages: the session counter must continue after them.
    for (const s of a.sessions) {
      if (!s.n || one(d.db, 'SELECT 1 FROM minerva_sessions WHERE world_id = ? AND number = ?', worldId, s.n)) continue;
      const src = Array.isArray(s.fm.sources) ? String(s.fm.sources[0] ?? '') : '';
      run(d.db, 'INSERT OR IGNORE INTO minerva_sessions (world_id, entry_id, number, arc_slug, rel, filed_at) VALUES (?, ?, ?, ?, ?, ?)', worldId, src || `import:${s.rel}`, s.n, sl, s.rel, now());
    }
  }
  return made;
}

/** A revelation page's clue table becomes the mystery's rows, so the board and the players' knowledge come back with it. */
function restoreMystery(d: Deps, worldId: string, r: { slug: string; title: string; body: string }, by: string | null, nameMap: Map<string, string>): boolean {
  const conclusion = /^##\s+Conclusion\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(r.body)?.[1]?.trim().replace(/^_.*_$/, '') ?? '';
  const rows = [...r.body.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/gm)];
  if (rows.length < MIN_CLUES) return false;
  const have = listMysteries(d, worldId).find((m) => m.slug === r.slug);
  if (!have) {
    run(d.db, 'INSERT INTO minerva_mysteries (world_id, slug, title, conclusion, status, arc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', worldId, r.slug, r.title, conclusion, 'open', '', new Date().toISOString());
    for (const row of rows) run(d.db, 'INSERT OR IGNORE INTO minerva_clues (world_id, slug, n, text) VALUES (?, ?, ?, ?)', worldId, r.slug, Number(row[1]), row[2]);
  }
  const ps = players(d, worldId);
  const reached = /^##\s+Who reached it\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(r.body)?.[1] ?? '';
  for (const m of reached.matchAll(/^[-*]\s+(.+?)\s*$/gm)) {
    const p = ps.find((x) => x.accountId === nameMap.get(norm(m[1]!))) ?? ps.find((x) => norm(x.character) === norm(m[1]!) || norm(x.name) === norm(m[1]!));
    if (p) try { markRevelation(d, worldId, { mystery: r.slug, player: p.accountId, kind: 'reached', by }); } catch { /* already marked */ }
  }
  for (const row of rows) {
    const found = row[3];
    if (!found || /not found yet/i.test(found)) continue;
    for (const nm of found.split(',').map((x) => x.trim()).filter(Boolean)) {
      const p = ps.find((x) => x.accountId === nameMap.get(norm(nm))) ?? ps.find((x) => norm(x.character) === norm(nm) || norm(x.name) === norm(nm));
      if (!p) continue;
      const session = Number(/session (\d+)/i.exec(row[4])?.[1]) || null;
      try { markRevelation(d, worldId, { mystery: r.slug, clue: Number(row[1]), player: p.accountId, session, by }); } catch { /* already marked */ }
    }
  }
  return true;
}

export { vaultLevel };
