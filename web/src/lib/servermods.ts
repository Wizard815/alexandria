// Server rules that are on (mods with scope "server", turned on under Admin → Mods). A feature that is a server mod
// says so with `serverMod: '<rule id>'` in its WebFeature; while the rule is off its pages, menu entries, settings
// section and cards hide. One shared state for the whole app, like net.ts. See docs/MODS.md.
import { useEffect, useSyncExternalStore } from 'react';

let on: ReadonlySet<string> | null = null; // null: not known yet
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

/** The rules that are on, or null before the server has said. */
export const serverModsOn = (): ReadonlySet<string> | null => on;

/** Set what is on (after a load, or after the admin turns a rule on or off). */
export function setServerModsOn(ids: Iterable<string>) {
  on = new Set(ids);
  for (const s of subs) s();
}

/** Load once (or again with force); a failed load leaves the state unknown, so the next screen tries again. */
export function ensureServerMods(load: () => Promise<string[]>, force = false): Promise<void> {
  if (on && !force) return Promise.resolve();
  if (loading) return loading;
  loading = load().then(setServerModsOn, () => {}).finally(() => { loading = null; });
  return loading;
}

const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

/** The rules that are on; the component re-renders when they change. Pass the loader the first screen should use. */
export function useServerMods(load?: () => Promise<string[]>): ReadonlySet<string> | null {
  const v = useSyncExternalStore(subscribe, serverModsOn, serverModsOn);
  useEffect(() => { if (load) void ensureServerMods(load); }, [load]);
  return v;
}

/** Is this rule on? No id: the feature is not a server mod, so it is always on. Unknown yet: off (it shows once known). */
export const modOn = (id: string | undefined, set: ReadonlySet<string> | null = on): boolean => !id || !!set?.has(id);

/** The loader for table screens (DM and player): any signed-in account may ask what is on. */
export const loadServerMods = (client: { request: <T>(m: string, p: string) => Promise<T> }) => () =>
  client.request<{ on: string[] }>('GET', '/api/server-mods').then((r) => r.on);

/** The loader for the admin pages (they use the admin session). */
export const loadServerModsAdmin = (client: { request: <T>(m: string, p: string) => Promise<T> }) => () =>
  client.request<{ mods: { id: string; enabled: boolean }[] }>('GET', '/api/admin/mods').then((r) => r.mods.filter((m) => m.enabled).map((m) => m.id));
