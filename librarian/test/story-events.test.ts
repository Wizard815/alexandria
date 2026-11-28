// Story events (quick events that happen to a player, by place), the new DM
// template kinds (quick event, spell) and the built-in starter templates.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, run } from '../src/core/db.ts';
import { balance } from '../src/core/coin.ts';
import { EVENT_STARTERS, parseScript } from '../src/features/encounters/index.ts';
import { cleanPlaces, PLACES, pickDc, play } from '../src/features/encounters/script.ts';
import { starterPacks } from '../src/features/templates/starters.ts';
import { cleanTemplate, EVENT_PLACES, guideText } from '../src/features/templates/spec.ts';
import { heuristicDraft } from '../src/features/templates/draft.ts';
import { spellSkeleton } from '../src/features/templates/spell.ts';
import { matchGuides } from '../src/features/templates/match.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const P = () => `/api/worlds/${W}/encounters`;
const TP = () => `/api/worlds/${W}/templates`;

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
const setCoin = (owner: string, cp: number) => { run(deps.db, 'DELETE FROM ledger WHERE world_id = ? AND owner = ?', W, owner); if (cp) run(deps.db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'approved')`, `led_t${Math.random()}`, W, owner, cp, ID.dm, new Date().toISOString()); };
const coin = (owner: string) => balance(deps.db, W, owner);
const invQty = (owner: string, name: string) => all<any>(deps.db, `SELECT qty FROM items WHERE world_id = ? AND owner = ? AND name = ? AND status = 'approved'`, W, owner, name).reduce((n, x) => n + x.qty, 0);
const send = (body: Record<string, unknown>) => ok('POST', P(), T.dm, body);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-story-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Streetland', dmAccountId: ID.dm })).id;
  for (const [u, c] of [['jess', 'Jess'], ['tom', 'Tom']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: u, password: 'player pass 123', characterName: c });
    T[u] = j.token; ID[u] = j.account.id;
  }
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const openFor = async (who: string) => (await ok('GET', P(), T[who])).find((e: any) => e.status === 'open');
const choose = (id: string, who: string, body: Record<string, unknown>) => call('POST', `${P()}/${id}/choose`, T[who], body);

test('TestStoryEvents_StartersAreValidAndTagged', () => {
  assert.ok(EVENT_STARTERS.length >= 10);
  for (const s of EVENT_STARTERS) {
    assert.doesNotThrow(() => parseScript(s.script), s.id);
    assert.equal(s.kind, 'event');
    assert.ok(s.places?.length, `${s.id} has places`);
    for (const p of s.places!) assert.ok((PLACES as readonly string[]).includes(p), `${s.id}: ${p}`);
  }
  // Every place the DM can pick has at least one built-in event.
  for (const p of PLACES) assert.ok(EVENT_STARTERS.some((s) => s.places!.includes(p)), `no starter for ${p}`);
  assert.deepEqual([...EVENT_PLACES], [...PLACES], 'the template spec and the encounter engine share one place list');
});

test('TestStoryEvents_CleanPlaces', () => {
  assert.deepEqual(cleanPlaces(['Forest', 'open road', 'Cave', 'moon']), ['road', 'woods', 'cave']);
  assert.deepEqual(cleanPlaces('town, city'), ['town', 'city']);
  assert.deepEqual(cleanPlaces(null), []);
});

test('TestStoryEvents_NewEffectsParse', () => {
  const sc = parseScript({ nodes: [{ id: 'a', text: 'x', options: [{ label: 'y', effects: [{ kind: 'pay', cp: 5 }, { kind: 'lose', cp: 3 }, { kind: 'dmnote', text: 'kept it' }] }, { label: 'z', effects: [{ kind: 'item', name: 'Gem', qty: 1, note: 'Worth 10 gp' }] }] }] });
  assert.equal(sc.nodes[0].options[0].effects.length, 3);
  assert.deepEqual(sc.nodes[0].options[1].effects[0], { kind: 'item', name: 'Gem', qty: 1, note: 'Worth 10 gp' });
  assert.throws(() => parseScript({ nodes: [{ id: 'a', text: 'x', options: [{ label: 'y', effects: [{ kind: 'pay', cp: 0 }] }] }] }), /cp/);
  assert.throws(() => parseScript({ nodes: [{ id: 'a', text: 'x', options: [{ label: 'y', effects: [{ kind: 'dmnote', text: '' }] }] }] }), /text/);
});

test('TestStoryEvents_RandomEventForAPlace', async () => {
  const made = await send({ accountIds: [ID.jess], place: 'dungeon' });
  assert.equal(made.length, 1);
  assert.equal(made[0].kind, 'event');
  assert.ok(EVENT_STARTERS.find((s) => s.id === made[0].templateId)?.places?.includes('dungeon'));
  const bad = await call('POST', P(), T.dm, { accountIds: [ID.jess], place: 'moon' });
  assert.equal(bad.status, 400);
  // The whole party: one event each.
  const party = await send({ accountIds: 'party', place: 'coast' });
  assert.equal(party.length, 2);
  assert.ok(party.every((e: any) => e.templateId === 'builtin:ev-bottle'));
  const tom = await openFor('tom');
  assert.equal(tom.kind, 'event');
  assert.equal(tom.npc.name, 'A bottle in the surf');
});

test('TestStoryEvents_PickpocketKeepOrGiveBack', async () => {
  setCoin(ID.jess, 100);
  setCoin(ID.tom, 100);
  // Jess lets the thief go: loses 5 sp.
  await send({ accountIds: [ID.jess], templateId: 'builtin:ev-pickpocket' });
  let e = await openFor('jess');
  assert.equal(e.text.includes('coin purse'), true);
  let r = await choose(e.id, 'jess', { option: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'done');
  assert.equal(coin(ID.jess), 50);
  // The DM note never reaches the player; the DM sees it.
  assert.ok(!r.body.log.some((l: any) => l.who === 'secret'));
  assert.ok(!JSON.stringify(r.body).includes('Let a pickpocket get away'));
  const dmView = await ok('GET', `${P()}/${e.id}`, T.dm);
  assert.ok(dmView.log.some((l: any) => l.who === 'secret' && /pickpocket/.test(l.text)));

  // Tom chases (a sure roll), catches the kid and keeps both purses.
  await send({ accountIds: [ID.tom], templateId: 'builtin:ev-pickpocket' });
  e = await openFor('tom');
  r = await choose(e.id, 'tom', { option: 0 });
  assert.equal(r.body.game.skill, 'Athletics');
  r = await choose(e.id, 'tom', { play: true, total: 30 });
  assert.match(r.body.text, /second, fatter purse/);
  r = await choose(e.id, 'tom', { option: 0 });
  assert.equal(r.body.status, 'done');
  assert.equal(coin(ID.tom), 130);
});

test('TestStoryEvents_PayNeedsTheCoin', async () => {
  setCoin(ID.jess, 0);
  await send({ accountIds: [ID.jess], templateId: 'builtin:ev-beggar' });
  const e = await openFor('jess');
  const r = await choose(e.id, 'jess', { option: 0 });
  assert.equal(r.status, 409);
  setCoin(ID.jess, 5);
  const r2 = await choose(e.id, 'jess', { option: 0 });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(coin(ID.jess), 4);
  const r3 = await choose(e.id, 'jess', { option: 0 });
  assert.equal(r3.body.status, 'done');
  assert.equal(invQty(ID.jess, 'Carved bone token'), 1);
  const note = all<any>(deps.db, `SELECT note FROM items WHERE world_id = ? AND owner = ? AND name = 'Carved bone token'`, W, ID.jess)[0].note;
  assert.match(note, /Leaky Lamp/);
});

test('TestStoryEvents_LoseNeverGoesBelowNothing', async () => {
  setCoin(ID.jess, 4);
  await send({ accountIds: [ID.jess], templateId: 'builtin:ev-bridge' });
  const e = await openFor('jess');
  await choose(e.id, 'jess', { option: 0 });
  const r = await choose(e.id, 'jess', { play: true, total: 1 });
  assert.match(r.body.text, /spill/);
  await choose(e.id, 'jess', { option: 0 });
  assert.equal(coin(ID.jess), 0);
});

test('TestStoryEvents_DcRangeParsesAndPicks', () => {
  const sc = (game: any) => parseScript({ nodes: [{ id: 'a', text: 'x', game: { kind: 'check', skill: 'Athletics', win: 'a', lose: 'a', ...game } }] }).nodes[0].game!;
  assert.deepEqual([sc({ dc: 12 }).dc, sc({ dc: 12 }).dcMax], [12, null]);
  assert.deepEqual([sc({ dc: 10, dcMax: 14 }).dc, sc({ dc: 10, dcMax: 14 }).dcMax], [10, 14]);
  assert.deepEqual([sc({ dc: 15, dcMax: 11 }).dc, sc({ dc: 15, dcMax: 11 }).dcMax], [11, 15]);
  assert.deepEqual([sc({ dc: [9, 13] }).dc, sc({ dc: [9, 13] }).dcMax], [9, 13]);
  assert.deepEqual([sc({ dc: '10-14' }).dc, sc({ dc: '10-14' }).dcMax], [10, 14]);
  assert.equal(sc({ dc: 12, dcMax: 12 }).dcMax, null);
  const g = sc({ dc: 10, dcMax: 14 });
  const seen = new Set<number>();
  for (let i = 1; i <= 5; i++) seen.add(pickDc(g, () => i));
  assert.deepEqual([...seen].sort(), [10, 11, 12, 13, 14]);
  // The player's typed total against the picked DC.
  assert.equal(play(g, { total: 12 }, () => 3).won, true);
  assert.equal(play(g, { total: 11 }, () => 3).won, false);
  assert.equal(play(g, { total: 11 }, () => 3).dc, 12);
  // A natural 20 passes and a natural 1 fails, whatever the total (or with none).
  assert.equal(play(g, { crit: 'high' }, () => 5).won, true);
  assert.equal(play(g, { crit: 'low', total: 40 }, () => 1).won, false);
  assert.match(play(g, { crit: 'high', total: 7 }, () => 5).text, /Natural 20 on Athletics \(7\)/);
  // Every built-in event check has a range.
  for (const ev of EVENT_STARTERS) for (const n of ev.script.nodes) if (n.game?.kind === 'check') assert.ok(n.game.dcMax && n.game.dcMax > n.game.dc!, `${ev.id} ${n.id}`);
});

test('TestStoryEvents_CheckNeedsTheTypedTotal', async () => {
  await send({ accountIds: [ID.jess], templateId: 'builtin:ev-pickpocket' });
  const e = await openFor('jess');
  await choose(e.id, 'jess', { option: 0 });
  const auto = await choose(e.id, 'jess', { play: true });
  assert.equal(auto.status, 400);
  assert.match(auto.body.error, /Athletics/);
  const r = await choose(e.id, 'jess', { play: true, total: 13 });
  assert.equal(r.status, 200);
  assert.ok(r.body.log.some((l: any) => /You rolled 13 for Athletics/.test(l.text)));
  assert.ok(!r.body.log.some((l: any) => /DC/.test(l.text)), 'the player saw the DC');
  const dmView = await ok('GET', `${P()}/${e.id}`, T.dm);
  assert.ok(dmView.log.some((l: any) => l.who === 'secret' && /DC 1[0-4] \(picked from 10–14\)/.test(l.text)));
  await ok('POST', `${P()}/${e.id}/end`, T.dm, {});
  // A natural 1 with no total fails the chase; the DM sees it was a natural 1.
  await send({ accountIds: [ID.jess], templateId: 'builtin:ev-pickpocket' });
  const c = await openFor('jess');
  await choose(c.id, 'jess', { option: 0 });
  const r1 = await choose(c.id, 'jess', { play: true, crit: 'low' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.match(r1.body.text, /vanish into the alleys/);
  const dm1 = await ok('GET', `${P()}/${c.id}`, T.dm);
  assert.ok(dm1.log.some((l: any) => l.who === 'secret' && /natural 1, failed/.test(l.text)));
  await ok('POST', `${P()}/${c.id}/end`, T.dm, {});
});

test('TestStoryEvents_TimedStep', async () => {
  // Parsing: a bare number is seconds; the fallback defaults to the last answer, or to failing a check.
  const one = (n: any) => parseScript({ nodes: [{ id: 'a', text: 'x', options: [{ label: 'A' }, { label: 'B' }], ...n }] }).nodes[0];
  assert.deepEqual(one({ timer: 15 }).timer, { secs: 15, fallback: 1 });
  assert.deepEqual(one({ timer: { secs: 15, fallback: 0 } }).timer, { secs: 15, fallback: 0 });
  assert.deepEqual(one({ timer: { secs: 15, fallback: 5 } }).timer, { secs: 15, fallback: 1 });
  assert.equal(one({}).timer, undefined);
  assert.throws(() => one({ timer: { secs: 2 } }), /timer.secs/);

  setCoin(ID.tom, 100);
  await send({ accountIds: [ID.tom], templateId: 'builtin:ev-pickpocket' });
  // The clock starts when Tom first sees it.
  const sent = (await ok('GET', P(), T.dm)).find((x: any) => x.player === 'Tom' && x.status === 'open');
  assert.deepEqual(sent.timer, { secs: 20, endsAt: null });
  const e = await openFor('tom');
  assert.equal(e.timer.secs, 20);
  assert.ok(Date.parse(e.timer.endsAt) - Date.now() > 15_000);
  // Too early to call time.
  assert.equal((await choose(e.id, 'tom', { timeout: true })).status, 409);
  // Twenty seconds later the app calls time: "Let it go" happens for them.
  run(deps.db, 'UPDATE encounters SET step_seen_at = ? WHERE id = ?', new Date(Date.now() - 21_000).toISOString(), e.id);
  const r = await choose(e.id, 'tom', { timeout: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'done');
  assert.ok(r.body.log.some((l: any) => /Let it go \(out of time\)/.test(l.text)));
  assert.equal(coin(ID.tom), 50);

  // A late answer is the same as running out: the check on the bridge fails.
  setCoin(ID.tom, 100);
  await send({ accountIds: [ID.tom], templateId: 'builtin:ev-bridge' });
  const b = await openFor('tom');
  const r1 = await choose(b.id, 'tom', { option: 0 });
  assert.equal(r1.body.timer.secs, 45);
  run(deps.db, 'UPDATE encounters SET step_seen_at = ? WHERE id = ?', new Date(Date.now() - 60_000).toISOString(), b.id);
  const r2 = await choose(b.id, 'tom', { play: true, total: 30 });
  assert.match(r2.body.text, /spill/);
  assert.ok(r2.body.log.some((l: any) => /counts as a failure/.test(l.text)));
  // A step without a timer has no time to run out.
  assert.equal((await choose(b.id, 'tom', { timeout: true })).status, 400);
});

test('TestStoryEvents_FavouritesAndRandomFrom', async () => {
  // Star a built-in and a saved one; both come back starred.
  await ok('PUT', `${P()}/templates/fav/builtin:ev-gem`, T.dm, { fav: true });
  const mine = await ok('POST', `${P()}/templates/all`, T.dm, { kind: 'event', name: 'Fake fortune teller', places: ['market'], script: { nodes: [{ id: 'a', text: 'A woman offers to read your palm.', options: [{ label: 'Sure' }, { label: 'No thanks' }] }] } });
  await ok('PUT', `${P()}/templates/fav/${mine.id}`, T.dm, { fav: true });
  let list = await ok('GET', `${P()}/templates/all?kind=event`, T.dm);
  assert.equal(list.starters.find((s: any) => s.id === 'builtin:ev-gem').fav, true);
  assert.equal(list.starters.find((s: any) => s.id === 'builtin:ev-pickpocket').fav, false);
  assert.equal(list.templates.find((t: any) => t.id === mine.id).fav, true);
  // Random from favourites in the market only ever picks a starred one.
  for (let i = 0; i < 6; i++) {
    const [e] = await send({ accountIds: [ID.jess], place: 'market', from: 'fav' });
    assert.ok(['builtin:ev-gem', mine.id].includes(e.templateId), e.templateId);
  }
  // Built-in only never picks the saved one, even though the world has its own market events.
  for (let i = 0; i < 4; i++) assert.ok((await send({ accountIds: [ID.jess], place: 'market', from: 'builtin' }))[0].templateId.startsWith('builtin:'));
  // Unstar; deleting a saved one drops its star too. No favourites left in the market: a clear 404.
  await ok('PUT', `${P()}/templates/fav/builtin:ev-gem`, T.dm, { fav: false });
  await ok('DELETE', `${P()}/templates/all/${mine.id}`, T.dm);
  assert.equal(all<any>(deps.db, 'SELECT * FROM encounter_favs WHERE world_id = ?', W).length, 0);
  const none = await call('POST', P(), T.dm, { accountIds: [ID.jess], place: 'market', from: 'fav' });
  assert.equal(none.status, 404);
  assert.match(none.body.error, /starred/);
  // Players cannot star.
  assert.equal((await call('PUT', `${P()}/templates/fav/builtin:ev-gem`, T.jess, { fav: true })).status, 403);
  assert.equal((await call('PUT', `${P()}/templates/fav/nope`, T.dm, { fav: true })).status, 404);
  // An unsaved draft sends with its own name.
  const [d] = await send({ accountIds: [ID.jess], kind: 'event', name: 'Loose cobble', npcName: 'A loose cobble', script: { nodes: [{ id: 'a', text: 'You stub your toe.', options: [{ label: 'Ow' }] }] } });
  assert.equal(d.templateName, 'Loose cobble');
  assert.equal(d.kind, 'event');
  await ok('POST', `${P()}/${d.id}/end`, T.dm, {});
});

test('TestStoryEvents_SavedEventsByPlace', async () => {
  const sc = { start: 'a', nodes: [{ id: 'a', text: 'A crow steals a shiny button.', options: [{ label: 'Shoo it', next: null, effects: [{ kind: 'dmnote', text: 'The crow will be back.' }] }] }] };
  const t = await ok('POST', `${P()}/templates/all`, T.dm, { kind: 'event', name: 'Thieving crow', places: ['woods', 'Forest', 'moon'], script: sc });
  assert.equal(t.kind, 'event');
  assert.deepEqual(t.places, ['woods']);
  assert.equal(t.npcName, 'Thieving crow');
  const woods = await ok('GET', `${P()}/templates/all?kind=event&place=woods`, T.dm);
  assert.deepEqual(woods.templates.map((x: any) => x.name), ['Thieving crow']);
  assert.ok(woods.starters.every((x: any) => x.kind === 'event' && x.places.includes('woods')));
  // With one of its own for the woods, a random woods event is the world's own.
  for (let i = 0; i < 5; i++) assert.equal((await send({ accountIds: [ID.tom], place: 'woods' }))[0].templateId, t.id);
  // Players never get the template list.
  assert.equal((await call('GET', `${P()}/templates/all`, T.jess)).status, 403);
  const npcOnly = await ok('GET', `${P()}/templates/all?kind=npc`, T.dm);
  assert.ok(npcOnly.starters.length >= 5 && npcOnly.starters.every((x: any) => x.kind === 'npc'));
});

test('TestStoryEvents_QuickLineEvent', async () => {
  const [e] = await send({ accountIds: [ID.jess], kind: 'event', line: 'Thunder rolls; the road ahead floods.', answers: ['Wade across', 'Wait it out'], addToPeople: true });
  assert.equal(e.kind, 'event');
  assert.equal(e.npc.name, 'Something happens');
  assert.equal(all<any>(deps.db, `SELECT 1 FROM people WHERE world_id = ? AND name = 'Something happens'`, W).length, 0, 'an event never joins People');
});

test('TestStoryEvents_DraftWithoutModel', async () => {
  const d = await ok('POST', `${P()}/templates/draft`, T.dm, { prompt: 'A thief in the market grabs a purse', kind: 'event', places: ['market'] });
  assert.equal(d.kind, 'event');
  assert.deepEqual(d.places, ['market']);
  assert.ok(d.script.nodes.length >= 1);
  assert.equal(d.usedModel, false);
});

test('TestTemplates_EventAndSpellKinds', () => {
  const ev = cleanTemplate({ kind: 'event', name: 'Road events', spec: { places: ['road', 'moon'], choices: 9, maxRewardCp: -3 } });
  assert.deepEqual((ev.spec as any).places, ['road']);
  assert.equal((ev.spec as any).choices, 4);
  assert.equal((ev.spec as any).maxRewardCp, 0);
  assert.match(guideText(ev as any), /quick events/);
  const sp = cleanTemplate({ kind: 'spell', name: 'Frost', spec: { minLevel: 5, maxLevel: 2, schools: ['evocation', 'Cooking'], lines: ['Frost'] } });
  assert.equal((sp.spec as any).minLevel, 2);
  assert.equal((sp.spec as any).maxLevel, 5);
  assert.deepEqual((sp.spec as any).schools, ['Evocation']);
  assert.match(guideText(sp as any), /Level 2 to 5/);
  assert.match(guideText(sp as any), /Spell lines: Frost/);
  // Drafted without a model from the DM's words.
  const de = heuristicDraft('event', 'Things that happen in the forest and caves: thieves, finds');
  assert.deepEqual((de.template.spec as any).places, ['woods', 'cave']);
  const ds = heuristicDraft('spell', 'Frost spells for wizards, level 1 to 3, evocation');
  assert.equal((ds.template.spec as any).minLevel, 1);
  assert.equal((ds.template.spec as any).maxLevel, 3);
  assert.deepEqual((ds.template.spec as any).classes, ['Wizard']);
  assert.deepEqual((ds.template.spec as any).lines, ['Frost']);
  // "make a spell" picks the spell template up; talking about templates does not.
  const list = [{ id: 's', name: 'Frost', kind: 'spell' as const, triggers: ['spell'], enabled: true, spec: {} }];
  assert.equal(matchGuides('make a new spell that freezes feet', list).length, 1);
  assert.equal(matchGuides('make a spell template', list).length, 0);
});

test('TestTemplates_SpellSkeletonIsACodexSpell', () => {
  const s = spellSkeleton({ minLevel: 2, maxLevel: 4, schools: ['Evocation'], classes: ['Wizard'], lines: [], balance: '', mana: '', naming: '', instructions: '', higherLevels: true }, 'Frost Pin: pins a foe to the ground');
  assert.equal(s.name, 'Frost Pin');
  assert.equal(s.level, 2);
  assert.equal(s.school, 'Evocation');
  assert.deepEqual(s.classes, ['Wizard']);
  assert.match(s.text, /Higher-Level/);
});

test('TestTemplates_StartersCopyIn', async () => {
  // The quick event and spell starters ship as packs in templates/, 8 of each, and add like any other.
  const packs = starterPacks();
  const of = (k: string) => packs.flatMap((p) => p.templates).filter((t) => t.kind === k);
  assert.equal(of('event').length, 8);
  assert.equal(of('spell').length, 8);
  const st = await ok('GET', `${TP()}/starters`, T.dm);
  assert.ok(st.packs.some((p: any) => p.id === 'events' && p.templates.length === 8));
  const add = await ok('POST', `${TP()}/starters/add`, T.dm, { pack: 'events', names: ['Town & city temptations'] });
  assert.deepEqual(add.created, ['Town & city temptations']);
  assert.equal((await call('POST', `${TP()}/starters/add`, T.jess, { pack: 'events' })).status, 403);
  const made = (await ok('GET', TP(), T.dm)).templates.find((t: any) => t.name === 'Town & city temptations');
  assert.equal(made.kind, 'event');
  assert.equal(made.version, 1);
  assert.ok((made.spec.places as string[]).includes('market'));
  // The quick event template drafts an event (no model here: a plain draft) with its places.
  const r = await ok('POST', `${TP()}/${made.id}/event`, T.dm, { prompt: '' });
  assert.equal(r.draft.kind, 'event');
  assert.ok(r.draft.places.includes('town'));
  // And steers the Encounters draft too.
  const d = await ok('POST', `${P()}/templates/draft`, T.dm, { prompt: 'A drunk spills ale', kind: 'event', guide: made.id });
  assert.ok(d.places.includes('market'));
});

test('TestTemplates_SpellTemplateDraftsAndSaves', async () => {
  await ok('POST', `${TP()}/starters/add`, T.dm, { pack: 'spells', names: ['Cantrip'] });
  const st = (await ok('GET', TP(), T.dm)).templates.find((t: any) => t.kind === 'spell' && t.name === 'Cantrip');
  assert.equal((await call('POST', `${TP()}/${st.id}/spell`, T.dm, { prompt: '' })).status, 400);
  const r = await ok('POST', `${TP()}/${st.id}/spell`, T.dm, { prompt: 'Spark Flick: a tiny jolt that makes a foe drop what they hold' });
  assert.equal(r.draft.spell.level, 0);
  assert.equal(r.draft.spell.name, 'Spark Flick');
  const saved = await ok('POST', `/api/worlds/${W}/spells/s`, T.dm, r.draft.spell);
  assert.equal(saved.name, 'Spark Flick');
  assert.equal(saved.source, 'Homebrew');
  const ev = await ok('GET', TP(), T.dm);
  assert.equal((await call('POST', `${TP()}/${ev.templates.find((t: any) => t.kind === 'event').id}/spell`, T.dm, { prompt: 'x' })).status, 400);
});
