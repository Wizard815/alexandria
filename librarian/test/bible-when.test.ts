// The story bible reads in the background only when the world says it may: by default, only while a session runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { all, run } from '../src/core/db.ts';
import { SESSION_MAX_MS, mayRead, worldsToRead } from '../src/features/bible/when.ts';

test('TestBible_ReadsOnlyDuringASession', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-bw-'));
  const { deps } = createApp({ dbFile: path.join(tmp, 'a.db'), dataDir: tmp, noScheduler: true }) as any;
  const db = deps.db;
  const at = new Date().toISOString();
  run(db, 'INSERT INTO worlds (id, slug, name, settings, created_at) VALUES (?, ?, ?, ?, ?)', 'w1', 'w1', 'One', '{}', at);
  run(db, 'INSERT INTO worlds (id, slug, name, settings, created_at) VALUES (?, ?, ?, ?, ?)', 'w2', 'w2', 'Two', '{}', at);
  const set = (v: string) => run(db, 'UPDATE worlds SET settings = ? WHERE id = ?', JSON.stringify({ bibleRuns: v }), 'w1');
  assert.deepEqual(worldsToRead(db), [], 'no session: nothing is read');
  run(db, 'INSERT INTO sessionchat_sessions (id, world_id, title, started_at) VALUES (?, ?, ?, ?)', 's1', 'w1', 'Night', at);
  assert.deepEqual(worldsToRead(db), ['w1'], 'only the world in session');
  set('off'); assert.equal(mayRead(db, 'w1'), false, 'off wins over a session');
  set('session'); run(db, 'UPDATE sessionchat_sessions SET ended_at = ?', at);
  assert.equal(mayRead(db, 'w1'), false, 'ended: stops');
  set('always'); assert.equal(mayRead(db, 'w1'), true);
  set('session'); run(db, 'UPDATE sessionchat_sessions SET ended_at = NULL');
  assert.equal(mayRead(db, 'w1', Date.now() + SESSION_MAX_MS + 1000), false, 'a forgotten session stops counting');
  run(db, 'UPDATE sessionchat_sessions SET ended_at = ?', at);
  run(db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, started_by) VALUES (?, ?, ?, ?, ?)', 'a1', 'w1', 'Rec', at, 'x');
  assert.equal(mayRead(db, 'w1'), true, 'a recording is a session');
});

test('TestBible_StoppedMidPageStoresNothing', async () => {
  const { syncBible } = await import('../src/features/bible/extract.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-bw2-'));
  const ctl = new AbortController();
  let calls = 0;
  const fakeFetch: any = async () => { calls++; ctl.abort(); return new Response(JSON.stringify({ choices: [{ message: { content: '{"facts":[{"subject":"A","kind":"lore","fact":"A is a thing."}]}' } }] }), { headers: { 'content-type': 'application/json' } }); };
  const { deps } = createApp({ dbFile: path.join(tmp, 'a.db'), dataDir: tmp, noScheduler: true, fetch: fakeFetch, env: { ALX_MODEL_CHAT_URL: 'http://127.0.0.1:1/v1', ALX_MODEL_CHAT_MODEL: 'fake' } }) as any;
  const at = new Date().toISOString();
  run(deps.db, 'INSERT INTO worlds (id, slug, name, settings, created_at) VALUES (?, ?, ?, ?, ?)', 'w1', 'w1', 'One', '{}', at);
  for (const p of ['a', 'b']) deps.library.save ? deps.library.save('w1', { path: p, title: p, body: 'Some words about ' + p, visibility: 'gm', frontmatter: {} }, null) : null;
  const r = await syncBible(deps, { worldId: 'w1', signal: ctl.signal });
  assert.equal(r.facts, 0);
  assert.equal(calls, 1, 'one page was asked for, then it stopped');
  assert.equal(all(deps.db, 'SELECT 1 FROM bible_state').length, 0, 'an interrupted page is read again later');
});
