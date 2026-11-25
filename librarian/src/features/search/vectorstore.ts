// Where chunk vectors live. Today: SQLite (search_chunks), brute-force cosine in
// memory. The interface is small on purpose so another backend (a vector
// database service) can be added later without touching the callers: they only
// ask for the rows of one (world, scope) and write one page at a time.
//
// Permissions are not this layer's job: callers pick the scopes (scopes.ts) and
// check hits against the pages table.
import { type DB, all, one, run, tx } from '../../core/db.ts';
import type { VecScope } from './scopes.ts';

export interface VectorRow { page: string; idx: number; text: string; v: Float32Array }
export interface PageState { updatedAt: string; sig: number; model: string; hash: string | null }

export interface VectorStore {
  /** Every vector of one scope of one world (cached until the rows change). */
  rows(worldId: string, scope: VecScope): VectorRow[];
  /** Replace all of a page's vectors in one scope, and record what they were made from. */
  replacePage(worldId: string, pageId: string, scope: VecScope, chunks: { text: string; v: Float32Array }[], state: PageState): void;
  /** Delete a page's vectors (one scope, or every scope). */
  deletePage(pageId: string, scope?: VecScope): void;
  /** Delete every vector of a world (re-embed). */
  deleteWorld(worldId: string): void;
  counts(worldId: string): Record<VecScope, number>;
}

export const normalize = (v: number[]): Float32Array => {
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
export { toBlob, fromBlob };

class SqliteVectorStore implements VectorStore {
  db: DB;
  cache = new Map<string, { stamp: string; n: number; max: number; sum: number; rows: VectorRow[] }>();
  constructor(db: DB) { this.db = db; }

  rows(worldId: string, scope: VecScope): VectorRow[] {
    const st = one<any>(this.db, 'SELECT count(*) AS n, coalesce(max(id), 0) AS m, coalesce(sum(id), 0) AS s FROM search_chunks WHERE world_id = ? AND scope = ?', worldId, scope)!;
    const n = Number(st.n), max = Number(st.m), sum = Number(st.s);
    const key = `${worldId}|${scope}`;
    const hit = this.cache.get(key);
    if (hit && hit.n === n && hit.max === max && hit.sum === sum) return hit.rows;
    // Only rows that have a state row: chunks cut under an older level scheme or left without state are never read.
    const select = `SELECT c.id, c.page_id, c.idx, c.text, c.vec FROM search_chunks c JOIN search_chunk_state s ON s.page_id = c.page_id AND s.scope = c.scope
      WHERE c.world_id = ? AND c.scope = ? ${scope === 'dm' ? "AND s.model LIKE '%|lv1'" : ''}`;
    const toRow = (r: any): VectorRow & { id: number } => ({ id: Number(r.id), page: r.page_id as string, idx: Number(r.idx), text: r.text as string, v: fromBlob(r.vec) });
    // While pages are being embedded the rows only grow: read just the new ones (ids above the newest held) and check the totals add up.
    // Anything else (a page re-embedded, rows deleted) reads the scope again.
    if (hit && hit.rows.length && max > hit.max && n >= hit.n) {
      const added = all<any>(this.db, `${select} AND c.id > ? ORDER BY c.page_id, c.idx`, worldId, scope, hit.max).map(toRow);
      const addedSum = added.reduce((a, r) => a + r.id, 0);
      if (n === hit.n + added.length && sum === hit.sum + addedSum) {
        const rows = hit.rows.concat(added);
        this.cache.set(key, { stamp: '', n, max, sum, rows });
        return rows;
      }
    }
    const rows = all<any>(this.db, `${select} ORDER BY c.page_id, c.idx`, worldId, scope).map(toRow);
    this.cache.set(key, { stamp: '', n, max, sum, rows });
    return rows;
  }

  replacePage(worldId: string, pageId: string, scope: VecScope, chunks: { text: string; v: Float32Array }[], st: PageState) {
    tx(this.db, () => {
      run(this.db, 'DELETE FROM search_chunks WHERE page_id = ? AND scope = ?', pageId, scope);
      chunks.forEach((c, i) => run(this.db, 'INSERT INTO search_chunks (world_id, page_id, scope, idx, text, vec) VALUES (?, ?, ?, ?, ?, ?)', worldId, pageId, scope, i, c.text, toBlob(c.v)));
      run(this.db, `INSERT INTO search_chunk_state (page_id, scope, world_id, updated_at, sig, model, hash) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (page_id, scope) DO UPDATE SET updated_at = excluded.updated_at, sig = excluded.sig, model = excluded.model, world_id = excluded.world_id, hash = excluded.hash`, pageId, scope, worldId, st.updatedAt, st.sig, st.model, st.hash);
    });
  }

  deletePage(pageId: string, scope?: VecScope) {
    tx(this.db, () => {
      run(this.db, `DELETE FROM search_chunks WHERE page_id = ? ${scope ? 'AND scope = ?' : ''}`, pageId, ...(scope ? [scope] : []));
      run(this.db, `DELETE FROM search_chunk_state WHERE page_id = ? ${scope ? 'AND scope = ?' : ''}`, pageId, ...(scope ? [scope] : []));
    });
  }

  deleteWorld(worldId: string) {
    tx(this.db, () => {
      run(this.db, 'DELETE FROM search_chunks WHERE world_id = ?', worldId);
      run(this.db, 'DELETE FROM search_chunk_state WHERE world_id = ?', worldId);
    });
  }

  counts(worldId: string): Record<VecScope, number> {
    const out: Record<VecScope, number> = { dm: 0, broker: 0, party: 0, lifted: 0 };
    for (const r of all<any>(this.db, 'SELECT scope, count(*) AS n FROM search_chunks WHERE world_id = ? GROUP BY scope', worldId)) if (r.scope in out) out[r.scope as VecScope] = Number(r.n);
    return out;
  }
}

const stores = new WeakMap<DB, VectorStore>();
/** The vector store of a database. */
export function vectorStore(db: DB): VectorStore {
  let s = stores.get(db);
  if (!s) { s = new SqliteVectorStore(db); stores.set(db, s); }
  return s;
}

/** Forget the vectors held in memory (they are read again from the database when next needed): for a memory squeeze. */
export function dropVectorCaches(db: DB) {
  const s = stores.get(db) as SqliteVectorStore | undefined;
  s?.cache.clear();
}
