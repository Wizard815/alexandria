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
import { checkMod, commandActions, impliedPermissions, makePackage, presetValues, resolveOptions, toFile, unpack } from '../src/features/mods/format.ts';
import { MODS_DIR, loadModsDir, shippedMod, shippedMods } from '../src/features/mods/catalog.ts';
import { DEFAULT_COSTS, DEFAULT_MAX_LEVEL, DEFAULT_POOL, DEFAULT_REST } from '../src/features/spells/mana.ts';

const INSPIRATION_REROLLS = JSON.parse(fs.readFileSync(path.join(MODS_DIR, 'inspiration-rerolls.alxmod.json'), 'utf8'));
import { migrateSheetRerolls } from '../src/features/mods/index.ts';
import { all } from '../src/core/db.ts';

let base = '';
let server: any;
let db: any;
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
  db = made.deps.db;
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

test('Mods: every rule file in the repo\'s mods/ folder is a built-in rule, claimed by its feature', () => {
  const files = fs.readdirSync(MODS_DIR).filter((n) => n.endsWith('.alxmod.json'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const { mods, errors } = unpack(fs.readFileSync(path.join(MODS_DIR, f), 'utf8'));
    assert.deepEqual(errors, [], f);
    for (const m of mods) assert.ok(shippedMod(m.id), `${m.id} is shipped`);
  }
  for (const f of fs.readdirSync(path.join(MODS_DIR, 'examples'))) assert.deepEqual(unpack(fs.readFileSync(path.join(MODS_DIR, 'examples', f), 'utf8')).errors, [], f);
  assert.equal(shippedMod('hero-points'), undefined, 'examples are not built in');
  assert.equal(shippedMod('spell-points')!.feature, 'spells');
  assert.equal(shippedMod('inspiration-rerolls')!.feature, 'mods');
  assert.equal(new Set(shippedMods().map((s) => s.mod.id)).size, shippedMods().length);
  // The simple mana pool sets the spells feature's own defaults back.
  const pool = shippedMod('mana-pool')!.mod.presets;
  assert.deepEqual([pool.spellManaCosts, pool.spellManaPool, pool.spellManaRest, pool.spellManaMaxLevel], [DEFAULT_COSTS, DEFAULT_POOL, DEFAULT_REST, DEFAULT_MAX_LEVEL]);
});

test('Mods: a drop-in folder adds rules and skips broken files without stopping', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-mods-'));
  fs.writeFileSync(path.join(dir, 'pack.alxmod.json'), JSON.stringify(makePackage([checkMod({ kit: 1, id: 'drop-a', name: 'A' }).mod!, checkMod({ kit: 1, id: 'drop-b', name: 'B' }).mod!], { alexandria: 'test' })));
  fs.writeFileSync(path.join(dir, 'broken.alxmod.json'), '{ nope');
  fs.writeFileSync(path.join(dir, 'twice.alxmod.json'), JSON.stringify({ kit: 1, id: 'spell-points', name: 'Again' }));
  const warn = console.warn; console.warn = () => {};
  try {
    const r = loadModsDir(dir);
    assert.deepEqual(r.loaded, ['drop-a', 'drop-b']);
    assert.equal(r.problems.length, 2);
    assert.equal(shippedMod('drop-b')!.mod.name, 'B');
  } finally { console.warn = warn; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Mods: a package holds several rules; a bad rule in it names where', () => {
  const a = checkMod({ kit: 1, id: 'pkg-a', name: 'A' }).mod!;
  const pkg = makePackage([a, checkMod({ kit: 1, id: 'pkg-b', name: 'B' }).mod!], { alexandria: '1.0', author: 'Wizard' });
  assert.equal(pkg.summary, 'A, B');
  const back = unpack(JSON.stringify(pkg));
  assert.deepEqual(back.mods.map((m) => m.id), ['pkg-a', 'pkg-b']);
  assert.equal(back.info!.author, 'Wizard');
  assert.deepEqual(unpack({ kit: 1, id: 'solo', name: 'Solo' }).mods.map((m) => m.id), ['solo']);
  const bad = unpack({ type: 'alexandria-house-rules', kit: 1, mods: [toFile(a), { id: 'Bad Id', name: 'x' }, toFile(a)] });
  assert.equal(bad.mods.length, 0);
  assert.ok(bad.errors.some((e) => e.startsWith('mods[1] (Bad Id)')), bad.errors.join('\n'));
  assert.ok(bad.errors.some((e) => e.includes('in the package twice')));
  assert.match(unpack({ type: 'alexandria-house-rules', kit: 9, mods: [a] }).errors[0], /newer Alexandria/);
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
  assert.match(checkMod('x'.repeat(130_000)).errors[0], /larger than 128 KB/);
});

test('Mods: presets read the options', () => {
  const { mod } = checkMod({ id: 'p', name: 'P', options: { a: { type: 'enum', values: ['dm', 'auto'], default: 'dm', label: 'A' } }, presets: { spellCraftApproval: '$a', spellCrafting: true } });
  assert.deepEqual(presetValues(mod!, { a: 'auto' }), { spellCraftApproval: 'auto', spellCrafting: true });
});

// ---- shipped rules, on and off --------------------------------------------------------------------------------------

test('Mods: the GM sees every shipped rule; players see only rules that are on', async () => {
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

test('Mods: spell crafting (Codex) switches on with the GM\'s approval option', async () => {
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

test('Mods: the GM grants rerolls with a reason, up to the cap; players cannot grant', async () => {
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

test('Mods: a GM reroll makes the GM roll again; keep the better posts which one stands', async () => {
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

test('Mods: the GM checks, imports, exports and removes a rule; shipped ids are taken', async () => {
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
  assert.equal(ex.type, 'alexandria-house-rules');
  assert.equal(ex.kit, 2);
  assert.deepEqual(ex.mods.map((m: any) => m.id), ['hero-points']);
  assert.equal(ex.mods[0].name, 'Hero points');
  assert.equal((await call('DELETE', `${M()}/inspiration-rerolls`, T.dm)).status, 400);
  // A package: several rules in one file, checked and saved together; the export of what is on is a package too.
  const VOW = { kit: 1, id: 'vows', name: 'Vows', resources: [{ id: 'vow', label: 'Vow' }], actions: [{ id: 'give', label: 'Give', by: 'dm', resource: 'vow', add: 1 }] };
  const pkg = { type: 'alexandria-house-rules', kit: 1, name: 'Saltreach rules', mods: [HERO, VOW] };
  const pc = await ok('POST', `${M()}/check`, T.dm, { mod: pkg });
  assert.equal(pc.ok, true);
  assert.deepEqual(pc.mods.map((m: any) => m.id), ['hero-points', 'vows']);
  assert.equal(pc.package.name, 'Saltreach rules');
  assert.equal((await call('POST', `${M()}/import`, T.dm, { mod: { ...pkg, mods: [VOW, INSPIRATION_REROLLS] } })).status, 409);
  assert.equal((await ok('GET', `${M()}/`, T.dm)).mods.some((r: any) => r.id === 'vows'), false, 'nothing saved when one rule is refused');
  const pi = await call('POST', `${M()}/import`, T.dm, { mod: pkg });
  assert.equal(pi.status, 201);
  assert.deepEqual(pi.body.rules.map((r: any) => r.id), ['hero-points', 'vows']);
  const two = await ok('GET', `${M()}/export?ids=hero-points,vows`, T.dm);
  assert.deepEqual(two.mods.map((m: any) => m.id), ['hero-points', 'vows']);
  assert.equal((await call('GET', `${M()}/export`, T.jess)).status, 403);
  await ok('DELETE', `${M()}/vows`, T.dm);
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

test('Mods: the player sheet\'s re-rolls are the inspiration rule\'s counters', async () => {
  // The rule switched the sheet's Re-rolls module on with its cap.
  const s = await settings();
  assert.equal(s.sheetRerolls, true);
  assert.equal(s.sheetRerollCap, 1);
  // A party re-roll given on the sheet is the rule's everyone reroll, and the other way round.
  await ok('POST', `/api/worlds/${W}/sheet/${ID.tom}/rerolls`, T.dm, { kind: 'party', delta: 1, note: 'Sang the sea shanty' });
  assert.equal((await counts('tom')).everyone, 1);
  await ok('POST', `${M()}/inspiration-rerolls/act`, T.dm, { action: 'grant', player: ID.tom, resource: 'personal' });
  const sheet = await ok('GET', `/api/worlds/${W}/sheet/me`, T.tom);
  assert.equal(sheet.rerolls.party, 1);
  assert.equal(sheet.rerolls.personal, 1);
  const log = await ok('GET', `${M()}/log`, T.tom);
  assert.ok(log.log.some((l: any) => l.resource === 'everyone' && l.note === 'Sang the sea shanty'));
  // Turning the rule off puts the sheet back as it was.
  await ok('PUT', `${M()}/inspiration-rerolls/enabled`, T.dm, { on: false });
  assert.equal((await settings()).sheetRerolls, false);
  await ok('PUT', `${M()}/inspiration-rerolls/enabled`, T.dm, { on: true });
});

test('Mods: a world that used the sheet\'s re-roll switch gets the house rule on, with its cap and counts', async () => {
  const settings0 = JSON.parse(db.prepare('SELECT settings FROM worlds WHERE id = ?').get(W).settings);
  db.prepare("DELETE FROM mods WHERE world_id = ? AND id = 'inspiration-rerolls'").run(W);
  db.prepare("DELETE FROM mod_counts WHERE world_id = ? AND mod_id = 'inspiration-rerolls'").run(W);
  db.prepare('UPDATE worlds SET settings = ? WHERE id = ?').run(JSON.stringify({ ...settings0, sheetRerolls: true, sheetRerollCap: 4 }), W);
  db.prepare("INSERT OR REPLACE INTO sheet_rerolls (world_id, account_id, kind, count, updated_at) VALUES (?, ?, 'party', 3, 'x')").run(W, ID.jess);
  migrateSheetRerolls(db);
  migrateSheetRerolls(db); // again: nothing changes
  const r = (await ok('GET', M(), T.dm)).mods.find((m: any) => m.id === 'inspiration-rerolls');
  assert.equal(r.enabled, true);
  assert.equal(r.options.cap, 4);
  assert.equal((await counts('jess')).everyone, 3);
  // Turning it off now goes back to the sheet's defaults.
  await ok('PUT', `${M()}/inspiration-rerolls/enabled`, T.dm, { on: false });
  assert.equal((await settings()).sheetRerolls, false);
});

// ---- kit 2: versions, targets, needed rules, conflicts, permissions -----------------------------------------------

test('Mods: a kit 2 manifest is checked field by field', () => {
  const good = checkMod({
    kit: 2, id: 'downtime-lite', name: 'Downtime lite', version: '1.2.0', alexandria: '>=0.1', api: 0,
    targets: { builtFor: ['sheet', 'table'], worksWith: ['codex', 'sheet'] },
    requires: { mods: { 'inspiration-rerolls': '^1' } }, conflicts: ['hero-points'], permissions: ['records', 'chat.post'],
    commands: [{ word: 'rest', action: 'x' }], actions: [{ id: 'x', label: 'X', by: 'dm', resource: 'r', add: 1 }], resources: [{ id: 'r', label: 'R' }],
  });
  assert.deepEqual(good.errors, []);
  assert.equal(good.mod!.kit, 2);
  assert.deepEqual(good.mod!.targets.worksWith, ['codex'], 'a target in builtFor is not repeated in worksWith');
  assert.deepEqual(impliedPermissions(good.mod!), ['chat.post', 'chat.commands', 'records']);
  const bad = checkMod({
    kit: 3, id: 'bad', name: 'Bad', version: 'one', alexandria: 'soon', api: 'x', targets: { builtFor: ['Sheet!'], other: [] },
    requires: { mods: { bad: '1', 'hero-points': 'whenever' } }, conflicts: ['bad'], permissions: ['root'],
  });
  for (const want of [/kit 3 needs a newer Alexandria/, /version must look like/, /alexandria must be a version range/, /api must be/, /targets.builtFor\[0\]/, /targets.other/, /cannot need itself/, /requires.mods.hero-points/, /conflicts\[0\]/, /permissions\[0\] "root"/]) {
    assert.ok(bad.errors.some((e) => want.test(e)), `${want} in ${bad.errors.join(' | ')}`);
  }
});

test('Mods: a rule built for a missing part, or a newer Alexandria, cannot be turned on and says why', async () => {
  const rule = (id: string, extra: object) => ({ kit: 2, id, name: id, ...extra });
  await ok('POST', `${M()}/import`, T.dm, { mod: { type: 'alexandria-house-rules', kit: 2, mods: [
    rule('for-space', { targets: { builtFor: ['spaceships'] } }),
    rule('for-later', { alexandria: '>=99' }),
    rule('for-sheet', { targets: { builtFor: ['sheet', 'dnd-2024'], worksWith: ['codex'] } }),
  ] } });
  const list = (await ok('GET', `${M()}/`, T.dm)).mods;
  const by = (id: string) => list.find((r: any) => r.id === id);
  assert.match(by('for-space').needs[0], /Built for spaceships/);
  assert.match(by('for-later').needs[0], /Needs Alexandria >=99/);
  assert.deepEqual(by('for-sheet').needs, []);
  assert.deepEqual(by('for-sheet').targets.builtFor.map((t: any) => [t.label, t.ok]), [['Player sheet', true], ['dnd-2024', true]]);
  const r = await call('PUT', `${M()}/for-space/enabled`, T.dm, { on: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /cannot be turned on here: Built for spaceships/);
  const chk = await ok('POST', `${M()}/check`, T.dm, { mod: rule('for-later-2', { alexandria: '>=99', requires: { mods: { nowhere: '*' } } }) });
  assert.ok(chk.notes.some((n: string) => /built for Alexandria >=99/.test(n)));
  assert.ok(chk.notes.some((n: string) => /needs the house rule nowhere/.test(n)));
  for (const id of ['for-space', 'for-later', 'for-sheet']) await ok('DELETE', `${M()}/${id}`, T.dm);
});

test('Mods: turning a rule on turns on what it needs and off what it conflicts with; its needed rules stay until it goes', async () => {
  const base = { kit: 2, version: '1.4.0', resources: [{ id: 'p', label: 'P' }], actions: [{ id: 'g', label: 'G', by: 'dm', resource: 'p', add: 1 }] };
  await ok('POST', `${M()}/import`, T.dm, { mod: { type: 'alexandria-house-rules', kit: 2, mods: [
    { ...base, id: 'k-base', name: 'Base' },
    { ...base, id: 'k-rival', name: 'Rival' },
    { ...base, id: 'k-addon', name: 'Addon', requires: { mods: { 'k-base': '^1.2' } }, conflicts: ['k-rival'] },
    { ...base, id: 'k-old', name: 'Old addon', requires: { mods: { 'k-base': '^2' } } },
  ] } });
  await ok('PUT', `${M()}/k-rival/enabled`, T.dm, { on: true });
  const on = await ok('PUT', `${M()}/k-addon/enabled`, T.dm, { on: true });
  assert.deepEqual(on.turnedOn, ['k-base']);
  assert.deepEqual(on.turnedOff, ['k-rival']);
  const list = (await ok('GET', `${M()}/`, T.dm)).mods;
  assert.equal(list.find((r: any) => r.id === 'k-base').enabled, true);
  assert.match(list.find((r: any) => r.id === 'k-old').needs[0], /Needs Base \^2 \(this world has 1.4.0\)/);
  // Turning the base off would leave the addon without it: refused, unless the GM turns both off.
  const no = await call('PUT', `${M()}/k-base/enabled`, T.dm, { on: false });
  assert.equal(no.status, 409);
  assert.match(no.body.error, /Addon needs Base/);
  const both = await ok('PUT', `${M()}/k-base/enabled`, T.dm, { on: false, cascade: true });
  assert.deepEqual(both.turnedOff, ['k-addon']);
  assert.equal((await ok('GET', `${M()}/`, T.dm)).mods.find((r: any) => r.id === 'k-addon').enabled, false);
  for (const id of ['k-base', 'k-rival', 'k-addon', 'k-old']) await ok('DELETE', `${M()}/${id}`, T.dm);
});

// ---- kit 2 data systems: records, record actions, timers, prompts, views ------------------------------------------

const DOWNTIME = {
  kit: 2, id: 'downtime-lite', name: 'Downtime lite', version: '1.0.0', author: 'Wizard',
  targets: { builtFor: ['sheet'] },
  options: { common: { type: 'int', default: 1, min: 1, max: 30, label: 'Days for a common activity' } },
  records: {
    activity: { label: 'Activity', plural: 'Activities', fields: { name: 'text', tier: 'enum:common|rare|legendary', days: 'int', reward: 'text?' },
      seed: [{ name: 'Work a trade', tier: 'common', days: 2, reward: '5 gp' }, { name: 'Study a spell', tier: 'rare', days: 7 }] },
    task: { label: 'Task', owned: true, title: 'activity', fields: { activity: 'ref:activity', done: { type: 'int', default: 0, min: 0 }, goal: 'int', status: { type: 'enum', values: ['open', 'done', 'dropped'], default: 'open' } } },
  },
  recordActions: [
    { id: 'start', label: 'Start', by: 'owner', record: 'task', do: 'create', ask: ['activity'], copy: { via: 'activity', fields: { goal: 'days' } }, effect: { chat: '{name} starts {activity.name}' } },
    { id: 'work', label: 'Keep working', by: 'owner', record: 'task', do: 'set', where: { status: 'open' } },
    { id: 'adjust', label: 'Add or take days', by: 'dm', record: 'task', do: 'add', field: 'done', amount: 'ask' },
    { id: 'drop', label: 'Drop', by: 'any', record: 'task', do: 'remove', where: { status: 'open' } },
    { id: 'new-activity', label: 'New activity', by: 'player', record: 'activity', do: 'create', ask: ['name', 'tier', 'days'] },
  ],
  timers: [{ id: 'day', record: 'task', on: 'prompt:downtime-day', where: { status: 'open' }, field: 'done', add: 1, goal: 'goal', done: { set: { status: 'done' }, chat: '{name} finished {activity.name}: {activity.reward}' } }],
  prompts: [{ id: 'downtime-day', button: 'Downtime', title: 'A downtime day', choices: [{ label: 'Keep working', action: 'work' }, { label: 'Start something', action: 'start' }, { label: 'Skip', skip: true }] }],
  views: [
    { id: 'tasks', title: 'Downtime', record: 'task', place: 'dm', columns: ['player', 'activity', 'done', 'goal', 'status'], actions: ['adjust', 'drop'], groupByPlayer: true },
    { id: 'mine', title: 'My downtime', record: 'task', place: 'sheet', columns: ['activity', 'done', 'goal'], where: { status: 'open' }, actions: ['drop'] },
  ],
};

test('Mods: a data system is checked: kinds, fields, actions, timers, prompts and views', () => {
  const good = checkMod(DOWNTIME);
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.mod!.system.records.map((k) => k.id), ['activity', 'task']);
  assert.ok(impliedPermissions(good.mod!).includes('records'));
  // Its file shape checks again unchanged (what is saved and exported).
  assert.deepEqual(checkMod(toFile(good.mod!)).errors, []);
  const bad = checkMod({
    ...DOWNTIME,
    records: { ...DOWNTIME.records, task: { ...DOWNTIME.records.task, fields: { ...DOWNTIME.records.task.fields, activity: 'ref:nowhere', id: 'text', size: 'huge' } } },
    recordActions: [...DOWNTIME.recordActions, { id: 'bump', label: 'Bump', by: 'dm', record: 'task', do: 'add', field: 'status' }, { id: 'x', label: 'X', by: 'king', record: 'ghost', do: 'fly' }],
    timers: [{ record: 'task', on: 'prompt:nope', field: 'done', goal: 'status' }],
    views: [{ title: 'V', record: 'task', place: 'wall', columns: ['colour'], actions: ['new-activity'] }],
  });
  for (const want of [/ref "nowhere" is not a record kind/, /"id" cannot be a field name/, /"huge" is not a field type/, /recordActions\[5\].field must be a number field/, /recordActions\[6\].by/, /recordActions\[6\].record "ghost"/, /recordActions\[6\].do/, /timers\[0\].on/, /timers\[0\].goal "status"/, /views\[0\].place/, /views\[0\].columns: "colour"/, /"new-activity" works on activity, not task/]) {
    assert.ok(bad.errors.some((e) => want.test(e)), `${want} in ${bad.errors.join(' | ')}`);
  }
});

test('Mods: a data system runs: seeds, record actions with who may, a GM prompt, timers to the goal, and its log', async () => {
  await ok('POST', `${M()}/import`, T.dm, { mod: DOWNTIME });
  assert.equal((await call('GET', `${M()}/downtime-lite/records`, T.jess)).status, 404, 'a player sees nothing of a rule that is off');
  await ok('PUT', `${M()}/downtime-lite/enabled`, T.dm, { on: true });
  const acts = (await ok('GET', `${M()}/downtime-lite/records?kind=activity`, T.jess)).records.activity;
  assert.deepEqual(acts.map((a: any) => a.name), ['Work a trade', 'Study a spell'], 'the seed activities are there');
  const trade = acts[0].id;
  // Jess starts a task: it is hers, its goal comes from the activity's days.
  const started = await call('POST', `${M()}/downtime-lite/records/start`, T.jess, { values: { activity: trade } });
  assert.equal(started.status, 201);
  const task = started.body.record;
  assert.equal(task.player, ID.jess);
  assert.equal(task.goal, 2);
  assert.equal(task.status, 'open');
  assert.equal((await call('POST', `${M()}/downtime-lite/records/start`, T.jess, { values: { activity: trade, goal: 1 } })).status, 400, 'only asked fields');
  assert.equal((await call('POST', `${M()}/downtime-lite/records/adjust`, T.jess, { recordId: task.id, amount: 5 })).status, 403, 'adjust is the GM\'s');
  assert.equal((await call('POST', `${M()}/downtime-lite/records/work`, T.tom, { recordId: task.id })).status, 403, 'not Tomas\'s task');
  assert.equal((await ok('GET', `${M()}/downtime-lite/records?kind=task`, T.tom)).records.task.length, 0, 'Tomas does not see Jess\'s tasks');
  // A player adds an activity everyone can pick.
  const made = await ok('POST', `${M()}/downtime-lite/records/new-activity`, T.tom, { values: { name: 'Carve a figurehead', tier: 'legendary', days: 90 } });
  assert.equal(made.record.player, null);
  // The GM opens a downtime day; Jess keeps working, Tomas skips.
  const round = await call('POST', `${M()}/downtime-lite/prompts/downtime-day`, T.dm, {});
  assert.equal(round.status, 201);
  assert.equal((await call('POST', `${M()}/downtime-lite/prompts/downtime-day`, T.dm, {})).status, 409, 'one open at a time');
  assert.equal((await ok('GET', `${M()}/prompts/open`, T.jess)).rounds.length, 1);
  const a1 = await ok('POST', `${M()}/downtime-lite/prompts/round/${round.body.id}/answer`, T.jess, { choice: 0, recordId: task.id });
  assert.equal(a1.result.record.done, 1);
  await ok('POST', `${M()}/downtime-lite/prompts/round/${round.body.id}/answer`, T.tom, { choice: 2 });
  assert.equal((await call('POST', `${M()}/downtime-lite/prompts/round/${round.body.id}/answer`, T.jess, { choice: 0, recordId: task.id })).status, 409, 'one answer each');
  await ok('POST', `${M()}/downtime-lite/prompts/round/${round.body.id}/close`, T.dm, {});
  // The next day finishes it.
  const r2 = await ok('POST', `${M()}/downtime-lite/prompts/downtime-day`, T.dm, {});
  const a2 = await ok('POST', `${M()}/downtime-lite/prompts/round/${r2.id}/answer`, T.jess, { choice: 0, recordId: task.id });
  assert.equal(a2.said.chat.at(-1), 'Jessamine finished Work a trade: 5 gp');
  const done = (await ok('GET', `${M()}/downtime-lite/records?kind=task`, T.dm)).records.task[0];
  assert.deepEqual([done.done, done.status], [2, 'done']);
  assert.equal((await call('POST', `${M()}/downtime-lite/records/work`, T.jess, { recordId: task.id })).status, 409, 'a finished task takes no more work');
  // The GM takes a day back; the log shows every step with who and when.
  await ok('POST', `${M()}/downtime-lite/records/adjust`, T.dm, { recordId: task.id, amount: -1, note: 'Lost a day to the storm' });
  const log = (await ok('GET', `${M()}/downtime-lite/records-log?record=${task.id}`, T.dm)).log.map((l: any) => l.action);
  assert.deepEqual(log, ['adjust', 'timer:day:done', 'timer:day', 'work', 'timer:day', 'work', 'start']);
  assert.equal((await ok('GET', `${M()}/downtime-lite/records-log`, T.tom)).log.every((l: any) => l.player === ID.tom), true, 'a player reads only their own log');
  // The rule's view comes with it for the web.
  const rule = (await ok('GET', `${M()}/`, T.dm)).mods.find((r: any) => r.id === 'downtime-lite');
  assert.deepEqual(rule.system.views.map((v: any) => v.place), ['dm', 'sheet']);
  await ok('DELETE', `${M()}/downtime-lite`, T.dm);
  assert.equal(all(db, "SELECT 1 FROM mod_records WHERE mod_id = 'downtime-lite'").length, 0, 'removing the rule removes its records');
});

test('Mods: the Mod studio guide covers every part, and every rule shipped or in the examples reads back as a file that checks', async () => {
  const start = await ok('GET', `${M()}/guide`, T.dm);
  assert.match(start.text, /house_rule_check/);
  assert.match(start.text, /downtime-lite/);
  for (const part of ['counters', 'data', 'presets', 'manifest']) {
    const g = await ok('GET', `${M()}/guide?part=${part}`, T.dm);
    assert.equal(g.part, part);
    assert.ok(g.text.length > 400, part);
  }
  assert.match((await ok('GET', `${M()}/guide?part=presets`, T.dm)).text, /sheetRerolls: false/);
  assert.equal((await call('GET', `${M()}/guide`, T.jess)).status, 403);
  const ids = [...shippedMods().map((s) => s.mod.id), 'hero-points', 'downtime-lite'];
  for (const id of ids) {
    const f = await ok('GET', `${M()}/${id}/file`, T.dm);
    const back = checkMod(f.file);
    assert.deepEqual(back.errors, [], id);
    const c = await ok('POST', `${M()}/check`, T.dm, { mod: f.file });
    assert.equal(c.ok, true, id);
    assert.ok(c.preview.length > 0, `${id} has a preview`);
  }
  assert.equal((await call('GET', `${M()}/nope/file`, T.dm)).status, 404);
});

test('Mods: the check preview tells the GM what a rule does in plain words', async () => {
  const dl = (await ok('GET', `${M()}/downtime-lite/file`, T.dm)).file;
  const p: string[] = (await ok('POST', `${M()}/check`, T.dm, { mod: { ...dl, id: 'studio-downtime' } })).preview;
  const all = p.join('\n');
  assert.match(all, /Keeps a list of Activities: .*starts with 5 ready-made/);
  assert.match(all, /Keeps a list of Tasks \(each player has their own\)/);
  assert.match(all, /The GM gets a Downtime button: every player is asked "How do you spend the day\?" with Keep working \/ Start something \/ Skip the day/);
  assert.match(all, /Each A downtime day \(for players who did not skip\): \+1 done on each task; done when it reaches its goal/);
  assert.match(all, /The GM can Add or take days: add or take done on a task/);
  const hp = (await ok('GET', `${M()}/hero-points/file`, T.dm)).file;
  const h: string[] = (await ok('POST', `${M()}/check`, T.dm, { mod: { ...hp, id: 'studio-hero' } })).preview;
  assert.ok(h.some((l) => /^Each player has Hero point \(starts at 1, at most 3 \(option max\)\)/.test(l)), h.join('\n'));
  assert.ok(h.some((l) => /^At the start of a session: Hero point \+1/.test(l)), h.join('\n'));
  assert.ok(h.some((l) => l === 'Chat word /hero runs spend'), h.join('\n'));
});

test('Mods: a checked draft saves exactly the checked file; an unknown draft says to check again', async () => {
  const hp = (await ok('GET', `${M()}/hero-points/file`, T.dm)).file;
  const c = await ok('POST', `${M()}/check`, T.dm, { mod: { ...hp, id: 'draft-hero', name: 'Draft hero' } });
  assert.match(c.draft, /^draft-hero-[a-z0-9]{1,5}$/);
  const saved = await ok('POST', `${M()}/import`, T.dm, { draft: c.draft });
  assert.equal(saved.id, 'draft-hero');
  assert.equal(saved.enabled, false);
  const bad = await call('POST', `${M()}/import`, T.dm, { draft: 'draft-hero-zzzzz' });
  assert.equal(bad.status, 404);
  assert.match(bad.body.error, /house_rule_check/);
  assert.equal((await call('POST', `${M()}/import`, T.jess, { draft: c.draft })).status, 403);
  await ok('DELETE', `${M()}/draft-hero`, T.dm);
});

test('Mods: chat text in a data system names real fields; {kind.field} is the record\'s own field and {name} the player', async () => {
  const proj = (chat: string) => ({ kit: 2, id: 'studio-projects', name: 'Projects',
    records: { project: { label: 'Project', owned: true, fields: { name: 'text', done: { type: 'int', default: 0 }, goal: 'int' } } },
    recordActions: [{ id: 'start', label: 'Start', by: 'owner', record: 'project', do: 'create', ask: ['name', 'goal'], effect: { chat } }] });
  assert.deepEqual(checkMod(proj('{name} starts {project.name} ({goal} days, {title})')).errors, []);
  assert.match(checkMod(proj('{name} starts {bogus}')).errors.join('\n'), /\{bogus\} is not a field of project/);
  assert.match(checkMod(proj('{name} starts {task.name}')).errors.join('\n'), /task is not a ref field of project/);
  await ok('POST', `${M()}/import`, T.dm, { mod: proj('{name} starts {project.name} ({goal} days, {title})') });
  await ok('PUT', `${M()}/studio-projects/enabled`, T.dm, { on: true });
  await ok('POST', `${M()}/studio-projects/records/start`, T.jess, { values: { name: 'Iron sword', goal: 4 } });
  const said = (await ok('GET', `${CH()}/chat/table`, T.dm)).messages.map((x: any) => x.body).join('\n');
  assert.match(said, /Jessamine starts Iron sword \(4 days, Iron sword\)/);
  await ok('DELETE', `${M()}/studio-projects`, T.dm);
});

test('Mods: the assistant part is checked, kept in the file, and its GM guidance never reaches players', async () => {
  const base = { kit: 2, id: 'studio-assist', name: 'Assisted', resources: [{ id: 'pt', label: 'Point' }], actions: [{ id: 'give', label: 'Give', by: 'dm', resource: 'pt', add: 1 }] };
  const good = checkMod({ ...base, assistant: { words: ['Lucky'], dm: 'SECRET GM HINT', player: 'Help them spend.', tools: ['my_spell_codex'] } });
  assert.deepEqual(good.errors, []);
  assert.deepEqual(good.mod!.assistant!.words, ['lucky']);
  assert.deepEqual((toFile(good.mod!) as any).assistant.tools, ['my_spell_codex']);
  assert.ok(impliedPermissions(good.mod!).includes('assistant.tools'));
  assert.equal((toFile(checkMod(base).mod!) as any).assistant, undefined);
  const bad = checkMod({ ...base, assistant: { words: ['x'], tools: ['Not A Tool'], mood: 'happy' } });
  assert.match(bad.errors.join('\n'), /assistant\.mood is not part of assistant/);
  assert.match(bad.errors.join('\n'), /assistant\.words\[0\]/);
  assert.match(bad.errors.join('\n'), /assistant\.tools\[0\] must be a tool name/);
  await ok('POST', `${M()}/import`, T.dm, { mod: toFile(good.mod!) });
  await ok('PUT', `${M()}/studio-assist/enabled`, T.dm, { on: true });
  assert.ok(!JSON.stringify(await ok('GET', `${M()}`, T.jess)).includes('SECRET GM HINT'));
  assert.equal((await call('GET', `${M()}/studio-assist/file`, T.jess)).status, 403);
  for (const id of ['spell-crafting', 'spell-points', 'mana-pool']) assert.ok(shippedMod(id)!.mod.assistant?.player, `${id} helps players`);
  await ok('DELETE', `${M()}/studio-assist`, T.dm);
});
