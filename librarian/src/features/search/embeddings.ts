// Optional semantic search. When the "extra" (embeddings) model job is set,
// every page's chunks (about 500 characters) are embedded in the background
// and stored, DM copy and player copy separately:
//
//   scope 'dm'    chunks of the DM copy   (only ever searched by a DM)
//   scope 'party' chunks of the player copy (pages.player_body); DM text is
//                 never embedded into this scope
//
// Keyword results and nearest-chunk results are merged with reciprocal rank
// fusion. Without an embeddings model nothing here runs and search is
// keyword only.
import type { Deps } from '../../app.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { embed, hasJob, jobConfig } from '../../core/ai.ts';
import { type PageHit, type ParsedQuery, type Scope, factsText, makeSnippet, markHtml, parseQuery, plainText } from '../../core/pagesearch.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('dm', 'party')),
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS search_chunks_world ON search_chunks (world_id, scope);
CREATE INDEX IF NOT EXISTS search_chunks_page ON search_chunks (page_id, scope);
CREATE TABLE IF NOT EXISTS search_chunk_state (
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('dm', 'party')),
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  sig INTEGER NOT NULL,
  model TEXT NOT NULL,
  PRIMARY KEY (page_id, scope)
);
`;

export const CHUNK_CHARS = 500;
const MAX_CHUNKS_PER_PAGE = 40;
const BATCH = 16;

/** Split plain text into chunks of about `size` characters, on paragraph then sentence then word edges. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  const paras = text.split(/\n{2,}|\r\n\r\n/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const para of paras) {
    if (para.length > size) {
      push();
      for (const piece of para.split(/(?<=[.!?])\s+/)) {
        if (piece.length > size) {
          push();
          let i = 0;
          while (i < piece.length) {
            let end = Math.min(piece.length, i + size);
            if (end < piece.length) { const sp = piece.lastIndexOf(' ', end); if (sp > i + size / 2) end = sp; }
            out.push(piece.slice(i, end).trim());
            i = end;
          }
        } else if (cur && cur.length + piece.length + 1 > size) { push(); cur = piece; } else cur = cur ? `${cur} ${piece}` : piece;
      }
      push();
    } else if (cur && cur.length + para.length + 1 > size) { push(); cur = para; } else cur = cur ? `${cur}\n${para}` : para;
  }
  push();
  return out.filter(Boolean).slice(0, MAX_CHUNKS_PER_PAGE);
}

const normalize = (v: number[]): Float32Array => {
  const f = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) { f[i] = v[i]; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
};
const toBlob = (f: Float32Array) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
const fromBlob = (b: Uint8Array): Float32Array => {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
};

interface Stale { id: string; world_id: string; title: string; updated_at: string; text: string; props: string | null }

/** Text and facts of one copy; chunked on paragraphs, then each chunk is turned into plain reading text. */
const copyChunks = (r: Stale) => chunkText(`${r.text}\n\n${factsText(r.props).replace(/\n/g, '\n\n')}`).map((c) => plainText(c)).filter(Boolean);

function stalePages(db: DB, scope: Scope, model: string, limit: number): Stale[] {
  const body = scope === 'dm' ? 'p.body' : 'p.player_body';
  const props = scope === 'dm' ? 'p.properties' : 'p.player_properties';
  const guard = scope === 'dm' ? '' : 'AND p.player_body IS NOT NULL AND p.visibility = \'party\'';
  return all<Stale>(db, `SELECT p.id, p.world_id, p.title, p.updated_at, ${body} AS text, ${props} AS props FROM pages p
    LEFT JOIN search_chunk_state s ON s.page_id = p.id AND s.scope = ?
    WHERE 1 = 1 ${guard} AND (s.page_id IS NULL OR s.updated_at <> p.updated_at OR s.model <> ? OR s.sig <> length(${body}) + length(coalesce(${props}, '')))
    ORDER BY p.updated_at DESC LIMIT ?`, scope, model, limit);
}

/** Remove chunks of pages that are gone, or (party scope) no longer shared. */
export function pruneChunks(db: DB) {
  tx(db, () => {
    run(db, `DELETE FROM search_chunks WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = search_chunks.page_id)`);
    run(db, `DELETE FROM search_chunk_state WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = search_chunk_state.page_id)`);
    run(db, `DELETE FROM search_chunks WHERE scope = 'party' AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = search_chunks.page_id AND p.visibility = 'party' AND p.player_body IS NOT NULL)`);
    run(db, `DELETE FROM search_chunk_state WHERE scope = 'party' AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = search_chunk_state.page_id AND p.visibility = 'party' AND p.player_body IS NOT NULL)`);
  });
}

export interface SyncResult { embedded: number; pages: number; remaining: boolean; error?: string }

/**
 * Embed pages whose chunks are missing or out of date. Safe to call again at
 * any time; stops quietly when no embeddings model answers.
 */
export async function syncEmbeddings(d: Deps, opts: { maxPages?: number } = {}): Promise<SyncResult> {
  const res: SyncResult = { embedded: 0, pages: 0, remaining: false };
  const cfg = jobConfig(d, 'extra');
  if (!cfg) return res;
  pruneChunks(d.db);
  let budget = opts.maxPages ?? 25;
  try {
    for (const scope of ['party', 'dm'] as Scope[]) {
      while (budget > 0) {
        const rows = stalePages(d.db, scope, cfg.model, Math.min(budget, 10));
        if (!rows.length) break;
        for (const r of rows) {
          const chunks = copyChunks(r);
          const vecs: Float32Array[] = [];
          for (let i = 0; i < chunks.length; i += BATCH) {
            const part = chunks.slice(i, i + BATCH);
            const got = await embed(d, part.map((c) => `${r.title}\n${c}`));
            if (got.length !== part.length || got.some((v) => !Array.isArray(v) || !v.length)) throw new Error('The embeddings model returned an unexpected answer');
            for (const v of got) vecs.push(normalize(v));
          }
          const sig = Number(one<any>(d.db, `SELECT length(${scope === 'dm' ? 'body' : 'player_body'}) + length(coalesce(${scope === 'dm' ? 'properties' : 'player_properties'}, '')) AS n FROM pages WHERE id = ?`, r.id)?.n ?? -1);
          // The page may have changed while the model worked; the next round will see the new signature.
          tx(d.db, () => {
            run(d.db, 'DELETE FROM search_chunks WHERE page_id = ? AND scope = ?', r.id, scope);
            chunks.forEach((c, i) => run(d.db, 'INSERT INTO search_chunks (world_id, page_id, scope, idx, text, vec) VALUES (?, ?, ?, ?, ?, ?)', r.world_id, r.id, scope, i, c, toBlob(vecs[i])));
            run(d.db, `INSERT INTO search_chunk_state (page_id, scope, world_id, updated_at, sig, model) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (page_id, scope) DO UPDATE SET updated_at = excluded.updated_at, sig = excluded.sig, model = excluded.model, world_id = excluded.world_id`, r.id, scope, r.world_id, r.updated_at, sig, cfg.model);
          });
          res.embedded += chunks.length;
          res.pages++;
          budget--;
        }
      }
    }
    res.remaining = (['party', 'dm'] as Scope[]).some((s) => stalePages(d.db, s, cfg.model, 1).length > 0);
  } catch (e: any) {
    res.error = String(e?.message ?? e).slice(0, 200);
    res.remaining = true;
  }
  return res;
}

export function embeddingStats(db: DB, worldId: string) {
  const c = (scope: Scope) => Number(one<any>(db, 'SELECT count(*) AS n FROM search_chunks WHERE world_id = ? AND scope = ?', worldId, scope)?.n ?? 0);
  return { dmChunks: c('dm'), partyChunks: c('party') };
}

// ---- querying ----------------------------------------------------------------

const vecCache = new WeakMap<DB, Map<string, { stamp: string; rows: { page: string; text: string; v: Float32Array }[] }>>();

function vectors(db: DB, worldId: string, scope: Scope) {
  const stamp = JSON.stringify(one<any>(db, 'SELECT count(*) AS n, max(id) AS m, sum(id) AS s FROM search_chunks WHERE world_id = ? AND scope = ?', worldId, scope));
  let m = vecCache.get(db);
  if (!m) { m = new Map(); vecCache.set(db, m); }
  const key = `${worldId}|${scope}`;
  const hit = m.get(key);
  if (hit && hit.stamp === stamp) return hit.rows;
  const rows = all<any>(db, 'SELECT page_id, text, vec FROM search_chunks WHERE world_id = ? AND scope = ?', worldId, scope).map((r) => ({ page: r.page_id as string, text: r.text as string, v: fromBlob(r.vec) }));
  m.set(key, { stamp, rows });
  return rows;
}

/** Nearest chunks to the query, best chunk per page. Empty when there is no embeddings model. */
export async function semanticPages(d: Deps, worldId: string, scope: Scope, q: string, limit = 20): Promise<{ id: string; sim: number; text: string }[]> {
  if (!hasJob(d, 'extra')) return [];
  const got = await embed(d, [q.slice(0, 500)]);
  if (!got[0]?.length) return [];
  const qv = normalize(got[0]);
  const min = Number(d.env.ALX_SEARCH_MIN_SIM ?? 0.2);
  const best = new Map<string, { sim: number; text: string }>();
  for (const r of vectors(d.db, worldId, scope)) {
    if (r.v.length !== qv.length) continue;
    let dot = 0;
    for (let i = 0; i < qv.length; i++) dot += qv[i] * r.v[i];
    if (dot < min) continue;
    const prev = best.get(r.page);
    if (!prev || dot > prev.sim) best.set(r.page, { sim: dot, text: r.text });
  }
  const ranked = [...best].sort((a, b) => b[1].sim - a[1].sim).slice(0, limit * 2);
  if (!ranked.length) return [];
  // The page must still exist and, for the party scope, still be shared.
  const guard = scope === 'party' ? `AND visibility = 'party' AND player_body IS NOT NULL` : '';
  const ok = new Set(all<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND id IN (${ranked.map(() => '?').join(',')}) ${guard}`, worldId, ...ranked.map((r) => r[0])).map((r) => r.id));
  return ranked.filter((r) => ok.has(r[0])).slice(0, limit).map(([id, v]) => ({ id, sim: v.sim, text: v.text }));
}

/** Reciprocal rank fusion: each list adds 1 / (k + rank). */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lists) l.forEach((id, i) => out.set(id, (out.get(id) ?? 0) + 1 / (k + i + 1)));
  return out;
}

/**
 * Keyword hits merged with semantic hits. Exact title or alias matches stay
 * on top. Without an embeddings model, or if it fails, the keyword hits.
 */
export async function hybridPages(d: Deps, worldId: string, q: string, scope: Scope, limit = 20): Promise<PageHit[]> {
  const kw = d.library.search(worldId, q, { accountId: '', role: scope === 'dm' ? 'dm' : 'player' }, Math.max(limit, 30)) as PageHit[];
  if (!hasJob(d, 'extra') || !parseQuery(q).pos.length) return kw.slice(0, limit);
  let sem: { id: string; sim: number; text: string }[] = [];
  try { sem = await semanticPages(d, worldId, scope, q, Math.max(limit, 30)); } catch { return kw.slice(0, limit); }
  if (!sem.length) return kw.slice(0, limit);
  const fused = rrf([kw.map((h) => h.id), sem.map((s) => s.id)]);
  const byId = new Map(kw.map((h) => [h.id, h]));
  const pq: ParsedQuery = parseQuery(q);
  const missing = sem.filter((s) => !byId.has(s.id));
  if (missing.length) {
    const rows = all<any>(d.db, `SELECT id, path, title FROM pages WHERE world_id = ? AND id IN (${missing.map(() => '?').join(',')})`, worldId, ...missing.map((m) => m.id));
    const info = new Map(rows.map((r) => [r.id, r]));
    for (const m of missing) {
      const r = info.get(m.id);
      if (!r) continue;
      const sn = makeSnippet(m.text, pq);
      byId.set(m.id, { id: r.id, path: r.path, title: r.title, snippet: sn.text, snippetHtml: sn.html, titleHtml: markHtml(r.title, pq), score: 0, matchedOn: 'semantic', tier: 0, relevance: 0 });
    }
  }
  const out: PageHit[] = [];
  for (const [id, s] of fused) {
    const h = byId.get(id);
    if (!h) continue;
    // Exact name matches keep their lead; the rest ordered by fused rank.
    out.push({ ...h, score: Math.round((s + h.tier) * 1e5) / 1e5, relevance: s });
  }
  out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return out.slice(0, limit);
}
