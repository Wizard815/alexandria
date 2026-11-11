// Signed-in state. The session token lives in localStorage so a reload
// keeps you signed in; signing out deletes it on the server too.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlexandriaClient, AlexandriaError } from '@alx/client';
import { responseCache, clearAccount } from './offline.ts';
import { netHooks } from './net.ts';

export interface Me {
  account: { id: string; username: string; display_name: string; is_admin: boolean };
  theme: { race?: string; mode?: 'dark' | 'light'; effects?: boolean } | null;
  worlds: { id: string; slug: string; name: string; role: 'dm' | 'player' | 'guest'; character_name: string | null }[];
}

interface AuthState {
  client: AlexandriaClient;
  me: Me | null;
  ready: boolean;
  needsSetup: boolean;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const KEY = 'alx.token';
// The account the stored token belongs to: the offline cache is kept per
// account, so another person signing in on this browser never sees it.
const ACCOUNT = 'alx.account';
const Ctx = createContext<AuthState | null>(null);

function storedToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
function storedAccount(): string | null {
  try { return localStorage.getItem(ACCOUNT); } catch { return null; }
}
const unreachable = (e: unknown) => e instanceof AlexandriaError && e.status === 0;

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const c = new AlexandriaClient({ baseUrl: window.location.origin, token: storedToken(), cache: responseCache, net: netHooks });
    c.cacheScope = c.token ? storedAccount() : null;
    return c;
  }, []);
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Set needsSetup together with me (below), so no screen sees "setup
      // done" with nobody signed in and bounces to /login in between.
      let setup: boolean | null = null;
      try { setup = (await client.needsSetup()).needsSetup; } catch (e) { if (!unreachable(e)) throw e; }
      if (client.token) {
        const m = (await client.me()) as Me;
        if (client.cacheScope !== m.account.id) {
          // First load for this token: start this account's cache now.
          client.cacheScope = m.account.id;
          try { localStorage.setItem(ACCOUNT, m.account.id); } catch { /* ignore */ }
          const key = client.cacheKey('/api/me');
          if (key) void responseCache.put(key, m);
        }
        if (setup !== null) setNeedsSetup(setup);
        setMe(m);
      } else {
        if (setup !== null) setNeedsSetup(setup);
        setMe(null);
      }
    } catch (e) {
      // Offline with nothing cached: keep the token and try again later.
      if (!unreachable(e)) {
        client.token = null;
        client.cacheScope = null;
        try { localStorage.removeItem(KEY); localStorage.removeItem(ACCOUNT); } catch { /* ignore */ }
      }
      setMe(null);
    } finally {
      setReady(true);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (token: string) => {
    client.token = token;
    client.cacheScope = null; // set once /api/me says whose token this is
    try { localStorage.setItem(KEY, token); localStorage.removeItem(ACCOUNT); } catch { /* ignore */ }
    await refresh();
  }, [client, refresh]);

  const signOut = useCallback(async () => {
    const account = client.cacheScope;
    try { await client.logout(); } catch { /* already gone, or offline */ }
    client.token = null;
    client.cacheScope = null;
    try { localStorage.removeItem(KEY); localStorage.removeItem(ACCOUNT); } catch { /* ignore */ }
    if (account) await clearAccount(account);
    setMe(null);
  }, [client]);

  return <Ctx.Provider value={{ client, me, ready, needsSetup, signIn, signOut, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
