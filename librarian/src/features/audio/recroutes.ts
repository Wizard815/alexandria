// The recordings API: lists, build / retention / delete (DM), and the audio files.
// Fails closed: every file request names a track id (never a path), the stored path
// is checked to stay inside data/recordings, and a player may only reach the tracks
// of their own mics. The full mix and everyone else's tracks are DM-only.
import type { Express, Response, Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, int, now, oneOf, parseJson } from '../../core/util.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import { serveFile } from '../sound/files.ts';
import { engine } from './engine.ts';
import { mintTicket, readTicket } from '../sound/ticket.ts';
import {
  type SessionRow, type TrackRow, buildProgress, chunkFiles, deleteSessionAudio, deletesAt, effectiveDays, enqueueBuild, ffmpegAvailable, isBuilding, localDate,
} from './recordings.ts';

const audit = (d: Deps, worldId: string, accountId: string, action: string, detail = '') => { run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now()); };

/** May this account read this track? A DM: any track of the world. A player: a track of a mic registered from their own account. */
export function mayHear(d: Deps, worldId: string, accountId: string, t: TrackRow & { world_id: string }): boolean {
  if (t.world_id !== worldId) return false;
  const m = one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, accountId);
  if (!m) return false;
  if (m.role === 'dm') return true;
  return m.role === 'player' && t.kind === 'mic' && !!t.account_id && t.account_id === accountId;
}

const trackById = (d: Deps, tid: string) => one<TrackRow & { world_id: string; rec_dir: string | null }>(d.db,
  'SELECT t.*, s.world_id AS world_id, s.rec_dir AS rec_dir FROM audio_tracks t JOIN audio_sessions s ON s.id = t.session_id WHERE t.id = ? AND s.audio_deleted_at IS NULL', tid);

/** The absolute path of a track's file, only if it is a plain file name inside data/recordings (no symlink out of it). */
function trackPath(d: Deps, t: { rec_dir: string | null; file: string }): string | null {
  if (!d.dataDir || !t.rec_dir || !t.file || /[\\/\0]/.test(t.file) || t.file.startsWith('.')) return null;
  const root = path.resolve(d.dataDir, 'recordings');
  const abs = path.resolve(d.dataDir, t.rec_dir, t.file);
  if (!abs.startsWith(root + path.sep)) return null;
  try {
    const real = fs.realpathSync(abs);
    return real.startsWith(fs.realpathSync(root) + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
function send(req: any, res: Response, d: Deps, t: TrackRow & { rec_dir: string | null }, download: boolean) {
  const abs = trackPath(d, t);
  if (!abs) throw new HttpError(404, 'File not found');
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${ascii(t.file)}"; filename*=UTF-8''${encodeURIComponent(t.file)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  serveFile(req, res, abs, t.mime);
}

export const ticketUrl = (worldId: string, trackId: string, accountId: string) => `/api/media/recording/${mintTicket({ w: worldId, k: 'recording', f: trackId, a: accountId })}`;

const sessionTracks = (d: Deps, sid: string) => all<TrackRow>(d.db, "SELECT * FROM audio_tracks WHERE session_id = ? ORDER BY CASE kind WHEN 'full' THEN 0 ELSE 1 END, created_at, label", sid);
const trackOut = (worldId: string, accountId: string, t: TrackRow) => ({
  id: t.id, kind: t.kind, label: t.label, person: t.person, accountId: t.account_id, durationMs: t.duration_ms, bytes: t.bytes, file: t.file,
  url: ticketUrl(worldId, t.id, accountId),
});

function chunkBytes(d: Deps, sid: string): { n: number; bytes: number } {
  let bytes = 0; let n = 0;
  for (const c of chunkFiles(d, sid)) { n++; try { bytes += fs.statSync(path.join(d.dataDir!, c.file)).size; } catch { /* gone */ } }
  return { n, bytes };
}

function sessionView(d: Deps, s: SessionRow, accountId: string, dm: boolean, withTracks: boolean) {
  const tracks = sessionTracks(d, s.id);
  const chunks = s.audio_deleted_at ? { n: 0, bytes: 0 } : chunkBytes(d, s.id);
  const days = effectiveDays(d, s);
  const at = s.audio_deleted_at ? null : deletesAt(d, s);
  const people = [...new Set(tracks.filter((t) => t.kind === 'mic').map((t) => t.person))];
  const micNames = all<any>(d.db, `SELECT DISTINCT m.label, a.display_name FROM audio_chunks c JOIN audio_mics m ON m.id = c.mic_id JOIN accounts a ON a.id = m.account_id WHERE c.session_id = ?`, s.id);
  const prog = isBuilding(d, s.id) ? buildProgress(d, s.id) : null;
  const durationMs = s.rec_duration_ms ?? one<{ t: number | null }>(d.db, 'SELECT MAX(end_ms) AS t FROM audio_chunks WHERE session_id = ?', s.id)?.t ?? (s.stopped_at ? Date.parse(s.stopped_at) - Date.parse(s.started_at) : 0);
  return {
    id: s.id, name: s.name, date: localDate(s.started_at), startedAt: s.started_at, stoppedAt: s.stopped_at, active: !s.stopped_at,
    durationMs, status: s.rec_status ?? (chunks.n ? 'raw' : s.audio_deleted_at ? 'deleted' : 'none'),
    error: s.rec_error, warnings: parseJson<string[]>(s.rec_warnings, []), progress: prog, builtAt: s.rec_built_at,
    final: dm ? engine(d).finalView(s.id) : undefined,
    folder: dm && s.rec_dir ? s.rec_dir.replace(/\\/g, '/') : undefined,
    people: people.length ? people : [...new Set(micNames.map((m) => m.display_name))],
    mics: tracks.filter((t) => t.kind === 'mic').length || micNames.length,
    bytes: tracks.reduce((a, t) => a + t.bytes, 0) + chunks.bytes, rawChunks: chunks.n,
    retention: { mode: s.retention_mode, days: s.retention_mode === 'days' ? s.retention_days : null, effectiveDays: days, deletesAt: at, daysLeft: at ? Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 864e5)) : null },
    audioDeleted: !!s.audio_deleted_at, audioDeletedAt: s.audio_deleted_at,
    canBuild: !!s.stopped_at && !s.audio_deleted_at && chunks.n > 0 && !isBuilding(d, s.id),
    ...(withTracks ? { tracks: tracks.filter((t) => (dm ? true : t.kind === 'mic' && t.account_id === accountId)).map((t) => trackOut(s.world_id, accountId, t)) } : {}),
  };
}

export function recordingRoutes(r: Router, d: Deps) {
  const sess = (res: Response, sid: string) => {
    const s = one<SessionRow>(d.db, 'SELECT * FROM audio_sessions WHERE id = ? AND world_id = ?', sid, ctx(res).world.id);
    if (!s) throw new HttpError(404, 'Recording session not found');
    return s;
  };

  // DM: every session with its recording.
  r.get('/recordings', requireDM, async (_req, res) => {
    const c = ctx(res);
    const rows = all<SessionRow>(d.db, 'SELECT * FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC LIMIT 500', c.world.id);
    res.json({ sessions: rows.map((s) => sessionView(d, s, me(res), true, false)), ffmpeg: await ffmpegAvailable(), serverNow: now() });
  });

  // A player: the sessions they were recorded in, with only their own mic tracks.
  r.get('/recordings/mine', (_req, res) => {
    const c = ctx(res);
    const rows = all<SessionRow>(d.db, `SELECT * FROM audio_sessions s WHERE s.world_id = ? AND (
        EXISTS (SELECT 1 FROM audio_tracks t WHERE t.session_id = s.id AND t.kind = 'mic' AND t.account_id = ?)
        OR EXISTS (SELECT 1 FROM audio_chunks k JOIN audio_mics m ON m.id = k.mic_id WHERE k.session_id = s.id AND m.account_id = ?)) ORDER BY s.started_at DESC LIMIT 200`, c.world.id, me(res), me(res));
    res.json({
      sessions: rows.map((s) => {
        const v = sessionView(d, s, me(res), false, true);
        // A player sees what is theirs only: no folder, no other people, no sizes of the rest.
        return { id: v.id, name: v.name, date: v.date, startedAt: v.startedAt, stoppedAt: v.stoppedAt, active: v.active, status: v.status === 'ready' || v.status === 'deleted' ? v.status : v.active ? 'recording' : 'preparing', durationMs: v.durationMs,
          audioDeleted: v.audioDeleted, deletesAt: v.retention.deletesAt, daysLeft: v.retention.daysLeft, tracks: v.tracks };
      }),
    });
  });

  // DM: one session, with every track (and tickets to play them).
  r.get('/recordings/:sid', requireDM, (req, res) => {
    res.json(sessionView(d, sess(res, String(req.params.sid)), me(res), true, true));
  });

  r.post('/recordings/:sid/build', requireDM, async (req, res) => {
    const s = sess(res, String(req.params.sid));
    if (!s.stopped_at) throw new HttpError(409, 'Stop the recording first');
    if (s.audio_deleted_at) throw new HttpError(409, 'The audio of this session was deleted');
    if (isBuilding(d, s.id)) throw new HttpError(409, 'This recording is already being built');
    if (!chunkFiles(d, s.id).length) throw new HttpError(409, 'The raw audio chunks are gone, so there is nothing to build from');
    if (!(await ffmpegAvailable())) throw new HttpError(503, 'ffmpeg is not installed on this server (the Docker image has it)');
    enqueueBuild(d, s.id);
    audit(d, ctx(res).world.id, me(res), 'audio.build', s.id);
    res.status(202).json(sessionView(d, sess(res, s.id), me(res), true, false));
  });

  r.post('/recordings/:sid/retention', requireDM, (req, res) => {
    const s = sess(res, String(req.params.sid));
    const mode = oneOf(req.body?.mode, 'mode', ['default', 'forever', 'days'] as const);
    const days = mode === 'days' ? int(req.body?.days, 'days', { min: 1, max: 3650 }) : null;
    if (mode === 'days' && !days) throw new HttpError(400, 'days must be a whole number from 1 to 3650');
    run(d.db, 'UPDATE audio_sessions SET retention_mode = ?, retention_days = ? WHERE id = ?', mode, days, s.id);
    // The folder's session.json names the setting.
    audit(d, ctx(res).world.id, me(res), 'audio.retention', `${s.id} ${mode} ${days ?? ''}`);
    res.json(sessionView(d, sess(res, s.id), me(res), true, false));
  });

  r.post('/recordings/:sid/delete-audio', requireDM, (req, res) => {
    const s = sess(res, String(req.params.sid));
    if (req.body?.confirm !== true) throw new HttpError(400, 'Send confirm: true to delete this session\'s audio');
    if (!s.stopped_at) throw new HttpError(409, 'Stop the recording first');
    if (isBuilding(d, s.id)) throw new HttpError(409, 'This recording is being built; try again when it is done');
    const n = deleteSessionAudio(d, s);
    audit(d, ctx(res).world.id, me(res), 'audio.delete_audio', `${s.id} ${n} files`);
    res.json({ removed: n, session: sessionView(d, sess(res, s.id), me(res), true, false) });
  });

  // The audio itself, by track id, with the sign-in header. A player: own mics only (403 otherwise).
  r.get('/recordings/tracks/:tid/file', (req, res) => {
    const t = trackById(d, String(req.params.tid));
    if (!t || t.world_id !== ctx(res).world.id) throw new HttpError(404, 'File not found');
    if (!mayHear(d, ctx(res).world.id, me(res), t)) throw new HttpError(403, 'That recording is not yours to play');
    send(req, res, d, t, req.query.download === '1');
  });
}

/** <audio> and <a download> cannot send the sign-in header: a signed ticket names one track and one account and is checked again on every request. */
export function recordingMedia(app: Express, d: Deps) {
  app.get('/api/media/recording/:ticket', (req, res) => {
    const t = readTicket(String(req.params.ticket));
    if (!t || t.k !== 'recording') throw new HttpError(404, 'File not found');
    const track = trackById(d, t.f);
    if (!track || !mayHear(d, t.w, t.a, track)) throw new HttpError(404, 'File not found');
    send(req, res, d, track, req.query.download === '1');
  });
}
