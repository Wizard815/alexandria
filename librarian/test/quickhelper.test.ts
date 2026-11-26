// The players' quick helper: a small second model ('helper' job) that answers
// from a short brief rebuilt on every call, and hands harder questions to the
// broker or the table helper.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { parseHandoff, routeFirst, stripThinking, briefBudget, groundAnswer } from '../src/features/playerhelp/quick.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const Q = () => `/api/worlds/${W}/helper/quick`;

// The fake small model: records every request and answers with `reply`.
const sent: any[] = [];
let reply = 'Dodge: attacks against you have disadvantage until your next turn.';
let down = false;
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  if (!u.startsWith('http://helper.invalid/')) return fetch(url, init);
  if (down) throw new TypeError('fetch failed');
  const body = JSON.parse(String(init?.body ?? '{}'));
  sent.push({ url: u, body });
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-quick-'));
  const made = createApp({
    noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fake,
    env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_HELPER_URL: 'http://helper.invalid/v1', ALX_MODEL_HELPER_MODEL: 'bonsai-tiny', ALX_MODEL_HELPER_OPTIONS: '{"contextTokens":4096}' },
  });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Quickland', dmAccountId: ID.dm })).id;
  for (const [name, ch] of [['jess', 'Brindle'], ['tom', 'Oskar']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: ch });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: '# Saltmarsh\nSaltmarsh is a fishing town ruled by a council of seven captains.\n\n> [!secret] DM\n> The council answers to the smuggler queen Velmira.\n' });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Velmira', visibility: 'dm', markdown: '# Velmira\nVelmira keeps her treasury beneath the lighthouse in Saltmarsh.\n' });
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Rope of climbing', qty: 1, reason: 'Loot' });
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.tom, name: 'Wand of secrets', qty: 1, reason: 'Found it' });
});

after(async () => {
  server?.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
});

const last = () => sent[sent.length - 1];
const userText = (req: any) => String(req.body.messages.find((m: any) => m.role === 'user')?.content ?? '');

test('TestQuickHelper_StatusNamesTheSmallModel', async () => {
  const s = await ok('GET', Q(), T.jess);
  assert.equal(s.on, true);
  assert.equal(s.model, 'bonsai-tiny');
  assert.equal(s.own, true);
});

test('TestQuickHelper_RulesAnswerFromAFreshShortBrief', async () => {
  sent.length = 0;
  const r = await ok('POST', Q(), T.jess, { task: 'rules', question: 'What does the Dodge action do?' });
  assert.match(r.answer, /disadvantage/);
  assert.equal(r.handoff, null);
  assert.equal(r.model, 'bonsai-tiny');
  assert.equal(sent.length, 1, 'one call to the small model');
  const req = last();
  assert.equal(req.body.model, 'bonsai-tiny');
  assert.equal(req.body.messages.length, 2, 'no history: a system prompt and one brief');
  const u = userText(req);
  assert.match(u, /Brindle/, 'the brief names the character');
  assert.match(u, /Rope of climbing/, 'and their items');
  assert.match(u, /## Rules passages[\s\S]*Dodge/, 'and the rule from the module');
  assert.ok(!/Wand of secrets/.test(u), "another player's items stay out");
  assert.ok(u.length < briefBudget(deps) + 1500, 'the brief stays inside the budget');
  // A second call starts from scratch again.
  await ok('POST', Q(), T.jess, { task: 'rules', question: 'What does the Dodge action do?' });
  assert.equal(last().body.messages.length, 2);
});

test('TestQuickHelper_BriefHasOnlyWhatThePlayerMaySee', async () => {
  sent.length = 0;
  reply = 'Saltmarsh is ruled by seven captains.';
  await ok('POST', Q(), T.jess, { task: 'ask', question: 'Is Saltmarsh near Velmira a good place to rest?' });
  const u = userText(last());
  assert.match(u, /seven captains/, 'a party page is used');
  assert.ok(!/smuggler queen|treasury|lighthouse/i.test(u), 'DM-only text never reaches the small model');
  const b = await ok('GET', `${Q()}/brief?task=ask&q=${encodeURIComponent('Saltmarsh')}`, T.jess);
  assert.ok(b.sections.some((s: any) => s.label === 'Library (shared with the party)'));
  assert.ok(b.lore.some((l: any) => l.title === 'Saltmarsh'));
  // The DM can look at what a player's helper is given, as that player sees it.
  const dmView = await ok('GET', `${Q()}/brief?task=sheet&account=${ID.tom}`, T.dm);
  assert.match(JSON.stringify(dmView.sections), /Wand of secrets/);
  assert.equal((await call('GET', `${Q()}/brief?task=sheet`, T.dm)).status, 400);
});

test('TestQuickHelper_ModelHandoffGoesToTheBroker', async () => {
  reply = 'HANDOFF broker: the Blackthorn Syndicate.';
  const r = await ok('POST', Q(), T.jess, { task: 'ask', question: 'Can I trust the harbour folk?' });
  assert.ok(!/Blackthorn/.test(r.handoff.reason));
  assert.equal(r.answer, '');
  assert.equal(r.handoff.to, 'broker');
  assert.equal(r.handoff.question, 'Can I trust the harbour folk?');
  sent.length = 0;
  const who = await ok('POST', Q(), T.jess, { task: 'ask', question: 'Who rules the harbour?' });
  assert.equal(who.handoff.to, 'broker');
  assert.equal(sent.length, 0, 'who/why questions go straight to the broker');
  reply = 'Silas Blackwood runs the docks.';
  const made = await ok('POST', Q(), T.jess, { task: 'ask', question: 'Is the harbour safe tonight?' });
  assert.equal(made.answer, '', 'an answer built on a made-up name is not shown');
  assert.equal(made.handoff.to, 'broker');
});

test('TestQuickHelper_HardQuestionsSkipTheSmallModel', async () => {
  sent.length = 0;
  const w = await ok('POST', Q(), T.jess, { task: 'ask', question: 'Write my backstory as a long poem' });
  assert.equal(w.handoff.to, 'helper');
  const c = await ok('POST', Q(), T.jess, { task: 'ask', question: 'Add a healing potion to my inventory' });
  assert.equal(c.handoff.to, 'helper');
  const long = await ok('POST', Q(), T.jess, { task: 'ask', question: 'x '.repeat(300) });
  assert.equal(long.handoff.to, 'helper');
  assert.equal(sent.length, 0, 'none of these asked the model');
});

test('TestQuickHelper_TurnOptionsSeeTheCombat', async () => {
  reply = '- Attack the goblin\n- Dodge';
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Goblin', initiative: 5, hp: 7, maxHp: 7 });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Brindle', accountId: ID.jess, initiative: 15, hp: 12, maxHp: 12 });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true, round: 2, turn: 0 });
  const r = await ok('POST', Q(), T.jess, { task: 'turn' });
  assert.match(r.answer, /Attack/);
  const u = userText(last());
  assert.match(u, /Combat is on, round 2/);
  assert.match(u, /HP: 12 of 12 \(combat tracker\)/, 'their own HP from the tracker when there is no sheet');
  assert.match(u, /Question: What can I do on my turn\?/);
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: false });
});

test('TestQuickHelper_ModelDownHandsOff', async () => {
  down = true;
  try {
    const r = await ok('POST', Q(), T.jess, { task: 'sheet' });
    assert.equal(r.handoff.to, 'helper');
    assert.match(r.handoff.reason, /not answering/);
  } finally { down = false; }
});

test('TestQuickHelper_OnlyPlayersAndTheDMCanTurnItOff', async () => {
  assert.equal((await call('POST', Q(), T.dm, { task: 'ask', question: 'hi' })).status, 403);
  assert.equal((await call('POST', Q(), T.jess, { task: 'nope' })).status, 400);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { quickHelper: false });
  assert.equal((await call('POST', Q(), T.jess, { task: 'sheet' })).status, 403);
  assert.equal((await ok('GET', Q(), T.jess)).on, false);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { quickHelper: true });
  void run;
});

test('TestQuickHelper_Helpers', () => {
  assert.equal(parseHandoff('HANDOFF helper: needs tools')?.to, 'helper');
  const mid = parseHandoff('No rule lets you hide in plain sight. HANDOFF broker: the Blackthorn Syndicate rules it');
  assert.equal(mid?.answer, 'No rule lets you hide in plain sight.');
  assert.ok(!/Blackthorn/.test(mid!.reason), "the model's own reason is never shown");
  const g = groundAnswer('- Attack the Smuggler captain\n- Ask Silas Blackwood for help', 'Combatants: Smuggler captain, Brindle');
  assert.equal(g.text, '- Attack the Smuggler captain');
  assert.ok(g.dropped.some((n) => n.includes('Silas Blackwood')));
  assert.equal(parseHandoff('Use your bonus action.'), null);
  assert.equal(stripThinking('<think>hmm</think> Dodge.'), 'Dodge.');
  const empty = { sections: [], text: '', chars: 0, lore: [] };
  assert.equal(routeFirst('ask', 'Who is the baron?', empty)?.to, 'broker', 'in-world questions go to the broker');
  assert.equal(routeFirst('ask', 'Who is the baron?', { ...empty, lore: [{ id: 'p', title: 'Baron' }] })?.to, 'broker', 'even with a library match');
  assert.equal(routeFirst('ask', 'Is my rope long enough to climb down?', empty), null);
  assert.equal(routeFirst('turn', 'What can I do on my turn?', empty), null);
});

test('TestQuickHelper_UnsetUsesThePlayersModel', async () => {
  const keep = { ...deps.env };
  try {
    delete deps.env.ALX_MODEL_HELPER_URL;
    delete deps.env.ALX_MODEL_HELPER_MODEL;
    deps.env.ALX_MODEL_PLAYER_URL = 'http://helper.invalid/v1';
    deps.env.ALX_MODEL_PLAYER_MODEL = 'players-model';
    const s = await ok('GET', Q(), T.jess);
    assert.equal(s.own, false);
    assert.equal(s.model, 'players-model');
    reply = 'You are fine.';
    await ok('POST', Q(), T.jess, { task: 'sheet' });
    assert.equal(last().body.model, 'players-model');
  } finally {
    for (const k of Object.keys(deps.env)) delete deps.env[k];
    Object.assign(deps.env, keep);
  }
});
