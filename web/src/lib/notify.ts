// Notifications on this device. Every app shows the same alerts (the glance's `alerts`,
// librarian/src/features/glance): in the Alexandria apps through an app link, in a browser
// through the service worker; web push (librarian/src/features/notify) reaches a browser or
// the iPhone home-screen app even when it is closed.
import type { AlexandriaClient } from '@alx/client';
import { appInfo } from './nativeApp.ts';

export interface Alert { id: string; kind: string; title: string; body: string; path: string }

const SEEN = 'alx.notified';
export function seenIds(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN) ?? '[]')); } catch { return new Set(); }
}
export function markSeen(ids: Iterable<string>) {
  const all = [...seenIds(), ...ids];
  try { localStorage.setItem(SEEN, JSON.stringify(all.slice(-300))); } catch { /* storage off */ }
}

/** Show one alert as a system notification. Returns false when this device can't. */
export async function showAlert(a: Alert): Promise<boolean> {
  if (appInfo()) {
    const q = (s: string) => encodeURIComponent(s).slice(0, 600);
    window.location.assign(`/app-link/notify#i=${q(a.id)}&t=${q(a.title)}&b=${q(a.body)}&p=${q(a.path)}`);
    return true;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  // The same tag as a web push for the same alert, so the device shows it once.
  await reg.showNotification(a.title, { body: a.body, tag: a.id, icon: '/icons/icon-192.png', data: { path: a.path } });
  return true;
}

// ---- web push ----

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined' && !appInfo();

const keyBytes = (b64u: string) => {
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function currentPush(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission, subscribe this browser and tell the server. Needs a tap (iPhone). */
export async function turnOnPush(client: AlexandriaClient, publicKey: string, label: string): Promise<void> {
  if (!pushSupported()) throw new Error('This browser cannot show notifications');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser\'s site settings, then try again.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const j = sub.toJSON();
  await client.request('POST', '/api/push/subscriptions', { endpoint: j.endpoint, keys: j.keys, label });
}

export async function turnOffPush(client: AlexandriaClient): Promise<void> {
  const sub = await currentPush();
  if (!sub) return;
  await client.request('POST', '/api/push/subscriptions/remove', { endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => {});
}

/** A short name for this device, for the list of devices. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  const home = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone ? ' (home screen)' : '';
  return `${os} · ${br}${home}`;
}
