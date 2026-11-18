// Obsidian export and import of the vault (docs/MINERVA.md §9): a zip of
// Markdown files with front matter in the layout of §2. Import checks every
// path against that layout and every level (a page without one is dm; dm/ can
// never be opened to players).
import zlib from 'node:zlib';
import type { Deps } from '../../app.ts';
import { HttpError } from '../../core/util.ts';
import { readZip, type ZipLimits } from '../modules/zip.ts';
import { listMysteries, markRevelation, MIN_CLUES } from './revelations.ts';
import { all, run } from '../../core/db.ts';
import { audit } from './store.ts';
import { fromMarkdown, listPages, norm, players, safeRel, slug, toMarkdown, vaultLevel, writePage, ROOT } from './vault.ts';

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

/** The vault as Markdown files in the layout of §2, ready to open in Obsidian. */
export function exportVault(d: Deps, worldId: string): Buffer {
  const files = listPages(d, worldId).map((p) => ({ name: p.rel, data: Buffer.from(toMarkdown({ fm: p.fm, body: p.body }), 'utf8') }));
  return makeZip(files);
}

export interface ImportReport { created: number; updated: number; skipped: { path: string; why: string }[]; mysteries: number }

const LIMITS: ZipLimits = { entries: 5000, entryBytes: 1_000_000, totalBytes: 24_000_000 };

/** Import a zip made by exportVault or an Obsidian vault in the same layout. */
export function importVault(d: Deps, worldId: string, buf: Buffer, by: string | null): ImportReport {
  if (!buf?.length) throw new HttpError(400, 'Send the zip file as the request body');
  const entries = readZip(buf, LIMITS, (n) => /\.md$/i.test(n));
  const members = new Set(players(d, worldId).map((p) => p.accountId));
  const rep: ImportReport = { created: 0, updated: 0, skipped: [], mysteries: 0 };
  const existing = new Set(listPages(d, worldId).map((p) => p.rel));
  const touched: string[] = [];
  const revs: { slug: string; title: string; body: string }[] = [];
  for (const e of entries) {
    // A zip of the folder itself carries its name in front of every path.
    let name = e.name.replace(/\\/g, '/').replace(/^\.?\//, '');
    if (name.startsWith(`${ROOT}/`)) name = name.slice(ROOT.length + 1);
    if (name.endsWith('/')) continue;
    let rel: string;
    try { rel = safeRel(name); } catch (err: any) { rep.skipped.push({ path: e.name.slice(0, 120), why: String(err?.message ?? 'bad path') }); continue; }
    const player = /^players\/([^/]+)\//.exec(rel)?.[1];
    if (player && !members.has(player)) { rep.skipped.push({ path: rel, why: 'not a player of this world' }); continue; }
    let text: string;
    try { text = e.read().toString('utf8'); } catch (err: any) { rep.skipped.push({ path: rel, why: String(err?.message ?? 'unreadable') }); continue; }
    const { fm, body } = fromMarkdown(text);
    // Levels: missing or unknown is dm; the DM's own folder is never opened to players.
    const lv = typeof fm.level === 'string' && ['party', 'broker', 'dm', 'classified'].includes(fm.level) ? fm.level : 'dm';
    fm.level = rel.startsWith('dm/') && lv === 'party' ? 'dm' : lv;
    delete (fm as any).visibility;
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? rel.split('/').pop()!.replace(/\.md$/i, '');
    writePage(d, worldId, rel, { title, fm, body, by, batch: true });
    touched.push(rel);
    if (existing.has(rel)) rep.updated++; else rep.created++;
    if (rel.startsWith('dm/revelations/')) revs.push({ slug: slug(rel.split('/').pop()!.replace(/\.md$/i, '')), title, body });
  }
  const ids = all<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND path LIKE 'Minerva/%'`, worldId).map((r) => r.id as string);
  d.library.rebuildPlayerCopies(worldId, ids);
  for (const r of revs) if (restoreMystery(d, worldId, r, by)) rep.mysteries++;
  audit(d, worldId, by, 'minerva.import', `${rep.created} new, ${rep.updated} updated, ${rep.skipped.length} skipped`);
  return rep;
}

/** A revelation page's clue table becomes the mystery's rows, so the board and the players' knowledge come back with it. */
function restoreMystery(d: Deps, worldId: string, r: { slug: string; title: string; body: string }, by: string | null): boolean {
  const conclusion = /^##\s+Conclusion\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(r.body)?.[1]?.trim().replace(/^_.*_$/, '') ?? '';
  const rows = [...r.body.matchAll(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/gm)];
  if (rows.length < MIN_CLUES) return false;
  const have = listMysteries(d, worldId).find((m) => m.slug === r.slug);
  if (!have) {
    run(d.db, 'INSERT INTO minerva_mysteries (world_id, slug, title, conclusion, status, arc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', worldId, r.slug, r.title, conclusion, 'open', '', new Date().toISOString());
    for (const row of rows) run(d.db, 'INSERT OR IGNORE INTO minerva_clues (world_id, slug, n, text) VALUES (?, ?, ?, ?)', worldId, r.slug, Number(row[1]), row[2]);
  }
  const ps = players(d, worldId);
  for (const row of rows) {
    const found = row[3];
    if (!found || /not found yet/i.test(found)) continue;
    for (const nm of found.split(',').map((x) => x.trim()).filter(Boolean)) {
      const p = ps.find((x) => norm(x.character) === norm(nm) || norm(x.name) === norm(nm));
      if (!p) continue;
      const session = Number(/session (\d+)/i.exec(row[4])?.[1]) || null;
      try { markRevelation(d, worldId, { mystery: r.slug, clue: Number(row[1]), player: p.accountId, session, by }); } catch { /* already marked */ }
    }
  }
  return true;
}

export { vaultLevel };
