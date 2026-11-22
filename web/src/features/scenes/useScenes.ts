// Scenes for the DM: the list, activation with its per-part report, and undo. Shared by the Scenes page, the big-button panel
// (side screen and pop-out) and the phone's Remote tab, so they all behave the same.
import { useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';

export type PartKey = 'tv' | 'sound' | 'lights' | 'table';
export interface Parts {
  tv?: any; sound?: any; lights?: any; table?: any;
}
export interface Scene { id: string; name: string; icon: string; color: string; pos: number; parts: Parts; updatedAt: string }
export interface PartReport { status: 'ok' | 'failed' | 'skipped'; detail?: string; error?: string; notRestored?: string[] }
export interface Outcome { kind: 'activate' | 'undo'; name: string; ok: boolean; empty?: boolean; parts: Partial<Record<PartKey, PartReport>> }
export interface Last { sceneId: string | null; name: string; at: string; canUndo: boolean }

export const PART_LABEL: Record<PartKey, string> = { tv: "Players' TV", sound: 'Sound', lights: 'Lights', table: 'Table map' };
export const PART_KEYS: PartKey[] = ['tv', 'sound', 'lights', 'table'];
export const partsOf = (s: Scene) => PART_KEYS.filter((k) => s.parts[k]);

/** One line a person can read: "Players' TV ok, Lights failed: no light groups". */
export function outcomeLines(o: Outcome): { key: PartKey; label: string; status: PartReport['status']; text: string }[] {
  return PART_KEYS.filter((k) => o.parts[k]).map((k) => {
    const p = o.parts[k]!;
    const extra = p.notRestored?.length ? ` Not put back: ${p.notRestored.join('; ')}.` : '';
    return { key: k, label: PART_LABEL[k], status: p.status, text: (p.status === 'failed' ? p.error ?? 'failed' : p.detail ?? (p.status === 'skipped' ? 'left alone' : 'done')) + extra };
  });
}

export function useScenes() {
  const { w } = useWorld();
  const q = useLoad<{ scenes: Scene[]; last: Last | null }>(() => w.call('GET', '/scenes'), [w], ['scenes']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async (fn: () => Promise<Outcome | void>) => {
    setBusy(true); setError(null);
    try { const o = await fn(); if (o) setOutcome(o); await q.reload(); } catch (e: any) { setError(e.message ?? String(e)); } finally { setBusy(false); }
  };
  return {
    scenes: q.data?.scenes ?? [], last: q.data?.last ?? null, loading: q.loading, loadError: q.error, reload: q.reload,
    busy, error, outcome, clearOutcome: () => setOutcome(null),
    activate: (s: Scene) => run(async () => {
      const r = await w.call<any>('POST', `/scenes/${encodeURIComponent(s.id)}/activate`, {});
      return { kind: 'activate', name: s.name, ok: r.ok, empty: r.empty, parts: r.parts };
    }),
    undo: (name: string) => run(async () => {
      const r = await w.call<any>('POST', '/scenes/undo', {});
      return { kind: 'undo', name, ok: r.ok, parts: r.parts };
    }),
  };
}
export type ScenesApi = ReturnType<typeof useScenes>;
