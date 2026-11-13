// Spotify: sign in with Authorization Code + PKCE, map events to playlists,
// start a playlist on the DM's own active Spotify device. Everything goes
// through Deps.fetch so tests use a fake. Spotify audio is never sent to
// players: this only controls the DM's Spotify app.
import { createHash, randomBytes } from 'node:crypto';
import type { Deps } from '../../app.ts';
import { one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = 'user-modify-playback-state user-read-playback-state';

const b64url = (b: Buffer) => b.toString('base64url');
const row = (d: Deps, worldId: string) => one<any>(d.db, 'SELECT * FROM sound_spotify WHERE world_id = ?', worldId);

function ensure(d: Deps, worldId: string) {
  run(d.db, 'INSERT OR IGNORE INTO sound_spotify (world_id) VALUES (?)', worldId);
  return row(d, worldId)!;
}

/** What the DM page may see: never a token. */
export function spotifyStatus(d: Deps, worldId: string) {
  const r = row(d, worldId);
  return {
    clientId: r?.client_id ?? '',
    connected: !!r?.refresh_token,
    events: r?.events ? JSON.parse(r.events) : {},
  };
}

export function setClientId(d: Deps, worldId: string, clientId: string) {
  if (!/^[A-Za-z0-9]{8,64}$/.test(clientId)) throw new HttpError(400, 'That does not look like a Spotify client id');
  const r = ensure(d, worldId);
  // A new client id invalidates the old sign-in.
  if (r.client_id !== clientId) run(d.db, 'UPDATE sound_spotify SET client_id = ?, refresh_token = NULL, access_token = NULL, expires_at = NULL, pending = NULL WHERE world_id = ?', clientId, worldId);
}

export function loginUrl(d: Deps, worldId: string, redirectUri: string): string {
  const r = row(d, worldId);
  if (!r?.client_id) throw new HttpError(400, 'Save your Spotify client id first');
  if (!/^https?:\/\/[^\s]+$/.test(redirectUri)) throw new HttpError(400, 'redirectUri must be an http(s) address');
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(18));
  run(d.db, 'UPDATE sound_spotify SET pending = ? WHERE world_id = ?', JSON.stringify({ verifier, state, redirectUri, at: Date.now() }), worldId);
  const q = new URLSearchParams({
    response_type: 'code', client_id: r.client_id, redirect_uri: redirectUri, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: b64url(createHash('sha256').update(verifier).digest()), state,
  });
  return `${AUTH}?${q}`;
}

async function tokenCall(d: Deps, form: Record<string, string>) {
  let r: Response;
  try {
    r = await d.fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  } catch (e: any) { throw new HttpError(502, `Could not reach Spotify: ${String(e?.message ?? e).slice(0, 120)}`); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new HttpError(r.status === 400 || r.status === 401 ? 400 : 502, `Spotify refused the sign-in${j.error_description ? `: ${String(j.error_description).slice(0, 120)}` : ''}`);
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

export async function finishLogin(d: Deps, worldId: string, code: string, state: string) {
  const r = row(d, worldId);
  const p = r?.pending ? JSON.parse(r.pending) : null;
  if (!r || !p || p.state !== state || Date.now() - p.at > 15 * 60_000) throw new HttpError(400, 'This sign-in expired or did not start here. Start again.');
  const j = await tokenCall(d, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: r.client_id, code_verifier: p.verifier });
  run(d.db, 'UPDATE sound_spotify SET refresh_token = ?, access_token = ?, expires_at = ?, pending = NULL WHERE world_id = ?',
    j.refresh_token ?? null, j.access_token, Date.now() + (j.expires_in ?? 3600) * 1000 - 30_000, worldId);
}

async function accessToken(d: Deps, worldId: string, force = false): Promise<string> {
  const r = row(d, worldId);
  if (!r?.refresh_token) throw new HttpError(409, 'Spotify is not connected');
  if (!force && r.access_token && r.expires_at > Date.now()) return r.access_token;
  const j = await tokenCall(d, { grant_type: 'refresh_token', refresh_token: r.refresh_token, client_id: r.client_id });
  run(d.db, 'UPDATE sound_spotify SET access_token = ?, expires_at = ?, refresh_token = COALESCE(?, refresh_token) WHERE world_id = ?',
    j.access_token, Date.now() + (j.expires_in ?? 3600) * 1000 - 30_000, j.refresh_token ?? null, worldId);
  return j.access_token;
}

/** A playlist, album or artist link or URI → spotify:<kind>:<id>. */
export function normalizeUri(v: string): string {
  const s = v.trim();
  const m = /^spotify:(playlist|album|artist|show):([A-Za-z0-9]{10,40})$/.exec(s) ?? /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|artist|show)\/([A-Za-z0-9]{10,40})/.exec(s);
  if (!m) throw new HttpError(400, `"${s.slice(0, 60)}" is not a Spotify playlist link or URI`);
  return `spotify:${m[1]}:${m[2]}`;
}

export function setEvents(d: Deps, worldId: string, events: unknown) {
  if (!events || typeof events !== 'object' || Array.isArray(events)) throw new HttpError(400, 'events must be an object of event name to playlist');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(events as Record<string, unknown>)) {
    const name = k.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(name)) throw new HttpError(400, `"${k}" is not a usable event name`);
    if (typeof v !== 'string') throw new HttpError(400, `${k} needs a playlist link`);
    if (v.trim()) out[name] = normalizeUri(v);
  }
  if (Object.keys(out).length > 60) throw new HttpError(400, 'Too many events');
  ensure(d, worldId);
  run(d.db, 'UPDATE sound_spotify SET events = ? WHERE world_id = ?', JSON.stringify(out), worldId);
  return out;
}

export async function playEvent(d: Deps, worldId: string, event: string) {
  const r = row(d, worldId);
  const uri = r?.events ? JSON.parse(r.events)[event.trim().toLowerCase()] : null;
  if (!uri) throw new HttpError(404, `No playlist is mapped to "${event}"`);
  const go = async (tok: string) => {
    try {
      return await d.fetch(`${API}/me/player/play`, { method: 'PUT', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ context_uri: uri }) });
    } catch (e: any) { throw new HttpError(502, `Could not reach Spotify: ${String(e?.message ?? e).slice(0, 120)}`); }
  };
  let resp = await go(await accessToken(d, worldId));
  if (resp.status === 401) resp = await go(await accessToken(d, worldId, true));
  if (resp.status === 204 || resp.status === 200 || resp.status === 202) return { ok: true, event, uri, at: now() };
  if (resp.status === 404) throw new HttpError(409, 'Spotify has no active device. Open Spotify on your computer or phone, start any song once, then try again.');
  if (resp.status === 403) throw new HttpError(403, 'Spotify refused: playing from here needs Spotify Premium.');
  if (resp.status === 429) throw new HttpError(429, 'Spotify says wait a moment.');
  throw new HttpError(502, `Spotify answered ${resp.status}`);
}

export function disconnect(d: Deps, worldId: string) {
  run(d.db, 'UPDATE sound_spotify SET refresh_token = NULL, access_token = NULL, expires_at = NULL, pending = NULL WHERE world_id = ?', worldId);
}
