// Audit notes: sign-in by address, a removed member keeps nothing, stuck agent actions.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { one, run } from '../src/core/db.ts';
import { boot, type Kit } from './audit-kit.ts';
import agent from '../src/features/agent/index.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

test('Audit_Members: a removed player keeps no shares and gets none back when re-added', async () => {
  const p = await k.ok('PUT', k.w('/library/pages'), k.T.gm, { path: 'notes/Bridge.md', visibility: 'gm', body: '# Bridge\nThe bridge ZNOTES1 is old.\n' });
  await k.ok('POST', k.w(`/library/pages/${p.id}/share`), k.T.gm, { to: [k.ID.jess] });
  assert.equal((await k.call('GET', k.w(`/library/pages/${p.id}`), k.T.jess)).status, 200, 'shared');
  await k.ok('DELETE', `/api/admin/worlds/${k.W}/members/${k.ID.jess}`, k.T.admin);
  assert.equal(one<any>(k.deps.db, 'SELECT COUNT(*) AS n FROM sourcekeys_shares WHERE world_id = ? AND (from_id = ? OR to_id = ?)', k.W, k.ID.jess, k.ID.jess).n, 0);
  await k.ok('PUT', `/api/admin/worlds/${k.W}/members/${k.ID.jess}`, k.T.admin, { role: 'player' });
  const fresh = (await k.ok('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' })).token as string;
  assert.equal((await k.call('GET', k.w(`/library/pages/${p.id}`), fresh)).status, 404, 'the old share must not come back');
});

test('Audit_Agent: an action left running when the server stopped is marked failed on start', () => {
  const chat = 'agc_stuck';
  run(k.deps.db, 'INSERT INTO agent_chats (id, world_id, account_id, harness, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', chat, k.W, k.ID.gm, 'gm', 't', new Date().toISOString(), new Date().toISOString());
  run(k.deps.db, `INSERT INTO agent_actions (id, world_id, chat_id, account_id, tool, args, summary, status, created_at) VALUES ('aga_stuck', ?, ?, ?, 'add_person', '{}', 's', 'running', ?)`, k.W, chat, k.ID.gm, new Date().toISOString());
  agent.migrate!(k.deps.db);
  const a = one<any>(k.deps.db, `SELECT status, result FROM agent_actions WHERE id = 'aga_stuck'`);
  assert.equal(a.status, 'failed');
  assert.match(a.result, /restarted/);
});

// Last: it locks this address out of signing in for a minute.
test('Audit_Login: one address trying many usernames is locked out, not just one name', async () => {
  let locked = 0;
  for (let i = 0; i < 25; i++) {
    const r = await k.call('POST', '/api/auth/login', null, { username: `nobody${i}`, password: 'wrong password 1' });
    if (r.status === 429) locked++;
    else assert.equal(r.status, 401);
  }
  assert.ok(locked > 0, 'twenty-odd failed names from one address must hit the address limit');
});
