// What the gateway status pages read (/api/admin/gwstatus/*) and small formatters. The numbers refresh every few seconds while a page is open.
import { useEffect, useRef } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';

export type Health = 'ok' | 'slow' | 'failing' | 'throttled' | 'idle';

export interface ConnStatus {
  id: string; connectionId: string | null; sourceId: string | null; name: string; kind: string; connector: string; sources: number; worlds: number;
  health: Health; callsToday: number; callsThisHour: number; callsLastHour: number; errorsToday: number; avgMs: number | null;
  series: { hour: string; calls: number; errors: number }[];
  lastCallAt: string | null; lastSuccessAt: string | null; lastError: { at: string; message: string } | null;
  rate: {
    perMinute: number; perMinuteInEffect: number; perSecond: number; usedLastMinute: number;
    waiting: { ms: number; until: string; reason: 'asked' | 'limit' | 'pace' } | null;
    lastRetryAfterSec: number | null; remaining: number | null; siteLimit: number | null;
  };
}

export interface MirrorWorld {
  id: string; name: string; slug: string; view: 'gm' | 'counts'; folder: string | null; exists: boolean; pages: number; shared: number;
  copies: Record<'vault' | 'party' | 'api', { files: number; bytes: number }>;
  lastWrittenAt: string | null; failures: number;
  failed: { copy: string; path: string; error: string; at: string; attempts: number }[] | null;
}
export interface Mirror { enabled: boolean; worlds: MirrorWorld[]; totals: { files: number; bytes: number; failures: number } }

export interface FileRow { id: string; name: string | null; kind: string; size: number; at: string; level: string; hidden: boolean }
export interface SourceFilesWorld {
  id: string; name: string; view: 'gm' | 'counts';
  sources: { id: string; name: string; kind: string; connector: string; enabled: boolean; lastSyncAt: string | null; lastStatus: string | null; lastFetchedAt: string | null; canSync: boolean; count: number; bytes: number; byKind: { kind: string; count: number }[]; hiddenCount: number; files: FileRow[]; truncated: boolean }[];
  library: { count: number; bytes: number; files: FileRow[]; truncated: boolean; hiddenCount: number };
}
export interface SourceFiles { totals: { pictures: { count: number; bytes: number }; libraryFiles: { count: number; bytes: number; onDiskBytes: number }; bytes: number }; worlds: SourceFilesWorld[] }

export interface SearchStats {
  days: number; since: string; retentionDays: number;
  totals: { searches: number; nothing: number; hiddenQueries: number };
  worlds: { id: string; name: string; view: 'gm' | 'counts'; searches: number; nothing: number }[];
  popular: { world: { id: string; name: string }; q: string; count: number; lastAt: string; avgResults: number }[];
  nothing: { world: { id: string; name: string }; q: string; count: number; lastAt: string; drafted: boolean }[];
  bySource: { name: string; count: number }[]; byOrigin: { origin: string; count: number }[]; byDay: { day: string; searches: number; nothing: number }[];
}

/** A load that asks again every `every` ms while the tab is showing. */
export function usePolled<T>(path: string, every = 10_000) {
  const { client } = useAuth();
  const q = useLoad(() => client.request<T>('GET', `/api/admin/gwstatus${path}`), [path]);
  const reload = useRef(q.reload);
  reload.current = q.reload;
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void reload.current(); }, every);
    return () => clearInterval(t);
  }, [every]);
  return q;
}

export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172_800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};

export const bytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
};

export const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
