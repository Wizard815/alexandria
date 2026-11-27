// Roll20: the real Mod script (features/roll20/client/alexandria.mod.js)
// runs in a stand-in Roll20 sandbox (roll20-sandbox.js), a test bridge
// carries its chat messages to and from a real librarian, and both sides are
// checked: characters linked by name, HP and markers both ways, rolls into
// the table chat and back, handouts, chat lines, keys and roles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { conditionsFromMarkers, markerMap, markersFor } from '../src/features/roll20/sync.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const MOD = fs.readFileSync(path.join(here, '../src/features/roll20/client/alexandria.mod.js'), 'utf8');
const SANDBOX = fs.readFileSync(path.join(here, 'roll20-sandbox.js'), 'utf8');

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
let KEY = '';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a Roll20 game with the Mod, and a bridge in between ----
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

function game() {
  const ctx: any = { console, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(SANDBOX, ctx);
  const sb = ctx.makeRoll20Sandbox({ tokenMarkers: [{ name: 'Concentrating', tag: 'Concentrating::4401' }] });
  Object.assign(ctx, sb.api);
  vm.runInContext(MOD, ctx);
  const gm = sb.addPlayer('Wizard', true);
  const pj = sb.addPlayer('jess', false);
  const pt = sb.addPlayer('Tom', false);
  const jess = sb.addCharacter('Jessamine', [pj.id], 30, 30);
  const tom = sb.addCharacter('Tomas', [pt.id], 22, 25);
  const gob = sb.addCharacter('Goblin', [], 7, 7);
  sb.ready();

  // The bridge: whispers to the GM go to Alexandria; Alexandria's answers go back as !alx-in.
  const inbox: any[] = [];
  const parts: Record<string, Record<number, string>> = {};
  const RX = /ALX::(\S+) (\d+)\/(\d+) (\S+?)::ALX/;
  sb.api.onChatLine = (m: any) => {
    if (m.type !== 'whisper') return;
    const x = RX.exec(m.content);
    if (!x) return;
    const p = (parts[x[1]] ??= {});
    p[+x[2]] = x[4];
    if (Object.keys(p).length < +x[3]) return;
    delete parts[x[1]];
    inbox.push(dec(Array.from({ length: +x[3] }, (_, i) => p[i + 1]).join('')));
  };
  let n = 0;
  const toMod = (o: unknown, chunk = 1500) => {
    const data = enc(o);
    const id = `t${n++}`;
    const k = Math.max(1, Math.ceil(data.length / chunk));
    for (let i = 0; i < k; i++) sb.say(gm.id, `!alx-in ${id} ${i + 1}/${k} ${data.slice(i * chunk, (i + 1) * chunk)}`);
  };
  const bapi = (p: string, body: unknown = {}, key = KEY) => call('POST', `/api/roll20/bridge${p}`, key, body);
  /** Carry everything the Mod whispered to Alexandria. */
  async function carry() {
    while (inbox.length) {
      const m = inbox.shift();
      if (m.t === 'hi') await bapi('/hello', { modVersion: m.version, campaign: m.campaign });
      if (m.t === 'events') {
        const r = await bapi('/events', { instance: m.instance, events: m.events });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        if (r.body.acked) toMod({ t: 'ack', seq: r.body.acked });
      }
    }
  }
  /** One sync: Alexandria's changes to the Mod. */
  async function sync() {
    const r = await bapi('/sync');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.pushes.length || r.body.items.length || r.body.rolls.length) toMod({ t: 'sync', config: r.body.config, pushes: r.body.pushes, items: r.body.items, rolls: r.body.rolls });
    return r.body;
  }
  async function hello() {
    const r = await bapi('/hello');
    assert.equal(r.status, 200);
    toMod({ t: 'hello', config: r.body.config });
    await carry();
  }
  return { sb, gm, pj, pt, jess, tom, gob, ctx, carry, sync, hello, toMod, bapi, inbox };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-roll20-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Rollhold', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Roll20_MarkerMap: conditions to markers and back, custom names, the rest left alone', () => {
  const map = markerMap({ Poisoned: 'skull', Prone: '', Hexed: 'purple' });
  assert.equal(map.Poisoned, 'skull');
  assert.equal(map.Prone, undefined);
  assert.equal(map.Hexed, 'purple');
  assert.deepEqual(markersFor(['poisoned', 'Inspired', 'Hexed'], map), ['skull', 'purple']);
  // Markers decide the conditions they map to; conditions with no marker stay; unknown markers are ignored.
  assert.deepEqual(conditionsFromMarkers(['Poisoned', 'Inspired'], ['blue', 'sleepy'], map), ['Inspired', 'Unconscious']);
  // A custom marker named like a condition counts.
  assert.deepEqual(conditionsFromMarkers([], ['Concentrating'], markerMap({ Concentrating: '' })), []);
  assert.deepEqual(conditionsFromMarkers([], ['Concentrating'], markerMap({})), ['Concentrating']);
});

test('Roll20_Keys: only the GM makes a key; a bad or replaced key is refused', async () => {
  assert.equal((await call('POST', `/api/worlds/${W}/roll20/key`, T.jess)).status, 403);
  assert.equal((await call('GET', `/api/worlds/${W}/roll20`, T.jess)).status, 403);
  const first = (await ok('POST', `/api/worlds/${W}/roll20/key`, T.dm)).key;
  assert.match(first, /^alx_r20_/);
  KEY = (await ok('POST', `/api/worlds/${W}/roll20/key`, T.dm)).key;
  assert.equal((await call('POST', '/api/roll20/bridge/sync', first, {})).status, 401);
  assert.equal((await call('POST', '/api/roll20/bridge/sync', 'alx_r20_nope', {})).status, 401);
  assert.equal((await call('POST', '/api/roll20/bridge/sync', T.dm, {})).status, 401, 'a GM session is not a bridge key');
  const st = await ok('GET', `/api/worlds/${W}/roll20`, T.dm);
  assert.equal(st.key.prefix, KEY.slice(0, 12));
  assert.equal(st.online, false);
});

test('Roll20_Sync: the Mod and Alexandria keep HP, conditions, rolls and handouts in step', async () => {
  const g = game();
  await g.hello();
  // The Mod said hello and listed the player characters (not the goblin); both were linked by character name.
  let st = await ok('GET', `/api/worlds/${W}/roll20`, T.dm);
  assert.equal(st.online, true);
  assert.equal(st.modVersion, '1.0.0');
  assert.deepEqual(st.links.map((l: any) => [l.name, l.accountId]), [['Jessamine', ID.jess], ['Tomas', ID.tom]]);
  // Alexandria had no HP yet, so Roll20's filled it in.
  let sheet = await ok('GET', `/api/worlds/${W}/sheet/${ID.jess}`, T.dm);
  assert.equal(sheet.hp, 30);
  assert.equal(sheet.maxHp, 30);
  await g.sync();

  // Damage in Roll20 → Alexandria's sheet (logged as Roll20), not sent back.
  g.sb.userSet(g.sb.attr(g.jess.ch.id, 'hp'), 'current', '21');
  await sleep(600);
  await g.carry();
  sheet = await ok('GET', `/api/worlds/${W}/sheet/${ID.jess}`, T.dm);
  assert.equal(sheet.hp, 21);
  const log = (await ok('GET', `/api/worlds/${W}/sheet/log?account=${ID.jess}`, T.dm)).log;
  assert.equal(log[0].source, 'roll20');
  assert.equal(log[0].after, 21);
  assert.deepEqual((await g.sync()).pushes, []);

  // Damage and a condition in Alexandria → the character's HP and every token's markers in Roll20.
  // (This game has a custom marker set with a Concentrating marker; the GM maps the condition to it.)
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { roll20Markers: { Concentrating: 'Concentrating' } });
  await ok('POST', `/api/worlds/${W}/sheet/${ID.jess}/vitals`, T.dm, { damage: 5, conditions: ['Poisoned', 'Inspired', 'Concentrating'] });
  const s1 = await g.sync();
  assert.deepEqual(s1.pushes, [{ id: g.jess.ch.id, name: 'Jessamine', hp: 16, markers: ['chemical-bolt', 'Concentrating'] }]);
  assert.equal(g.sb.attr(g.jess.ch.id, 'hp').get('current'), 16);
  // Custom marker set: the condition goes on as that marker's tag.
  assert.equal(g.jess.tok.get('statusmarkers'), 'chemical-bolt,Concentrating::4401');
  await sleep(500);
  assert.equal(g.inbox.length, 0, 'what the Mod applied is not reported back');
  assert.deepEqual((await g.sync()).pushes, []);

  // Markers changed in Roll20 → conditions (unmanaged markers ignored, conditions with no marker kept).
  g.sb.userSet(g.jess.tok, 'statusmarkers', 'Concentrating::4401,sleepy,blue@2');
  await sleep(600);
  await g.carry();
  sheet = await ok('GET', `/api/worlds/${W}/sheet/${ID.jess}`, T.dm);
  assert.deepEqual(sheet.conditions, ['Inspired', 'Concentrating', 'Unconscious']);
  assert.deepEqual((await g.sync()).pushes, []);

  // An unlinked token bar (no hp attribute link) counts too.
  g.sb.userSet(g.tom.tok, 'bar1_value', '9');
  await sleep(600);
  await g.carry();
  assert.equal((await ok('GET', `/api/worlds/${W}/sheet/${ID.tom}`, T.dm)).hp, 9);

  // A roll in Roll20 → the table chat, by the character's player, with the label and second roll.
  await ok('POST', `/api/worlds/${W}/sessionchat/sessions/start`, T.dm, { title: 'Roll20 night' });
  g.sb.say(g.pj.id, '&{template:default} {{name=Longsword}} {{attack=$[[0]]}} {{damage=$[[1]]}}', {
    who: 'Jessamine', rolltemplate: 'default',
    inlinerolls: [
      { expression: '1d20+5', results: { total: 17, rolls: [{ type: 'R', dice: 1, sides: 20, results: [{ v: 12 }] }, { type: 'M', expr: '+5' }] } },
      { expression: '1d8+3', results: { total: 7, rolls: [{ type: 'R', dice: 1, sides: 8, results: [{ v: 4 }] }] } },
    ],
  });
  // A whispered roll stays private.
  g.sb.say(g.pt.id, '/w gm [[1d20]]', { type: 'whisper', inlinerolls: [{ expression: '1d20', results: { total: 3, rolls: [{ type: 'R', results: [{ v: 3 }] }] } }] });
  await g.carry();
  let chat = (await ok('GET', `/api/worlds/${W}/sessionchat/chat/table`, T.tom)).messages;
  assert.equal(chat.length, 1);
  assert.equal(chat[0].authorId, ID.jess);
  assert.equal(chat[0].kind, 'roll');
  assert.equal(chat[0].roll.total, 17);
  assert.deepEqual(chat[0].roll.terms[0].dice, [12]);
  assert.match(chat[0].roll.note, /Longsword/);
  assert.match(chat[0].roll.note, /1d8\+3 = 7/);

  // Table chat rolls go to Roll20 when the GM turns that on; the one that came from Roll20 does not go back.
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { roll20RollsOut: true });
  await ok('POST', `/api/worlds/${W}/sessionchat/chat/table`, T.tom, { body: '/roll 1d20+2 perception' });
  const before = g.sb.chat.length;
  const s2 = await g.sync();
  assert.equal(s2.rolls.length, 1);
  assert.equal(s2.rolls[0].who, 'Tomas');
  const line = g.sb.chat.slice(before).find((m: any) => m.who === 'Alexandria' && m.type === 'general');
  assert.match(line.content, /Tomas rolls 1d20\+2/);
  await g.carry();
  chat = (await ok('GET', `/api/worlds/${W}/sessionchat/chat/table`, T.tom)).messages;
  assert.equal(chat.length, 2, 'the Mod does not report its own lines as rolls');
  assert.equal((await g.sync()).rolls.length, 0);

  // Handouts: players need the page's player copy; the GM copy goes to the GM notes.
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Handouts/Plot', markdown: '# Plot\nThe twist.' });
  const port = await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Places/Port', visibility: 'party', markdown: '# Port\nFish and [[Plot]].\n\n> [!secret]\n> Smugglers.\n' });
  assert.equal((await call('POST', `/api/worlds/${W}/roll20/handout`, T.dm, { page: 'Plot', players: true })).status, 409);
  assert.equal((await call('POST', `/api/worlds/${W}/roll20/handout`, T.jess, { page: port.id })).status, 403);
  await ok('POST', `/api/worlds/${W}/roll20/handout`, T.dm, { page: port.id, players: true });
  await ok('POST', `/api/worlds/${W}/roll20/say`, T.dm, { text: 'The bell tolls {{twice}}.', as: 'Town crier' });
  await g.sync();
  const ho = g.sb.api.findObjs({ _type: 'handout', name: 'Port' })[0];
  assert.ok(ho, 'handout made');
  assert.equal(ho.get('inplayerjournals'), 'all');
  assert.match(ho.get('notes'), /Fish and \(hidden\)/, 'the player copy does not name the GM-only page it links');
  assert.doesNotMatch(ho.get('notes'), /Smugglers/);
  assert.match(ho.get('gmnotes'), /Smugglers/);
  const crier = g.sb.chat.find((m: any) => m.who === 'Town crier');
  assert.ok(crier && !/\{\{/.test(crier.content), 'chat lines cannot run Roll20 templates');
  // Sent once.
  assert.deepEqual((await g.sync()).items, []);

  // Relinking a character pushes Alexandria's numbers to it.
  await ok('PUT', `/api/worlds/${W}/roll20/links/${g.tom.ch.id}`, T.dm, { accountId: null });
  assert.equal((await call('PUT', `/api/worlds/${W}/roll20/links/${g.tom.ch.id}`, T.dm, { accountId: ID.dm })).status, 400);
  await ok('PUT', `/api/worlds/${W}/roll20/links/${g.tom.ch.id}`, T.dm, { accountId: ID.tom });
  const s3 = await g.sync();
  assert.deepEqual(s3.pushes.map((p: any) => [p.name, p.hp]), [['Tomas', 9]]);

  // The same events sent twice (the bridge reloaded before the ack) apply once.
  const dupe = { instance: 'again', events: [{ seq: 1, t: 'vitals', id: g.jess.ch.id, name: 'Jessamine', hp: 12 }] };
  await g.bapi('/events', dupe);
  await ok('POST', `/api/worlds/${W}/sheet/${ID.jess}/vitals`, T.dm, { hp: 14 });
  await g.bapi('/events', dupe);
  assert.equal((await ok('GET', `/api/worlds/${W}/sheet/${ID.jess}`, T.dm)).hp, 14);

  st = await ok('GET', `/api/worlds/${W}/roll20`, T.dm);
  assert.ok(st.activity.some((a: any) => /Jessamine: HP 30 → 21/.test(a.text)), JSON.stringify(st.activity.slice(0, 5)));
  assert.ok(st.activity.some((a: any) => a.dir === 'out' && /Handout "Port"/.test(a.text)));
});

test('Roll20_Mod: GM-only commands, long messages in pieces, status', async () => {
  const g = game();
  await g.hello();
  // A player cannot speak for the bridge.
  g.sb.say(g.pj.id, `!alx-in x 1/1 ${enc({ t: 'sync', pushes: [{ id: g.jess.ch.id, hp: 1 }] })}`);
  assert.equal(g.sb.attr(g.jess.ch.id, 'hp').get('current'), '30');
  // A long sync in many pieces still lands.
  g.toMod({ t: 'sync', items: [{ kind: 'handout', name: 'Long', notes: '<p>' + 'é'.repeat(5000) + '</p>', gmnotes: '', players: false }] }, 700);
  const ho = g.sb.api.findObjs({ _type: 'handout', name: 'Long' })[0];
  assert.equal(ho.get('notes').length, 5007);
  assert.equal(ho.get('inplayerjournals'), '');
  g.sb.say(g.gm.id, '!alx status');
  assert.match(g.sb.chat[g.sb.chat.length - 1].content, /Alexandria 1\.0\.0: bridge online/);
});

test('Roll20_Modes: the bridge says which way the game runs; without the Mod there is no Mod version', async () => {
  await ok('POST', '/api/roll20/bridge/hello', KEY, { modVersion: '1.0.0', mode: 'mod' });
  let st = await ok('GET', `/api/worlds/${W}/roll20`, T.dm);
  assert.equal(st.mode, 'mod');
  assert.equal(st.modVersion, '1.0.0');
  await ok('POST', '/api/roll20/bridge/hello', KEY, { mode: 'free', campaign: 'No Pro game' });
  st = await ok('GET', `/api/worlds/${W}/roll20`, T.dm);
  assert.equal(st.mode, 'free');
  assert.equal(st.modVersion, null);
  assert.equal(st.campaign, 'No Pro game');
  // A hello that names no way keeps the last one.
  await ok('POST', '/api/roll20/bridge/hello', KEY, {});
  assert.equal((await ok('GET', `/api/worlds/${W}/roll20`, T.dm)).mode, 'free');
});
