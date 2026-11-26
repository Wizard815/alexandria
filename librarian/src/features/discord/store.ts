// What the Discord bot keeps: each world's bot settings, which Discord user
// is which player, one-time link codes, and what was already posted (so a
// restart never posts a recap twice).
import { randomInt } from 'node:crypto';
import { all, one, run, type DB } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import type { Viewer } from '../../core/policy.ts';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS discord_worlds (
    world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    token TEXT,
    guild_id TEXT,
    recap_channel TEXT,
    roll_channel TEXT,
    post_recaps INTEGER NOT NULL DEFAULT 1,
    post_rolls INTEGER NOT NULL DEFAULT 1,
    broker_dms INTEGER NOT NULL DEFAULT 1,
    broker_text INTEGER NOT NULL DEFAULT 1,
    helper INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discord_links (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    discord_user TEXT NOT NULL,
    discord_name TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (world_id, discord_user),
    UNIQUE (world_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS discord_codes (
    code TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discord_posts (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (world_id, ref)
  );
`;

export interface Config {
  worldId: string;
  enabled: boolean;
  token: string | null;
  guildId: string | null;
  recapChannel: string | null;
  rollChannel: string | null;
  postRecaps: boolean;
  postRolls: boolean;
  brokerDms: boolean;
  brokerText: boolean;
  helper: boolean;
}

const toConfig = (r: any): Config => ({
  worldId: r.world_id, enabled: !!r.enabled, token: r.token || null, guildId: r.guild_id || null,
  recapChannel: r.recap_channel || null, rollChannel: r.roll_channel || null,
  postRecaps: !!r.post_recaps, postRolls: !!r.post_rolls, brokerDms: !!r.broker_dms, brokerText: !!r.broker_text, helper: !!r.helper,
});

export function configOf(db: DB, worldId: string): Config | null {
  const r = one<any>(db, 'SELECT * FROM discord_worlds WHERE world_id = ?', worldId);
  return r ? toConfig(r) : null;
}

/** Worlds whose bot should be running: switched on, with a token and a server. */
export function liveConfigs(db: DB): Config[] {
  return all<any>(db, `SELECT * FROM discord_worlds WHERE enabled = 1 AND token IS NOT NULL AND token <> '' AND guild_id IS NOT NULL AND guild_id <> ''`).map(toConfig);
}

const SNOWFLAKE = /^\d{15,22}$/;
/** A Discord id (server, channel, user), or null for empty. */
export function snowflake(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!SNOWFLAKE.test(s)) throw new HttpError(400, `${field} must be a Discord id (turn on Developer Mode in Discord, then right-click → Copy ID)`);
  return s;
}

/** Bot tokens are three dot-separated base64url parts. */
export function botToken(v: unknown): string {
  const s = String(v ?? '').trim().replace(/^Bot\s+/i, '');
  if (!/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(s)) throw new HttpError(400, 'That does not look like a bot token. Copy it from the Developer Portal: your app → Bot → Reset Token.');
  return s;
}

export function saveConfig(db: DB, worldId: string, patch: Partial<Omit<Config, 'worldId'>>) {
  const cur = configOf(db, worldId) ?? { worldId, enabled: true, token: null, guildId: null, recapChannel: null, rollChannel: null, postRecaps: true, postRolls: true, brokerDms: true, brokerText: true, helper: true };
  const c = { ...cur, ...patch };
  if (c.guildId) {
    const other = one<any>(db, 'SELECT world_id FROM discord_worlds WHERE guild_id = ? AND world_id <> ? AND enabled = 1', c.guildId, worldId);
    if (other) throw new HttpError(409, 'Another world on this server already uses that Discord server');
  }
  run(db, `INSERT INTO discord_worlds (world_id, enabled, token, guild_id, recap_channel, roll_channel, post_recaps, post_rolls, broker_dms, broker_text, helper, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (world_id) DO UPDATE SET enabled = excluded.enabled, token = excluded.token, guild_id = excluded.guild_id, recap_channel = excluded.recap_channel,
      roll_channel = excluded.roll_channel, post_recaps = excluded.post_recaps, post_rolls = excluded.post_rolls, broker_dms = excluded.broker_dms,
      broker_text = excluded.broker_text, helper = excluded.helper, updated_at = excluded.updated_at`,
    worldId, c.enabled ? 1 : 0, c.token, c.guildId, c.recapChannel, c.rollChannel, c.postRecaps ? 1 : 0, c.postRolls ? 1 : 0, c.brokerDms ? 1 : 0, c.brokerText ? 1 : 0, c.helper ? 1 : 0, now());
  return configOf(db, worldId)!;
}

// ---- links ----

// No 0/O, 1/I/L: a code is read off one screen and typed on another.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_MINUTES = 10;

export function newCode(db: DB, worldId: string, accountId: string): { code: string; expiresAt: string } {
  run(db, 'DELETE FROM discord_codes WHERE expires_at < ? OR (world_id = ? AND account_id = ?)', now(), worldId, accountId);
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000).toISOString();
  run(db, 'INSERT INTO discord_codes (code, world_id, account_id, expires_at) VALUES (?, ?, ?, ?)', code, worldId, accountId, expiresAt);
  return { code, expiresAt };
}

/** Use a code typed in Discord: links that Discord user to the code's account, once. */
export function useCode(db: DB, worldId: string, raw: string, discordUser: string, discordName: string): { accountId: string } | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const c = one<any>(db, 'SELECT * FROM discord_codes WHERE code = ? AND world_id = ?', code, worldId);
  if (!c || c.expires_at < now()) return null;
  run(db, 'DELETE FROM discord_codes WHERE code = ?', code);
  if (!roleOf(db, worldId, c.account_id)) return null;
  run(db, 'DELETE FROM discord_links WHERE world_id = ? AND (discord_user = ? OR account_id = ?)', worldId, discordUser, c.account_id);
  run(db, 'INSERT INTO discord_links (world_id, discord_user, discord_name, account_id, linked_at) VALUES (?, ?, ?, ?, ?)', worldId, discordUser, discordName.slice(0, 100), c.account_id, now());
  return { accountId: c.account_id };
}

export const roleOf = (db: DB, worldId: string, accountId: string): Viewer['role'] | null =>
  (one<any>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, accountId)?.role as Viewer['role']) ?? null;

/** Who a Discord user is in this world, checked on every command: a link only counts while its account is still a member. */
export function whoIs(db: DB, worldId: string, discordUser: string): { accountId: string; role: Viewer['role']; name: string } | null {
  const r = one<any>(db, `SELECT l.account_id, m.role, COALESCE(NULLIF(m.character_name, ''), a.display_name) AS name
    FROM discord_links l JOIN members m ON m.world_id = l.world_id AND m.account_id = l.account_id JOIN accounts a ON a.id = l.account_id
    WHERE l.world_id = ? AND l.discord_user = ?`, worldId, discordUser);
  return r ? { accountId: r.account_id, role: r.role, name: r.name } : null;
}

export function discordUserOf(db: DB, worldId: string, accountId: string): string | null {
  return one<any>(db, 'SELECT discord_user FROM discord_links WHERE world_id = ? AND account_id = ?', worldId, accountId)?.discord_user ?? null;
}

export function linksOf(db: DB, worldId: string) {
  return all<any>(db, `SELECT l.account_id, l.discord_user, l.discord_name, l.linked_at, m.role, COALESCE(NULLIF(m.character_name, ''), a.display_name) AS name
    FROM discord_links l JOIN accounts a ON a.id = l.account_id LEFT JOIN members m ON m.world_id = l.world_id AND m.account_id = l.account_id
    WHERE l.world_id = ? ORDER BY name`, worldId)
    .map((r) => ({ accountId: r.account_id, name: r.name, role: r.role ?? null, discordUser: r.discord_user, discordName: r.discord_name, linkedAt: r.linked_at }));
}

/** True the first time a ref is seen for a world (and records it). */
export function firstPost(db: DB, worldId: string, ref: string): boolean {
  return run(db, "INSERT OR IGNORE INTO discord_posts (world_id, ref, at) VALUES (?, ?, ?)", worldId, ref, now()) > 0;
}
