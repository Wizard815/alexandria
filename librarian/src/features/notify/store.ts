// Who wants which notifications. One choice per person, for all their devices; the
// devices themselves (a browser's web push subscription, the Android background check)
// are turned on per device.
import type { DB } from '../../core/db.ts';
import { one, run } from '../../core/db.ts';
import { now, parseJson } from '../../core/util.ts';

export const KINDS = ['turn', 'quick', 'night', 'reply', 'request'] as const;
export type Kind = (typeof KINDS)[number];
export type Kinds = Record<Kind, boolean>;
export const DEFAULT_KINDS: Kinds = { turn: true, quick: true, night: true, reply: true, request: true };

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS notify_prefs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  prefs TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_ok_at TEXT
);
CREATE INDEX IF NOT EXISTS push_subs_account ON push_subs(account_id);
CREATE TABLE IF NOT EXISTS push_seen (
  account_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (account_id, alert_id)
);
CREATE TABLE IF NOT EXISTS push_vapid (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_pem TEXT NOT NULL
);
`;

export function kindsFor(db: DB, accountId: string): Kinds {
  const row = (() => { try { return one<{ prefs: string }>(db, 'SELECT prefs FROM notify_prefs WHERE account_id = ?', accountId); } catch { return undefined; } })();
  const p = parseJson<Partial<Kinds>>(row?.prefs, {});
  const out = { ...DEFAULT_KINDS };
  for (const k of KINDS) if (typeof p[k] === 'boolean') out[k] = p[k]!;
  return out;
}

export function setKinds(db: DB, accountId: string, patch: Partial<Record<string, unknown>>): Kinds {
  const cur = kindsFor(db, accountId);
  for (const k of KINDS) if (typeof patch[k] === 'boolean') cur[k] = patch[k] as boolean;
  run(db, `INSERT INTO notify_prefs (account_id, prefs, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`, accountId, JSON.stringify(cur), now());
  return cur;
}
