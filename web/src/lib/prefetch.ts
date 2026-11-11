// Keep a copy of the open world on this device, so it can be read with no
// connection. Every GET the client makes is cached already; this walks the
// world's main screens in the background, then fetches every library page
// the viewer can see (the server sends players only the player copy).
// Unchanged pages are skipped; throttled so it never competes with the UI.
import type { WorldClient } from '@alx/client';
import { responseCache } from './offline.ts';
import { isOffline, setPrefetch } from './net.ts';

const CHUNK = 50;
const PAUSE = 250;
const FULL_REFRESH_MS = 24 * 3600_000;
const running = new Map<string, Promise<void>>();

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
});

/** Screens to keep, as the screens themselves ask for them (same cache keys). */
function lists(w: WorldClient, role: string, worldId: string): (() => Promise<unknown>)[] {
  const dm = role === 'dm';
  let maps = ['world'];
  try { const m = JSON.parse(localStorage.getItem(`alx.maps.${worldId}`) ?? '[]'); if (Array.isArray(m) && m.length) maps = m.map(String); } catch { /* default */ }
  const get = (p: string) => () => w.call('GET', p);
  return [
    () => w.info(), () => w.members(), () => w.relations(), () => w.requests(),
    () => w.threads(), () => w.quickEvents(), () => w.calendar(), () => w.people(), () => w.profile('me'),
    () => w.whiteboard(), () => w.live(), () => w.coin('me'), () => w.coin('party'),
    () => w.inventory('me'), () => w.inventory('party'),
    get('/broker'), get('/broker/config'), get('/broker/offers'),
    get('/inventory/transfers'), get('/inventory/coin-requests'),
    ...(dm ? [get('/broker/notes'), get('/broker/rules'), get('/approvals'), () => w.settings(), () => w.combat()] : [get('/approvals/mine')]),
    ...maps.map((m) => () => w.marks(m)),
  ];
}

export function prefetchWorld(w: WorldClient, role: string, signal: AbortSignal, worldId = w.id): Promise<void> {
  const c = w.client;
  const id = `${c.cacheScope}|${w.id}`;
  if (!c.cacheScope || !c.cache || role === 'guest') return Promise.resolve();
  const busy = running.get(id);
  if (busy) return busy;
  const job = run(w, role, signal, worldId).finally(() => { running.delete(id); setPrefetch(null); });
  running.set(id, job);
  return job;
}

async function run(w: WorldClient, role: string, signal: AbortSignal, worldId: string) {
  const c = w.client;
  const scope = c.cacheScope;
  const stillMine = () => !signal.aborted && !isOffline() && c.cacheScope === scope;

  // 1. The world's screens. Errors (a screen this role can't open) are fine.
  let pages: { id: string; updated_at?: string }[] = [];
  try { pages = await w.pages(); } catch { return; }
  for (const load of lists(w, role, worldId)) {
    if (!stillMine()) return;
    try { await load(); } catch { /* not for this role, or offline */ }
    await sleep(60, signal);
  }

  // 2. Library pages: only new, changed or old copies.
  const keyOf = (pid: string) => c.cacheKey(w.path(`/library/pages/${encodeURIComponent(pid)}`));
  const need: string[] = [];
  for (const p of pages) {
    const k = keyOf(p.id);
    if (!k) return;
    const hit = await responseCache.get(k);
    const v = hit?.value as { updated_at?: string } | undefined;
    const fresh = hit && v?.updated_at === p.updated_at && Date.now() - Date.parse(hit.savedAt) < FULL_REFRESH_MS;
    if (!fresh) need.push(p.id);
  }
  const total = pages.length;
  let done = total - need.length;
  if (!need.length) return;
  setPrefetch({ done, total, label: 'pages' });
  for (let i = 0; i < need.length; i += CHUNK) {
    if (!stillMine()) return;
    const ids = need.slice(i, i + CHUNK);
    try {
      const got = await w.call<any[]>('POST', '/library/pages/bulk', { ids });
      if (c.cacheScope !== scope) return; // signed out meanwhile: drop it
      const rows: [string, unknown][] = [];
      for (const pg of got ?? []) { const k = keyOf(pg.id); if (k) rows.push([k, pg]); }
      await responseCache.putMany(rows);
    } catch { return; }
    done += ids.length;
    setPrefetch({ done, total, label: 'pages' });
    await sleep(PAUSE, signal);
  }
}
