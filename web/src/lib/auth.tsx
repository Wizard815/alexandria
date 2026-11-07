// Signed-in state. The session token lives in localStorage so a reload
// keeps you signed in; signing out deletes it on the server too.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlexandriaClient } from '@alx/client';

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
const Ctx = createContext<AuthState | null>(null);

function storedToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useMemo(() => new AlexandriaClient({ baseUrl: window.location.origin, token: storedToken() }), []);
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setNeedsSetup((await client.needsSetup()).needsSetup);
      if (client.token) setMe((await client.me()) as Me);
      else setMe(null);
    } catch {
      client.token = null;
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      setMe(null);
    } finally {
      setReady(true);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback(async (token: string) => {
    client.token = token;
    try { localStorage.setItem(KEY, token); } catch { /* ignore */ }
    await refresh();
  }, [client, refresh]);

  const signOut = useCallback(async () => {
    try { await client.logout(); } catch { /* already gone */ }
    client.token = null;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    setMe(null);
  }, [client]);

  return <Ctx.Provider value={{ client, me, ready, needsSetup, signIn, signOut, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
