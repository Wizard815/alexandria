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
interface Env { base: string; server: any; deps: any; T: Record<string, string>; ID: Record<string, string>; W: string; model: { queue: Handler[]; seen: any[]; hook?: (url: string) => Promise<void>; log: { url: string; start: number; end: number }[] }; call: (m: string, u: string, t?: string, b?: unknown) => Promise<{ status: number; body: any }>; ok: (m: string, u: string, t?: string, b?: unknown) => Promise<any>; }
const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

async function boot(withModel: boolean): Promise<Env> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-agent-'));
  const model = { queue: [] as Handler[], seen: [] as any[], hook: undefined as undefined | ((url: string) => Promise<void>), log: [] as { url: string; start: number; end: number }[] };
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('http://fake.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      model.seen.push(body);
      const h = model.queue.shift();
      if (!h) return new Response('no scripted reply', { status: 500 });
      const message = h(body);
      if (message instanceof Response) return message;
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const start = performance.now();
    await model.hook?.(u);
    const r = await fetch(url, init);
    model.log.push({ url: u, start, end: performance.now() });
    return r;
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
  // Only the tools that fit are offered (at most 8), and the library search is always among them.
  assert.ok(toolNames(e.model.seen[0]).length <= 8 && toolNames(e.model.seen[0]).includes('search_library') && toolNames(e.model.seen[0]).includes('read_page'));
  // The library matches for the question came with it (DM copies), so the model could answer in one round.
  assert.ok(e.model.seen[0].messages.at(-1).content.includes('Library matches'));
  // The tool result the model got is the DM copy of the page.
  assert.ok(e.model.seen[1].messages.some((m: any) => m.role === 'tool' && m.content.includes(SECRET)));
  assert.equal(chat.actions.length, 0);
  assert.ok(all<any>(e.deps.db, `SELECT * FROM audit WHERE world_id = ? AND action = 'agent.read'`, e.W).length >= 1);
});

test('Agent: it answers from the transcript with a citation', async () => {
  const e = env;
  e.model.queue.push(() => toolCall('search_transcript', { query: 'harbour' }), () => say('You arrived at the harbour as the evening bells rang.'));
  const { reply } = await ask(e, e.T.dm, 'What happened when we arrived?');
  // The latest transcript (with the DM-only line) rides in the user message for a question about the session.
  assert.ok(e.model.seen.at(-2).messages.at(-1).content.includes(DM_LINE));
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
  const { chat } = await ask(e, e.T.dm, 'Move combat along to the following creature and tell me how it went');
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
  const { reply } = await ask(e, e.T.jess, 'Who is the smuggler queen Velmira, and what happened at Saltmarsh?');
  assert.equal(reply.text, 'I do not know about that.');
  const everything = JSON.stringify(e.model.seen.map((r) => r.messages));
  for (const secret of ['treasury beneath the lighthouse', 'secretly answers', DM_LINE, 'seven seven three nine']) assert.ok(!everything.includes(secret), `the model input held DM text: ${secret}`);
  // It did get what a player may read: the shared page, and the players' transcript.
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
  const slow = await add({ name: 'Ogre', hp: 59, initiative: 3, ac: 11 }); // below the Archer's lowest roll (1 + 3), so always last
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

// ---- speed and streaming ----------------------------------------------------------

import { fastPlan, matchCombatant, rollDice, searchTerms, selectTools, MAX_TOOLS } from '../src/features/agent/intent.ts';
import { SentenceGate } from '../src/features/agent/leak.ts';

/** A streamed model reply: OpenAI-shaped chunks, one text piece each. */
const streamOf = (pieces: string[], gapMs = 0): Response => {
  const enc = new TextEncoder();
  const c = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const body = new ReadableStream<Uint8Array>({
    async start(ctl) {
      ctl.enqueue(enc.encode(c({ role: 'assistant', content: '' })));
      for (const p of pieces) { if (gapMs) await new Promise((r) => setTimeout(r, gapMs)); ctl.enqueue(enc.encode(c({ content: p }))); }
      ctl.enqueue(enc.encode(c({}, 'stop')));
      ctl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctl.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

interface Live { events: { type: string; data: any }[]; close: () => void; until: (f: (e: { type: string; data: any }) => boolean, ms?: number) => Promise<void> }
/** Listen to the world's live events as one account. */
async function listen(e: Env, token: string): Promise<Live> {
  const ac = new AbortController();
  const res = await fetch(`${e.base}/api/worlds/${e.W}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const events: Live['events'] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = chunk.match(/^event: (.*)$/m)?.[1];
          const data = chunk.match(/^data: (.*)$/m)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch { /* closed */ }
  })();
  const until = async (f: (x: { type: string; data: any }) => boolean, ms = 4000) => {
    const t0 = Date.now();
    while (!events.some(f)) { if (Date.now() - t0 > ms) throw new Error('live event never came: ' + JSON.stringify(events.slice(-5))); await new Promise((r) => setTimeout(r, 10)); }
  };
  await new Promise((r) => setTimeout(r, 30));
  return { events, close: () => ac.abort(), until };
}
const agentEvents = (l: Live, kind?: string) => l.events.filter((x) => x.type === 'agent' && (!kind || x.data.kind === kind)).map((x) => x.data);

test('Agent: most questions are answered in ONE model round, from the library matches that came with the question', async () => {
  const e = env;
  e.model.seen.length = 0;
  e.model.queue.push((req) => {
    const last = req.messages.at(-1).content;
    assert.ok(last.includes('[Saltmarsh]') && last.includes('fishing town'), 'the snippet is in the prompt');
    return say('Saltmarsh is ruled by the harbour council of seven captains [Saltmarsh].');
  });
  const { reply } = await ask(e, e.T.dm, 'Who rules Saltmarsh?', { page: e.ID.saltmarsh, selection: 'seven captains' });
  assert.equal(e.model.seen.length, 1, 'one round, no tool calls');
  assert.match(reply.text, /harbour council/);
  assert.ok(reply.citations.some((c: any) => c.id === e.ID.saltmarsh && c.kind === 'page'), 'a prefetched page the reply names is cited');
  const last = e.model.seen[0].messages.at(-1).content;
  assert.ok(last.includes(`(${e.ID.saltmarsh})`) && last.includes('looking at the library page [Saltmarsh]') && last.includes('"""seven captains"""'), 'ids, the page on screen and the selection');
  assert.ok(last.endsWith('Who rules Saltmarsh?'));
  assert.equal(reply.timings.rounds, 1);
  assert.equal(reply.timings.toolCalls, 0);
  assert.ok(reply.timings.snippets >= 1 && reply.timings.toolsOffered <= MAX_TOOLS && reply.timings.totalMs >= reply.timings.modelMs);
  assert.ok(all<any>(e.deps.db, `SELECT detail FROM audit WHERE world_id = ? AND action = 'agent.timing'`, e.W).some((a) => /rounds 1/.test(a.detail) && /gateway/.test(a.detail)));
});

test('Agent: the system prompt is static and first, so a server can cache it; the context rides in the user message', async () => {
  const e = env;
  e.model.seen.length = 0;
  e.model.queue.push(() => say('One.'), () => say('Two.'));
  await ask(e, e.T.dm, 'Tell me about Saltmarsh');
  await ask(e, e.T.dm, 'Who is Velmira and what does she want');
  const [a, b] = e.model.seen;
  assert.equal(a.messages[0].role, 'system');
  assert.equal(a.messages[0].content, b.messages[0].content);
  assert.ok(!/World date|Library matches/.test(a.messages[0].content));
  assert.match(a.messages[0].content, /never invent/i);
  assert.match(a.messages[0].content, /\[Page title\]/);
  assert.ok(b.messages.at(-1).content.includes('Velmira'), 'the DM sees the DM-only page match');
  const p = e.model.seen.length;
  e.model.queue.push(() => say('Player.'));
  await ask(e, e.T.jess, 'Tell me about Saltmarsh');
  assert.notEqual(e.model.seen[p].messages[0].content, a.messages[0].content, 'each harness has its own prompt');
  assert.match(e.model.seen[p].messages[0].content, /cannot change anything/);
});

test('Agent: the combat state rides along for the DM only, while a fight is running', async () => {
  const e = env;
  const goblin = await e.ok('POST', `/api/worlds/${e.W}/live/combatants`, e.T.dm, { name: 'Prefetch Goblin', initiative: 12, hp: 7, maxHp: 7 });
  e.model.seen.length = 0;
  e.model.queue.push(() => say('Noted.'), () => say('Fine.'));
  await ask(e, e.T.dm, 'How is the fight going?');
  await ask(e, e.T.jess, 'How is the fight going?');
  const dmText = e.model.seen[0].messages.at(-1).content;
  assert.ok(dmText.includes('Prefetch Goblin') && dmText.includes(goblin.id) && /Combat:/.test(dmText));
  assert.ok(!/Prefetch Goblin|Combat:/.test(JSON.stringify(e.model.seen[1].messages)), 'a player is not handed combat state');
  await e.ok('DELETE', `/api/worlds/${e.W}/live/combatants/${goblin.id}`, e.T.dm);
});

test('Agent: only the tools that fit are offered (at most 8), and search_library and read_page always are', async () => {
  const names = toolsFor(true).map((t) => t.name);
  const cases: [string, string[]][] = [
    ['Add a goblin and deal 5 damage in combat', ['add_combatant', 'damage_combatant', 'next_turn']],
    ['How does grappling work? What is the rule for advantage?', ['lookup_rule']],
    ['Save a page about the lighthouse', ['save_page', 'list_pages']],
    ['What did we say last session?', ['search_transcript']],
    ['Make a statblock for a harbour guard', ['make_statblock']],
    ['Give the party 50 gold', ['add_coin', 'add_item']],
    ['What is the date, and let us take a long rest', ['get_world_date', 'advance_world_time']],
    ['hello', []],
  ];
  for (const [text, want] of cases) {
    const got = selectTools(text, names);
    assert.ok(got.length <= MAX_TOOLS, `${text}: ${got.length} tools`);
    assert.ok(got.includes('search_library') && got.includes('read_page'), text);
    for (const w of want) assert.ok(got.includes(w), `${text}: missing ${w} in ${got.join(',')}`);
  }
  // A message that matches everything still stays within the limit.
  assert.equal(selectTools('combat statblock rules session page npc gold date broker request schedule vote players', names).length, MAX_TOOLS);
  // Only what exists is offered, and a player's list has no writes.
  const player = toolsFor(true).filter((t) => !t.write).map((t) => t.name);
  assert.ok(selectTools('add a goblin to combat and save a page', player).every((n) => player.includes(n)));
  // Over the wire.
  const e = env;
  e.model.seen.length = 0;
  e.model.queue.push(() => say('Done.'));
  await ask(e, e.T.dm, 'Add a goblin to the fight and then deal 4 damage to it');
  const offered = toolNames(e.model.seen[0]);
  assert.ok(offered.length <= MAX_TOOLS && offered.includes('add_combatant') && offered.includes('search_library'), offered.join(','));
  assert.equal(e.model.seen[0].parallel_tool_calls, true);
});

test('Agent: several tool calls in one turn run at the same time', async () => {
  const e = env;
  e.model.seen.length = 0;
  e.model.log.length = 0;
  e.model.hook = async (u) => { if (/\/library\/(search|pages)/.test(u)) await new Promise((r) => setTimeout(r, 150)); };
  try {
    e.model.queue.push(
      () => ({ role: 'assistant', content: null, tool_calls: [
        { id: 'p1', type: 'function', function: { name: 'search_library', arguments: JSON.stringify({ query: 'harbour' }) } },
        { id: 'p2', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ page: e.ID.saltmarsh }) } },
        { id: 'p3', type: 'function', function: { name: 'search_library', arguments: JSON.stringify({ query: 'lighthouse' }) } },
      ] }),
      () => say('Looked at all three.'),
    );
    const { reply } = await ask(e, e.T.dm, 'Look into the harbour, the lighthouse and Saltmarsh');
    assert.equal(reply.text, 'Looked at all three.');
    const calls = e.model.log.filter((l) => /\/library\/(search|pages)/.test(l.url));
    assert.equal(calls.length, 3);
    // One after another would take 450 ms; together they overlap.
    assert.ok(Math.max(...calls.map((c) => c.start)) < Math.min(...calls.map((c) => c.end)), 'all three were in flight together');
    assert.ok(reply.timings.toolMs < 400, `tool time ${reply.timings.toolMs}ms`);
    assert.equal(reply.timings.toolCalls, 3);
    // The answers go back in the order asked.
    const tools = e.model.seen[1].messages.filter((m: any) => m.role === 'tool');
    assert.deepEqual(tools.map((m: any) => m.tool_call_id), ['p1', 'p2', 'p3']);
  } finally { e.model.hook = undefined; }
});

test('Agent: dice, the date, next turn and adding creatures need no model at all', async () => {
  const e = bare;
  // Rolling.
  const roll = await ask(e, e.T.dm, 'roll 2d6+3');
  assert.equal(roll.reply.status, 'done');
  const m = roll.reply.text.match(/= \*\*(\d+)\*\*/);
  assert.ok(m && Number(m[1]) >= 5 && Number(m[1]) <= 15, roll.reply.text);
  assert.equal(roll.reply.timings.fast, true);
  assert.equal((await ask(e, e.T.jess, 'roll d20')).reply.status, 'done');
  // The date.
  const date = await ask(e, e.T.jess, "what's the date?");
  assert.match(date.reply.text, /^It is \*\*.+\*\*\.$/);
  // Next turn is a write: a pending action, not done.
  const next = await ask(e, e.T.dm, 'next turn');
  assert.equal(next.chat.actions.length, 1);
  assert.equal(next.chat.actions[0].tool, 'next_turn');
  assert.equal(next.chat.actions[0].status, 'pending');
  assert.match(next.reply.text, /Waiting for your approval/);
  const state = async () => { const c = await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm); return JSON.stringify([c.active, c.round, c.turn]); };
  const before = await state();
  assert.equal(await state(), before, 'nothing ran yet');
  assert.equal((await e.ok('POST', `${A(e)}/actions/${next.chat.actions[0].id}`, e.T.dm, { decision: 'approve' })).status, 'done');
  assert.notEqual(await state(), before, 'approving ran it');
  // "add 1d4 goblins": one pending add per goblin rolled.
  const count = async () => (await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants.length;
  const had = await count();
  const add = await ask(e, e.T.dm, 'add 1d4 goblins');
  const n = add.chat.actions.length;
  assert.ok(n >= 1 && n <= 4, `${n} goblins`);
  assert.ok(add.chat.actions.every((a: any) => a.tool === 'add_combatant' && a.status === 'pending' && /^Goblin( \d)?$/.test(a.args.name) && a.args.initiative >= 1 && a.args.initiative <= 20));
  assert.match(add.reply.text, new RegExp(`Adding ${n} Goblin`));
  assert.equal(await count(), had, 'not added until approved');
  // By name: damage a creature that is there.
  const sb = await e.ok('POST', `/api/worlds/${e.W}/live/combatants`, e.T.dm, { name: 'Fast Ogre', initiative: 9, hp: 30, maxHp: 30 });
  const hit = await ask(e, e.T.dm, 'damage fast ogre for 7');
  assert.equal(hit.chat.actions.at(-1).tool, 'damage_combatant');
  assert.deepEqual(hit.chat.actions.at(-1).args, { combatant: sb.id, amount: 7 });
  const who = await ask(e, e.T.dm, "who's up?");
  assert.match(who.reply.text, /turn \(round/);
  // A player gets dice and the date only; a command needs the model, which is not set.
  assert.equal((await e.call('POST', `${A(e)}/chats/${(await e.ok('POST', `${A(e)}/chats`, e.T.jess, {})).id}/messages`, e.T.jess, { text: 'next turn' })).status, 503);
  assert.equal(e.model.seen.length, 0, 'no model call for any of it');
  assert.ok(all<any>(e.deps.db, `SELECT detail FROM audit WHERE world_id = ? AND action = 'agent.timing'`, e.W).every((a) => /no model/.test(a.detail)));
});

test('Agent: a fast command that is set to auto-approve runs at once', async () => {
  const e = bare;
  await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentAutoApprove: ['add_combatant'] });
  const { chat, reply } = await ask(e, e.T.dm, 'add 3 orcs to combat');
  assert.equal(chat.actions.length, 0);
  assert.match(reply.text, /Done: Add Orc 1 to combat/);
  const names = (await e.ok('GET', `/api/worlds/${e.W}/live/combat`, e.T.dm)).combatants.map((c: any) => c.name);
  for (const n of ['Orc 1', 'Orc 2', 'Orc 3']) assert.ok(names.includes(n), names.join(','));
  await e.ok('PATCH', `/api/worlds/${e.W}/settings`, e.T.dm, { agentAutoApprove: [] });
});

test('Agent: what is and is not a fast command', () => {
  const dm = (t: string) => fastPlan(t, true);
  assert.equal(dm('roll 2d6+3')?.kind, 'reply');
  assert.equal(dm('Roll a d20 with advantage')?.kind, 'reply');
  assert.equal(dm('please roll 4d6')?.kind, 'reply');
  assert.equal(dm('2d8+1')?.kind, 'reply');
  assert.equal(dm("What's the date today?")?.kind, 'date');
  assert.equal(dm('what time is it')?.kind, 'date');
  assert.equal(dm('next turn')?.kind, 'calls');
  assert.equal(dm('Next turn!')?.kind, 'calls');
  assert.equal(dm('add 3 orcs')?.kind, 'calls');
  assert.equal(dm('add a goblin to combat')?.kind, 'calls');
  assert.equal((dm('add 1d4 goblins') as any).calls.every((c: any) => c.tool === 'add_combatant'), true);
  assert.equal(dm('hit goblin 2 for 5')?.kind, 'combat');
  assert.equal(dm('heal Aria for 8')?.kind, 'combat');
  // Questions and bigger asks go to the model.
  for (const t of ['roll initiative for the goblins and tell me the order', 'add a page about goblins', 'add a goblin', 'add 2 items to the party', 'what is the date of the festival?', 'what happened last session', 'roll the dice on whether the guards notice, and describe it', 'add 99 goblins', 'add 0 goblins']) assert.equal(dm(t), null, t);
  // A player: dice and the date only.
  assert.equal(fastPlan('roll d20', false)?.kind, 'reply');
  assert.equal(fastPlan('next turn', false), null);
  assert.equal(fastPlan('add 2 goblins', false), null);
  // Dice with a fixed rng.
  const r = rollDice('2d6+3', (n) => n)!;
  assert.deepEqual([r.total, r.parts[0].rolls], [15, [6, 6]]);
  assert.equal(rollDice('d20-1', () => 10)!.total, 9);
  assert.equal(rollDice('1d8+1d4+2', (n) => n)!.total, 14);
  assert.equal(rollDice('3+1d4', () => 1)!.total, 4);
  assert.equal(rollDice('3+4', () => 1), null);
  assert.equal(rollDice('1000d6', () => 1), null);
  assert.equal(rollDice('hello', () => 1), null);
  assert.equal(matchCombatant([{ id: 'a', name: 'Goblin 1' }, { id: 'b', name: 'Goblin 2' }], 'goblin'), null);
  assert.equal(matchCombatant([{ id: 'a', name: 'Goblin 1' }, { id: 'b', name: 'Goblin 2' }], 'goblin 2')?.id, 'b');
  assert.deepEqual(searchTerms('Who rules the town of Saltmarsh?'), ['rules', 'town', 'saltmarsh']);
});

test('Agent: the reply streams to its owner as it is written, and only to the owner', async () => {
  const e = env;
  const dm = await listen(e, e.T.dm);
  const tom = await listen(e, e.T.tom);
  try {
    const pieces = ['Saltmarsh ', 'is a fishing ', 'town. ', 'Its council ', 'has seven captains.'];
    e.model.queue.push(() => streamOf(pieces, 25));
    const { id, reply } = await ask(e, e.T.dm, 'Describe Saltmarsh');
    assert.equal(reply.text, pieces.join(''));
    const deltas = agentEvents(dm, 'delta').filter((x) => x.chatId === id);
    assert.ok(deltas.length >= 2, `${deltas.length} bursts`);
    assert.equal(deltas.map((x) => x.text).join(''), pieces.join(''));
    assert.ok(deltas.every((x) => x.messageId === reply.id));
    const firstDelta = dm.events.findIndex((x) => x.type === 'agent' && x.data.kind === 'delta');
    const done = dm.events.findIndex((x) => x.type === 'agent' && x.data.kind === 'message' && x.data.chatId === id);
    assert.ok(firstDelta >= 0 && firstDelta < done, 'text arrived before the message was finished');
    assert.deepEqual(agentEvents(tom), [], 'another player gets nothing');
    assert.ok(reply.timings.firstTokenMs < reply.timings.totalMs, `first text ${reply.timings.firstTokenMs}ms of ${reply.timings.totalMs}ms`);
    // The chat view of a message being written shows what has come so far.
    e.model.queue.push(() => streamOf(['Part one. ', 'Part two. ', 'Part three.'], 120));
    const cid = (await e.ok('POST', `${A(e)}/chats`, e.T.dm, {})).id;
    await e.ok('POST', `${A(e)}/chats/${cid}/messages`, e.T.dm, { text: 'Go on' });
    await dm.until((x) => x.type === 'agent' && x.data.kind === 'delta' && x.data.chatId === cid);
    const mid = await e.ok('GET', `${A(e)}/chats/${cid}`, e.T.dm);
    assert.equal(mid.busy, true);
    assert.match(mid.messages.at(-1).text, /^Part one/);
    await dm.until((x) => x.type === 'agent' && x.data.kind === 'message' && x.data.chatId === cid);
  } finally { dm.close(); tom.close(); }
});

test('Agent: Stop ends the answer and keeps what was shown', async () => {
  const e = env;
  const dm = await listen(e, e.T.dm);
  try {
    e.model.queue.push(() => streamOf(['First part. ', 'Second part. ', 'Third part. ', 'Fourth part. ', 'Fifth part.'], 150));
    const cid = (await e.ok('POST', `${A(e)}/chats`, e.T.dm, {})).id;
    await e.ok('POST', `${A(e)}/chats/${cid}/messages`, e.T.dm, { text: 'Tell a long tale' });
    await dm.until((x) => x.type === 'agent' && x.data.kind === 'delta' && x.data.chatId === cid);
    assert.equal((await e.ok('POST', `${A(e)}/chats/${cid}/stop`, e.T.dm)).stopped, true);
    await dm.until((x) => x.type === 'agent' && x.data.kind === 'message' && x.data.chatId === cid);
    const c = await e.ok('GET', `${A(e)}/chats/${cid}`, e.T.dm);
    const last = c.messages.at(-1);
    assert.equal(last.status, 'done');
    assert.match(last.text, /^First part\./);
    assert.match(last.text, /_Stopped\._$/);
    assert.ok(!last.text.includes('Fifth'));
    assert.equal(c.busy, false);
    assert.equal((await e.ok('POST', `${A(e)}/chats/${cid}/stop`, e.T.dm)).stopped, false, 'nothing left to stop');
    assert.equal((await e.call('POST', `${A(e)}/chats/${cid}/stop`, e.T.jess)).status, 404);
  } finally { dm.close(); }
});

test('Agent: the player stream never sends a sentence that leaks DM-only text', async () => {
  const e = env;
  const jess = await listen(e, e.T.jess);
  const dm = await listen(e, e.T.dm);
  try {
    // The secret arrives in the third sentence, split mid-word across chunks.
    const text = `Greetings, traveller. The harbour is busy today. Also, ${SECRET}. Anyway, that is all.`;
    const pieces: string[] = [];
    for (let i = 0; i < text.length; i += 7) pieces.push(text.slice(i, i + 7));
    e.model.queue.push(() => streamOf(pieces, 2));
    const { id, reply } = await ask(e, e.T.jess, 'Tell me a secret');
    assert.equal(reply.text, "I can't answer that from what you know.");
    assert.equal(reply.status, 'done');
    assert.deepEqual(reply.citations, []);
    const sent = agentEvents(jess, 'delta').filter((x) => x.chatId === id).map((x) => x.text).join('');
    // Nothing of the secret, not even half of it, was ever sent. What came before was fine to send.
    for (const frag of ['Velmira', 'smuggler queen', 'treasury', 'lighthouse', 'Anyway']) assert.ok(!sent.includes(frag), `sent "${frag}": ${sent}`);
    assert.equal(sent, 'Greetings, traveller. ');
    assert.ok(agentEvents(jess, 'replace').some((x) => x.chatId === id && x.text === "I can't answer that from what you know."), 'the screen is told to replace what it has');
    assert.equal(agentEvents(jess).filter((x) => JSON.stringify(x).includes('treasury')).length, 0);
    // The DM hears about it, the player does not.
    await dm.until((x) => x.type === 'agent' && x.data.kind === 'leak' && x.data.chatId === id);
    assert.ok(!agentEvents(jess, 'leak').length);
    assert.equal((await e.ok('GET', `${A(e)}/leaks`, e.T.dm)).leaks.filter((l: any) => l.chatId === id).length, 1);
    // A clean answer streams through whole, sentence by sentence.
    const clean = 'Saltmarsh is a fishing town. Its harbour council has seven captains. They meet at dusk.';
    const ps: string[] = [];
    for (let i = 0; i < clean.length; i += 5) ps.push(clean.slice(i, i + 5));
    e.model.queue.push(() => streamOf(ps, 1));
    const ok2 = await ask(e, e.T.jess, 'What is Saltmarsh?');
    assert.equal(ok2.reply.text, clean);
    const sent2 = agentEvents(jess, 'delta').filter((x) => x.chatId === ok2.id).map((x) => x.text).join('');
    assert.equal(sent2.trim(), clean);
    assert.equal(ok2.reply.timings.gateMs >= 0, true);
  } finally { jess.close(); dm.close(); }
});

test('Agent: the leak gate holds a sentence until the next is complete, so a run across the boundary is caught', () => {
  const check = (t: string) => (t.toLowerCase().replace(/[^a-z ]/g, '').replace(/ +/g, ' ').includes('brown fox jumps over the lazy') ? { blocked: true, match: 'x' } : { blocked: false });
  const out: string[] = [];
  const g = new SentenceGate(check, (s) => out.push(s));
  // "...the quick brown fox." / "Jumps over the lazy dog today." : neither sentence alone holds the run.
  for (const piece of ['Hello there. ', 'Mind this: the quick brown fox. ', 'Jumps over the lazy dog today. ', 'Bye.']) g.push(piece);
  g.end();
  assert.ok(g.blocked);
  assert.equal(out.join(''), 'Hello there. ', 'the first half of the run was never sent');
  // A gate that finds nothing sends everything, in order, and end() flushes the unfinished last sentence.
  const out2: string[] = [];
  const h = new SentenceGate(() => ({ blocked: false }), (s) => out2.push(s));
  for (const p of ['One. Tw', 'o. Thr', 'ee']) h.push(p);
  assert.deepEqual(out2, ['One. '], 'only a sentence that has a complete follower is released');
  assert.equal(h.end(), true);
  assert.equal(out2.join(''), 'One. Two. Three');
});

test('Agent: long chats are sent as a summary plus the last 8 messages', async () => {
  const e = bare;
  const cid = (await e.ok('POST', `${A(e)}/chats`, e.T.dm, {})).id;
  for (let i = 0; i < 7; i++) await ask(e, e.T.dm, `roll d${6 + i}`, {}, cid);
  const { historyFor } = await import('../src/features/agent/harness.ts');
  const { summarize } = await import('../src/features/agent/summary.ts');
  const row = () => all<any>(e.deps.db, 'SELECT summary, summary_upto FROM agent_chats WHERE id = ?', cid)[0];
  await summarize(e.deps, cid);
  assert.ok(row().summary.includes('Asked: roll d6'), row().summary);
  assert.ok(row().summary_upto > 0);
  const h = historyFor(e.deps, cid);
  assert.ok(h.messages.length <= 16 && h.messages.length >= 8, `${h.messages.length} messages`);
  assert.equal(h.messages.at(-1)!.role, 'assistant');
  assert.match(h.summary, /Asked: roll d6/);
});

test('Agent: a history summary goes into the system prompt, and the window stays small', async () => {
  const e = env;
  const cid = (await e.ok('POST', `${A(e)}/chats`, e.T.dm, {})).id;
  for (let i = 0; i < 6; i++) { e.model.queue.push(() => say(`Answer ${i}.`)); await ask(e, e.T.dm, `Question number ${i} about Saltmarsh`, {}, cid); }
  const { summarize } = await import('../src/features/agent/summary.ts');
  await summarize(e.deps, cid);
  e.model.seen.length = 0;
  e.model.queue.push(() => say('Latest.'));
  await ask(e, e.T.dm, 'And one more thing about Saltmarsh', {}, cid);
  const m = e.model.seen[0].messages;
  assert.match(m[0].content, /Earlier in this chat \(summary\):[\s\S]*Question number 0/);
  assert.ok(m.length <= 1 + 16 + 1, `${m.length} messages sent`);
  assert.ok(m.length >= 1 + 8 + 1);
});

test('Agent: the gateway adds under 50 ms per model round (fake model, instant tools)', async () => {
  const e = env;
  const per: number[] = [];
  for (let i = 0; i < 4; i++) {
    e.model.queue.push(() => toolCall('world_info', {}, `ov${i}`), () => say('Done.'));
    const { reply } = await ask(e, e.T.dm, `Check the world for overhead run ${i}`);
    assert.equal(reply.timings.rounds, 2);
    per.push(reply.timings.gatewayMs / reply.timings.rounds);
  }
  // The first run warms caches; judge the best of the rest.
  assert.ok(Math.min(...per.slice(1)) < 50, `gateway overhead per round: ${per.map((x) => x.toFixed(1)).join(', ')} ms`);
  e.model.queue.push(() => say('Player.'));
  const p = await ask(e, e.T.jess, 'Overhead check for players');
  assert.ok(p.reply.timings.gatewayMs < 50, `player gateway ${p.reply.timings.gatewayMs} ms`);
});
