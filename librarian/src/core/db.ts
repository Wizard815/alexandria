// SQLite storage for the librarian. Uses Node's built-in node:sqlite, so
// there is no native module to build. One database holds every world.
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  theme TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('admin', 'scribe')),
  world_id TEXT REFERENCES worlds(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  access TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write'))
);

CREATE TABLE IF NOT EXISTS reset_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('dm', 'player', 'guest')),
  character_name TEXT,
  PRIMARY KEY (world_id, account_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('player', 'guest')),
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('vault', 'git', 'kanka', 'mcp')),
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  default_visibility TEXT NOT NULL DEFAULT 'dm',
  last_sync_at TEXT,
  last_status TEXT
);

-- body is the DM copy. player_body is computed at write time by the leak
-- guard and is NULL unless the page is shared with the party.
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'dm',
  frontmatter TEXT NOT NULL DEFAULT '{}',
  player_frontmatter TEXT,
  body TEXT NOT NULL DEFAULT '',
  player_body TEXT,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE (world_id, path)
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_dm USING fts5(page_id UNINDEXED, world_id UNINDEXED, title, body);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_party USING fts5(page_id UNINDEXED, world_id UNINDEXED, title, body);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_title TEXT NOT NULL,
  to_title TEXT NOT NULL,
  kind TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'dm',
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'new', 'question')),
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('dm', 'party')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  reply TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  starter_id TEXT NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  kept INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, account_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  body TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quick_events (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  audience TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  skill TEXT,
  dc INTEGER,
  success_text TEXT,
  fail_text TEXT,
  public_votes INTEGER NOT NULL DEFAULT 0,
  timer_s INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'cancelled')),
  created_at TEXT NOT NULL,
  closes_at TEXT
);
CREATE TABLE IF NOT EXISTS quick_responses (
  event_id TEXT NOT NULL REFERENCES quick_events(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  choice INTEGER,
  roll INTEGER,
  total INTEGER,
  at TEXT NOT NULL,
  result TEXT,
  PRIMARY KEY (event_id, account_id)
);

CREATE TABLE IF NOT EXISTS cal_sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cal_rsvps (
  session_id TEXT NOT NULL REFERENCES cal_sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  answer TEXT NOT NULL CHECK (answer IN ('yes', 'maybe', 'no')),
  at TEXT NOT NULL,
  PRIMARY KEY (session_id, account_id)
);
CREATE TABLE IF NOT EXISTS cal_chat (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cal_sessions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cal_reschedules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cal_sessions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  reason TEXT NOT NULL,
  proposed TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'declined')),
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  location TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id)
);

-- owner is 'party' or an account id. amounts are in copper.
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  amount_cp INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  session_label TEXT,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  weight REAL,
  note TEXT NOT NULL DEFAULT '',
  dm_note TEXT NOT NULL DEFAULT '',
  link TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combat (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 1,
  turn INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS combatants (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  is_pc INTEGER NOT NULL DEFAULT 0,
  initiative INTEGER NOT NULL DEFAULT 0,
  hp INTEGER,
  max_hp INTEGER,
  effects TEXT NOT NULL DEFAULT '[]',
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS map_marks (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  map_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('pin', 'note', 'route', 'stop', 'icon')),
  data TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('party', 'me', 'dm')),
  hidden_by_dm INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_blocks (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('me', 'dm', 'party')),
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  attitude TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'neutral',
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  met TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'party'
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  said TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'party'
);
CREATE TABLE IF NOT EXISTS recalls (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  text TEXT NOT NULL,
  success INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS person_notes (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  PRIMARY KEY (person_id, account_id)
);

CREATE TABLE IF NOT EXISTS whiteboards (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS whiteboard_history (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  doc TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, version)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT,
  account_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
`;

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Small additive migrations for databases made by older versions. */
function migrate(db: DB) {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
  // Keys made before read/write access existed stay read-only.
  if (!cols('api_keys').includes('access')) db.exec(`ALTER TABLE api_keys ADD COLUMN access TEXT NOT NULL DEFAULT 'read'`);
}

type Row = Record<string, any>;

export function one<T = Row>(db: DB, sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(db: DB, sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: DB, sql: string, ...params: any[]): number {
  return Number(db.prepare(sql).run(...params).changes);
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
