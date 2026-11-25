// Optional semantic search. When the "extra" (embeddings) model job is set,
// every page's chunks (about 500 characters) are embedded in the background
// and stored per scope (the full permission model is in scopes.ts):
//
//   scope 'dm'      chunks of the AI copy (pages.ai_body: everything but
//                   classified, which is never embedded or sent to the
//                   embeddings model); read by a DM and by every model
//   scope 'broker'  chunks of the broker copy; read by the information broker
//   scope 'party'   chunks of the player copy (pages.player_body); DM text is
//                   never embedded into this scope
//   scope 'lifted'  the player copy of pages that are not party-level but that
//                   some account may open (own source key, DM grant, share);
//                   a player reads the rows of pages they may open right now
//
// A query is filtered by who asks (reachOf) and every hit is checked against
// the pages table again. The store sits behind the small VectorStore
// interface (vectorstore.ts) so another backend could be added later.
//
// Keyword results and nearest-chunk results are merged with reciprocal rank
// fusion. Without an embeddings model nothing here runs and search is
// keyword only.
import type { Deps } from '../../app.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { ClassifiedRefused, ModelUnavailable, embed, hasJob, jobConfig, rerankItems } from '../../core/ai.ts';
import type { Viewer } from '../../core/policy.ts';
import { type PageHit, type ParsedQuery, type Scope, makeSnippet, markHtml, parseQuery, plainText } from '../../core/pagesearch.ts';
import { type Pending, backedOffCount, bindBackoff, eligibleIds, isBackedOff, isCurrent, noteRefused, pendingCopies } from './copies.ts';
import { libraryOf as libraryFor } from '../../core/library.ts';
import { type Reach, type VecScope, VEC_SCOPES, openable, reachOf, reachOfScope, reachScopes } from './scopes.ts';
import { noteDone, progress } from './pace.ts';
import { normalize, vectorStore } from './vectorstore.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('dm', 'party', 'broker', 'lifted')),
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS search_chunks_world ON search_chunks (world_id, scope);
CREATE INDEX IF NOT EXISTS search_chunks_page ON search_chunks (page_id, scope);
CREATE INDEX IF NOT EXISTS search_chunks_wsp ON search_chunks (world_id, scope, page_id);
CREATE TABLE IF NOT EXISTS search_chunk_state (
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('dm', 'party', 'broker', 'lifted')),
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  sig INTEGER NOT NULL,
  model TEXT NOT NULL,
  hash TEXT,
  PRIMARY KEY (page_id, scope)
);
`;

/** Older databases allowed only the dm and party scopes: rebuild the two tables once (their rows are kept). */
export function migrateSearch(db: DB) {
  bindBackoff(db);
  const sqlOf = (t: string) => String(one<any>(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, t)?.sql ?? '');
  if (sqlOf('search_chunks') && !sqlOf('search_chunks').includes("'lifted'")) {
    tx(db, () => {
      run(db, 'DROP INDEX IF EXISTS search_chunks_world');
      run(db, 'DROP INDEX IF EXISTS search_chunks_page');
      run(db, 'ALTER TABLE search_chunks RENAME TO search_chunks_old');
      run(db, SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS search_chunks'), SCHEMA.indexOf('CREATE INDEX')));
      run(db, 'INSERT INTO search_chunks (id, world_id, page_id, scope, idx, text, vec) SELECT id, world_id, page_id, scope, idx, text, vec FROM search_chunks_old');
      run(db, 'DROP TABLE search_chunks_old');
      run(db, 'CREATE INDEX IF NOT EXISTS search_chunks_world ON search_chunks (world_id, scope)');
      run(db, 'CREATE INDEX IF NOT EXISTS search_chunks_page ON search_chunks (page_id, scope)');
    });
  }
  if (sqlOf('search_chunk_state') && !sqlOf('search_chunk_state').includes("'lifted'")) {
    tx(db, () => {
      run(db, 'ALTER TABLE search_chunk_state RENAME TO search_chunk_state_old');
      run(db, SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS search_chunk_state')));
      run(db, 'INSERT INTO search_chunk_state (page_id, scope, world_id, updated_at, sig, model) SELECT page_id, scope, world_id, updated_at, sig, model FROM search_chunk_state_old');
      run(db, 'DROP TABLE search_chunk_state_old');
    });
  }
}

export const CHUNK_CHARS = 500;
/** Chunks are tagged with the level scheme they were cut under; older ones (cut from the full text) are never read. */
const tagged = (model: string) => `${model}|lv1`;
const MAX_CHUNKS_PER_PAGE = 40;
const BATCH = 16;
/** Scopes are taken in turn, a few pages each (the party's copy, then the DM's, in each turn), so no scope waits for the others to finish. */
const ORDER: VecScope[] = ['party', 'dm', 'lifted', 'broker'];
const PER_TURN = 3;


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

/** Remove chunks of pages that are gone or that a scope's copy no longer covers (every world). */
export function pruneChunks(db: DB) {
  const lib = libraryFor(db);
  for (const w of all<{ id: string }>(db, 'SELECT id FROM worlds')) lib?.reconcileQuietly(w.id);
  tx(db, () => {
    run(db, `DELETE FROM search_chunks WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = search_chunks.page_id)`);
    run(db, `DELETE FROM search_chunk_state WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = search_chunk_state.page_id)`);
  });
  prunedAt.set(db, lib?.rev ?? -1);
}
const prunedAt = new WeakMap<DB, number>();
/** pruneChunks, unless nothing has changed in the library since the last time (the background tick runs every 20 seconds). */
function pruneIfChanged(db: DB) {
  const lib = libraryFor(db);
  if (lib && prunedAt.get(db) === lib.rev) return;
  pruneChunks(db);
}

export interface SyncResult { embedded: number; pages: number; remaining: boolean; error?: string; /** Pages the classified guard refused this round (they are retried later, not every tick). */ refused?: number }

/**
 * Embed pages whose chunks are missing or out of date. Safe to call again at
 * any time; stops quietly when no embeddings model answers.
 *
 * Idle costs nothing: with every page current there is no model call, and the
 * pass is a few small queries. A page the model keeps refusing or failing on
 * is left alone for a while (copies.ts, kept in the database), and a model
 * that is down ends the pass at the first failure.
 */
export async function syncEmbeddings(d: Deps, opts: { maxPages?: number; worldId?: string; signal?: AbortSignal; onPage?: (done: { pages: number; embedded: number; id: string; scope: VecScope }) => void } = {}): Promise<SyncResult> {
  const res: SyncResult = { embedded: 0, pages: 0, remaining: false };
  const cfg = jobConfig(d, 'extra');
  if (!cfg) return res;
  pruneIfChanged(d.db);
  const store = vectorStore(d.db);
  const model = tagged(cfg.model);
  let budget = opts.maxPages ?? 25;
  // Each scope's waiting pages are read once, in batches, and taken a few at a time: not one query per three pages.
  const queues = new Map<VecScope, Pending[]>();
  const exhausted = new Set<VecScope>();
  const next = (scope: VecScope, n: number): Pending[] => {
    let q = queues.get(scope) ?? [];
    if (q.length < n && !exhausted.has(scope)) {
      const batch = pendingCopies(d, scope, 'search_chunk_state', model, 40 + backedOffCount(), opts.worldId).filter((r) => !isBackedOff(r) && !q.some((x) => x.id === r.id));
      if (!batch.length) exhausted.add(scope);
      q = [...q, ...batch];
    }
    queues.set(scope, q.slice(n));
    return q.slice(0, n);
  };
  try {
    for (let more = true; more && budget > 0 && !opts.signal?.aborted;) {
      more = false;
      for (const scope of ORDER) {
        if (budget <= 0 || opts.signal?.aborted) break;
        const take = Math.min(budget, PER_TURN);
        const rows = next(scope, take);
        if (!rows.length) continue;
        more = true;
        for (const r of rows) {
          if (opts.signal?.aborted) break;
          // The page may have changed while the queue waited: skip what is no longer what was read.
          if (!isCurrent(d, r)) continue;
          const chunks = chunkText(r.full).map((c) => plainText(c)).filter(Boolean);
          const vecs: Float32Array[] = [];
          try {
            for (let i = 0; i < chunks.length; i += BATCH) {
              const part = chunks.slice(i, i + BATCH);
              const got = await embed(d, part.map((c) => `${r.title}\n${c}`), opts.signal);
              if (got.length !== part.length || got.some((v) => !Array.isArray(v) || !v.length)) throw new Error('The embeddings model returned an unexpected answer');
              for (const v of got) vecs.push(normalize(v));
            }
          } catch (e) {
            // The guard refused this page's text, or the model refuses this page (a 4xx about the request): leave it for later (longer each time) and carry on with the others.
            if (e instanceof ClassifiedRefused || (e instanceof ModelUnavailable && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 404 && e.status !== 408)) { noteRefused(r); res.refused = (res.refused ?? 0) + 1; continue; }
            throw e;
          }
          // The page may have changed while the model worked: write only what still matches its copy now (the next round sees the rest).
          if (!isCurrent(d, r)) continue;
          store.replacePage(r.world_id, r.id, scope, chunks.map((text, i) => ({ text, v: vecs[i] })), { updatedAt: r.updated_at, sig: r.sig, model, hash: r.hash });
          res.embedded += chunks.length;
          res.pages++;
          budget--;
          noteDone('embeddings', r.world_id);
          opts.onPage?.({ pages: res.pages, embedded: res.embedded, id: r.id, scope });
          // Between pages the event loop breathes: the model's answer and the write are the only waits otherwise.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    }
    res.remaining = ORDER.some((s) => pendingCopies(d, s, 'search_chunk_state', model, 1 + backedOffCount(), opts.worldId).some((r) => !isBackedOff(r)));
  } catch (e: any) {
    res.error = String(e?.message ?? e).slice(0, 200);
    res.remaining = true;
  }
  return res;
}

export type ScopeCount = { eligible: number; indexed: number; pending: number; chunks: number };

/** Per scope: pages that have this copy, pages whose chunks are current, pages waiting, and the chunk count. */
export function scopeCoverage(d: Deps, worldId: string, stateTable: 'search_chunk_state' | 'bible_state', model: string | null): Record<VecScope, ScopeCount> {
  return scopeAndPageCoverage(d, worldId, stateTable, model).scopes;
}

/** Per scope (copies) and in total (distinct pages), from one pass over the copies. */
export function scopeAndPageCoverage(d: Deps, worldId: string, stateTable: 'search_chunk_state' | 'bible_state', model: string | null) {
  const scopes = {} as Record<VecScope, ScopeCount>;
  const chunkCounts = vectorStore(d.db).counts(worldId);
  const eligibleSet = new Set<string>();
  const pendingSet = new Set<string>();
  for (const s of VEC_SCOPES) {
    const ids = eligibleIds(d, s, worldId);
    for (const id of ids) eligibleSet.add(id);
    const waiting = model ? pendingCopies(d, s, stateTable, model, 1_000_000, worldId) : ids.map((id) => ({ id }));
    for (const r of waiting) pendingSet.add(r.id);
    scopes[s] = { eligible: ids.length, pending: waiting.length, indexed: Math.max(0, ids.length - waiting.length), chunks: chunkCounts[s] };
  }
  const waitingPages = [...pendingSet].filter((id) => eligibleSet.has(id)).length;
  return { scopes, pages: { eligible: eligibleSet.size, pending: waitingPages, indexed: eligibleSet.size - waitingPages } };
}

/** How much of a world's library the embeddings model has read: pages with chunks, pages still waiting, and the chunks, in total and per scope. */
export function embeddingCoverage(d: Deps, worldId: string) {
  const cfg = jobConfig(d, 'extra');
  const stats = embeddingStats(d.db, worldId);
  const { scopes, pages } = scopeAndPageCoverage(d, worldId, 'search_chunk_state', cfg ? tagged(cfg.model) : null);
  return {
    configured: !!cfg, model: cfg?.model ?? null, location: cfg?.location ?? null, ...stats, scopes,
    // Distinct pages (a page with a DM copy and a party copy counts once); `scopes` counts copies, one scope at a time.
    pages: cfg ? pages : { eligible: 0, indexed: 0, pending: 0 },
    chunks: stats.dmChunks + stats.partyChunks + stats.brokerChunks + stats.liftedChunks,
    // "Indexing N of M": copies (a page counts once per copy it has), with an estimate from the recent pace.
    progress: progressOf(worldId, scopes),
  };
}

function progressOf(worldId: string, scopes: Record<VecScope, ScopeCount>) {
  let eligible = 0;
  let indexed = 0;
  for (const s of VEC_SCOPES) { eligible += scopes[s].eligible; indexed += scopes[s].indexed; }
  return progress('embeddings', worldId, eligible, indexed, { refused: backedOffCount() });
}

export function embeddingStats(db: DB, worldId: string) {
  const c = vectorStore(db).counts(worldId);
  return { dmChunks: c.dm, partyChunks: c.party, brokerChunks: c.broker, liftedChunks: c.lifted };
}

// ---- querying ----------------------------------------------------------------

export interface SemanticHit { id: string; sim: number; text: string }

/** Nearest chunks of the scopes a viewer reads: best chunk per page, filtered to pages the viewer may open now. */
export function nearestPages(d: Deps, worldId: string, reach: Reach, qv: Float32Array, limit: number, min: number): SemanticHit[] {
  const store = vectorStore(d.db);
  const best = new Map<string, SemanticHit>();
  for (const scope of reachScopes(reach)) {
    for (const r of store.rows(worldId, scope)) {
      if (r.v.length !== qv.length) continue;
      if (scope === 'lifted' && !reach.lifted.has(r.page)) continue;
      let dot = 0;
      for (let i = 0; i < qv.length; i++) dot += qv[i] * r.v[i];
      if (dot < min) continue;
      const prev = best.get(r.page);
      if (!prev || dot > prev.sim) best.set(r.page, { id: r.page, sim: dot, text: r.text });
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.sim - a.sim).slice(0, limit * 2);
  // Belt and braces: the page must still exist and still have the copy the viewer reads.
  const ok = openable(d.db, worldId, reach, ranked.map((r) => r.id));
  return ranked.filter((r) => ok.has(r.id)).slice(0, limit);
}

/**
 * Nearest chunks to the query, best chunk per page, for one viewer. Empty when
 * there is no embeddings model. Without a `viewer`, the scope alone decides
 * (never lifted pages).
 */
export async function semanticPages(d: Deps, worldId: string, scopeIn: Scope, q: string, limit = 20, viewer?: Viewer): Promise<SemanticHit[]> {
  if (!hasJob(d, 'extra')) return [];
  const reach = viewer ? reachOf(d, worldId, viewer) : reachOfScope(scopeIn);
  const got = await embed(d, [q.slice(0, 500)]);
  if (!got[0]?.length) return [];
  return nearestPages(d, worldId, reach, normalize(got[0]), limit, Number(d.env.ALX_SEARCH_MIN_SIM ?? 0.2));
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
 * Pass the `viewer` so a player's own lifted pages (key, grant, share) count.
 */
export async function hybridPages(d: Deps, worldId: string, q: string, scope: Scope, limit = 20, viewer?: Viewer): Promise<PageHit[]> {
  // The optional rerank job reorders the top 20 within 300 ms; slower or failing, the order below stands.
  // The text it reads is the hit's own title and snippet, taken from this viewer's copy of the page.
  if (!hasJob(d, 'rerank')) return hybridBase(d, worldId, q, scope, limit, viewer);
  const hits = await hybridBase(d, worldId, q, scope, Math.max(limit, 20), viewer);
  return (await rerankItems(d, q, hits, (h) => `${h.title}\n${h.snippet}`)).slice(0, limit);
}

async function hybridBase(d: Deps, worldId: string, q: string, scope: Scope, limit: number, viewer?: Viewer): Promise<PageHit[]> {
  const kwViewer: Viewer = viewer ?? (scope === 'party' ? { accountId: '', role: 'player' } : { accountId: '', role: 'dm', ...(scope === 'ai' ? { audience: 'ai' as const } : scope === 'broker' ? { audience: 'broker' as const } : {}) });
  const kw = d.library.search(worldId, q, kwViewer, Math.max(limit, 30)) as PageHit[];
  if (!hasJob(d, 'extra') || !parseQuery(q).pos.length) return kw.slice(0, limit);
  let sem: SemanticHit[] = [];
  try { sem = await semanticPages(d, worldId, scope, q, Math.max(limit, 30), kwViewer); } catch { return kw.slice(0, limit); }
  if (!sem.length) return kw.slice(0, limit);
  const fused = rrf([kw.map((h) => h.id), sem.map((s) => s.id)]);
  const byId = new Map(kw.map((h) => [h.id, h]));
  const pq: ParsedQuery = parseQuery(q);
  const missing = sem.filter((s) => !byId.has(s.id));
  if (missing.length) {
    // The semantic side already limited itself to pages this viewer may open; the rows here are read for their title and path only.
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
