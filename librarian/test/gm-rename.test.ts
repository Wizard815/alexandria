// The one-time dm -> gm rename: a database written before it (CHECK (role IN ('dm', ...)),
// DEFAULT 'dm', dm_note columns, dm values, settings keys, Minerva/dm/ pages) opens as gm,
// and outside input that still says dm is read as gm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/core/db.ts';
import { gmJson, gmName, gmRequest, gmText } from '../src/core/gmcompat.ts';
import { splitFrontmatter } from '../src/core/frontmatter.ts';

/** Turn a current database back into the old dm layout. */
function makeOld(file: string) {
  const db = new DatabaseSync(file);
  const back = (s: string) => s.replace(/'gm'/g, "'dm'").replace(/\bgm_note\b/g, 'dm_note');
  const v = (db.prepare('PRAGMA schema_version').get() as any).schema_version as number;
  db.exec('PRAGMA writable_schema = ON');
  for (const r of db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND sql NOT LIKE 'CREATE VIRTUAL%' AND name IN ('members', 'pages', 'items')`).all() as any[]) {
    db.prepare('UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?').run(back(r.sql), r.type, r.name);
  }
  db.exec(`PRAGMA schema_version = ${v + 1}`);
  db.exec('PRAGMA writable_schema = OFF');
  db.exec(`DELETE FROM alx_renames`);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO worlds (id, slug, name, settings, created_at) VALUES ('w1', 'w1', 'W', ?, ?)`).run(JSON.stringify({ dmFirst: true, agentAutoApprove: ['list_dm_templates'], whiteboardWipe: 'dm' }), now);
  db.prepare(`INSERT INTO accounts (id, username, display_name, pass_hash, created_at) VALUES ('a1', 'dm', 'Dana', 'x', ?)`).run(now);
  db.prepare(`INSERT INTO members (world_id, account_id, role) VALUES ('w1', 'a1', 'dm')`).run();
  db.prepare(`INSERT INTO pages (id, world_id, path, title, frontmatter, updated_at) VALUES ('p1', 'w1', 'Minerva/dm/hooks/Lighthouse.md', 'Lighthouse', ?, ?)`).run(JSON.stringify({ level: 'dm' }), now);
  db.close();
}

test('TestGmRename_AnOldDatabaseOpensWithGmNamesAndValues', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-gmrename-'));
  const file = path.join(dir, 'librarian.db');
  openDb(file).close();
  makeOld(file);
  const old = new DatabaseSync(file);
  assert.match((old.prepare(`SELECT sql FROM sqlite_master WHERE name = 'members'`).get() as any).sql, /'dm'/);
  assert.ok((old.prepare(`PRAGMA table_info(items)`).all() as any[]).some((c) => c.name === 'dm_note'));
  old.close();

  const db = openDb(file);
  assert.doesNotMatch((db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'members'`).get() as any).sql, /'dm'/);
  assert.equal((db.prepare(`SELECT role FROM members WHERE account_id = 'a1'`).get() as any).role, 'gm');
  assert.equal((db.prepare(`SELECT username FROM accounts WHERE id = 'a1'`).get() as any).username, 'dm', 'a username is never rewritten');
  const cols = (db.prepare(`PRAGMA table_info(items)`).all() as any[]).map((c) => c.name);
  assert.ok(cols.includes('gm_note') && !cols.includes('dm_note'));
  const s = JSON.parse((db.prepare(`SELECT settings FROM worlds WHERE id = 'w1'`).get() as any).settings);
  assert.deepEqual(s, { gmFirst: true, agentAutoApprove: ['list_gm_templates'], whiteboardWipe: 'gm' });
  const pg = db.prepare(`SELECT path, frontmatter, visibility FROM pages WHERE id = 'p1'`).get() as any;
  assert.equal(pg.path, 'Minerva/gm/hooks/Lighthouse.md');
  assert.deepEqual(JSON.parse(pg.frontmatter), { level: 'gm' });
  assert.equal(pg.visibility, 'gm', 'the column default moved to gm too');
  // A new member can be a gm (the CHECK changed) and the default is gm.
  db.prepare(`INSERT INTO accounts (id, username, display_name, pass_hash, created_at) VALUES ('a2', 'b', 'B', 'x', 'now')`).run();
  db.prepare(`INSERT INTO members (world_id, account_id, role) VALUES ('w1', 'a2', 'gm')`).run();
  assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  db.close();
  // Opening again changes nothing.
  openDb(file).close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TestGmRename_OldInputIsReadAsGm', () => {
  assert.equal(gmName('isDM'), 'isGM');
  assert.equal(gmName('dm_note'), 'gm_note');
  assert.equal(gmName('dmOnly'), 'gmOnly');
  assert.equal(gmName('admin'), 'admin');
  assert.equal(gmName('dmg'), 'dmg');
  assert.equal(gmName('landmarks'), 'landmarks');
  assert.equal(gmText('{{#dm}}\nSecret\n{{/dm}}'), '{{#gm}}\nSecret\n{{/gm}}');
  assert.deepEqual(gmJson({ assistant: { dm: 'Tell the GM', player: 'x' }, by: 'dm', dmnote: 'n' }), { assistant: { gm: 'Tell the GM', player: 'x' }, by: 'gm', gmnote: 'n' });
  assert.deepEqual(gmRequest({ username: 'dm', visibility: 'dm', text: 'dm', nested: { level: 'dm' } }), { username: 'dm', visibility: 'gm', text: 'dm', nested: { level: 'gm' } });
  assert.equal(splitFrontmatter('---\nlevel: dm\n---\nHi').fm.level, 'gm');
});
