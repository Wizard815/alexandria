// Chats in folders, and template chats kept apart from the main chats (GET/POST/PATCH /agent/chats,
// POST /agent/chats/folders/rename). No model is needed: nothing here is sent to the assistant.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { chatFolder } from '../src/features/agent/store.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

async function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-folders-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', admin, { username: 'dungeon', password: 'dm password 123' });
  const dmT = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', admin, { name: 'Folderland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, dmT, { role: 'player' });
  const jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  const A = `/api/worlds/${W}/agent`;
  return { call, ok, dmT, jess, A };
}

test('AgentFolders: a folder path is cleaned and limited', () => {
  assert.equal(chatFolder('  Bloodearth //  Session   3 / '), 'Bloodearth/Session 3');
  assert.equal(chatFolder(''), '');
  assert.equal(chatFolder(null), '');
  assert.throws(() => chatFolder(5), /folder must be text/);
  assert.throws(() => chatFolder('a/b/c/d/e/f/g'), /6 deep/);
  assert.throws(() => chatFolder('x'.repeat(61)), /60 characters/);
});

test('AgentFolders: chats carry a folder, can be moved, and keep their place when moved', async () => {
  const { ok, call, dmT, A } = await boot();
  const a = await ok('POST', `${A}/chats`, dmT, { title: 'Bandits', folder: 'Bloodearth / Session 1' });
  const b = await ok('POST', `${A}/chats`, dmT, { title: 'Loose' });
  let list = (await ok('GET', `${A}/chats`, dmT)).chats;
  assert.deepEqual(list.map((c: any) => [c.title, c.folder, c.template]), [['Loose', '', ''], ['Bandits', 'Bloodearth/Session 1', '']]);
  await ok('PATCH', `${A}/chats/${b.id}`, dmT, { folder: 'Bloodearth' });
  list = (await ok('GET', `${A}/chats`, dmT)).chats;
  assert.equal(list.find((c: any) => c.id === b.id).folder, 'Bloodearth');
  assert.equal(list[0].id, b.id, 'moving is not new activity: the order stays');
  // Title alone still works; neither is refused.
  await ok('PATCH', `${A}/chats/${a.id}`, dmT, { title: 'Bandit ambush' });
  assert.equal((await call('PATCH', `${A}/chats/${a.id}`, dmT, {})).status, 400);
  assert.equal((await call('PATCH', `${A}/chats/${a.id}`, dmT, { folder: 7 })).status, 400);
  // Back to the top level.
  await ok('PATCH', `${A}/chats/${b.id}`, dmT, { folder: '' });
  assert.equal((await ok('GET', `${A}/chats`, dmT)).chats.find((c: any) => c.id === b.id).folder, '');
});

test('AgentFolders: renaming a folder moves the chats in it and in its subfolders, and nothing else', async () => {
  const { ok, call, dmT, jess, A } = await boot();
  const x = await ok('POST', `${A}/chats`, dmT, { folder: 'Arc' });
  const y = await ok('POST', `${A}/chats`, dmT, { folder: 'Arc/Session 2' });
  const z = await ok('POST', `${A}/chats`, dmT, { folder: 'Arcane' });
  const p = await ok('POST', `${A}/chats`, jess, { folder: 'Arc' });
  assert.equal((await ok('POST', `${A}/chats/folders/rename`, dmT, { from: 'Arc', to: 'Bloodearth/Arc one' })).moved, 2);
  const f = Object.fromEntries((await ok('GET', `${A}/chats`, dmT)).chats.map((c: any) => [c.id, c.folder]));
  assert.equal(f[x.id], 'Bloodearth/Arc one');
  assert.equal(f[y.id], 'Bloodearth/Arc one/Session 2');
  assert.equal(f[z.id], 'Arcane', 'a folder that only starts with the same letters is left alone');
  assert.equal((await ok('GET', `${A}/chats`, jess)).chats.find((c: any) => c.id === p.id).folder, 'Arc', "another account's chats are never moved");
  assert.equal((await call('POST', `${A}/chats/folders/rename`, dmT, { from: 'Bloodearth', to: 'Bloodearth/inside' })).status, 400);
  assert.equal((await call('POST', `${A}/chats/folders/rename`, dmT, { from: '', to: 'x' })).status, 400);
});

test('AgentFolders: template chats are listed apart from the main chats', async () => {
  const { ok, dmT, A } = await boot();
  const main = await ok('POST', `${A}/chats`, dmT, { title: 'Main' });
  const t1 = await ok('POST', `${A}/chats`, dmT, { title: 'Quick event', template: 'starter:quick-event' });
  const t2 = await ok('POST', `${A}/chats`, dmT, { title: 'Spell', template: 'tpl_abc' });
  const ids = async (q = '') => (await ok('GET', `${A}/chats${q}`, dmT)).chats.map((c: any) => c.id).sort();
  assert.deepEqual(await ids(), [main.id]);
  assert.deepEqual(await ids('?template=only'), [t1.id, t2.id].sort());
  assert.deepEqual(await ids('?template=tpl_abc'), [t2.id]);
  assert.equal((await ok('GET', `${A}/chats?template=only`, dmT)).chats.find((c: any) => c.id === t1.id).template, 'starter:quick-event');
});
