// Session prep: the assistant drafts one note per player from that player's own brief, the GM edits it, and sending
// makes a kept private chat between the GM and that player. A draft is the GM's alone, and nothing the player may
// not see (a GM-only item note, another player's quest) is ever sent to the model or put in the draft.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const SECRET_ITEM = 'The lantern is the lich phylactery';
const TOM_QUEST = 'Betray the party at the crypt';

/** The fake Players model: every request it got, and it answers with a short prep built from the brief's first line. */
const fake = { chats: [] as any[], down: false };
const fakeFetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u === 'http://prep.test/v1/chat/completions') {
    if (fake.down) return new Response('down', { status: 503 });
    const body = JSON.parse(init.body);
    fake.chats.push(body);
    const who = /The player's character: ([^.]+)\./.exec(body.messages.at(-1).content)?.[1] ?? 'friend';
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `**Last time**\n- ${who} reached the lighthouse.\n\n**To think about**\nWho lit the lamp?` }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fetch(url, init);
}) as typeof fetch;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: any = null;
  try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const api = (p: string) => `/api/worlds/${W}${p}`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-prep-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_PLAYER_URL: 'http://prep.test/v1', ALX_MODEL_PLAYER_MODEL: 'small-1' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gmId = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  ID.gm = gmId;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Prepland', gmAccountId: gmId })).id;
  for (const [name, character] of [['jess', 'Jessamine'], ['tom', 'Tomas']]) {
    const inv = await ok('POST', api('/invites'), T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: character });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  await ok('POST', api('/inventory'), T.gm, { owner: ID.jess, name: 'Brass lantern', qty: 1, note: 'Hums near water', gmNote: SECRET_ITEM, reason: 'Found' });
  await ok('POST', api(`/sheet/${ID.jess}/gm-notes`), T.gm, { kind: 'goal', text: 'Ask the keeper about the lamp.' });
  await ok('POST', api(`/sheet/${ID.tom}/gm-notes`), T.gm, { kind: 'goal', text: TOM_QUEST });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestPrep_EachPlayerGetsADraftFromTheirOwnBrief', async () => {
  fake.chats = [];
  const r = await ok('POST', api('/prep'), T.gm, { note: 'We start in the crypt.' });
  assert.equal(r.preps.length, 2, 'one draft per player');
  const jess = r.preps.find((p: any) => p.accountId === ID.jess);
  assert.equal(jess.status, 'draft');
  assert.ok(jess.byModel);
  assert.match(jess.text, /Jessamine reached the lighthouse/);
  assert.match(jess.text, /\*\*From the GM:\*\* We start in the crypt\./);
  const jessReq = fake.chats.find((c) => /Jessamine/.test(c.messages.at(-1).content));
  const sent = JSON.stringify(jessReq);
  assert.match(sent, /Brass lantern/);
  assert.match(sent, /Ask the keeper about the lamp/, "the player's own quest is in the brief");
  for (const c of fake.chats) {
    const s = JSON.stringify(c);
    assert.ok(!s.includes(SECRET_ITEM), 'a GM-only item note never reaches the model');
  }
  assert.ok(!sent.includes(TOM_QUEST), "another player's quest is not in Jessamine's request");
});

test('TestPrep_ADraftIsTheGmsAloneUntilSent', async () => {
  await ok('POST', api('/prep'), T.gm, { accountIds: [ID.jess] });
  assert.equal((await ok('GET', api('/prep'), T.jess)).preps.length, 0, 'the player sees no draft');
  assert.equal((await call('POST', api('/prep'), T.jess, {})).status, 403);
  assert.equal((await call('POST', api('/prep/send'), T.jess, {})).status, 403);
  const drafts = (await ok('GET', api('/prep'), T.gm)).preps.filter((p: any) => p.status === 'draft');
  assert.equal(drafts.filter((p: any) => p.accountId === ID.jess).length, 1, 'a new draft replaces the older one');
});

test('TestPrep_SendingMakesAKeptPrivateChat', async () => {
  const draft = (await ok('POST', api('/prep'), T.gm, { accountIds: ['Jessamine'] })).preps[0];
  const edited = await ok('PATCH', api(`/prep/${draft.id}`), T.gm, { text: 'See you Friday at the crypt, Jessamine.' });
  assert.equal(edited.text, 'See you Friday at the crypt, Jessamine.');
  const s = await ok('POST', api('/prep/send'), T.gm, { ids: [draft.id] });
  assert.equal(s.sent.length, 1);
  const tid = s.sent[0].threadId;
  const jessThreads = await ok('GET', api('/messages'), T.jess);
  const t = jessThreads.find((x: any) => x.id === tid);
  assert.ok(t, 'Jessamine has the chat');
  assert.equal(t.kept, true);
  assert.deepEqual([...t.members].sort(), [ID.gm, ID.jess].sort());
  assert.equal(t.last, 'See you Friday at the crypt, Jessamine.');
  assert.ok(!(await ok('GET', api('/messages'), T.tom)).some((x: any) => x.id === tid), 'Tomas does not see it');
  assert.equal((await call('PATCH', api(`/prep/${draft.id}`), T.gm, { text: 'x' })).status, 409, 'a sent prep cannot be edited');
  const mine = (await ok('GET', api('/prep'), T.jess)).preps;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'sent');
});

test('TestPrep_NoModelStillGivesADraftFromTheBrief', async () => {
  fake.down = true;
  try {
    const p = (await ok('POST', api('/prep'), T.gm, { accountIds: [ID.tom] })).preps[0];
    assert.equal(p.byModel, false);
    assert.match(p.text, /Healing|Betray|Character/, 'the brief parts are there to edit');
  } finally { fake.down = false; }
});

test('TestPrep_ToolsAreGmOnlyAndSendingNeedsApproval', () => {
  const tools = toolsFor(false);
  for (const n of ['draft_session_prep', 'list_session_prep']) assert.ok(tools.find((t) => t.name === n)?.gmOnly, `${n} is GM-only`);
  for (const n of ['edit_session_prep', 'send_session_prep']) assert.ok(toolsFor(true).find((t) => t.name === n)?.write, `${n} needs approval`);
});
