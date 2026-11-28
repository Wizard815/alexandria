// NPC voices: when the GM turns it on, what an NPC says in an encounter is read aloud on that player's device only
// (the other players do not hear a private talk), in the NPC's own voice preset or the default NPC voice. A quick
// event's prompt can be read aloud too, to the players it went to. Nothing new is revealed: a voiced line is the
// same text that player already sees on screen.
//
// Lines are spoken once. The last spoken line of each encounter (and each quick event) is kept in voice_spoken, so
// a restart or a later change to the encounter does not repeat what was already said.
import type { Deps } from '../../app.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { one, run } from '../../core/db.ts';
import { now, parseJson } from '../../core/util.ts';
import { findPreset, speakLine, type Preset } from './line.ts';

export const npcSchema = `
CREATE TABLE IF NOT EXISTS voice_npcs (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  npc TEXT NOT NULL,
  name TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  PRIMARY KEY (world_id, npc)
);
CREATE TABLE IF NOT EXISTS voice_spoken (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  last_at TEXT NOT NULL DEFAULT '',
  last_text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (world_id, key)
);
`;

export const npcKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

const settingsOf = (d: Deps, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) });

/** The preset an NPC speaks with: their own, else the world's default NPC voice. */
export function presetForNpc(d: Deps, worldId: string, npcName: string, s: WorldSettings): Preset | undefined {
  const own = one<{ preset_id: string }>(d.db, 'SELECT preset_id FROM voice_npcs WHERE world_id = ? AND npc = ?', worldId, npcKey(npcName));
  return (own && findPreset(d, worldId, own.preset_id)) || findPreset(d, worldId, featureSetting<string>(s, 'npcVoicePreset') ?? '');
}

interface Line { who: string; text: string; at: string }
/** An encounter's NPC lines (the script's and the GM's live ones) after the last one spoken. */
function newLines(log: Line[], last: { last_at: string; last_text: string } | undefined): Line[] {
  const said = log.filter((l) => (l.who === 'npc' || l.who === 'gm') && l.text?.trim());
  if (!last) return said;
  let i = said.length - 1;
  while (i >= 0 && !(said[i].at === last.last_at && said[i].text === last.last_text)) i--;
  return i >= 0 ? said.slice(i + 1) : said.filter((l) => l.at > last.last_at);
}

const OLD_MS = 10 * 60_000;
const errors = (e: unknown) => { if (process.env.ALX_DEBUG_VOICE) console.warn('npc voice:', e); };

/** Speak what is new in one encounter, to that encounter's player. */
export function onEncounter(d: Deps, worldId: string, encounterId: string) {
  const e = one<any>(d.db, 'SELECT * FROM encounters WHERE id = ? AND world_id = ?', encounterId, worldId);
  if (!e) return;
  const key = `enc:${e.id}`;
  const last = one<{ last_at: string; last_text: string }>(d.db, 'SELECT last_at, last_text FROM voice_spoken WHERE world_id = ? AND key = ?', worldId, key);
  const lines = newLines(parseJson<Line[]>(e.log, []), last);
  if (!lines.length) return;
  const mark = lines.at(-1)!;
  run(d.db, 'INSERT INTO voice_spoken (world_id, key, last_at, last_text) VALUES (?, ?, ?, ?) ON CONFLICT (world_id, key) DO UPDATE SET last_at = excluded.last_at, last_text = excluded.last_text', worldId, key, mark.at, mark.text);
  const s = settingsOf(d, worldId);
  // Off, a finished talk, or one first seen long after it started (lines from before voices were on): marked, not spoken.
  if (featureSetting<boolean>(s, 'npcVoices') !== true || e.status !== 'open') return;
  if (!last && Date.parse(lines[0].at) < Date.now() - OLD_MS) return;
  const p = presetForNpc(d, worldId, e.npc_name, s);
  if (!p) return;
  speakLine(d, worldId, lines.map((l) => l.text).join('\n'), p, 'players', [e.account_id], e.npc_name).catch(errors);
}

/** Read a new quick event's prompt to the players it went to, once. */
export function onQuickEvent(d: Deps, worldId: string, ev: any) {
  if (!ev?.id || ev.status !== 'open' || !Array.isArray(ev.audience) || !ev.audience.length) return;
  const s = settingsOf(d, worldId);
  const p = findPreset(d, worldId, featureSetting<string>(s, 'quickEventVoicePreset') ?? '');
  if (!p) return;
  const key = `qe:${ev.id}`;
  if (one(d.db, 'SELECT 1 FROM voice_spoken WHERE world_id = ? AND key = ?', worldId, key)) return;
  run(d.db, 'INSERT INTO voice_spoken (world_id, key, last_at, last_text) VALUES (?, ?, ?, ?)', worldId, key, now(), '');
  const text = [ev.title, ev.prompt].map((x) => String(x ?? '').trim()).filter(Boolean).join('. ');
  if (text) speakLine(d, worldId, text, p, 'players', ev.audience.map(String), p.name).catch(errors);
}

/** Server listener: encounters and quick events as they change. */
export function startNpcVoices(d: Deps): () => void {
  return d.hub.tap((worldId, type, data: any) => {
    if (type === 'encounter' && typeof data?.id === 'string') queueMicrotask(() => { try { onEncounter(d, worldId, data.id); } catch (e) { errors(e); } });
    else if (type === 'quick-event') queueMicrotask(() => { try { onQuickEvent(d, worldId, data); } catch (e) { errors(e); } });
  });
}
