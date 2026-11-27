// House rules (mods): edge cases. Hostile or sloppy files (prototype keys, huge numbers, cycles, duplicate ids),
// players poking at what is not theirs, rules turned off or removed mid-use, prompts answered twice or after closing.
// Each case must end in a plain error or a safe result, never a crash, a leak or a corrupt world.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { checkMod, unpack } from '../src/features/mods/format.ts';
import { parseRange, satisfies } from '../src/features/mods/semver.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const M = () => `/api/worlds/${W}/mods`;

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
/** A plain refusal: a 4xx with an error sentence, never a 500. */
const refused = async (method: string, url: string, token: string, body: unknown, re?: RegExp) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status >= 400 && r.status < 500, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  if (re) assert.match(String(r.body?.error ?? ''), re);
  return r;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-mods-edge-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Edgeholm', gmAccountId: ID.gm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const POINTS = { kit: 2, id: 'edge-points', name: 'Edge points', resources: [{ id: 'pt', label: 'Point', max: 3 }], actions: [{ id: 'give', label: 'Give', by: 'gm', resource: 'pt', add: 1 }, { id: 'spend', label: 'Spend', by: 'owner', resource: 'pt', add: -1 }] };
const LIST = {
  kit: 2, id: 'edge-list', name: 'Edge list',
  records: {
    item: { label: 'Item', fields: { name: 'text', size: { type: 'int', min: 0, max: 10, default: 0 }, kind: 'enum:a|b' }, seed: [{ name: 'Rope', size: 1, kind: 'a' }] },
    job: { label: 'Job', owned: true, fields: { item: 'ref:item', done: { type: 'int', default: 0, min: 0 }, goal: { type: 'int', default: 3 }, status: { type: 'enum', values: ['open', 'done'], default: 'open' } } },
  },
  recordActions: [
    { id: 'add-item', label: 'Add', by: 'any', record: 'item', do: 'create', ask: ['name', 'size', 'kind'] },
    { id: 'start', label: 'Start', by: 'owner', record: 'job', do: 'create', ask: ['item'] },
    { id: 'bump', label: 'Bump', by: 'gm', record: 'job', do: 'add', field: 'done', amount: 'ask' },
    { id: 'drop', label: 'Drop', by: 'owner', record: 'job', do: 'remove' },
    { id: 'rename', label: 'Rename', by: 'any', record: 'item', do: 'set', ask: ['name'] },
  ],
  timers: [{ id: 'tick', record: 'job', on: 'prompt:day', where: { status: 'open' }, field: 'done', add: 1, goal: 'goal', done: { set: { status: 'done' } } }],
  prompts: [{ id: 'day', button: 'Day', title: 'A day', text: 'Pick', choices: [{ label: 'Start', action: 'start' }, { label: 'Skip', skip: true }] }],
};

// ---- hostile and sloppy files ------------------------------------------------------------------------------------

test('ModsEdge: prototype keys in a file are refused and never reach Object.prototype', () => {
  const bad = JSON.parse('{"kit":2,"id":"proto","name":"Proto","options":{"__proto__":{"type":"int","default":1,"min":0,"max":3,"label":"x"}},"records":{"__proto__":{"label":"P","fields":{"constructor":"text"}}},"presets":{"__proto__":{"polluted":true}}}');
  const r = checkMod(bad);
  assert.equal(r.mod, null);
  assert.ok(r.errors.length > 0);
  assert.equal(({} as any).polluted, undefined);
  const fields = checkMod({ ...LIST, id: 'proto2', records: { ...LIST.records, item: { ...LIST.records.item, fields: JSON.parse('{"name":"text","__proto__":"int","constructor":"text"}') } } });
  assert.equal(fields.mod, null, 'a field called __proto__ or constructor is refused');
});

test('ModsEdge: numbers that are not finite whole numbers, and wrong $option types, are refused', () => {
  for (const add of [1e308 * 10, 0.5, '1', '$nope']) {
    const r = checkMod({ ...POINTS, id: 'num', actions: [{ id: 'give', label: 'Give', by: 'gm', resource: 'pt', add }] });
    assert.equal(r.mod, null, `add ${String(add)}`);
  }
  const wrongType = checkMod({ ...POINTS, id: 'opt', options: { on: { type: 'boolean', default: true, label: 'On' } }, resources: [{ id: 'pt', label: 'Point', max: '$on' }] });
  assert.equal(wrongType.mod, null, 'a yes/no option cannot be a max');
  assert.match(checkMod('{"kit":2,"id":"x","name":"X",}').errors.join(), /not valid JSON/);
  assert.match(checkMod('﻿{"kit":2,"id":"bom","name":"Bom"}').errors.join() || 'ok', /ok/, 'a byte order mark is fine');
});

test('ModsEdge: broken references inside a data system name where they are', () => {
  const bad = checkMod({
    ...LIST, id: 'refs',
    recordActions: [
      { id: 'a1', label: 'A', by: 'any', record: 'item', do: 'create', ask: ['nope'] },
      { id: 'a2', label: 'B', by: 'any', record: 'item', do: 'set', set: { kind: 'z' } },
      { id: 'a3', label: 'C', by: 'any', record: 'job', do: 'create', copy: { via: 'done', fields: { goal: 'size' } } },
    ],
    timers: [{ id: 't', record: 'job', on: 'prompt:ghost', field: 'done', add: 1, goal: 'nofield', done: { set: {} } }],
    prompts: [{ id: 'day', button: 'Day', title: 'D', text: '', choices: [{ label: 'X', action: 'ghost' }] }],
  });
  const e = bad.errors.join('\n');
  assert.equal(bad.mod, null);
  for (const re of [/nope/, /"z"|z is not|one of a, b/, /via|copy/, /ghost/, /nofield/]) assert.match(e, re);
  const seed = checkMod({ ...LIST, id: 'seed', records: { ...LIST.records, item: { ...LIST.records.item, seed: [{ name: 'Big', size: 99, kind: 'a' }, { size: 1 }] } } });
  assert.equal(seed.mod, null, 'seed values are checked like any other');
});

test('ModsEdge: a package with the same id twice, or that needs itself in a loop, is handled', async () => {
  const dup = unpack({ type: 'alexandria-house-rules', kit: 2, name: 'Dup', mods: [{ ...POINTS }, { ...POINTS }] });
  assert.equal(dup.mods.length, 0, 'two rules with one id is refused');
  assert.match(dup.errors.join(), /edge-points/);
  const a = { kit: 2, id: 'loop-a', name: 'Loop A', requires: { mods: { 'loop-b': '^1' } } };
  const b = { kit: 2, id: 'loop-b', name: 'Loop B', requires: { mods: { 'loop-a': '^1' } } };
  await ok('POST', `${M()}/import`, T.gm, { mod: { type: 'alexandria-house-rules', kit: 2, name: 'Loop', mods: [a, b] } });
  const on = await call('PUT', `${M()}/loop-a/enabled`, T.gm, { on: true });
  assert.ok(on.status < 500, `no crash on a requires loop: ${on.status}`);
  const list = (await ok('GET', M(), T.gm)).mods;
  const st = Object.fromEntries(list.filter((m: any) => m.id.startsWith('loop-')).map((m: any) => [m.id, m.enabled]));
  assert.equal(st['loop-a'], st['loop-b'], 'both on or both off');
  const off = await call('PUT', `${M()}/loop-b/enabled`, T.gm, { on: false, cascade: true });
  assert.ok(off.status < 500);
  await ok('DELETE', `${M()}/loop-a`, T.gm);
  await ok('DELETE', `${M()}/loop-b`, T.gm);
});

test('ModsEdge: version ranges that are nonsense do not parse; odd but valid ones do', () => {
  for (const r of ['banana', '^1 ||', '>=', '^', '1..2', '>=1 <', '|| ||']) assert.equal(parseRange(r), null, `"${r}"`);
  assert.equal(satisfies('0.1.0-alpha.1', '>=0.1'), true);
  assert.equal(satisfies('2.0.0', '^1 || ^2'), true);
  assert.equal(satisfies('1.5.0', '>=1.2 <2'), true);
  assert.equal(satisfies('2.0.0', '>=1.2 <2'), false);
});

// ---- play: players, values, rules going away ---------------------------------------------------------------------

test('ModsEdge: record values from players are checked: range, enum, type, length, and fields that are not asked', async () => {
  await ok('POST', `${M()}/import`, T.gm, { mod: LIST });
  await ok('PUT', `${M()}/edge-list/enabled`, T.gm, { on: true });
  const R = `${M()}/edge-list/records`;
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'Huge', size: 11, kind: 'a' } }, /size/);
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'Odd', size: 1, kind: 'q' } }, /kind/);
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'Half', size: 1.5, kind: 'a' } }, /size/);
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: { $gt: '' }, size: 1, kind: 'a' } }, /name/);
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'x'.repeat(5000), size: 1, kind: 'a' } });
  // Fields the action does not ask for (or the server's own: id, player) are refused, not quietly kept.
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'Lamp', size: 2, kind: 'b', player: ID.tom } }, /does not take player/);
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'Lamp', size: 2, kind: 'b', id: 'evil' } }, /does not take id/);
  const lamp = (await ok('POST', `${R}/add-item`, T.jess, { values: { name: 'Lamp', size: 2, kind: 'b' } })).record;
  assert.equal(lamp.player ?? null, null, 'a shared record has no owner');
  await refused('POST', `${R}/start`, T.jess, { values: { item: 'rec_nope' } }, /item|not found|no /i);
});

test('ModsEdge: a player cannot touch another player\'s records, or run a GM action, even by id', async () => {
  const R = `${M()}/edge-list/records`;
  const items = (await ok('GET', `${M()}/edge-list/records?kind=item`, T.gm)).records.item;
  const rope = items.find((x: any) => x.name === 'Rope');
  const tomJob = (await ok('POST', `${R}/start`, T.tom, { values: { item: rope.id } })).record;
  await refused('POST', `${R}/drop`, T.jess, { recordId: tomJob.id });
  await refused('POST', `${R}/bump`, T.jess, { recordId: tomJob.id, amount: 5 });
  const seen = (await ok('GET', `${M()}/edge-list/records?kind=job`, T.jess)).records.job;
  assert.ok(!seen.some((x: any) => x.id === tomJob.id), "Jess cannot list Tom's job");
  const asTom = (await ok('GET', `${M()}/edge-list/records?kind=job&player=${ID.tom}`, T.jess)).records.job;
  assert.equal(asTom.length, 0, 'a player asking for another player gets nothing');
  // The GM's add is clamped by the field's min, and odd amounts are refused.
  const low = await ok('POST', `${R}/bump`, T.gm, { recordId: tomJob.id, amount: -50 });
  assert.equal(low.record.done, 0);
  for (const amount of [Infinity, 'lots', null, 1e20]) await refused('POST', `${R}/bump`, T.gm, { recordId: tomJob.id, amount });
});

test('ModsEdge: a prompt answered twice, after closing, or by the GM is refused; one answer moves one record', async () => {
  const items = (await ok('GET', `${M()}/edge-list/records?kind=item`, T.gm)).records.item;
  const rope = items.find((x: any) => x.name === 'Rope');
  const open = await ok('POST', `${M()}/edge-list/prompts/day`, T.gm, {});
  const round = open.round?.id ?? open.id;
  assert.ok(round, JSON.stringify(open));
  const A = `${M()}/edge-list/prompts/round/${round}/answer`;
  await ok('POST', A, T.jess, { choice: 0, values: { item: rope.id } });
  await refused('POST', A, T.jess, { choice: 0, values: { item: rope.id } });
  await refused('POST', A, T.tom, { choice: 7 });
  await refused('POST', A, T.tom, { choice: -1 });
  const jobs = (await ok('GET', `${M()}/edge-list/records?kind=job`, T.jess)).records.job;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].done, 1, 'the day timer moved her new job once');
  await ok('POST', `${M()}/edge-list/prompts/round/${round}/close`, T.gm, {});
  await refused('POST', A, T.tom, { choice: 1 });
});

test('ModsEdge: a rule turned off stops its actions and prompts; removing it leaves nothing behind', async () => {
  const R = `${M()}/edge-list/records`;
  const open = await ok('POST', `${M()}/edge-list/prompts/day`, T.gm, {});
  const round = open.round?.id ?? open.id;
  await ok('PUT', `${M()}/edge-list/enabled`, T.gm, { on: false });
  await refused('POST', `${R}/add-item`, T.jess, { values: { name: 'Late', size: 1, kind: 'a' } }, /off|No house rule/);
  await refused('POST', `${R}/add-item`, T.gm, { values: { name: 'Late', size: 1, kind: 'a' } }, /off/);
  await refused('POST', `${M()}/edge-list/prompts/round/${round}/answer`, T.jess, { choice: 1 });
  const openNow = (await ok('GET', `${M()}/prompts/open`, T.jess)).rounds;
  assert.ok(!openNow.some((r: any) => r.mod === 'edge-list'), 'an off rule shows no open prompt');
  await ok('DELETE', `${M()}/edge-list`, T.gm);
  await refused('GET', `${M()}/edge-list/records`, T.gm, undefined);
  // Importing it again starts clean: seeds again, no old records.
  await ok('POST', `${M()}/import`, T.gm, { mod: LIST });
  await ok('PUT', `${M()}/edge-list/enabled`, T.gm, { on: true });
  const again = (await ok('GET', `${M()}/edge-list/records`, T.gm)).records;
  assert.deepEqual(again.item.map((x: any) => x.name), ['Rope']);
  assert.equal(again.job.length, 0);
  await ok('DELETE', `${M()}/edge-list`, T.gm);
});

test('ModsEdge: counters hold at the cap and at zero, a lower max later clamps, ids that do not exist are plain errors', async () => {
  await ok('POST', `${M()}/import`, T.gm, { mod: POINTS });
  await ok('PUT', `${M()}/edge-points/enabled`, T.gm, { on: true });
  const act = (tok: string, body: unknown) => call('POST', `${M()}/edge-points/act`, tok, body);
  await refused('POST', `${M()}/edge-points/act`, T.jess, { action: 'spend' }, /No Point left/);
  for (let i = 0; i < 3; i++) assert.ok((await act(T.gm, { action: 'give', player: ID.jess })).status < 300);
  await refused('POST', `${M()}/edge-points/act`, T.gm, { action: 'give', player: ID.jess }, /most/);
  await refused('POST', `${M()}/edge-points/act`, T.gm, { action: 'nope', player: ID.jess });
  await refused('POST', `${M()}/edge-points/act`, T.gm, { action: 'give', player: 'acc_nobody' });
  await refused('POST', `${M()}/edge-points/act`, T.jess, { action: 'give', player: ID.jess });
  await refused('POST', `${M()}/nope/act`, T.gm, { action: 'give', player: ID.jess });
  // A new version with a lower max: Jess's 3 become 2.
  await ok('POST', `${M()}/import`, T.gm, { mod: { ...POINTS, version: '1.1.0', resources: [{ id: 'pt', label: 'Point', max: 2 }] } });
  const c = await ok('GET', `${M()}/counters`, T.jess);
  assert.equal(c.players[0].mods['edge-points'][0].value, 2);
  await ok('DELETE', `${M()}/edge-points`, T.gm);
});

test('ModsEdge: a world holds at most 50 of its own rules, and a package that does not fit adds none', async () => {
  const have = (await ok('GET', M(), T.gm)).mods.filter((m: any) => m.source === 'imported').length;
  const many = Array.from({ length: 25 }, (_, i) => ({ kit: 2, id: `bulk-${i}`, name: `Bulk ${i}` }));
  await ok('POST', `${M()}/import`, T.gm, { mod: { type: 'alexandria-house-rules', kit: 2, name: 'A', mods: many } });
  const rest = 50 - have - 25;
  await ok('POST', `${M()}/import`, T.gm, { mod: { type: 'alexandria-house-rules', kit: 2, name: 'B', mods: many.slice(0, rest - 2).map((m, i) => ({ ...m, id: `bulk-${i + 25}` })) } });
  const tooBig = { type: 'alexandria-house-rules', kit: 2, name: 'C', mods: [0, 1, 2].map((i) => ({ kit: 2, id: `late-${i}`, name: `Late ${i}` })) };
  await refused('POST', `${M()}/import`, T.gm, { mod: tooBig }, /room for 2/);
  const ids = (await ok('GET', M(), T.gm)).mods.map((m: any) => m.id);
  assert.ok(!ids.some((x: string) => x.startsWith('late-')), 'none of the package was added');
  await ok('POST', `${M()}/import`, T.gm, { mod: { ...tooBig, mods: tooBig.mods.slice(0, 2) } });
  await refused('POST', `${M()}/import`, T.gm, { mod: { kit: 2, id: 'one-more', name: 'One too many' } }, /50/);
  await ok('POST', `${M()}/import`, T.gm, { mod: { kit: 2, id: 'bulk-0', name: 'Bulk 0 again' } }, );
  for (const id of (await ok('GET', M(), T.gm)).mods.filter((m: any) => /^(bulk|late)-/.test(m.id)).map((m: any) => m.id)) await ok('DELETE', `${M()}/${id}`, T.gm);
});

// ---- the popular table rules that ship in mods/ ------------------------------------------------------------------

test('ModsEdge: the party inspiration pool is shared, refuses a draw when empty, and turns inspiration rerolls off', async () => {
  await ok('POST', `/api/worlds/${W}/sessionchat/sessions/start`, T.gm, { title: 'Table rules' });
  await ok('PUT', `${M()}/inspiration-rerolls/enabled`, T.gm, { on: true });
  const on = await ok('PUT', `${M()}/party-inspiration/enabled`, T.gm, { on: true });
  assert.deepEqual(on.turnedOff ?? [], ['inspiration-rerolls']);
  const R = `${M()}/party-inspiration/records`;
  const pool = (await ok('GET', `${M()}/party-inspiration/records?kind=pool`, T.jess)).records.pool[0];
  assert.equal(pool.points, 0);
  await refused('POST', `${R}/draw`, T.jess, { recordId: pool.id }, /Not enough Points left/);
  await ok('POST', `${R}/add`, T.gm, { recordId: pool.id, amount: 2, note: 'Great plan' });
  await ok('POST', `${R}/draw`, T.jess, { recordId: pool.id, note: 'Sneaking past the guard' });
  const left = await ok('POST', `${R}/draw`, T.tom, { recordId: pool.id });
  assert.equal(left.record.points, 0, 'both players draw from the same pool');
  await refused('POST', `${R}/add`, T.jess, { recordId: pool.id, amount: 5 });
  const capped = await ok('POST', `${R}/add`, T.gm, { recordId: pool.id, amount: 50 });
  assert.equal(capped.record.points, 10, 'the GM adding a lot holds at the most');
  const chat = (await ok('GET', `/api/worlds/${W}/sessionchat/chat/table`, T.gm)).messages.map((x: any) => x.body).join('\n');
  assert.match(chat, /Jessamine draws on the party's inspiration \(1 left\)\. Sneaking past the guard/);
  await ok('PUT', `${M()}/party-inspiration/enabled`, T.gm, { on: false });
});

test('ModsEdge: lingering injuries heal over long rests; one of 0 days waits for magic', async () => {
  await ok('PUT', `${M()}/lingering-injuries/enabled`, T.gm, { on: true });
  const R = `${M()}/lingering-injuries/records`;
  const ribs = (await ok('POST', `${R}/injure`, T.gm, { player: ID.jess, values: { name: 'Broken ribs', effect: 'Disadvantage on Constitution saves', days: 2 } })).record;
  const eye = (await ok('POST', `${R}/injure`, T.gm, { player: ID.jess, values: { name: 'Lost eye', effect: 'Disadvantage on sight-based Perception', days: 0 } })).record;
  await refused('POST', `${R}/injure`, T.jess, { values: { name: 'Fake', effect: 'x', days: 1 } });
  const tomSees = (await ok('GET', `${M()}/lingering-injuries/records?kind=injury`, T.tom)).records.injury;
  assert.equal(tomSees.length, 0, "Tom does not see Jess's injuries");
  for (let i = 0; i < 3; i++) await ok('POST', `/api/worlds/${W}/clock/advance`, T.gm, { preset: 'long-rest' });
  const mine = Object.fromEntries((await ok('GET', `${M()}/lingering-injuries/records?kind=injury`, T.jess)).records.injury.map((r: any) => [r.id, r]));
  assert.equal(mine[ribs.id].status, 'healed');
  assert.equal(mine[eye.id].status, 'open', 'magic only');
  await ok('POST', `${R}/heal`, T.gm, { recordId: eye.id, note: 'Regenerate' });
  await refused('POST', `${R}/heal`, T.gm, { recordId: eye.id });
  const chat = (await ok('GET', `/api/worlds/${W}/sessionchat/chat/table`, T.gm)).messages.map((x: any) => x.body).join('\n');
  assert.match(chat, /Jessamine suffers a lingering injury: Broken ribs\. Disadvantage on Constitution saves/);
  assert.match(chat, /Jessamine's Broken ribs has healed\./);
  assert.match(chat, /Jessamine's Lost eye has healed\./);
  await ok('PUT', `${M()}/lingering-injuries/enabled`, T.gm, { on: false });
});

test('ModsEdge: every rules-only table rule turns on, adds its glossary term, and tells the assistant', async () => {
  for (const id of ['potion-bonus-action', 'flanking-bonus', 'skill-check-crits', 'hidden-death-saves', 'max-hp-level', 'gritty-rests']) {
    await ok('PUT', `${M()}/${id}/enabled`, T.gm, { on: true });
    const rules = (await ok('GET', `${M()}/rules`, T.jess)).rules;
    assert.ok(rules.some((r: any) => r.mod === id), `${id} in the glossary`);
    await ok('PUT', `${M()}/${id}/enabled`, T.gm, { on: false });
  }
});
