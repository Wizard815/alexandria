// Source keys (PLAN §17): who may read a world's source with which key.
//
// A key is a secret for ONE source of ONE world, added by a player (their own)
// or by the GM (any number, with users, uses and trust set by the GM). The
// secret is stored here and never returned; every use is audited.
//
//   trust  per-user  the source gives each key only what its user may see.
//          blanket   every key sees everything: treated as GM-level.
//          unsure    not known: treated as blanket (fails closed).
//
// Only a verified, live key can be used, and only by an account named in
// `users`, for a use named in `uses`. Everything here reads the live row, so
// revoking a key, or changing its trust, users or uses, takes effect at once.
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { id, now, parseJson } from '../../core/util.ts';
import { libraryOf } from '../../core/library.ts';

export const USES = ['library', 'agent', 'broker'] as const;
export type KeyUse = (typeof USES)[number];
export const TRUSTS = ['per-user', 'blanket', 'unsure'] as const;
export type Trust = (typeof TRUSTS)[number];
export const SECRET_MASK = '••••';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sourcekeys_keys (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'unsure',
  claimed TEXT NOT NULL DEFAULT 'unsure',
  users TEXT NOT NULL DEFAULT '[]',
  uses TEXT NOT NULL DEFAULT '[]',
  verified INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  probe TEXT NOT NULL DEFAULT '{}',
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  revoked_by TEXT,
  refreshed_at TEXT,
  refresh_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sourcekeys_keys_world ON sourcekeys_keys (world_id, revoked);
-- page_access(world, page, account): the pages a person's own per-user key can see (ids only, never text).
CREATE TABLE IF NOT EXISTS sourcekeys_access (
  world_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  PRIMARY KEY (world_id, page_id, account_id, key_id)
);
CREATE INDEX IF NOT EXISTS sourcekeys_access_key ON sourcekeys_access (key_id);
-- Page shares: a player (kind share) or the GM (kind gm) lets others open the player copy of a page.
-- to_id is an account id, or '*' for the whole party. A share is read live (core/library.ts liftedInfo): it only counts while the sharer can still see the page.
CREATE TABLE IF NOT EXISTS sourcekeys_shares (
  world_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (world_id, page_id, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS sourcekeys_shares_to ON sourcekeys_shares (world_id, to_id);
-- Questions a player's own view could not answer. hidden is for the GM only.
CREATE TABLE IF NOT EXISTS sourcekeys_escalations (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  question TEXT NOT NULL,
  origin TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  hidden TEXT NOT NULL DEFAULT '{}',
  broker_request_id TEXT,
  answer TEXT,
  cost_cp INTEGER,
  sessions INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS sourcekeys_esc_world ON sourcekeys_escalations (world_id, status);
`;

export interface KeyRow {
  id: string; world_id: string; source_id: string; owner_id: string; label: string; secret: string;
  trust: string; claimed: string; users: string; uses: string; verified: number; checked_at: string | null; probe: string;
  revoked: number; revoked_at: string | null; revoked_by: string | null; refreshed_at: string | null; refresh_note: string; created_at: string;
}

export const normTrust = (v: unknown): Trust => (v === 'per-user' || v === 'blanket' ? v : 'unsure');
/** Only `per-user` is trusted. Blanket and unsure are the same thing: GM-level. */
export const isPerUser = (k: Pick<KeyRow, 'trust'>) => k.trust === 'per-user';
export const usersOf = (k: Pick<KeyRow, 'users'>): string[] => { const v = parseJson<unknown>(k.users, []); return Array.isArray(v) ? v.map(String) : []; };
export const usesOf = (k: Pick<KeyRow, 'uses'>): KeyUse[] => { const v = parseJson<unknown>(k.uses, []); return Array.isArray(v) ? v.filter((x): x is KeyUse => USES.includes(x as KeyUse)) : []; };
export const cleanUses = (v: unknown): KeyUse[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is KeyUse => USES.includes(x as KeyUse)))] : []);

export const getKey = (db: DB, worldId: string, keyId: string): KeyRow | null => one<KeyRow>(db, 'SELECT * FROM sourcekeys_keys WHERE id = ? AND world_id = ?', keyId, worldId) ?? null;

/** Keys of a world, newest first. */
export const worldKeys = (db: DB, worldId: string): KeyRow[] => all<KeyRow>(db, 'SELECT * FROM sourcekeys_keys WHERE world_id = ? ORDER BY created_at DESC', worldId);

/** What a key may be used for right now by this account: live, verified, named user, named use. */
export function usable(k: KeyRow, accountId: string, use: KeyUse): boolean {
  return !k.revoked && !!k.verified && usersOf(k).includes(accountId) && usesOf(k).includes(use);
}

/** Keys this account may use for this use in this world (and source, when given). */
export function keysFor(db: DB, worldId: string, accountId: string, use: KeyUse, sourceId?: string): KeyRow[] {
  return worldKeys(db, worldId).filter((k) => (!sourceId || k.source_id === sourceId) && usable(k, accountId, use));
}

/** Every use of a key goes in the audit log: key id, account and use. Never the secret. */
export function auditUse(db: DB, k: Pick<KeyRow, 'id' | 'world_id'>, accountId: string | null, use: string, detail = '') {
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', k.world_id, accountId, 'sourcekeys.use', `key ${k.id} for ${use}${detail ? ` ${detail}` : ''}`.slice(0, 480), now());
}

export function auditKey(db: DB, worldId: string, accountId: string | null, action: string, detail: string) {
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, `sourcekeys.${action}`, detail.slice(0, 480), now());
}

export function insertKey(db: DB, a: { worldId: string; sourceId: string; ownerId: string; label: string; secret: string; trust: Trust; claimed: Trust; users: string[]; uses: KeyUse[]; verified: boolean; probe: unknown }): KeyRow {
  const kid = id('skey_');
  run(db, `INSERT INTO sourcekeys_keys (id, world_id, source_id, owner_id, label, secret, trust, claimed, users, uses, verified, checked_at, probe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    kid, a.worldId, a.sourceId, a.ownerId, a.label, a.secret, a.trust, a.claimed, JSON.stringify(a.users), JSON.stringify(a.uses), a.verified ? 1 : 0, now(), JSON.stringify(a.probe ?? {}), now());
  return getKey(db, a.worldId, kid)!;
}

/** Revoke: the key stops working at once, its access sets go, and its secret is wiped. */
export function revokeKey(db: DB, k: KeyRow, by: string) {
  run(db, `UPDATE sourcekeys_keys SET revoked = 1, revoked_at = ?, revoked_by = ?, secret = '' WHERE id = ?`, now(), by, k.id);
  run(db, 'DELETE FROM sourcekeys_access WHERE key_id = ?', k.id);
  libraryOf(db)?.changed(k.world_id);
}

/** The key as an API client sees it: the secret is only ever a mask. */
export function keyView(db: DB, k: KeyRow, names: Record<string, string>, opts: { gm: boolean }) {
  const src = one<any>(db, 'SELECT name, kind FROM sources WHERE id = ?', k.source_id);
  const probe = parseJson<Record<string, unknown>>(k.probe, {});
  const out: Record<string, unknown> = {
    id: k.id, sourceId: k.source_id, sourceName: src?.name ?? null, sourceKind: src?.kind ?? null, label: k.label, secret: k.revoked ? '' : SECRET_MASK,
    ownerId: k.owner_id, ownerName: names[k.owner_id] ?? 'Someone', trust: k.trust, claimed: k.claimed,
    /** What the key is treated as: only `per-user` is trusted. */
    treatedAs: isPerUser(k) ? 'per-user' : 'blanket',
    users: usersOf(k), uses: usesOf(k),
    verified: { matchedWorld: !!k.verified, checkedAt: k.checked_at }, revoked: !!k.revoked, revokedAt: k.revoked_at,
    refreshedAt: k.refreshed_at, createdAt: k.created_at,
  };
  if (opts.gm) { out.userNames = usersOf(k).map((u) => names[u] ?? 'Someone'); out.probe = probe; out.refreshNote = k.refresh_note; out.pagesSeen = one<any>(db, 'SELECT COUNT(DISTINCT page_id) AS n FROM sourcekeys_access WHERE key_id = ?', k.id)?.n ?? 0; }
  else { out.probe = { verdict: probe.verdict ?? 'unknown' }; out.pagesSeen = one<any>(db, 'SELECT COUNT(DISTINCT page_id) AS n FROM sourcekeys_access WHERE key_id = ?', k.id)?.n ?? 0; }
  return out;
}
