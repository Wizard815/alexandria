// Notifications (features/notify): each person picks which alerts they get, and web push
// carries new alerts to their browsers once, encrypted so the push service can't read them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { sweep } from '../src/features/notify/index.ts';
import { pushHostOk } from '../src/features/notify/webpush.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const pushed: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
let pushStatus = 201;

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
const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

// A browser: its own key pair and auth secret, and the decryption a browser does (RFC 8291).
const ua = createECDH('prime256v1'); ua.generateKeys();
const authSecret = randomBytes(16);
function decrypt(body: Buffer): any {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const as = body.subarray(21, 21 + idlen);
  const enc = body.subarray(21 + idlen);
  const shared = ua.computeSecret(as);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const dc = createDecipheriv('aes-128-gcm', cek, nonce);
  dc.setAuthTag(enc.subarray(enc.length - 16));
  const plain = Buffer.concat([dc.update(enc.subarray(0, enc.length - 16)), dc.final()]);
  assert.equal(plain[plain.length - 1], 2, 'the last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-notify-'));
  const realFetch = fetch;
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (!u.startsWith('https://')) return realFetch(url, init);
    pushed.push({ url: u, headers: init.headers, body: Buffer.from(init.body) });
    return new Response('', { status: pushStatus });
  }) as typeof fetch;
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Pushland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token; ID.jess = j.account.id;
});
after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Notify_prefs: each person picks their alerts; the glance follows', async () => {
  const n = await ok('GET', '/api/me/notifications', T.jess);
  assert.deepEqual(n.kinds, { turn: true, quick: true, night: true, reply: true, request: true });
  assert.match(n.push.publicKey, /^[A-Za-z0-9_-]{87}$/, 'a VAPID public key');
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Jess', accountId: ID.jess, initiative: 15, hp: 10, maxHp: 10 });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true, round: 1, turn: 0 });
  assert.ok((await ok('GET', `/api/worlds/${W}/glance`, T.jess)).alerts.some((a: any) => a.kind === 'turn'));
  const off = await ok('PUT', '/api/me/notifications', T.jess, { kinds: { turn: false, bogus: true } });
  assert.equal(off.kinds.turn, false);
  assert.ok(!('bogus' in off.kinds));
  assert.ok(!(await ok('GET', `/api/worlds/${W}/glance`, T.jess)).alerts.some((a: any) => a.kind === 'turn'), 'turned off: no turn alert');
  assert.equal((await ok('GET', '/api/me/notifications', T.dm)).kinds.turn, true, 'one person\'s choice is theirs alone');
  const key = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'k', worldId: W });
  assert.equal((await call('PUT', '/api/me/notifications', key.key, { kinds: { turn: true } })).status, 403, 'not with a key');
  await ok('PUT', '/api/me/notifications', T.jess, { kinds: { turn: true } });
});

test('Notify_subscribe: only real push services, only from a session', async () => {
  assert.ok(pushHostOk('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(pushHostOk('https://web.push.apple.com/QK'));
  assert.ok(!pushHostOk('http://fcm.googleapis.com/x'));
  assert.ok(!pushHostOk('https://evil.example/fcm.googleapis.com'));
  assert.ok(!pushHostOk('https://127.0.0.1/x'));
  assert.ok(!pushHostOk('https://fcm.googleapis.com.evil.example/x'));
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };
  assert.equal((await call('POST', '/api/push/subscriptions', T.jess, { endpoint: 'https://localhost/push', keys })).status, 400);
  assert.equal((await call('POST', '/api/push/subscriptions', T.jess, { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'short', auth: 'x' } })).status, 400);
  const s = await call('POST', '/api/push/subscriptions', T.jess, { endpoint: 'https://fcm.googleapis.com/fcm/send/jess-phone', keys, label: 'Pixel' });
  assert.equal(s.status, 201);
  const devices = (await ok('GET', '/api/me/notifications', T.jess)).push.devices;
  assert.deepEqual(devices.map((x: any) => x.label), ['Pixel']);
});

test('Notify_push: a new alert reaches each device once, encrypted and signed', async () => {
  pushed.length = 0;
  // Her turn was already waiting when she subscribed: not pushed again.
  assert.equal(await sweep(deps), 0);
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { round: 2, turn: 0 });
  assert.equal(await sweep(deps), 1, 'round 2, her turn again: one push');
  assert.equal(await sweep(deps), 0, 'and only once');
  const p = pushed[0];
  assert.equal(p.url, 'https://fcm.googleapis.com/fcm/send/jess-phone');
  assert.equal(p.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(!p.body.toString('latin1').includes('Your turn'), 'the push service cannot read it');
  const msg = decrypt(p.body);
  assert.equal(msg.title, 'Your turn');
  assert.match(msg.path, /\/live$/);
  // VAPID: a JWT for the push service's origin, signed with the key the browser was given.
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(p.headers.Authorization)!;
  assert.ok(m);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  const pub = Buffer.from(m[4], 'base64url');
  const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));

  // A device the push service says is gone is forgotten.
  pushStatus = 410;
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { round: 3, turn: 0 });
  await sweep(deps);
  assert.equal((await ok('GET', '/api/me/notifications', T.jess)).push.devices.length, 0);
  pushStatus = 201;
});
