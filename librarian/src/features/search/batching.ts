// How big and how wide the background readers go: the embeddings job packs the
// chunks of many pages into one request and keeps several requests in flight,
// and the story bible reads several pages at once. A first import of a whole
// world is then one fast pass instead of a trickle over hours.
//
//   ALX_EMBED_BATCH     chunks per embeddings request (default 64, 1 to 1024)
//   ALX_EMBED_PARALLEL  embeddings requests in flight (default: the model's maxConcurrent)
//   ALX_BIBLE_PARALLEL  pages the story bible reads at once (default: the model's maxConcurrent)
//
// The model queue (core/ai.ts, the job option maxConcurrent) still has the last
// word: asking for more at once than a model takes only queues the rest there,
// and the table's own requests still go first.
import type { Deps } from '../../app.ts';
import { type Job, gateFor, jobConfig } from '../../core/ai.ts';

const num = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : def;
};

/** Chunks (or facts) sent in one embeddings request. */
export const embedBatch = (d: Deps): number => num(d.env.ALX_EMBED_BATCH, 64, 1, 1024);

/** How many requests to keep in flight for a job: the env override, else what its model's queue takes at once. */
export function parallelFor(d: Deps, job: Job, envKey: string): number {
  const cfg = jobConfig(d, job);
  const gate = cfg ? gateFor(cfg).max : 1;
  return num(d.env[envKey], gate, 1, 64);
}

/**
 * Run `work` on `n` workers. Each worker asks `next` for its next item and ends
 * when there is none or `stop()` says so. The first error thrown by `work`
 * stops every worker and is thrown again once they have all ended.
 */
export async function pool<T>(n: number, next: () => T | null, work: (item: T) => Promise<void>, stop: () => boolean = () => false): Promise<void> {
  let failed: { err: unknown } | null = null;
  const worker = async () => {
    while (!failed && !stop()) {
      const item = next();
      if (item === null) return;
      try { await work(item); } catch (err) { failed ??= { err }; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, n) }, worker));
  if (failed) throw (failed as { err: unknown }).err;
}
