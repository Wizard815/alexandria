// The app builds this server hosts, and the app's own update events.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import type { Builds, Ticket } from '../../lib/nativeApp.ts';

export function useBuilds() {
  const { client } = useAuth();
  const [data, setData] = useState<Builds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await client.request<Builds>('GET', '/api/apps/builds')); setError(null); } catch (e: any) { setError(e.message ?? String(e)); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  const ticket = useCallback((file: string) => client.request<Ticket>('POST', `/api/apps/builds/${encodeURIComponent(file)}/ticket`), [client]);
  return { data, error, reload: load, ticket };
}

export interface UpdateEvent { state: string; message: string }
/** What the app says while it downloads and installs (desktop/src-tauri/src/update.rs, AppUpdater.kt). */
export function useUpdateEvents() {
  const [ev, setEv] = useState<UpdateEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => setEv((e as CustomEvent<UpdateEvent>).detail);
    window.addEventListener('alexandria-update', on);
    return () => window.removeEventListener('alexandria-update', on);
  }, []);
  return ev;
}

export const sizeText = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
export const PLATFORM_NAMES: Record<string, string> = { android: 'Android', windows: 'Windows', macos: 'macOS', linux: 'Linux' };
