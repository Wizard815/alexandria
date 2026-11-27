// GM phone summary: whose turn it is plus the next two, the counts behind the
// tab badges, the GM-view transcript, and that players are refused.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { turnWindow } from '../src/features/dmphone/index.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
let W = '';
const P = () => `/api/worlds/${W}/dmphone`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-phone-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Phoneland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
});
after(async () => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestDmPhone_TurnWindowWrapsAndSkipsSelf', () => {
  const l = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
  assert.deepEqual(turnWindow(l, 2, 2).next.map((x) => x.n), ['a', 'b']);
  assert.equal(turnWindow(l, 4, 2).current.n, 'b');
  assert.deepEqual(turnWindow([{ n: 'x' }], 0, 2).next, []);
  assert.deepEqual(turnWindow([], 0, 2), { current: null, next: [] });
});

test('TestDmPhone_SummaryShowsCurrentTurnNextTwoAndCounts', async () => {
  for (const [name, init, hp] of [['Goblin', 12, 7], ['Sera', 18, 30], ['Orc', 8, 15], ['Rat', 3, 1]] as const) await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name, initiative: init, hp, maxHp: hp });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true, round: 1, turn: 0 });
  let s = await ok('GET', `${P()}/summary`, T.dm);
  assert.equal(s.combat.current.name, 'Sera');
  assert.deepEqual(s.combat.next.map((x: any) => x.name), ['Goblin', 'Orc']);
  assert.equal(s.combat.total, 4);
  assert.ok(s.date.label.length > 0);
  await ok('POST', `/api/worlds/${W}/live/combat/next`, T.dm);
  s = await ok('GET', `${P()}/summary?next=3`, T.dm);
  assert.equal(s.combat.current.name, 'Goblin');
  assert.equal(s.combat.next.length, 3);
  assert.equal(s.counts.all, 0);
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.jess, { owner: 'me', amountCp: 100, note: 'found' });
  await ok('POST', `/api/worlds/${W}/requests`, T.jess, { kind: 'question', title: 'Q', body: 'Is the door locked?' });
  s = await ok('GET', `${P()}/summary`, T.dm);
  assert.equal(s.counts.requests, 1);
  assert.equal(s.counts.approvals, s.counts.coin + s.counts.items + s.counts.disputes + s.counts.agent);
  assert.equal(s.counts.all, s.counts.approvals + s.counts.broker + s.counts.requests);
  assert.equal(s.session.recording, false);
});

test('TestDmPhone_TranscriptIsDmViewAndPlayersAreRefused', async () => {
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES ('as1', ?, 'Table', '2026-01-01T18:00:00.000Z')", W);
  const line = (n: number, text: string, audience: string) => run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `l${n}`, 'as1', W, n * 1000, n * 1000 + 500, 'Someone', text, audience, '2026-01-01T18:00:00.000Z');
  line(1, 'The party opens the door.', 'players');
  line(2, 'Aside: the baron is a vampire.', 'dm');
  const t = await ok('GET', `${P()}/transcript`, T.dm);
  assert.equal(t.session.live, true);
  assert.deepEqual(t.lines.map((l: any) => l.audience), ['players', 'dm']);
  assert.equal((await ok('GET', `${P()}/summary`, T.dm)).session.recording, true);
  for (const url of [`${P()}/transcript`, `${P()}/summary`]) {
    const r = await call('GET', url, T.jess);
    assert.ok([401, 403, 404].includes(r.status), `${url} -> ${r.status}`);
    assert.ok(!r.text.includes('vampire'));
  }
});
