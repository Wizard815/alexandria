// The music, ambience and effects libraries: scan the folders under the
// data directory into an index, and place tracks on the mood map.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EXTS, MIME, durationOf } from './files.ts';

/** The mood map: x runs left to right, y top to bottom. */
export const CORNERS: Record<string, { x: number; y: number }> = {
  calm: { x: 0, y: 0 },
  tense: { x: 1, y: 0 },
  sneaky: { x: 0, y: 1 },
  combat: { x: 1, y: 1 },
};

export interface Mood { x: number; y: number; src: 'folder' | 'yaml' | 'gm' }
export interface Track { id: string; kind: 'music'; path: string; area: string; sub: string; title: string; duration: number | null; mood: Mood | null }
export interface AmbienceFile { id: string; kind: 'ambience'; path: string; layer: string; name: string; duration: number | null }
export interface SfxFile { id: string; kind: 'sfx'; path: string; bank: string; name: string; duration: number | null }
export interface Index {
  music: Track[]; ambience: AmbienceFile[]; sfx: SfxFile[];
  /** id → where the file is. */
  files: Map<string, { kind: 'music' | 'ambience' | 'sfx'; abs: string; mime: string }>;
  scannedAt: number;
}

const fileId = (kind: string, rel: string) => createHash('sha1').update(`${kind}/${rel}`).digest('hex').slice(0, 16);
const hash01 = (s: string, salt: string) => parseInt(createHash('sha1').update(salt + s).digest('hex').slice(0, 6), 16) / 0xffffff;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const titleOf = (file: string) => path.basename(file, path.extname(file)).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

/** The tiny YAML subset a moods.yaml uses: `name: corner`, `name: {x: .2, y: .8}`, `name: [x, y]` or `name: x, y`. `*` is the folder's default. */
export function parseMoodsYaml(text: string): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = /^(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? m[2] ?? m[3]).trim();
    const val = m[4].trim().replace(/^["']|["']$/g, '').toLowerCase();
    let p: { x: number; y: number } | null = null;
    if (CORNERS[val]) p = CORNERS[val];
    else {
      const x = /\bx\s*:\s*(-?[\d.]+)/.exec(val), y = /\by\s*:\s*(-?[\d.]+)/.exec(val);
      if (x && y) p = { x: Number(x[1]), y: Number(y[1]) };
      else {
        const nums = val.replace(/[[\]{}]/g, '').split(',').map((n) => Number(n.trim()));
        if (nums.length === 2 && nums.every((n) => Number.isFinite(n))) p = { x: nums[0], y: nums[1] };
      }
    }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) out[key] = { x: clamp01(p.x), y: clamp01(p.y) };
  }
  return out;
}

function walk(root: string, max = 6000): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const go = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || out.length >= max) return;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) go(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      else if (e.isFile()) out.push({ rel: rel ? `${rel}/${e.name}` : e.name, abs: path.join(dir, e.name) });
    }
  };
  go(root, '', 0);
  return out;
}

export function scan(dataDir: string | null): Index {
  const idx: Index = { music: [], ambience: [], sfx: [], files: new Map(), scannedAt: Date.now() };
  if (!dataDir) return idx;

  // music/
  const mfiles = walk(path.join(dataDir, 'music'));
  const yamls = new Map<string, Record<string, { x: number; y: number }>>();
  for (const f of mfiles) {
    const b = path.basename(f.rel).toLowerCase();
    if (b === 'moods.yaml' || b === 'moods.yml') {
      try { yamls.set(path.posix.dirname(f.rel), parseMoodsYaml(fs.readFileSync(f.abs, 'utf8'))); } catch { /* ignore */ }
    }
  }
  for (const f of mfiles) {
    const ext = EXTS[path.extname(f.rel).toLowerCase()];
    if (!ext) continue;
    const segs = f.rel.split('/');
    const dirs = segs.slice(0, -1);
    const id = fileId('music', f.rel);
    let mood: Mood | null = null;
    // moods.yaml in the file's folder (or a parent) wins over the folder name.
    for (let i = dirs.length; i >= 0 && !mood; i--) {
      const y = yamls.get(i === 0 ? '.' : dirs.slice(0, i).join('/'));
      if (!y) continue;
      const hit = y[segs.slice(i).join('/')] ?? y[segs[segs.length - 1]] ?? y['*'];
      if (hit) mood = { ...hit, src: 'yaml' };
    }
    if (!mood) {
      const corner = [...dirs].reverse().map((d) => d.toLowerCase()).find((d) => CORNERS[d]);
      if (corner) {
        // Spread a folder's tracks a little around its corner so they are not stacked.
        const c = CORNERS[corner];
        const pull = (v: number, salt: string) => Math.round(clamp01((v ? 0.85 : 0.15) + (hash01(f.rel, salt) - 0.5) * 0.14) * 1000) / 1000;
        mood = { x: pull(c.x, 'x'), y: pull(c.y, 'y'), src: 'folder' };
      }
    }
    idx.music.push({ id, kind: 'music', path: f.rel, area: dirs[0] ?? '', sub: dirs.slice(1).join('/'), title: titleOf(f.rel), duration: durationOf(f.abs), mood });
    idx.files.set(id, { kind: 'music', abs: f.abs, mime: MIME[ext] });
  }

  // ambience/<kind>/file
  for (const f of walk(path.join(dataDir, 'ambience'))) {
    const ext = EXTS[path.extname(f.rel).toLowerCase()];
    if (!ext) continue;
    const segs = f.rel.split('/');
    const id = fileId('ambience', f.rel);
    idx.ambience.push({ id, kind: 'ambience', path: f.rel, layer: segs.length > 1 ? segs[0].toLowerCase() : 'misc', name: titleOf(f.rel), duration: durationOf(f.abs) });
    idx.files.set(id, { kind: 'ambience', abs: f.abs, mime: MIME[ext] });
  }

  // sfx/<bank>/file
  for (const f of walk(path.join(dataDir, 'sfx'))) {
    const ext = EXTS[path.extname(f.rel).toLowerCase()];
    if (!ext) continue;
    const segs = f.rel.split('/');
    const id = fileId('sfx', f.rel);
    idx.sfx.push({ id, kind: 'sfx', path: f.rel, bank: segs.length > 1 ? segs[0] : 'general', name: titleOf(f.rel), duration: durationOf(f.abs) });
    idx.files.set(id, { kind: 'sfx', abs: f.abs, mime: MIME[ext] });
  }
  return idx;
}

/** Apply the GM's own spots (they beat moods.yaml and folder names). */
export function withOverrides(tracks: Track[], over: Map<string, { x: number; y: number }>): Track[] {
  return tracks.map((t) => (over.has(t.id) ? { ...t, mood: { ...over.get(t.id)!, src: 'gm' as const } } : t));
}

/** Is the track in this area (a top-level folder, or "area/sub")? No area means any. */
export const inArea = (t: Track, area?: string) => {
  if (!area) return true;
  const a = area.toLowerCase().replace(/^\/+|\/+$/g, '');
  return t.path.toLowerCase().startsWith(a + '/');
};

/** The track nearest to a spot on the map, among tracks that have one. Ties go to the earlier path. */
export function nearest(tracks: Track[], x: number, y: number, area?: string): Track | null {
  let best: Track | null = null;
  let bd = Infinity;
  for (const t of [...tracks].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!t.mood || !inArea(t, area)) continue;
    const d = Math.hypot(t.mood.x - x, t.mood.y - y);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

const lev = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
};

/** The ambience layer kind nearest to what was asked for ("thunderstorm" -> "storm"): exact, then one containing the other, then a shared word, then a near spelling. Null if none is close. */
export function nearestLayer(kind: string, layers: string[]): string | null {
  const k = kind.toLowerCase().trim();
  if (!k || !layers.length) return null;
  if (layers.includes(k)) return k;
  const sub = layers.filter((l) => l.includes(k) || k.includes(l)).sort((a, b) => Math.abs(a.length - k.length) - Math.abs(b.length - k.length));
  if (sub.length) return sub[0];
  const words = k.split(/[\s_-]+/).filter((w) => w.length > 2);
  const shared = layers.find((l) => l.split(/[\s_-]+/).some((w) => words.some((x) => x === w || (x.length > 3 && w.length > 3 && (x.startsWith(w) || w.startsWith(x))))));
  if (shared) return shared;
  const near = layers.map((l) => ({ l, d: lev(k, l) })).filter((x) => x.d <= Math.max(2, Math.floor(k.length / 3))).sort((a, b) => a.d - b.d);
  return near[0]?.l ?? null;
}

/** A line telling the model what the sound library really holds, for the sound tools' descriptions. */
export function libraryHint(idx: Index, tracks: Track[]): string {
  const bits: string[] = [];
  const moods = Object.keys(CORNERS).filter((m) => nearest(tracks, CORNERS[m].x, CORNERS[m].y));
  const areas = [...new Set(tracks.map((t) => t.area).filter(Boolean))].sort();
  bits.push(moods.length ? `Moods with a track: ${moods.join(', ')}.` : 'No music track has a mood yet.');
  if (areas.length) bits.push(`Music areas: ${areas.join(', ')}.`);
  const layers = [...new Set(idx.ambience.map((a) => a.layer))].sort();
  bits.push(layers.length ? `Ambience layer kinds: ${layers.join(', ')} (the nearest name is used for an unknown one).` : 'No ambience layers are in the library.');
  return bits.join(' ');
}
