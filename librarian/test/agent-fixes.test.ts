// Tool offering, more_tools, false "Proposed" claims, combat, sound, templates,
// party items, the broker's answer check, monster cards, leak-gate false positives
// and Minerva's live help. Models are in-test fake fetches (never a real model).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';
import { toneWav } from './soundTone.ts';

const SECRET = 'Velmira the smuggler queen keeps her treasury beneath the lighthouse';
const DM_LINE = 'The vault code is seven seven three nine and nobody must learn it yet';
const OPEN_LINE = 'We arrive at the harbour of Saltmarsh as the evening bells ring';

type Handler = (req: any) => any;
interface Env { audit: { handler?: (body: any) => any; seen: any[] }; base: string; server: any; deps: any; T: Record<string, string>; ID: Record<string, string>; W: string; model: { queue: Handler[]; seen: any[]; hook?: (url: string) => Promise<void>; log: { url: string; start: number; end: number }[] }; call: (m: string, u: string, t?: string, b?: unknown) => Promise<{ status: number; body: any }>; ok: (m: string, u: string, t?: string, b?: unknown) => Promise<any>; }
const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

async function boot(withModel: boolean): Promise<Env> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-agent-'));
  const audit = { handler: undefined as undefined | ((body: any) => any), seen: [] as any[] };
  const model = { queue: [] as Handler[], seen: [] as any[], hook: undefined as undefined | ((url: string) => Promise<void>), log: [] as { url: string; start: number; end: number }[] };
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('http://fake.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      if (body.model === 'audit-fake') {
        audit.seen.push(body);
        const m = audit.handler?.(body);
        if (m === undefined) return new Response('no audit model', { status: 500 });
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(m) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
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
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ...(withModel ? { ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake', ALX_MODEL_AUDIT_URL: 'http://fake.test/v1', ALX_MODEL_AUDIT_MODEL: 'audit-fake' } : {}) }, fetch: fake });
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
  return { audit, base, server, deps: made.deps, T, ID, W, model, call, ok };
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

import { selectTools, MAX_TOOLS, DM_CORE_TOOLS, fastPlan } from '../src/features/agent/intent.ts';
import { claimsChange, rewriteClaim, COULD_NOT, matchTools } from '../src/features/agent/moretools.ts';
import { systemPrompt } from '../src/features/agent/harness.ts';
import { personaGiveaway } from '../src/features/minerva/player.ts';
import { leakChecker } from '../src/features/agent/leak.ts';
import { liveLines, suggestionPass, LIVE_LINES } from '../src/features/minerva/live.ts';
import { findMatches } from '../src/features/modules/match.ts';
import { nearestLayer } from '../src/features/sound/library.ts';
import { hadActivity } from '../src/features/minerva/after.ts';
import { currentSession } from '../src/features/minerva/store.ts';

const e = await boot(true);
const W = e.W;
const dmNames = toolsFor(true).map((t) => t.name);
const api = (p: string) => `/api/worlds/${W}${p}`;
const acts = (chatId: string) => all<any>(e.deps.db, 'SELECT * FROM agent_actions WHERE chat_id = ? ORDER BY created_at, rowid', chatId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, what: string) => { for (let i = 0; i < 200; i++) { if (f()) return; await sleep(25); } throw new Error(`timed out: ${what}`); };
const approve = (id: string) => e.ok('POST', `${A(e)}/actions/${id}`, e.T.dm, { decision: 'approve' });
const clearCombat = async () => { const c = await e.ok('GET', api('/live/combat'), e.T.dm); for (const x of c.combatants) await e.ok('DELETE', api(`/live/combatants/${x.id}`), e.T.dm); };

// sound files for the library
const data = e.deps.dataDir as string;
const put = (rel: string, buf: Buffer) => { fs.mkdirSync(path.dirname(path.join(data, rel)), { recursive: true }); fs.writeFileSync(path.join(data, rel), buf); };
put('music/dungeon/tense/dripping.wav', toneWav(1, 147));
put('ambience/rain/steady.wav', toneWav(1, 800));
put('ambience/storm/rumble.wav', toneWav(1, 90));

// ---- 1. which tools are offered ------------------------------------------------------------------------------

test('AgentTools_DmCoreIsAlwaysOfferedAndNeverTheMyTools', () => {
  for (const text of ['hello', 'play tense music', 'roll initiative and the goblins flee', 'give the party an item', 'summarise the session transcript', 'create a template']) {
    const got = selectTools(text, dmNames, undefined, true);
    for (const n of DM_CORE_TOOLS) assert.ok(got.includes(n), `${text}: core tool ${n} missing from ${got.join(',')}`);
    assert.ok(got.length <= MAX_TOOLS && MAX_TOOLS >= 14 && MAX_TOOLS <= 16, `${text}: ${got.length}`);
    assert.ok(!got.some((n) => n.startsWith('my_')), `${text}: a player tool was offered to the DM`);
  }
  // A player gets the player tools, and never the DM's core.
  const player = toolsFor(false).filter((t) => !t.write && !(t as any).dmOnly).map((t) => t.name);
  const p = selectTools('what are my goals and notes', player);
  assert.ok(p.includes('my_context') && !p.includes('more_tools') && !p.includes('save_page'));
});

test('AgentTools_KeywordsPickTheRightCategories', () => {
  const want: [string, string[]][] = [
    ['can you play something tense for the cellar', ['get_sound_now', 'play_music']],
    ['set the mood with some ambient rain', ['play_ambience', 'get_sound_now']],
    ['send the scene to the players, add a layer of wind', ['send_scene', 'play_ambience']],
    ['sculpt a new template for a ritual', ['list_templates', 'sculpt_templates', 'sculpt', 'create_template']],
    ['roll initiative for the new goblin', ['set_initiative']],
    ['the ogre flees, end the fight', ['set_combat', 'remove_combatant', 'set_initiative']],
    ['the bandit fled so remove him', ['remove_combatant']],
    ['what is in the party stash', ['get_inventory', 'add_item']],
    ['we need names for the innkeeper', ['generate_names']],
    ['how much gold in the hoard', ['generate_coins']],
    ['make me a villain boss for the lighthouse', ['generate']],
    ['promote Marla, she is part of the arc', ['promote']],
    ['mark the clue as a revelation and note the goal of the mystery', ['revelation_mark', 'goal_update']],
    ['capture what was said in the transcript', ['memory_capture', 'search_transcript']],
  ];
  for (const [text, tools] of want) {
    const got = selectTools(text, dmNames, undefined, true);
    for (const t of tools) assert.ok(got.includes(t), `"${text}" should offer ${t}; got ${got.join(', ')}`);
  }
  // An NPC request goes to the generators, not to sculpt, unless a template is named.
  const npc = selectTools('make me an NPC for the harbour', dmNames, undefined, true);
  assert.ok(npc.includes('generate') && !npc.includes('sculpt') && !npc.includes('create_template'), npc.join(','));
  assert.ok(selectTools('use the NPC template', dmNames, undefined, true).includes('sculpt'));
});

test('AgentTools_RequestsTheRealModelTestMissedNowGetTheirTool', () => {
  const want: [string, string][] = [
    ['The broker may sell this fact: the Harbour Council collects the salt tithe on the quay.', 'add_broker_note'],
    ['Send the party a special broker offer: where the ferry guild hides its ledgers, for 80 copper.', 'send_broker_offer'],
    ['Show me the item card for the Lantern of the Deep.', 'get_item_card'],
    ['Who has given what to whom lately?', 'list_transfers'],
    ['Who is online right now, and what is in the party pouch?', 'get_live'],
    ['Answer Anselm\'s question about the ferry guild: yes, he knows it.', 'decide_request'],
    ['Close the current arc and draft its summary.', 'arc_close'],
    ['Start a new arc called The Drowned Bell.', 'arc_start'],
    ['Jot down an idea: the lamp merchant could be the keeper\'s brother.', 'memory_capture'],
    ['Start a mystery: who stole the harbour bell.', 'revelation_create'],
    ['Add an NPC called Captain Marrow, a stern harbour captain.', 'add_person'],
    ['Jessamine tried to recall what she knew about Captain Marrow and failed.', 'add_recall'],
    ['What voice presets do I have for read-aloud?', 'list_voice_presets'],
    ['Which quick events are open and who has answered?', 'list_quick_events'],
    ['What has been published in the session log so far?', 'list_session_log'],
    ['Draft a summary of the last session.', 'draft_session_summary'],
    ['Are there any family links or relations between our people?', 'list_relations'],
    ['Which other pages read like the Saltmarsh page?', 'related_pages'],
    ['Save that tavern to the library as a page.', 'save_generated'],
    ['Do I have a template for rumours?', 'list_templates'],
  ];
  for (const [text, tool] of want) {
    const got = selectTools(text, dmNames, undefined, true);
    assert.ok(got.includes(tool), `"${text}" should offer ${tool}; got ${got.join(', ')}`);
    assert.ok(got.length <= MAX_TOOLS);
  }
});

test('AgentTools_MoreToolsFindsTheSchemasAndOffersThemNext', async () => {
  const goblin = await e.ok('POST', api('/live/combatants'), e.T.dm, { name: 'More Goblin', initiative: 5, hp: 7, maxHp: 7 });
  e.model.seen.length = 0;
  e.model.queue.push(
    () => toolCall('more_tools', { query: 'change initiative order' }),
    (req) => {
      // The tool result carries the schemas, and the next request offers them.
      assert.ok(toolNames(req).includes('set_initiative'), toolNames(req).join(','));
      const result = req.messages.filter((m: any) => m.role === 'tool').at(-1).content;
      assert.match(result, /set_initiative/);
      assert.match(result, /"combatant"/);
      return toolCall('set_initiative', { combatant: goblin.id, value: 19 });
    },
    () => say('I proposed the initiative change.'),
  );
  const r = await ask(e, e.T.dm, 'Make the little green one go first, whatever tool that takes');
  assert.ok(!toolNames(e.model.seen[0]).includes('set_initiative'), 'it was not offered at first');
  assert.ok(toolNames(e.model.seen[0]).includes('more_tools'));
  const a = acts(r.id);
  assert.equal(a.length, 1);
  assert.equal(a[0].tool, 'set_initiative');
  await approve(a[0].id);
  const c = await e.ok('GET', api('/live/combat'), e.T.dm);
  assert.equal(c.combatants.find((x: any) => x.id === goblin.id).initiative, 19);
  await clearCombat();
});

test('AgentTools_MoreToolsMatchesByNameAndDescriptionAndHidesPlayerTools', () => {
  const all_ = toolsFor(true);
  assert.ok(matchTools(all_, 'create template', true).map((t) => t.name).includes('create_template'));
  assert.ok(matchTools(all_, 'remove a combatant', true).map((t) => t.name).includes('remove_combatant'));
  assert.ok(!matchTools(all_, 'my goals journal notes', true).some((t) => t.name.startsWith('my_')));
  assert.deepEqual(matchTools(all_, '', true), []);
  assert.match(systemPrompt({ harness: 'dm', worldName: 'X' }), /never say "I have no tool" without calling more_tools/i);
  assert.ok(!/more_tools/.test(systemPrompt({ harness: 'player', worldName: 'X' })));
});

test('AgentTools_TooManyToolCallsInOneMessageAreSkipped', async () => {
  e.model.seen.length = 0;
  e.model.queue.push(
    () => ({ role: 'assistant', content: null, tool_calls: Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, type: 'function', function: { name: 'search_library', arguments: JSON.stringify({ query: `saltmarsh ${i}` }) } })) }),
    (req) => {
      const results = req.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content as string);
      assert.equal(results.length, 14, 'every call is answered');
      assert.equal(results.filter((x) => x.startsWith('Skipped')).length, 2, 'two went over the 12 allowed');
      return say('Done.');
    },
  );
  const r = await ask(e, e.T.dm, 'Search the library for fourteen different things');
  assert.equal(r.reply.text, 'Done.');
});

// ---- 2. a reply that says it proposed something must have proposed it -----------------------------------------------

test('AgentClaims_TheClaimDetectorIgnoresDenialsAndPlainAnswers', () => {
  assert.ok(claimsChange('Proposed: deal 14 damage to the Ogre.'));
  assert.ok(claimsChange("I've added the goblin to the fight."));
  assert.ok(claimsChange('HP is now set to 12.'));
  assert.ok(claimsChange('Noted. The ogre is hurt.'));
  assert.ok(!claimsChange('I have not proposed anything yet.'));
  assert.ok(!claimsChange('The ogre has 59 HP and AC 11.'));
  assert.ok(!claimsChange('I can propose that if you like.'));
  assert.equal(rewriteClaim('Proposed: 14 damage to the Ogre.'), COULD_NOT);
  assert.match(rewriteClaim("Proposed it. The ogre is at 45 HP."), new RegExp(`^${COULD_NOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\nThe ogre is at 45 HP\\.`));
});

test('AgentClaims_NoWriteCallRetriesOnceThenSaysItCouldNot', async () => {
  await clearCombat();
  e.model.seen.length = 0;
  e.model.queue.push(
    () => say('Proposed: deal 14 damage to the Ogre.'),
    (req) => {
      // The retry says what is wrong and offers the write tools of the area.
      assert.match(req.messages.at(-1).content, /no write tool call/);
      assert.ok(toolNames(req).includes('damage_combatant'), toolNames(req).join(','));
      return say('Proposed again: 14 damage to the Ogre.');
    },
  );
  const r = await ask(e, e.T.dm, 'Hit the ogre for 14 and tell me how it looks');
  assert.equal(e.model.seen.length, 2);
  assert.ok(r.reply.text.startsWith(COULD_NOT), r.reply.text);
  assert.ok(!/proposed/i.test(r.reply.text));
  assert.equal(acts(r.id).length, 0);
});

test('AgentClaims_ARealWriteInTheRetryKeepsTheReply', async () => {
  const ogre = await e.ok('POST', api('/live/combatants'), e.T.dm, { name: 'Ogre', initiative: 8, hp: 59, maxHp: 59 });
  e.model.seen.length = 0;
  e.model.queue.push(
    () => say('Proposed: 14 damage to the Ogre.'),
    () => toolCall('damage_combatant', { combatant: ogre.id, amount: 14 }),
    () => say('Proposed: 14 damage to the Ogre. It will be at 45.'),
  );
  const r = await ask(e, e.T.dm, 'Hit the ogre for 14 and tell me how it looks');
  assert.equal(acts(r.id).length, 1);
  assert.match(r.reply.text, /^Proposed: 14 damage/);
  assert.ok(!r.reply.text.startsWith(COULD_NOT));
  // A write that did run first: no retry at all.
  e.model.seen.length = 0;
  e.model.queue.push(() => toolCall('damage_combatant', { combatant: ogre.id, amount: 1 }), () => say('Proposed: 1 damage.'));
  await ask(e, e.T.dm, 'Hit the ogre for 1 and tell me how it looks');
  assert.equal(e.model.seen.length, 2);
  await clearCombat();
});

// ---- 3. combat ----------------------------------------------------------------------------------------------

test('AgentCombat_FastPathsMatchTheShapesTheRealModelTestMissed', () => {
  const dmPlan = (t: string) => fastPlan(t, true);
  for (const t of ['Ogre takes 7', 'Ogre takes 7 damage', 'the Ogre takes 7 (from the flail)', 'Goblin 2 takes 7 damage from Anselm', 'Ogre took 7 from the flail']) {
    const p: any = dmPlan(t);
    assert.ok(p && p.kind === 'combat' && p.verb === 'damage' && p.amount === 7, `${t}: ${JSON.stringify(p)}`);
  }
  assert.deepEqual({ ...(dmPlan('set Goblin 2 initiative to 14') as any) }, { kind: 'combat', verb: 'init', target: 'Goblin 2', amount: 14, what: 'set_initiative' });
  assert.equal((dmPlan('Goblin 2 initiative 9') as any).verb, 'init');
  const pc: any = dmPlan('add Tomas to combat with initiative 17');
  assert.deepEqual({ kind: pc.kind, name: pc.name, initiative: pc.initiative }, { kind: 'pc', name: 'Tomas', initiative: 17 });
  assert.equal((dmPlan('Jessamine rolled 12 for initiative') as any).kind, 'pc');
  const end: any = dmPlan('end the fight');
  assert.deepEqual(end.calls, [{ tool: 'set_combat', args: { active: false } }]);
  assert.equal(fastPlan('Ogre takes 7', false), null, 'a player gets none of these');
});

test('AgentCombat_PlayerCharactersJoinWithTheirRolledInitiativeAndFastPathsSkipTheModel', async () => {
  await clearCombat();
  e.model.seen.length = 0;
  const t0 = performance.now();
  const r = await ask(e, e.T.dm, 'add jess to combat with initiative 17');
  assert.ok(performance.now() - t0 < 1500, 'no model call is waited for');
  assert.equal(e.model.seen.length, 0);
  const a = acts(r.id);
  assert.equal(a.length, 1);
  assert.equal(JSON.parse(a[0].args).initiative, 17);
  assert.equal(JSON.parse(a[0].args).accountId, e.ID.jess, 'the player character is that player\'s own combatant');
  await approve(a[0].id);
  const c = await e.ok('GET', api('/live/combat'), e.T.dm);
  const j = c.combatants.find((x: any) => x.account_id === e.ID.jess);
  assert.ok(j && j.initiative === 17 && j.is_pc);
  // Damage by the new shapes, and the initiative change.
  const g = await e.ok('POST', api('/live/combatants'), e.T.dm, { name: 'Ogre', initiative: 9, hp: 30, maxHp: 30 });
  const d1 = await ask(e, e.T.dm, 'the Ogre takes 7 (from the flail)');
  await approve(acts(d1.id)[0].id);
  assert.equal((await e.ok('GET', api('/live/combat'), e.T.dm)).combatants.find((x: any) => x.id === g.id).hp, 23);
  const d2 = await ask(e, e.T.dm, 'set Ogre initiative to 3');
  await approve(acts(d2.id)[0].id);
  assert.equal((await e.ok('GET', api('/live/combat'), e.T.dm)).combatants.find((x: any) => x.id === g.id).initiative, 3);
  assert.equal(e.model.seen.length, 0, 'all of it without a model');
  await clearCombat();
});

test('AgentCombat_DeadMonstersAreMarkedDefeatedAndMayBeRemoved', async () => {
  await clearCombat();
  const gob = await e.ok('POST', api('/live/combatants'), e.T.dm, { name: 'Goblin', initiative: 5, hp: 5, maxHp: 5 });
  const pc = await e.ok('POST', api('/live/combatants'), e.T.dm, { name: 'jess', initiative: 5, hp: 3, maxHp: 3, accountId: e.ID.jess });
  const hit = await e.ok('PATCH', api(`/live/combatants/${gob.id}`), e.T.dm, { damage: 9 });
  assert.equal(hit.defeated, true);
  assert.equal(hit.removed, false);
  let c = await e.ok('GET', api('/live/combat'), e.T.dm);
  assert.ok(c.combatants.find((x: any) => x.id === gob.id).effects.some((f: any) => f.name === 'Defeated'));
  // A second hit on a dead one does not mark it again.
  await e.ok('PATCH', api(`/live/combatants/${gob.id}`), e.T.dm, { damage: 1 });
  c = await e.ok('GET', api('/live/combat'), e.T.dm);
  assert.equal(c.combatants.find((x: any) => x.id === gob.id).effects.filter((f: any) => f.name === 'Defeated').length, 1);
  // A player character at 0 is not "defeated" (they roll death saves).
  const pcHit = await e.ok('PATCH', api(`/live/combatants/${pc.id}`), e.T.dm, { damage: 9 });
  assert.equal(pcHit.defeated, false);
  // With the setting on, the monster leaves the tracker.
  await e.ok('PATCH', api('/settings'), e.T.dm, { combatRemoveDefeated: true });
  const orc = await e.ok('POST', api('/live/combatants'), e.T.dm, { name: 'Orc', initiative: 4, hp: 4, maxHp: 4 });
  const gone = await e.ok('PATCH', api(`/live/combatants/${orc.id}`), e.T.dm, { damage: 4 });
  assert.equal(gone.removed, true);
  assert.ok(!(await e.ok('GET', api('/live/combat'), e.T.dm)).combatants.some((x: any) => x.id === orc.id));
  await e.ok('PATCH', api('/settings'), e.T.dm, { combatRemoveDefeated: false });
  await clearCombat();
});

// ---- 4. sound -------------------------------------------------------------------------------------------------

test('AgentSound_ToolDescriptionsListTheMoodsAndLayerKindsTheLibraryHas', async () => {
  e.model.seen.length = 0;
  e.model.queue.push(() => say('Nothing is playing.'));
  await ask(e, e.T.dm, 'play something tense and add some ambient sound');
  const tools = e.model.seen[0].tools;
  const desc = (n: string) => tools.find((t: any) => t.function.name === n)?.function.description ?? '';
  for (const n of ['play_music', 'play_ambience']) {
    assert.match(desc(n), /Moods with a track: [a-z, ]*tense/, n);
    assert.match(desc(n), /Ambience layer kinds: rain, storm/, n);
    assert.match(desc(n), /Music areas: dungeon/, n);
  }
  assert.ok(tools.some((t: any) => t.function.name === 'get_sound_now'), 'get_sound_now is reachable');
});

test('AgentSound_AnUnknownLayerPlaysTheNearestOneAndNoOneOptedInIsSaid', async () => {
  assert.equal(nearestLayer('thunderstorm', ['rain', 'storm']), 'storm');
  assert.equal(nearestLayer('rainfall', ['rain', 'storm']), 'rain');
  assert.equal(nearestLayer('raen', ['rain', 'storm']), 'rain');
  assert.equal(nearestLayer('dragons', ['rain', 'storm']), null);
  const out = await e.ok('POST', api('/sound/ambience/scene'), e.T.dm, { layers: [{ kind: 'thunderstorm', volume: 0.5 }, { kind: 'rainfall' }, { kind: 'dragons' }], target: 'players' });
  assert.deepEqual(out.layers.map((l: any) => l.kind).sort(), ['rain', 'storm']);
  assert.deepEqual(out.matched, [{ asked: 'thunderstorm', used: 'storm' }, { asked: 'rainfall', used: 'rain' }]);
  assert.deepEqual(out.missing, ['dragons']);
  assert.deepEqual(out.available.sort(), ['rain', 'storm']);
  // Nobody has "Allow sound" on: the result says so (the agent tells the DM).
  assert.equal(out.playersHearing, 0);
  assert.match(out.note, /No player has "Allow sound" switched on/);
  const music = await e.ok('POST', api('/sound/music/mood'), e.T.dm, { mood: 'tense', target: 'players' });
  assert.match(music.note, /Allow sound/);
  // Aimed at the table only: nothing to warn about.
  assert.equal((await e.ok('POST', api('/sound/music/mood'), e.T.dm, { mood: 'calm', target: 'table' })).note, undefined);
  // One player opts in.
  await e.ok('PUT', api('/sound/me/switches'), e.T.jess, { device: 'jess-phone-1', music: true, ambience: true });
  const again = await e.ok('POST', api('/sound/ambience/scene'), e.T.dm, { layers: [{ kind: 'rain' }], target: 'players' });
  assert.equal(again.playersHearing, 1);
  assert.equal(again.note, undefined);
  const now = await e.ok('GET', api('/sound/now'), e.T.dm);
  assert.equal(now.playersListening.ambience, 1);
  assert.equal(now.playersListening.sfx, 0);
  // A player's own view says nothing of who listens.
  assert.equal((await e.ok('GET', api('/sound/now'), e.T.jess)).playersListening, undefined);
  await e.ok('PUT', api('/sound/me/switches'), e.T.jess, { device: 'jess-phone-1', music: false, ambience: false });
});

// ---- 5. templates and NPCs ---------------------------------------------------------------------------------------

test('AgentTemplates_CreateTemplateIsADraftTheDmApproves', async () => {
  e.model.seen.length = 0;
  const tpl = { name: 'Harbour ritual', description: 'A rite at the quay', perspective: 'dm', category: 'Story', fields: [{ key: 'place', label: 'Place', type: 'text' }, { key: 'omen', label: 'Omen', type: 'text', gen: 'pick:a gull|a bell|nothing' }], body: 'A ritual at {{place}} with the omen of {{omen}}.' };
  e.model.queue.push(() => toolCall('create_template', tpl), () => say('I drafted the template for you to approve.'));
  const r = await ask(e, e.T.dm, 'Create a new template for a harbour ritual with a place and an omen');
  for (const n of ['list_templates', 'sculpt_templates', 'sculpt', 'create_template']) assert.ok(toolNames(e.model.seen[0]).includes(n), `${n} is offered when templates are mentioned`);
  const a = acts(r.id);
  assert.equal(a.length, 1);
  assert.match(a[0].summary, /Create sculpting template "Harbour ritual" \(2 fields/);
  assert.ok(!(await e.ok('GET', api('/sculpt/templates?compact=1'), e.T.dm)).templates.some((t: any) => t.name === 'Harbour ritual'), 'nothing is saved before approval');
  await approve(a[0].id);
  const list = (await e.ok('GET', api('/sculpt/templates?compact=1'), e.T.dm)).templates;
  assert.ok(list.some((t: any) => t.name === 'Harbour ritual'));
  // A schema that would be refused is sent back to the model with the reason; the DM is never asked to approve it.
  e.model.queue.push(
    () => toolCall('create_template', { name: 'Broken', fields: [{ key: 'Bad Key', type: 'text' }], body: 'x {{dm}} y' }),
    (req) => { assert.match(req.messages.filter((m: any) => m.role === 'tool').at(-1).content, /^Not proposed: .*lowercase/); return say('Let me fix that.'); },
  );
  const b = await ask(e, e.T.dm, 'Create a template named Broken');
  assert.equal(acts(b.id).length, 0);
  assert.ok(!(await e.ok('GET', api('/sculpt/templates?compact=1'), e.T.dm)).templates.some((t: any) => t.name === 'Broken'));
});

// ---- 6. party items --------------------------------------------------------------------------------------------

test('AgentItems_AddItemToThePartyNeedsNoReason', async () => {
  const add = toolsFor(true).find((t) => t.name === 'add_item')!;
  assert.deepEqual(add.call({ owner: 'party', name: 'Brass bell' }).body, { owner: 'party', name: 'Brass bell', reason: 'via the assistant' });
  assert.equal((add.call({ owner: e.ID.jess, name: 'Brass bell' }).body as any).reason, undefined, 'a player\'s item still asks for a reason when the world wants one');
  assert.match(JSON.stringify(add.props.reason), /optional/i);
  e.model.queue.push(() => toolCall('add_item', { owner: 'party', name: 'Brass bell', qty: 1 }), () => say('Proposed the bell.'));
  const r = await ask(e, e.T.dm, 'Put a brass bell in the party pouch');
  const done = await approve(acts(r.id)[0].id);
  assert.equal(done.status, 'done', JSON.stringify(done).slice(0, 300));
  assert.ok((await e.ok('GET', api('/inventory?owner=party'), e.T.dm)).items.some((i: any) => i.name === 'Brass bell'));
});

// ---- 7. broker routing -----------------------------------------------------------------------------------------

const quote = (token: string, question: string) => e.ok('POST', api('/broker/quote'), token, { question, length: 'short' });
const route = (labels: any, answers?: boolean) => (body: any) => {
  const sys = String(body.messages?.[0]?.content ?? '');
  if (/check whether a short text answers/.test(sys)) return { answers };
  return labels;
};

test('AgentBroker_AWhyQuestionWhoseSharedTextDoesNotAnswerItGoesToTheDm', async () => {
  await e.ok('PUT', api('/library/pages'), e.T.dm, { path: 'places/Lighthouse', visibility: 'party', markdown: '# Saltmarsh Lighthouse\nThe Saltmarsh lighthouse has been dark for a month and boats keep to the harbour.\n\n> [!secret] DM\n> The keeper sold the lamp oil to smugglers.\n' });
  // Audit model says: world question, fact, why; and then that the shared text does not answer it.
  e.audit.seen.length = 0;
  e.audit.handler = route({ scope: 'world', intent: 'fact', type: 'why', confidence: 0.9 }, false);
  const q = await quote(e.T.jess, 'Why did the Saltmarsh lighthouse go dark?');
  assert.equal(q.secret, true, JSON.stringify(q).slice(0, 300));
  assert.match(q.line, /ask around/);
  assert.ok(e.audit.seen.every((b) => b.temperature === 0), 'audit calls run at temperature 0');
  const check = e.audit.seen.find((b) => /check whether a short text answers/.test(b.messages[0].content));
  assert.ok(check, 'the relevance check ran');
  assert.ok(!JSON.stringify(check).includes('smugglers'), 'only the player copy is shown to the audit model');
  assert.match(JSON.stringify(check), /dark for a month/);
  // The same question with an audit model that finds an answer is sold.
  e.audit.handler = route({ scope: 'world', intent: 'fact', type: 'why', confidence: 0.9 }, true);
  const ok2 = await quote(e.T.jess, 'Why did the Saltmarsh lighthouse go dark?');
  assert.equal(ok2.secret, false);
  assert.ok(ok2.cost_cp !== null);
});

test('AgentBroker_WithoutAnAuditModelTheRulesDecide', async () => {
  e.audit.handler = undefined;
  // The text only says it is dark: no reason, no lexical cause.
  const q = await quote(e.T.jess, 'Why did the Saltmarsh lighthouse go dark?');
  assert.equal(q.secret, true);
  // A plain fact question about the same page is still answered.
  const fact = await quote(e.T.jess, 'How long has the Saltmarsh lighthouse been dark?');
  assert.equal(fact.secret, false, JSON.stringify(fact).slice(0, 300));
  // A page that does give the reason sells the why.
  await e.ok('PUT', api('/library/pages'), e.T.dm, { path: 'places/Quay bell', visibility: 'party', markdown: '# The quay bell\nThe quay bell stopped ringing because the clapper was stolen during the flood.\n' });
  const why = await quote(e.T.jess, 'Why did the quay bell stop ringing?');
  assert.equal(why.secret, false, JSON.stringify(why).slice(0, 300));
});

test('AgentBroker_AnAllowedRealWorldTopicIsAnsweredFromGeneralKnowledgeNeverFromTheLibrary', async () => {
  await e.ok('PATCH', api('/settings'), e.T.dm, { brokerTopics: ['Medieval history: castles, armour'] });
  e.audit.handler = route({ scope: 'real-world-allowed', intent: 'fact', type: 'what', confidence: 0.9 });
  e.model.seen.length = 0;
  e.model.queue.push(() => say("That's not my trade, but castles had thick walls so siege engines struggled against them."));
  const q = await quote(e.T.jess, 'How thick were medieval castle walls?');
  assert.equal(q.kind, 'other');
  assert.equal(q.cost_cp, 0);
  assert.match(q.line, /not my trade/);
  assert.match(q.answer, /^That's not my trade, but/);
  // The model was given the question and the topic, nothing of the library.
  const sent = JSON.stringify(e.model.seen[0]);
  assert.ok(!/Velmira|smuggler|Saltmarsh|harbour council/i.test(sent), sent.slice(0, 400));
  const ask_ = await e.ok('POST', api('/broker/ask'), e.T.jess, { quoteId: q.quoteId });
  assert.equal(ask_.status, 'answered');
  // No chat model answer (a failure): the old route, a question for the DM.
  e.model.queue.push(() => new Response('no', { status: 500 }));
  const fallback = await quote(e.T.jess, 'How thick were medieval castle walls?');
  assert.notEqual(fallback.kind, 'other');
  await e.ok('PATCH', api('/settings'), e.T.dm, { brokerTopics: [] });
});

// ---- 8. keyword cards for players -------------------------------------------------------------------------------

test('AgentCards_PlayersSeeNoAcHpAbilityScoresOrCrOnMonsterCards', async () => {
  const dragon = encodeURIComponent((await e.ok('GET', api('/modules/terms?q=Adult%20Blue%20Dragon'), e.T.jess)).terms[0].id);
  const dmCard = await e.ok('GET', api(`/modules/card/module/${dragon}`), e.T.dm);
  assert.match(dmCard.text, /\*\*AC\*\*/);
  assert.equal(dmCard.data.abilities.str, 25);
  const pl = await e.ok('GET', api(`/modules/card/module/${dragon}`), e.T.jess);
  assert.ok(!/\*\*AC\*\*|\*\*HP\*\*|\*\*CR\*\*|\| STR \|/.test(pl.text), pl.text.slice(0, 300));
  assert.ok(!/(AC|HP|CR) \d/.test(pl.summary), pl.summary);
  for (const k of ['ac', 'hp', 'cr', 'abilities']) assert.equal(pl.data[k], undefined, k);
  assert.ok(pl.data.actions.length > 0, 'what it does is still shown');
  // The rules search a player's assistant uses is cleaned the same way.
  const hits = (await e.ok('GET', api('/modules/rules/search?q=Adult%20Blue%20Dragon&limit=2'), e.T.jess)).results;
  assert.ok(hits.every((h: any) => !/\*\*AC\*\*|\| STR \|/.test(h.passage)));
  // With monster health shown exactly, the HP comes back (never AC, scores or CR).
  await e.ok('PATCH', api('/settings'), e.T.dm, { monsterHealth: 'exact' });
  const ex = await e.ok('GET', api(`/modules/card/module/${dragon}`), e.T.jess);
  assert.ok(ex.data.hp > 0 && ex.data.ac === undefined && ex.data.abilities === undefined);
  await e.ok('PATCH', api('/settings'), e.T.dm, { monsterHealth: 'words' });
});

test('AgentCards_CommonItemWordsDoNotHighlightButTheFullNameDoes', async () => {
  const dm = { accountId: e.ID.dm, role: 'dm' } as any;
  const find = (text: string) => findMatches(e.deps.db, W, dm, text).map((m) => m.text);
  const text = 'The bell tolled and he fumbled in his pouch for a rope, but the Bell of Opening was gone.';
  const found = find(text);
  assert.ok(!found.some((t) => /^(bell|pouch|rope)$/i.test(t)), `common words lit up: ${found.join(', ')}`);
  assert.ok(find('He carried a Bag of Holding.').includes('Bag of Holding'), 'a full item name still matches');
  // Capital letters alone are not enough for a stoplist word, but a rarer one-word item still needs one.
  assert.ok(!find('Bell').includes('Bell'));
  assert.ok(!find('he lit the lamp').some((t) => /lamp/i.test(t)));
  // A world page called "Bell" is the world's own and does match.
  await e.ok('PUT', api('/library/pages'), e.T.dm, { path: 'items/Bell', visibility: 'party', markdown: '# Bell\nThe drowned bell of Saltmarsh.\n' });
  assert.ok(findMatches(e.deps.db, W, { accountId: e.ID.jess, role: 'player' } as any, 'They rang the Bell at dusk.').some((m) => m.source === 'library'));
});

// ---- 9. the leak gate ---------------------------------------------------------------------------------------------

test('AgentLeakGate_APublicFactIsNotAnEightWordLeakButASecretStillIs', async () => {
  await e.ok('PUT', api('/library/pages'), e.T.dm, { path: 'dm/Campaign Status', visibility: 'dm', markdown: '# Campaign Status\nThe quiet harbour lighthouse has been dark for a month because Velmira bribed the keeper with crates of black powder.\n' });
  await e.ok('PUT', api('/library/pages'), e.T.dm, { path: 'places/Quiet harbour', visibility: 'party', markdown: '# Quiet harbour\nIts quiet harbour lighthouse has been dark for a month.\n' });
  const check = leakChecker(e.deps.db, W);
  assert.equal(check('Locals say the quiet harbour lighthouse has been dark for a month, and nobody can say why.').blocked, false);
  assert.equal(check('The quiet harbour lighthouse has been dark for a month now.').blocked, false);
  const secret = check('The keeper took the bribe because Velmira bribed the keeper with crates of black powder.');
  assert.equal(secret.blocked, true, 'the secret part is still held');
});

test('AgentLeakGate_PersonaDenialsPassButAffirmationsAreHeld', () => {
  for (const ok_ of ["I'm not Minerva.", 'I do not work for the DM, I trade in rumours.', "I don't have any DM notes.", 'There is no DM assistant here, friend.', "Nobody called Minerva has told me anything."]) assert.equal(personaGiveaway(ok_), null, ok_);
  for (const bad of ["I'm Minerva, the keeper of records.", 'I work for the DM.', "Minerva told me you would ask.", "The DM's assistant says no.", 'There is no secret. I work for the dungeon master.', "I'm not sure. Minerva knows."]) assert.ok(personaGiveaway(bad), bad);
  assert.equal(personaGiveaway('Not that I know of. I am Tideglass.', 'Tideglass') !== null, true, 'a renamed assistant named plainly is held');
  assert.equal(personaGiveaway('I am not Tideglass.', 'Tideglass'), null);
});

// ---- 10. Minerva: no DM analysis on a page the players can read --------------------------------------------------

test('AgentMinerva_CodexAnalysisOnAPartyPageGoesInASecretBlockAndNoPlayerSeesIt', async () => {
  await e.ok('POST', api('/minerva/enable'), e.T.dm, {});
  const HOOK = 'Hook aimed at Jessamine: the dockhand will pay unless she keeps her promise, and Velmira hears of any broken oath.';
  // The Anselm case: a player character's page is party level; her analysis is proposed and approved.
  e.model.queue.push(() => toolCall('codex_upsert', { name: 'jess', kind: 'pc', section: 'notes', text: HOOK }), () => say('Proposed the hook on her page.'));
  const r = await ask(e, e.T.dm, 'Log the promise Jess made as a hook for her character');
  const a = acts(r.id)[0];
  assert.match(a.summary, /DM-only block on a level party page/, a.summary);
  assert.ok(!/Visible to players/.test(a.summary));
  await approve(a.id);
  const page = await e.ok('GET', api(`/minerva/page?rel=${encodeURIComponent('codex/characters/pc/jess.md')}`), e.T.dm);
  assert.equal(page.level, 'party');
  assert.match(page.body, /> \[!secret\]\n> .*dockhand will pay/);
  for (const who of ['jess', 'tom']) {
    const ctx = JSON.stringify(await e.ok('GET', api('/minerva/me/context'), e.T[who]));
    assert.ok(!/dockhand|Velmira|oath/.test(ctx), `${who} sees the hook in /minerva/me/context`);
  }
  // Nor does the broker's gate treat it as public text: repeating it is blocked.
  assert.equal(leakChecker(e.deps.db, W)('Hook aimed at Jessamine: the dockhand will pay unless she keeps her promise, and Velmira hears of any broken oath.').blocked, true);
  // Only when the DM says it is for the players does it go in the open, and the card says so in red words.
  e.model.queue.push(() => toolCall('codex_upsert', { name: 'jess', kind: 'pc', section: 'appearances', text: 'Helped the dockhand at the quay.', visible: true }), () => say('Proposed.'));
  const v = await ask(e, e.T.dm, 'Add to Jess\'s page that she helped the dockhand, for the players to read');
  const va = acts(v.id)[0];
  assert.match(va.summary, /Visible to players \(level party\)/);
  await approve(va.id);
  assert.match(JSON.stringify(await e.ok('GET', api('/minerva/me/context'), e.T.tom)), /Helped the dockhand at the quay/);
  // The Minerva review card for a codex draft carries the same fact.
  const dr = (await e.ok('POST', api('/minerva/codex'), e.T.dm, { name: 'jess', section: 'notes', text: 'another note' }));
  assert.equal(dr.visibleToPlayers, false);
  assert.equal(dr.level, 'party');
  // An NPC page the DM has not opened to the party stays plain DM text.
  const npc = await e.ok('POST', api('/minerva/codex'), e.T.dm, { name: 'Marla Tuck', kind: 'npc', section: 'notes', text: 'Wants the keeper gone.' });
  assert.equal(npc.level, 'dm');
  assert.match((await e.ok('GET', api(`/minerva/page?rel=${encodeURIComponent(npc.rel)}`), e.T.dm)).body, /- Wants the keeper gone\./);
});

// ---- 11. live help ------------------------------------------------------------------------------------------------

let lineN = 100;
const addLine = (speaker: string | null, label: string, text: string, audience: 'players' | 'dm', at = new Date().toISOString()) => {
  lineN += 1;
  run(e.deps.db, `INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_account, speaker_label, text, audience, updated_at) VALUES (?, 'as_1', ?, ?, ?, ?, ?, ?, ?, ?)`, `ln_${lineN}`, W, lineN * 1000, lineN * 1000 + 800, speaker, label, text, audience, at);
};

test('AgentLive_TheHarnessCarriesTheLastLinesOfARunningSessionAndNeverTheOtherSide', async () => {
  const DM_SECRET_LINE = 'The vault code is seven seven three nine and nobody must learn it yet';
  const CLASSIFIED = 'the sunken bell opens only when three silver keys turn together at ebb tide';
  await e.ok('PUT', api('/library/pages'), e.T.dm, { path: 'dm/Sealed bell', visibility: 'classified', markdown: `# Sealed bell\n${CLASSIFIED}.\n` });
  addLine(e.ID.jess, 'jess', 'We should ask the harbourmaster about the lamp', 'players');
  addLine(null, 'DM', 'Whisper: the harbourmaster is secretly the keeper brother', 'dm');
  addLine(e.ID.tom, 'tom', CLASSIFIED, 'players');
  e.model.seen.length = 0;
  e.model.queue.push(() => say('Nothing yet.'), () => say('Nothing yet.'));
  await ask(e, e.T.dm, 'Did the table just find a clue?');
  await ask(e, e.T.jess, 'What did we just say?');
  const dmCtx = JSON.stringify(e.model.seen[0].messages.at(-1));
  const plCtx = JSON.stringify(e.model.seen[1].messages.at(-1));
  assert.match(dmCtx, /Live transcript/);
  assert.match(dmCtx, /ask the harbourmaster about the lamp/);
  assert.match(dmCtx, /secretly the keeper brother/, 'the DM sees the DM-visible lines');
  assert.match(plCtx, /Live transcript/);
  assert.match(plCtx, /ask the harbourmaster about the lamp/);
  assert.ok(!/secretly the keeper brother|vault code/.test(plCtx), 'a player gets the players\' lines only');
  assert.ok(!dmCtx.includes('three silver keys') && !plCtx.includes('three silver keys'), 'classified text is never sent');
  assert.ok(liveLines(e.deps, W, true, 20).lines.length <= 20);
});

test('AgentLive_SuggestionsLandInTheReviewQueueLowAndAreRateLimited', async () => {
  // A mystery with a clue, a promise and a new NPC named twice.
  await e.ok('POST', api('/minerva/revelations'), e.T.dm, { title: 'Who took the lamp oil?', conclusion: 'The keeper did.', clues: ['A silver ring engraved with a grey heron lies in the keeper cellar', 'Oil barrels were rolled to the east quay at night', 'The keeper bought a new boat in autumn'] });
  const t = new Date().toISOString();
  addLine(e.ID.jess, 'jess', 'I found a silver ring engraved with a grey heron in the keeper cellar', 'players', t);
  addLine(e.ID.tom, 'tom', 'We should talk to Bram Oakes about the boat', 'players', t);
  addLine(e.ID.tom, 'tom', 'I think Bram Oakes lied to us', 'players', t);
  addLine(e.ID.jess, 'jess', 'I promise I will protect the dockhand if he tells the council', 'players', t);
  e.audit.seen.length = 0;
  e.audit.handler = (body: any) => ({ keep: [0, 1, 2, 3, 4, 5] });
  const first = await suggestionPass(e.deps, W);
  assert.equal(first.ran, true);
  assert.ok(first.drafted >= 3, JSON.stringify(first));
  const review = await e.ok('GET', api('/minerva/review'), e.T.dm);
  const sug = review.drafts.filter((x: any) => x.kind.startsWith('suggest-'));
  const kinds = new Set(sug.map((x: any) => x.kind));
  for (const k of ['suggest-clue', 'suggest-npc', 'suggest-goal']) assert.ok(kinds.has(k), `${k} in ${[...kinds]}`);
  assert.match(sug.find((x: any) => x.kind === 'suggest-clue').title, /jess may have found a clue of "Who took the lamp oil\?"/);
  assert.equal(sug.find((x: any) => x.kind === 'suggest-clue').op.op, 'mark');
  assert.match(sug.find((x: any) => x.kind === 'suggest-npc').title, /Bram Oakes/);
  // Low priority: they come after every other draft, and nothing was applied.
  const last = review.drafts.map((x: any) => x.kind.startsWith('suggest-'));
  assert.equal(last.indexOf(false) === -1 || last.lastIndexOf(false) < last.indexOf(true), true);
  assert.ok(!JSON.stringify(await e.ok('GET', api('/minerva/revelations'), e.T.dm)).includes('"accountId":"' + e.ID.jess + '","name":"jess","session"'), 'the clue was not marked by itself');
  // The model saw DM-visible lines but never classified text or players' private notes.
  assert.ok(e.audit.seen.length >= 1 && !JSON.stringify(e.audit.seen).includes('three silver keys'));
  // Rate limit: a new line right away does nothing; after two minutes (or 30 lines) it runs, and nothing is suggested twice.
  addLine(e.ID.tom, 'tom', 'Bram Oakes is hiding something', 'players');
  assert.deepEqual(await suggestionPass(e.deps, W), { ran: false, reason: 'Too soon', lines: 1, drafted: 0 });
  const later = await suggestionPass(e.deps, W, { at: Date.now() + 3 * 60_000 });
  assert.equal(later.ran, true);
  assert.equal(later.drafted, 0, 'the same suggestions are not made twice');
  for (let i = 0; i < LIVE_LINES; i++) addLine(e.ID.tom, 'tom', `Another line about the weather number ${i}`, 'players');
  assert.equal((await suggestionPass(e.deps, W)).ran, true, 'thirty new lines run it at once');
  // Nothing new: nothing to do. A forced run (the DM\'s button) with no new lines is also a no-op.
  assert.equal((await suggestionPass(e.deps, W, { force: true })).ran, false);
  // A line stamped in the same millisecond as the last line read is still new (it was skipped as "No new lines" on a fast machine).
  const lastAt = (all<any>(e.deps.db, "SELECT MAX(updated_at) AS t FROM audio_lines WHERE session_id = 'as_1'")[0]).t as string;
  addLine(e.ID.tom, 'tom', 'Same millisecond line about Bram Oakes', 'players', lastAt);
  assert.deepEqual(await suggestionPass(e.deps, W, { force: true }).then((r) => [r.ran, r.lines]), [true, 1]);
  assert.equal((await suggestionPass(e.deps, W, { force: true })).ran, false, 'and read once only');
  // The DM's button.
  addLine(e.ID.jess, 'jess', 'I will protect Brask the dockhand with my life', 'players');
  assert.equal((await e.ok('POST', api('/minerva/live/suggest'), e.T.dm, {})).ran, true);
  // A player cannot ask for it, and no suggestion shows in a player's view.
  assert.equal((await e.call('POST', api('/minerva/live/suggest'), e.T.jess, {})).status, 403);
  assert.ok(!/Bram Oakes|suggest-/.test(JSON.stringify(await e.ok('GET', api('/minerva/me'), e.T.jess))));
  // A suggestion is applied only when the DM approves it.
  const clue = sug.find((x: any) => x.kind === 'suggest-clue');
  await e.ok('POST', api(`/minerva/review/${clue.id}`), e.T.dm, { decision: 'approve' });
  assert.ok(JSON.stringify(await e.ok('GET', api('/minerva/revelations'), e.T.dm)).includes('jess'));
  e.audit.handler = undefined;
});

// ---- 12. review drafts after a session ---------------------------------------------------------------------------

test('AgentReview_ActivityIsDetectedFromMostOfATitlesWords', () => {
  assert.equal(hadActivity('The darkened lamp', 'They talked about the lamp that was darkened on purpose.'), true);
  assert.equal(hadActivity('The drowned bell', 'Nothing about the harbour was said.'), false);
  assert.equal(hadActivity('Velmira', 'We heard velmira is coming.'), true);
});

test('AgentReview_AfterSessionDraftsAppendNeverCoolAnActiveHookPromoteOnlyNamedPeopleAndUseTheTableNumber', async () => {
  // Two hooks that are on: one came up this session, the other did not.
  await e.ok('PUT', api('/minerva/page'), e.T.dm, { rel: 'dm/hooks/The darkened lamp.md', body: '# The darkened lamp\nWhy was it put out?\n', heat: 'on' });
  await e.ok('PUT', api('/minerva/page'), e.T.dm, { rel: 'dm/hooks/The drowned bell.md', body: '# The drowned bell\nWho rings it?\n', heat: 'on' });
  // An old NPC that is a promotion candidate (in an active hook) but was not in this session, and a status section the DM wrote.
  await e.ok('PUT', api('/minerva/page'), e.T.dm, { rel: 'dm/state/Campaign Status.md', body: '# Campaign Status\n\n## What changed last session\n- The DM wrote this and it stays.\n\n## Next session\n- Visit the quay.\n' });
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const draft = await e.ok('POST', api('/sessionlog/drafts'), e.T.dm, { from, to: new Date().toISOString(), title: 'The dark lamp' });
  await e.ok('PUT', api(`/sessionlog/drafts/${draft.id}`), e.T.dm, { markdown: '## Recap\n- The party spoke of the lamp, who darkened it and why.\n\n## Key moments\n- The keeper admitted it.\n\n## People met\n- Nell Harrow: a net mender\n- Captain Brask: the harbour captain\n\n## Open threads\n- Who paid the keeper?\n' });
  await e.ok('POST', api(`/sessionlog/drafts/${draft.id}/publish`), e.T.dm, {});
  await until(() => !!one(e.deps.db, 'SELECT 1 FROM minerva_sessions WHERE world_id = ?', W), 'the session was filed');
  await until(() => (one<any>(e.deps.db, `SELECT COUNT(*) AS n FROM minerva_drafts WHERE world_id = ? AND review LIKE 'session-%'`, W)?.n ?? 0) > 3, 'drafts made');
  const filed = one<any>(e.deps.db, 'SELECT * FROM minerva_sessions WHERE world_id = ?', W);
  const rv = await e.ok('GET', api('/minerva/review'), e.T.dm);
  const mine = rv.drafts.filter((x: any) => x.review === `session-${filed.number}`);
  // Status drafts add to the section.
  const status = mine.filter((x: any) => x.kind === 'status' && x.op.op === 'section');
  assert.ok(status.length >= 1 && status.every((x: any) => x.op.mode === 'append'), JSON.stringify(status.map((x: any) => x.op)));
  const st = status.find((x: any) => /what changed/i.test(x.title));
  assert.match(st.preview.after, /The DM wrote this and it stays\./);
  assert.match(st.preview.after, /The keeper admitted it/);
  // The hook that came up is raised and never lowered; the one that did not cools a step.
  const heat = (n: string) => mine.find((x: any) => x.kind === 'heat' && x.title.includes(n));
  assert.equal(heat('darkened lamp'), undefined, 'an active hook that is already on is left alone');
  assert.match(heat('drowned bell').title, /on to ongoing/);
  // People the session named get a draft; people it did not name do not.
  const promos = mine.filter((x: any) => x.kind === 'promote').map((x: any) => x.title).join(' | ');
  assert.match(promos, /Nell Harrow/);
  assert.match(promos, /Captain Brask/);
  assert.ok(!/Velmira|Mara Quill/.test(promos), promos);
  // The table's number is the session record's number.
  assert.match(mine[0].review, new RegExp(`session-${filed.number}$`));
  const entry = one<any>(e.deps.db, 'SELECT number FROM sessionlog_entries WHERE world_id = ?', W);
  assert.equal(filed.number, entry.number);
  // A recording the table named "Session 22" makes the session in progress number 22.
  run(e.deps.db, `INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES ('as_22', ?, 'Session 22', ?)`, W, new Date(Date.now() + 1000).toISOString());
  assert.equal(currentSession(e.deps.db, W), 22);
  run(e.deps.db, `DELETE FROM audio_sessions WHERE id = 'as_22'`);
});

// ---- 13. prep ---------------------------------------------------------------------------------------------------

test('AgentPrep_ThePrepContextCarriesTheStatusTheArcAndTheLastSessionAndTheModelNeedsFewSearches', async () => {
  e.model.seen.length = 0;
  e.model.queue.push(() => say('Here is a prep outline.'));
  const t0 = performance.now();
  const r = await ask(e, e.T.dm, 'Prep next session for me: strong start, scenes and what to prepare');
  const ctx = e.model.seen[0].messages.at(-1).content as string;
  assert.match(ctx, /Prefetched for prep/);
  assert.match(ctx, /## Campaign Status/);
  assert.match(ctx, /## Last session/);
  assert.match(ctx, /The keeper admitted it/);
  assert.ok(!ctx.includes('three silver keys'), 'no classified text');
  assert.equal(e.model.seen.length, 1, 'one model round');
  assert.ok(performance.now() - t0 < 5000);
  assert.equal(r.reply.text, 'Here is a prep outline.');
  // A player's context has none of it.
  e.model.queue.push(() => say('Fine.'));
  await ask(e, e.T.jess, 'Prep next session for me: what should I do');
  assert.ok(!/Prefetched for prep|Campaign Status/.test(JSON.stringify(e.model.seen.at(-1).messages)));
});

test('AgentFixes_QuotedToolOutputIsNotAClaimAndTheRealDateIsKnown', async () => {
  const { claimSentences } = await import('../src/features/agent/moretools.ts');
  const { realToday } = await import('../src/features/agent/harness.ts');
  const draft = '## Recap\nTomas proposed a toast to the harbour council before the storm.\n';
  const reply = 'Here is the draft in full:\n\nTomas proposed a toast to the harbour council before the storm.';
  assert.equal(claimSentences(reply).length, 1, 'without the tool output it looks like a claim');
  assert.equal(claimSentences(reply, draft).length, 0, 'copied from what the tool returned: data, not a claim');
  assert.equal(claimSentences('> I proposed nothing new, this is a quote').length, 0, 'quoted blocks are skipped');
  assert.equal(claimSentences('I proposed moving the dagger to Tomas.', draft).length, 1, 'its own claim still counts');
  assert.match(realToday(new Date('2026-11-20T14:05:00Z')), /^Friday 2026-11-20 \d\d:\d\d /);
});

test('AgentCards_SpokenRulesTermsMatchRunTogetherAndLowerCaseConditions', async () => {
  const dm = { accountId: e.ID.dm, role: 'dm' } as any;
  const terms = (text: string, spoken = false) => findMatches(e.deps.db, W, dm, text, { spoken }).filter((m) => m.source === 'module').map((m) => m.term);
  assert.ok(terms('I cast counter spell on him!').includes('Counterspell'), 'two words for a one-word spell');
  assert.ok(terms('She casts Misty-Step away').some((t) => /misty step/i.test(t)));
  assert.ok(!terms('the mage is grappled now').some((t) => /grappled/i.test(t)), 'a page or a note: lower case stays plain');
  assert.ok(terms('the mage is grappled now', true).some((t) => /grappled/i.test(t)), 'said at the table: the condition');
  assert.ok(!terms('he lit a fire and felt cold', true).length, 'everyday words stay plain even when spoken');
  const { rulesSaid } = await import('../src/features/agent/harness.ts');
  const block = rulesSaid(e.deps, { worldId: W, viewer: dm } as any, 'Jessamine: I cast counter spell!\nDM: the mage is grappled');
  assert.match(block, /Counterspell \(spell\)/);
  assert.match(block, /Grappled \(condition\)/);
});

test('AgentBudget_ContextScalesWithTheModelWindowAndRequestsAreFitted', async () => {
  const { budgetFrom, fitToBudget } = await import('../src/features/agent/harness.ts');
  assert.equal(budgetFrom().liveLines, 20, 'unset: the sizes Alexandria always used');
  assert.ok(budgetFrom(8_000).liveLines < 20 && budgetFrom(8_000).toolChars < 12_000, 'a small local model gets less');
  assert.ok(budgetFrom(128_000).liveLines > 20);
  assert.ok(budgetFrom(1_000_000).liveLines >= 3000, 'a 1M model gets the whole night');
  const big = 'x'.repeat(20_000);
  const msgs: any[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_page', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: big }, { role: 'user', content: 'now' }];
  const fit = fitToBudget(msgs, 4000);
  assert.equal(fit[0].content, 'sys');
  assert.equal(fit.at(-1).content, 'now');
  assert.ok(JSON.stringify(fit).length < 4000 * 3, 'inside the window');
  assert.ok(fit.some((m: any) => m.role === 'tool'), 'a tool reply keeps its place next to its call');
  assert.deepEqual(fitToBudget(msgs, 1_000_000), msgs, 'nothing changes when it fits');
});
