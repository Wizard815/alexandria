// Is the server reachable? One shared state for the whole app.
// It goes offline when a request can't reach the server, the browser says
// it's offline, or live updates drop and a health check fails. While
// offline the app is read-only: the client refuses writes and serves
// cached reads. A health check every few seconds brings it back, and
// screens reload when it does.
import { useSyncExternalStore } from 'react';
import type { NetHooks } from '@alx/client';

export interface NetState {
  online: boolean;
  /** When the server last answered (this account, this browser). */
  lastOnline: string | null;
  /** The oldest cached copy shown since going offline. */
  servedSince: string | null;
  /** Background "save for offline" progress for the open world. */
  prefetch: { done: number; total: number; label: string } | null;
}

const LAST_KEY = 'alx.lastOnline';
function readLast(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

let state: NetState = { online: typeof navigator === 'undefined' ? true : navigator.onLine !== false, lastOnline: readLast(), servedSince: null, prefetch: null };
const subs = new Set<() => void>();
const reconnectSubs = new Set<() => void>();
let probe: ReturnType<typeof setInterval> | undefined;
let lastWrite = 0;

function set(patch: Partial<NetState>) {
  state = { ...state, ...patch };
  for (const s of subs) s();
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

function startProbe() {
  if (probe) return;
  probe = setInterval(() => { void check(); }, 5000);
}

function goOffline() {
  if (state.online) set({ online: false });
  startProbe();
}

function goOnline() {
  const was = state.online;
  const now = new Date().toISOString();
  // Writing the timestamp on every request would be wasteful.
  if (Date.now() - lastWrite > 10_000) {
    lastWrite = Date.now();
    try { localStorage.setItem(LAST_KEY, now); } catch { /* ignore */ }
  }
  if (!was || Date.now() - Date.parse(state.lastOnline ?? '0') > 10_000) set({ online: true, lastOnline: now, servedSince: was ? state.servedSince : null });
  if (probe) { clearInterval(probe); probe = undefined; }
  if (!was) for (const f of reconnectSubs) f();
}

/** Ask the server now; flips the state either way. */
export async function check(): Promise<boolean> {
  const ok = await healthy();
  if (ok) goOnline(); else goOffline();
  return ok;
}

export const netHooks: NetHooks = {
  offline: () => !state.online,
  failed: goOffline,
  ok: goOnline,
  served: (savedAt) => {
    if (!state.servedSince || savedAt < state.servedSince) set({ servedSince: savedAt });
  },
};

export function isOffline() { return !state.online; }

export function setPrefetch(p: NetState['prefetch']) { set({ prefetch: p }); }

/** Run fn when the server comes back after being unreachable. */
export function onReconnect(fn: () => void): () => void {
  reconnectSubs.add(fn);
  return () => { reconnectSubs.delete(fn); };
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', goOffline);
  window.addEventListener('online', () => { void check(); });
  if (!state.online) startProbe();
}

export function useNet(): NetState {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => state, () => state);
}

export function sinceText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `on ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
