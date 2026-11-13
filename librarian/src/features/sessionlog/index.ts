// The session log (PLAN §8): DM drafts of a session summary built from the
// transcript (players' lines only), combat, loot, coin, the broker and the
// world clock; review with versions; a proposed date change; a leak check;
// publishing to players, who only ever see published entries.
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one, run, tx, type DB } from '../../core/db.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError, id, now, str } from '../../core/util.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import { addEvent, advance, deleteEvent, formatDate, getCalendar, getClock, updateEvent } from '../clock/api.ts';
import type { Feature } from '../types.ts';
import { cleanProposal, draftOut, draftSummary, entryOut, gather, dmNotes, resolveRange, reviseSummary, type DateProposal } from './api.ts';
import { leakCheck } from './leak.ts';

const audit = (db: DB, worldId: string, accountId: string, action: string, detail = '') => { run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now()); };
const MAX_MD = 100_000;

const feature: Feature = {
  id: 'sessionlog',
  schema: `
    CREATE TABLE IF NOT EXISTS sessionlog_drafts (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Session summary',
      audio_session_id TEXT,
      from_at TEXT NOT NULL,
      to_at TEXT NOT NULL,
      world_start_minutes INTEGER NOT NULL DEFAULT 0,
      current_version INTEGER NOT NULL DEFAULT 1,
      dm_notes TEXT NOT NULL DEFAULT '',
      used_model INTEGER NOT NULL DEFAULT 0,
      proposal TEXT,
      date_status TEXT NOT NULL DEFAULT 'none',
      date_applied TEXT,
      entry_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessionlog_drafts_world ON sessionlog_drafts(world_id, created_at);
    CREATE TABLE IF NOT EXISTS sessionlog_versions (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES sessionlog_drafts(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      markdown TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (draft_id, n)
    );
    CREATE TABLE IF NOT EXISTS sessionlog_entries (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      draft_id TEXT,
      version_n INTEGER,
      summary TEXT NOT NULL,
      session_at TEXT NOT NULL,
      world_from_minutes INTEGER NOT NULL,
      world_to_minutes INTEGER NOT NULL,
      world_from_label TEXT NOT NULL DEFAULT '',
      world_to_label TEXT NOT NULL DEFAULT '',
      event_id TEXT,
      published_at TEXT NOT NULL,
      published_by TEXT,
      unpublished_at TEXT,
      UNIQUE (world_id, number)
    );
  `,
  worldMount: 'sessionlog',
  worldRoutes: (d: Deps) => {
    const db = d.db;
    const r = Router();

    const draftRow = (worldId: string, did: string) => {
      const row = one<any>(db, 'SELECT * FROM sessionlog_drafts WHERE id = ? AND world_id = ?', did, worldId);
      if (!row) throw new HttpError(404, 'Draft not found');
      return row;
    };
    const addVersion = (draftId: string, markdown: string, note: string, by: string | null) => {
      const n = (one<any>(db, 'SELECT MAX(n) AS n FROM sessionlog_versions WHERE draft_id = ?', draftId)?.n ?? 0) + 1;
      run(db, 'INSERT INTO sessionlog_versions (id, draft_id, n, markdown, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)', id('slv_'), draftId, n, markdown, note, by, now());
      run(db, 'UPDATE sessionlog_drafts SET current_version = ?, updated_at = ? WHERE id = ?', n, now(), draftId);
      return n;
    };
    const md = (v: unknown) => {
      if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'markdown is required');
      if (v.length > MAX_MD) throw new HttpError(400, 'markdown is too long');
      return v;
    };

    /** Entries reach players only as published; DMs see all of them. */
    const announce = (worldId: string, action: 'published' | 'unpublished', row: any) => {
      d.hub.emit(worldId, 'sessionlog', { action, entry: { ...entryOut(row), draftId: row.draft_id } }, dmOnly);
      if (action === 'published') d.hub.emit(worldId, 'sessionlog', { action, entry: entryOut(row) }, (v) => v.role !== 'dm');
      else d.hub.emit(worldId, 'sessionlog', { action, entry: { id: row.id } }, (v) => v.role !== 'dm');
    };

    r.get('/', (_req, res) => {
      const c = ctx(res);
      const dm = isDM(res);
      const rows = all<any>(db, `SELECT * FROM sessionlog_entries WHERE world_id = ? ${dm ? '' : 'AND unpublished_at IS NULL'} ORDER BY number DESC`, c.world.id);
      res.json(rows.map((x) => (dm ? { ...entryOut(x), draftId: x.draft_id } : entryOut(x))));
    });

    // ---- drafts (DM only) ----
    r.get('/drafts', requireDM, (_req, res) => {
      const rows = all<any>(db, 'SELECT * FROM sessionlog_drafts WHERE world_id = ? ORDER BY created_at DESC', ctx(res).world.id);
      res.json(rows.map((x) => { const o = draftOut(db, x); return { id: o.id, title: o.title, version: o.version, dateStatus: o.dateStatus, entryId: o.entryId, usedModel: o.usedModel, createdAt: o.createdAt, updatedAt: o.updatedAt }; }));
    });

    r.post('/drafts', requireDM, async (req, res) => {
      const c = ctx(res);
      const range = resolveRange(db, c.world.id, req.body ?? {});
      const g = gather(db, c.world.id, range);
      const out = await draftSummary(d, g);
      const did = id('sld_');
      const title = typeof req.body?.title === 'string' && req.body.title.trim() ? str(req.body.title, 'title', { max: 200 }) : 'Session summary';
      tx(db, () => {
        run(db, `INSERT INTO sessionlog_drafts (id, world_id, title, audio_session_id, from_at, to_at, world_start_minutes, dm_notes, used_model, proposal, date_status, created_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, did, c.world.id, title, g.audioSessionIds.length === 1 ? g.audioSessionIds[0] : null, g.from, g.to, g.worldStartMinutes, dmNotes(g), out.usedModel ? 1 : 0,
          out.proposal ? JSON.stringify(out.proposal) : null, out.proposal ? 'pending' : 'none', me(res), now(), now());
        run(db, 'INSERT INTO sessionlog_versions (id, draft_id, n, markdown, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)', id('slv_'), did, 1, out.markdown, out.usedModel ? 'drafted by the model' : 'drafted from the data (no model)', me(res), now());
      });
      audit(db, c.world.id, me(res), 'sessionlog.draft', did);
      res.status(201).json(draftOut(db, draftRow(c.world.id, did), true));
    });

    r.get('/drafts/:id', requireDM, (req, res) => res.json(draftOut(db, draftRow(ctx(res).world.id, String(req.params.id)), true)));

    r.put('/drafts/:id', requireDM, (req, res) => {
      const c = ctx(res);
      const row = draftRow(c.world.id, String(req.params.id));
      if (req.body?.title !== undefined) run(db, 'UPDATE sessionlog_drafts SET title = ?, updated_at = ? WHERE id = ?', str(req.body.title, 'title', { max: 200 }), now(), row.id);
      if (req.body?.markdown !== undefined) addVersion(row.id, md(req.body.markdown), 'edited by hand', me(res));
      res.json(draftOut(db, draftRow(c.world.id, row.id), true));
    });

    r.delete('/drafts/:id', requireDM, (req, res) => {
      const row = draftRow(ctx(res).world.id, String(req.params.id));
      run(db, 'DELETE FROM sessionlog_drafts WHERE id = ?', row.id);
      res.json({ ok: true });
    });

    r.post('/drafts/:id/revise', requireDM, async (req, res) => {
      const c = ctx(res);
      const row = draftRow(c.world.id, String(req.params.id));
      const instruction = str(req.body?.instruction, 'instruction', { max: 2000 });
      const cur = draftOut(db, row).markdown;
      const next = await reviseSummary(d, cur, instruction);
      addVersion(row.id, next, `revised: ${instruction.slice(0, 80)}`, me(res));
      res.json(draftOut(db, draftRow(c.world.id, row.id), true));
    });

    r.post('/drafts/:id/restore', requireDM, (req, res) => {
      const c = ctx(res);
      const row = draftRow(c.world.id, String(req.params.id));
      const n = Number(req.body?.version);
      const v = one<any>(db, 'SELECT * FROM sessionlog_versions WHERE draft_id = ? AND n = ?', row.id, n);
      if (!v) throw new HttpError(404, 'Version not found');
      addVersion(row.id, v.markdown, `restored version ${n}`, me(res));
      res.json(draftOut(db, draftRow(c.world.id, row.id), true));
    });

    r.get('/drafts/:id/versions/:n', requireDM, (req, res) => {
      const row = draftRow(ctx(res).world.id, String(req.params.id));
      const v = one<any>(db, 'SELECT * FROM sessionlog_versions WHERE draft_id = ? AND n = ?', row.id, Number(req.params.n));
      if (!v) throw new HttpError(404, 'Version not found');
      res.json({ n: v.n, note: v.note, createdAt: v.created_at, markdown: v.markdown });
    });

    // Accept (or edit, or decline) the proposed date change. Nothing moves without this.
    r.post('/drafts/:id/date', requireDM, (req, res) => {
      const c = ctx(res);
      const row = draftRow(c.world.id, String(req.params.id));
      if (row.date_status === 'accepted') throw new HttpError(409, 'The date change was already applied');
      if (req.body?.accept === false) {
        run(db, "UPDATE sessionlog_drafts SET date_status = 'declined', updated_at = ? WHERE id = ?", now(), row.id);
        return res.json(draftOut(db, draftRow(c.world.id, row.id), true));
      }
      const prop: DateProposal | null = row.proposal ? JSON.parse(row.proposal) : null;
      const b = req.body ?? {};
      const merged = cleanProposal({
        minutes: b.minutes ?? prop?.minutes,
        reason: b.reason ?? prop?.reason ?? '',
        travel: b.travel === undefined ? prop?.travel : b.travel,
        rests: b.rests === undefined ? prop?.rests : b.rests,
      });
      if (!merged) throw new HttpError(400, 'minutes must be a whole number above zero');
      let reason = merged.reason;
      if (merged.travel && !/travel/i.test(reason)) reason = `Travel ${merged.travel.from || '?'} to ${merged.travel.to || '?'}${merged.travel.route ? ` via ${merged.travel.route}` : ''}${reason ? `: ${reason}` : ''}`;
      const before = getClock(db, c.world.id).minutes;
      const entry = advance(db, d.hub, c.world.id, merged.minutes, reason || 'Session log', me(res));
      const after = before + merged.minutes;
      if (merged.travel) {
        addEvent(db, d.hub, c.world.id, {
          title: `Travel: ${merged.travel.from || '?'} to ${merged.travel.to || '?'}`, description: [merged.travel.route && `Route: ${merged.travel.route}`, merged.travel.days && `${merged.travel.days} days`].filter(Boolean).join('. '),
          start: before, end: after, visibility: 'party', kind: 'travel',
        }, me(res));
      }
      for (const rest of merged.rests ?? []) {
        addEvent(db, d.hub, c.world.id, { title: rest.kind === 'long' ? 'Long rest' : 'Short rest', start: before + (rest.minutesIn ?? merged.minutes), visibility: 'party', kind: 'rest' }, me(res));
      }
      run(db, "UPDATE sessionlog_drafts SET date_status = 'accepted', date_applied = ?, proposal = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...merged, reason, logId: entry.id, before, after }), JSON.stringify(merged), now(), row.id);
      audit(db, c.world.id, me(res), 'sessionlog.date', `${row.id} +${merged.minutes}m`);
      res.json(draftOut(db, draftRow(c.world.id, row.id), true));
    });

    r.get('/drafts/:id/leakcheck', requireDM, (req, res) => {
      const c = ctx(res);
      const row = draftRow(c.world.id, String(req.params.id));
      const overlaps = leakCheck(db, c.world.id, draftOut(db, row).markdown);
      res.json({ overlaps, blocked: overlaps.some((o) => o.aside) });
    });

    r.post('/drafts/:id/publish', requireDM, (req, res) => {
      const c = ctx(res);
      const row = draftRow(c.world.id, String(req.params.id));
      const draft = draftOut(db, row);
      if (!draft.markdown.trim()) throw new HttpError(400, 'The summary is empty');
      const overlaps = leakCheck(db, c.world.id, draft.markdown);
      const asides = overlaps.filter((o) => o.aside);
      if (asides.length) {
        res.status(409).json({ error: 'The summary repeats words from an aside. Asides are never published; remove these passages.', overlaps, blocked: true, forceAllowed: false });
        return;
      }
      if (overlaps.length && req.body?.force !== true) {
        res.status(409).json({ error: 'The summary repeats DM-only text. Fix these passages, or publish anyway.', overlaps, blocked: false, forceAllowed: true });
        return;
      }
      if (overlaps.length) audit(db, c.world.id, me(res), 'sessionlog.publish_forced', `${row.id} ${overlaps.length} overlaps`);

      const def = getCalendar(db, c.world.id).definition;
      const clock = getClock(db, c.world.id);
      const startMin = Math.min(row.world_start_minutes, clock.minutes);
      const endMin = clock.minutes;
      const existing = row.entry_id ? one<any>(db, 'SELECT * FROM sessionlog_entries WHERE id = ?', row.entry_id) : null;
      const number = existing?.number ?? ((one<any>(db, 'SELECT MAX(number) AS n FROM sessionlog_entries WHERE world_id = ?', c.world.id)?.n ?? 0) + 1);
      const eid = existing?.id ?? id('sle_');
      // A session event on the in-world date, so the calendar shows it.
      const ev = { title: /^session\b/i.test(String(draft.title).trim()) ? draft.title : `Session ${number}: ${draft.title}`, description: '', start: startMin, end: endMin > startMin ? endMin : null, visibility: 'party', kind: 'session' };
      let eventId: string | null = existing?.event_id ?? null;
      try {
        if (eventId) updateEvent(db, d.hub, c.world.id, eventId, ev);
        else eventId = addEvent(db, d.hub, c.world.id, ev, me(res)).id;
      } catch (e: any) {
        if (e?.status !== 404) throw e;
        eventId = addEvent(db, d.hub, c.world.id, ev, me(res)).id;
      }
      tx(db, () => {
        if (existing) {
          run(db, 'UPDATE sessionlog_entries SET title = ?, version_n = ?, summary = ?, world_from_minutes = ?, world_to_minutes = ?, world_from_label = ?, world_to_label = ?, event_id = ?, published_at = ?, published_by = ?, unpublished_at = NULL WHERE id = ?',
            draft.title, draft.version, draft.markdown, startMin, endMin, formatDate(def, startMin), formatDate(def, endMin), eventId, now(), me(res), eid);
        } else {
          run(db, 'INSERT INTO sessionlog_entries (id, world_id, number, title, draft_id, version_n, summary, session_at, world_from_minutes, world_to_minutes, world_from_label, world_to_label, event_id, published_at, published_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            eid, c.world.id, number, draft.title, row.id, draft.version, draft.markdown, row.from_at, startMin, endMin, formatDate(def, startMin), formatDate(def, endMin), eventId, now(), me(res));
        }
        run(db, 'UPDATE sessionlog_drafts SET entry_id = ?, updated_at = ? WHERE id = ?', eid, now(), row.id);
      });
      const out = one<any>(db, 'SELECT * FROM sessionlog_entries WHERE id = ?', eid);
      audit(db, c.world.id, me(res), 'sessionlog.publish', `${eid} #${number}`);
      announce(c.world.id, 'published', out);
      res.json({ ...entryOut(out), draftId: row.id, overlaps });
    });

    r.post('/:id/unpublish', requireDM, (req, res) => {
      const c = ctx(res);
      const e = one<any>(db, 'SELECT * FROM sessionlog_entries WHERE id = ? AND world_id = ?', String(req.params.id), c.world.id);
      if (!e) throw new HttpError(404, 'Entry not found');
      if (e.event_id) { try { deleteEvent(db, d.hub, c.world.id, e.event_id); } catch { /* already gone */ } }
      run(db, 'UPDATE sessionlog_entries SET unpublished_at = ?, event_id = NULL WHERE id = ?', now(), e.id);
      const out = one<any>(db, 'SELECT * FROM sessionlog_entries WHERE id = ?', e.id);
      audit(db, c.world.id, me(res), 'sessionlog.unpublish', e.id);
      announce(c.world.id, 'unpublished', out);
      res.json({ ...entryOut(out), draftId: out.draft_id });
    });

    r.get('/:id', (req, res) => {
      const c = ctx(res);
      const e = one<any>(db, 'SELECT * FROM sessionlog_entries WHERE id = ? AND world_id = ?', String(req.params.id), c.world.id);
      // A player gets "not found" for an unpublished entry, the same as for one that does not exist.
      if (!e || (!isDM(res) && e.unpublished_at !== null)) throw new HttpError(404, 'Entry not found');
      res.json(isDM(res) ? { ...entryOut(e), draftId: e.draft_id } : entryOut(e));
    });

    return r;
  },
  mcpTools: [
    { name: 'list_session_log', description: 'The session log: published summaries of past sessions, newest first, with the in-world dates they cover. Players only ever see published entries.', props: {}, call: () => ({ method: 'GET', path: '/sessionlog' }) },
    {
      name: 'draft_session_summary', write: true,
      description: "Draft a summary of a session for the DM to review (never published by this tool). Built from the players' transcript, combat, loot, coin, purchases and clock changes. Give audioSessionId, or from/to (ISO date-times).",
      props: { audioSessionId: { type: 'string', description: 'The audio session to summarise' }, from: { type: 'string', description: 'Start, ISO date-time' }, to: { type: 'string', description: 'End, ISO date-time' }, title: { type: 'string' } },
      call: (a) => ({ method: 'POST', path: '/sessionlog/drafts', body: { audioSessionId: a.audioSessionId, from: a.from, to: a.to, title: a.title } }),
    },
  ],
};
export default feature;
