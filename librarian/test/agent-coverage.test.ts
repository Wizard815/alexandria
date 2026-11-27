// Can the agent use all of Alexandria? Every MCP tool is driven through the real
// DM agent harness by a scripted fake chat model (an in-test fake fetch that
// answers the agent's request with a tool_call for the named tool), and every
// read tool through the player harness. The tools are listed at run time
// (toolsFor), so a tool added later is covered without touching this file;
// its arguments come from its schema unless ARGS has a better set.
//
//   DM harness     read tools run; write tools become pending actions that run
//                  when the DM approves them (or at once when auto-approved).
//   Player harness no write tool is offered, and a call to one is refused.
//   Both           no classified text, and for players no DM-only text, is ever
//                  in a request a model receives.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { allTools, toolsFor } from '../src/routes/mcpServer.ts';
import { offerableTools, selectTools } from '../src/features/agent/intent.ts';
import { startFakeModels } from '../scripts/fake-models.ts';
import { toneWav } from './soundTone.ts';

// Secrets, one unique marker each. DM-only text may reach the DM's agent; it must never reach a player's.
const DM_PAGE = 'DMSECRET_PAGE the smuggler queen keeps her treasury beneath the lighthouse cellar';
const DM_CALLOUT = 'DMSECRET_CALLOUT the harbour council secretly answers to the queen of smugglers';
const DM_ITEM_NOTE = 'DMSECRET_ITEMNOTE this lantern is cursed by the drowned king';
const DM_PERSON = 'DMSECRET_PERSON the spymaster of the red harbour';
const DM_BROKER = 'DMSECRET_BROKERNOTE the keeper sells fog charts to the smugglers';
const CLASSIFIED = 'sunken bell opens only when three silver keys turn together at the ebb tide';
const DM_ONLY = [DM_PAGE, DM_CALLOUT, DM_ITEM_NOTE, DM_PERSON, DM_BROKER].map((s) => s.split(' ')[0]);

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => { for (const c of cleanups) await c(); });

interface Seen { who: 'dm' | 'player' | 'other'; body: string }
const model = {
  /** What the next agent request is told to do. */
  script: null as null | { tool: string; args: unknown },
  /** Every request any model job received, whole. */
  seen: [] as Seen[],
  /** The tool result the agent got back for the last scripted call. */
  lastResult: '',
  offered: [] as string[][],
};

const AGENT_SYSTEM = /^You are (Minerva, the assistant of the Dungeon Master|.+, the information broker)/;
const reply = (message: any) => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fakes = await startFakeModels(0);
cleanups.push(() => fakes.close());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-coverage-'));
cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dataDir = path.join(tmp, 'data');
const put = (rel: string, buf: Buffer) => { fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true }); fs.writeFileSync(path.join(dataDir, rel), buf); };
put('music/dungeon/tense/dripping.wav', toneWav(1, 147));
put('ambience/rain/steady.wav', toneWav(1, 800));
put('sfx/doors/creak.wav', toneWav(0.5, 520));

const fakeFetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://fake.test/')) {
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const sys = body?.messages?.[0]?.role === 'system' ? String(body.messages[0].content) : '';
    const agent = u.endsWith('/chat/completions') && AGENT_SYSTEM.test(sys);
    model.seen.push({ who: agent ? (sys.includes('Dungeon Master') ? 'dm' : 'player') : 'other', body: init?.body ?? '' });
    if (agent) {
      const last = body.messages[body.messages.length - 1];
      if (last.role === 'tool') { model.lastResult = String(last.content); return reply({ role: 'assistant', content: 'Done.' }); }
      model.offered.push((body.tools ?? []).map((t: any) => t.function.name));
      if (!model.script) return reply({ role: 'assistant', content: 'Nothing to do.' });
      return reply({ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: model.script.tool, arguments: JSON.stringify(model.script.args) } }] });
    }
    // Every other job (sculpting, statblocks, session summaries, voice, the broker) goes to the stock fake models.
    return fetch(u.replace('http://fake.test/v1', fakes.baseUrl), init);
  }
  // The free content sources (import_content, list_content_books): one small book, never the real services.
  if (u.startsWith('https://api.open5e.com/')) {
    const tob = { key: 'tob', name: 'Tome of Beasts', licenses: [{ name: 'OPEN GAME LICENSE Version 1.0a', key: 'ogl-10a' }], publisher: { name: 'Kobold Press' } };
    const list = new URL(u).pathname.replace(/^\/v2\/|\/$/g, '');
    const results = list === 'documents' ? [tob] : list === 'conditions' ? [{ name: 'Void Sick', document: { key: 'tob' }, descriptions: [{ desc: 'You feel the void.' }] }] : [];
    return new Response(JSON.stringify({ count: results.length, next: null, results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.startsWith('https://raw.githubusercontent.com/5e-bits/')) return new Response(u.endsWith('5e-SRD-Conditions.json') ? JSON.stringify([{ index: 'dazed', name: 'Dazed', desc: ['You are dazed.'] }]) : '404: Not Found', { status: u.endsWith('5e-SRD-Conditions.json') ? 200 : 404 });
  return fetch(url, init);
}) as typeof fetch;

const made = createApp({
  noScheduler: true, dataDir, vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
  env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake', ALX_MODEL_VOICE_URL: 'http://fake.test/v1', ALX_MODEL_VOICE_MODEL: 'kokoro' },
});
const server = made.app.listen(0);
await new Promise((r) => server.once('listening', r));
cleanups.push(() => { server.close(); server.closeAllConnections?.(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const deps = made.deps;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json };
}
async function ok(method: string, url: string, token?: string, body?: unknown) {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

// ---- the world --------------------------------------------------------------

const T: Record<string, string> = {};
const ID: Record<string, string> = {};
T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
T.ads = (await ok('POST', '/api/admin-auth/login', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
ID.dm = (await ok('POST', '/api/admin/accounts', T.ads, { username: 'dungeon', password: 'dm password 123' })).account.id;
T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
const W = (await ok('POST', '/api/admin/worlds', T.ads, { name: 'Coverageland', dmAccountId: ID.dm })).id;
const w = (p: string) => `/api/worlds/${W}${p}`;
for (const name of ['jess', 'tom', 'ana']) {
  const inv = await ok('POST', w('/invites'), T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
  T[name] = j.token;
  ID[name] = j.account.id;
}
const dm = (m: string, u: string, b?: unknown) => ok(m, w(u), T.dm, b);
const as = (who: string) => (m: string, u: string, b?: unknown) => ok(m, w(u), T[who], b);

ID.saltmarsh = (await dm('PUT', '/library/pages', { path: 'places/Saltmarsh', visibility: 'party', markdown: `---\nknowledge: local\n---\n# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council of seven captains.\n\n> [!secret] DM\n> ${DM_CALLOUT}\n` })).id;
ID.dmpage = (await dm('PUT', '/library/pages', { path: 'dm/Queen', visibility: 'dm', markdown: `# Queen\n${DM_PAGE}.\n` })).id;
await dm('PUT', '/library/pages', { path: 'classified/Vault', visibility: 'classified', markdown: `# Vault\nThe harbour vault: the ${CLASSIFIED}.\n` });
ID.item = (await dm('POST', '/inventory', { owner: ID.jess, name: 'Brass lantern', qty: 1, note: 'Hums near water', dmNote: DM_ITEM_NOTE, reason: 'Found in the lighthouse' })).id;
await dm('POST', '/inventory', { owner: ID.tom, name: 'Healing potion', qty: 2, reason: 'From the temple' });
await dm('POST', '/live/ledger', { owner: ID.jess, amountCp: 5000, note: 'Reward' });
await dm('POST', '/live/ledger', { owner: 'party', amountCp: 2000, note: 'Loot' });
await dm('POST', '/people', { name: 'Spymaster', role: DM_PERSON, visibility: 'dm' });
await dm('POST', '/people', { name: 'Odo Fennick', role: 'Harbour clerk', visibility: 'party' });
await dm('POST', '/broker/notes', { topic: 'Keeper', text: DM_BROKER, knowledge: 'local' });
await dm('POST', '/stage/cards', { kind: 'text', title: 'Staged note', text: `${DM_PAGE} (staged, not shown)` });
await dm('POST', '/sound/rescan', {});
await dm('POST', '/sound/scenes', { name: 'Rainy night', layers: [{ kind: 'rain', volume: 0.4 }] });
await dm('POST', '/voice/presets', { name: 'Narrator', voice: 'af_heart', speed: 1, effect: 'none', target: 'table' });
await dm('PUT', '/worldlore/config', { kind: 'library', root: 'WorldLore', defaultLevel: 'party' });
await dm('PATCH', '/settings', { agentAutoApprove: [], sheetRerolls: true });
await dm('POST', '/minerva/enable', {});
// Three players asked the broker; the requests are set to the states the DM's tools act on.
for (const [who, q] of [['jess', 'Who rules Saltmarsh?'], ['tom', 'How much is the ferry?'], ['ana', 'Where is the lighthouse?']] as const) {
  const quote = await as(who)('POST', '/broker/quote', { question: q });
  await as(who)('POST', '/broker/ask', { quoteId: quote.quoteId });
}
const brokerIds = all<any>(deps.db, 'SELECT id FROM broker_requests WHERE world_id = ? ORDER BY created_at, rowid', W).map((r) => r.id);
assert.ok(brokerIds.length >= 3, 'three broker requests were made');
run(deps.db, `UPDATE broker_requests SET status = 'waiting' WHERE id = ?`, brokerIds[1]);
run(deps.db, `UPDATE broker_requests SET status = 'pricing' WHERE id = ?`, brokerIds[2]);
// A player's coin request waits for the DM.
await as('jess')('POST', '/live/ledger', { owner: 'me', amountCp: -50, note: 'A round of drinks' });

// ---- driving a tool through a harness ---------------------------------------

const AGENT = w('/agent');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Driven { result: string; offered: string[]; actions: any[]; text: string }
/** One chat, one message; the scripted model calls `tool` with `args`. */
async function drive(who: 'dm' | 'jess', tool: string, args: unknown): Promise<Driven> {
  model.script = { tool, args };
  model.lastResult = '';
  model.offered.length = 0;
  const chat = await ok('POST', `${AGENT}/chats`, T[who === 'dm' ? 'dm' : 'jess'], {});
  await ok('POST', `${AGENT}/chats/${chat.id}/messages`, T[who === 'dm' ? 'dm' : 'jess'], { text: `Please run the ${tool.replace(/_/g, ' ')} tool for the table` });
  for (let i = 0; i < 400; i++) {
    const c = await ok('GET', `${AGENT}/chats/${chat.id}`, T[who === 'dm' ? 'dm' : 'jess']);
    if (!c.busy) {
      const last = c.messages.filter((m: any) => m.role === 'assistant' && m.status !== 'working').at(-1);
      assert.notEqual(last?.status, 'error', `${tool}: the agent failed: ${last?.text}`);
      return { result: model.lastResult, offered: model.offered.flat(), actions: c.actions, text: last?.text ?? '' };
    }
    await wait(15);
  }
  throw new Error(`${tool}: the agent never finished`);
}

/** What the agent hands back when a tool did not work. */
const FAILED = /^(Error \d+|Unknown tool|Missing |The call failed)/;

// ---- arguments ---------------------------------------------------------------

type Maker = () => Promise<Record<string, unknown>> | Record<string, unknown>;
const memo = new Map<string, Promise<any>>();
/** Build something once (a person, a draft...) the first time a tool needs it. */
const once = <X,>(key: string, make: () => Promise<X>): Promise<X> => { if (!memo.has(key)) memo.set(key, make()); return memo.get(key)!; };
const minutes = async () => (await dm('GET', '/clock')).minutes as number;
const person = () => once('person', async () => (await dm('POST', '/people', { name: 'Old Hennet', role: 'Lighthouse keeper', visibility: 'party' })).id as string);
const combatant = (n: string) => once(`cb-${n}`, async () => (await dm('POST', '/live/combatants', { name: n, initiative: 10, hp: 20, maxHp: 20, ac: 12 })).id as string);
const draft = () => once('draft', async () => (await dm('POST', '/sessionlog/drafts', { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), title: 'Session 1: Coverage' })).id as string);
const encounter = (n: string) => once(`enc-${n}`, async () => (await dm('POST', '/encounters', { accountIds: [ID.tom], npcName: `Stranger ${n}`, line: 'Hello there.' }))[0].id as string);
const quickEvent = (n: string) => once(`qe-${n}`, async () => (await dm('POST', '/quick-events', { kind: 'recall', title: `Recall ${n}`, prompt: 'What do you remember?', timerS: 60 })).id as string);
const lorePage = (n: string) => once(`lore-${n}`, async () => (await dm('POST', '/worldlore/pages', { path: `Test/${n}`, title: n, markdown: `# ${n}\nA page for the test.\n`, level: 'party', by: 'the DM' })).id as string);
const card = () => once('card', async () => (await dm('POST', '/stage/cards', { kind: 'text', title: 'Shown card', text: 'On the stage.', show: true })).id as string);
const mark = (n: string) => once(`mark-${n}`, async () => (await dm('POST', '/map/world/marks', { kind: 'pin', x: 20, y: 30, label: n })).id as string);
const scene = () => once('scene', async () => (await dm('POST', '/scenes', { name: 'Coverage scene', parts: { table: { mapId: 'world', pic: 'none' }, sound: { stopOthers: true } } })).name as string);
const pendingCoin = () => once('coin', async () => (await dm('GET', '/approvals')).coin[0].id as string);
const request = () => once('request', async () => (await as('jess')('POST', '/requests', { kind: 'question', title: 'Can I recall the keeper?', body: 'Jessamine grew up here.' })).id as string);
const dmTemplate = () => once('dm-template', async () => (await dm('POST', '/templates', { kind: 'library', name: 'Coverage page', spec: { sections: ['Overview'] } })).id as string);
const movableItem = () => once('movable', async () => (await dm('POST', '/inventory', { owner: ID.tom, name: 'Rope', qty: 3, reason: 'Bought' })).id as string);

const shopId = () => once('shop', async () => (await dm('POST', '/shop/generate', { kind: 'general', size: 'town', seed: 'cov', save: true, status: 'open' })).shop.id as string);
const shopItem = () => once('shopitem', async () => (await dm('POST', '/shop/items', { name: 'Coverage Lantern', cost: '2 gp' })).id as string);

// Foundry: a map picture in the library, and a token on a linked scene (as the bridge module would have sent).
const foundryPic = () => once('fpic', async () => {
  put(`libfiles/${W}/lf_covmap`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  run(deps.db, "INSERT INTO libfiles_files (id, world_id, page_id, name, kind, level, mime, family, size, by_id, at) VALUES ('lf_covmap', ?, ?, 'cove.png', 'map', 'party', 'image/png', 'image', 12, NULL, ?)", W, ID.saltmarsh, new Date().toISOString());
  return 'lib:lf_covmap';
});
const foundryToken = () => once('ftoken', async () => {
  const at = new Date().toISOString();
  run(deps.db, "INSERT INTO foundry_scenes (world_id, scene_id, name, map_id, pic, seen_at) VALUES (?, 'covscene', 'Cove', 'world', 'none', ?)", W, at);
  run(deps.db, "INSERT INTO map_marks (id, world_id, map_id, author_id, kind, data, visibility, hidden_by_dm, created_at) VALUES ('mk_covtoken', ?, 'world', ?, 'pin', ?, 'party', 0, ?)", W, ID.dm, JSON.stringify({ x: 10, y: 10, label: 'Cove goblin', token: { scene: 'covscene', id: 'tok1', actor: null, account: null, size: 0.02, disposition: -1, player: false } }), at);
  run(deps.db, "INSERT INTO foundry_tokens (world_id, scene_id, token_id, mark_id) VALUES (?, 'covscene', 'tok1', 'mk_covtoken')", W);
  return 'mk_covtoken';
});

/** Arguments that need real ids or values. A tool not listed gets values made from its schema. */
// DownTime: the house rule on, a fresh task per tool, a round open or closed as the tool needs.
const dtOn = () => once('downtime-on', async () => { await dm('PUT', '/mods/downtime/enabled', { on: true }); return true; });
const dtTask = async (label: string, reward?: unknown) => { await dtOn(); return (await dm('POST', '/downtime/tasks', { player: ID.jess, activity: { name: `Coverage ${label}`, tier: 'common' }, reward })).id as string; };
const dtNoRound = async () => { await dtOn(); await call('POST', w('/downtime/rounds/current/cancel'), T.dm, {}); };
const dtRound = async () => { await dtOn(); if (!(await dm('GET', '/downtime/rounds/current')).round) await dm('POST', '/downtime/rounds', { days: 1, advance: false }); };

const ARGS: Record<string, Maker> = {
  import_content: () => ({ source: 'open5e', books: ['tob'], kinds: ['condition'] }),
  run_macro: () => once('macro', async () => { await dm('POST', '/actions/macros', { name: 'Coverage roll', steps: [{ action: 'dice.roll' }] }); return 'ok'; }).then(() => ({ macro: 'Coverage roll' })),
  share_library_item: () => ({ kind: 'page', id: ID.saltmarsh, to: 'party', notify: true }),
  read_page: () => ({ page: ID.saltmarsh }),
  foundry_send_handout: () => ({ page: ID.saltmarsh }),
  foundry_send_map: async () => ({ pic: await foundryPic(), name: 'Cove' }),
  foundry_move_token: async () => ({ token: await foundryToken(), x: 40, y: 60 }),
  roll20_send_handout: () => ({ page: ID.saltmarsh }),
  owlbear_link: () => once('owlbear', async () => { await dm('POST', '/owlbear/key', {}); return 'ok'; }).then(() => ({ lead: 'alexandria' })),
  search_library: () => ({ query: 'Saltmarsh' }),
  search_world: () => ({ query: 'Saltmarsh' }),
  related_pages: () => ({ page: ID.saltmarsh }),
  story_bible: () => ({ q: 'Saltmarsh' }),
  get_inventory: () => ({ owner: 'me' }),
  ask_broker_quote: () => ({ question: 'Who rules Saltmarsh?' }),
  list_world_events: () => ({ days: 7 }),
  get_item_card: () => ({ itemId: ID.item }),
  link_item_page: () => ({ itemId: ID.item, pageId: ID.saltmarsh }),
  lookup_rule: () => ({ query: 'grapple' }),
  lookup_term: () => ({ term: 'fireball', kind: 'spell' }),
  read_term: () => ({ id: 'dnd-2024:monster-goblin-warrior' }),
  read_spell: () => ({ id: 'srd:fireball' }),
  draft_spell_recipe: () => ({ result: 'Scorching Ray', prereqs: ['Fire Bolt', 'Burning Hands'], stats: { int: 13 } }),
  generate_names: () => ({ race: 'elf', count: 3, seed: 'cov' }),
  generate_items: () => ({ rarity: 'rare', seed: 'cov' }),
  generate_coins: () => ({ mode: 'hoard', level: 4, seed: 'cov' }),
  save_page: () => ({ path: 'agent/Tool test', markdown: '# Tool test\nA page the agent saved.' }),
  add_person: () => ({ name: 'Captain Brask', role: 'Harbour council', kind: 'rival', visibility: 'party' }),
  add_quote: async () => ({ personId: await person(), text: 'The tide waits for no one.', said: 'Session 1' }),
  schedule_session: () => ({ title: 'Game night', startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 7 * 86_400_000 + 3 * 3_600_000).toISOString() }),
  send_quick_event: () => ({ kind: 'recall', title: 'The keeper', prompt: 'Does anyone remember the keeper?', timerS: 30 }),
  add_item: () => ({ owner: 'party', name: 'Coil of rope', qty: 1, reason: 'Found' }),
  add_coin: () => ({ owner: 'party', amountCp: 250, note: 'Found in a barrel' }),
  decide_request: async () => ({ id: await request(), decision: 'rejected', reply: 'Not yet.' }),
  send_broker_offer: () => ({ title: 'The dark lighthouse', info: 'Someone paid the keeper to let it go dark.', priceCp: 150, targets: ['party'] }),
  add_broker_note: () => ({ topic: 'Ferry', text: 'The ferry costs two silver.', knowledge: 'common' }),
  broker_answer: () => ({ id: brokerIds[0], answer: 'The harbour council of seven captains rules the town.' }),
  broker_deliver: () => ({ id: brokerIds[1] }),
  broker_refuse: () => ({ id: brokerIds[2], note: 'Not for sale.' }),
  add_combatant: () => ({ name: 'Goblin Boss', initiative: 14, hp: 21, ac: 17 }),
  damage_combatant: async () => ({ combatant: await combatant('Goblin 1'), amount: 4 }),
  create_template: async () => ({ name: 'Coverage ritual', description: 'A ritual', perspective: 'dm', category: 'Story', fields: [{ key: 'place', label: 'Place', type: 'text' }], body: 'A ritual at {{place}}.' }),
  set_initiative: async () => ({ combatant: await combatant('Goblin 1'), value: 14 }),
  heal_combatant: async () => ({ combatant: await combatant('Goblin 1'), amount: 2 }),
  set_conditions: async () => ({ combatant: await combatant('Goblin 1'), conditions: ['Prone'] }),
  give_temp_hp: async () => ({ combatant: await combatant('Goblin 1'), amount: 5 }),
  set_concentration: async () => ({ combatant: await combatant('Goblin 1'), spell: 'Bless' }),
  // A save is only owed to someone concentrating, and death saves belong to a downed player character.
  concentration_save: async () => ({ combatant: await once('cb-mage', async () => (await dm('POST', '/live/combatants', { name: 'Mage', initiative: 9, hp: 20, maxHp: 20, concentration: { spell: 'Bless', dc: 10 } })).id as string), result: 'pass' }),
  set_combatant_state: async () => ({ combatant: await combatant('Goblin 1'), tempHp: 0 }),
  death_save: async () => ({ combatant: await once('cb-downed', async () => (await dm('POST', '/live/combatants', { name: 'Tomas', initiative: 8, hp: 0, maxHp: 10, accountId: ID.tom })).id as string), roll: 12 }),
  remove_combatant: async () => ({ combatant: await combatant('Goblin 2') }),
  set_combat: () => ({ active: true, round: 1 }),
  make_statblock: () => ({ moduleTermId: 'dnd-2024:monster-goblin-warrior', addToCombat: true, initiative: 12 }),
  start_recording: () => ({ name: 'Session 1' }),
  advance_world_time: () => ({ preset: 'short-rest', reason: 'A rest at the inn' }),
  add_world_event: async () => ({ title: 'Harbour festival', start: (await minutes()) + 3 * 1440, visibility: 'party', kind: 'holiday' }),
  sculpt: () => ({ template: 'Tavern', values: { name: 'The Salty Dog' } }),
  send_scene: () => ({ template: 'Scene, player perspective', values: { location: 'Saltmarsh', time: 'Dusk', weather: 'Fog', description: 'You stand on the quay as the fog rolls in.' } }),
  start_game_session: () => ({ title: 'Session 1' }),
  send_table_chat: () => ({ body: 'Welcome back to Saltmarsh.' }),
  read_session_log_draft: async () => ({ draftId: await draft() }),
  edit_session_log_draft: async () => ({ draftId: await draft(), markdown: '# Session 1\nThe party reached Saltmarsh.' }),
  decide_session_date: async () => ({ draftId: await draft(), accept: false }),
  publish_session_log: async () => ({ draftId: await draft() }),
  draft_session_summary: () => ({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), title: 'Session 1' }),
  activate_scene: async () => ({ scene: await scene() }),
  play_music: () => ({ mood: 'tense', area: 'dungeon' }),
  play_ambience: () => ({ scene: 'Rainy night' }),
  play_sfx: () => ({ name: 'creak' }),
  speak: () => ({ text: 'Welcome, travellers.', preset: 'Narrator' }),
  show_on_stage: () => ({ kind: 'text', title: 'The lighthouse', text: 'A tall white tower on the headland.' }),
  hide_stage_card: async () => ({ cardId: await card() }),
  queue_media: () => ({ url: 'https://youtu.be/dQw4w9WgXcQ', title: 'Tavern theme' }),
  show_media: () => ({ action: 'queue' }),
  decide_approval: async () => ({ id: await pendingCoin(), action: 'approve' }),
  move_item: async () => ({ itemId: await movableItem(), to: 'party', reason: 'Stashed for the road' }),
  add_map_mark: () => ({ kind: 'pin', x: 40, y: 50, label: 'The dark lighthouse' }),
  hide_map_mark: async () => ({ markId: await mark('A'), hidden: true }),
  delete_map_mark: async () => ({ markId: await mark('B') }),
  remove_someday_event: async () => ({ id: (await dm('POST', '/clock/someday', { title: 'The dragon wakes' })).id }),
  update_person: async () => ({ personId: await person(), attitude: 'Chatty' }),
  change_player_hp: () => ({ accountId: 'jess', damage: 1, note: 'coverage' }),
  give_reroll: () => ({ accountId: 'jess', kind: 'personal', note: 'coverage' }),
  add_recall: async () => ({ personId: await person(), accountId: ID.jess, text: 'Jessamine knew him as a child.', success: true }),
  resolve_quick_event: async () => ({ id: await quickEvent('resolve') }),
  cancel_quick_event: async () => ({ id: await quickEvent('cancel') }),
  send_encounter: () => ({ accountIds: [ID.jess], templateId: 'builtin:coin' }),
  encounter_say: async () => ({ id: await encounter('say'), text: 'Lovely weather.', answers: ['It is'] }),
  end_encounter: async () => ({ id: await encounter('end') }),
  lore_read: async () => ({ id: await lorePage('Read') }),
  lore_write: () => ({ path: 'Test/Written', title: 'Written', markdown: '# Written\nBy the agent.', level: 'party' }),
  create_dm_template: () => ({ kind: 'guide', name: 'Coverage towns', triggers: ['town'], spec: { sections: ['Overview'] } }),
  get_dm_template: async () => ({ id: await dmTemplate() }),
  update_dm_template: async () => ({ id: await dmTemplate(), description: 'Updated by the agent' }),
  // Web research is off by default; here it is on, with the fake models server standing in for a SearXNG instance.
  web_research: async () => { await dm('PUT', '/templates/web', { enabled: true, provider: 'searxng', searxUrl: fakes.baseUrl.replace(/\/v1$/, '') }); return { queries: ['Tomonoura Japan town'] }; },
  lore_move: async () => ({ id: await lorePage('Move'), to: 'Moved' }),
  lore_delete: async () => ({ id: await lorePage('Delete') }),
  list_map_marks: () => ({ mapId: 'world' }),
  who_is: () => ({ name: 'Saltmarsh' }),
  conversation_log: () => ({ lines: [{ speaker: 'jess', text: 'We should ask the keeper about the lamp.' }] }),
  status_update: () => ({ section: 'Now', text: 'The party is in Saltmarsh.' }),
  revelation_create: () => ({ title: 'Who darkened the lamp?', conclusion: 'The keeper did.', clues: ['A ledger page', 'Oil on his hands', 'A boat at night'] }),
  revelation_mark: () => once('mystery', async () => (await dm('POST', '/minerva/revelations', { title: 'Who sank the ferry?', conclusion: 'The harbour council.', clues: ['A cut rope', 'A silent captain', 'A paid witness'] })).slug as string).then(() => ({ mystery: 'Who sank the ferry?', clue: 1, player: 'jess' })),
  codex_upsert: () => ({ name: 'Odo Fennick', section: 'notes', text: 'Keeps the harbour ledgers.' }),
  promote: () => ({ name: 'Harbour Master Pell' }),
  arc_start: async () => { await call('POST', w('/minerva/arcs/open/close'), T.dm, {}); return { title: 'Coverage arc' }; },
  arc_close: async () => { await call('POST', w('/minerva/arcs'), T.dm, { title: 'Closing arc' }); return { arc: 'open' }; },
  goal_update: () => ({ player: 'jess', goal: 'Find the keeper', heat: 'on', text: 'Seen at the quay.' }),
  my_who_is: () => ({ name: 'jess' }),
  my_goal_update: () => ({ goal: 'Find my brother', heat: 'on' }),
  read_shop: async () => ({ shop: await shopId() }),
  edit_item: async () => ({ item: await shopItem(), cost: '3 gp' }),
  stock_shop: async () => ({ shop: await shopId(), items: [{ item_id: await shopItem(), qty: 2 }] }),
  set_shop_status: async () => ({ shop: await shopId(), status: 'open' }),
  create_shopkeeper: async () => ({ shop: await shopId(), save_page: true }),
  generate_shop: () => ({ kind: 'magic', size: 'town', level: 5, seed: 'cov' }),
  shop_memory: async () => ({ shop: await shopId() }),
  give_shop_deal: async () => ({ shop: await shopId(), player: ID.jess, pct: 10, days: 2 }),
  present_shop: async () => ({ shop: await shopId(), players: [ID.jess], message: 'Fine wares, friend!', open: true }),
  set_town: () => ({ name: 'Coverage Harbour', size: 'town', price_pct: 20 }),
  house_rule_grant: async () => { await dm('PUT', '/mods/inspiration-rerolls/enabled', { on: true }); return { mod: 'inspiration-rerolls', player: ID.tom, resource: 'dm', note: 'Stayed in character' }; },
  downtime_suggest: async () => { await dtOn(); return { player: 'jess', want: 'earn money' }; },
  downtime_start: async () => { await dtOn(); return { activityId: 'pre-carouse' }; },
  downtime_pick: async () => { await dtRound(); return { skip: true }; },
  downtime_assign: async () => { await dtOn(); return { player: 'jess', activityId: 'pre-work', reward: { gp: 1 } }; },
  downtime_time: async () => ({ task: await dtTask('time'), days: -1, note: 'Fever' }),
  downtime_work: async () => ({ task: await dtTask('work'), hours: 4, note: 'Half a day' }),
  downtime_update: async () => ({ task: await dtTask('update'), tier: 'rare' }),
  downtime_remove: async () => ({ task: await dtTask('remove'), note: 'Gave up' }),
  downtime_reward: async () => { const t = await dtTask('reward', { gp: 2 }); await dm('POST', `/downtime/tasks/${t}/work`, { days: 1 }); return { task: t }; },
  downtime_round: async () => { await dtNoRound(); return { days: 1, advance: false }; },
  downtime_close_round: async () => { await dtRound(); return {}; },
  // A player spends a personal reroll they really hold (for a roll made with real dice), so the run shows a spend, not a refusal.
  house_rule_spend: async () => {
    await dm('PUT', '/mods/inspiration-rerolls/enabled', { on: true });
    const held = (await dm('GET', '/mods/counters')).players.find((p: any) => p.accountId === ID.jess).mods['inspiration-rerolls'].find((c: any) => c.id === 'personal').value;
    if (held < 1) await dm('POST', '/mods/inspiration-rerolls/act', { action: 'grant', player: ID.jess, resource: 'personal', note: 'coverage' });
    return { mod: 'inspiration-rerolls', action: 'use-personal', atTable: true, note: 'coverage' };
  },
  // A small data system for the record tools: shared notes the DM keeps, a task each player owns, a prompt.
  house_rule_records: async () => ({ mod: await coverageSystem() }),
  house_rule_record_act: async () => ({ mod: await coverageSystem(), action: 'note', values: { text: 'The tide turns at dusk' }, note: 'coverage' }),
  house_rule_prompt: async () => ({ mod: await coverageSystem(), prompt: 'day' }),
  house_rule_my_record: async () => ({ mod: await coverageSystem(), action: 'start', values: { what: 'Mend nets' } }),
  house_rule_file: () => ({ mod: 'hero-points' }),
  house_rule_guide: () => ({ part: 'data' }),
  house_rule_save: () => ({ mod: { kit: 1, id: 'coverage-points', name: 'Coverage points', resources: [{ id: 'pt', label: 'Point' }], actions: [{ id: 'give', label: 'Give', by: 'dm', resource: 'pt', add: 1 }] } }),
};

/** Values from a tool's own schema for any tool without an entry in ARGS. */
function fromSchema(tool: { props: Record<string, any>; required?: string[] }): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  for (const k of tool.required ?? []) {
    const p = tool.props[k] ?? {};
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    a[k] = p.enum ? p.enum[0] : t === 'integer' || t === 'number' ? 1 : t === 'boolean' ? false : t === 'array' ? [] : t === 'object' ? {} : 'x';
  }
  return a;
}
const coverageSystem = () => once('cov-system', async () => {
  await dm('POST', '/mods/import', { mod: { kit: 2, id: 'coverage-system', name: 'Coverage system',
    records: { note: { label: 'Note', fields: { text: 'text' } }, task: { label: 'Task', owned: true, fields: { what: 'text', done: { type: 'int', default: 0 } } } },
    recordActions: [{ id: 'note', label: 'Note', by: 'dm', record: 'note', do: 'create', ask: ['text'] }, { id: 'start', label: 'Start', by: 'owner', record: 'task', do: 'create', ask: ['what'] }],
    prompts: [{ id: 'day', button: 'Day', choices: [{ label: 'Start', action: 'start' }, { label: 'Skip', skip: true }] }] } });
  await dm('PUT', '/mods/coverage-system/enabled', { on: true });
  return 'coverage-system';
});
const argsFor = async (tool: { name: string; props: Record<string, any>; required?: string[] }) => (ARGS[tool.name] ? await ARGS[tool.name]() : fromSchema(tool));

/** Tools that end something the others need (a running game, a recording, a page) go last. */
const LAST = ['end_game_session', 'stop_recording', 'lore_delete', 'delete_map_mark', 'publish_session_log', 'remove_combatant', 'hide_stage_card'];
const rank = (n: string) => (n === 'start_game_session' ? -1 : LAST.includes(n) ? 1 + LAST.indexOf(n) : 0);
const ordered = (tools: ReturnType<typeof toolsFor>) => [...tools].sort((a, b) => rank(a.name) - rank(b.name));

// ---- the tests ---------------------------------------------------------------

test('Coverage: every tool can be offered to the model by some message', () => {
  const offerable = offerableTools();
  const missing = allTools().filter((t) => !offerable.has(t.name)).map((t) => t.name);
  assert.deepEqual(missing, [], `these tools are never offered to the agent; add them to a category in features/agent/intent.ts: ${missing.join(', ')}`);
  // The ones a message about the subject picks.
  for (const [text, tools] of [
    ['put the lighthouse on the stage for the table', ['show_on_stage']],
    ['play tense music', ['play_music']],
    ['read this aloud in the narrator voice', ['speak']],
    ['start recording the session', ['start_recording', 'start_game_session']],
    ['publish the session log', ['publish_session_log']],
    ['approve the coin request', ['decide_approval']],
    ['add a pin on the map', ['add_map_mark']],
    ['give Jess a personal reroll for that speech', ['house_rule_grant']],
    ['write a house rule for hero points', ['house_rule_check', 'house_rule_save']],
    ['start a downtime round for 3 days', ['downtime_round']],
    ['Mira lost two days of crafting to the fever', ['downtime_time']],
    ['make me a downtime mod for my table', ['house_rule_guide', 'house_rule_file', 'house_rule_check']],
    ['start a downtime day for the party', ['house_rule_prompt']],
    ['take two days off Jess\'s downtime task', ['house_rule_record_act', 'house_rule_records']],
  ] as const) {
    const picked = selectTools(text, toolsFor(true).map((t) => t.name));
    for (const n of tools) assert.ok(picked.includes(n), `"${text}" offers ${n}: got ${picked.join(', ')}`);
  }
});

test('Coverage: the DM harness runs every DM tool (writes wait for approval, then run)', async () => {
  const tools = ordered(toolsFor(true));
  assert.ok(tools.length > 80, `found ${tools.length} tools`);
  const report: string[] = [];
  const failures: string[] = [];
  for (const tool of tools) {
    try {
      const args = await argsFor(tool);
      const before = model.seen.length;
      const run1 = await drive('dm', tool.name, args);
      assert.ok(model.seen.length > before, `${tool.name}: the model was asked`);
      if (!tool.write) {
        assert.ok(run1.result && !FAILED.test(run1.result), `${tool.name} did not run: ${run1.result.slice(0, 240)}`);
        assert.equal(run1.actions.length, 0, `${tool.name}: a read tool proposed an action`);
        report.push(`read   ${tool.name}`);
        continue;
      }
      // A write is proposed, and has not run.
      assert.match(run1.result, /^Proposed to the DM as action act_/, `${tool.name} was not proposed: ${run1.result.slice(0, 200)}`);
      const act = run1.actions.find((a: any) => a.tool === tool.name);
      assert.ok(act && act.status === 'pending', `${tool.name}: a pending action`);
      // The DM approves it, and it runs.
      const done = await call('POST', `${AGENT}/actions/${act.id}`, T.dm, { decision: 'approve' });
      assert.equal(done.status, 200, `${tool.name} failed on approval: ${JSON.stringify(done.body).slice(0, 300)}`);
      assert.equal(done.body.status, 'done', `${tool.name}: ${JSON.stringify(done.body).slice(0, 300)}`);
      report.push(`write  ${tool.name} (approved)`);
    } catch (e: any) {
      failures.push(`${tool.name}: ${String(e.message).split('\n')[0]}`);
    }
  }
  console.log(`DM harness: ${report.length}/${tools.length} tools ran`);
  assert.deepEqual(failures, [], `tools that did not run:\n${failures.join('\n')}`);
});

test('Coverage: a tool set to auto-approve runs without waiting', async () => {
  await dm('PATCH', '/settings', { agentAutoApprove: ['send_table_chat', 'add_coin'] });
  try {
    const before = (await dm('GET', '/live/ledger?owner=party')).cp;
    const r = await drive('dm', 'add_coin', { owner: 'party', amountCp: 77, note: 'Auto' });
    assert.equal(r.actions.filter((a: any) => a.status === 'pending').length, 0, 'nothing waits');
    assert.ok(!FAILED.test(r.result), r.result);
    assert.equal((await dm('GET', '/live/ledger?owner=party')).cp, before + 77);
    assert.ok(all<any>(deps.db, `SELECT 1 FROM audit WHERE world_id = ? AND action = 'agent.action' AND detail LIKE 'add_coin%auto-approved%'`, W).length >= 1);
    // A tool that is not on the list still waits.
    assert.equal((await drive('dm', 'add_item', { owner: 'party', name: 'Torch' })).actions.length, 1);
  } finally {
    await dm('PATCH', '/settings', { agentAutoApprove: [] });
  }
});

test('Coverage: the player harness offers and runs read tools only', async () => {
  // DM-only lookups are never offered to a player's model (they would only get 403).
  const dmOnly = toolsFor(false).filter((t) => !t.write && t.dmOnly);
  assert.ok(dmOnly.length >= 10, 'the DM-only lookups are flagged');
  for (const t of dmOnly) {
    const r = await drive('jess', t.name, await argsFor(t));
    assert.match(r.result, /Unknown tool/, `${t.name} is hidden from players`);
    assert.ok(!r.offered.includes(t.name), `${t.name} is not offered to a player's model`);
  }
  const readTools = toolsFor(false).filter((t) => !t.write && !t.dmOnly);
  const writeTools = toolsFor(true).filter((t) => t.write);
  assert.ok(readTools.length >= 30 && writeTools.length >= 30);
  // toolsFor(false) is already read only: no write tool, and no DM's playerOnly mix-up either.
  assert.deepEqual(toolsFor(false).filter((t) => t.write), []);
  const actionsBefore = all<any>(deps.db, 'SELECT id FROM agent_actions WHERE world_id = ?', W).length;
  const denied: string[] = [];
  const failures: string[] = [];
  const results: string[] = [];
  for (const tool of readTools) {
    try {
      const run1 = await drive('jess', tool.name, await argsFor(tool));
      for (const t of run1.offered) assert.ok(!writeTools.some((x) => x.name === t), `${tool.name}: the player model was offered the write tool ${t}`);
      assert.ok(run1.result, `${tool.name}: no result`);
      results.push(run1.result);
      // A DM's lookup may be refused for a player (the route is the DM's), but it never fails any other way.
      if (/^Error (401|403|404)/.test(run1.result)) denied.push(tool.name);
      else assert.ok(!FAILED.test(run1.result), `${tool.name} did not run: ${run1.result.slice(0, 200)}`);
    } catch (e: any) {
      failures.push(`${tool.name}: ${String(e.message).split('\n')[0]}`);
    }
  }
  assert.deepEqual(failures, [], `player tools that did not run:\n${failures.join('\n')}`);
  console.log(`Player harness: ${readTools.length - denied.length} ran, ${denied.length} are the DM's and were refused (${denied.join(', ')})`);
  // The ones a player is meant to have are not among the refused.
  for (const n of ['read_page', 'search_library', 'list_people', 'get_live', 'get_stage', 'get_world_date', 'read_table_chat', 'read_party_chat', 'list_session_log', 'get_inventory', 'house_rule_spend', 'house_rule_records', 'house_rule_my_record']) assert.ok(!denied.includes(n), `${n} works for a player`);
  // The spend really happened: Jess's personal reroll is used and logged as hers.
  const spent = (await dm('GET', '/mods/log')).log.find((l: any) => l.action === 'use-personal' && l.accountId === ID.jess);
  assert.ok(spent && spent.after === spent.before - 1, 'house_rule_spend spent a personal reroll for the player');
  // What the tools returned to a player holds nothing of the DM's.
  for (const marker of DM_ONLY) assert.ok(!results.some((r) => r.includes(marker)), `a tool result for a player held ${marker}`);

  // Every write tool is refused when a player's model asks for it, and changes nothing.
  const combatBefore = (await dm('GET', '/live/combat')).combatants.length;
  for (const tool of writeTools) {
    const run1 = await drive('jess', tool.name, await argsFor(tool));
    assert.match(run1.result, /^Unknown tool/, `${tool.name} was callable by the player harness: ${run1.result.slice(0, 200)}`);
    assert.equal(run1.actions.length, 0, `${tool.name} became an action for a player`);
  }
  assert.equal(all<any>(deps.db, 'SELECT id FROM agent_actions WHERE world_id = ?', W).length, actionsBefore, 'a player created no pending action');
  assert.equal((await dm('GET', '/live/combat')).combatants.length, combatBefore, 'combat is unchanged');
});

test('Coverage: a player key over MCP lists and runs read tools only', async () => {
  const key = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'jess read', access: 'read' })).key;
  const rpc = async (method: string, params?: unknown) => (await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method, params })).body;
  const listed = (await rpc('tools/list')).result.tools.map((t: any) => t.name);
  const writes = new Set(toolsFor(true).filter((t) => t.write).map((t) => t.name));
  assert.deepEqual(listed.filter((n: string) => writes.has(n)), []);
  for (const n of ['save_page', 'add_coin', 'next_turn', 'play_music', 'speak', 'start_recording', 'decide_approval', 'show_on_stage']) {
    const r = await rpc('tools/call', { name: n, arguments: { path: 'x', markdown: 'y', owner: 'me', amountCp: 5, text: 'x', kind: 'text', id: 'x', action: 'approve' } });
    assert.ok(r.error || r.result?.isError, `${n} is refused for a player key`);
  }
});

test('Coverage: no classified text, and no DM-only text for a player, reaches any model', () => {
  assert.ok(model.seen.length > 200, `${model.seen.length} model requests were seen`);
  const players = model.seen.filter((s) => s.who === 'player');
  const dms = model.seen.filter((s) => s.who === 'dm');
  assert.ok(players.length > 40 && dms.length > 80, `${players.length} player and ${dms.length} DM agent requests`);
  for (const s of model.seen) assert.ok(!s.body.includes(CLASSIFIED) && !s.body.includes('sunken bell'), `a ${s.who} request carried classified text`);
  for (const s of players) for (const m of DM_ONLY) assert.ok(!s.body.includes(m), `a player's request carried ${m}`);
  // The DM's own agent does get the DM copies (this is what the check above is not allowed to confuse).
  assert.ok(dms.some((s) => DM_ONLY.some((m) => s.body.includes(m))), 'the DM agent saw DM-only text');
  // Calls were audited.
  assert.ok(one<any>(deps.db, `SELECT COUNT(*) AS n FROM audit WHERE world_id = ? AND action = 'agent.action'`, W)!.n >= 30);
});
