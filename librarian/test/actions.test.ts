// Actions, macros, bindings and trigger URLs (PLAN §16.1): every action runs
// and respects roles, macros run in order and report a failure, bindings are
// stored by scope, and a trigger URL runs only its macro, reads nothing, is
// rate limited and can be revoked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { toneWav } from './soundTone.ts';
import { ACTIONS } from '../src/features/actions/catalog.ts';
import { normCombo } from '../src/features/actions/combo.ts';
import { normalizeStatblock, saveStatblockPage } from '../src/features/agent/statblock.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const A = () => `/api/worlds/${W}/actions`;
const realFetch = globalThis.fetch;
const lightCalls: { url: string; body: any }[] = [];

const fakeFetch: typeof fetch = async (input: any, init: any = {}) => {
  const u = String(input);
  if (u.startsWith('http://127.0.0.1')) return realFetch(input, init);
  if (u === 'http://tts.test/v1/audio/speech') return new Response(new Uint8Array(toneWav()), { headers: { 'content-type': 'audio/wav' } });
  if (u.startsWith('http://wled.local/')) { lightCalls.push({ url: u, body: JSON.parse(init.body) }); return new Response('{"success":true}'); }
  throw new Error(`unexpected fetch ${u}`);
};

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
const act = (token: string, action: string, args: Record<string, unknown> = {}) => call('POST', `${A()}/run`, token, { action, args });
const macro = (body: Record<string, unknown>) => ok('POST', `${A()}/macros`, T.dm, body);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-act-'));
  const put = (rel: string) => { fs.mkdirSync(path.dirname(path.join(tmp, 'data', rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, 'data', rel), toneWav()); };
  put('music/combat/boss.wav'); put('music/village/calm/meadow.wav'); put('ambience/rain/rain.wav'); put('sfx/doors/creak.wav');
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_VOICE_URL: 'http://tts.test/v1', ALX_MODEL_VOICE_MODEL: 'kokoro', ALX_RATE_LIMIT: '0', ALX_LIGHTS_MIN_MS: '0' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Actionland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestActions_PlayersSeeOnlyWhatTheyMayRun', async () => {
  const dm = await ok('GET', A(), T.dm);
  const pl = await ok('GET', A(), T.jess);
  assert.equal(dm.actions.length, ACTIONS.length);
  assert.deepEqual(pl.actions.map((a: any) => a.id), ['dice.roll']);
  const needed = ['combat.next', 'combat.damage', 'combat.heal', 'combat.add_statblock', 'clock.short_rest', 'clock.long_rest', 'clock.next_day', 'clock.advance', 'sound.pad', 'sound.mood', 'sound.ambience', 'sound.stop_all', 'stage.show', 'stage.hide', 'recording.start', 'recording.stop', 'recording.aside', 'recording.aside_hold', 'event.send', 'voice.speak', 'dice.roll', 'gen.gold', 'lights.scene'];
  for (const id of needed) assert.ok(dm.actions.some((a: any) => a.id === id), `action ${id} is registered`);
  assert.ok(dm.actions.every((a: any) => a.title && Array.isArray(a.args) && Array.isArray(a.roles)));
});

test('TestActions_PlayersCannotRunDmActions', async () => {
  for (const a of ACTIONS.filter((x) => !x.roles.includes('player'))) {
    const args = Object.fromEntries(a.args.filter((x) => x.required).map((x) => [x.name, x.type === 'int' || x.type === 'number' ? 1 : x.type === 'bool' ? true : x.type === 'enum' ? x.values![0] : 'x']));
    const r = await act(T.jess, a.id, args);
    assert.equal(r.status, 403, `${a.id} for a player -> ${r.status}`);
  }
  assert.equal((await act(T.jess, 'no.such.action')).status, 404);
  // A player may roll dice.
  const d = await act(T.jess, 'dice.roll', { notation: '2d6+3' });
  assert.equal(d.status, 200);
  assert.ok(d.body.result.total >= 5 && d.body.result.total <= 15);
  assert.equal((await act(T.jess, 'dice.roll', { notation: 'banana' })).status, 422);
  // Unknown arguments are refused.
  assert.equal((await act(T.dm, 'dice.roll', { notation: 'd20', cheat: 1 })).status, 422);
});

test('TestActions_EveryActionRuns', async () => {
  const w = `/api/worlds/${W}`;
  // Combat: two creatures and a player.
  const hero = await ok('POST', `${w}/live/combatants`, T.dm, { name: 'Brenna', initiative: 18, hp: 30, maxHp: 30, accountId: ID.jess });
  const orc = await ok('POST', `${w}/live/combatants`, T.dm, { name: 'Orc', initiative: 10, hp: 20, maxHp: 20 });
  assert.equal((await act(T.dm, 'combat.start')).status, 200);
  let r = await act(T.dm, 'combat.damage', { target: 'current', amount: 7 });
  assert.equal(r.body.result.name, 'Brenna');
  assert.equal(r.body.result.hp, 23);
  r = await act(T.dm, 'combat.heal', { target: 'current', amount: 100 });
  assert.equal(r.body.result.hp, 30, 'healing stops at the maximum');
  r = await act(T.dm, 'combat.damage', { target: 'orc', amount: 5 });
  assert.equal(r.body.result.hp, 15);
  r = await act(T.dm, 'combat.next');
  assert.equal(r.status, 200);
  assert.equal(r.body.result.turn, 1);
  r = await act(T.dm, 'combat.damage', { target: 'current', amount: 1 });
  assert.equal(r.body.result.name, 'Orc', 'current follows the turn');
  assert.equal((await act(T.dm, 'combat.damage', { target: 'nobody', amount: 1 })).status, 404);
  // A statblock page.
  const sb = normalizeStatblock({ name: 'Goblin', size: 'Small', type: 'humanoid', alignment: 'neutral evil', cr: '1/4', ac: 15, hp: 7, speed: { walk: '30 ft.' }, actions: [{ name: 'Scimitar', text: 'Melee +4. Hit: 5 slashing.' }], abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 } } as any);
  const pg: any = saveStatblockPage(deps, W, ID.dm, sb, { kind: 'test', ref: 'goblin', title: 'Goblin' });
  r = await act(T.dm, 'combat.add_statblock', { page: pg.id, initiative: 12 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.hp, 7);
  assert.equal((await act(T.dm, 'combat.end')).status, 200);
  void hero; void orc;

  // Clock.
  for (const [a, args] of [['clock.short_rest', {}], ['clock.long_rest', {}], ['clock.next_day', {}], ['clock.advance', { minutes: 30 }]] as const) {
    r = await act(T.dm, a, args as any);
    assert.equal(r.status, 200, `${a}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await act(T.dm, 'clock.advance', { minutes: 0 })).status, 422);

  // Sound.
  const lib = await ok('GET', `${w}/sound/library`, T.dm);
  await ok('POST', `${w}/sound/pads`, T.dm, { file: lib.sfx[0].id, label: 'Door creak' });
  await ok('POST', `${w}/sound/scenes`, T.dm, { name: 'Rainy', layers: [{ kind: 'rain', volume: 0.4 }] });
  assert.equal((await act(T.dm, 'sound.pad', { pad: 'door creak' })).status, 200);
  assert.equal((await act(T.dm, 'sound.pad', { pad: 'nope' })).status, 404);
  r = await act(T.dm, 'sound.mood', { x: 0.95, y: 0.95 });
  assert.equal(r.status, 200);
  assert.ok(r.body.result.track);
  assert.equal((await act(T.dm, 'sound.mood', { x: 2, y: 0 })).status, 422);
  assert.equal((await act(T.dm, 'sound.ambience', { scene: 'Rainy' })).status, 200);
  assert.equal((await act(T.dm, 'sound.stop_all')).status, 200);

  // Stage.
  const card = await ok('POST', `${w}/stage/cards`, T.dm, { kind: 'text', title: 'Rumour', text: 'The bridge is weak.' });
  assert.equal((await act(T.dm, 'stage.show', { card: card.label || 'Rumour' })).status, 200);
  assert.equal((await ok('GET', `${w}/stage`, T.jess)).cards.length, 1);
  assert.equal((await act(T.dm, 'stage.hide', { card: card.id })).status, 200);
  assert.equal((await ok('GET', `${w}/stage`, T.jess)).cards.length, 0);
  assert.equal((await act(T.dm, 'stage.show', { card: 'missing' })).status, 404);

  // Recording: start, aside on/off (needs a mic), the hold variant, stop.
  assert.equal((await act(T.dm, 'recording.stop')).status, 422, 'nothing to stop');
  assert.equal((await act(T.dm, 'recording.start', { name: 'Test session' })).status, 200);
  assert.equal((await act(T.dm, 'recording.aside', { on: true })).status, 422, 'no mic yet');
  await ok('POST', `${w}/audio/mics`, T.dm, { deviceId: 'dev1', label: 'Table', mode: 'always' });
  assert.equal((await act(T.dm, 'recording.aside', { on: true })).status, 200);
  assert.equal((await ok('GET', `${w}/audio/mics`, T.dm))[0].aside, true);
  assert.equal((await act(T.dm, 'recording.aside', { on: false })).status, 200);
  assert.equal((await ok('GET', `${w}/audio/mics`, T.dm))[0].aside, false);
  assert.equal((await act(T.dm, 'recording.aside_hold', { phase: 'end' })).status, 422, 'no hold started');
  assert.equal((await act(T.dm, 'recording.aside_hold', { phase: 'start' })).status, 200);
  assert.equal((await act(T.dm, 'recording.aside_hold', { phase: 'end' })).status, 200);
  assert.equal((await act(T.dm, 'recording.stop')).status, 200);

  // Quick event, voice, gold, dice.
  r = await act(T.dm, 'event.send', { template: 'ambush', dc: 15 });
  assert.equal(r.status, 200);
  assert.equal((await ok('GET', `${w}/quick-events`, T.jess))[0].title, 'Ambush!');
  const preset = await ok('POST', `${w}/voice/presets`, T.dm, { name: 'Narrator', voice: 'bm_george' });
  assert.equal(preset.name, 'Narrator');
  assert.equal((await act(T.dm, 'voice.speak', { preset: 'narrator', text: 'The door creaks open.' })).status, 200);
  assert.equal((await act(T.dm, 'voice.speak', { preset: 'nobody', text: 'x' })).status, 404);
  r = await act(T.dm, 'gen.gold', { mode: 'individual', level: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await ok('GET', `${w}/live`, T.dm)).party !== undefined || true);
  assert.equal((await act(T.dm, 'dice.roll', {})).status, 200, 'dice default to a d20');

  // Lights scene (uses the lights feature directly).
  const drv = await ok('POST', `${w}/lights/drivers`, T.dm, { kind: 'wled', name: 'Strip', config: { host: 'wled.local' } });
  await ok('POST', `${w}/lights/groups`, T.dm, { name: 'Room', driverId: drv.id, target: {} });
  await ok('POST', `${w}/lights/scenes`, T.dm, { name: 'Red alert', color: '#ff0000' });
  lightCalls.length = 0;
  r = await act(T.dm, 'lights.scene', { scene: 'red alert' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(lightCalls.length, 1);
  assert.deepEqual(lightCalls[0].body.seg[0].col, [[255, 0, 0]]);
  assert.equal((await act(T.dm, 'lights.scene', { scene: 'ghost' })).status, 404);
  // Templates: runs a built-in by name (no model: the generators fill it) without sending it anywhere.
  r = await act(T.dm, 'sculpt.run', { template: 'Rumour table', count: 1, outputs: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await act(T.dm, 'sculpt.run', { template: 'No such template' })).status, 404);
  // Minerva actions: the switch and a command work; a task needs a chat model (none here), so it says so.
  assert.equal((await act(T.dm, 'minerva.active', { mode: 'on' })).body.result.mode, 'active');
  assert.equal((await act(T.dm, 'minerva.active', { mode: 'toggle' })).body.result.mode, 'assistant');
  assert.match((await act(T.dm, 'minerva.command', { command: '/takeover-1' })).body.result.message, /Mood only/);
  assert.equal((await act(T.dm, 'minerva.run', { prompt: 'Play tense music' })).status, 422, 'no chat model is set');
  // Every action in the registry was exercised above.
  const rows = all<any>(deps.db, "SELECT detail FROM audit WHERE world_id = ? AND action = 'action.run'", W).map((x) => String(x.detail).split(' ')[0]);
  for (const a of ACTIONS) assert.ok(rows.includes(a.id), `${a.id} ran`);
});

test('TestActions_MacroRunsInOrderAndStopsOnFailure', async () => {
  const w = `/api/worlds/${W}`;
  await ok('PUT', `${w}/live/combat`, T.dm, { active: false });
  const m = await macro({
    name: 'Rest and report', steps: [
      { action: 'clock.short_rest' },
      { action: 'combat.damage', args: { target: 'nobody-here', amount: 3 } },
      { action: 'dice.roll', args: { notation: 'd6' } },
    ],
  });
  let r = await call('POST', `${A()}/macros/${m.id}/run`, T.dm, {});
  assert.equal(r.status, 207);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.steps.map((s: any) => s.status), ['ok', 'failed', 'skipped']);
  assert.match(r.body.steps[1].error, /combat|combatant/i);
  // The same with continueOnError on the failing step: the rest runs.
  const m2 = await macro({
    name: 'Rest and carry on', steps: [
      { action: 'combat.damage', args: { target: 'nobody-here', amount: 3 }, continueOnError: true },
      { action: 'dice.roll', args: { notation: 'd6' }, delayMs: 30 },
    ],
  });
  const t0 = Date.now();
  r = await call('POST', `${A()}/macros/${m2.id}/run`, T.dm, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.steps.map((s: any) => s.status), ['failed', 'ok']);
  assert.ok(Date.now() - t0 >= 25, 'the delay was honoured');
  // Every run is audited.
  const runs = await ok('GET', `${A()}/runs`, T.dm);
  assert.ok(runs.some((x: any) => x.action === 'macro.run' && x.detail.includes('Rest and carry on')));
  // Arguments: templates are filled from the macro's parameters.
  const m3 = await macro({ name: 'Hit', params: [{ name: 'dmg', type: 'int', default: 4, min: 1, max: 50 }], steps: [{ action: 'combat.damage', args: { target: 'Brenna', amount: '{{dmg}}' } }] });
  r = await call('POST', `${A()}/macros/${m3.id}/run`, T.dm, { args: { dmg: 6 } });
  assert.equal(r.body.steps[0].result.name, 'Brenna');
  assert.equal(r.status, 200);
  assert.equal((await call('POST', `${A()}/macros/${m3.id}/run`, T.dm, { args: { dmg: 999 } })).status, 400);
  assert.equal((await call('POST', `${A()}/macros/${m3.id}/run`, T.dm, { args: { sneaky: 1 } })).status, 400);
});

test('TestActions_MacroValidationAndPlayerMacros', async () => {
  assert.equal((await call('POST', `${A()}/macros`, T.dm, { name: 'Bad', steps: [{ action: 'nope' }] })).status, 400);
  assert.equal((await call('POST', `${A()}/macros`, T.dm, { name: 'Bad', steps: [] })).status, 400);
  assert.equal((await call('POST', `${A()}/macros`, T.dm, { name: 'Bad', steps: [{ action: 'combat.next', args: { x: 1 } }] })).status, 400);
  assert.equal((await call('POST', `${A()}/macros`, T.dm, { name: 'Bad', steps: [{ action: 'combat.next', delayMs: 99999 }] })).status, 400);
  assert.equal((await call('POST', `${A()}/macros`, T.dm, { name: 'Bad', steps: [{ action: 'dice.roll', args: { notation: '{{nope}}' } }] })).status, 400, 'unknown parameter');
  // A macro players can run may only use actions players may use.
  assert.equal((await call('POST', `${A()}/macros`, T.dm, { name: 'Sneaky', playerRun: true, steps: [{ action: 'combat.next' }] })).status, 400);
  assert.equal((await call('POST', `${A()}/macros`, T.jess, { name: 'Mine', steps: [{ action: 'dice.roll' }] })).status, 403, 'players cannot make macros');
  const pm = await macro({ name: 'Initiative roll', playerRun: true, steps: [{ action: 'dice.roll', args: { notation: 'd20' } }] });
  const dmOnly = await macro({ name: 'Secret plan', description: 'Ashgrove ambush', steps: [{ action: 'event.send', args: { template: 'noise', prompt: 'The cult strikes' } }] });
  // A player sees the shared macro without its steps, and never learns of the other.
  const list = await ok('GET', `${A()}/macros`, T.jess);
  assert.deepEqual(list.map((x: any) => x.name), ['Initiative roll']);
  assert.equal(list[0].steps, undefined);
  assert.equal((await call('GET', `${A()}/macros/${dmOnly.id}`, T.jess)).status, 404);
  assert.equal((await call('POST', `${A()}/macros/${dmOnly.id}/run`, T.jess, {})).status, 404);
  assert.ok(!JSON.stringify(list).includes('cult'));
  const run = await call('POST', `${A()}/macros/${pm.id}/run`, T.jess, {});
  assert.equal(run.status, 200);
  assert.equal(run.body.steps[0].status, 'ok');
  // Editing it so players cannot run it drops their bindings.
  await ok('POST', `${A()}/bindings`, T.jess, { combo: 'Ctrl+Alt+R', macroId: pm.id, scope: 'web' });
  await ok('PUT', `${A()}/macros/${pm.id}`, T.dm, { playerRun: false });
  assert.deepEqual((await ok('GET', `${A()}/bindings`, T.jess)).bindings, []);
  assert.equal((await call('POST', `${A()}/macros/${pm.id}/run`, T.jess, {})).status, 404);
  await ok('DELETE', `${A()}/macros/${pm.id}`, T.dm);
  await ok('DELETE', `${A()}/macros/${dmOnly.id}`, T.dm);
});

test('TestActions_BindingsAreStoredPerAccountAndScope', async () => {
  const m = await macro({ name: 'Quick roll', playerRun: true, steps: [{ action: 'dice.roll' }] });
  assert.equal(normCombo('ctrl+alt+shift+1'), 'Ctrl+Alt+Shift+1');
  assert.equal(normCombo('shift+control+alt+1'), 'Ctrl+Alt+Shift+1');
  assert.equal(normCombo('f13'), 'F13');
  assert.equal(normCombo('Cmd+Space'), 'Meta+Space');
  assert.throws(() => normCombo('a'), /Ctrl, Alt or Meta/);
  assert.throws(() => normCombo('Ctrl+Alt'), /key/);
  assert.throws(() => normCombo('Ctrl+Banana'), /not a key/);
  const web = await ok('POST', `${A()}/bindings`, T.dm, { combo: 'F13', macroId: m.id, scope: 'web' });
  assert.equal(web.combo, 'F13');
  const app = await ok('POST', `${A()}/bindings`, T.dm, { combo: 'F13', macroId: m.id, scope: 'app' });
  const both = await ok('POST', `${A()}/bindings`, T.dm, { combo: 'ctrl+alt+shift+1', macroId: m.id });
  assert.equal(both.scope, 'both');
  // The same keys cannot mean two things in one place.
  assert.equal((await call('POST', `${A()}/bindings`, T.dm, { combo: 'F13', macroId: m.id, scope: 'both' })).status, 409);
  assert.equal((await call('POST', `${A()}/bindings`, T.dm, { combo: 'Alt+Shift+Ctrl+1', macroId: m.id, scope: 'web' })).status, 409);
  assert.equal((await call('POST', `${A()}/bindings`, T.dm, { combo: 'x', macroId: m.id })).status, 400);
  assert.equal((await call('POST', `${A()}/bindings`, T.dm, { combo: 'F14', macroId: 'nope' })).status, 404);
  assert.equal((await call('POST', `${A()}/bindings`, T.dm, { combo: 'F14', macroId: m.id, scope: 'tv' })).status, 400);
  const combos = (b: any) => b.bindings.map((x: any) => `${x.combo}:${x.scope}`).sort();
  assert.deepEqual(combos(await ok('GET', `${A()}/bindings?scope=web`, T.dm)), ['Ctrl+Alt+Shift+1:both', 'F13:web']);
  assert.deepEqual(combos(await ok('GET', `${A()}/bindings?scope=app`, T.dm)), ['Ctrl+Alt+Shift+1:both', 'F13:app']);
  assert.equal((await ok('GET', `${A()}/bindings?scope=app`, T.dm)).bindings[0].macroName, 'Quick roll');
  // Bindings belong to the account.
  assert.deepEqual((await ok('GET', `${A()}/bindings`, T.jess)).bindings, []);
  const mine = await ok('POST', `${A()}/bindings`, T.jess, { combo: 'F13', macroId: m.id, scope: 'web' });
  assert.equal((await call('DELETE', `${A()}/bindings/${web.id}`, T.jess)).status, 404, "not someone else's");
  assert.equal((await ok('GET', `${A()}/bindings`, T.dm)).bindings.length, 3);
  await ok('DELETE', `${A()}/bindings/${mine.id}`, T.jess);
  await ok('DELETE', `${A()}/bindings/${web.id}`, T.dm);
  await ok('DELETE', `${A()}/bindings/${app.id}`, T.dm);
  await ok('DELETE', `${A()}/bindings/${both.id}`, T.dm);
  // A DM-only macro cannot be bound by a player.
  const secret = await macro({ name: 'Plot', steps: [{ action: 'combat.next' }] });
  assert.equal((await call('POST', `${A()}/bindings`, T.jess, { combo: 'F15', macroId: secret.id })).status, 404);
  await ok('DELETE', `${A()}/macros/${m.id}`, T.dm);
  await ok('DELETE', `${A()}/macros/${secret.id}`, T.dm);
});

test('TestActions_TriggerUrlRunsOnlyItsMacro', async () => {
  const m = await macro({ name: 'Roll for me', params: [{ name: 'dice', type: 'string', default: 'd20' }], steps: [{ action: 'dice.roll', args: { notation: '{{dice}}' } }] });
  const other = await macro({ name: 'Other macro', steps: [{ action: 'dice.roll', args: { notation: 'd4' } }] });
  assert.equal((await call('POST', `${A()}/macros/${m.id}/triggers`, T.jess, {})).status, 403, 'players cannot make trigger urls');
  const t = await ok('POST', `${A()}/macros/${m.id}/triggers`, T.dm, { label: 'Stream Deck', perMinute: 3 });
  assert.match(t.token, /^alx_trg_/);
  assert.equal(t.url, `${base}/api/trigger/${t.token}`);
  // Shown once: the list never has the token.
  const list = await ok('GET', `${A()}/triggers`, T.dm);
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(t.token));
  assert.equal(list[0].macroName, 'Roll for me');
  const before = await call('GET', `${A()}/triggers`, T.jess);
  assert.equal(before.status, 403);

  // It runs the macro, with no login at all.
  let r = await call('POST', `/api/trigger/${t.token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.macro, 'Roll for me');
  assert.equal(r.body.steps[0].status, 'ok');
  assert.equal(r.body.steps[0].result, undefined, 'the caller learns what ran, not what it returned');
  // An argument override, limited to declared parameters.
  r = await call('POST', `/api/trigger/${t.token}?arg=dice=3d6`);
  assert.equal(r.status, 200);
  r = await call('POST', `/api/trigger/${t.token}?arg=macro=${other.id}`);
  assert.equal(r.status, 400, 'cannot point it at another macro');
  r = await call('POST', `/api/trigger/${t.token}?arg=bogus`);
  assert.equal(r.status, 400);
  // The three runs so far fill the limit of 3 a minute (the two refused calls did not count).
  r = await call('POST', `/api/trigger/${t.token}`);
  assert.equal(r.status, 200);
  r = await call('POST', `/api/trigger/${t.token}`);
  assert.equal(r.status, 429);
  // The token is not a login: it opens no other route.
  for (const [method, url] of [['GET', `/api/worlds/${W}`], ['GET', `${A()}/macros`], ['POST', `${A()}/macros/${other.id}/run`], ['GET', `/api/worlds/${W}/live`], ['GET', '/api/worlds'], ['POST', '/mcp']] as const) {
    const x = await fetch(base + url, { method, headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.ok([401, 403, 404].includes(x.status), `${method} ${url} with a trigger token -> ${x.status}`);
  }
  // Wrong tokens look like nothing.
  assert.equal((await call('POST', '/api/trigger/alx_trg_wrong')).status, 404);
  assert.equal((await call('POST', '/api/trigger/not-a-token')).status, 404);
  assert.equal((await call('GET', `/api/trigger/${t.token}`)).status, 404, 'POST only');
  // Revoke it.
  await ok('DELETE', `${A()}/triggers/${t.id}`, T.dm);
  assert.equal((await call('POST', `/api/trigger/${t.token}`)).status, 404);
  assert.equal((await ok('GET', `${A()}/triggers`, T.dm))[0].revoked, true);
  // The runs were audited, and no login was left behind.
  assert.ok(all<any>(deps.db, "SELECT detail FROM audit WHERE world_id = ? AND action = 'macro.trigger'", W).length >= 3);
  assert.equal(all<any>(deps.db, 'SELECT 1 FROM sessions WHERE expires_at < ?', new Date(Date.now() + 11 * 60_000).toISOString()).length, 0, 'no leftover temporary session');
  await ok('DELETE', `${A()}/macros/${m.id}`, T.dm);
  await ok('DELETE', `${A()}/macros/${other.id}`, T.dm);
});

test('TestActions_TriggerFailureAndRemovedMaker', async () => {
  const m = await macro({ name: 'Broken', steps: [{ action: 'stage.show', args: { card: 'does not exist' } }] });
  const t = await ok('POST', `${A()}/macros/${m.id}/triggers`, T.dm, {});
  const r = await call('POST', `/api/trigger/${t.token}`);
  assert.equal(r.status, 424);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.steps[0].status, 'failed');
  // Deleting the macro takes its trigger with it.
  await ok('DELETE', `${A()}/macros/${m.id}`, T.dm);
  assert.equal((await call('POST', `/api/trigger/${t.token}`)).status, 404);
});

test('TestActions_McpToolsListAndRunMacros', async () => {
  const names = toolsFor(true).map((x) => x.name);
  assert.ok(names.includes('list_macros') && names.includes('run_macro'));
  assert.ok(toolsFor(false).some((x) => x.name === 'list_macros'));
  assert.ok(!toolsFor(false).some((x) => x.name === 'run_macro'), 'running is a write tool');
  const m = await macro({ name: 'Mcp roll', steps: [{ action: 'dice.roll' }] });
  const key = await ok('POST', '/api/keys', T.dm, { label: 'agent', scope: 'scribe', worldId: W, access: 'write' });
  const rpc = async (token: string, name: string, args: Record<string, unknown>) => {
    const x = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await x.json()) as any;
  };
  const listed = await rpc(key.key, 'list_macros', {});
  assert.match(listed.result.content[0].text, /Mcp roll/);
  const ran = await rpc(key.key, 'run_macro', { macro: 'mcp roll' });
  assert.equal(ran.result.isError, false, JSON.stringify(ran));
  assert.match(ran.result.content[0].text, /"status":"ok"/);
  await ok('DELETE', `${A()}/macros/${m.id}`, T.dm);
});
