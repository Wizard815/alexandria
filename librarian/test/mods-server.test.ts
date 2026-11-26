// Server rules (house rules with "scope": "server"): whole features the server admin turns on or off for every
// world under Admin → Mods, such as a content source with its own admin page. They come only from the mods/ folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { checkMod } from '../src/features/mods/format.ts';
import { loadModsDir } from '../src/features/mods/catalog.ts';
import { serverModGate, serverModOn } from '../src/features/mods/server.ts';

let base = '';
let server: any;
let db: any;
let tmp = '';
const T: Record<string, string> = {};
let W = '';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const SRV = (id: string, extra: Record<string, unknown> = {}) => ({ kit: 2, id, name: `Server ${id}`, scope: 'server', summary: `The ${id} source`, ...extra });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-mods-server-'));
  const dir = path.join(tmp, 'mods');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'srv-a.alxmod.json'), JSON.stringify(SRV('srv-a', { onByDefault: true })));
  fs.writeFileSync(path.join(dir, 'srv-b.alxmod.json'), JSON.stringify(SRV('srv-b', { requires: { mods: { 'srv-a': '^1' } } })));
  fs.writeFileSync(path.join(dir, 'srv-c.alxmod.json'), JSON.stringify(SRV('srv-c', { conflicts: ['srv-a'] })));
  assert.deepEqual(loadModsDir(dir).problems, []);
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  db = made.deps.db;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Serverholm', dmAccountId: dm })).id;
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('ModsServer: a server rule has no per-world parts, and onByDefault is only for server rules', () => {
  assert.deepEqual(checkMod(SRV('fine', { onByDefault: true, requires: { mods: { other: '^1' } }, rules: [{ term: 'X', text: 'y' }] })).errors, []);
  const bad = checkMod(SRV('bad', { resources: [{ id: 'pt', label: 'Point' }], presets: { trackWeight: true }, records: { a: { label: 'A', fields: { n: 'text' } } } })).errors.join('\n');
  for (const re of [/resources: a server rule/, /presets: a server rule/, /records: a server rule/]) assert.match(bad, re);
  assert.match(checkMod({ kit: 2, id: 'w', name: 'W', onByDefault: true }).errors.join(), /only for a server rule/);
  assert.match(checkMod({ kit: 2, id: 'w', name: 'W', scope: 'galaxy' }).errors.join(), /scope must be world or server/);
});

test('ModsServer: the admin lists and switches server rules; needs and conflicts follow; others cannot', async () => {
  const list = (await ok('GET', '/api/admin/mods', T.admin)).mods;
  assert.deepEqual(list.map((m: any) => [m.id, m.enabled]).sort(), [['srv-a', true], ['srv-b', false], ['srv-c', false]]);
  assert.equal((await call('GET', '/api/admin/mods', T.dm)).status, 403);
  assert.equal((await call('PUT', '/api/admin/mods/srv-b/enabled', T.dm, { on: true })).status, 403);
  assert.deepEqual((await ok('GET', '/api/server-mods', T.dm)).on, ['srv-a']);
  assert.equal((await call('GET', '/api/server-mods')).status, 401);
  // Off: what needs it goes off too. On: what it needs comes on. A conflict turns the other off.
  await ok('PUT', '/api/admin/mods/srv-a/enabled', T.admin, { on: false });
  const b = await ok('PUT', '/api/admin/mods/srv-b/enabled', T.admin, { on: true });
  assert.deepEqual(b.turnedOn, ['srv-a']);
  const offA = await ok('PUT', '/api/admin/mods/srv-a/enabled', T.admin, { on: false });
  assert.deepEqual(offA.turnedOff, ['srv-b']);
  await ok('PUT', '/api/admin/mods/srv-a/enabled', T.admin, { on: true });
  const c = await ok('PUT', '/api/admin/mods/srv-c/enabled', T.admin, { on: true });
  assert.deepEqual(c.turnedOff, ['srv-a']);
  assert.deepEqual((await ok('GET', '/api/server-mods', T.dm)).on, ['srv-c']);
  assert.equal(serverModOn(db, 'srv-a'), false);
  assert.equal(serverModOn(db, 'nope'), false);
  await call('PUT', '/api/admin/mods/nope/enabled', T.admin, { on: true }).then((r) => assert.equal(r.status, 404));
  await ok('PUT', '/api/admin/mods/srv-a/enabled', T.admin, { on: true });
});

test('ModsServer: worlds never list or import server rules', async () => {
  const world = (await ok('GET', `/api/worlds/${W}/mods`, T.dm)).mods.map((m: any) => m.id);
  assert.ok(!world.some((id: string) => id.startsWith('srv-')));
  const r = await call('POST', `/api/worlds/${W}/mods/import`, T.dm, { mod: SRV('sneaky') });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /server rule/);
});

test('ModsServer: the gate answers 404 with a reason while the rule is off', async () => {
  const app = express();
  app.use('/x', serverModGate(db, 'srv-b'), (_req, res) => { res.json({ ok: true }); });
  app.use('/y', serverModGate(db, undefined), (_req, res) => { res.json({ ok: true }); });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const off = await fetch(`${u}/x`);
    assert.equal(off.status, 404);
    assert.match((await off.json()).error, /Server srv-b is turned off on this server/);
    assert.equal((await fetch(`${u}/y`)).status, 200);
    await ok('PUT', '/api/admin/mods/srv-b/enabled', T.admin, { on: true });
    assert.equal((await fetch(`${u}/x`)).status, 200);
  } finally { s.close(); }
});
