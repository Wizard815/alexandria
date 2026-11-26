// App features: each folder web/src/features/<id>/index.tsx default-exports
// a WebFeature. They are picked up here, so adding one never means editing
// App.tsx, the layouts, World settings or the home pages.
import { createElement, type ComponentType, type ReactNode } from 'react';
import type { DMGroupId } from '../lib/dmnames.ts';
import type { AdminGroupId } from '../lib/adminnames.ts';
import { modOn, serverModsOn } from '../lib/servermods.ts';
import ServerModGate from './ServerModGate.tsx';

export interface FeatureRoute { path: string; element: ReactNode }
export interface WebFeature {
  id: string;
  /**
   * This feature is a server mod: the id of a server rule (a mods/ file with scope "server", turned on under
   * Admin → Mods). While the rule is off its pages show a "turned off" note and its menu entries, settings section,
   * cards, bands and tabs hide. Leave it out for a feature that is always on. See docs/MODS.md.
   */
  serverMod?: string;
  /** Under /w/:world/dm/<path>. */
  dmRoutes?: FeatureRoute[];
  /** Under /w/:world/<path> (players). */
  playerRoutes?: FeatureRoute[];
  /** Under /admin/<path>. */
  adminRoutes?: FeatureRoute[];
  /** A page in the DM menu. Known routes take name, icon, description and group from lib/dmnames.ts; a new route gives its own. */
  dmNav?: { to: string; group?: DMGroupId; label?: string; icon?: string; desc?: string }[];
  /** icon: a Font Awesome solid name, e.g. 'fa-scroll'. */
  playerNav?: { to: string; label: string; icon: string }[];
  /** A page in the admin menu. Known routes take name, icon, description and group from lib/adminnames.ts; a new route gives its own (it lands under Server without a group). */
  adminNav?: { to: string; label: string; group?: AdminGroupId; icon?: string; desc?: string }[];
  /** A section in the DM's World settings. */
  settings?: { title: string; component: ComponentType };
  /** Cards on the DM's table page and the player's home page. */
  dmHome?: ComponentType[];
  playerHome?: ComponentType[];
  /** Shown on every DM and player page (e.g. the transcript island). */
  overlay?: ComponentType;
  /** Shown in the top bar next to the world name (e.g. the world date). */
  topbar?: ComponentType;
  /** A band across the top of every DM page, under the menu tabs (e.g. the party's health and mana). */
  dmBand?: ComponentType;
  /** Extra buttons under a session chat message (e.g. Reroll on a roll, from house rules). */
  chatActions?: ComponentType<{ message: ChatActionMessage; channel: 'table' | 'party' }>[];
  /** Tabs on the DM's House rules page for a system rule (shown while the rule `mod` is on), e.g. DownTime's activities. */
  houseRuleTabs?: { mod: string; title: string; component: ComponentType }[];
}
/** What a chat action sees of a message. */
export interface ChatActionMessage { id: string; authorId: string; kind: 'text' | 'roll'; roll: { total: number; expr: string } | null }

const mods = import.meta.glob<{ default: WebFeature }>('./*/index.tsx', { eager: true });
export const FEATURES: WebFeature[] = Object.keys(mods).sort().map((k) => mods[k].default).filter(Boolean);

// Which server rule each menu entry, section, card and tab belongs to (only those of a server-mod feature).
const owner = new WeakMap<object, string>();
const flat = <T,>(pick: (f: WebFeature) => T[] | T | undefined): T[] => FEATURES.flatMap((f) => {
  const v = pick(f);
  const list = v === undefined ? [] : Array.isArray(v) ? v : [v];
  if (f.serverMod) for (const x of list) if (x && (typeof x === 'object' || typeof x === 'function')) owner.set(x as object, f.serverMod);
  return list;
});
// Routes always exist (a link or reload never bounces home); a server mod's page shows a note while its rule is off.
const routes = (pick: (f: WebFeature) => FeatureRoute[] | undefined): FeatureRoute[] => FEATURES.flatMap((f) =>
  (pick(f) ?? []).map((r) => (f.serverMod ? { path: r.path, element: createElement(ServerModGate, { id: f.serverMod }, r.element) } : r)));
/** Keep only what belongs to a feature that is on now (pass the set from useServerMods() so the screen re-renders). */
export const onlyOn = <T,>(items: T[], set: ReadonlySet<string> | null = serverModsOn()): T[] =>
  items.filter((x) => !(x && (typeof x === 'object' || typeof x === 'function')) || modOn(owner.get(x as object), set));
export const dmRoutes = routes((f) => f.dmRoutes);
export const playerRoutes = routes((f) => f.playerRoutes);
export const adminRoutes = routes((f) => f.adminRoutes);
export const dmNav = flat((f) => f.dmNav);
export const playerNav = flat((f) => f.playerNav);
export const adminNav = flat((f) => f.adminNav);
export const settingsSections = flat((f) => (f.settings ? { id: f.id, ...f.settings } : undefined));
export const dmHome = flat((f) => f.dmHome);
export const playerHome = flat((f) => f.playerHome);
export const overlays = flat((f) => f.overlay);
export const topbars = flat((f) => f.topbar);
export const dmBands = flat((f) => f.dmBand);
export const chatActions = flat((f) => f.chatActions);
export const houseRuleTabs = flat((f) => f.houseRuleTabs);
