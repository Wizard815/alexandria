// "Install app" support. Chrome and Android fire `beforeinstallprompt` once, early,
// so it is caught at module load (main.tsx imports this) and kept for the hint.
// iOS Safari never fires it: there the hint says to use Share, Add to Home Screen.
import { useEffect, useState } from 'react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: InstallEvent | null = null;
const subs = new Set<() => void>();
const poke = () => subs.forEach((f) => f());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; poke(); });
  window.addEventListener('appinstalled', () => { deferred = null; poke(); });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}
export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
/** Inside the Tauri desktop app there is nothing to install. */
const isDesktopApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  const hidden = isStandalone() || isDesktopApp();
  const ios = !hidden && isIOS();
  const canPrompt = !hidden && !!deferred;
  const install = async () => {
    const e = deferred;
    if (!e) return;
    deferred = null; poke();
    await e.prompt();
    await e.userChoice.catch(() => {});
  };
  return { show: canPrompt || ios, canPrompt, ios, install };
}

/** A small card: an Install button where the browser offers one, a how-to on iOS, nothing otherwise. */
export function InstallHint({ className = 'c' }: { className?: string }) {
  const { show, canPrompt, install } = useInstall();
  if (!show) return null;
  return (
    <section className={className} aria-label="Install the app" data-testid="install-hint">
      <h3>Install the app</h3>
      {canPrompt
        ? <button type="button" className="b" onClick={() => void install()}><i className="fa-solid fa-download" aria-hidden="true" /> Install Alexandria on this device</button>
        : <span className="tiny">On iPhone or iPad: tap Share, then Add to Home Screen. Alexandria then opens full screen, like an app.</span>}
    </section>
  );
}
