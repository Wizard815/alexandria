// Map vision: the model attached to the vision job (unset: the GM assistant's) is asked whether it can see pictures
// before a map is sent; a model listed without image input is never sent one; a model that can see gets the picture
// as an image part and its boxes come back on the 0 to 100 grid. Only the GM may ask, and the tool is hidden from players.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';
import { forgetVision } from '../src/features/fog/vision.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
let W = '';
const PNG = fs.readFileSync(path.join(import.meta.dirname, '../../web/e2e/fixtures/dungeon-map.png'));

/** What the fake provider says about its model, and every chat request it got. */
const fake = { modalities: ['text'] as string[], listed: true, chats: [] as any[] };
const fakeFetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u === 'http://vision.test/v1/models') {
    return new Response(JSON.stringify({ data: fake.listed ? [{ id: 'eyes-1', architecture: { input_modalities: fake.modalities } }] : [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u === 'http://vision.test/v1/chat/completions') {
    fake.chats.push(JSON.parse(init.body));
    const content = JSON.stringify({ summary: 'Three rooms joined by corridors.', areas: [{ name: '2 Crypt', x: 60, y: 10, w: 32, h: 33 }, { name: 'Bad box', x: 90, y: 90, w: 50, h: 50 }], answer: 'The crypt is top right.' });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fetch(url, init);
}) as typeof fetch;

async function call(method: string, url: string, token?: string, body?: unknown, raw?: Buffer) {
  const r = await fetch(base + url, { method, headers: { ...(raw ? { 'Content-Type': 'image/png' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const t = await r.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown, raw?: Buffer) => {
  const r = await call(method, url, token, body, raw);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const api = (p: string) => `/api/worlds/${W}${p}`;
let PIC = '';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-vision-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_GM_URL: 'http://vision.test/v1', ALX_MODEL_GM_MODEL: 'eyes-1' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gmId = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Visionland', gmAccountId: gmId })).id;
  const inv = await ok('POST', api('/invites'), T.gm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  const f = await ok('POST', api('/files?name=dungeon.png&kind=map&title=Dungeon'), T.gm, undefined, PNG);
  PIC = `lib:${f.id ?? f.file?.id}`;
  await ok('PUT', api('/fog/table'), T.gm, { mapId: 'world', pic: PIC });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestFogVision_ABlindModelIsNeverSentTheMap', async () => {
  forgetVision();
  fake.modalities = ['text'];
  const chk = await ok('GET', api('/fog/vision'), T.gm);
  assert.equal(chk.sees, 'no');
  assert.match(chk.why, /cannot see pictures/);
  const r = await call('POST', api('/fog/look'), T.gm, {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /eyes-1 cannot see pictures.*Map vision/);
  assert.equal(fake.chats.length, 0, 'no request reached the model');
});

test('TestFogVision_ASeeingModelGetsThePictureAndBoxesComeBack', async () => {
  forgetVision();
  fake.modalities = ['text', 'image'];
  assert.equal((await ok('GET', api('/fog/vision'), T.gm)).sees, 'yes');
  const look = await ok('POST', api('/fog/look'), T.gm, { question: 'Where is the crypt?' });
  assert.equal(look.pic, PIC, 'the picture on the table screen by default');
  assert.equal(look.answer, 'The crypt is top right.');
  assert.deepEqual(look.areas[0], { name: '2 Crypt', x: 60, y: 10, w: 32, h: 33 });
  assert.deepEqual(look.areas[1], { name: 'Bad box', x: 90, y: 90, w: 10, h: 10 }, 'a box is kept on the map');
  const req = fake.chats.at(-1);
  const parts = req.messages.at(-1).content;
  assert.ok(Array.isArray(parts) && parts[0].type === 'text' && /Where is the crypt/.test(parts[0].text));
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(parts[1].image_url.url.split(',')[1], 'base64').length, PNG.length, 'the whole picture was sent');
});

test('TestFogVision_AProviderThatSaysNothingIsTried', async () => {
  forgetVision();
  fake.listed = false;
  try {
    assert.equal((await ok('GET', api('/fog/vision'), T.gm)).sees, 'unknown');
    assert.equal((await ok('POST', api('/fog/look'), T.gm, { pic: PIC })).areas.length, 2);
  } finally { fake.listed = true; }
});

test('TestFogVision_OnlyTheGmMayLook', async () => {
  assert.equal((await call('POST', api('/fog/look'), T.jess, { pic: PIC })).status, 403);
  assert.equal((await call('GET', api('/fog/vision'), T.jess)).status, 403);
  assert.ok(toolsFor(false).find((t) => t.name === 'look_at_map')?.gmOnly, 'look_at_map is GM-only');
  assert.equal((await call('POST', api('/fog/look'), T.gm, { pic: 'none' })).status, 400);
});
