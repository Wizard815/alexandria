// Real-life session calendar for a world. The DM sets days and times;
// everyone can RSVP, talk about a day, or ask to reschedule. Calendar apps
// subscribe to an iCalendar feed that carries only title, time and place.
import { Router, type Request, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { HttpError, id, isoDate, now, oneOf, str } from '../core/util.ts';
import { ctx, me, settings } from './_shared.ts';

export default function calendarRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const on = (res: Response) => {
    if (settings(res).calendar === 'off') throw new HttpError(404, 'The session calendar is off for this world');
  };
  const session = (res: Response, sid: string) => {
    const s = one<any>(db, 'SELECT * FROM cal_sessions WHERE id = ? AND world_id = ?', sid, ctx(res).world.id);
    if (!s) throw new HttpError(404, 'Session not found');
    return s;
  };
  const everyone = () => true;

  r.get('/', (req, res) => {
    on(res);
    const from = req.query.from ? isoDate(req.query.from, 'from') : new Date(Date.now() - 31 * 864e5).toISOString();
    const to = req.query.to ? isoDate(req.query.to, 'to') : new Date(Date.now() + 120 * 864e5).toISOString();
    const rows = all<any>(db, 'SELECT * FROM cal_sessions WHERE world_id = ? AND starts_at >= ? AND starts_at <= ? ORDER BY starts_at', ctx(res).world.id, from, to);
    res.json(rows.map((s) => ({
      ...s,
      rsvps: all(db, 'SELECT account_id, answer, at FROM cal_rsvps WHERE session_id = ?', s.id),
      reschedules: all(db, `SELECT * FROM cal_reschedules WHERE session_id = ? AND status = 'open'`, s.id).map((x: any) => ({ ...x, proposed: JSON.parse(x.proposed) })),
      chatCount: one<any>(db, 'SELECT COUNT(*) AS n FROM cal_chat WHERE session_id = ?', s.id)!.n,
    })));
  });

  r.post('/', requireDM, (req, res) => {
    on(res);
    const c = ctx(res);
    const starts = isoDate(req.body?.startsAt, 'startsAt');
    const ends = isoDate(req.body?.endsAt, 'endsAt');
    if (ends <= starts) throw new HttpError(400, 'endsAt must be after startsAt');
    const s = { id: id('cal_'), world_id: c.world.id, title: str(req.body?.title, 'title', { max: 120 }), starts_at: starts, ends_at: ends, location: str(req.body?.location, 'location', { max: 200, optional: true }), status: 'scheduled', updated_at: now() };
    run(db, 'INSERT INTO cal_sessions (id, world_id, title, starts_at, ends_at, location, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', s.id, s.world_id, s.title, s.starts_at, s.ends_at, s.location, s.status, s.updated_at);
    audit(db, c.world.id, me(res), 'calendar.create', `${s.title} ${s.starts_at}`);
    d.hub.emit(c.world.id, 'calendar', s, everyone);
    res.status(201).json(s);
  });

  r.patch('/:sid', requireDM, (req, res) => {
    on(res);
    const s = session(res, String(req.params.sid));
    const b = req.body ?? {};
    const next = {
      ...s,
      title: b.title !== undefined ? str(b.title, 'title', { max: 120 }) : s.title,
      starts_at: b.startsAt !== undefined ? isoDate(b.startsAt, 'startsAt') : s.starts_at,
      ends_at: b.endsAt !== undefined ? isoDate(b.endsAt, 'endsAt') : s.ends_at,
      location: b.location !== undefined ? str(b.location, 'location', { max: 200, optional: true }) : s.location,
      status: b.status !== undefined ? oneOf(b.status, 'status', ['scheduled', 'cancelled'] as const) : s.status,
      updated_at: now(),
    };
    if (next.ends_at <= next.starts_at) throw new HttpError(400, 'endsAt must be after startsAt');
    run(db, 'UPDATE cal_sessions SET title = ?, starts_at = ?, ends_at = ?, location = ?, status = ?, updated_at = ? WHERE id = ?', next.title, next.starts_at, next.ends_at, next.location, next.status, next.updated_at, s.id);
    // Moving a session clears RSVPs: people must answer for the new time.
    if (next.starts_at !== s.starts_at) run(db, 'DELETE FROM cal_rsvps WHERE session_id = ?', s.id);
    d.hub.emit(ctx(res).world.id, 'calendar', next, everyone);
    res.json(next);
  });

  r.put('/:sid/rsvp', requirePlayerOrDM, (req, res) => {
    on(res);
    const s = session(res, String(req.params.sid));
    const answer = oneOf(req.body?.answer, 'answer', ['yes', 'maybe', 'no'] as const);
    run(db, `INSERT INTO cal_rsvps (session_id, account_id, answer, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id, account_id) DO UPDATE SET answer = excluded.answer, at = excluded.at`, s.id, me(res), answer, now());
    d.hub.emit(ctx(res).world.id, 'rsvp', { sessionId: s.id, accountId: me(res), answer }, everyone);
    res.json({ answer });
  });

  r.get('/:sid/chat', (req, res) => {
    on(res);
    const s = session(res, String(req.params.sid));
    res.json(all(db, 'SELECT id, author_id, body, at FROM cal_chat WHERE session_id = ? ORDER BY at', s.id));
  });
  r.post('/:sid/chat', requirePlayerOrDM, (req, res) => {
    on(res);
    const s = session(res, String(req.params.sid));
    const m = { id: id('cc_'), session_id: s.id, author_id: me(res), body: str(req.body?.body, 'body', { max: 2000 }), at: now() };
    run(db, 'INSERT INTO cal_chat (id, session_id, author_id, body, at) VALUES (?, ?, ?, ?, ?)', m.id, m.session_id, m.author_id, m.body, m.at);
    d.hub.emit(ctx(res).world.id, 'calendar-chat', m, everyone);
    res.status(201).json(m);
  });

  r.post('/:sid/reschedule', requirePlayerOrDM, (req, res) => {
    on(res);
    const s = session(res, String(req.params.sid));
    const proposed = Array.isArray(req.body?.proposed) ? req.body.proposed.slice(0, 5).map((x: unknown, i: number) => isoDate(x, `proposed[${i}]`)) : [];
    const x = { id: id('rs_'), session_id: s.id, author_id: me(res), reason: str(req.body?.reason, 'reason', { max: 500 }), proposed, status: 'open', at: now() };
    run(db, 'INSERT INTO cal_reschedules (id, session_id, author_id, reason, proposed, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)', x.id, x.session_id, x.author_id, x.reason, JSON.stringify(proposed), x.status, x.at);
    d.hub.emit(ctx(res).world.id, 'reschedule', x, everyone);
    res.status(201).json(x);
  });

  // DM answers a reschedule ask. accept + moveTo moves the session.
  r.post('/:sid/reschedule/:rid', requireDM, (req, res) => {
    on(res);
    const s = session(res, String(req.params.sid));
    const x = one<any>(db, 'SELECT * FROM cal_reschedules WHERE id = ? AND session_id = ?', String(req.params.rid), s.id);
    if (!x) throw new HttpError(404, 'Reschedule request not found');
    const status = oneOf(req.body?.status, 'status', ['accepted', 'declined'] as const);
    run(db, 'UPDATE cal_reschedules SET status = ? WHERE id = ?', status, x.id);
    if (status === 'accepted' && req.body?.moveTo) {
      const start = isoDate(req.body.moveTo, 'moveTo');
      const len = Date.parse(s.ends_at) - Date.parse(s.starts_at);
      const end = new Date(Date.parse(start) + len).toISOString();
      run(db, 'UPDATE cal_sessions SET starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?', start, end, now(), s.id);
      run(db, 'DELETE FROM cal_rsvps WHERE session_id = ?', s.id);
      d.hub.emit(ctx(res).world.id, 'calendar', { ...s, starts_at: start, ends_at: end }, everyone);
    }
    res.json({ status });
  });

  return r;
}

const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function icsFeed(d: Deps) {
  return (_req: Request, res: Response) => {
    const c = ctx(res);
    if (settings(res).calendar === 'off') throw new HttpError(404, 'The session calendar is off for this world');
    const rows = all<any>(d.db, `SELECT * FROM cal_sessions WHERE world_id = ? AND status = 'scheduled' ORDER BY starts_at`, c.world.id);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Alexandria//Session calendar//EN', `X-WR-CALNAME:${icsText(c.world.name)} sessions`];
    for (const s of rows) {
      lines.push('BEGIN:VEVENT', `UID:${s.id}@alexandria`, `DTSTAMP:${icsDate(s.updated_at)}`, `DTSTART:${icsDate(s.starts_at)}`, `DTEND:${icsDate(s.ends_at)}`,
        `SUMMARY:${icsText(s.title)}`, ...(s.location ? [`LOCATION:${icsText(s.location)}`] : []),
        'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(s.title)} tomorrow`, 'END:VALARM', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(lines.join('\r\n') + '\r\n');
  };
}
