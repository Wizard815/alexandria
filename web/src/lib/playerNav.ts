// The player's navigation: every page the app offers, which group it belongs to
// in the phone's More menu, which of them the world has switched off, and the
// tabs this player pinned to the bottom bar (kept per browser, per world).
import * as F from '../features/registry.ts';
import type { WorldSettings } from './world.tsx';

export interface NavItem { to: string; label: string; icon: string }

// [path under /w/:world, label, Font Awesome icon]
const CORE: NavItem[] = ([
  ['', 'Home', 'fa-house'], ['live', 'Live', 'fa-tower-broadcast'], ['library', 'Library', 'fa-book'], ['broker', 'Broker', 'fa-scale-balanced'],
  ['inventory', 'Inventory', 'fa-sack-dollar'], ['people', 'People', 'fa-users'], ['me', 'Me', 'fa-user'], ['map', 'Map', 'fa-map'],
  ['messages', 'Messages', 'fa-envelope'], ['calendar', 'Calendar', 'fa-calendar'], ['ask', 'Ask the DM', 'fa-circle-question'], ['whiteboard', 'Whiteboard', 'fa-chalkboard'],
] as [string, string, string][]).map(([to, label, icon]) => ({ to, label, icon }));

/** Every page, core first and then the features' (the desktop top bar shows this list as is). */
export const allLinks = (): NavItem[] => [...CORE, ...F.playerNav]; // a function: the search box (itself a feature) reads it, so the features may still be loading

export const GROUPS = ['At the table', 'My character', 'World', 'Settings & account'] as const;
export const FALLBACK_GROUP = 'More';
const GROUP_OF: Record<string, string> = {};
const put = (g: (typeof GROUPS)[number], ...ids: string[]) => ids.forEach((id) => { GROUP_OF[id] = g; });
put('At the table', '', 'live', 'assistant', 'stage', 'chat', 'rules', 'whiteboard', 'map', 'ask');
put('My character', 'me', 'codex', 'inventory', 'journal', 'audio', 'recordings', 'lights');
put('World', 'library', 'people', 'calendar', 'bible', 'log', 'broker', 'messages');
put('Settings & account', 'my-keys', 'connect');
/** A page nobody has filed yet lands in "More", so a new feature never goes missing. */
export const groupOf = (to: string): string => GROUP_OF[to] ?? FALLBACK_GROUP;

type S = Partial<WorldSettings> & { agentPlayerHelper?: boolean; sourceKeysPlayers?: boolean };
/** Pages this world has switched off. */
export function isOff(to: string, settings: unknown): boolean {
  const s = (settings ?? {}) as S;
  if (to === 'broker') return s.brokerEnabled === false;
  if (to === 'calendar') return s.calendar === 'off';
  if (to === 'assistant') return s.brokerEnabled === false && s.agentPlayerHelper === false;
  if (to === 'my-keys') return s.sourceKeysPlayers === false;
  return false;
}
export const availableLinks = (settings: unknown): NavItem[] => allLinks().filter((l) => !isOff(l.to, settings));

/**
 * The default tabs, in order of how much a player at the table needs them:
 * Home (what is on tonight), Live (initiative, HP, the DM's cards and events),
 * Ask (the broker and the table helper) and Inventory (coins and items). Me and
 * the rest are one tap away under More; Me takes a slot when Ask is switched off.
 */
export const MAX_TABS = 4;
const DEFAULTS = ['', 'live', 'assistant', 'inventory', 'me'];
export function defaultTabs(settings: unknown): string[] {
  const ok = new Set(availableLinks(settings).map((l) => l.to));
  return DEFAULTS.filter((d) => ok.has(d)).slice(0, MAX_TABS);
}

const key = (slug: string) => `alx.tabs.${slug}`;
export function loadPinned(slug: string): string[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(slug)) ?? 'null');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_TABS) : null;
  } catch { return null; }
}
export function savePinned(slug: string, ids: string[] | null) {
  try { if (ids) localStorage.setItem(key(slug), JSON.stringify(ids)); else localStorage.removeItem(key(slug)); } catch { /* private window */ }
}
/** The tabs to show: the player's pins (minus pages that went away), else the defaults. */
export function tabsFor(pinned: string[] | null, settings: unknown): string[] {
  const ok = new Set(availableLinks(settings).map((l) => l.to));
  const mine = (pinned ?? []).filter((id) => ok.has(id));
  return pinned && mine.length ? mine : defaultTabs(settings);
}
