// One world: its client, your role, its settings, and live updates.
// useLoad() re-fetches when one of the named live events arrives, so every
// screen stays current without polling.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { WorldClient, LiveEvent } from '@alx/client';
import { useAuth } from './auth.tsx';

export type Role = 'dm' | 'player' | 'guest';

export interface WorldSettings {
  trackWeight: boolean; coins: 'gsc' | 'all' | 'gold'; partyPurse: boolean; dmEditsInventory: boolean;
  monsterHealth: 'none' | 'words' | 'bar' | 'exact'; initiativeVisible: boolean;
  mapPins: boolean; mapDraw: boolean; mapStops: boolean; whiteboardWipe: 'dm' | 'all';
  messageDays: number | null; captions: boolean; rules: string; requestDefault: 'dm' | 'party';
  quickEventTimer: number | null; themeEffects: boolean; calendar: 'builtin' | 'off';
  playerChangesNeedApproval?: boolean; dmChangeReason?: boolean; brokerEnabled?: boolean; brokerPayer?: 'self' | 'party';
}

export interface WorldInfo { id: string; slug: string; name: string; role: Role; settings: WorldSettings }
export interface Member { id: string; display_name: string; role: Role; character_name: string | null }

interface WorldState {
  w: WorldClient;
  info: WorldInfo;
  members: Member[];
  me: string;
  isDM: boolean;
  /** Display name for an account id: character name first. */
  nameOf: (accountId: string | null | undefined) => string;
  on: (types: string[], fn: (e: LiveEvent) => void) => () => void;
  reloadInfo: () => Promise<void>;
  connected: boolean;
}

const Ctx = createContext<WorldState | null>(null);

export function WorldProvider({ children }: { children: ReactNode }) {
  const { world = '' } = useParams();
  const { client, me } = useAuth();
  const w = useMemo(() => client.world(world), [client, world]);
  const [info, setInfo] = useState<WorldInfo | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<{ types: string[]; fn: (e: LiveEvent) => void }>());

  const reloadInfo = useCallback(async () => {
    try {
      const [i, m] = await Promise.all([w.info(), w.members()]);
      setInfo(i as WorldInfo);
      setMembers(m as Member[]);
    } catch (e: any) {
      setError(e.message);
    }
  }, [w]);

  useEffect(() => { void reloadInfo(); }, [reloadInfo]);

  useEffect(() => {
    let stop = () => {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const start = () => {
      setConnected(true);
      stop = w.subscribe(
        (e) => {
          if (e.type === 'settings') setInfo((i) => (i ? { ...i, settings: e.data } : i));
          for (const l of listeners.current) if (l.types.includes(e.type) || l.types.includes('*')) l.fn(e);
        },
        () => {
          setConnected(false);
          if (alive) retry = setTimeout(start, 3000);
        },
      );
    };
    start();
    return () => { alive = false; clearTimeout(retry); stop(); };
  }, [w]);

  const on = useCallback((types: string[], fn: (e: LiveEvent) => void) => {
    const l = { types, fn };
    listeners.current.add(l);
    return () => { listeners.current.delete(l); };
  }, []);

  const nameOf = useCallback((id: string | null | undefined) => {
    if (!id) return '';
    const m = members.find((x) => x.id === id);
    return m ? m.character_name || m.display_name : 'Someone';
  }, [members]);

  if (error) return <div className="page"><div className="error-box">This world could not be opened: {error}</div></div>;
  if (!info || !me) return <div className="page"><p className="muted">Opening the world…</p></div>;
  return (
    <Ctx.Provider value={{ w, info, members, me: me.account.id, isDM: info.role === 'dm', nameOf, on, reloadInfo, connected }}>
      {children}
    </Ctx.Provider>
  );
}

export function useWorld() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorld outside WorldProvider');
  return v;
}

/**
 * Load data and keep it fresh. `events` are live event types that trigger a
 * reload (debounced), e.g. ['message', 'thread'].
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], events: string[] = []) {
  const ctx = useContext(Ctx);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(true); void reload(); }, deps);

  useEffect(() => {
    if (!ctx || !events.length) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = ctx.on(events, () => {
      clearTimeout(t);
      t = setTimeout(() => void reload(), 150);
    });
    return () => { clearTimeout(t); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, events.join(','), reload]);

  return { data, error, loading, reload, setData };
}
