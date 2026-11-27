// Audio capture and the live transcript (PLAN §3). Sessions, consent, mics,
// chunk upload, speech to text, the many-mic merge, and the transcript read
// API. See engine.ts for the pipeline and merge.ts for the algorithm.
import express, { Router, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { all, one, run } from '../../core/db.ts';
import { featureSetting } from '../../core/policy.ts';
import { HttpError, id, int, now, oneOf, str } from '../../core/util.ts';
import { ctx, isDM, me, settings } from '../../routes/_shared.ts';
import type { Feature } from '../types.ts';
import { DEFAULT_CONSENT_TEXT, HOLD_KINDS, MODES, SCHEMA, engine, lineView, migrateStt, type LineRow, type MicRow } from './engine.ts';
import { SUMMARY_SCHEMA, getSummary, recordingSessions, updateBoth } from './summary.ts';
import { RULES_SCHEMA, ruleNotes, rulesPass } from './rulescheck.ts';
import { sttAssetRoutes, sttAssetsFor } from './sttassets.ts';
import { HANDOFF_SCHEMA, afterRecording, decideHandoff, handoffView, watchFinals } from './handoff.ts';
import { REC_SCHEMA, enqueueBuild, migrateRecordings, resetStuckBuilds, sweepRecordings } from './recordings.ts';
import { recordingMedia, recordingRoutes } from './recroutes.ts';

// (app.ts cannot be imported by a feature: it is waiting on the registry.)
const audit = (db: DB, worldId: string, accountId: string, action: string, detail = '') => { run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now()); };

export const MAX_CHUNK = 2 * 1024 * 1024;

/** The container format, from the first bytes. Anything else is refused. */
export function sniff(b: Buffer): { mime: string; ext: string } | null {
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  return null;
}

const micOut = (m: MicRow, names?: (id: string) => string) => ({
  id: m.id, deviceId: m.device_id, label: m.label, mode: m.mode, playersTranscript: !!m.players_transcript, aside: !!m.aside, room: !!m.room,
  accountId: m.account_id, ...(names ? { owner: names(m.account_id) } : {}),
});

const sessionOut = (s: any) => ({ id: s.id, name: s.name, startedAt: s.started_at, stoppedAt: s.stopped_at, active: !s.stopped_at });

/** A little after the last chunk may arrive (60 s) and once the second listen is done, join the session's chunks into its recording. */
function scheduleBuild(d: Deps, eng: ReturnType<typeof engine>, sessionId: string) {
  const n = Number(d.env.ALX_RECORDINGS_BUILD_DELAY_MS ?? 65_000);
  const t = setTimeout(() => {
    void Promise.resolve(eng.refining.get(sessionId)).then(() => { if (d.dataDir) enqueueBuild(d, sessionId); }).catch((e) => console.error('audio: build not started', e));
  }, Number.isFinite(n) ? n : 65_000);
  t.unref?.();
}

const feature: Feature = {
  id: 'audio',
  schema: SCHEMA + SUMMARY_SCHEMA + RULES_SCHEMA + REC_SCHEMA + HANDOFF_SCHEMA,
  migrate: (db) => { migrateRecordings(db); migrateStt(db); },
  settings: {
    recordingConsentText: { type: 'string', default: DEFAULT_CONSENT_TEXT, max: 2000 },
    audioRetentionDays: { type: 'int', default: 30, min: 1, max: 3650, nullable: true },
    // A short vocabulary prompt (names the players can read, dice words) sent with each chunk to the speech model.
    transcriptHint: { type: 'enum', values: ['on', 'off'], default: 'on' },
    // Minerva's quiet rules checks while recording (features/audio/rulescheck.ts).
    rulesCheck: { type: 'enum', values: ['on', 'off'], default: 'on' },
    // The words just before a chunk, sent as its prompt, for continuity across chunks.
    transcriptContext: { type: 'enum', values: ['on', 'off'], default: 'off' },
    // After a recording stops, listen again in 60 s windows with the audio job's `refineModel` (off unless the job names one).
    transcriptRefine: { type: 'enum', values: ['on', 'off'], default: 'off' },
    // Where speech to text runs: the server's audio model, each recording device's own model (WebGPU, else WASM), or
    // auto (a device with a usable GPU does its own). The server always transcribes what a device did not send text for.
    speechToText: { type: 'enum', values: ['server', 'device', 'auto'], default: 'server' },
    // After a recording stops, sync every mic into one clean transcript that replaces the live one (the live one is kept for undo).
    finalTranscript: { type: 'enum', values: ['on', 'off'], default: 'on' },
  },
  worldMount: 'audio',
  dataDirs: ['audio', 'recordings'],
  appRoutes: (app, d) => {
    recordingMedia(app, d);
    sttAssetRoutes(app, d);
    // When the final transcript is done (or undone), the summaries are made again from its lines and the hand-off follows.
    watchFinals(d);
    // The GM changed where speech to text runs: tell every recording device at once ('stt-mode'), so it loads or frees its model
    // without waiting for its next recording. The mode is no secret (players read it in /audio/status); nothing else is sent.
    const lastMode = new Map<string, string>();
    d.hub.tap((worldId, type) => {
      if (type !== 'settings') return;
      let mode: string;
      try { mode = engine(d).sttMode(worldId); } catch { return; }
      if (lastMode.get(worldId) === mode) return;
      lastMode.set(worldId, mode);
      d.hub.emit(worldId, 'stt-mode', { mode }, () => true);
    });
  },

  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const eng = engine(d);
    r.use(requirePlayerOrDM);

    const consentOf = (worldId: string, accountId: string) => !!one<any>(db, 'SELECT agreed FROM audio_consent WHERE world_id = ? AND account_id = ?', worldId, accountId)?.agreed;
    const activeSession = (worldId: string) => one<any>(db, 'SELECT * FROM audio_sessions WHERE world_id = ? AND stopped_at IS NULL ORDER BY started_at DESC', worldId);
    const sessionOf = (res: Response, sid: string) => {
      // "current" is the recording that is running now.
      const s = sid === 'current' ? activeSession(ctx(res).world.id) : one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ? AND world_id = ?', sid, ctx(res).world.id);
      if (!s) throw new HttpError(404, 'Recording session not found');
      return s;
    };

    // ---- status -----------------------------------------------------------
    r.get('/status', (req, res) => {
      const c = ctx(res);
      const s = activeSession(c.world.id);
      const last = one<any>(db, 'SELECT * FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC', c.world.id);
      const dm = isDM(res);
      res.json({
        recording: !!s,
        session: s ? sessionOut(s) : null,
        lastSession: last ? sessionOut(last) : null,
        serverNow: now(),
        consent: { text: String(featureSetting(settings(res), 'recordingConsentText') ?? ''), agreed: dm || consentOf(c.world.id, me(res)), required: !dm },
        retentionDays: featureSetting(settings(res), 'audioRetentionDays'),
        transcription: { stt: eng.sttMode(c.world.id), hint: featureSetting(settings(res), 'transcriptHint'), context: featureSetting(settings(res), 'transcriptContext'), refine: featureSetting(settings(res), 'transcriptRefine') },
        ...(dm ? { dropped: eng.dropped } : {}),
      });
    });

    // ---- consent --------------------------------------------------------------
    r.get('/consent', (_req, res) => {
      res.json({ text: String(featureSetting(settings(res), 'recordingConsentText') ?? ''), agreed: isDM(res) || consentOf(ctx(res).world.id, me(res)), required: !isDM(res) });
    });
    r.post('/consent', (req, res) => {
      if (typeof req.body?.agree !== 'boolean') throw new HttpError(400, 'agree must be true or false');
      const w = ctx(res).world.id;
      run(db, 'INSERT INTO audio_consent (world_id, account_id, agreed, at) VALUES (?, ?, ?, ?) ON CONFLICT (world_id, account_id) DO UPDATE SET agreed = excluded.agreed, at = excluded.at', w, me(res), req.body.agree ? 1 : 0, now());
      audit(db, w, me(res), req.body.agree ? 'audio.consent' : 'audio.consent_withdrawn');
      res.json({ agreed: req.body.agree });
    });
    r.get('/consents', requireDM, (_req, res) => {
      const w = ctx(res).world.id;
      res.json(all<any>(db, `SELECT a.id AS accountId, a.display_name AS name, m.character_name AS character, m.role, c.agreed, c.at FROM members m JOIN accounts a ON a.id = m.account_id
        LEFT JOIN audio_consent c ON c.world_id = m.world_id AND c.account_id = m.account_id WHERE m.world_id = ? AND m.role = 'player' ORDER BY a.display_name`, w)
        .map((x) => ({ ...x, agreed: !!x.agreed })));
    });

    // ---- mics ----------------------------------------------------------------
    // Where each mic's speech to text happens: what its device reports, and what its chunks of the running (else the latest) session turned out to be.
    const sttOf = (worldId: string, m: MicRow) => {
      const st = eng.sttStatus.get(m.id);
      const sess = activeSession(worldId) ?? one<any>(db, 'SELECT * FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC', worldId);
      const chunks = { device: 0, server: 0, awaiting: 0, pending: 0 };
      if (sess) for (const x of all<any>(db, 'SELECT source, status, COUNT(*) AS n FROM audio_chunks WHERE session_id = ? AND mic_id = ? GROUP BY source, status', sess.id, m.id)) {
        if (x.status === 'awaiting') chunks.awaiting += x.n; else if (x.status === 'pending' || x.status === 'queued') chunks.pending += x.n;
        else if (x.source === 'device') chunks.device += x.n; else if (x.status === 'done') chunks.server += x.n;
      }
      const last = one<any>(db, "SELECT source, stt FROM audio_chunks WHERE mic_id = ? AND status = 'done' ORDER BY end_ms DESC", m.id);
      const info = last?.stt ? JSON.parse(last.stt) : null;
      return { mode: eng.sttMode(worldId), device: st && Date.now() - st.at < 120_000 ? { model: st.model, backend: st.backend, state: st.state, rtf: st.rtf, backlog: st.backlog, progress: st.progress, note: st.note } : null, chunks, last: last?.source ?? null, lastModel: info?.model || null, lastBackend: info?.backend || null, lastRtf: info?.rtf ?? null };
    };
    r.get('/mics', (_req, res) => {
      const w = ctx(res).world.id;
      const eng2 = eng.nameOf(w);
      const rows = isDM(res) ? all<MicRow>(db, 'SELECT * FROM audio_mics WHERE world_id = ? ORDER BY created_at', w) : all<MicRow>(db, 'SELECT * FROM audio_mics WHERE world_id = ? AND account_id = ? ORDER BY created_at', w, me(res));
      res.json(rows.map((m) => ({ ...micOut(m, eng2), stt: sttOf(w, m) })));
    });

    // A device says how its own speech to text is going (every few seconds while it records).
    r.post('/mics/:id/stt', (req, res) => {
      const m = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ? AND world_id = ?', String(req.params.id), ctx(res).world.id);
      if (!m || m.account_id !== me(res)) throw new HttpError(403, 'That mic is not yours');
      const b = req.body ?? {};
      const state = oneOf(b.state, 'state', ['off', 'unsupported', 'loading', 'ready', 'running', 'behind', 'error'] as const);
      const n = (v: unknown, lo: number, hi: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : null; };
      eng.sttStatus.set(m.id, {
        at: Date.now(), state, model: typeof b.model === 'string' ? b.model.slice(0, 60) : '', backend: typeof b.backend === 'string' ? b.backend.slice(0, 20) : '',
        rtf: n(b.rtf, 0, 1000), backlog: Math.round(n(b.backlog, 0, 100000) ?? 0), progress: n(b.progress, 0, 1), note: typeof b.note === 'string' ? b.note.slice(0, 120) : '',
      });
      // A device that cannot keep up or whose model failed: what it still owes is done by the server now, not in 45 s.
      if (state === 'behind' || state === 'error' || state === 'unsupported' || state === 'off') void eng.expireAwaiting(undefined, 0, m.id).catch((e) => console.error('audio: fallback failed', e));
      res.json({ ok: true, mode: eng.sttMode(ctx(res).world.id) });
    });

    // Where this device loads its own speech model from: the librarian serves (and caches) the library and the model
    // files, so no page ever talks to another site. The ticket in the path stands in for the sign-in header that a
    // module import cannot send. Null when this server does not serve them (ALX_STT_ASSETS=off).
    r.get('/stt/assets', (_req, res) => {
      const c = ctx(res);
      res.json({ mode: eng.sttMode(c.world.id), assets: sttAssetsFor(d, c.world.id, me(res)) });
    });

    // The vocabulary prompt for a device's own speech model: names every player may read (never a GM-only or classified title).
    r.get('/hint', (_req, res) => {
      const c = ctx(res);
      res.json({ hint: featureSetting(settings(res), 'transcriptHint') === 'off' ? '' : eng.hint(c.world.id) });
    });

    r.post('/mics', (req, res) => {
      const w = ctx(res).world.id;
      const dm = isDM(res);
      const b = req.body ?? {};
      const deviceId = str(b.deviceId, 'deviceId', { max: 200 });
      const label = str(b.label, 'label', { max: 60 });
      const mode = oneOf(b.mode, 'mode', MODES, 'always');
      for (const k of ['playersTranscript', 'aside'] as const) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
      // A player's mic is that player, always in the players' transcript and never an aside.
      const playersTranscript = dm ? b.playersTranscript !== false : true;
      const aside = dm ? b.aside === true : false;
      const room = dm ? (b.room === undefined ? (mode === 'always' && !aside ? 1 : 0) : b.room ? 1 : 0) : 0;
      let row = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE world_id = ? AND account_id = ? AND device_id = ?', w, me(res), deviceId);
      if (!dm) {
        // One mic per player: a different device replaces the old one.
        const mine = all<MicRow>(db, 'SELECT * FROM audio_mics WHERE world_id = ? AND account_id = ?', w, me(res));
        if (!row && mine.length) {
          row = mine[0];
          for (const extra of mine.slice(1)) run(db, 'DELETE FROM audio_mics WHERE id = ?', extra.id);
          run(db, 'UPDATE audio_mics SET device_id = ? WHERE id = ?', deviceId, row.id);
        }
      } else if (!row && one<any>(db, 'SELECT COUNT(*) AS n FROM audio_mics WHERE world_id = ? AND account_id = ?', w, me(res))!.n >= 16) throw new HttpError(400, 'That is plenty of mics: remove one first');
      if (row) run(db, 'UPDATE audio_mics SET label = ?, mode = ?, players_transcript = ?, aside = ?, room = ? WHERE id = ?', label, mode, playersTranscript ? 1 : 0, aside ? 1 : 0, room, row.id);
      else {
        const mid = id('mic_');
        run(db, 'INSERT INTO audio_mics (id, world_id, account_id, device_id, label, mode, players_transcript, aside, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', mid, w, me(res), deviceId, label, mode, playersTranscript ? 1 : 0, aside ? 1 : 0, room, now());
        row = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ?', mid)!;
      }
      res.status(201).json(micOut(one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ?', row!.id)!));
    });

    r.delete('/mics/:id', (req, res) => {
      const m = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ? AND world_id = ?', String(req.params.id), ctx(res).world.id);
      if (!m || (m.account_id !== me(res) && !isDM(res))) throw new HttpError(404, 'Mic not found');
      // Its transcript lines stay; only the registration goes (chunks reference it, so keep the row if any exist).
      if (one(db, 'SELECT 1 FROM audio_chunks WHERE mic_id = ?', m.id)) run(db, "UPDATE audio_mics SET mode = 'off' WHERE id = ?", m.id);
      else run(db, 'DELETE FROM audio_mics WHERE id = ?', m.id);
      res.json({ ok: true });
    });

    // ---- sessions ----------------------------------------------------------------
    r.get('/sessions', (_req, res) => {
      res.json(all<any>(db, 'SELECT * FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC LIMIT 200', ctx(res).world.id).map(sessionOut));
    });

    r.post('/sessions', requireDM, (req, res) => {
      const c = ctx(res);
      if (activeSession(c.world.id)) throw new HttpError(409, 'A recording session is already running');
      const name = str(req.body?.name, 'name', { max: 80, optional: true }) || `Session ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const sid = id('ses_');
      run(db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, started_by) VALUES (?, ?, ?, ?, ?)', sid, c.world.id, name, now(), me(res));
      const s = one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', sid)!;
      audit(db, c.world.id, me(res), 'audio.start', sid);
      eng.broadcastRecording(c.world.id, true, s);
      res.status(201).json({ ...sessionOut(s), serverNow: now() });
    });

    r.get('/sessions/:sid', (req, res) => res.json({ ...sessionOut(sessionOf(res, String(req.params.sid))), serverNow: now() }));

    r.post('/sessions/:sid/stop', requireDM, (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      if (s.stopped_at) return res.json(sessionOut(s));
      run(db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ?', now(), s.id);
      audit(db, c.world.id, me(res), 'audio.stop', s.id);
      eng.flush(s.id);
      eng.broadcastRecording(c.world.id, false, null);
      eng.scheduleRefine(s.id);
      scheduleBuild(d, eng, s.id);
      // The last lines go into the running summary once the recording ends (after the chunks are flushed). Then the
      // hand-off for the GM's review: with Minerva on, "Last session" for the status doc (which the next session reads);
      // with Minerva off, a "Summary ready" card on Recordings. When the final transcript is done, both are made again
      // from its lines (handoff.ts).
      setTimeout(() => { void afterRecording(d, c.world.id, s.id).catch((e) => console.error('audio: hand-off failed', e)); }, Number(d.env.ALX_AUDIO_HANDOFF_DELAY_MS ?? 5_000)).unref();
      res.json(sessionOut(one<any>(db, 'SELECT * FROM audio_sessions WHERE id = ?', s.id)));
    });

    // ---- upload ------------------------------------------------------------------------
    r.post('/sessions/:sid/chunks', express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: MAX_CHUNK }), async (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      // A last chunk may arrive a moment after the GM stops the session.
      if (s.stopped_at && Date.now() - Date.parse(s.stopped_at) > 60_000) throw new HttpError(409, 'This recording session has ended');
      const mic = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ? AND world_id = ?', String(req.query.mic ?? ''), c.world.id);
      if (!mic || mic.account_id !== me(res)) throw new HttpError(403, 'That mic is not yours');
      // Consent comes first: nothing is stored for a player who has not agreed.
      if (!isDM(res) && !consentOf(c.world.id, me(res))) throw new HttpError(403, 'Agree to recording first');
      const owner = one<any>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', c.world.id, mic.account_id);
      if (owner?.role === 'player' && !consentOf(c.world.id, mic.account_id)) throw new HttpError(403, 'Agree to recording first');
      if (mic.mode === 'off') throw new HttpError(409, 'This mic is turned off');
      const seq = int(req.query.seq, 'seq', { min: 0, max: 10_000_000 })!;
      const start = int(req.query.start, 'start', { min: 0, max: 864e5 })!;
      const end = int(req.query.end, 'end', { min: 1, max: 864e5 })!;
      if (end <= start || end - start > 30_000) throw new HttpError(400, 'end must be after start, within 30 seconds');
      const lv = req.query.level === undefined ? 0.5 : Number(req.query.level);
      if (!Number.isFinite(lv)) throw new HttpError(400, 'level must be a number from 0 to 1');
      const level = Math.max(0, Math.min(1, lv));
      const body = req.body;
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send the audio (audio/webm, audio/ogg or audio/wav) as the request body');
      const fmt = sniff(body);
      if (!fmt) throw new HttpError(415, 'That is not webm, ogg or wav audio');
      if (!d.dataDir) throw new HttpError(503, 'The librarian has no data folder to keep audio in');

      const dup = one<any>(db, 'SELECT id, status FROM audio_chunks WHERE session_id = ? AND mic_id = ? AND seq = ?', s.id, mic.id, seq);
      if (dup) return res.json({ id: dup.id, status: dup.status, duplicate: true });
      // The device's own clock reading at sending (session ms): the server's minus this is that device's clock error plus its upload time.
      const sent = req.query.sent === undefined ? null : Number(req.query.sent);
      const skew = sent !== null && Number.isFinite(sent) ? Math.max(-6e5, Math.min(6e5, Math.round(Date.now() - Date.parse(s.started_at) - sent))) : null;
      // `wait=1`: the device is transcribing this chunk and will send its text next.
      const wait = req.query.wait === '1' || req.query.wait === 'true';

      const rel = path.join('audio', c.world.id, s.id, mic.id, `${seq}.${fmt.ext}`);
      fs.mkdirSync(path.dirname(path.join(d.dataDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(d.dataDir, rel), body);
      const cid = id('chk_');
      run(db, "INSERT INTO audio_chunks (id, session_id, mic_id, seq, start_ms, end_ms, level, status, file, mime, created_at, skew_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)", cid, s.id, mic.id, seq, start, end, level, rel, fmt.mime, now(), skew);
      const outcome = await eng.intake(cid, wait);
      res.status(201).json({ id: cid, status: one<any>(db, 'SELECT status FROM audio_chunks WHERE id = ?', cid)!.status, outcome });
    });

    // The text a device made of a chunk it uploaded (same rules as the upload: its own mic, consent, a running or just-stopped session).
    r.post('/sessions/:sid/chunks/:seq/text', express.json({ limit: '1mb' }), async (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      if (s.stopped_at && Date.now() - Date.parse(s.stopped_at) > 5 * 60_000) throw new HttpError(409, 'This recording session has ended');
      const mic = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ? AND world_id = ?', String(req.query.mic ?? ''), c.world.id);
      if (!mic || mic.account_id !== me(res)) throw new HttpError(403, 'That mic is not yours');
      if (!isDM(res) && !consentOf(c.world.id, me(res))) throw new HttpError(403, 'Agree to recording first');
      const owner = one<any>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', c.world.id, mic.account_id);
      if (owner?.role === 'player' && !consentOf(c.world.id, mic.account_id)) throw new HttpError(403, 'Agree to recording first');
      if (mic.mode === 'off') throw new HttpError(409, 'This mic is turned off');
      const seq = int(req.params.seq, 'seq', { min: 0, max: 10_000_000 })!;
      const ch = one<any>(db, 'SELECT id FROM audio_chunks WHERE session_id = ? AND mic_id = ? AND seq = ?', s.id, mic.id, seq);
      if (!ch) throw new HttpError(404, 'Upload the chunk first');
      res.json(await eng.acceptText(ch.id, req.body));
    });

    // ---- holds: key pressed and released ------------------------------------------------
    r.post('/sessions/:sid/holds', (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      const list = Array.isArray(req.body?.holds) ? req.body.holds : [req.body ?? {}];
      if (list.length > 100) throw new HttpError(400, 'At most 100 holds at a time');
      let from = Infinity;
      let to = 0;
      const rows: any[] = [];
      for (const h of list) {
        const kind = oneOf(h.kind, 'kind', HOLD_KINDS);
        const start = int(h.start, 'start', { min: 0, max: 864e5 })!;
        const end = int(h.end, 'end', { min: 0, max: 864e5 })!;
        if (end < start) throw new HttpError(400, 'end must not be before start');
        let micId: string | null = null;
        if (h.micId !== undefined && h.micId !== null && h.micId !== '') {
          const m = one<MicRow>(db, 'SELECT * FROM audio_mics WHERE id = ? AND world_id = ?', String(h.micId), c.world.id);
          if (!m || (m.account_id !== me(res) && !isDM(res))) throw new HttpError(403, 'That mic is not yours');
          micId = m.id;
        } else if (kind !== 'aside') throw new HttpError(400, 'micId is required');
        if (kind === 'aside' && !isDM(res)) throw new HttpError(403, 'Only the GM can mark an aside');
        rows.push([id('hld_'), s.id, micId, kind, start, end]);
        from = Math.min(from, start);
        to = Math.max(to, end);
      }
      for (const x of rows) run(db, 'INSERT INTO audio_holds (id, session_id, mic_id, kind, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)', ...x);
      // Lines already merged may now be an aside (or muted): merge that stretch again.
      void eng.touch(s.id, from, to).catch((e) => console.error('audio: merge failed', e));
      res.status(201).json({ ok: true, count: rows.length });
    });

    // ---- the transcript ------------------------------------------------------------------
    // The running summary of a session: the GM's (every line they can read) or, for anyone else, the players' one.
    r.get('/sessions/:sid/summary', (req, res) => {
      const s = sessionOf(res, String(req.params.sid));
      res.json(getSummary(d, s.id, isDM(res) ? 'dm' : 'party'));
    });
    // Where the session's summary went (Minerva's review queue, or a card here), for the GM. Never for a player: it is the
    // GM's summary, asides included.
    r.get('/sessions/:sid/handoff', requireDM, (req, res) => {
      const s = sessionOf(res, String(req.params.sid));
      res.json(handoffView(d, ctx(res).world.id, s.id));
    });
    r.post('/sessions/:sid/handoff/:id', requireDM, (req, res) => {
      const s = sessionOf(res, String(req.params.sid));
      const action = oneOf(req.body?.action, 'action', ['approve', 'discard'] as const);
      const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
      res.json(decideHandoff(d, ctx(res).world.id, s.id, String(req.params.id), action, me(res), text));
    });
    // Minerva's quiet rules checks for the GM: the calls that looked off (all=1 for every check made).
    r.get('/sessions/:sid/rule-notes', requireDM, (req, res) => {
      const s = sessionOf(res, String(req.params.sid));
      res.json({ notes: ruleNotes(d, s.id, { onlyFlags: req.query.all !== '1' }) });
    });
    r.post('/sessions/:sid/summary/refresh', requireDM, async (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      const r2 = await updateBoth(d, c.world.id, s.id, { force: true });
      res.json({ ...r2, summary: getSummary(d, s.id, 'dm') });
    });

    r.get('/sessions/:sid/lines', (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      const since = req.query.since === undefined ? '' : String(req.query.since);
      const dm = isDM(res);
      // The GM can read the live version the final transcript replaced.
      if (req.query.version === 'live') {
        if (!dm) throw new HttpError(403, 'Only the GM can read the live version');
        const nm0 = eng.nameOf(c.world.id);
        return res.json({ session: sessionOut(s), version: 'live', lines: eng.liveLines(s.id).sort((a, b) => a.start_ms - b.start_ms).map((l) => lineView(l, true, nm0)) });
      }
      const rows = all<LineRow>(db, `SELECT * FROM audio_lines WHERE session_id = ? ${dm ? '' : "AND audience = 'players'"} ${since ? 'AND updated_at > ?' : ''} ORDER BY start_ms, id`, s.id, ...(since ? [since] : []));
      const nm = eng.nameOf(c.world.id);
      res.json({ session: sessionOut(s), lines: rows.map((l) => lineView(l, dm, nm)) });
    });

    r.patch('/lines/:id', requireDM, (req, res) => {
      const c = ctx(res);
      const l = one<LineRow>(db, 'SELECT * FROM audio_lines WHERE id = ? AND world_id = ?', String(req.params.id), c.world.id);
      if (!l) throw new HttpError(404, 'Line not found');
      const to = oneOf(req.body?.audience, 'audience', ['players', 'dm', 'auto'] as const);
      const next = eng.setAudience(l, to, c.world.id);
      audit(db, c.world.id, me(res), 'audio.line_audience', `${l.id} ${next.audience}`);
      res.json(lineView(next, true, eng.nameOf(c.world.id)));
    });

    // ---- the final transcript ----------------------------------------------------------------------
    r.get('/sessions/:sid/final', requireDM, (req, res) => {
      const s = sessionOf(res, String(req.params.sid));
      res.json({ final: eng.finalView(s.id), serverNow: now() });
    });
    r.post('/sessions/:sid/final', requireDM, (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      if (!s.stopped_at) throw new HttpError(409, 'Stop the recording first');
      if (req.body?.retranscribe !== undefined && typeof req.body.retranscribe !== 'boolean') throw new HttpError(400, 'retranscribe must be true or false');
      if (eng.isFinalizing(s.id)) return res.status(202).json({ final: eng.finalView(s.id) });
      audit(db, c.world.id, me(res), 'audio.final', s.id);
      void eng.finalize(s.id, { retranscribe: req.body?.retranscribe === true }).catch((e) => console.error('audio: final transcript failed', e));
      res.status(202).json({ final: eng.finalView(s.id) ?? { status: 'running', step: 'Starting', pct: 0 } });
    });
    r.post('/sessions/:sid/final/undo', requireDM, (req, res) => {
      const c = ctx(res);
      const s = sessionOf(res, String(req.params.sid));
      const n = eng.undoFinal(s.id);
      audit(db, c.world.id, me(res), 'audio.final_undo', s.id);
      res.json({ restored: n, final: eng.finalView(s.id) });
    });

    // Re-send chunks that were waiting for a model.
    r.post('/retry', requireDM, async (_req, res) => {
      const n = await eng.retryPending();
      res.json({ transcribed: n, pending: one<any>(db, "SELECT COUNT(*) AS n FROM audio_chunks WHERE status = 'pending'")!.n });
    });

    recordingRoutes(r, d);
    return r;
  },

  mcpTools: [
    { name: 'recording_status', description: 'Is a session being recorded, since when, and has each player agreed to the recording?', props: {}, call: () => ({ method: 'GET', path: '/audio/status' }) },
    { name: 'start_recording', write: true, description: 'GM: start recording the game session (the transcript the session log is drafted from). Players must have agreed to the recording consent; check recording_status first.', props: { name: { type: 'string', description: 'Session name, e.g. Session 21' } }, call: (a) => ({ method: 'POST', path: '/audio/sessions', body: { name: a.name } }) },
    { name: 'stop_recording', write: true, description: 'GM: stop the recording that is running.', props: {}, call: () => ({ method: 'POST', path: '/audio/sessions/current/stop', body: {} }) },
  ],

  start: (d: Deps) => {
    const eng = engine(d);
    const retry = setInterval(() => { void eng.retryPending().catch((e) => console.error('audio: retry failed', e)); }, 60_000);
    // Chunks whose device text did not come in time: the server takes them (checked often, so the live transcript has no long hole).
    const late = setInterval(() => { void eng.expireAwaiting().catch((e) => console.error('audio: fallback failed', e)); }, 10_000);
    const keep = setInterval(() => { try { eng.runRetention(); } catch (e) { console.error('audio: retention failed', e); } }, 60 * 60_000);
    // The running summaries of sessions recording now (each folds in new lines only when enough have come in).
    const summ = setInterval(() => { for (const x of recordingSessions(d)) void updateBoth(d, x.worldId, x.sessionId).catch((e) => console.error('audio: summary pass failed', e)); }, 30_000);
    const rules = setInterval(() => { for (const x of recordingSessions(d)) void rulesPass(d, x.worldId, x.sessionId).catch((e) => console.error('audio: rules check failed', e)); }, 20_000);
    rules.unref();
    summ.unref();
    // Sessions that stopped with no recording built (before this existed, or the server restarted) are built lazily, one at a time.
    resetStuckBuilds(d.db);
    const sweep = setInterval(() => { try { sweepRecordings(d); } catch (e) { console.error('audio: recording sweep failed', e); } }, 30 * 60_000);
    const first = setTimeout(() => { try { eng.runRetention(); sweepRecordings(d); } catch (e) { console.error('audio: retention failed', e); } void eng.retryPending().catch(() => {}); }, 10_000);
    for (const t of [retry, late, keep, first, sweep]) t.unref();
    return () => { clearInterval(retry); clearInterval(late); clearInterval(keep); clearInterval(sweep); clearInterval(summ); clearInterval(rules); clearTimeout(first); eng.flushAll(); };
  },
};

export default feature;
