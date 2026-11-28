// NPC voices: with npcVoices on, what an encounter NPC says is read aloud to that player only (a private talk is not
// heard by the rest of the party), in the NPC's own preset or the default NPC voice, and each line once. A quick
// event's prompt is read to the players it went to when a quick event voice is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';
import { toneWav, listen, wait, baseOf } from './soundTone.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const tts: any[] = [];
const api = (p: string) => `/api/worlds/${W}${p}`;

const fakeFetch: typeof fetch = async (input: any, init: any = {}) => {
  const u = String(input);
  if (u === 'http://tts.test/v1/audio/speech') {
    tts.push(JSON.parse(init.body));
    return new Response(new Uint8Array(toneWav(0.1)), { headers: { 'content-type': 'audio/wav' } });
  }
  throw new Error(`unexpected fetch ${u}`);
};

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
/** Wait until the fake voice model has had n requests. */
async function spoken(n: number) {
  for (let i = 0; i < 50 && tts.length < n; i++) await wait(20);
  await wait(60);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-npcvoice-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_MODEL_VOICE_URL: 'http://tts.test/v1', ALX_MODEL_VOICE_MODEL: 'kokoro', ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = baseOf(server);
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Voiceland', gmAccountId: ID.gm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', api('/invites'), T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
    await ok('PUT', api('/sound/me/switches'), j.token, { device: `${name}-phone-1`, sfx: true });
  }
  await ok('POST', api('/voice/presets'), T.gm, { name: 'Gravel', voice: 'bm_george', speed: 0.9, target: 'table' });
  await ok('POST', api('/voice/presets'), T.gm, { name: 'Sprite', voice: 'af_sky', speed: 1.2, target: 'table' });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestNpcVoice_OffByDefaultNothingIsSpoken', async () => {
  const before = tts.length;
  await ok('POST', api('/encounters'), T.gm, { accountIds: [ID.jess], npcName: 'Old Bram', line: 'Spare a coin?', answers: ['No'] });
  await wait(150);
  assert.equal(tts.length, before);
  const s = await ok('GET', api('/voice/npcs'), T.gm);
  assert.equal(s.npcVoices, false);
});

test('TestNpcVoice_AnNpcSpeaksToThatPlayerOnly', async () => {
  await ok('PATCH', api('/settings'), T.gm, { npcVoices: true, npcVoicePreset: 'Sprite' });
  await ok('PUT', api('/voice/npcs'), T.gm, { npc: 'Captain Vex', preset: 'gravel' });
  assert.equal((await call('PUT', api('/voice/npcs'), T.gm, { npc: 'Nobody', preset: 'No such voice' })).status, 404);
  const jess = await listen(base, W, T.jess);
  const tom = await listen(base, W, T.tom);
  const gm = await listen(base, W, T.gm);
  await wait();
  const n = tts.length;
  const [e] = await ok('POST', api('/encounters'), T.gm, { accountIds: [ID.jess], npcName: 'Captain Vex', line: 'You there. You owe me passage money.', answers: ['Pay', 'Run'] });
  await spoken(n + 1);
  assert.equal(tts.length, n + 1);
  assert.match(tts.at(-1).input, /You owe me passage money/);
  assert.equal(tts.at(-1).voice, 'bm_george', "the NPC's own preset");
  const jessSound = jess.events.filter((x) => x.type === 'sound');
  assert.equal(jessSound.length, 1, 'the player in the talk hears it');
  assert.equal(jessSound[0].data.label, 'Captain Vex');
  assert.equal(tom.events.filter((x) => x.type === 'sound').length, 0, 'the rest of the party does not');
  assert.equal(gm.events.filter((x) => x.type === 'sound').at(-1)?.data.target, 'players', 'not played at the table');
  const file = jessSound[0].data.url.split('/').pop();
  assert.equal((await call('GET', api(`/voice/file/${file}`), T.jess)).status, 200);
  assert.equal((await call('GET', api(`/voice/file/${file}`), T.tom)).status, 404, 'another player cannot fetch it');
  assert.equal((await call('GET', api(`/voice/file/${file}/ticket`), T.tom)).status, 404);
  // The GM speaks live as the NPC: only the new line is read.
  await ok('POST', api(`/encounters/${e.id}/say`), T.gm, { text: 'Last chance, sailor.', answers: ['Fine'] });
  await spoken(n + 2);
  assert.equal(tts.length, n + 2);
  assert.equal(tts.at(-1).input, 'Last chance, sailor.');
  // The player answering adds no NPC line here, so nothing new is spoken twice.
  await ok('POST', api(`/encounters/${e.id}/end`), T.gm, {});
  await wait(150);
  assert.equal(tts.length, n + 2);
  jess.stop(); tom.stop(); gm.stop();
});

test('TestNpcVoice_DefaultVoiceForOtherNpcs', async () => {
  const n = tts.length;
  await ok('POST', api('/encounters'), T.gm, { accountIds: [ID.tom], npcName: 'A street urchin', line: 'Psst. Want to buy a map?', answers: ['Sure'] });
  await spoken(n + 1);
  assert.equal(tts.at(-1).voice, 'af_sky');
});

test('TestNpcVoice_QuickEventPromptToItsAudience', async () => {
  await ok('PATCH', api('/settings'), T.gm, { quickEventVoicePreset: 'Gravel' });
  const jess = await listen(base, W, T.jess);
  const tom = await listen(base, W, T.tom);
  await wait();
  const n = tts.length;
  const ev = await ok('POST', api('/quick-events'), T.gm, { kind: 'recall', title: 'The old song', prompt: 'Do you remember how it ends?', audience: [ID.tom] });
  await spoken(n + 1);
  assert.equal(tts.length, n + 1);
  assert.equal(tts.at(-1).input, 'The old song. Do you remember how it ends?');
  assert.equal(tom.events.filter((x) => x.type === 'sound').length, 1);
  assert.equal(jess.events.filter((x) => x.type === 'sound').length, 0);
  await ok('POST', api(`/quick-events/${ev.id}/cancel`), T.gm, {}).catch(() => undefined);
  await wait(150);
  assert.equal(tts.length, n + 1, 'spoken once');
  jess.stop(); tom.stop();
});

test('TestNpcVoice_ToolsAndPlayerAccess', async () => {
  assert.ok(toolsFor(false).find((t) => t.name === 'list_npc_voices')?.gmOnly);
  assert.ok(toolsFor(true).find((t) => t.name === 'set_npc_voice')?.write);
  assert.equal((await call('GET', api('/voice/npcs'), T.jess)).status, 403);
  assert.equal((await call('PUT', api('/voice/npcs'), T.jess, { npc: 'x', preset: 'Gravel' })).status, 403);
  const list = await ok('GET', api('/voice/npcs'), T.gm);
  assert.deepEqual(list.npcs.map((x: any) => [x.npc, x.preset]), [['Captain Vex', 'Gravel']]);
  await ok('PUT', api('/voice/npcs'), T.gm, { npc: 'captain vex', preset: '' });
  assert.equal((await ok('GET', api('/voice/npcs'), T.gm)).npcs.length, 0);
});
