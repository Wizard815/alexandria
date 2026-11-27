// "GM", never "DM": every internal name for the Game Master says gm. Older
// databases, mod files, templates, vault pages and API callers still say dm;
// this file turns those into the gm names. Used by the one-time database
// migration (migrateDmToGm) and wherever outside input comes in.

import type { DatabaseSync } from 'node:sqlite';

/** Names that run dm into the next word. */
const JOINED: Record<string, string> = { dmnote: 'gmnote', dmnotes: 'gmnotes', dmonly: 'gmonly', dmlegend: 'gmlegend', dmband: 'gmband' };

/** A name with its dm parts as gm: dm_note -> gm_note, isDM -> isGM, dmOnly -> gmOnly. Other words (admin, dmg) are kept. */
export function gmName(t: string): string {
  if (t === 'DM' || t === 'DMs' || t === 'dmg') return t;
  if (Object.hasOwn(JOINED, t)) return JOINED[t];
  return t.replace(/(DM|Dm|dm)(s?)(?=$|[_$\-0-9A-Z])/g, (m, w: string, s: string, at: number) => {
    const prev = at > 0 ? t[at - 1] : '';
    if (prev && /[a-z]/.test(prev) && w === 'dm') return m;
    if (prev && !/[a-z_$\-0-9]/.test(prev)) return m;
    return ({ DM: 'GM', Dm: 'Gm', dm: 'gm' } as Record<string, string>)[w] + s;
  });
}

/** Stored values that named the GM with dm. */
const VALUES: Record<string, string> = Object.fromEntries(
  ['dm', 'dm-first', 'dm_first', 'dm-only', 'dm_only', 'dm-question', 'from-dm', 'dm-note-add', 'dm_written', 'owner_dm', 'dm-quiet',
    'dm_note', 'dm_notes', 'create_dm_template', 'get_dm_template', 'list_dm_templates', 'update_dm_template', 'dmband']
    .map((v) => [v, gmName(v)]),
);

/** One stored or typed value: "dm" -> "gm" (and the few compound values); anything else unchanged. */
export const gmValue = (v: unknown): unknown => (typeof v === 'string' && Object.hasOwn(VALUES, v) ? VALUES[v] : v);

/** Template sections and Minerva folders written the old way. */
export function gmText(s: string): string {
  return s.replace(/\{\{([#/])dm\}\}/g, '{{$1gm}}').replace(/(^|\/)dm\/(players|hooks|revelations|state|session-prep|hidden-lore)\//g, '$1gm/$2/');
}

/** A parsed JSON value with dm keys and values as gm (mod files, settings, stored blobs). */
export function gmJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(gmJson);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const nk = gmName(k);
      o[Object.hasOwn(o, nk) ? k : nk] = gmJson(x);
    }
    return o;
  }
  if (typeof v === 'string') return gmText(gmValue(v) as string);
  return v;
}

/** Request fields that hold a role, level or audience. Free text (names, passwords, messages) is never touched. */
const ENUM_KEYS = new Set(['role', 'level', 'visibility', 'audience', 'audience_override', 'override', 'kind', 'scope', 'perspective', 'whose', 'place',
  'by', 'from', 'view', 'mode', 'resource', 'defaultLevel', 'requestDefault', 'whiteboardWipe', 'who', 'harness', 'source', 'type', 'to']);

/** Old API callers (an installed bridge script, a saved macro) may still send dm: read it as gm. */
export function gmRequest(v: unknown, depth = 0): unknown {
  if (depth > 6 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = gmRequest(v[i], depth + 1); return v; }
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const x = o[k];
    if (typeof x === 'string') { if (ENUM_KEYS.has(k)) o[k] = gmValue(x); }
    else if (Array.isArray(x) && ENUM_KEYS.has(k)) o[k] = x.map(gmValue);
    else o[k] = gmRequest(x, depth + 1);
  }
  return o;
}

/** Columns of free text and secrets: values there are never rewritten. */
const FREE = /^(id|.*_id|username|display_name|name|title|text|body|player_body|markdown|md|content|note|notes|message|messages|summary|description|label|q|query|password.*|.*hash.*|.*token.*|.*secret.*|.*key|key_.*|url|.*_url|email|speaker.*|transcript|line|lines|answer|question|prompt|reply|raw|data|blob|bytes|mime|sha.*)$/i;

type DB = InstanceType<typeof DatabaseSync>;

/**
 * Once per database: tables, columns, defaults, checks and indexes that named the GM
 * with dm are renamed to gm, and stored values follow (roles, levels, settings keys,
 * mod packages, templates, the Minerva gm/ folder). Runs before the schema is applied.
 */
export function migrateDmToGm(db: DB) {
  db.exec('CREATE TABLE IF NOT EXISTS alx_renames (name TEXT PRIMARY KEY, at TEXT NOT NULL)');
  if (db.prepare(`SELECT 1 FROM alx_renames WHERE name = 'dm-to-gm'`).get()) return;
  const rows = () => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL`).all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const fresh = !rows().some((r) => r.type === 'table' && r.name !== 'alx_renames');
  const done = () => db.prepare(`INSERT OR IGNORE INTO alx_renames (name, at) VALUES ('dm-to-gm', ?)`).run(new Date().toISOString());
  if (fresh) return done();
  const sqlName = (s: string) => s.replace(/[A-Za-z0-9_$]+|'dm'/g, (t) => (t === "'dm'" ? "'gm'" : gmName(t)));
  const virtual = rows().filter((r) => r.type === 'table' && /^CREATE VIRTUAL TABLE/i.test(r.sql));
  const shadowOf = (n: string) => virtual.some((v) => n !== v.name && n.startsWith(`${v.name}_`));
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    // FTS tables named for the GM are rebuilt by the search code under their new names.
    for (const v of virtual) if (gmName(v.name) !== v.name) db.exec(`DROP TABLE IF EXISTS "${v.name}"`);
    for (const r of rows()) {
      if (r.type !== 'table' || /^CREATE VIRTUAL TABLE/i.test(r.sql) || shadowOf(r.name) || r.name.startsWith('sqlite_')) continue;
      const n = gmName(r.name);
      if (n !== r.name) db.exec(`ALTER TABLE "${r.name}" RENAME TO "${n}"`);
    }
    const version = (db.prepare('PRAGMA schema_version').get() as any).schema_version as number;
    const edits = rows().filter((r) => !/^CREATE VIRTUAL TABLE/i.test(r.sql) && !shadowOf(r.name) && !r.name.startsWith('sqlite_') && sqlName(r.sql) !== r.sql);
    if (edits.length) {
      db.exec('PRAGMA writable_schema = ON');
      const up = db.prepare('UPDATE sqlite_master SET sql = ?, name = ?, tbl_name = ? WHERE type = ? AND name = ?');
      for (const r of edits) up.run(sqlName(r.sql), r.type === 'table' ? r.name : gmName(r.name), gmName(r.tbl_name), r.type, r.name);
      db.exec(`PRAGMA schema_version = ${version + 1}`);
      db.exec('PRAGMA writable_schema = OFF');
    }
    // Stored values.
    for (const t of rows().filter((r) => r.type === 'table' && !/^CREATE VIRTUAL TABLE/i.test(r.sql) && !shadowOf(r.name) && !r.name.startsWith('sqlite_'))) {
      const cols = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as any[]).filter((c) => !/INT|REAL|BLOB|NUM/i.test(String(c.type ?? '')));
      for (const c of cols) {
        const col = `"${c.name}"`;
        const tb = `"${t.name}"`;
        if (!FREE.test(c.name)) {
          for (const [from, to] of Object.entries(VALUES)) db.prepare(`UPDATE ${tb} SET ${col} = ? WHERE ${col} = ?`).run(to, from);
        }
        // JSON blobs: settings, mod packages, frontmatter, saved lists of tool names.
        const pick = db.prepare(`SELECT rowid AS r, ${col} AS v FROM ${tb} WHERE (${col} LIKE '{%' OR ${col} LIKE '[%') AND (${col} LIKE '%dm%' OR ${col} LIKE '%Dm%' OR ${col} LIKE '%DM%')`);
        const put = db.prepare(`UPDATE ${tb} SET ${col} = ? WHERE rowid = ?`);
        let list: any[] = [];
        try { list = pick.all() as any[]; } catch { list = []; }
        for (const row of list) {
          let parsed: unknown;
          try { parsed = JSON.parse(String(row.v)); } catch { continue; }
          const next = JSON.stringify(gmJson(parsed));
          if (next !== JSON.stringify(parsed)) put.run(next, row.r);
        }
        // Template sections and Minerva folders in text and paths.
        try {
          db.prepare(`UPDATE ${tb} SET ${col} = replace(replace(${col}, '{{#dm}}', '{{#gm}}'), '{{/dm}}', '{{/gm}}') WHERE ${col} LIKE '%{{_dm}}%'`).run();
          for (const sub of ['players', 'hooks', 'revelations', 'state', 'session-prep', 'hidden-lore']) {
            db.prepare(`UPDATE ${tb} SET ${col} = replace(${col}, ?, ?) WHERE ${col} LIKE ?`).run(`Minerva/dm/${sub}/`, `Minerva/gm/${sub}/`, `%Minerva/dm/${sub}/%`);
            db.prepare(`UPDATE ${tb} SET ${col} = 'gm/' || substr(${col}, 4) WHERE ${col} LIKE ?`).run(`dm/${sub}/%`);
          }
        } catch { /* a UNIQUE clash leaves that row as it was */ }
      }
    }
    done();
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to undo */ }
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
