// On This device: which alerts this person gets (for all their devices), and turning
// notifications on for this device.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { appInfo } from '../../lib/nativeApp.ts';
import { isIOS, isStandalone } from '../../lib/install.tsx';
import { currentPush, deviceLabel, pushSupported, turnOffPush, turnOnPush } from '../../lib/notify.ts';
import { ErrorBox, useAction } from '../../ui/index.tsx';

type Kinds = Record<'turn' | 'quick' | 'night' | 'reply' | 'request', boolean>;
interface Device { id: string; label: string; createdAt: string; lastOkAt: string | null }
interface Prefs { kinds: Kinds; push: { publicKey: string; devices: Device[] } }

const LABELS: Record<keyof Kinds, string> = {
  turn: 'Your turn in a fight',
  quick: 'A quick event for you (a roll, a choice)',
  night: 'Game night starts within the hour',
  reply: 'An answer to your request',
  request: 'A new request from a player',
};

export default function NotificationsCard({ isDM, linkPhone }: { isDM: boolean; linkPhone?: () => void }) {
  const { client } = useAuth();
  const act = useAction();
  const [p, setP] = useState<Prefs | null>(null);
  const [here, setHere] = useState<string | null | undefined>(undefined); // this browser's push endpoint
  const [note, setNote] = useState('');
  const app = appInfo();
  const load = async () => {
    setP(await client.request<Prefs>('GET', '/api/me/notifications'));
    setHere((await currentPush().catch(() => null))?.endpoint ?? null);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void act.run(load); }, []);

  const kinds = (isDM ? ['night', 'request', 'turn'] : ['turn', 'quick', 'night', 'reply']) as (keyof Kinds)[];
  const toggle = (k: keyof Kinds, on: boolean) => {
    setP((x) => (x ? { ...x, kinds: { ...x.kinds, [k]: on } } : x)); // at once; the server's answer follows
    return act.run(async () => { setP(await client.request<Prefs>('PUT', '/api/me/notifications', { kinds: { [k]: on } })); });
  };
  const pushOn = !!here;
  const mine = p?.push.devices ?? [];

  return (
    <section className="card stack tight" aria-labelledby="notif-h" data-testid="notifications">
      <h2 id="notif-h">Notifications</h2>
      <p className="small">Pick what you want to hear about. This counts for all your devices.</p>
      <ErrorBox error={act.error} />
      {p && kinds.map((k) => (
        <label key={k} className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input type="checkbox" checked={p.kinds[k]} onChange={(e) => void toggle(k, e.target.checked)} data-kind={k} />
          <span>{LABELS[k]}</span>
        </label>
      ))}

      <h3 className="small" style={{ marginTop: 8 }}>Where they appear</h3>
      {app?.platform === 'android' ? (
        <>
          <p className="small">While the app is open or in the background, these show as Android notifications. When the app is closed, it checks every 15 minutes, using the same read-only link as the home-screen widget.</p>
          {linkPhone && <div className="row"><button type="button" className="btn" disabled={act.busy} onClick={linkPhone} data-testid="notif-link"><i className="fa-solid fa-bell" aria-hidden="true" /> Check when the app is closed</button></div>}
        </>
      ) : app ? (
        <p className="small">They show as {app.platform === 'macos' ? 'macOS' : app.platform === 'windows' ? 'Windows' : 'desktop'} notifications while Alexandria runs, also when it is minimized. Closed, it can't show them.</p>
      ) : pushSupported() && (!isIOS() || isStandalone()) ? (
        <>
          <p className="small">{pushOn ? 'On: they reach this device even when Alexandria is closed.' : 'Off on this device.'}</p>
          <div className="row">
            {pushOn ? (
              <>
                <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void act.run(async () => { await turnOffPush(client); await load(); })} data-testid="push-off">Turn off here</button>
                <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void act.run(async () => { const r = await client.request<{ sent: number }>('POST', '/api/push/test'); setNote(r.sent ? 'Sent. It should arrive in a few seconds.' : 'Nothing was delivered. Turn it off and on again.'); })} data-testid="push-test">Send a test</button>
              </>
            ) : (
              <button type="button" className="btn" disabled={act.busy || !p} onClick={() => void act.run(async () => { await turnOnPush(client, p!.push.publicKey, deviceLabel()); await load(); setNote(''); })} data-testid="push-on"><i className="fa-solid fa-bell" aria-hidden="true" /> Turn on for this device</button>
            )}
          </div>
          {note && <p className="small" role="status">{note}</p>}
        </>
      ) : isIOS() ? (
        <p className="small">On iPhone, add Alexandria to the Home Screen first (above), open it from there, and turn notifications on here.</p>
      ) : (
        <p className="small muted">This browser can't show notifications.</p>
      )}
      {mine.length > 0 && !app && (
        <details className="small">
          <summary>{mine.length} device{mine.length === 1 ? '' : 's'} with notifications on</summary>
          <ul className="dl-list">
            {mine.map((x) => (
              <li key={x.id}>
                <span className="grow">{x.label || 'A browser'}<br /><span className="tiny faint">since {x.createdAt.slice(0, 10)}</span></span>
                <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await client.request('DELETE', `/api/push/subscriptions/${encodeURIComponent(x.id)}`); await load(); })} aria-label={`Stop notifications on ${x.label || 'that device'}`}>Remove</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
