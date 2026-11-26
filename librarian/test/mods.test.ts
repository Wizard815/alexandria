// House rules (mods): the file format and its checks, the shipped rules,
// turning rules on and off (groups, presets and restoring settings), options,
// counters and who may change them, rerolls in session chat (/reroll and the
// act route), triggers on rests and sessions, the glossary and imports.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { checkMod, commandActions, presetValues, resolveOptions } from '../src/features/mods/format.ts';
import { INSPIRATION_REROLLS } from '../src/features/mods/catalog.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const M = () => `/api/worlds/${W}/mods`;
const CH = () => `/api/worlds/${W}/sessionchat`;

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
const settings = () => ok('GET', `/api/worlds/${W}/settings`, T.dm);
const counts = async (who: string, mod = 'inspiration-rerolls') => {
  const c = await ok('GET', `${M()}/counters`, T.dm);
  const p = c.players.find((x: any) => x.accountId === ID[who]);
  return Object.fromEntries(p.mods[mod].map((x: any) => [x.id, x.value]));
};
const say = (who: string, body: string, replyTo?: string) => ok('POST', `${CH()}/chat/table`, T[who], { body, ...(replyTo ? { replyTo } : {}) });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-mods-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Ruleholm', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- the format ---------------------------------------------------------------------------------------------------

test('Mods: the inspiration rerolls rule is a valid mod with its chat words', () => {
  const { mod, errors } = checkMod(INSPIRATION_REROLLS);
  assert.deepEqual(errors, []);
  assert.equal(mod!.resources.length, 3);
  assert.deepEqual(commandActions(mod!).map((c) => `${c.word} ${c.arg} ${c.action}`), ['reroll personal use-personal', 'reroll everyone use-everyone', 'reroll dm use-dm']);
  assert.deepEqual(resolveOptions(mod!, { cap: 4, keepBetter: 'yes' }), { cap: 4, keepBetter: false });
});

test('Mods: a bad file gets plain errors the assistant can fix', () => {
  const r = checkMod({
    id: 'Hero Points', name: 'Hero points',
    options: { cap: { type: 'int', default: 20, min: 0, max: 9, label: 'Cap' } },
    resources: [{ id: 'hero', label: 'Hero point', max: '$nope' }],
    actions: [{ id: 'spend', label: 'Spend', by: 'someone', resource: 'heroes', add: -1, effect: { explode: true } }],
    commands: [{ word: 'roll', action: 'spend' }, { word: 'hero', args: ['x'], action: 'use-$1' }],
    sheet: { resources: ['villain'] },
    colour: 'red',
  });
  assert.equal(r.mod, null);
  const all = r.errors.join('\n');
  for (const want of [/^id must be a short id/m, /options\.cap\.default must be a whole number from 0 to 9/, /"\$nope" is not a whole-number option/, /by must be one of dm, owner, player, any/,
    /uses resource "heroes", which this mod does not define/, /effect\.explode is not an effect/, /word "roll" belongs to the chat itself/, /points at action "use-x"/, /sheet\.resources: "villain"/, /"colour" is not part of a mod/]) {
    assert.match(all, want);
  }
  assert.deepEqual(checkMod('{not json').errors.length, 1);
  assert.match(checkMod('x'.repeat(70_000)).errors[0], /larger than 64 KB/);
});

test('Mods: presets read the options', () => {
  const { mod } = checkMod({ id: 'p', name: 'P', options: { a: { type: 'enum', values: ['dm', 'auto'], default: 'dm', label: 'A' } }, presets: { spellCraftApproval: '$a', spellCrafting: true } });
  assert.deepEqual(presetValues(mod!, { a: 'auto' }), { spellCraftApproval: 'auto', spellCrafting: true });
});

// ---- shipped rules, on and off --------------------------------------------------------------------------------------

test('Mods: the DM sees every shipped rule; players see only rules that are on', async () => {
  const dm = await ok('GET', M(), T.dm);
  const ids = dm.mods.map((m: any) => m.id);
  for (const id of ['inspiration-rerolls', 'mana-system', 'spell-points', 'mana-pool', 'spell-crafting']) assert.ok(ids.includes(id), id);
  assert.deepEqual(dm.mods.find((m: any) => m.id === 'mana-system').missing, ['spellRulesOn']);
  assert.equal((await ok('GET', M(), T.jess)).mods.length, 0);
  assert.equal((await call('PUT', `${M()}/inspiration-rerolls/enabled`, T.jess, { on: true })).status, 403);
  assert.equal((await call('PUT', `${M()}/mana-system/enabled`, T.dm, { on: true })).status, 409);
});

test('Mods: magic rules are one group; turning one off restores the settings it changed', async () => {
  const before0 = await settings();
  assert.equal(before0.spellMana, false);
  await ok('PUT', `${M()}/spell-points/enabled`, T.dm, { on: true });
  let s = await settings();
  assert.equal(s.spellMana, true);
  assert.deepEqual(s.spellManaCosts, [0, 2, 3, 5, 6, 7, 9, 10, 11, 13]);
  assert.equal(s.spellManaPool.table[19], 133);
  assert.equal(s.spellManaMaxLevel.on, true);
  // The simple mana pool takes over: spell points goes off first.
  const sw = await ok('PUT', `${M()}/mana-pool/enabled`, T.dm, { on: true });
  assert.deepEqual(sw.turnedOff, ['spell-points']);
  s = await settings();
  assert.deepEqual(s.spellManaCosts, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  await ok('PUT', `${M()}/mana-pool/enabled`, T.dm, { on: false });
  s = await settings();
  assert.equal(s.spellMana, false);
  assert.deepEqual(s.spellManaCosts, before0.spellManaCosts);
  assert.deepEqual(s.spellManaMaxLevel, before0.spellManaMaxLevel);
});

test('Mods: spell crafting (Codex) switches on with the DM\'s approval option', async () => {
  await ok('PUT', `${M()}/spell-crafting/enabled`, T.dm, { on: true });
  assert.equal((await settings()).spellCrafting, true);
  assert.equal((await settings()).spellCraftApproval, 'dm');
  assert.equal((await call('PUT', `${M()}/spell-crafting/options`, T.dm, { options: { approval: 'never' } })).status, 400);
  await ok('PUT', `${M()}/spell-crafting/options`, T.dm, { options: { approval: 'auto' } });
  assert.equal((await settings()).spellCraftApproval, 'auto');
  await ok('PUT', `${M()}/spell-crafting/enabled`, T.dm, { on: false });
  assert.equal((await settings()).spellCrafting, false);
  assert.equal((await settings()).spellCraftApproval, 'dm');
});

// ---- inspiration rerolls --------------------------------------------------------------------------------------------

test('Mods: the DM grants rerolls with a reason, up to the cap; players cannot grant', async () => {
  await ok('PUT', `${M()}/inspiration-rerolls/enabled`, T.dm, { on: true });
  assert.equal((await ok('GET', M(), T.jess)).mods.length, 1);
  const g = await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: 'Jessamine', resource: 'personal', note: 'Stayed in character' });
  assert.deepEqual([g.before, g.after], [0, 1]);
  const cap = await call('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.jess, resource: 'personal' });
  assert.equal(cap.status, 409);
  assert.match(cap.body.error, /most Personal reroll allowed \(1\)/);
  assert.equal((await call('POST', `${M()}/inspiration-rerolls/act`, T.jess, { action: 'grant', resource: 'personal' })).status, 403);
  assert.equal((await call('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.jess })).status, 400);
  // Players see only their own counters.
  const mine = await ok('GET', `${M()}/counters`, T.jess);
  assert.deepEqual(mine.players.map((p: any) => p.accountId), [ID.jess]);
  const log = await ok('GET', `${M()}/log`, T.jess);
  assert.equal(log.log[0].note, 'Stayed in character');
  assert.equal((await ok('GET', `${M()}/log`, T.tom)).log.length, 0);
});

test('Mods: /reroll personal rerolls your own latest roll on the server and spends the token', async () => {
  await ok('POST', `${CH()}/sessions/start`, T.dm, { title: 'Night one' });
  const first = await say('jess', '/roll 1d20+3 stealth');
  await say('tom', '/roll 1d20 perception');
  const re = await say('jess', '/reroll personal');
  assert.equal(re.kind, 'roll');
  assert.equal(re.replyTo.id, first.id);
  assert.match(re.roll.note, new RegExp(`stealth · reroll of Jessamine's ${first.roll.total} \\(Personal reroll\\)`));
  assert.equal(re.roll.expr, first.roll.expr);
  assert.equal((await counts('jess')).personal, 0);
  const none = await call('POST', `${CH()}/chat/table`, T.jess, { body: '/reroll personal' });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /No Personal reroll left/);
  const bad = await call('POST', `${CH()}/chat/table`, T.jess, { body: '/reroll sideways' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /\/reroll personal, \/reroll everyone, \/reroll dm/);
});

test('Mods: an everyone reroll works on an ally\'s roll; a personal one does not', async () => {
  await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.jess, resource: 'everyone', note: 'Great speech' });
  await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.jess, resource: 'personal' });
  const toms = await say('tom', '/roll 1d20+1 save');
  const wrong = await call('POST', `${M()}/inspiration-rerolls/act`, T.jess, { action: 'use-personal', rollId: toms.id });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /one of your own rolls/);
  const r = await ok('POST', `${M()}/inspiration-rerolls/act`, T.jess, { action: 'use-everyone', rollId: toms.id });
  assert.equal(r.roll.was, toms.roll.total);
  assert.equal((await counts('jess')).everyone, 0);
  assert.equal((await counts('jess')).personal, 1);
  // Only Jess can spend Jess's tokens.
  assert.equal((await call('POST', `${M()}/inspiration-rerolls/act`, T.tom, { action: 'use-personal', player: ID.jess, atTable: true })).status, 403);
});

test('Mods: a DM reroll makes the DM roll again; keep the better posts which one stands', async () => {
  await ok('PUT', `${M()}/inspiration-rerolls/options`, T.dm, { options: { keepBetter: true, cap: 2 } });
  await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.tom, resource: 'dm' });
  const dms = await say('dm', '/roll 1d20+5 goblin attack');
  assert.equal((await call('POST', `${CH()}/chat/table`, T.tom, { body: '/reroll personal' })).status, 409);
  const r = await say('tom', '/reroll dm', dms.id);
  assert.equal(r.replyTo.id, dms.id);
  const after2 = await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.tom, resource: 'dm' });
  assert.equal(after2.after, 1);
  const api = await ok('POST', `${M()}/inspiration-rerolls/act`, T.tom, { action: 'use-dm' });
  assert.equal(api.roll.kept, Math.max(api.roll.total, api.roll.was));
  const chat = await ok('GET', `${CH()}/chat/table`, T.dm);
  assert.match(chat.messages.at(-1).body, /^Keeps the better roll: \d+/);
});

test('Mods: a lower cap clamps what players hold; a token spent at the table needs no chat roll', async () => {
  await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.jess, resource: 'personal' });
  assert.equal((await counts('jess')).personal, 2);
  await ok('PUT', `${M()}/inspiration-rerolls/options`, T.dm, { options: { cap: 1 } });
  assert.equal((await counts('jess')).personal, 1);
  const r = await ok('POST', `${M()}/inspiration-rerolls/act`, T.jess, { action: 'use-personal', atTable: true });
  assert.deepEqual([r.before, r.after], [1, 0]);
  assert.equal((await ok('GET', `${M()}/log`, T.jess)).log[0].note, 'at the table');
});

test('Mods: the rule text joins the glossary while the rule is on', async () => {
  const hits = await ok('GET', `/api/worlds/${W}/modules/terms?q=${encodeURIComponent('Inspiration (house rule)')}`, T.jess);
  const list = hits.terms ?? hits.results ?? [];
  assert.ok(list.some((t: any) => t.term === 'Inspiration (house rule)' && t.moduleId === 'house-inspiration-rerolls'), JSON.stringify(hits).slice(0, 300));
  const rules = await ok('GET', `${M()}/rules`, T.tom);
  assert.equal(rules.rules[0].mod, 'inspiration-rerolls');
});

// ---- imported rules and triggers ------------------------------------------------------------------------------------

const HERO = {
  kit: 1, id: 'hero-points', name: 'Hero points', summary: '1 per session, refilled on a long rest.',
  options: { max: { type: 'int', default: 3, min: 1, max: 10, label: 'Most hero points' } },
  resources: [{ id: 'hero', label: 'Hero point', icon: 'fa-star', max: '$max', start: 1 }],
  actions: [
    { id: 'spend', label: 'Spend', by: 'owner', resource: 'hero', add: -1, effect: { chat: '{name} spends a hero point: +1d6 ({note})', dmnote: '{name} used a hero point' } },
    { id: 'give', label: 'Give', by: 'dm', resource: 'hero', add: 1 },
  ],
  triggers: [{ on: 'longRest', resource: 'hero', set: 'max' }, { on: 'sessionStart', resource: 'hero', add: 1 }],
  commands: [{ word: 'hero', action: 'spend' }],
  sheet: { title: 'Hero points' },
  rules: [{ term: 'Hero points', text: 'Spend one to add 1d6 to a roll.' }],
};

test('Mods: the DM checks, imports, exports and removes a rule; shipped ids are taken', async () => {
  const chk = await ok('POST', `${M()}/check`, T.dm, { mod: { ...HERO, actions: [] } });
  assert.equal(chk.ok, false);
  const good = await ok('POST', `${M()}/check`, T.dm, { mod: HERO });
  assert.equal(good.ok, true);
  assert.equal((await call('POST', `${M()}/check`, T.jess, { mod: HERO })).status, 403);
  assert.equal((await call('POST', `${M()}/import`, T.dm, { mod: { ...INSPIRATION_REROLLS } })).status, 409);
  const imp = await call('POST', `${M()}/import`, T.dm, { mod: HERO });
  assert.equal(imp.status, 201);
  assert.equal(imp.body.enabled, false);
  const ex = await ok('GET', `${M()}/hero-points/export`, T.dm);
  assert.equal(ex.id, 'hero-points');
  assert.equal(ex.kit, 1);
  assert.equal((await call('DELETE', `${M()}/inspiration-rerolls`, T.dm)).status, 400);
});

test('Mods: triggers run on a long rest and at session start; chat words and effects work', async () => {
  await ok('PUT', `${M()}/hero-points/enabled`, T.dm, { on: true });
  assert.equal((await counts('jess', 'hero-points')).hero, 1);
  const used = await say('jess', '/hero sneaking past');
  assert.match(used.body, /Spend: Hero point 1 → 0 \(sneaking past\)/);
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'long-rest' });
  assert.equal((await counts('jess', 'hero-points')).hero, 3);
  await ok('POST', `${M()}/hero-points/act`, T.jess, { action: 'spend', note: 'the lock' });
  const chat = await ok('GET', `${CH()}/chat/table`, T.dm);
  assert.equal(chat.messages.at(-1).body, 'Jessamine spends a hero point: +1d6 (the lock)');
  await ok('POST', `${CH()}/sessions/end`, T.dm);
  await ok('POST', `${CH()}/sessions/start`, T.dm, { title: 'Night two' });
  assert.equal((await counts('jess', 'hero-points')).hero, 3);
  assert.equal((await counts('tom', 'hero-points')).hero, 3);
  // A new version keeps counters; removing the rule drops them.
  await ok('POST', `${M()}/import`, T.dm, { mod: { ...HERO, version: '1.1.0' } });
  assert.equal((await counts('jess', 'hero-points')).hero, 3);
  await ok('DELETE', `${M()}/hero-points`, T.dm);
  assert.equal((await ok('GET', M(), T.dm)).mods.some((m: any) => m.id === 'hero-points'), false);
});
