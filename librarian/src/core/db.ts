// SQLite storage for the librarian. Uses Node's built-in node:sqlite, so
// there is no native module to build. One database holds every world.
import { DatabaseSync } from 'node:sqlite';
import { ensureSearchIndex } from './pagesearch.ts';

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
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  default_visibility TEXT NOT NULL DEFAULT 'dm',
  last_sync_at TEXT,
  last_status TEXT,
  schedule_minutes INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

-- One row per sync of a source: the admin panel's job list.
CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  world_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'stopped')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  log TEXT NOT NULL DEFAULT '',
  error TEXT
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
-- Search indexes (fts_dm, fts_party, page_names) are created, versioned and rebuilt by core/pagesearch.ts (ensureSearchIndex, called from migrate()).

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

-- Item changes: player proposals waiting for the DM, and DM changes the
-- owner is told about (and can dispute).
CREATE TABLE IF NOT EXISTS item_changes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'edit', 'remove')),
  before_json TEXT,
  after_json TEXT,
  reason TEXT NOT NULL DEFAULT '',
  by_id TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'alert', 'ok', 'disputed', 'reverted')),
  dispute_note TEXT,
  decided_by TEXT,
  decided_at TEXT
);

-- The information broker: one row per world for the persona, tiers and game clock.
CREATE TABLE IF NOT EXISTS broker_config (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  game_minutes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS broker_requests (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  length TEXT NOT NULL,
  tier TEXT NOT NULL,
  cost_cp INTEGER NOT NULL DEFAULT 0,
  payer TEXT,
  ledger_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pricing', 'offered', 'waiting', 'answered', 'refused', 'refunded', 'declined', 'noted')),
  wait_clock TEXT,
  ready_at TEXT,
  ready_at_game INTEGER,
  answer TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  dm_note TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);

-- Broker v2: what each question was judged to be (DM only), DM-written
-- notes the broker may sell, per-page price rules, and DM-sent offers.
CREATE TABLE IF NOT EXISTS broker_notes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  page_id TEXT,
  topic TEXT NOT NULL,
  text TEXT NOT NULL,
  knowledge TEXT NOT NULL DEFAULT 'local',
  active INTEGER NOT NULL DEFAULT 1,
  from_request TEXT,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broker_page_rules (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  knowledge TEXT,
  multiplier REAL NOT NULL DEFAULT 1,
  never_sell INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, page_id)
);
CREATE TABLE IF NOT EXISTS broker_offers (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  teaser TEXT NOT NULL DEFAULT '',
  info TEXT NOT NULL,
  page_id TEXT,
  price_cp INTEGER NOT NULL,
  targets TEXT NOT NULL,
  expires_sessions INTEGER,
  fallback_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'paid', 'declined', 'expired', 'withdrawn')),
  declined_by TEXT NOT NULL DEFAULT '[]',
  paid_by TEXT,
  paid_from TEXT,
  ledger_id TEXT,
  paid_at TEXT,
  by_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Coin players ask each other for (e.g. to afford an offer).
CREATE TABLE IF NOT EXISTS coin_requests (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount_cp INTEGER NOT NULL,
  given_cp INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  offer_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'declined', 'cancelled')),
  declined_by TEXT NOT NULL DEFAULT '[]',
  at TEXT NOT NULL
);

-- Free moves between players and the party: logged for the DM, never pending.
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('coin', 'item')),
  from_owner TEXT NOT NULL,
  to_owner TEXT NOT NULL,
  amount_cp INTEGER,
  item_name TEXT,
  qty INTEGER,
  note TEXT NOT NULL DEFAULT '',
  by_id TEXT NOT NULL,
  at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);

-- Uploaded images (item pictures). Stored in the database so backups keep them.
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  by_id TEXT NOT NULL,
  at TEXT NOT NULL
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

  // Sources used to allow only four kinds; any connector id is fine now.
  const srcSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'sources'`).get() as any)?.sql ?? '';
  if (srcSql.includes("CHECK (kind IN")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`BEGIN;
      CREATE TABLE sources_new (id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', default_visibility TEXT NOT NULL DEFAULT 'dm', last_sync_at TEXT, last_status TEXT, schedule_minutes INTEGER, enabled INTEGER NOT NULL DEFAULT 1);
      INSERT INTO sources_new (id, world_id, kind, name, config, default_visibility, last_sync_at, last_status) SELECT id, world_id, kind, name, config, default_visibility, last_sync_at, last_status FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_new RENAME TO sources;
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Structured pages: blocks, sidebar facts, tree and source ids.
  const pc = cols('pages');
  const add = (c: string, def: string) => { if (!pc.includes(c)) db.exec(`ALTER TABLE pages ADD COLUMN ${c} ${def}`); };
  add('origin', "TEXT NOT NULL DEFAULT 'markdown'");
  add('external_id', 'TEXT');
  add('parent_external', 'TEXT');
  add('folder', "TEXT NOT NULL DEFAULT '[]'");
  add('aliases', "TEXT NOT NULL DEFAULT '[]'");
  add('tags', "TEXT NOT NULL DEFAULT '[]'");
  add('kind', "TEXT NOT NULL DEFAULT 'page'");
  add('icon', 'TEXT');
  add('banner', 'TEXT');
  add('url', 'TEXT');
  add('knowledge', 'TEXT');
  add('blocks', "TEXT NOT NULL DEFAULT '[]'");
  add('player_blocks', 'TEXT');
  add('properties', "TEXT NOT NULL DEFAULT '[]'");
  add('player_properties', 'TEXT');
  // Secrecy levels (core/levels.ts): the broker copy (party + broker content) and the AI copy (everything but classified).
  for (const c of ['broker_frontmatter', 'broker_body', 'broker_blocks', 'broker_properties', 'ai_frontmatter', 'ai_body', 'ai_blocks', 'ai_properties']) add(c, 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pages_source_ext ON pages (world_id, source_id, external_id) WHERE external_id IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS pages_world_vis ON pages (world_id, visibility)');
  // Search: create the FTS tables, or rebuild them when the layout/version changed (needs the pages columns above).
  ensureSearchIndex(db);

  // DM approvals: player coin changes and player-added items wait for the DM.
  if (!cols('ledger').includes('status')) {
    db.exec(`ALTER TABLE ledger ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
    db.exec('ALTER TABLE ledger ADD COLUMN decided_by TEXT');
    db.exec('ALTER TABLE ledger ADD COLUMN decided_at TEXT');
  }
  if (!cols('items').includes('status')) db.exec(`ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);

  // Broker v2 and item pictures.
  if (!cols('items').includes('image')) db.exec('ALTER TABLE items ADD COLUMN image TEXT');
  if (!cols('broker_requests').includes('classification')) db.exec('ALTER TABLE broker_requests ADD COLUMN classification TEXT');
  if (!cols('ledger').includes('transfer_id')) db.exec('ALTER TABLE ledger ADD COLUMN transfer_id TEXT');
  // 'noted': a question the broker turned away; only the DM sees it.
  const brSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'broker_requests'`).get() as any)?.sql ?? '';
  if (!brSql.includes("'noted'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`BEGIN;
      ALTER TABLE broker_requests RENAME TO broker_requests_old;
      CREATE TABLE broker_requests (id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        question TEXT NOT NULL, length TEXT NOT NULL, tier TEXT NOT NULL, cost_cp INTEGER NOT NULL DEFAULT 0, payer TEXT, ledger_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pricing', 'offered', 'waiting', 'answered', 'refused', 'refunded', 'declined', 'noted')),
        wait_clock TEXT, ready_at TEXT, ready_at_game INTEGER, answer TEXT, sources TEXT NOT NULL DEFAULT '[]', dm_note TEXT, created_at TEXT NOT NULL, delivered_at TEXT, classification TEXT);
      INSERT INTO broker_requests SELECT id, world_id, account_id, question, length, tier, cost_cp, payer, ledger_id, status, wait_clock, ready_at, ready_at_game, answer, sources, dm_note, created_at, delivered_at, classification FROM broker_requests_old;
      DROP TABLE broker_requests_old;
      COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON');
  }
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
