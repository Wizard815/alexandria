// Active mode: cue rules, auto / ask / off, undo, de-dup, rate limits, the wake
// word (the DM's own mic only), DM asides, takeover commands, the command log,
// macros with a Minerva step, and "players never see Minerva". Models are
// scripted fakes; nothing real is called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, run } from '../src/core/db.ts';
import { toneWav } from './soundTone.ts';
import { notifyLine } from '../src/features/audio/hooks.ts';
import { flushActive, resetActiveMemory } from '../src/features/active/engine.ts';
import { allCues, wakeCommand } from '../src/features/active/cues.ts';
import { parseCommand } from '../src/features/active/commands.ts';
import { TEMPLATES } from '../src/features/actions/templates.ts';

let base = '', server: any, tmp = '', deps: any, W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const MIC: Record<string, string> = {};
const realFetch = globalThis.fetch;
const audit: { queue: ((b: any) => any)[]; seen: any[] } = { queue: [], seen: [] };
const chat: { queue: ((b: any) => any)[]; seen: any[] } = { queue: [], seen: [] };
const fake: typeof fetch = async (input: any, init: any = {}) => {
  const u = String(input);
  if (u.startsWith('http://127.0.0.1')) return realFetch(input, init);
  const q = u.startsWith('http://audit.test/') ? audit : u.startsWith('http://chat.test/') ? chat : null;
  if (q) {
    const body = JSON.parse(init.body);
    q.seen.push(body);
    const h = q.queue.shift();
    if (!h) return new Response('no scripted reply', { status: 500 });
    const message = h(body);
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`unexpected fetch ${u}`);
};
const call = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await realFetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json };
};
const ok = async (method: string, url: string, token?: string, body?: unknown) => { const r = await call(method, url, token, body); assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const A = () => `/api/worlds/${W}/active`;
const log = async (status?: string) => (await ok('GET', `${A()}${status ? `?status=${status}` : ''}`.replace(A(), `${A()}/log`), T.dm)).log as any[];
const msg = (content: string) => ({ role: 'assistant', content });
const toolCall = (name: string, args: unknown) => ({ role: 'assistant', content: null, tool_calls: [{ id: `c_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

let n = 0;
/** A transcript line as the audio pipeline would store it, then the batch run. */
async function say(who: 'dm' | 'jess' | 'tom' | 'room', text: string, o: { aside?: boolean; mics?: string[] } = {}) {
  const id = `ln_t${++n}`;
  const acct = who === 'dm' || who === 'room' ? ID.dm : ID[who];
  run(deps.db, `INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, sources, audience, updated_at) VALUES (?, 'as_a', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, W, n * 5000, n * 5000 + 3000, who === 'room' ? null : acct, who === 'room' ? 'Room' : who, text, JSON.stringify(o.mics ?? [MIC[who]]), o.aside ? 'dm' : 'players', new Date().toISOString());
  notifyLine(deps, W, id, false);
  await flushActive(deps, W);
  return id;
}
const settings = (patch: Record<string, unknown>) => ok('PUT', A(), T.dm, patch);
const reset = async () => {
  run(deps.db, 'DELETE FROM active_log WHERE world_id = ?', W);
  run(deps.db, 'DELETE FROM active_rules WHERE world_id = ?', W);
  run(deps.db, 'DELETE FROM combatants WHERE world_id = ?', W);
  run(deps.db, "UPDATE combat SET active = 0, round = 1, turn = 0 WHERE world_id = ?", W);
  await settings({ mode: 'active', cats: { music: 'auto', sfx: 'auto', stage: 'ask', events: 'ask', combat: 'auto', combatAdd: 'ask', items: 'ask', clock: 'ask' }, listen: { dm: true, players: true } });
  resetActiveMemory(deps, W);
  run(deps.db, 'DELETE FROM sound_state WHERE world_id = ?', W);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-active-'));
  const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(tmp, 'data', rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'data', rel), toneWav()); };
  put('music/combat/boss.wav'); put('music/village/calm/meadow.wav'); put('music/dungeon/tense/dark.wav'); put('ambience/rain/rain.wav'); put('sfx/doors/creak.wav'); put('sfx/weather/thunder.wav');
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_AUDIT_URL: 'http://audit.test/v1', ALX_MODEL_AUDIT_MODEL: 'fake-audit', ALX_MODEL_CHAT_URL: 'http://chat.test/v1', ALX_MODEL_CHAT_MODEL: 'fake-chat' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Activeland', dmAccountId: ID.dm })).id;
  for (const [name, ch] of [['jess', 'Jessamine'], ['tom', 'Tomas']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: ch });
    T[name] = j.token; ID[name] = j.account.id;
  }
  const page = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown });
  ID.docks = (await page('maps/Docks Map', 'party', '# Docks Map\nThe docks of Saltmarsh, with the old quay marked.\n')).id;
  ID.secretMap = (await page('dm/Smugglers Tunnel Map', 'dm', '# Smugglers Tunnel Map\nThe hidden tunnel under the third stall leads to the vault.\n')).id;
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES ('as_a', ?, 'Session A', ?)", W, new Date().toISOString());
  const mic = (key: string, acct: string, room: number) => { MIC[key] = `mic_${key}`; run(deps.db, 'INSERT INTO audio_mics (id, world_id, account_id, device_id, label, mode, players_transcript, aside, room, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)', MIC[key], W, acct, `dev_${key}`, key, 'always', room, new Date().toISOString()); };
  mic('dm', ID.dm, 0); mic('jess', ID.jess, 0); mic('tom', ID.tom, 0); mic('room', ID.dm, 1);
  await ok('GET', A(), T.dm); // the first request tells the engine which port to call
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestActive_CuesAreSpecific', () => {
  const ctx: any = { combat: { active: true, turn: 0, combatants: [{ id: 'o', name: 'Ogre', effects: [], isPc: false }, { id: 'g1', name: 'Goblin 1', effects: [], isPc: false }, { id: 'g2', name: 'Goblin 2', effects: [], isPc: false }, { id: 't', name: 'Tomas', effects: [], isPc: true, accountId: 'a' }] }, party: [{ accountId: 'a', name: 'Tom', character: 'Tomas' }], pages: [], sfx: ['Creak'], initiativeOpen: false };
  const dm = (text: string) => allCues({ id: 'x', text, speaker: 'dm', role: 'dm', accountId: null, aside: false }, ctx);
  const kinds = (text: string) => dm(text).map((c) => c.kind);
  assert.deepEqual(kinds('The ogre takes 12 from the fireball.'), ['damage']);
  assert.equal((dm('The ogre takes 12 from the fireball.')[0] as any).amount, 12);
  assert.deepEqual(kinds('Goblin 2 takes 5 damage.').length, 1);
  assert.deepEqual((dm('Goblin 2 takes 5 damage.')[0] as any).ids, ['g2']);
  assert.deepEqual((dm('The goblin takes 5 damage.')[0] as any).ids.sort(), ['g1', 'g2'], 'an ambiguous name is not guessed');
  for (const t of ['What if the ogre takes 12?', 'Maybe the ogre could take 12 damage if you hit.', 'Tom takes 10 minutes to climb.', 'The ogre takes 3 turns to wake.']) assert.deepEqual(kinds(t), [], t);
  assert.deepEqual(kinds('Music: something tense.'), ['music']);
  assert.deepEqual(kinds('Tomas is poisoned and the ogre is prone.'), ['condition', 'condition']);
  assert.deepEqual(kinds('Heal Tomas for 4.'), ['heal']);
  assert.deepEqual(kinds('Give Tom 50 gold.'), ['coins']);
  assert.deepEqual(kinds('That costs 50 gold.'), []);
  assert.deepEqual(kinds('You find a silver key under the bed.'), ['item']);
  assert.deepEqual(kinds('Two goblins and an ogre burst out of the reeds.'), ['add_monsters', 'add_monsters']);
  assert.deepEqual(kinds('You take a long rest.'), ['clock']);
  assert.deepEqual(kinds('Do you want to take a long rest?'), []);
  assert.deepEqual(kinds('A door creaks open behind you.'), ['sfx']);
  // A player's words never set off a scene, a creature or damage.
  const pl = (text: string) => allCues({ id: 'x', text, speaker: 'tom', role: 'player', accountId: 'a', aside: false }, ctx).map((c) => c.kind);
  assert.deepEqual(pl('Music: something tense. The ogre takes 12. Give me 50 gold.'), []);
  assert.deepEqual(pl('I rolled a 17 for initiative'), ['initiative']);
  assert.deepEqual(pl('I drink the potion'), ['use_item']);
  // A room mic or an unknown voice never does anything.
  assert.deepEqual(allCues({ id: 'x', text: 'Music: something tense.', speaker: 'Room', role: 'other', accountId: null, aside: false }, ctx), []);
});

test('TestActive_WakeWordAndCommandParsing', () => {
  assert.equal(wakeCommand('Minerva, play something tense', 'Minerva'), 'play something tense');
  assert.equal(wakeCommand('The innkeeper nods. Hey Minerva run Ambush at the docks', 'Minerva'), 'run Ambush at the docks');
  assert.equal(wakeCommand('I asked Minerva about it', 'Minerva'), null, 'the name inside a sentence is not a wake');
  assert.equal(wakeCommand('Jarvis, lights', 'Jarvis'), 'lights');
  assert.deepEqual(parseCommand('/takeover'), { cmd: 'takeover' });
  assert.deepEqual(parseCommand('/takeover-2'), { cmd: 'preset', n: '2' });
  assert.deepEqual(parseCommand('/takeover-save 4 Night owl'), { cmd: 'save', n: '4', name: 'Night owl' });
  assert.deepEqual(parseCommand('/auto music off'), { cmd: 'auto', category: 'music', setting: 'off' });
  assert.deepEqual(parseCommand('takeover two'), { cmd: 'preset', n: '2' });
  assert.equal(parseCommand('hello there'), null);
});

test('TestActive_AutoRunsWithUndoAndDedup', async () => {
  await reset();
  await say('dm', 'Music: something tense.');
  let rows = await log('done');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'play_music');
  assert.equal(rows[0].mode, 'active');
  assert.equal(rows[0].trigger, 'line');
  assert.equal(rows[0].speaker, 'dm');
  assert.equal(rows[0].visible, 'table');
  assert.ok(rows[0].latencyMs !== null && rows[0].reversible, 'a log row says how fast it was and whether it can be undone');
  // The speech model repeating itself does not restart the music.
  await say('dm', 'Music: something tense.');
  assert.equal((await log('done')).length, 1);
  // Combat: the tracker, damage with an exact undo.
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Ogre', initiative: 12, hp: 59, maxHp: 59 });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true });
  await say('dm', 'The ogre takes 12 from the fireball.');
  const hp = async () => (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants[0].hp;
  assert.equal(await hp(), 47);
  await say('dm', 'The ogre takes 12 from the fireball.');
  assert.equal(await hp(), 47, 'the same line again is not applied twice');
  rows = await log('done');
  const dmg = rows.find((r: any) => r.tool === 'damage_combatant');
  assert.ok(dmg && dmg.reversible);
  await ok('POST', `${A()}/log/${dmg.id}/undo`, T.dm);
  assert.equal(await hp(), 59, 'undo puts the hit points back');
  assert.equal((await log('undone')).length, 1);
  assert.equal((await call('POST', `${A()}/log/${dmg.id}/undo`, T.dm)).status, 409, 'undone once');
});

test('TestActive_AskCardsApproveDismissExpire', async () => {
  await reset();
  await say('dm', 'You find a silver key under the bed.');
  const cards = await log('pending');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].category, 'items');
  assert.ok(cards[0].expiresAt);
  const inv = async () => (await ok('GET', `/api/worlds/${W}/inventory?owner=party`, T.dm)).items.map((i: any) => i.name);
  assert.ok(!(await inv()).includes('Silver Key'), 'nothing happened before the tap');
  const done = await ok('POST', `${A()}/log/${cards[0].id}/approve`, T.dm);
  assert.equal(done.status, 'done');
  assert.ok((await inv()).includes('Silver Key'));
  assert.equal((await call('POST', `${A()}/log/${cards[0].id}/approve`, T.dm)).status, 409, 'a card runs once');
  // The undo takes the key away again.
  await ok('POST', `${A()}/log/${cards[0].id}/undo`, T.dm);
  assert.ok(!(await inv()).includes('Silver Key'));
  // Dismiss and expire.
  await say('dm', 'Give Tom 50 gold.');
  const c2 = (await log('pending'))[0];
  await ok('POST', `${A()}/log/${c2.id}/dismiss`, T.dm);
  assert.equal((await log('dismissed')).length, 1);
  await say('dm', 'Give Tom 70 gold.');
  const c3 = (await log('pending'))[0];
  run(deps.db, 'UPDATE active_log SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), c3.id);
  assert.equal((await log('pending')).length, 0);
  assert.equal((await log('expired')).length, 1);
  assert.equal((await call('POST', `${A()}/log/${c3.id}/approve`, T.dm)).status, 409);
});

test('TestActive_OffAndPerCategoryAndRateLimit', async () => {
  await reset();
  await settings({ cats: { music: 'off' } });
  await say('dm', 'Music: something calm.');
  assert.equal((await log()).length, 0, 'an off category does nothing and logs nothing');
  await settings({ cats: { music: 'auto', sfx: 'ask' } });
  await say('dm', 'Sound effect: creak.');
  assert.equal((await log('pending')).length, 1, 'ask makes a card');
  // The assistant mode never acts on lines by itself.
  await settings({ mode: 'assistant' });
  await say('dm', 'Music: something tense.');
  assert.equal((await log('done')).length, 0);
  await settings({ mode: 'active' });
  // Per recording override.
  await ok('PUT', A(), T.dm, { mode: 'assistant', sessionOnly: true });
  await say('dm', 'Music: something eerie.');
  assert.equal((await log('done')).length, 0, 'the recording was switched to Assistant');
  const st = await ok('PUT', A(), T.dm, { mode: 'active', sessionOnly: true });
  assert.equal(st.sessionOverride, 'active');
  // Rate limit: past 14 automatic actions a minute the rest wait for a tap.
  for (let i = 0; i < 16; i++) run(deps.db, `INSERT INTO active_log (id, world_id, session_id, at, mode, trigger, category, tool, summary, status) VALUES (?, ?, 'as_a', ?, 'active', 'line', 'sfx', 'play_sfx', 'x', 'done')`, `fill_${i}`, W, new Date().toISOString());
  await say('dm', 'Music: something tense.');
  assert.ok((await log('pending')).some((r: any) => r.tool === 'play_music'), 'over the rate limit it asks');
  run(deps.db, "DELETE FROM active_log WHERE id LIKE 'fill_%'");
  await ok('PUT', A(), T.dm, { mode: 'active' }); // drops the override
});

test('TestActive_PlayerFacingFailsClosed', async () => {
  await reset();
  await settings({ cats: { stage: 'auto', items: 'auto', events: 'auto', clock: 'auto', combatAdd: 'auto', sfx: 'auto', music: 'auto', combat: 'auto' } });
  // A party-level page may be shown on auto; a DM-only page never, in any setting.
  await say('dm', 'Show them the map of the docks.');
  const shown = (await log('done')).filter((r: any) => r.tool === 'show_on_stage');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].args.ref, ID.docks);
  await say('dm', 'Now show them the smugglers tunnel map.');
  const all2 = await log();
  assert.ok(!all2.some((r: any) => JSON.stringify(r.args ?? '').includes(ID.secretMap)), 'a DM-only page is never put on the stage');
  const stage = await ok('GET', `/api/worlds/${W}/stage`, T.jess);
  assert.ok(!JSON.stringify(stage).includes('tunnel'), 'players see no DM-only page');
  // A DM aside (DM-only line) may set the music but never anything players see.
  await say('dm', 'Show them the map of the docks again.', { aside: true });
  await say('dm', 'Give Tom 500 gold.', { aside: true });
  await say('dm', 'Music: something tense.', { aside: true });
  const rows = await log();
  const blocked = rows.filter((r: any) => r.status === 'blocked');
  assert.ok(blocked.length >= 2, 'the aside cues were blocked and logged');
  assert.ok(!rows.some((r: any) => r.status === 'done' && r.cue.includes('500 gold')));
  assert.ok(rows.some((r: any) => r.status === 'done' && r.tool === 'play_music' && r.cue.includes('tense')), 'an aside may set the music');
  const coin = await ok('GET', `/api/worlds/${W}/inventory?owner=${ID.tom}`, T.dm);
  assert.equal(coin.coinCp ?? coin.coin_cp ?? 0, 0);
  // Classified text is never read.
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Vault Code', visibility: 'classified', markdown: '# Vault Code\nThe vault code is seven seven three nine.\n' });
  const before = (await log()).length;
  await say('dm', 'The vault code is seven seven three nine. Music: something tense.');
  assert.equal((await log()).length, before, 'a line with classified text is skipped whole');
});

test('TestActive_PlayersMaySetOffOnlyTheirOwnThings', async () => {
  await reset();
  await settings({ cats: { items: 'auto', stage: 'auto', music: 'auto', combat: 'auto' } });
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.tom, name: 'Potion of Healing', qty: 2, reason: 'Test setup' });
  await say('tom', 'Music: something tense. The ogre takes 30. Show them the map of the docks.');
  assert.equal((await log()).length, 0, 'a player cannot set the scene');
  await say('tom', 'I drink the potion.');
  const c = await log('pending');
  assert.equal(c.length, 1, 'item use is a confirm card, even with items on auto');
  assert.equal(c[0].category, 'items');
  const left = async () => (await ok('GET', `/api/worlds/${W}/inventory?owner=${ID.tom}`, T.dm)).items.find((i: any) => i.name === 'Potion of Healing').qty;
  assert.equal(await left(), 2);
  await ok('POST', `${A()}/log/${c[0].id}/approve`, T.dm);
  assert.equal(await left(), 1);
  await ok('POST', `${A()}/log/${c[0].id}/undo`, T.dm);
  assert.equal(await left(), 2);
  // Initiative rolled by a player lands in the tracker on auto.
  await say('dm', 'Roll initiative!');
  assert.ok((await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).active, 'combat started');
  await say('tom', 'I rolled a 17 for initiative.');
  const tr = await ok('GET', `/api/worlds/${W}/live/combat`, T.dm);
  assert.ok(tr.combatants.some((x: any) => x.name === 'Tomas' && x.initiative === 17));
});

test('TestActive_WakeWordOnlyFromTheDmMic', async () => {
  await reset();
  await settings({ cats: { music: 'off' } });
  // Spoken on a player's mic, a room mic, or the DM's voice picked up by a player's mic: nothing.
  await say('jess', 'Minerva, play combat music.');
  await say('room', 'Minerva, play combat music.');
  await say('dm', 'Minerva, play combat music.', { mics: [MIC.dm, MIC.jess] });
  assert.equal((await log()).length, 0);
  // From the DM's own mic it is a direct request: it runs even though the category is off.
  const wakeId = await say('dm', 'Minerva, play combat music.');
  assert.equal(all<any>(deps.db, 'SELECT audience FROM audio_lines WHERE id = ?', wakeId)[0].audience, 'dm', 'a command to the assistant is taken out of the players\' transcript');
  const rows = await log('done');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trigger, 'wake');
  assert.equal(rows[0].tool, 'play_music');
  assert.equal(rows[0].args.mood, 'combat');
  // Wake works in Assistant mode too, and takes commands.
  await settings({ mode: 'assistant' });
  await say('dm', 'Minerva, takeover three.');
  const st = await ok('GET', A(), T.dm);
  assert.equal(st.mode, 'active');
  assert.equal(st.cats.items, 'auto');
  assert.equal(st.takeoverOn, false);
});

test('TestActive_TakeoverPresetsAndCommands', async () => {
  await reset();
  const cmd = (text: string) => ok('POST', `${A()}/command`, T.dm, { text });
  const before = (await ok('GET', A(), T.dm)).cats;
  let r = await cmd('/takeover');
  assert.ok(Object.entries(r.cats).every(([k, v]) => k === 'notes' ? v === 'draft' : v === 'auto'), 'everything auto, notes still drafts');
  assert.equal(r.takeoverOn, true);
  r = await cmd('/takeover');
  assert.deepEqual(r.cats, before, 'again puts the old settings back');
  r = await cmd('/takeover-1');
  assert.equal(r.cats.music, 'auto'); assert.equal(r.cats.combat, 'ask'); assert.equal(r.cats.items, 'ask');
  r = await cmd('/takeover-2');
  assert.equal(r.cats.combat, 'auto'); assert.equal(r.cats.combatAdd, 'auto'); assert.equal(r.cats.stage, 'ask');
  await cmd('/auto music off');
  await cmd('/takeover-save 4 Quiet night');
  r = await cmd('/takeover-3');
  assert.equal(r.cats.music, 'auto');
  r = await cmd('/takeover-4');
  assert.equal(r.cats.music, 'off');
  assert.equal(r.presets['4'].name, 'Quiet night');
  assert.equal((await call('POST', `${A()}/command`, T.dm, { text: '/nonsense' })).status, 400);
  // Players cannot touch any of it.
  for (const [m, u] of [['GET', ''], ['PUT', ''], ['POST', '/command'], ['GET', '/log'], ['POST', '/task']] as const) assert.equal((await call(m, A() + u, T.jess, m === 'GET' ? undefined : { text: '/takeover' })).status, 403, `${m} ${u}`);
  // In the chat too: /takeover is a command, no model needed.
  const ch = await ok('POST', `/api/worlds/${W}/agent/chats`, T.dm, {});
  await ok('POST', `/api/worlds/${W}/agent/chats/${ch.id}/messages`, T.dm, { text: '/takeover-2' });
  assert.equal((await ok('GET', A(), T.dm)).cats.combat, 'auto');
  assert.ok((await log()).some((r: any) => r.category === 'command' && r.trigger === 'chat'));
  // On auto, the player-facing safety stays.
  await cmd('/takeover');
  await say('dm', 'Show them the smugglers tunnel map.');
  assert.ok(!(await log()).some((r: any) => JSON.stringify(r.args ?? '').includes(ID.secretMap)));
});

test('TestActive_RejectTeachesAndWrongUndoes', async () => {
  await reset();
  await say('dm', 'A door creaks open behind you.');
  const done = (await log('done'))[0];
  assert.equal(done.tool, 'play_sfx');
  assert.equal(done.reversible, false, 'a sound effect is clearly not undoable');
  await ok('POST', `${A()}/log/${done.id}/wrong`, T.dm);
  run(deps.db, 'DELETE FROM active_log WHERE world_id = ? AND status = ?', W, 'done');
  // Same cue again: no longer done.
  await new Promise((r) => setTimeout(r, 10));
  const w = (await ok('GET', `${A()}/rules`, T.dm)).rules;
  assert.equal(w.length, 1);
  await say('dm', 'The door creaks open again.');
  assert.equal((await log('done')).length, 0, 'a cue the DM called wrong is not acted on again');
  // A pending card rejected is the same.
  await settings({ cats: { items: 'ask' } });
  await say('dm', 'You find a rusty lantern.');
  const c = (await log('pending'))[0];
  await ok('POST', `${A()}/log/${c.id}/reject`, T.dm);
  assert.equal((await log('rejected')).length, 1);
});

test('TestActive_ModelSettlesUnsureCuesAndScansNarration', async () => {
  await reset();
  await settings({ cats: { items: 'auto', music: 'auto', clock: 'auto' } });
  // The rules found "you find a silver key"; the model says it is a real pickup.
  audit.queue.push((b) => msg(JSON.stringify({ verdicts: [{ i: 0, ok: true }] })));
  await say('dm', 'You find a silver key under the bed.');
  assert.equal((await log('done')).filter((r: any) => r.tool === 'add_item').length, 1, 'confirmed by the model, so auto');
  assert.ok(audit.seen.at(-1).messages.every((m: any) => !/seven seven three nine/.test(m.content ?? '')));
  // A refused one is dropped.
  audit.queue.push(() => msg(JSON.stringify({ verdicts: [{ i: 0, ok: false }] })));
  await say('dm', 'You find a hidden door behind the shelf.');
  assert.equal((await log()).filter((r: any) => /hidden door/i.test(r.summary)).length, 0);
  // Narration the rules cannot read: the model scan picks a scene change.
  audit.queue.push(() => msg(JSON.stringify({ actions: [{ line: 0, cat: 'music', mood: 'tense' }] })));
  await say('dm', 'You step into a dripping cave and the torches gutter in the cold air.');
  const rows = await log('done');
  assert.ok(rows.some((r: any) => r.tool === 'play_music' && r.source === 'model'));
  // Model says nonsense (unknown mood): nothing.
  audit.queue.push(() => msg(JSON.stringify({ actions: [{ line: 0, cat: 'music', mood: 'polka' }, { line: 0, cat: 'delete_everything' }] })));
  const n0 = (await log()).length;
  await say('dm', 'You walk down the corridor and the stranger watches you pass by.');
  assert.equal((await log()).length, n0);
  // The model's own failure leaves rules working; unsure cues become cards.
  audit.queue.length = 0;
  await say('dm', 'You find a copper coin purse tucked behind the barrel.');
  assert.ok((await log('pending')).some((r: any) => r.category === 'items'));
});

test('TestActive_MacroMinervaStepTemplatesAllowlistAndPlayersNeverSeeMinerva', async () => {
  await reset();
  const w = `/api/worlds/${W}`;
  // Every template copies into a valid macro.
  for (const t of TEMPLATES) {
    const m = await ok('POST', `${w}/actions/macro-templates/${t.id}/copy`, T.dm, {});
    assert.equal(m.steps[0].action, 'minerva.run');
  }
  assert.equal(TEMPLATES.length, 11);
  assert.equal((await call('GET', `${w}/actions/macro-templates`, T.jess)).status, 403);
  // A macro with {place} written in single braces.
  const mac = await ok('POST', `${w}/actions/macros`, T.dm, { name: 'Dock ambush', params: [{ name: 'place', type: 'string' }], steps: [{ action: 'minerva.run', args: { prompt: 'Ambush at {place}: tense music', mode: 'do', tools: 'play_music,set_combat' } }] });
  assert.match(mac.steps[0].args.prompt, /\{\{place\}\}/);
  // Run it with a scripted model: it plays music (allowed) and tries a tool that is off the list.
  chat.seen.length = 0;
  chat.queue.push(() => ({ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'play_music', arguments: JSON.stringify({ mood: 'tense' }) } }, { id: 'b', type: 'function', function: { name: 'add_coin', arguments: JSON.stringify({ owner: 'party', amountCp: 100 }) } }] }), () => msg('Tense music is on.'));
  const rep = await ok('POST', `${w}/actions/macros/${mac.id}/run`, T.dm, { args: { place: 'the old docks' } });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  const offered = chat.seen[0].tools.map((t: any) => t.function.name);
  assert.ok(offered.includes('play_music') && offered.includes('set_combat'));
  assert.ok(!offered.includes('add_coin') && !offered.includes('save_page') && !offered.includes('stop_recording'), 'only the allowlist, never a destructive tool');
  assert.match(JSON.stringify(chat.seen[0].messages), /old docks/, 'the parameter was filled in');
  const coin = await ok('GET', `${w}/inventory?owner=party`, T.dm);
  assert.ok(!JSON.stringify(coin).includes('"amountCp":100'), 'the off-list tool did not run');
  const rows = await log('done');
  assert.ok(rows.some((r: any) => r.tool === 'play_music' && r.trigger === 'chat'), 'the macro run is in the command log');
  // Propose mode leaves the change for the DM.
  const prop = await ok('POST', `${w}/actions/macros`, T.dm, { name: 'Maybe loot', steps: [{ action: 'minerva.run', args: { prompt: 'Give the party 5 gold', mode: 'propose', tools: 'add_coin' } }] });
  chat.queue.push(() => toolCall('add_coin', { owner: 'party', amountCp: 500 }), () => msg('Proposed.'));
  const r2 = await ok('POST', `${w}/actions/macros/${prop.id}/run`, T.dm, {});
  assert.equal(r2.steps[0].result.pending, 1);
  assert.ok((await log('pending')).some((r: any) => r.tool === 'add_coin' && r.trigger === 'chat'));
  // Players cannot run a macro with a Minerva step, nor see it.
  assert.equal((await call('POST', `${w}/actions`.replace('/actions', '/actions/run'), T.jess, { action: 'minerva.run', args: { prompt: 'x' } })).status, 403);
  assert.equal((await call('POST', `${w}/actions/macros`, T.dm, { name: 'Player one', playerRun: true, steps: [{ action: 'minerva.run', args: { prompt: 'x' } }] })).status, 400);
  assert.equal((await call('GET', `${w}/actions/macros`, T.jess)).body.length, 0);
  // Voice: "Minerva, run Dock ambush at the old docks" runs the macro by name.
  chat.queue.push(() => toolCall('play_music', { mood: 'tense' }), () => msg('Done.'));
  await say('dm', 'Minerva, run Dock ambush at the north pier.');
  assert.ok((await log()).some((r: any) => r.tool === 'macro' && /Dock ambush/.test(r.summary)));
  assert.match(JSON.stringify(chat.seen.at(-2).messages), /north pier/);
});

test('TestActive_PlayersNeverSeeMinervaOrActiveState', async () => {
  await reset();
  await say('dm', 'Music: something tense.');
  await say('dm', 'You find a silver key under the bed.');
  const world = `/api/worlds/${W}`;
  const needles = /minerva|active mode|takeover|ask card|command log|"wake/i;
  for (const p of ['/stage', '/sound/now', '/live/combat', '/inventory?owner=me', '/audio/sessions', '/settings', '/members', '/clock', '/quick-events', '/agent/status', '/library/pages', '/actions/macros']) {
    const r = await call('GET', world + p, T.jess);
    if (r.status >= 300) continue;
    assert.ok(!needles.test(JSON.stringify(r.body)), `${p} shows nothing of Active mode`);
  }
  const events: any[] = [];
  void events;
  const lineRows = all<any>(deps.db, 'SELECT id FROM audio_lines WHERE world_id = ?', W);
  assert.ok(lineRows.length > 0);
});

test('TestPlayerHelp_JournalDraftUsesOnlyTheTable', async () => {
  run(deps.db, 'DELETE FROM audio_lines WHERE world_id = ?', W);
  await say('jess', 'I creep forward and check the lock on the cellar door.');
  await say('dm', 'The cellar door is old oak, banded with iron, and it smells of brine behind it.');
  await say('dm', 'The harbour council secretly answers to the queen of smugglers, nobody must know.', { aside: true });
  const r = await ok('GET', `/api/worlds/${W}/helper/journal-draft`, T.jess);
  assert.match(r.markdown, /creep forward/);
  assert.match(r.markdown, /cellar door is old oak/);
  assert.ok(!/smugglers/.test(r.markdown), 'a DM aside is never in a player draft');
  const tom = await ok('GET', `/api/worlds/${W}/helper/journal-draft`, T.tom);
  assert.ok(!/creep forward/.test(tom.markdown.split('## What the table heard')[0]), "another player's words are not 'mine'");
  assert.equal((await call('GET', `/api/worlds/${W}/helper/journal-draft`, T.dm)).status, 403);
  assert.deepEqual((await ok('GET', `/api/worlds/${W}/helper/recap`, T.jess)).entries, []);
});

test('TestActive_CueRegressions', () => {
  const ctx: any = { combat: { active: true, turn: 0, combatants: [{ id: 'o', name: 'Ogre', effects: [], isPc: false }, { id: 'g2', name: 'Goblin 2', effects: ['Prone'], isPc: false }, { id: 't', name: 'Tomas', effects: [], isPc: true, accountId: 'a' }] }, party: [{ accountId: 'a', name: 'Tom', character: 'Tomas' }], pages: [], sfx: [], initiativeOpen: false };
  const dm = (text: string) => allCues({ id: 'x', text, speaker: 'dm', role: 'dm', accountId: null, aside: false }, ctx);
  assert.equal((dm('The ogre takes twelve damage.')[0] as any).amount, 12, 'number words');
  assert.equal((dm('Give Tom fifty gold.')[0] as any).cp, 5000);
  assert.deepEqual(dm("The club leaves Tomas stunned until the end of his next turn.").map((c) => c.kind), ['condition'], 'his next turn is not next turn');
  assert.deepEqual(dm('Next turn.').map((c) => c.kind), ['next_turn']);
  assert.deepEqual((dm('Goblin 2 stands up again, no longer prone.')[0] as any).remove, ['Prone']);
  assert.deepEqual((dm('Tomas, you are poisoned by the spear.')[0] as any).add, ['Poisoned']);
  assert.deepEqual(dm('Goblin 2 takes 9 damage and falls to the floor, dead.').map((c) => c.kind), ['damage', 'remove_creature']);
  const pl = allCues({ id: 'x', text: 'Twelve for initiative.', speaker: 'tom', role: 'player', accountId: 'a', aside: false }, ctx);
  assert.deepEqual(pl.map((c) => c.kind), ['initiative']);
  assert.equal((pl[0] as any).value, 12);
});

test('TestActive_MonstersAddedByVoiceGetStatblockHpAndUnknownHpIsNeverDefeatedByDamage', async () => {
  const { statsFor } = await import('../src/features/active/intents.ts');
  const wid = (deps.db.prepare('SELECT id FROM worlds WHERE slug = ? OR id = ?').get(W, W) as any).id;
  const g = statsFor(deps, wid, 'Goblin');
  assert.ok(g.hp && g.hp > 0 && g.maxHp === g.hp && g.ac, `goblin stats from the rules module: ${JSON.stringify(g)}`);
  assert.deepEqual(statsFor(deps, wid, 'Goblins'), g, 'a plural name finds the same creature');
  const w = statsFor(deps, wid, 'Wolf');
  assert.ok(w.hp && w.hp > 0, JSON.stringify(w));
  assert.deepEqual(statsFor(deps, wid, 'wolves'), w, '"wolves" is a wolf');
  assert.deepEqual(statsFor(deps, wid, 'Mister Nobody'), {}, 'no statblock: nothing made up');
  const { id } = await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Bandit of unknown health', initiative: 3 });
  const r = await ok('PATCH', `/api/worlds/${W}/live/combatants/${id}`, T.dm, { damage: 8 });
  assert.equal(r.defeated, false, 'damage to unknown HP does not defeat');
  assert.equal(r.hp, null);
});

test('TestCombat_CreaturesWithTheSameNameAreNumbered', async () => {
  for (const cb of (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants) await call('DELETE', `/api/worlds/${W}/live/combatants/${cb.id}`, T.dm);
  for (let i = 0; i < 3; i++) await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Wolf', initiative: 10 + i });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Bandit Captain', initiative: 5 });
  const names = (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants.map((x: any) => x.name).sort();
  assert.deepEqual(names, ['Bandit Captain', 'Wolf 1', 'Wolf 2', 'Wolf 3']);
});

test('TestActive_SpokenRequestReplyReachesOnlyTheDm', async () => {
  await reset();
  const { EventTap } = await import('./security-kit.ts');
  const dmTap = new EventTap(`${base}/api/worlds/${W}/events`, T.dm);
  const jessTap = new EventTap(`${base}/api/worlds/${W}/events`, T.jess);
  await new Promise((r) => setTimeout(r, 100));
  chat.queue.length = 0;
  chat.queue.push(() => msg('The harbour council answers to Velmira, a DM secret.'), () => msg('The harbour council answers to Velmira, a DM secret.'));
  await say('dm', 'Minerva, tell me who really rules the harbour council.');
  await new Promise((r) => setTimeout(r, 150));
  const row = (await log('done')).find((l) => l.tool === 'agent');
  assert.ok(row, 'the spoken request ran as a task');
  const spoken = (tap: { text: string }) => tap.text.split('\n\n').filter((b) => b.includes('"kind":"spoken"'));
  const got = spoken(dmTap);
  assert.equal(got.length, 1, dmTap.text);
  const ev = JSON.parse(got[0].split('\n').find((l) => l.startsWith('data:'))!.slice(5));
  const data = ev.data ?? ev;
  assert.match(data.text, /Velmira/);
  assert.ok((await ok('GET', `/api/worlds/${W}/agent/chats/${data.chatId}`, T.dm)).messages.length >= 2, 'the event names the chat that holds the reply');
  assert.equal(jessTap.text.includes('Velmira'), false, 'a player never receives the reply');
  assert.equal(spoken(jessTap).length, 0);
  chat.queue.length = 0;
  await dmTap.close(); await jessTap.close();
});

test('TestCombat_AssistantAddsAPartyMemberByNameAsTheirCharacterAndTurnTimersMeanSelf', async () => {
  for (const cb of (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants) await call('DELETE', `/api/worlds/${W}/live/combatants/${cb.id}`, T.dm);
  const wid = (deps.db.prepare('SELECT id FROM worlds WHERE slug = ? OR id = ?').get(W, W) as any).id;
  const pc = deps.db.prepare("SELECT m.account_id AS id, m.character_name AS ch FROM members m WHERE m.world_id = ? AND m.role = 'player' AND m.character_name IS NOT NULL AND m.character_name <> '' LIMIT 1").get(wid) as any;
  assert.ok(pc, 'a player with a character');
  const { id } = await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: pc.ch, initiative: 12, hp: 20, maxHp: 20 });
  const row = (await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants.find((x: any) => x.id === id);
  assert.equal(row.accountId ?? row.account_id, pc.id, 'linked to the player: death saves, not "defeated"');
  const ogre = await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Ogre', initiative: 5, hp: 59 });
  await ok('PATCH', `/api/worlds/${W}/live/combatants/${ogre.id}`, T.dm, { effects: [{ name: 'Stunned', untilEndOf: 'next turn' }] });
  const tool = (await import('../src/features/agent/index.ts')).default.mcpTools!.find((t) => t.name === 'add_combatant')!;
  assert.equal((tool.call({ name: 'Wolf', initiative: 0 }) as any).body.initiative, undefined, 'a 0 from the model is rolled');
  assert.equal((tool.call({ name: 'Wolf', initiative: 14 }) as any).body.initiative, 14);
});

test("TestActive_ThoughtsSayWhatWasHeardAndWhyItActedAskedOrLetGo", async () => {
  await reset();
  const { clearThoughts } = await import('../src/features/active/thoughts.ts');
  clearThoughts(deps, W);
  const thoughts = async () => (await ok('GET', `${A()}/thoughts`, T.dm));
  await settings({ cats: { music: 'off', sfx: 'ask' } });
  await say('dm', 'Music: something calm.');
  await say('dm', 'Sound effect: creak.');
  const th = await thoughts();
  assert.equal(th.mode, 'active');
  assert.equal(th.recording, true);
  assert.match(th.heard.text, /creak/, 'the last line heard is the listening line, not a feed entry');
  assert.ok(!th.thoughts.some((t: any) => t.kind === 'heard'));
  assert.ok(th.thoughts.some((t: any) => t.kind === 'skip' && /Music and ambience is set to Off/.test(t.text)), JSON.stringify(th.thoughts));
  const ask = th.thoughts.find((t: any) => t.kind === 'ask');
  assert.match(ask.text, /Sound effects is set to Ask/);
  assert.ok(ask.logId, 'a card can be decided from the window');
  assert.equal((await log('pending'))[0].id, ask.logId);
  // Approving the card says so; a line repeated at once is let go with the reason.
  await ok('POST', `${A()}/log/${ask.logId}/approve`, T.dm);
  await settings({ cats: { music: 'auto' } });
  await say('dm', 'Music: something tense.');
  await say('dm', 'Music: something tense.');
  const th2 = (await thoughts()).thoughts;
  assert.ok(th2.some((t: any) => t.kind === 'do' && /You said do it/.test(t.text)));
  assert.ok(th2.some((t: any) => t.kind === 'do' && /^Did it:/.test(t.text)));
  assert.ok(th2.some((t: any) => t.kind === 'skip' && /again/.test(t.text)));
  assert.equal((await call('GET', `${A()}/thoughts`, T.jess)).status, 403, 'players never see them');
});
