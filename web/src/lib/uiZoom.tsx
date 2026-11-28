// Screen size (zoom out or in) per person and per device. Each browser or app install makes up a device id once;
// the account keeps one zoom per device on the server (features/uiprefs), so the phone app, the desktop app and the
// web each remember their own, and signing in on a new phone starts at 100%. A copy is kept here too, so the page
// opens at the right size before the server answers.
//
// How it zooms: on a touch screen (phones, foldables, the Android app) through the viewport's scale, which is a real
// zoom: the layout gets more room and reflows, as if the screen were bigger. With a mouse (the desktop app, a desktop
// browser) through CSS zoom on the page, with --vh100/--dvh100 so full-height layouts still fill the window.
import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth.tsx';

export const ZOOM_MIN = 60;
export const ZOOM_MAX = 150;
const STEP = 10;
const KEY = 'alx.uiZoom';
const DEV = 'alx.deviceId';
const EVENT = 'alx-ui-zoom';
const BASE_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: this visit only */ } };

/** This browser's or this app's own id, made once. */
export function deviceId(): string {
  let id = lsGet(DEV);
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    const r = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
    id = `dev_${r.slice(0, 24)}`;
    lsSet(DEV, id);
  }
  return id;
}

/** "Android app", "Web, Windows": how this device is named in the account. */
export function deviceLabel(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iPhone or iPad' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this device';
  const app = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
  return app ? `${os} app` : `Web, ${os}`;
}

const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z)));
export const localZoom = (): number => { const n = Number(lsGet(KEY)); return Number.isFinite(n) && n > 0 ? clamp(n) : 100; };

/** Sizes the page. 100 puts everything back. */
export function applyZoom(z: number) {
  const root = document.documentElement;
  const s = clamp(z) / 100;
  root.style.removeProperty('zoom');
  for (const p of ['--vh100', '--dvh100']) root.style.removeProperty(p);
  const meta = document.querySelector<HTMLMetaElement>('meta[name=viewport]');
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (touch) {
    if (meta) meta.content = s === 1 ? BASE_VIEWPORT : `width=device-width, initial-scale=${s}, minimum-scale=${s}, viewport-fit=cover`;
    return;
  }
  if (meta && meta.content !== BASE_VIEWPORT) meta.content = BASE_VIEWPORT;
  if (s === 1) return;
  root.style.setProperty('zoom', String(s));
  root.style.setProperty('--vh100', `calc(100vh / ${s})`);
  root.style.setProperty('--dvh100', `calc(100dvh / ${s})`);
}

/** Call once before the first render. */
export const initZoom = () => { const z = localZoom(); if (z !== 100) applyZoom(z); };

function setLocal(z: number) {
  lsSet(KEY, String(z));
  applyZoom(z);
  window.dispatchEvent(new Event(EVENT));
}

/** Signed in: this device's zoom from the account wins over the copy kept here. */
export function ZoomSync() {
  const { client, me } = useAuth();
  const acct = me?.account.id;
  useEffect(() => {
    if (!acct) return;
    let live = true;
    client.request<{ zoom: number }>('GET', `/api/me/ui/${deviceId()}`).then((r) => { if (live && typeof r?.zoom === 'number' && clamp(r.zoom) !== localZoom()) setLocal(clamp(r.zoom)); }).catch(() => { /* offline: keep the copy */ });
    return () => { live = false; };
  }, [acct, client]);
  return null;
}

/** "Screen size on this device: − 90% + Reset". Only this device's line; it saves to the account. */
export function ZoomPicker({ compact }: { compact?: boolean }) {
  const { client, me } = useAuth();
  const [z, setZ] = useState(localZoom);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { const f = () => setZ(localZoom()); window.addEventListener(EVENT, f); return () => window.removeEventListener(EVENT, f); }, []);
  useEffect(() => () => clearTimeout(t.current), []);
  const pick = (n: number) => {
    const v = clamp(n);
    setZ(v);
    setLocal(v);
    clearTimeout(t.current);
    if (me) t.current = setTimeout(() => { void client.request('PUT', `/api/me/ui/${deviceId()}`, { zoom: v, label: deviceLabel() }).catch(() => { /* kept here; saved next time */ }); }, 400);
  };
  return (
    <div className="ui-zoom" role="group" aria-label="Screen size on this device" data-testid="ui-zoom">
      {!compact && <span className="ui-zoom-label">Screen size <span className="faint">· {deviceLabel()}</span></span>}
      <span className="ui-zoom-row">
        <button type="button" className="btn small" aria-label="Smaller" disabled={z <= ZOOM_MIN} onClick={() => pick(z - STEP)} data-testid="zoom-out"><i className="fa-solid fa-magnifying-glass-minus" aria-hidden="true" /></button>
        <output className="ui-zoom-val" aria-live="polite" data-testid="zoom-value">{z}%</output>
        <button type="button" className="btn small" aria-label="Bigger" disabled={z >= ZOOM_MAX} onClick={() => pick(z + STEP)} data-testid="zoom-in"><i className="fa-solid fa-magnifying-glass-plus" aria-hidden="true" /></button>
        <button type="button" className="btn small ghost" disabled={z === 100} onClick={() => pick(100)}>100%</button>
      </span>
    </div>
  );
}
