// Screen size (zoom) per person and per device. A device is one browser or one app install: it makes up its own id
// once and keeps it. The phone app, the desktop app and the web each remember their own zoom, the account keeps them
// all, and a device only ever reads and writes its own row.
//   GET /api/me/ui/:device        -> { device, label, zoom }   (zoom 100 when nothing is saved)
//   PUT /api/me/ui/:device        { zoom: 50..200, label? }
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { authenticate, type Auth } from '../../core/auth.ts';
import { one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';

const schema = `
CREATE TABLE IF NOT EXISTS ui_prefs (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', zoom INTEGER NOT NULL DEFAULT 100, updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, device_id)
);`;

/** Devices kept per account; the ones not used for longest go first. */
export const MAX_DEVICES = 30;
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;

const deviceOf = (v: string): string => {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(v)) throw new HttpError(400, 'Bad device id');
  return v;
};

const feature: Feature = {
  id: 'uiprefs',
  schema,
  appRoutes(app, d) {
    const r = Router();
    const me = (res: any) => (res.locals.auth as Auth).account.id;
    r.get('/:device', (req, res) => {
      const dev = deviceOf(String(req.params.device));
      const row = one<{ label: string; zoom: number }>(d.db, 'SELECT label, zoom FROM ui_prefs WHERE account_id = ? AND device_id = ?', me(res), dev);
      res.json({ device: dev, label: row?.label ?? '', zoom: row?.zoom ?? 100 });
    });
    r.put('/:device', (req, res) => {
      const dev = deviceOf(String(req.params.device));
      const z = Number(req.body?.zoom);
      if (!Number.isFinite(z) || z < ZOOM_MIN || z > ZOOM_MAX) throw new HttpError(400, `Zoom is ${ZOOM_MIN} to ${ZOOM_MAX}`);
      const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
      const id = me(res);
      run(d.db, `INSERT INTO ui_prefs (account_id, device_id, label, zoom, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (account_id, device_id) DO UPDATE SET label = CASE WHEN excluded.label = '' THEN ui_prefs.label ELSE excluded.label END, zoom = excluded.zoom, updated_at = excluded.updated_at`,
      id, dev, label, Math.round(z), now());
      run(d.db, `DELETE FROM ui_prefs WHERE account_id = ? AND device_id NOT IN (SELECT device_id FROM ui_prefs WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?)`, id, id, MAX_DEVICES);
      res.json({ device: dev, zoom: Math.round(z) });
    });
    app.use('/api/me/ui', authenticate(d.db), r);
  },
};
export default feature;
