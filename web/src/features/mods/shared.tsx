// House rules on the web: the types the server sends, a hook that keeps the
// rules and counters live, the counter chips and the Reroll button the chat
// shows under a roll.
import { useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import type { ChatActionMessage } from '../registry.ts';

export type OptionSpec =
  | { type: 'boolean'; default: boolean; label: string; help?: string }
  | { type: 'int'; default: number; min: number; max: number; label: string; help?: string }
  | { type: 'enum'; default: string; values: string[]; label: string; help?: string }
  | { type: 'string'; default: string; max: number; label: string; help?: string };

export interface HouseRule {
  id: string; name: string; summary: string; version: string; author: string; group: string | null;
  source: 'shipped' | 'imported'; feature: string | null; enabled: boolean;
  options: Record<string, unknown>; optionSpecs: Record<string, OptionSpec>;
  resources: { id: string; label: string; icon: string; private: boolean }[];
  actions: { id: string; label: string; by: 'dm' | 'owner' | 'player' | 'any'; resource: string; askReason: boolean; reroll: 'own' | 'anyPlayer' | 'dm' | null }[];
  commands: string[];
  sheet: { title: string; resources: string[] } | null;
  dmBand: { chips: string[]; actions: string[] } | null;
  table: { title: string; actions: string[] } | null;
  rules: { term: string; text: string }[];
  presets?: Record<string, unknown>; missing?: string[]; waiting?: string[];
  kit: number;
  targets: { builtFor: Target[]; worksWith: Target[] };
  requires: Record<string, string>; conflicts: string[];
  /** DM only: why it cannot be turned on here, the Alexandria range, the mod API and what it touches. */
  needs?: string[]; alexandria?: string | null; api?: number; permissions?: string[];
}
export interface Target { id: string; label: string; ok: boolean }
export interface Counter { id: string; label: string; icon: string; value: number; max: number | null; private: boolean }
export interface PlayerCounters { accountId: string; name: string; mods: Record<string, Counter[]> }
export interface LogLine { id: string; modId: string; accountId: string; resource: string; before: number; after: number; action: string; by: string | null; note: string; at: string }

export const GROUP_LABEL: Record<string, string> = { magic: 'How magic works' };

export function useHouseRules() {
  const { w } = useWorld();
  const rules = useLoad(() => w.call<{ mods: HouseRule[] }>('GET', '/mods'), [w], ['mods']);
  const counts = useLoad(() => w.call<{ players: PlayerCounters[] }>('GET', '/mods/counters'), [w], ['mods', 'mods-counts']);
  return { rules, counts, list: rules.data?.mods ?? [], players: counts.data?.players ?? [] };
}

export function Chip({ c }: { c: Counter }) {
  return (
    <span className="chip" title={c.label} aria-label={`${c.label}: ${c.value}${c.max !== null ? ` of ${c.max}` : ''}`}>
      <i className={`fa-solid ${c.icon}`} aria-hidden="true" /> {c.value}{c.max !== null ? `/${c.max}` : ''}
    </span>
  );
}

/** Under a chat roll: the rerolls I hold that fit this roll. */
export function RerollAction({ message, channel }: { message: ChatActionMessage; channel: 'table' | 'party' }) {
  const { w, me, isDM, members } = useWorld();
  const { list, players } = useHouseRules();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (isDM || message.kind !== 'roll') return null;
  const mine = players.find((p) => p.accountId === me);
  if (!mine) return null;
  const authorRole = members.find((m) => m.id === message.authorId)?.role;
  const fits = (whose: string) => (whose === 'own' ? message.authorId === me : whose === 'anyPlayer' ? authorRole === 'player' : authorRole === 'dm');
  const options = list.flatMap((r) => r.actions
    .filter((a) => a.reroll && a.by !== 'dm' && fits(a.reroll))
    .map((a) => ({ r, a, have: mine.mods[r.id]?.find((c) => c.id === a.resource)?.value ?? 0 }))
    .filter((x) => x.have > 0));
  if (!options.length) return null;
  const use = async (modId: string, action: string) => {
    setBusy(true); setErr(null);
    try { await w.call('POST', `/mods/${modId}/act`, { action, rollId: message.id, channel }); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      {options.map(({ r, a, have }) => (
        <button key={`${r.id}-${a.id}`} type="button" disabled={busy} title={`${r.resources.find((x) => x.id === a.resource)?.label} (${have} left)`} onClick={() => void use(r.id, a.id)}>
          <i className="fa-solid fa-rotate" aria-hidden="true" /> {a.label}
        </button>
      ))}
      {err && <span className="tiny" role="alert" style={{ color: 'var(--danger, #c33)' }}>{err}</span>}
    </>
  );
}
