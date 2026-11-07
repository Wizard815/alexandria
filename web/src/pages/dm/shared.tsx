// Helpers shared by the DM screens.
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useWorld } from '../../lib/world.tsx';

export const QUICK_KINDS: [string, string, string][] = [
  ['recall', 'Recall', 'A character tries to remember something'],
  ['notice', 'Notice', 'Spot something (perception)'],
  ['save', 'Saving throw', 'Dodge, resist, endure'],
  ['read', 'Read a person', 'Insight into someone'],
  ['group', 'Group check', 'Everyone rolls, half must pass'],
  ['contest', 'Contest', 'Player against player or NPC'],
  ['choice', 'Timed choice', 'Pick an option before time runs out'],
  ['vote', 'Party vote', 'The party decides together'],
  ['reaction', 'Reaction', 'First to answer wins'],
  ['twist', 'Twist of fate', 'A sudden turn, players respond'],
];
export const CHECK_KINDS = ['recall', 'notice', 'save', 'read', 'group', 'contest'];
export const OPTION_KINDS = ['choice', 'vote', 'reaction'];

/** What players see of a monster's health, worded like the librarian does. */
export function healthPreview(hp: number | null, max: number | null, mode: string): string {
  if (mode === 'none' || hp === null || max === null || max <= 0) return 'nothing';
  if (mode === 'exact') return `${hp}/${max}`;
  const pct = Math.max(0, Math.min(1, hp / max));
  if (mode === 'bar') return `a bar at ${Math.round(pct * 100)}%`;
  if (hp <= 0) return '“Down”';
  if (pct <= 0.25) return '“Near death”';
  if (pct <= 0.5) return '“Bloodied”';
  if (pct < 1) return '“Hurt”';
  return '“Unhurt”';
}

/** Link to another DM screen. */
export function DMLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const { info } = useWorld();
  return <Link to={`/w/${info.slug}/dm/${to}`} className={className}>{children}</Link>;
}

/** Player members only (not DMs or guests). */
export function usePlayers() {
  const { members } = useWorld();
  return members.filter((m) => m.role === 'player');
}

export function lsGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage off: just don't remember */
  }
}
