// One spoken line: the voice model reads text with a preset, the audio is kept under the data folder for a day,
// and a `sound` event (channel 'voice') tells the table and players' devices to play it. A line meant for some
// players only (an NPC talking to one player) is served to those players and the DM, and to no one else.
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { ModelUnavailable, speak } from '../../core/ai.ts';
import { HttpError, id as newId, now, parseJson } from '../../core/util.ts';
import { MIME, sniff } from '../sound/files.ts';
import { sendSound, toPlayers, type SoundEvent, type Target } from '../sound/send.ts';

export interface Preset { id: string; name: string; voice: string; speed: number; pitch: number; effect: string; target: Target }

const PLAYER_WINDOW_MS = 60 * 60_000;
const NAME = /^v_[A-Za-z0-9_-]+\.(mp3|ogg|wav|flac|m4a)$/;

/** The voice_files.accounts column (older databases do not have it). */
export function migrateVoice(db: Deps['db']) {
  const cols = (db.prepare('PRAGMA table_info(voice_files)').all() as any[]).map((c) => c.name);
  if (cols.length && !cols.includes('accounts')) db.exec('ALTER TABLE voice_files ADD COLUMN accounts TEXT');
}

/** A preset by id, or by name (case does not matter). */
export function findPreset(d: Deps, worldId: string, idOrName: string): Preset | undefined {
  const want = idOrName.trim();
  if (!want) return undefined;
  return one<Preset>(d.db, 'SELECT * FROM voice_presets WHERE id = ? AND world_id = ?', want, worldId)
    ?? all<Preset>(d.db, 'SELECT * FROM voice_presets WHERE world_id = ?', worldId).find((x) => String(x.name).toLowerCase() === want.toLowerCase());
}

/**
 * The spoken line, if this person may hear it: the DM always; a player only if it went to players within the last
 * hour and, for a line meant for some players, they are one of them.
 */
export function lineFor(d: Deps, worldId: string, dm: boolean, name: string, accountId: string) {
  if (!NAME.test(name) || !d.dataDir) return null;
  const row = one<any>(d.db, 'SELECT * FROM voice_files WHERE world_id = ? AND name = ?', worldId, name);
  if (!row) return null;
  if (!dm) {
    if (!toPlayers(row.target) || Date.parse(row.created_at) < Date.now() - PLAYER_WINDOW_MS) return null;
    const who = parseJson<string[] | null>(row.accounts, null);
    if (who && !who.includes(accountId)) return null;
  }
  return { abs: path.join(d.dataDir, 'voice', name), mime: MIME[name.split('.').pop()!] };
}

/** Read text aloud with a preset and play it. Throws HttpError 503 when no voice model answers. */
export async function speakLine(d: Deps, worldId: string, text: string, p: Preset, target: Target, accounts?: string[], label = p.name): Promise<{ file: string; event: SoundEvent }> {
  if (!d.dataDir) throw new HttpError(503, 'The gateway has no data folder for voice audio');
  let out: { audio: Uint8Array; mime: string };
  try {
    out = await speak(d, text.slice(0, 2000), { voice: p.voice || undefined, speed: p.speed, format: 'wav' });
  } catch (e) {
    if (e instanceof ModelUnavailable) throw new HttpError(503, `Read aloud is not available: ${e.message}`);
    throw e;
  }
  const type = sniff(out.audio);
  if (!type) throw new HttpError(502, 'The voice model sent audio that cannot be played');
  const dir = path.join(d.dataDir, 'voice');
  fs.mkdirSync(dir, { recursive: true });
  // Tidy up spoken lines from more than a day ago.
  for (const f of all<any>(d.db, 'SELECT world_id, name FROM voice_files WHERE created_at < ?', new Date(Date.now() - 86_400_000).toISOString())) {
    try { fs.rmSync(path.join(dir, f.name), { force: true }); } catch { /* ignore */ }
    run(d.db, 'DELETE FROM voice_files WHERE world_id = ? AND name = ?', f.world_id, f.name);
  }
  const name = `${newId('v_')}.${type}`;
  fs.writeFileSync(path.join(dir, name), out.audio);
  run(d.db, 'INSERT INTO voice_files (world_id, name, target, created_at, accounts) VALUES (?, ?, ?, ?, ?)', worldId, name, target, now(), accounts ? JSON.stringify(accounts) : null);
  const event = sendSound(d, worldId, {
    channel: 'voice', action: 'play', url: `/api/worlds/${worldId}/voice/file/${name}`, volume: 1, loop: false, fadeMs: 0, target,
    effect: p.effect, pitch: p.pitch, label,
  }, accounts);
  return { file: name, event };
}
