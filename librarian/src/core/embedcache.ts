// Vectors of fixed texts (the tools' descriptions, the labelled example questions) are made once and kept in the database, by the hash of the model
// and the text: a restart, or a second server process, does not ask the embeddings model for them again. Only for texts that do not change per
// request; never for page text (that has its own state, features/search) or anything a person typed.
import { createHash } from 'node:crypto';
import type { Deps } from '../app.ts';
import { embed, jobConfig } from './ai.ts';
import { all, run } from './db.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS embed_cache (
  hash TEXT PRIMARY KEY,
  dims INTEGER NOT NULL,
  vec BLOB NOT NULL,
  at TEXT NOT NULL
);`;
const ready = new WeakSet<object>();

const keyOf = (model: string, text: string) => createHash('sha1').update(`${model}\n${text}`).digest('hex');
const toBlob = (v: number[]) => new Uint8Array(Float32Array.from(v).buffer);
const fromBlob = (b: Uint8Array, dims: number): number[] => { const c = new Uint8Array(b.byteLength); c.set(b); return Array.from(new Float32Array(c.buffer, 0, dims)); };

/** embed(), for fixed texts: the ones already made (by this model) are read from the database, the rest are asked for in one batch and kept. */
export async function embedCached(d: Deps, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const model = jobConfig(d, 'extra')?.model ?? '';
  try { if (!ready.has(d.db)) { d.db.exec(SCHEMA); ready.add(d.db); } } catch { return embed(d, texts, signal); }
  const keys = texts.map((t) => keyOf(model, t));
  const have = new Map<string, number[]>();
  try {
    for (let i = 0; i < keys.length; i += 400) {
      const part = keys.slice(i, i + 400);
      for (const r of all<any>(d.db, `SELECT hash, dims, vec FROM embed_cache WHERE hash IN (${part.map(() => '?').join(',')})`, ...part)) have.set(r.hash, fromBlob(r.vec, Number(r.dims)));
    }
  } catch { /* read what can be read */ }
  const missing = [...new Set(keys.filter((k) => !have.has(k)))];
  if (missing.length) {
    const textOf = new Map(keys.map((k, i) => [k, texts[i]]));
    const got = await embed(d, missing.map((k) => textOf.get(k)!), signal);
    if (got.length === missing.length) {
      missing.forEach((k, i) => {
        if (!Array.isArray(got[i]) || !got[i].length) return;
        have.set(k, got[i]);
        try { run(d.db, 'INSERT OR REPLACE INTO embed_cache (hash, dims, vec, at) VALUES (?, ?, ?, ?)', k, got[i].length, toBlob(got[i]), new Date().toISOString()); } catch { /* kept in memory only */ }
      });
    } else return embed(d, texts, signal);
  }
  return keys.map((k) => have.get(k) ?? []);
}
