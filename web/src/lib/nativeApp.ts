// The Alexandria apps (desktop/, Tauri) load this web app as a remote page with no access to
// the app itself. To ask the app for something, a page goes to /app-link/<action> on its own
// server: the app cancels that navigation and acts on it (desktop/src-tauri/src/lib.rs,
// app_link). In a plain browser the same address shows a short "open this in the app" page.
export const inApp = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const inAndroidApp = (): boolean => inApp() && /Android/i.test(navigator.userAgent);

const go = (path: string) => { window.location.assign(path); };

/** Hand the app a widget key for this world. The #fragment never reaches the server. */
export function linkWidget(key: string, world: string) {
  go(`/app-link/widget#k=${encodeURIComponent(key)}&w=${encodeURIComponent(world)}`);
}
export const unlinkWidget = () => go('/app-link/widget-off');
export const changeServer = () => go('/app-link/change-server');

// ---- updates from this server (librarian/src/features/appbuilds) ----

export type AppPlatform = 'android' | 'windows' | 'macos' | 'linux';
export interface AppInfo { version: string; platform: AppPlatform; arch: string }
/** Set by the app itself (desktop/src-tauri/src/lib.rs, app_info_script); null in a browser. */
export const appInfo = (): AppInfo | null => (typeof window !== 'undefined' ? ((window as any).__ALEXANDRIA_APP__ as AppInfo | undefined) ?? null : null);

export interface Build { file: string; platform: AppPlatform; arch: string; version: string | null; release: string | null; size: number; sha256: string; at: string }
export interface Builds { builds: Build[]; latest: Partial<Record<AppPlatform, Build>> }
export interface Ticket { url: string; ticket: string; file: string; sha256: string; version: string | null }

/** Semver order, prereleases before their release (the server's compareVersions). */
export function compareVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const [ma, pa = ''] = a.split('-', 2);
  const [mb, pb = ''] = b.split('-', 2);
  const na = ma.split('.').map(Number), nb = mb.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) < (nb[i] ?? 0) ? -1 : 1;
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  const xa = pa.split('.'), xb = pb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i], q = xb[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
    if (np && nq) return Number(p) < Number(q) ? -1 : 1;
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The newest build for this app, if it is newer than the app (a build with no version never counts). */
export function updateFor(app: AppInfo | null, b: Builds | null): Build | null {
  const l = app && b?.latest[app.platform];
  return l && l.version && compareVersions(l.version, app!.version) > 0 ? l : null;
}

/** Hand the app a download link; it downloads, checks the SHA-256 and installs. */
export function startUpdate(t: Ticket) {
  go(`/app-link/update#f=${encodeURIComponent(t.file)}&t=${encodeURIComponent(t.ticket)}&s=${t.sha256}`);
}

const AUTO = 'alx.autoUpdate';
export const autoUpdateOn = (): boolean => { try { return localStorage.getItem(AUTO) === '1'; } catch { return false; } };
export const setAutoUpdate = (on: boolean) => { try { localStorage.setItem(AUTO, on ? '1' : '0'); } catch { /* private mode */ } };
