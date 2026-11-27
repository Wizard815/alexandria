// App features: each folder web/src/features/<id>/index.tsx default-exports
// a WebFeature. They are picked up here, so adding one never means editing
// App.tsx, the layouts, World settings or the home pages.
import type { ComponentType, ReactNode } from 'react';
import type { DMGroupId } from '../lib/dmnames.ts';

export interface FeatureRoute { path: string; element: ReactNode }
/** Where a block sits on the GM's Table: the band across the top (the world right now), the wide play column, the side
 * column (what needs the GM), or the world row at the bottom. */
export type TableZone = 'now' | 'main' | 'side' | 'world';
/** A block on the GM's Table. The GM can hide any block; `order` sorts inside a zone (built-in blocks use 10, 20, 30…). */
export interface TableBlock { id: string; label: string; zone: TableZone; order?: number; component: ComponentType }
export interface WebFeature {
  id: string;
  /** Under /w/:world/dm/<path>. */
  dmRoutes?: FeatureRoute[];
  /** Under /w/:world/<path> (players). */
  playerRoutes?: FeatureRoute[];
  /** Under /admin/<path>. */
  adminRoutes?: FeatureRoute[];
  /** A page in the GM menu. Known routes take name, icon, description and group from lib/dmnames.ts; a new route gives its own. */
  dmNav?: { to: string; group?: DMGroupId; label?: string; icon?: string; desc?: string }[];
  /** icon: a Font Awesome solid name, e.g. 'fa-scroll'. */
  playerNav?: { to: string; label: string; icon: string }[];
  adminNav?: { to: string; label: string }[];
  /** A section in the GM's World settings. */
  settings?: { title: string; component: ComponentType };
  /** Blocks on the GM's Table, each in a zone and hideable. */
  dmTable?: TableBlock[];
  /** Extra cards on the GM's Table (a notice or status card, not hideable) and the player's home page. */
  dmHome?: ComponentType[];
  playerHome?: ComponentType[];
  /** Shown on every GM and player page (e.g. the transcript island). */
  overlay?: ComponentType;
  /** Shown in the top bar next to the world name (e.g. the world date). */
  topbar?: ComponentType;
  /** A band across the top of every GM page, under the menu tabs (e.g. the party's health and mana). */
  dmBand?: ComponentType;
  /** Extra buttons under a session chat message (e.g. Reroll on a roll, from house rules). */
  chatActions?: ComponentType<{ message: ChatActionMessage; channel: 'table' | 'party' }>[];
  /** Tabs on the GM's House rules page for a system rule (shown while the rule `mod` is on), e.g. DownTime's activities. */
  houseRuleTabs?: { mod: string; title: string; component: ComponentType }[];
}
/** What a chat action sees of a message. */
export interface ChatActionMessage { id: string; authorId: string; kind: 'text' | 'roll'; roll: { total: number; expr: string } | null }

const mods = import.meta.glob<{ default: WebFeature }>('./*/index.tsx', { eager: true });
export const FEATURES: WebFeature[] = Object.keys(mods).sort().map((k) => mods[k].default).filter(Boolean);

const flat = <T,>(pick: (f: WebFeature) => T[] | T | undefined): T[] => FEATURES.flatMap((f) => { const v = pick(f); return v === undefined ? [] : Array.isArray(v) ? v : [v]; });
export const dmRoutes = flat((f) => f.dmRoutes);
export const playerRoutes = flat((f) => f.playerRoutes);
export const adminRoutes = flat((f) => f.adminRoutes);
export const dmNav = flat((f) => f.dmNav);
export const playerNav = flat((f) => f.playerNav);
export const adminNav = flat((f) => f.adminNav);
export const settingsSections = flat((f) => (f.settings ? { id: f.id, ...f.settings } : undefined));
export const dmTable = flat((f) => f.dmTable);
export const dmHome = flat((f) => f.dmHome);
export const playerHome = flat((f) => f.playerHome);
export const overlays = flat((f) => f.overlay);
export const topbars = flat((f) => f.topbar);
export const dmBands = flat((f) => f.dmBand);
export const chatActions = flat((f) => f.chatActions);
export const houseRuleTabs = flat((f) => f.houseRuleTabs);
