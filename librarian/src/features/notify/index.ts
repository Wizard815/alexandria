// Notifications: each person picks which alerts they get (your turn, a quick event for
// them, game night soon, a reply to their request, a new request for the DM). The alerts
// themselves come from the glance (features/glance), so every app agrees on them:
// - the page shows them as system notifications while the app runs (web/src/features/apps/Notifier.tsx),
// - the Android app checks the glance in the background every 15 minutes (NotifyWorker.kt),
// - browsers and the iPhone home-screen app get web push from here, even when closed.
//
// GET    /api/me/notifications            {kinds, push: {publicKey, devices}}
// PUT    /api/me/notifications            {kinds: {turn, quick, night, reply, request}}
// POST   /api/push/subscriptions          a signed-in session: {endpoint, keys: {p256dh, auth}, label}
// POST   /api/push/subscriptions/remove   {endpoint}: this browser turns itself off
// DELETE /api/push/subscriptions/:id      remove one of your devices
// POST   /api/push/test                   send yourself a test notification on every device
import { randomBytes } from 'node:crypto';
import type { Express, Response } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { authenticate, type Auth } from '../../core/auth.ts';
import { HttpError, now } from '../../core/util.ts';
import { glance, type Alert } from '../glance/index.ts';
import { kindsFor, SCHEMA, setKinds } from './store.ts';
import { pushHostOk, sendPush, vapid } from './webpush.ts';

const SUBS_KEPT = 10;
const subject = (d: Deps) => {
  const s = String(d.env.ALX_PUSH_CONTACT ?? '').trim();
  return /^(mailto:|https:\/\/)/.test(s) ? s : 'https://github.com/Wizard815/alexandria';
};

/** The alerts this person would see in one world right now, filtered by their choices. */
export function alertsFor(d: Deps, accountId: string, world: { id: string; slug: string; name: string; settings: string }, role: string): Alert[] {
  const res = { locals: { w: { world, viewer: { accountId, role } } } } as unknown as Response;
  const kinds = kindsFor(d.db, accountId);
  return ((glance(d, res).alerts ?? []) as Alert[]).filter((a) => kinds[a.kind]);
}

let sweeping = false;
/** Push every new alert to every subscribed device once. Run every 20 seconds. */
export async function sweep(d: Deps): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  let sent = 0;
  try {
    const accounts = all<{ account_id: string }>(d.db, 'SELECT DISTINCT account_id FROM push_subs');
    if (!accounts.length) return 0;
    const v = vapid(d.db);
    for (const { account_id } of accounts) {
      const worlds = all<any>(d.db, 'SELECT w.id, w.slug, w.name, w.settings, m.role FROM members m JOIN worlds w ON w.id = m.world_id WHERE m.account_id = ?', account_id);
      const fresh: Alert[] = [];
      for (const w of worlds) {
        let list: Alert[] = [];
        try { list = alertsFor(d, account_id, w, w.role); } catch { continue; }
        for (const a of list) if (!one(d.db, 'SELECT 1 AS x FROM push_seen WHERE account_id = ? AND alert_id = ?', account_id, a.id)) fresh.push(a);
      }
      if (!fresh.length) continue;
      for (const a of fresh) run(d.db, 'INSERT OR IGNORE INTO push_seen (account_id, alert_id, at) VALUES (?, ?, ?)', account_id, a.id, now());
      const subs = all<any>(d.db, 'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE account_id = ?', account_id);
      for (const a of fresh) {
        for (const s of subs) {
          try {
            const st = await sendPush(d.fetch, v, s, { id: a.id, title: a.title, body: a.body, path: a.path, kind: a.kind }, subject(d));
            if (st === 404 || st === 410) run(d.db, 'DELETE FROM push_subs WHERE id = ?', s.id);
            else if (st < 300) { sent++; run(d.db, 'UPDATE push_subs SET last_ok_at = ? WHERE id = ?', now(), s.id); }
          } catch { /* the push service is unreachable: try the next one */ }
        }
      }
    }
    run(d.db, 'DELETE FROM push_seen WHERE at < ?', new Date(Date.now() - 3 * 864e5).toISOString());
  } finally {
    sweeping = false;
  }
  return sent;
}

const sessionOnly = (res: Response) => {
  const a = res.locals.auth as Auth;
  if (a.via !== 'session') throw new HttpError(403, 'Notifications are set up from a signed-in session, not with a key');
  return a;
};

const feature: Feature = {
  id: 'notify',
  schema: SCHEMA,
  appRoutes: (app: Express, d: Deps) => {
    const auth = authenticate(d.db);
    const view = (accountId: string) => ({
      kinds: kindsFor(d.db, accountId),
      push: {
        publicKey: vapid(d.db).publicKey,
        devices: all<any>(d.db, 'SELECT id, label, created_at AS createdAt, last_ok_at AS lastOkAt FROM push_subs WHERE account_id = ? ORDER BY created_at DESC', accountId),
      },
    });
    app.get('/api/me/notifications', auth, (_req, res) => { res.json(view(sessionOnly(res).account.id)); });
    app.put('/api/me/notifications', auth, (req, res) => {
      const a = sessionOnly(res);
      setKinds(d.db, a.account.id, (req.body?.kinds ?? {}) as Record<string, unknown>);
      res.json(view(a.account.id));
    });
    app.post('/api/push/subscriptions', auth, (req, res) => {
      const a = sessionOnly(res);
      const endpoint = String(req.body?.endpoint ?? '');
      const p256dh = String(req.body?.keys?.p256dh ?? '');
      const authKey = String(req.body?.keys?.auth ?? '');
      if (endpoint.length > 1000 || !pushHostOk(endpoint, String(d.env.ALX_PUSH_HOSTS ?? ''))) throw new HttpError(400, 'That is not a browser push service address');
      if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(authKey)) throw new HttpError(400, 'Bad subscription keys');
      const label = String(req.body?.label ?? '').slice(0, 80);
      // The same device subscribing again (or after another account used it) is moved to this account.
      run(d.db, 'DELETE FROM push_subs WHERE endpoint = ?', endpoint);
      const id = 'ps_' + randomBytes(9).toString('base64url');
      run(d.db, 'INSERT INTO push_subs (id, account_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, a.account.id, endpoint, p256dh, authKey, label, now());
      const old = all<{ id: string }>(d.db, 'SELECT id FROM push_subs WHERE account_id = ? ORDER BY created_at DESC, rowid DESC', a.account.id).slice(SUBS_KEPT);
      for (const o of old) run(d.db, 'DELETE FROM push_subs WHERE id = ?', o.id);
      // What is already waiting is not pushed again to a device that is turned on now.
      for (const w of all<any>(d.db, 'SELECT w.id, w.slug, w.name, w.settings, m.role FROM members m JOIN worlds w ON w.id = m.world_id WHERE m.account_id = ?', a.account.id)) {
        try { for (const al of alertsFor(d, a.account.id, w, w.role)) run(d.db, 'INSERT OR IGNORE INTO push_seen (account_id, alert_id, at) VALUES (?, ?, ?)', a.account.id, al.id, now()); } catch { /* a world that fails to read is skipped */ }
      }
      res.status(201).json({ id });
    });
    // This browser turning itself off: it knows its endpoint, not the id.
    app.post('/api/push/subscriptions/remove', auth, (req, res) => {
      const a = sessionOnly(res);
      run(d.db, 'DELETE FROM push_subs WHERE endpoint = ? AND account_id = ?', String(req.body?.endpoint ?? ''), a.account.id);
      res.json({ ok: true });
    });
    app.delete('/api/push/subscriptions/:id', auth, (req, res) => {
      const a = sessionOnly(res);
      run(d.db, 'DELETE FROM push_subs WHERE id = ? AND account_id = ?', String(req.params.id), a.account.id);
      res.json({ ok: true });
    });
    app.post('/api/push/test', auth, async (_req, res, next) => {
      try {
        const a = sessionOnly(res);
        const v = vapid(d.db);
        let ok = 0;
        for (const s of all<any>(d.db, 'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE account_id = ?', a.account.id)) {
          const st = await sendPush(d.fetch, v, s, { id: `test:${Date.now()}`, title: 'Alexandria', body: 'Notifications work on this device.', path: '', kind: 'test' }, subject(d)).catch(() => 0);
          if (st === 404 || st === 410) run(d.db, 'DELETE FROM push_subs WHERE id = ?', s.id);
          else if (st > 0 && st < 300) ok++;
        }
        res.json({ sent: ok });
      } catch (e) { next(e); }
    });
  },
  start: (d: Deps) => {
    const t = setInterval(() => { void sweep(d).catch(() => {}); }, 20_000);
    t.unref?.();
    return () => clearInterval(t);
  },
};
export default feature;
