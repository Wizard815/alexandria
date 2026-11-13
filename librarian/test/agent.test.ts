// The DM agent and the player harness: tools over loopback with the caller's
// own token, pending writes the DM confirms, the leak check, combat tools and
// statblocks. The chat model is an in-test fake fetch (never a real model).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, run } from '../src/core/db.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';

const SECRET = 'Velmira the smuggler queen keeps her treasury beneath the lighthouse';
const DM_LINE = 'The vault code is seven seven three nine and nobody must learn it yet';
const OPEN_LINE = 'We arrive at the harbour of Saltmarsh as the evening bells ring';

type Handler = (req: any) => any;
interface Env { base: string; server: any; deps: any; T: Record<string, string>; ID: Record<string, string>; W: string; model: { queue: Handler[]; seen: any[] }; call: (m: string, u: string, t?: string, b?: unknown) => Promise<{ status: number; body: any }>; ok: (m: string, u: string, t?: string, b?: unknown) => Promise<any>; }
const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

async function boot(withModel: boolean): Promise<Env> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-agent-'));
  const model = { queue: [] as Handler[], seen: [] as any[] };
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('http://fake.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      model.seen.push(body);
      const h = model.queue.shift();
      if (!h) return new Response('no scripted reply', { status: 500 });
      const message = h(body);
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, init);
  }) as typeof fetch;
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ...(withModel ? { ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake' } : {}) }, fetch: fake });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  const ID: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Agentland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  const page = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown });
  const saltmarsh = await page('places/Saltmarsh', 'party', `# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council of seven captains.\n\n> [!secret] DM\n> The harbour council secretly answers to the smuggler queen Velmira.\n`);
  const velmira = await page('dm/Velmira', 'dm', `# Velmira\n${SECRET}.\n`);
  // A session with one line for everyone and one DM-only aside.
  run(made.deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?, ?, ?, ?)', 'as_1', W, 'Session 1', new Date().toISOString());
  run(made.deps.db, `INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES ('ln_1', 'as_1', ?, 0, 1000, 'Narrator', ?, 'players', ?)`, W, OPEN_LINE, new Date().toISOString());
  run(made.deps.db, `INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES ('ln_2', 'as_1', ?, 2000, 3000, 'Whisper', ?, 'dm', ?)`, W, DM_LINE, new Date().toISOString());
  ID.saltmarsh = saltmarsh.id;
  ID.velmira = velmira.id;
  return { base, server, deps: made.deps, T, ID, W, model, call, ok };
}

const toolCall = (name: string, args: unknown, id = `call_${name}`) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const say = (content: string) => ({ role: 'assistant', content });

/** Post a message and wait for the reply. */
async function ask(e: Env, token: string, text: string, extra: Record<string, unknown> = {}, chatId?: string) {
  const id = chatId ?? (await e.ok('POST', `/api/worlds/${e.W}/agent/chats`, token, {})).id;
  await e.ok('POST', `/api/worlds/${e.W}/agent/chats/${id}/messages`, token, { text, ...extra });
  for (let i = 0; i < 200; i++) {
    const c = await e.ok('GET', `/api/worlds/${e.W}/agent/chats/${id}`, token);
    if (!c.busy) return { id, chat: c, reply: c.messages.filter((m: any) => m.role === 'assistant' && m.status !== 'working').at(-1) };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the agent never finished');
}
const toolNames = (req: any) => (req.tools ?? []).map((t: any) => t.function.name);
const A = (e: Env) => `/api/worlds/${e.W}/agent`;

const env = await boot(true);
const bare = await boot(false);

test('Agent: the DM harness runs a read tool and answers with a citation', async () => {
  const e = env;
  e.model.seen.length = 0;
  e.model.queue.push(() => toolCall('read_page', { page: e.ID.velmira }), () => say('Velmira keeps her treasury under the lighthouse (dm/Velmira).'));
  const { reply, chat } = await ask(e, e.T.dm, 'Where is the smuggler treasury?');
  assert.equal(reply.status, 'done');
  assert.match(reply.text, /lighthouse/);
  assert.ok(reply.citations.some((c: any) => c.kind === 'page' && c.id === e.ID.velmira && c.path === 'dm/Velmira.md'), JSON.stringify(reply.citations));
  // The DM harness lists every tool, writes included; the DM transcript line is in its context.
  assert.ok(toolNames(e.model.seen[0]).includes('save_page') && toolNames(e.model.seen[0]).includes('add_combatant'));
  assert.ok(e.model.seen[0].messages[0].content.includes(DM_LINE));
  // The tool result the model got is the DM copy of the page.
  assert.ok(e.model.seen[1].messages.some((m: any) => m.role === 'tool' && m.content.includes(SECRET)));
  assert.equal(chat.actions.length, 0);
  assert.ok(all<any>(e.deps.db, `SELECT * FROM audit WHERE world_id = ? AND action = 'agent.read'`, e.W).length >= 1);
});

test('Agent: it answers from the transcript with a citation', async () => {
  const e = env;
  e.model.queue.push(() => toolCall('search_transcript', { query: 'harbour' }), () => say('You arrived at the harbour as the evening bells rang.'));
  const { reply } = await ask(e, e.T.dm, 'What happened when we arrived?');
  assert.ok(reply.citations.some((c: any) => c.kind === 'transcript' && c.id === 'ln_1' && c.snippet.includes('harbour')), JSON.stringify(reply.citations));
});

test('Agent: a write tool becomes a pending action and runs only after approval', async () => {
  const e = env;
  e.model.queue.push(() => toolCall('add_combatant', { name: 'Goblin Boss', hp: 52, initiative: 14 }), () => say('I proposed adding the Goblin Boss.'));
  const { chat } = await ask(e, e.T.dm, 'Add a goblin boss with 52 HP');
  assert.equal(chat.actions.length, 1);
  const act = chat.actions[0];
  assert.equal(act.status, 'pending');
  assert.equal(act.summary, 'Add Goblin Boss to combat with 52 HP, initiative 14');
  assert.equal(act.tool, 'add_combatant');
  assert.deepEqual(act.call, { method: 'POST', path: '/live/combatants', body: { name: 'Goblin Boss', initiative: 14, hp: 52, maxHp: 52 } });
  // Nothing happened yet.
  assert.equal((await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants.length, 0);
  assert.equal((await e.ok('GET', `${A(e)}/actions`, e.T.dm)).actions.length, 1);
  // A player cannot decide it.
  assert.equal((await e.call('POST', `${A(e)}/actions/${act.id}`, e.T.jess, { decision: 'approve' })).status, 403);
  const done = await e.ok('POST', `${A(e)}/actions/${act.id}`, e.T.dm, { decision: 'approve' });
  assert.equal(done.status, 'done');
  const combat = await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm);
  assert.equal(combat.combatants.length, 1);
  assert.equal(combat.combatants[0].name, 'Goblin Boss');
  assert.equal(combat.combatants[0].hp, 52);
  // It cannot run twice.
  assert.equal((await e.call('POST', `${A(e)}/actions/${act.id}`, e.T.dm, { decision: 'approve' })).status, 409);
  assert.equal((await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants.length, 1);
  const log = all<any>(e.deps.db, `SELECT action, detail FROM audit WHERE world_id = ? AND action LIKE 'agent.%'`, e.W);
  assert.ok(log.some((l) => l.action === 'agent.propose' && l.detail.includes('add_combatant')));
  assert.ok(log.some((l) => l.action === 'agent.action' && l.detail.includes('add_combatant') && l.detail.includes('done')));
  const after = await e.ok('GET', `${A(e)}/chats/${chat.id}`, e.T.dm);
  assert.ok(after.messages.some((m: any) => m.text.startsWith('Done: Add Goblin Boss')));
});

test('Agent: a rejected action never runs', async () => {
  const e = env;
  e.model.queue.push(() => toolCall('add_item', { owner: 'party', name: 'Cursed Ring' }), () => say('Proposed.'));
  const { chat } = await ask(e, e.T.dm, 'Give the party a ring');
  const rej = await e.ok('POST', `${A(e)}/actions/${chat.actions[0].id}`, e.T.dm, { decision: 'reject' });
  assert.equal(rej.status, 'rejected');
  const inv = await e.ok('GET', `/api/worlds/${e.W}/inventory?owner=party`, e.T.dm);
  assert.ok(!inv.items.some((i: any) => i.name === 'Cursed Ring'));
});

test('Agent: tool names set to auto-approve run at once, and are audited', async () => {
  const e = env;
  assert.equal((await e.call('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentAutoApprove: 'next_turn' })).status, 400);
  await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentAutoApprove: ['next_turn'] });
  e.model.queue.push(() => toolCall('next_turn', {}), () => say('Next turn.'));
  const { chat } = await ask(e, e.T.dm, 'next turn');
  assert.equal(chat.actions.length, 0);
  const now = await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm);
  assert.ok(now.active);
  assert.ok(all<any>(e.deps.db, `SELECT detail FROM audit WHERE world_id = ? AND action = 'agent.action' AND detail LIKE 'next_turn%auto-approved%'`, e.W).length === 1);
  await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentAutoApprove: [] });
});

test('Agent: at most 8 tool rounds, then a final reply without tools', async () => {
  const e = env;
  e.model.seen.length = 0;
  for (let i = 0; i < 8; i++) e.model.queue.push(() => toolCall('world_info', {}, `c${i}`));
  e.model.queue.push(() => say('Here is what I found.'));
  const { reply } = await ask(e, e.T.dm, 'Keep looking');
  assert.equal(reply.text, 'Here is what I found.');
  assert.equal(e.model.seen.length, 9);
  assert.equal(e.model.seen[8].tools, undefined);
});

test('Agent: the player harness never lists or calls write tools', async () => {
  const e = env;
  e.model.seen.length = 0;
  const writeNames = toolsFor(true).filter((t) => t.write).map((t) => t.name);
  assert.ok(writeNames.includes('add_combatant') && writeNames.includes('make_statblock') && writeNames.includes('save_page'));
  e.model.queue.push(() => toolCall('save_page', { path: 'people/Hacked', markdown: '# Hacked' }), () => toolCall('add_combatant', { name: 'Sneak', hp: 1, initiative: 20 }, 'c2'), () => say('I cannot change anything.'));
  const { reply } = await ask(e, e.T.jess, 'Please save a page and add a monster');
  assert.equal(reply.status, 'done');
  const listed = toolNames(e.model.seen[0]);
  assert.ok(listed.length > 5);
  for (const w of writeNames) assert.ok(!listed.includes(w), `${w} listed to a player`);
  // The refused calls did nothing: no page, no combatant, no pending action.
  assert.equal((await e.call('GET', `/api/worlds/${e.W}/library/pages/people%2FHacked`, e.T.dm)).status, 404);
  assert.ok(!(await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants.some((c: any) => c.name === 'Sneak'));
  assert.equal(all(e.deps.db, `SELECT 1 FROM agent_actions WHERE tool IN ('save_page') AND world_id = ?`, e.W).length, 0);
  assert.ok(e.model.seen[1].messages.some((m: any) => m.role === 'tool' && /Unknown tool/.test(m.content)));
});

test('Agent: a player never gets DM text in the model input or in a tool result', async () => {
  const e = env;
  e.model.seen.length = 0;
  e.model.queue.push(() => toolCall('read_page', { page: e.ID.velmira }), () => toolCall('search_library', { query: 'smuggler queen Velmira' }, 'c2'), () => toolCall('read_page', { page: e.ID.saltmarsh }, 'c3'), () => toolCall('search_transcript', { query: 'vault code' }, 'c4'), () => say('I do not know about that.'));
  const { reply } = await ask(e, e.T.jess, 'Who is the smuggler queen Velmira?');
  assert.equal(reply.text, 'I do not know about that.');
  const everything = JSON.stringify(e.model.seen.map((r) => r.messages));
  for (const secret of ['treasury beneath the lighthouse', 'secretly answers', DM_LINE, 'seven seven three nine']) assert.ok(!everything.includes(secret), `the model input held DM text: ${secret}`);
  // It did get what a player may read.
  assert.ok(everything.includes('fishing town ruled by the harbour council'));
  assert.ok(everything.includes(OPEN_LINE));
  // The DM-only page was a 404 to the player's own token.
  assert.ok(e.model.seen[1].messages.some((m: any) => m.role === 'tool' && /Error 404/.test(m.content)));
  assert.deepEqual(reply.citations.map((c: any) => c.id).filter((id: string) => id === e.ID.velmira), []);
});

test('Agent: the leak check blocks a player reply that echoes DM-only text', async () => {
  const e = env;
  e.model.queue.push(() => say(`Well, ${SECRET}, so I hear.`));
  const { reply } = await ask(e, e.T.jess, 'Tell me something secret');
  assert.equal(reply.text, "I can't answer that from what you know.");
  assert.deepEqual(reply.citations, []);
  const leaks = await e.ok('GET', `${A(e)}/leaks`, e.T.dm);
  assert.equal(leaks.leaks.length, 1);
  assert.equal(leaks.leaks[0].accountId, e.ID.jess);
  assert.equal((await e.call('GET', `${A(e)}/leaks`, e.T.jess)).status, 403);
  assert.ok(all(e.deps.db, `SELECT 1 FROM audit WHERE world_id = ? AND action = 'agent.leak_blocked'`, e.W).length === 1);
  // A DM-only transcript line is blocked too, and a secret block in a shared page.
  e.model.queue.push(() => say(`They whispered: ${DM_LINE}.`));
  assert.equal((await ask(e, e.T.jess, 'What was whispered?')).reply.text, "I can't answer that from what you know.");
  e.model.queue.push(() => say('The harbour council secretly answers to the smuggler queen Velmira, they say.'));
  assert.equal((await ask(e, e.T.jess, 'Who runs the council?')).reply.text, "I can't answer that from what you know.");
  // Ordinary answers pass, and so does what the player wrote themselves.
  e.model.queue.push(() => say('Saltmarsh is a fishing town ruled by the harbour council of seven captains.'));
  assert.match((await ask(e, e.T.jess, 'What is Saltmarsh?')).reply.text, /fishing town/);
  const quote = 'the quick brown fox jumps over the lazy dog today';
  e.model.queue.push(() => say(`You said: ${quote}`));
  assert.match((await ask(e, e.T.jess, quote)).reply.text, /You said/);
});

test('Agent: chats are private to their owner and the player assistant can be turned off', async () => {
  const e = env;
  const c = await e.ok('POST', `${A(e)}/chats`, e.T.jess, { title: 'mine' });
  assert.equal((await e.call('GET', `${A(e)}/chats/${c.id}`, e.T.tom)).status, 404);
  assert.equal((await e.call('GET', `${A(e)}/chats/${c.id}`, e.T.dm)).status, 404);
  assert.equal((await e.ok('GET', `${A(e)}/chats`, e.T.tom)).chats.length, 0);
  assert.equal((await e.call('POST', `${A(e)}/chats/${c.id}/messages`, e.T.dm, { text: 'hi' })).status, 404);
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.jess, { moduleTermId: 'dnd-2024:monster-goblin-warrior' })).status, 403);
  assert.equal((await e.call('GET', `${A(e)}/actions`, e.T.jess)).status, 403);
  await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentPlayerChat: false });
  assert.equal((await e.call('POST', `${A(e)}/chats`, e.T.jess, {})).status, 403);
  await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentPlayerChat: true });
});

test('Agent: statblock from a module monster, without any model', async () => {
  const e = bare;
  const r = await e.ok('POST', `${A(e)}/statblock`, e.T.dm, { moduleTermId: 'dnd-2024:monster-goblin-warrior' });
  assert.equal(r.statblock.name, 'Goblin Warrior');
  assert.equal(r.statblock.ac, 15);
  assert.equal(r.statblock.hp, 10);
  assert.ok(r.statblock.actions.length >= 1 && r.statblock.abilities.dex === 15);
  assert.equal(r.page.path, 'Statblocks/Goblin Warrior.md');
  const pg = await e.ok('GET', `/api/worlds/${e.W}/library/pages/${r.page.id}`, e.T.dm);
  assert.equal(pg.visibility, 'dm');
  assert.ok(pg.body.includes('**AC** 15'));
  // DM-only: a player cannot open or find it.
  assert.equal((await e.call('GET', `/api/worlds/${e.W}/library/pages/${r.page.id}`, e.T.jess)).status, 404);
  assert.ok(!JSON.stringify((await e.ok('GET', `/api/worlds/${e.W}/library/pages`, e.T.jess))).includes('Goblin Warrior'));
  // Another copy gets its own page.
  assert.equal((await e.ok('POST', `${A(e)}/statblock`, e.T.dm, { moduleTermId: 'dnd-2024:monster-goblin-warrior' })).page.path, 'Statblocks/Goblin Warrior 2.md');
  // Add to combat from the saved page: HP, AC and an initiative.
  const added = await e.ok('POST', `${A(e)}/statblock/${r.page.id}/combat`, e.T.dm, { initiative: 11 });
  assert.equal(added.combatant.hp, 10);
  const combat = await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm);
  const cb = combat.combatants.find((c: any) => c.id === added.combatant.id);
  assert.deepEqual([cb.name, cb.hp, cb.max_hp, cb.ac, cb.initiative, cb.statblock_page], ['Goblin Warrior', 10, 10, 15, 11, r.page.id]);
  // Players never see armor class.
  assert.ok(!JSON.stringify(await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.jess)).includes('"ac"'));
  // Straight into combat in one call.
  const both = await e.ok('POST', `${A(e)}/statblock`, e.T.dm, { moduleTermId: 'dnd-2024:monster-goblin-warrior', addToCombat: true, initiative: 19 });
  assert.equal(both.combatant.initiative, 19);
  assert.equal((await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants[0].initiative, 19);
  // Bad requests.
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, {})).status, 400);
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { moduleTermId: 'dnd-2024:spell-fireball' })).status, 422);
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { moduleTermId: 'nope:nothing' })).status, 404);
});

test('Agent: a missing chat model gives 503, and the module copy still works', async () => {
  const e = bare;
  const c = await e.ok('POST', `${A(e)}/chats`, e.T.dm, {});
  const m = await e.call('POST', `${A(e)}/chats/${c.id}/messages`, e.T.dm, { text: 'hello' });
  assert.equal(m.status, 503);
  assert.match(m.body.error, /No chat model/);
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { prompt: 'a cave troll' })).status, 503);
  const pg = await e.ok('PUT', `/api/worlds/${e.W}/library/pages`, e.T.dm, { path: 'monsters/Troll', visibility: 'dm', markdown: '# Troll\nBig and green.' });
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { pageId: pg.id })).status, 503);
  assert.equal((await e.ok('GET', `${A(e)}/status`, e.T.dm)).model, false);
  assert.equal((await e.ok('GET', `${A(e)}/status`, e.T.jess)).model, false);
});

test('Agent: statblocks from a prompt and from a page use the chat model and are validated', async () => {
  const e = env;
  const good = { name: 'Cave Troll', size: 'Large', type: 'giant', alignment: 'chaotic evil', cr: 5, ac: 15, hp: 84, hitDice: '8d10+40', speed: { walk: '30 ft.' }, abilities: { str: 18, dex: 8, con: 20, int: 7, wis: 9, cha: 7 }, actions: [{ name: 'Club', text: 'Melee Attack Roll: +7, reach 10 ft. Hit: 13 (2d8 + 4) Bludgeoning damage.' }] };
  e.model.queue.push(() => say(JSON.stringify(good)));
  const r = await e.ok('POST', `${A(e)}/statblock`, e.T.dm, { prompt: 'a cave troll', addToCombat: true, initiative: 6 });
  assert.equal(r.statblock.hp, 84);
  assert.equal(r.combatant.ac, 15);
  assert.equal(r.page.path, 'Statblocks/Cave Troll.md');
  // From a library page.
  const pg = await e.ok('PUT', `/api/worlds/${e.W}/library/pages`, e.T.dm, { path: 'monsters/Troll', visibility: 'dm', markdown: '# Mossback\nA troll with 90 hit points and AC 14.' });
  e.model.queue.push((req: any) => { assert.ok(req.messages.at(-1).content.includes('troll with 90 hit points')); return say(JSON.stringify({ ...good, name: 'Mossback', hp: 90, ac: 14 })); });
  const r2 = await e.ok('POST', `${A(e)}/statblock`, e.T.dm, { pageId: pg.id });
  assert.equal(r2.statblock.name, 'Mossback');
  assert.equal(r2.statblock.hp, 90);
  // An invalid statblock is refused and saves nothing.
  const pages = (await e.ok('GET', `/api/worlds/${e.W}/library/pages`, e.T.dm)).length;
  e.model.queue.push(() => say(JSON.stringify({ ...good, abilities: undefined })));
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { prompt: 'a broken thing' })).status, 422);
  e.model.queue.push(() => say(JSON.stringify({ ...good, ac: 'high' })));
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { prompt: 'a broken thing' })).status, 422);
  e.model.queue.push(() => say(JSON.stringify({ ...good, actions: [] })));
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { prompt: 'a broken thing' })).status, 422);
  e.model.queue.push(() => say('not json at all'));
  assert.equal((await e.call('POST', `${A(e)}/statblock`, e.T.dm, { prompt: 'a broken thing' })).status, 502);
  assert.equal((await e.ok('GET', `/api/worlds/${e.W}/library/pages`, e.T.dm)).length, pages);
});

test('Agent: combat tools through MCP place a creature in initiative and read as the caller may see', async () => {
  const e = bare;
  const key = async (t: string, access: string) => (await e.ok('POST', '/api/keys', t, { scope: 'scribe', label: access, worldId: e.W, access })).key;
  const dmKey = await key(e.T.dm, 'write');
  const rpc = async (k: string, name: string, args: any = {}) => (await e.call('POST', '/mcp', k, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body;
  const names = async (k: string) => (await e.call('POST', '/mcp', k, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t: any) => t.name);
  const writes = ['add_combatant', 'damage_combatant', 'heal_combatant', 'set_conditions', 'next_turn', 'make_statblock'];
  const dmNames = await names(dmKey);
  for (const w of [...writes, 'get_combat', 'search_transcript']) assert.ok(dmNames.includes(w), w);
  // Clear the earlier combatants so order is easy to read.
  for (const c of (await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants) await e.ok('DELETE', `/api/worlds/${e.W}/live/combatants/${c.id}`, e.T.dm);
  const add = async (args: any) => JSON.parse((await rpc(dmKey, 'add_combatant', args)).result.content[0].text);
  const slow = await add({ name: 'Ogre', hp: 59, initiative: 5, ac: 11 });
  const fast = await add({ name: 'Wolf', hp: 11, initiative: 18, ac: 13 });
  const fromSb = await add({ name: 'Archer', statblock: { hp: 13, ac: 15, abilities: { dex: 16 } }, hidden: true });
  const read = JSON.parse((await rpc(dmKey, 'get_combat')).result.content[0].text);
  assert.equal(read.combatants.length, 3);
  const order = read.combatants.map((c: any) => c.name);
  assert.equal(order.indexOf('Wolf') < order.indexOf('Ogre'), true);
  assert.equal(order.at(-1), 'Ogre');
  const archer = read.combatants.find((c: any) => c.name === 'Archer');
  assert.deepEqual([archer.hp, archer.ac, archer.hidden], [13, 15, true]);
  assert.ok(archer.initiative >= 4 && archer.initiative <= 23, `rolled ${archer.initiative}`);
  assert.equal(order[0] === 'Archer' || order[0] === 'Wolf', true);
  // Damage, heal (capped), conditions, next turn.
  await rpc(dmKey, 'damage_combatant', { combatant: slow.id, amount: 20 });
  await rpc(dmKey, 'heal_combatant', { combatant: slow.id, amount: 500 });
  await rpc(dmKey, 'damage_combatant', { combatant: fast.id, amount: 4 });
  await rpc(dmKey, 'set_conditions', { combatant: fast.id, conditions: ['Prone', 'Poisoned'] });
  await rpc(dmKey, 'next_turn');
  const after = JSON.parse((await rpc(dmKey, 'get_combat')).result.content[0].text);
  assert.equal(after.active, true);
  assert.equal(after.combatants.find((c: any) => c.id === slow.id).hp, 59);
  const wolf = after.combatants.find((c: any) => c.id === fast.id);
  assert.equal(wolf.hp, 7);
  assert.deepEqual(wolf.effects.map((x: any) => x.name), ['Prone', 'Poisoned']);
  assert.equal(after.turn, 1);
  // A player's key reads combat without the hidden archer, armor class or the monsters' numbers.
  const jessKey = await key(e.T.jess, 'read');
  const jessSees = JSON.stringify(JSON.parse((await rpc(jessKey, 'get_combat')).result.content[0].text));
  assert.ok(!jessSees.includes('Archer') && !jessSees.includes('"ac"') && !jessSees.includes('"hp":') && !jessSees.includes('statblock'));
  assert.ok(jessSees.includes('Wolf'));
  // Read keys get no write tools, and cannot call them.
  const readKey = await key(e.T.dm, 'read');
  const readNames = await names(readKey);
  for (const w of writes) assert.ok(!readNames.includes(w), `${w} listed for a read key`);
  assert.ok(readNames.includes('get_combat') && readNames.includes('search_transcript'));
  assert.ok((await rpc(readKey, 'add_combatant', { name: 'Nope', hp: 1, initiative: 1 })).error);
  // The DM-only transcript line is not in a player's search.
  const tr = await e.ok('GET', `${A(e)}/transcript?q=vault`, e.T.jess);
  assert.deepEqual(tr.lines, []);
});
