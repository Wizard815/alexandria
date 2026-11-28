// Smart connections: pages that read like this one, with a similarity percent.
//
//   GET /api/worlds/:world/library/pages/:id/related?limit=8
//
// A page's vector is the normalized mean of its chunk vectors, taken from the
// scopes the VIEWER reads (scopes.ts): a player's percentages come from the
// party chunks (plus the lifted pages they may open), never from the GM copy.
// So a number can't carry hidden text or reveal a hidden link: both pages'
// vectors, the candidates and the reason snippets are the viewer's own copy.
// Candidates are limited to pages the viewer may open right now.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { HttpError } from '../../core/util.ts';
import { type Reach, openable, reachOf, reachScopes } from './scopes.ts';
import { type VectorRow, vectorStore } from './vectorstore.ts';

export interface RelatedHit {
  id: string;
  path: string;
  title: string;
  /** 0 to 100: cosine similarity of the two pages' vectors, below zero counted as 0. */
  percent: number;
  /** The best matching passage of the related page (from the viewer's own copy). */
  reason: string;
  /** The passage of this page it matched. */
  matchedWith: string;
}

interface PageVec { v: Float32Array; chunks: VectorRow[] }

const meanCache = new WeakMap<VectorRow[], Map<string, PageVec>>();
function pageVectors(rows: VectorRow[]): Map<string, PageVec> {
  const hit = meanCache.get(rows);
  if (hit) return hit;
  const out = new Map<string, PageVec>();
  for (const r of rows) {
    let e = out.get(r.page);
    if (!e) { e = { v: new Float32Array(r.v.length), chunks: [] }; out.set(r.page, e); }
    if (e.v.length !== r.v.length) continue;
    for (let i = 0; i < r.v.length; i++) e.v[i] += r.v[i];
    e.chunks.push(r);
  }
  for (const e of out.values()) {
    let n = 0;
    for (let i = 0; i < e.v.length; i++) n += e.v[i] * e.v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < e.v.length; i++) e.v[i] /= n;
  }
  meanCache.set(rows, out);
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const clip = (s: string, n = 180) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The viewer's page vectors: their base scope plus the lifted pages they may open. */
export function viewerPageVectors(d: Deps, worldId: string, reach: Reach): Map<string, PageVec> {
  const store = vectorStore(d.db);
  const out = new Map<string, PageVec>();
  for (const scope of reachScopes(reach)) {
    for (const [page, e] of pageVectors(store.rows(worldId, scope))) {
      if (scope === 'lifted' && !reach.lifted.has(page)) continue;
      if (!out.has(page)) out.set(page, e);
    }
  }
  return out;
}

export function relatedPages(d: Deps, worldId: string, viewer: Viewer, pageRef: string, limit = 8): { page: string; indexed: boolean; related: RelatedHit[] } {
  const pg = one<{ id: string }>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND (id = ? OR path = ?)', worldId, pageRef, pageRef);
  if (!pg) throw new HttpError(404, 'Page not found');
  // The viewer must be able to open the page itself (a 404 for anything they cannot).
  d.library.get(worldId, pg.id, viewer);
  const reach = reachOf(d, worldId, viewer);
  const vecs = viewerPageVectors(d, worldId, reach);
  const mine = vecs.get(pg.id);
  if (!mine || !openable(d.db, worldId, reach, [pg.id]).has(pg.id)) return { page: pg.id, indexed: false, related: [] };
  const min = Number(d.env.ALX_RELATED_MIN_SIM ?? 0.25);
  let cand: { id: string; sim: number }[] = [];
  for (const [id, e] of vecs) {
    if (id === pg.id || e.v.length !== mine.v.length) continue;
    const s = dot(mine.v, e.v);
    if (s >= min) cand.push({ id, sim: s });
  }
  cand.sort((a, b) => b.sim - a.sim);
  cand = cand.slice(0, Math.max(1, Math.min(limit, 50)) * 2);
  // Only pages the viewer may open now (the rows could be stale for a moment after a change).
  const ok = openable(d.db, worldId, reach, cand.map((c) => c.id));
  cand = cand.filter((c) => ok.has(c.id)).slice(0, Math.max(1, Math.min(limit, 50)));
  const info = new Map(cand.length ? all<any>(d.db, `SELECT id, path, title FROM pages WHERE id IN (${cand.map(() => '?').join(',')})`, ...cand.map((c) => c.id)).map((r) => [r.id, r]) : []);
  const related: RelatedHit[] = [];
  for (const c of cand) {
    const row = info.get(c.id);
    if (!row) continue;
    // The best matching pair of passages, both from the viewer's own scope.
    let best = { s: -2, a: '', b: '' };
    for (const x of mine.chunks) for (const y of vecs.get(c.id)!.chunks) {
      if (x.v.length !== y.v.length) continue;
      const s = dot(x.v, y.v);
      if (s > best.s) best = { s, a: x.text, b: y.text };
    }
    related.push({ id: row.id, path: row.path, title: row.title, percent: Math.round(Math.max(0, Math.min(1, c.sim)) * 100), reason: clip(best.b), matchedWith: clip(best.a) });
  }
  return { page: pg.id, indexed: true, related };
}
