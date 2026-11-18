// Saving a generated result: a library page (DM level unless the DM picks party;
// DM-only parts stay in secret callouts), and for a map or a tavern also the
// picture as a library file of kind "map" so the Map page can use it.
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { one, run } from '../../core/db.ts';
import { HttpError, id as newId, now } from '../../core/util.ts';
import { firstLeak, makeCtx } from '../sculpt/ctx.ts';
import { toPng, toSvg } from './maps/index.ts';
import { publicText, renderMd, type Out } from './gen.ts';

const FOLDER: Record<string, string> = { npc: 'NPCs', monster: 'Monsters', tavern: 'Taverns', map: 'Maps', names: 'Names' };
const cleanSeg = (s: string) => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled';

export interface Saved {
  page: { id: string; path: string; title: string; level: string };
  files: { id: string; name: string; kind: string; level: string; mime: string }[];
}

/** Write bytes as a library file of a page, the way an upload does (DM level unless told otherwise). */
function addFile(d: Deps, worldId: string, pageId: string, by: string, f: { name: string; kind: 'map' | 'other'; level: 'dm' | 'party'; mime: string; bytes: Uint8Array }) {
  if (!d.dataDir) throw new HttpError(503, 'This server has no data folder for files');
  const fid = newId('lf_');
  const dir = path.join(d.dataDir, 'libfiles', worldId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fid), f.bytes);
  run(d.db, 'INSERT INTO libfiles_files (id, world_id, page_id, name, kind, level, mime, family, size, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', fid, worldId, pageId, f.name, f.kind, f.level, f.mime, 'image', f.bytes.length, by, now());
  d.hub.emit(worldId, 'libfile', { pageId }, (v: any) => v.role === 'dm' || f.level === 'party');
  return { id: fid, name: f.name, kind: f.kind, level: f.level, mime: f.mime };
}

export function saveOut(d: Deps, worldId: string, accountId: string, out: Out, o: { level?: string; path?: string } = {}): Saved {
  const level: 'dm' | 'party' = o.level === 'party' ? 'party' : 'dm';
  if (level === 'party') {
    // Whatever players could read is checked against what only the DM may know.
    const hit = firstLeak(makeCtx(d, worldId, false, {}), publicText(out));
    if (hit) throw new HttpError(409, 'Not shared: the text repeats words from DM-only notes. Save it at DM level, or reroll.');
  }
  const raw = (o.path?.replace(/\.md$/i, '') || `Generated/${FOLDER[out.kind] ?? 'Other'}/${out.title}`).split('/').map((x) => x.trim()).filter((x) => x && x !== '.' && x !== '..').map(cleanSeg);
  const stem = raw.join('/');
  let p = `${stem}.md`;
  for (let n = 2; one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', worldId, p); n++) p = `${stem} ${n}.md`;
  const fm = { title: out.title, kind: out.kind, tags: ['generated', `gen-${out.kind}`, out.preset].filter(Boolean), generator: out.kind, preset: out.preset, seed: out.seed, visibility: level };
  const page = d.library.save(worldId, { path: p, title: out.title, body: renderMd(out, level), frontmatter: fm, visibility: level }, accountId);
  const files: Saved['files'] = [];
  const m = out.map_result;
  if (m) {
    // A party copy has none of the DM's marks (secret doors, traps, hazards).
    const dmView = level === 'dm';
    const base = cleanSeg(out.title);
    files.push(addFile(d, worldId, page.id, accountId, { name: `${base}${dmView ? ' (DM)' : ''}.png`, kind: 'map', level, mime: 'image/png', bytes: toPng(m.canvas, { dm: dmView }) }));
    files.push(addFile(d, worldId, page.id, accountId, { name: `${base}${dmView ? ' (DM)' : ''}.svg`, kind: 'other', level, mime: 'image/svg+xml', bytes: Buffer.from(toSvg(m.canvas, { dm: dmView, title: out.title })) }));
  }
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, 'generators.save', `${out.kind} ${page.path} ${level}`.slice(0, 500), now());
  return { page: { id: page.id, path: page.path, title: page.title, level }, files };
}
