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
