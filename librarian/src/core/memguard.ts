// A memory guard. A server that runs out of memory is killed (by V8, or by Docker's OOM killer) and starts again from nothing: "the server went
// offline and took a while to boot back". This watches the heap and acts before that:
//
//   over 80% of the limit   free what can be made again (the caches of the library and the vector rows) and hold background work back
//   over 92% of the limit   stop the running jobs that can be stopped (a crawl, a sync): what they saved stays, and they can be started again
//
// The limit is ALX_MEMORY_MB, else V8's heap limit (NODE_OPTIONS=--max-old-space-size, which the Dockerfile sets).
import v8 from 'node:v8';
import type { Deps } from '../app.ts';
import { dropVectorCaches } from '../features/search/vectorstore.ts';

export interface MemoryState { usedMb: number; limitMb: number; ratio: number; level: 'ok' | 'high' | 'critical' }

export function memoryState(env: Record<string, string | undefined> = process.env): MemoryState {
  const limitMb = Number(env.ALX_MEMORY_MB) > 0 ? Number(env.ALX_MEMORY_MB) : v8.getHeapStatistics().heap_size_limit / 1048576;
  const usedMb = process.memoryUsage().heapUsed / 1048576;
  const ratio = usedMb / limitMb;
  return { usedMb: Math.round(usedMb), limitMb: Math.round(limitMb), ratio, level: ratio > 0.92 ? 'critical' : ratio > 0.8 ? 'high' : 'ok' };
}

export function startMemoryGuard(d: Deps, everyMs = 15_000) {
  let lastLog = 0;
  const check = () => {
    const m = memoryState(d.env);
    d.jobs.pressure = m.level !== 'ok';
    if (m.level === 'ok') return m;
    d.library.dropCaches();
    dropVectorCaches(d.db);
    if (m.level === 'critical') {
      for (const j of d.jobs.list()) if (j.status === 'running' && j.cancellable) d.jobs.cancel(j.id);
    }
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      console.warn(`Memory is ${m.level}: ${m.usedMb} of ${m.limitMb} MB in use${m.level === 'critical' ? '; the running jobs were stopped (start them again from the admin page)' : '; caches were dropped and background work is held back'}`);
    }
    return m;
  };
  const t = setInterval(check, everyMs);
  t.unref();
  return { stop: () => clearInterval(t), check };
}
