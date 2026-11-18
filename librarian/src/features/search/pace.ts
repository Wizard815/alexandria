// How fast background reading (embeddings, story bible facts) is going, so the
// Models card and the Story bible can say "indexing 12 of 58, about 3 minutes
// left". Kept in memory: after a restart the estimate is empty until a few
// pages have been read again.
const doneAt = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;

/** One page was read. `job` is "embeddings" or "bible". */
export function noteDone(job: string, worldId: string, at = Date.now()) {
  const k = `${job}|${worldId}`;
  const list = doneAt.get(k) ?? [];
  list.push(at);
  while (list.length > 40 || (list.length && list[0]! < at - WINDOW_MS)) list.shift();
  doneAt.set(k, list);
}

/** Pages per minute over the last ten minutes, or null when too few pages were read lately to say. */
export function pagesPerMinute(job: string, worldId: string, at = Date.now()): number | null {
  const list = (doneAt.get(`${job}|${worldId}`) ?? []).filter((t) => t > at - WINDOW_MS);
  if (list.length < 3) return null;
  const span = Math.max(1000, list[list.length - 1]! - list[0]!);
  return ((list.length - 1) / span) * 60_000;
}

/** "Indexing N of M": the counts, the pace and a rough time left. */
export function progress(job: string, worldId: string, eligible: number, indexed: number, extra: Record<string, unknown> = {}) {
  const pending = Math.max(0, eligible - indexed);
  const rate = pagesPerMinute(job, worldId);
  return { eligible, indexed, pending, perMinute: rate === null ? null : Math.round(rate * 10) / 10, etaSeconds: pending > 0 && rate ? Math.ceil((pending / rate) * 60) : null, ...extra };
}
