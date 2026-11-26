// Shows new alerts as system notifications while Alexandria is open in this app or tab but not
// in view (minimized, another tab, the phone's home screen). Alerts for every world you are in,
// checked when something happens in this world and every 45 seconds. Each alert shows once.
import { useEffect, useRef } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld } from '../../lib/world.tsx';
import { appInfo } from '../../lib/nativeApp.ts';
import { markSeen, seenIds, showAlert, type Alert } from '../../lib/notify.ts';
import { GLANCE_EVENTS } from './api.ts';

const EVERY = 45_000;

export default function Notifier() {
  const { client, me } = useAuth();
  const { on } = useWorld();
  const first = useRef(true);
  const busy = useRef(false);
  const worlds = me?.worlds ?? [];
  const key = worlds.map((x) => x.id).join(',');

  useEffect(() => {
    const can = () => !!appInfo() || (typeof Notification !== 'undefined' && Notification.permission === 'granted');
    const check = async () => {
      if (busy.current || !can()) return;
      busy.current = true;
      try {
        const got: Alert[] = [];
        for (const x of worlds) {
          try { got.push(...(((await client.request<{ alerts?: Alert[] }>('GET', `/api/worlds/${encodeURIComponent(x.id)}/glance`)).alerts) ?? [])); } catch { /* skip that world */ }
        }
        const seen = seenIds();
        const fresh = got.filter((a) => !seen.has(a.id));
        markSeen(fresh.map((a) => a.id));
        // What was already waiting when the app opened is on screen anyway: no buzz for it.
        if (first.current) { first.current = false; return; }
        if (!document.hidden) return;
        for (const a of fresh.slice(0, 3)) { await showAlert(a); await new Promise((r) => setTimeout(r, 400)); }
      } finally { busy.current = false; }
    };
    void check();
    const t = setInterval(() => void check(), EVERY);
    const off = on(GLANCE_EVENTS, () => void check());
    return () => { clearInterval(t); off(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, on]);
  return null;
}
