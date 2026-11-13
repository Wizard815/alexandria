// App features: each folder web/src/features/<id>/index.tsx default-exports
// a WebFeature. They are picked up here, so adding one never means editing
// App.tsx, the layouts, World settings or the home pages.
import type { ComponentType, ReactNode } from 'react';

export interface FeatureRoute { path: string; element: ReactNode }
export interface WebFeature {
  id: string;
  /** Under /w/:world/dm/<path>. */
  dmRoutes?: FeatureRoute[];
  /** Under /w/:world/<path> (players). */
  playerRoutes?: FeatureRoute[];
  /** Under /admin/<path>. */
  adminRoutes?: FeatureRoute[];
  dmNav?: { group: 'At the table' | 'The world' | 'Setup'; to: string; label: string }[];
  /** icon: a Font Awesome solid name, e.g. 'fa-scroll'. */
  playerNav?: { to: string; label: string; icon: string }[];
  adminNav?: { to: string; label: string }[];
  /** A section in the DM's World settings. */
  settings?: { title: string; component: ComponentType };
  /** Cards on the DM's table page and the player's home page. */
  dmHome?: ComponentType[];
  playerHome?: ComponentType[];
  /** Shown on every DM and player page (e.g. the transcript island). */
  overlay?: ComponentType;
  /** Shown in the top bar next to the world name (e.g. the world date). */
  topbar?: ComponentType;
}

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
export const dmHome = flat((f) => f.dmHome);
export const playerHome = flat((f) => f.playerHome);
export const overlays = flat((f) => f.overlay);
export const topbars = flat((f) => f.topbar);
