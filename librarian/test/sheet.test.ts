// The player sheet: modules each player arranges (private ones hidden from the
// DM too), HP, temporary HP and conditions with every change logged, the
// combat tracker and the sheet kept in step both ways, players changing
// their own mana (through the spells feature, logged there), the DM's party
// status bar, and recently seen people and places from published summaries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { cleanModules } from '../src/features/sheet/modules.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const SH = () => `/api/worlds/${W}/sheet`;

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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-sheet-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sheetholm', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Sheet_ModulesValidate: types, one of each live module, sizes and private only where it fits', () => {
  assert.throws(() => cleanModules([{ type: 'nope' }]), /type must be one of/);
  assert.throws(() => cleanModules([{ type: 'vitals' }, { type: 'vitals' }]), /Only one Health/);
  assert.throws(() => cleanModules([{ type: 'contacts', data: { entries: [{ name: 'Mira', kind: 'friend' }] } }]), /ally, enemy or neutral/);
  assert.throws(() => cleanModules([{ type: 'notes', data: { text: 'x'.repeat(10_001) } }]), /longer than/);
  const m = cleanModules([{ type: 'vitals', private: true }, { id: 'n1', type: 'notes', private: true, data: { text: 'hi' } }, { type: 'counters', data: { entries: [{ label: 'Inspiration', value: 1, max: 1 }] } }]);
  assert.equal(m[0].private, false, 'health is never private');
  assert.equal(m[1].private, true);
  assert.equal(m[0].title, 'Health');
  assert.deepEqual(m[2].data.entries[0], { id: 'e0', label: 'Inspiration', value: 1, max: 1 });
});

test('Sheet_Layout: a new sheet has the default modules; the player arranges it; private modules hide from the DM', async () => {
  const fresh = await ok('GET', `${SH()}/me`, T.jess);
  assert.deepEqual(fresh.modules.map((m: any) => m.type), ['vitals', 'mana', 'dm', 'inventory', 'contacts', 'notes', 'recent']);
  assert.equal(fresh.name, 'Jessamine');
  const mods = [
    { id: 'vitals', type: 'vitals' },
    { id: 'allies', type: 'contacts', title: 'Allies & enemies', data: { entries: [{ name: 'Captain Vex', kind: 'enemy', note: 'Owes us' }] } },
    { id: 'secret', type: 'notes', title: 'Secret plan', private: true, data: { text: 'Steal the crown' } },
  ];
  await ok('PUT', `${SH()}/me/modules`, T.jess, { modules: mods });
  const mine = await ok('GET', `${SH()}/me`, T.jess);
  assert.equal(mine.modules.length, 3);
  assert.equal(mine.modules[1].data.entries[0].name, 'Captain Vex');
  const dmView = await ok('GET', `${SH()}/${ID.jess}`, T.dm);
  assert.deepEqual(dmView.modules.map((m: any) => m.id), ['vitals', 'allies'], 'the DM does not see private modules');
  assert.ok(!JSON.stringify(dmView).includes('crown'));
  assert.equal((await call('GET', `${SH()}/${ID.jess}`, T.tom)).status, 404, 'other players cannot read it');
  assert.equal((await call('POST', `${SH()}/${ID.jess}/vitals`, T.tom, { damage: 1 })).status, 404, 'nor change it');
});

test('Sheet_Vitals: damage goes through temporary HP first, healing stops at max, every change is logged', async () => {
  await ok('POST', `${SH()}/me/vitals`, T.jess, { maxHp: 20, hp: 20 });
  await ok('POST', `${SH()}/me/vitals`, T.jess, { tempHp: 5 });
  const hit = await ok('POST', `${SH()}/me/vitals`, T.jess, { damage: 8, note: 'Goblin arrow' });
  assert.deepEqual([hit.hp, hit.tempHp], [17, 0]);
  const healed = await ok('POST', `${SH()}/me/vitals`, T.jess, { heal: 50 });
  assert.equal(healed.hp, 20);
  await ok('POST', `${SH()}/me/vitals`, T.jess, { conditions: ['Poisoned', 'poisoned', ' Prone '] });
  const s = await ok('GET', `${SH()}/me`, T.jess);
  assert.deepEqual(s.conditions, ['Poisoned', 'Prone']);
  const log = (await ok('GET', `${SH()}/log`, T.jess)).log;
  const hpLines = log.filter((x: any) => x.kind === 'hp');
  assert.ok(hpLines.some((x: any) => x.before === 20 && x.after === 17 && x.amount === -3 && x.note === 'Goblin arrow' && x.source === 'sheet'));
  assert.ok(log.some((x: any) => x.kind === 'temp' && x.before === 5 && x.after === 0));
  assert.ok(log.some((x: any) => x.kind === 'conditions' && /Poisoned, Prone/.test(x.note)));
  // The DM's change is marked as the DM's.
  await ok('POST', `${SH()}/${ID.jess}/vitals`, T.dm, { damage: 2 });
  const dmLog = (await ok('GET', `${SH()}/log?account=${ID.jess}`, T.dm)).log;
  assert.equal(dmLog[0].source, 'dm');
  assert.equal(dmLog[0].by, ID.dm);
});

test('Sheet_Combat: a player joins combat with their sheet HP, and changes flow both ways and are logged', async () => {
  await ok('POST', `${SH()}/${ID.tom}/vitals`, T.tom, { maxHp: 30, hp: 25 });
  const cb = await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Tomas', accountId: ID.tom, initiative: 12 });
  const view = await ok('GET', `/api/worlds/${W}/live/combat`, T.dm);
  const row = view.combatants.find((x: any) => x.id === cb.id);
  assert.deepEqual([row.hp, row.max_hp], [25, 30], 'seeded from the sheet');
  // The tracker damages Tomas: the sheet follows.
  await ok('PATCH', `/api/worlds/${W}/live/combatants/${cb.id}`, T.dm, { damage: 10 });
  assert.equal((await ok('GET', `${SH()}/me`, T.tom)).hp, 15);
  const log = (await ok('GET', `${SH()}/log`, T.tom)).log;
  assert.ok(log.some((x: any) => x.kind === 'hp' && x.source === 'combat' && x.before === 25 && x.after === 15));
  // The player heals on the sheet: the tracker follows.
  await ok('POST', `${SH()}/me/vitals`, T.tom, { heal: 4, note: 'Potion' });
  const after = (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants.find((x: any) => x.id === cb.id);
  assert.equal(after.hp, 19);
  // Down to 0 on the sheet starts death saves in the tracker, as the tracker's own damage would.
  await ok('POST', `${SH()}/me/vitals`, T.tom, { damage: 19 });
  const down = (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants.find((x: any) => x.id === cb.id);
  assert.equal(down.hp, 0);
  assert.ok(down.death_saves, 'death saves started');
  const party = (await ok('GET', `${SH()}/party`, T.dm)).players;
  const tom = party.find((p: any) => p.accountId === ID.tom);
  assert.equal(tom.inCombat, true);
  assert.equal(tom.hp, 0);
  await ok('DELETE', `/api/worlds/${W}/live/combatants/${cb.id}`, T.dm);
});

test('Sheet_Mana: players change their own mana within the pool, logged in the spells log; the DM sees it in the status bar', async () => {
  assert.equal((await call('POST', `${SH()}/me/mana`, T.jess, { delta: 1 })).status, 409, 'mana is off');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellMana: true });
  await ok('PUT', `/api/worlds/${W}/spells/characters/${ID.jess}`, T.dm, { level: 3, manaMax: 10 });
  const spent = await ok('POST', `${SH()}/me/mana`, T.jess, { delta: -4, note: 'Burned a focus' });
  assert.deepEqual([spent.now, spent.max], [6, 10]);
  const potion = await ok('POST', `${SH()}/me/mana`, T.jess, { delta: 50, note: 'Mana potion' });
  assert.equal(potion.now, 10, 'a player stays within the pool');
  const spellsLog = (await ok('GET', `/api/worlds/${W}/spells/log`, T.jess)).log;
  assert.ok(spellsLog.some((x: any) => x.kind === 'adjust' && x.amount === -4 && x.note === 'Burned a focus'));
  const log = (await ok('GET', `${SH()}/log`, T.jess)).log;
  assert.ok(log.some((x: any) => x.kind === 'mana' && x.before === 10 && x.after === 6));
  const jess = (await ok('GET', `${SH()}/party`, T.dm)).players.find((p: any) => p.accountId === ID.jess);
  assert.deepEqual(jess.mana, { on: true, now: 10, max: 10 });
  assert.equal(jess.name, 'Jessamine');
  assert.equal((await call('GET', `${SH()}/party`, T.jess)).status, 403, 'the status bar is the DM’s');
  // The MANA setting spellManaPlayerEdit: off stops players, never the DM.
  const row = deps.db.prepare('SELECT settings FROM worlds WHERE id = ?').get(W) as any;
  run(deps.db, 'UPDATE worlds SET settings = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(row.settings), spellManaPlayerEdit: false }), W);
  assert.equal((await call('POST', `${SH()}/me/mana`, T.jess, { delta: -1 })).status, 403);
  assert.equal((await ok('POST', `${SH()}/${ID.jess}/mana`, T.dm, { delta: -1 })).now, 9);
  run(deps.db, 'UPDATE worlds SET settings = ? WHERE id = ?', row.settings, W);
});

test('Sheet_Recent: people and places named in published summaries, only what the player may see', async () => {
  await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Mira Vane', visibility: 'party' });
  await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Secret Spy', visibility: 'dm' });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Locations/Bramblegate', visibility: 'party', markdown: '# Bramblegate\nA walled town.\n' });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Locations/Hidden Keep', visibility: 'dm', markdown: '# Hidden Keep\nSecret.\n' });
  const summary = '## Recap\n- The party reached Bramblegate and saw Hidden Keep. Secret Spy watched.\n## People met\n- **Mira Vane** the smith\n- **Old Tobb** the ferryman\n';
  run(deps.db, `INSERT INTO sessionlog_entries (id, world_id, number, title, summary, session_at, world_from_minutes, world_to_minutes, published_at) VALUES ('sle_1', ?, 1, 'Session 1', ?, ?, 0, 0, ?)`, W, summary, new Date().toISOString(), new Date().toISOString());
  const rec = await ok('GET', `${SH()}/me/recent`, T.jess);
  assert.deepEqual(rec.people.map((p: any) => p.name).sort(), ['Mira Vane', 'Old Tobb']);
  assert.ok(rec.people.find((p: any) => p.name === 'Mira Vane').personId);
  assert.deepEqual(rec.places.map((p: any) => p.name), ['Bramblegate']);
  assert.equal(rec.places[0].session, 1);
  // The DM asking for a player's list gets that player's list, not the DM's.
  const asDm = await ok('GET', `${SH()}/${ID.jess}/recent`, T.dm);
  assert.deepEqual(asDm.places.map((p: any) => p.name), ['Bramblegate']);
});

test('Sheet_DmNotes: the DM leaves notes and goals for one player; only that player and the DM see them; the player ticks goals', async () => {
  const made = await ok('POST', `${SH()}/${ID.jess}/dm-notes`, T.dm, { kind: 'goal', text: 'Find out who lights the lamp' });
  await ok('POST', `${SH()}/${ID.jess}/dm-notes`, T.dm, { text: 'You dream of a drowned bell.' });
  const gid = made.fromDm.find((x: any) => x.kind === 'goal').id;
  const mine = await ok('GET', `${SH()}/me`, T.jess);
  assert.equal(mine.fromDm.length, 2);
  assert.equal((await ok('GET', `${SH()}/me`, T.tom)).fromDm.length, 0, 'other players never see them');
  assert.equal((await call('POST', `${SH()}/${ID.tom}/dm-notes`, T.jess, { text: 'x' })).status, 403, 'players cannot write them');
  assert.equal((await call('PATCH', `${SH()}/${ID.jess}/dm-notes/${gid}`, T.jess, { text: 'changed' })).status, 403, 'nor change the words');
  const ticked = await ok('PATCH', `${SH()}/${ID.jess}/dm-notes/${gid}`, T.jess, { done: true });
  assert.equal(ticked.fromDm.find((x: any) => x.id === gid).done, true);
  const nid = mine.fromDm.find((x: any) => x.kind === 'note').id;
  assert.equal((await call('PATCH', `${SH()}/${ID.jess}/dm-notes/${nid}`, T.jess, { done: true })).status, 400, 'a note is not a goal');
  assert.equal((await call('PATCH', `${SH()}/${ID.jess}/dm-notes/${gid}`, T.tom, { done: false })).status, 404);
  await ok('DELETE', `${SH()}/${ID.jess}/dm-notes/${nid}`, T.dm);
  assert.equal((await ok('GET', `${SH()}/${ID.jess}`, T.dm)).fromDm.length, 1);
});

test('Sheet_ContactsLinks: a person on the sheet can link a library page; recently lists factions too', async () => {
  const m = cleanModules([{ type: 'contacts', data: { entries: [{ name: 'Mira', kind: 'ally', pageId: 'pg_abc123', personId: 'ppl_x' }, { name: 'Bad', kind: 'enemy', pageId: '../../etc' }] } }]);
  assert.equal(m[0].data.entries[0].pageId, 'pg_abc123');
  assert.equal(m[0].data.entries[1].pageId, undefined, 'only ids are kept');
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Factions/Harbour Guild', visibility: 'party', markdown: '# Harbour Guild\nDock workers.\n' });
  run(deps.db, `INSERT INTO sessionlog_entries (id, world_id, number, title, summary, session_at, world_from_minutes, world_to_minutes, published_at) VALUES ('sle_2', ?, 2, 'Session 2', ?, ?, 0, 0, ?)`, W, '## Recap\n- The Harbour Guild hired us.\n## People met\n- **Bramblegate**\n', new Date().toISOString(), new Date().toISOString());
  const rec = await ok('GET', `${SH()}/me/recent`, T.jess);
  assert.deepEqual(rec.factions.map((f: any) => f.name), ['Harbour Guild']);
  assert.equal(rec.factions[0].session, 2);
});

test('Sheet_Rerolls: the house rule is off until the DM turns it on; the DM gives re-rolls, the player spends them, all logged', async () => {
  assert.equal((await ok('GET', `${SH()}/me`, T.jess)).rerolls.on, false);
  assert.equal((await call('POST', `${SH()}/${ID.jess}/rerolls`, T.dm, { kind: 'personal', delta: 1 })).status, 409, 'off by default');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { sheetRerolls: true, sheetRerollCap: 2 });
  await ok('POST', `${SH()}/${ID.jess}/rerolls`, T.dm, { kind: 'dm', delta: 1, note: 'Great speech to the harbour guild' });
  const two = await ok('POST', `${SH()}/${ID.jess}/rerolls`, T.dm, { kind: 'dm', delta: 5 });
  assert.equal(two.now, 2, 'never above the cap');
  assert.equal((await call('POST', `${SH()}/${ID.jess}/rerolls`, T.jess, { kind: 'dm', delta: 1 })).status, 403, 'players do not give themselves re-rolls');
  assert.equal((await call('POST', `${SH()}/${ID.jess}/rerolls`, T.tom, { kind: 'dm', delta: -1 })).status, 404, 'nor spend someone else\'s');
  assert.equal((await call('POST', `${SH()}/me/rerolls`, T.jess, { kind: 'party', delta: -1 })).status, 409, 'none to spend');
  const used = await ok('POST', `${SH()}/me/rerolls`, T.jess, { kind: 'dm', delta: -1 });
  assert.equal(used.now, 1);
  const party = await ok('GET', `${SH()}/party`, T.dm);
  assert.equal(party.players.find((p: any) => p.accountId === ID.jess).rerolls.dm, 1);
  const log = (await ok('GET', `${SH()}/log?account=${ID.jess}`, T.dm)).log.filter((x: any) => x.kind === 'reroll');
  assert.equal(log.length, 3);
  assert.match(log[2].note, /DM re-roll given · Great speech/);
  assert.match(log[0].note, /DM re-roll used/);
});
