// Giving the event loop back during long work, so a request is never stuck behind a crawl.

/** Wait one turn of the event loop (pending requests and timers run first). */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A time slice: `await slice.maybe()` inside a loop gives the loop back once the slice has been used,
 * so the loop does a few milliseconds of work at a time whatever the size of the job.
 */
export class Slice {
  private start = performance.now();
  ms: number;
  constructor(ms = 20) { this.ms = ms; }
  /** Has the slice been used up? */
  get over(): boolean { return performance.now() - this.start >= this.ms; }
  /** Yield when the slice is used up, and start the next one. True when it yielded. */
  async maybe(): Promise<boolean> {
    if (!this.over) return false;
    await tick();
    this.start = performance.now();
    return true;
  }
}

/** Run `fn` over `items`, giving the loop back every `ms` milliseconds. Stops early when `signal` aborts. */
export async function eachSliced<T>(items: Iterable<T>, fn: (item: T, index: number) => void | Promise<void>, opts: { ms?: number; signal?: AbortSignal } = {}): Promise<void> {
  const slice = new Slice(opts.ms ?? 20);
  let i = 0;
  for (const item of items) {
    if (opts.signal?.aborted) return;
    await fn(item, i++);
    await slice.maybe();
  }
}
