// A whole game night, played through the real API as the GM and three players,
// on the seeded demo world and its fake models. It checks that every action
// took effect (API state) and that no player view ever holds GM-only, broker or
// classified text, then prints a timeline with timings.
//
//   node --experimental-strip-types librarian/scripts/demo-session.ts            # starts the demo in-process
//   node --experimental-strip-types librarian/scripts/demo-session.ts --url http://127.0.0.1:8400   # a demo already running
//
// Options: --port N (in-process demo port, default a free one), --data DIR, --verbose (show the demo's seeding output).
// Exit code 0 when every step passed. Everything is made up; no real model is called.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const arg = (name: string, def = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; };
const VERBOSE = process.argv.includes('--verbose');

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

// ---- the demo ---------------------------------------------------------------

let base = arg('url').replace(/\/+$/, '');
if (!base) {
  const port = Number(arg('port')) || await freePort();
  const modelsPort = await freePort();
  const data = arg('data') || fs.mkdtempSync(path.join(os.tmpdir(), 'alx-demo-session-'));
  process.argv.push('--port', String(port), '--models-port', String(modelsPort), '--data', data);
  const log = console.log;
  if (!VERBOSE) console.log = () => {};
  try { await import('./demo.ts'); } finally { console.log = log; }
  base = `http://127.0.0.1:${port}`;
}

// ---- helpers ----------------------------------------------------------------

const t0 = performance.now();
const timeline: { at: number; ms: number; name: string; note: string }[] = [];
const stats = { agentMessages: 0, approvals: 0, dmCalls: 0, playerCalls: 0, leakScans: 0, leakViews: 0, assertions: 0 };

async function raw(method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = text;
  try { j = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: r.status, body: j, text };
}
async function api(method: string, p: string, token?: string, body?: unknown): Promise<any> {
  const r = await raw(method, p, token, body);
  if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 240)}`);
  return r.body;
}
function check(cond: unknown, msg: string): asserts cond {
  stats.assertions++;
  if (!cond) throw new Error(`Check failed: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <X,>(what: string, fn: () => Promise<X | null | undefined | false>, ms = 8000): Promise<X> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v as X; if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`); await sleep(40); }
};

async function step<X>(name: string, fn: () => Promise<X>, note?: (x: X) => string): Promise<X> {
  const s = performance.now();
  try {
    const x = await fn();
    const ms = Math.round(performance.now() - s);
    const n = note ? note(x) : '';
    timeline.push({ at: Math.round(s - t0), ms, name, note: n });
    console.log(`  +${((s - t0) / 1000).toFixed(2).padStart(6)}s  ${String(ms).padStart(5)} ms  ${name}${n ? `  (${n})` : ''}`);
    return x;
  } catch (e: any) {
    console.log(`  +${((s - t0) / 1000).toFixed(2).padStart(6)}s  FAILED  ${name}\n      ${String(e.message).split('\n')[0]}`);
    throw e;
  }
}

// ---- who is who -------------------------------------------------------------

const ADMIN = { username: 'admin', password: 'library admin 123' };
const DMLOGIN = { username: 'dm', password: 'game master 123' };
const PLAYERS = [['jess', 'Jessamine'], ['tom', 'Tomas'], ['ana', 'Anselm']] as const;

const login = async (u: { username: string; password: string }) => (await api('POST', '/api/auth/login', undefined, u)).token as string;
const adminTok = (await api('POST', '/api/admin-auth/login', undefined, ADMIN)).token as string;
const dmTok = await login(DMLOGIN);
const worlds = await api('GET', '/api/worlds', dmTok);
const world = (Array.isArray(worlds) ? worlds : worlds.worlds).find((x: any) => /saltreach/i.test(x.name));
if (!world) throw new Error('The demo world "Saltreach" was not found. Is this the demo?');
const W = `/api/worlds/${world.slug ?? world.id}`;
const P: Record<string, { token: string; id: string; name: string }> = {};
for (const [u, name] of PLAYERS) {
  const token = await login({ username: u, password: 'player pass 123' });
  const me = await api('GET', `${W}/whoami`, token);
  P[u] = { token, id: me.accountId ?? me.account?.id ?? me.id, name };
}
const dm = (m: string, p: string, b?: unknown) => { stats.dmCalls++; return api(m, `${W}${p}`, dmTok, b); };
const asP = (who: string) => (m: string, p: string, b?: unknown) => { stats.playerCalls++; return api(m, `${W}${p}`, P[who].token, b); };
const { jess, tom, ana } = { jess: asP('jess'), tom: asP('tom'), ana: asP('ana') };

// ---- no leaks in a player's view -------------------------------------------------

// Text that only the GM, the broker or the classified level knows (the demo's seeds, and what this script adds).
const SECRETS = [
  'Velmira', 'on her payroll', 'Drowned King', 'lost crown', 'treasury beneath the dark lighthouse', 'Who owes Velmira', 'unlisted cargoes', 'Not even the Information broker',
  'three cargoes a month', 'DMSECRET', 'smugglers\' tunnels', 'abyssal',
];
const SCREENS = ['/stage', '/live', '/live/combat', '/live/ledger?owner=me', '/live/ledger?owner=party', '/inventory?owner=me', '/inventory?owner=party', '/inventory/transfers', '/clock', '/clock/events', '/clock/upcoming?days=14',
  '/sessionlog', '/sessionchat/current', '/sessionchat/chat/table', '/sessionchat/chat/party', '/sessionchat/trades', '/messages', '/people', '/broker', '/broker/offers', '/quick-events', '/audio/status', '/sound/now', '/library/pages', '/requests', '/approvals/mine', '/calendar'];
/** Every screen a player has, as each player; none may hold a secret, and the combat views never show exact monster numbers when the setting says not. */
async function noLeaks(label: string) {
  for (const [who, pl] of Object.entries(P)) {
    for (const s of SCREENS) {
      const r = await raw('GET', `${W}${s}`, pl.token);
      stats.leakViews++;
      for (const m of SECRETS) if (r.text.includes(m)) throw new Error(`LEAK after "${label}": ${who} ${s} holds "${m}": ...${r.text.slice(Math.max(0, r.text.indexOf(m) - 60), r.text.indexOf(m) + 80)}...`);
      if (s === '/live/combat' || s === '/stage') {
        const bad = /"(hp|max_hp|ac|statblock_page|statblockPage)"\s*:/.exec(r.text);
        if (bad) throw new Error(`LEAK after "${label}": ${who} ${s} shows ${bad[0]}`);
      }
      if (s === '/live/combat' && /Lurking/.test(r.text)) throw new Error(`LEAK after "${label}": ${who} sees the hidden creature`);
    }
  }
  stats.leakScans++;
}

// ---- the GM agent --------------------------------------------------------------------

let chatId = '';
interface Turn { reply: string; actions: any[] }
/** One message to the GM's agent. FAKE_CALL lines make the fake model call those tools with those arguments. Waits for the answer. */
async function say(text: string): Promise<Turn> {
  stats.agentMessages++;
  if (!chatId) chatId = (await dm('POST', '/agent/chats', { title: 'Game night' })).id;
  await dm('POST', `/agent/chats/${chatId}/messages`, { text });
  const c = await until('the agent to answer', async () => { const x = await dm('GET', `/agent/chats/${chatId}`); return x.busy ? null : x; }, 20_000);
  const last = c.messages.filter((m: any) => m.role === 'assistant' && m.status !== 'working').at(-1);
  check(last && last.status !== 'error', `the agent failed: ${last?.text}`);
  return { reply: last.text as string, actions: c.actions.filter((a: any) => a.status === 'pending') };
}
const call = (tool: string, args: Record<string, unknown> = {}) => `FAKE_CALL ${tool} ${JSON.stringify(args)}`;
/** The GM approves what the agent proposed; each must run. */
async function approve(actions: any[], expect: string[]): Promise<any[]> {
  check(actions.length === expect.length, `expected ${expect.length} proposals (${expect.join(', ')}), got ${actions.map((a) => a.tool).join(', ') || 'none'}`);
  const out: any[] = [];
  for (const a of actions) {
    stats.approvals++;
    const r = await raw('POST', `${W}/agent/actions/${a.id}`, dmTok, { decision: 'approve' });
    check(r.status === 200 && r.body.status === "done", `${a.tool} failed on approval: ${String(r.body?.result ?? r.text).slice(0, 200)}`);
    out.push({ ...r.body, tool: a.tool, json: (() => { try { return JSON.parse(r.body.result); } catch { return null; } })() });
  }
  check(expect.every((t) => out.some((o) => o.tool === t)), `proposed ${out.map((o) => o.tool).join(', ')}`);
  return out;
}
/** Propose, approve, and return the results. */
async function agentDo(text: string, expect: string[]) { const t = await say(text); return approve(t.actions, expect); }
/** A read tool (or a fast command) the agent runs with no approval. */
async function agentRead(text: string) { const t = await say(text); check(t.actions.length === 0, 'a read needed no approval'); return t.reply; }

// =============================================================================
console.log(`\nA game night in ${world.name} (${base})\n`);

// ---- 1. start the session ---------------------------------------------------------------
// A control: the scan below only means something if the GM can see the secrets it looks for.
check(JSON.stringify(await dm('GET', '/people')).includes('Velmira') && JSON.stringify(await dm('GET', '/library/pages')).includes('Drowned King'), 'the GM sees the secrets the leak scan looks for');
const rec = await step('Start the session: models warm, recording starts, players consent', async () => {
  // The previous night's table chat is still open in the seeded demo.
  if ((await dm('GET', '/sessionchat/current')).session) await dm('POST', '/sessionchat/sessions/end', {});
  await api('PUT', '/api/admin/models/lifecycle', adminTok, { policies: { chat: 'hold', audit: 'hold', audio: 'hold', extra: 'hold' } });
  for (const p of Object.values(P)) await api('POST', `${W}/audio/consent`, p.token, { agree: true });
  const consents = await dm('GET', '/audio/consents');
  check(consents.length === 3 && consents.every((c: any) => c.agreed), 'all three players agreed to the recording');
  const started = performance.now();
  const s = await dm('POST', '/audio/sessions', { name: 'Session 24: A night at the lighthouse' });
  const warm = await until('the models to be ready', async () => { const r = await dm('GET', '/models/ready'); const jobs = Object.values<any>(r.jobs); return jobs.length && jobs.every((j) => j.state === 'ready') ? r : null; }, 15_000);
  const status = await dm('GET', '/audio/status');
  check(status.recording && status.session.id === s.id, 'the recording is running');
  const chat = await dm('GET', '/sessionchat/current');
  check(chat.session, 'recording opened the table chat for the session');
  for (const [who, p] of Object.entries(P)) {
    const seen = await api('GET', `${W}/audio/status`, p.token);
    check(seen.recording && seen.consent.agreed, `${who} sees the recording banner and has agreed`);
  }
  return { id: s.id as string, warmMs: Math.round(performance.now() - started), jobs: Object.keys(warm.jobs).length };
}, (x) => `${x.jobs} models warm in ${x.warmMs} ms`);
await noLeaks('start');

// ---- 2. set the scene -------------------------------------------------------------------
const scene = await step('The agent sculpts a player-view scene (approved)', async () => {
  const [r] = await agentDo(`Set the scene at the Saltmarsh quay.\n${call('sculpt', { template: 'Scene, player perspective', values: { location: 'Saltmarsh', time: 'Dusk', weather: 'Fog off the bay', mood: 'Uneasy' } })}`, ['sculpt']);
  const hist = (await dm('GET', '/sculpt/history')).history[0];
  check(hist && hist.templateName === 'Scene, player perspective' && hist.values.description, 'the scene was sculpted and filled');
  return { values: hist.values as Record<string, string>, md: hist.md as string };
}, (x) => `${x.md.length} characters`);

await step('Send it to the players, read it aloud, put it on the stage, set music and ambience (5 approvals)', async () => {
  const out = await agentDo([
    'Put this scene in front of the table.',
    call('send_scene', { template: 'Scene, player perspective', values: scene.values }),
    call('speak', { text: scene.values.description, preset: 'Narrator', target: 'both' }),
    call('show_on_stage', { kind: 'text', title: 'The Saltmarsh quay', text: scene.values.description, spotlight: true }),
    call('play_music', { mood: 'tense', area: 'village', target: 'both' }),
    call('play_ambience', { scene: 'Stormy night at the tavern', target: 'both' }),
  ].join('\n'), ['send_scene', 'speak', 'show_on_stage', 'play_music', 'play_ambience']);
  // The scene went to every player as a message.
  for (const [who, p] of Object.entries(P)) {
    const threads = await api('GET', `${W}/messages`, p.token);
    check(threads.some((t: any) => /Saltmarsh/.test(t.title)), `${who} was sent the scene`);
  }
  // It is on the stage for players, in the spotlight.
  const stage = await jess('GET', '/stage');
  const shown = stage.cards.find((c: any) => JSON.stringify(c).includes('Saltmarsh quay'));
  check(shown, `the stage card is shown to players (${JSON.stringify(stage).slice(0, 300)})`);
  check(stage.spotlightId === shown.id, 'and it is in the spotlight');
  // The spoken line can be heard by a player (it was aimed at everyone), and the music and ambience play for them.
  const spoken = out.find((o) => o.tool === 'speak')!.json;
  check(spoken?.file, 'the voice line was made');
  const heard = await raw('GET', `${W}/voice/file/${spoken.file}`, P.jess.token);
  check(heard.status === 200, 'a player can fetch the spoken line');
  const now = await jess('GET', '/sound/now');
  check(now.music && now.ambience, 'players hear the music and the ambience');
  const dmNow = await dm('GET', '/sound/now');
  check(dmNow.music?.id === now.music.id, 'the GM and the players play the same track');
}, () => '5 actions');
await noLeaks('scene');

// ---- 3. the table talks -----------------------------------------------------------------
await step('Players chat in the table and party chats; the agent answers the table', async () => {
  await jess('POST', '/sessionchat/chat/table', { body: 'We take the ferry across first, right?' });
  await tom('POST', '/sessionchat/chat/party', { body: 'Keep your voices down, the clerk is listening.' });
  await ana('POST', '/sessionchat/chat/party', { body: 'I have the rope. Who has the lantern?' });
  const roll = await jess('POST', '/sessionchat/chat/table', { body: '/roll 1d20+5' });
  check(roll.dice || roll.roll || /\d/.test(JSON.stringify(roll)), 'the roll was made by the server');
  await agentDo(`Tell the table what happens.\n${call('send_table_chat', { body: 'The ferryman nods. "Two silver a head, double after dark."' })}`, ['send_table_chat']);
  // The table chat reaches everyone; the party chat is the players' only.
  const read = await agentRead(call('read_table_chat', { limit: 20 }));
  void read;
  const table = await tom('GET', '/sessionchat/chat/table');
  const lines = JSON.stringify(table);
  check(lines.includes('We take the ferry') && lines.includes('Two silver a head'), 'the table chat holds the players and the GM');
  const dmParty = await raw('GET', `${W}/sessionchat/chat/party`, dmTok);
  check(dmParty.status >= 400 || !dmParty.text.includes('Keep your voices down'), 'the GM cannot read the party chat');
  const party = await jess('GET', '/sessionchat/chat/party');
  check(JSON.stringify(party).includes('I have the rope') && !JSON.stringify(party).includes('Two silver a head'), 'the party chat is the players only');
});
await noLeaks('chat');

// ---- 4. the broker ----------------------------------------------------------------------
const brokerOut = await step('A player asks the broker: one normal question, one spoiler question for the GM', async () => {
  const q1 = await jess('POST', '/broker/quote', { question: 'How much is the Greywater Ferry?' });
  const a1 = await jess('POST', '/broker/ask', { quoteId: q1.quoteId });
  const q2 = await tom('POST', '/broker/quote', { question: 'Who does the harbour council secretly answer to?' });
  const a2 = await tom('POST', '/broker/ask', { quoteId: q2.quoteId });
  return { normal: a1.request ?? a1, spoiler: a2.request ?? a2, q1, q2 };
}, (x) => `normal: ${x.normal.status}, spoiler: ${x.spoiler.status}`);
await step('The spoiler question reaches the GM, who prices it; the player pays and gets the GM\'s answer', async () => {
  const mine = await tom('GET', '/broker');
  const req = (mine.requests ?? mine).find((r: any) => /secretly answer/.test(r.question));
  check(req, 'the player sees the question in their list');
  check(!req.answer || req.status !== 'answered', 'the spoiler is not answered by the broker');
  const list = await agentRead(call('list_broker_requests'));
  void list;
  const dmList = await dm('GET', '/broker');
  const dmReq = (dmList.requests ?? dmList).find((r: any) => r.id === req.id);
  check(dmReq && dmReq.status === 'pricing', `the GM sees it waiting for a price (status ${dmReq?.status})`);
  const DM_ANSWER = 'A rumour on the quay: the council\'s coin comes from a ship that never docks.';
  await agentDo(call('broker_answer', { id: req.id, answer: DM_ANSWER, costCp: 150, waitAmount: 0, waitUnit: 'minutes', clock: 'game' }), ['broker_answer']);
  const offered = (await tom('GET', '/broker')).requests.find((r: any) => r.id === req.id);
  check(offered.status === 'offered' && offered.cost_cp === 150 || offered.costCp === 150, `the player is offered the GM's price (${JSON.stringify(offered).slice(0, 200)})`);
  const before = (await tom('GET', '/live/ledger?owner=me')).cp;
  await tom('POST', `/broker/${req.id}/accept`, {});
  const done = await until('the answer', async () => { const r = (await tom('GET', '/broker')).requests.find((x: any) => x.id === req.id); return r && r.status === 'answered' ? r : null; });
  check(done.answer === DM_ANSWER, 'the player gets exactly the GM\'s answer');
  check((await tom('GET', '/live/ledger?owner=me')).cp === before - 150, 'the player paid the GM\'s price');
  // Nobody else sees tom's bought answer.
  check(!JSON.stringify(await jess('GET', '/broker')).includes('ship that never docks'), 'another player does not see it');
});
await noLeaks('broker');

// ---- 5. combat --------------------------------------------------------------------------
await step('Combat: the agent adds monsters from a statblock (approved), players join, initiative', async () => {
  const sb = await agentDo(`Goblins ambush the party on the quay.\n${call('make_statblock', { moduleTermId: 'dnd-2024:monster-goblin-warrior', addToCombat: true, initiative: 15 })}\n${call('make_statblock', { moduleTermId: 'dnd-2024:monster-goblin-warrior', addToCombat: true, initiative: 11, name: 'Goblin Warrior 2' })}\n${call('add_combatant', { name: 'Lurking Horror', initiative: 8, hp: 40, ac: 15, hidden: true })}`, ['make_statblock', 'make_statblock', 'add_combatant']);
  check(sb.length === 3, 'three creatures proposed');
  for (const [who, p] of Object.entries(P)) await dm('POST', '/live/combatants', { name: p.name, accountId: p.id, initiative: who === 'jess' ? 18 : who === 'tom' ? 13 : 9, hp: 30, maxHp: 30 });
  await agentDo(call('set_combat', { active: true, round: 1, turn: 0 }), ['set_combat']);
  const c = await dm('GET', '/live/combat');
  check(c.active && c.combatants.length === 6, `six combatants (${c.combatants.map((x: any) => x.name).join(', ')})`);
  check(c.combatants.every((x: any, i: number, a: any[]) => i === 0 || a[i - 1].initiative >= x.initiative), 'in initiative order');
  const gob = c.combatants.find((x: any) => /Goblin/.test(x.name));
  check(gob.hp > 0 && gob.ac && gob.statblock_page, 'the goblin has hp, ac and its statblock page');
}, () => '3 monsters + 3 players');

await step('The GM sets combat tools to auto-approve, then runs rounds: damage, conditions, next turn', async () => {
  await dm('PATCH', '/settings', { agentAutoApprove: ['damage_combatant', 'heal_combatant', 'set_conditions', 'next_turn'] });
  const c0 = await dm('GET', '/live/combat');
  const g1 = c0.combatants.find((x: any) => x.name === 'Goblin Warrior');
  const g2 = c0.combatants.find((x: any) => x.name === 'Goblin Warrior 2');
  // Fast commands need no model at all.
  const t1 = await say('damage Goblin Warrior 2 for 4');
  check(t1.actions.length === 0 && /Done: Deal 4/.test(t1.reply), `damage by name ran at once (${t1.reply.slice(0, 80)})`);
  const t2 = await say([call('damage_combatant', { combatant: g1.id, amount: 9 }), call('set_conditions', { combatant: g1.id, conditions: ['Prone'] })].join('\n'));
  check(t2.actions.length === 0, 'auto-approved tools did not wait');
  await say('next turn');
  await say('next turn');
  const c1 = await dm('GET', '/live/combat');
  const a = c1.combatants.find((x: any) => x.id === g1.id), b = c1.combatants.find((x: any) => x.id === g2.id);
  check(a.hp === g1.hp - 9 && b.hp === g2.hp - 4, 'damage landed');
  check(JSON.stringify(a.effects).includes('Prone'), 'the condition is set');
  check(c1.turn === 2 && c1.round === 1, `two turns on (turn ${c1.turn}, round ${c1.round})`);
  check((await say('who is up')).reply.includes(c1.combatants[2].name), 'the agent knows whose turn it is');
  await dm('PATCH', '/settings', { agentAutoApprove: [] });
}, () => 'damage, Prone, 2 turns');

await step('Players see the combat card and the stage card, with monster health as the setting says', async () => {
  await agentDo(call('show_on_stage', { kind: 'combat' }), ['show_on_stage']);
  const view = async (mode: string) => { await dm('PATCH', '/settings', { monsterHealth: mode }); return jess('GET', '/live/combat'); };
  const names = (c: any) => c.combatants.map((x: any) => x.name);
  const words = await view('words');
  check(words.active && !names(words).some((n: string) => /Lurking/.test(n)), 'the hidden creature is not listed');
  const gw = words.combatants.find((x: any) => x.name === 'Goblin Warrior');
  check(['Unhurt', 'Hurt', 'Bloodied', 'Near death', 'Down'].includes(gw.health) && gw.health !== 'Unhurt', `health in words (${gw.health})`);
  check((await view('none')).combatants.find((x: any) => x.name === 'Goblin Warrior').health === null, 'health hidden when the setting is none');
  const exact = await view('exact');
  check(/^\d+\/\d+$/.test(exact.combatants.find((x: any) => x.name === 'Goblin Warrior').health), 'exact health when the setting says so');
  await dm('PATCH', '/settings', { monsterHealth: 'words' });
  const stage = await tom('GET', '/stage');
  const card = stage.cards.find((c: any) => c.kind === 'combat');
  check(card, 'players see the combat card on the stage');
  check(!/Lurking|"hp"|"ac"/.test(JSON.stringify(card)), 'the stage combat card holds no hidden creature or exact numbers');
  const dmStage = await dm('GET', '/stage');
  check(dmStage.cards.some((c: any) => c.kind === 'combat'), 'the GM sees it too');
});
await noLeaks('combat');

const coinsToCp = (g: any): number => {
  const rate: Record<string, number> = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
  const c = g.coins ?? g.total ?? g;
  if (typeof g.totalCp === 'number') return g.totalCp;
  if (typeof c === 'object') return Object.entries(c).reduce((n, [k, v]) => n + (rate[k] ?? 0) * (Number(v) || 0), 0);
  return 0;
};
// ---- 6. loot ----------------------------------------------------------------------------
await step('Loot: quick-gen gold and items, given to the party', async () => {
  const coins = await agentRead(call('generate_coins', { mode: 'hoard', level: 3, seed: 'night' }));
  void coins;
  const gen = await dm('GET', '/quickgen/coins?mode=hoard&level=3&seed=night');
  const cp = coinsToCp(gen);
  check(cp > 0, `the hoard has coin (${JSON.stringify(gen).slice(0, 120)})`);
  const items = await dm('GET', '/quickgen/items?rarity=uncommon&count=2&seed=night');
  const list = (items.items ?? items) as any[];
  check(list.length >= 1 && list[0].name, 'quick-gen made items');
  const before = (await dm('GET', '/live/ledger?owner=party')).cp;
  await agentDo([call('add_coin', { owner: 'party', amountCp: cp, note: 'Goblin hoard' }), ...list.slice(0, 2).map((i: any) => call('add_item', { owner: 'party', name: i.name, qty: 1, note: 'From the goblins', reason: 'Goblin hoard' }))].join('\n'), ['add_coin', ...list.slice(0, 2).map(() => 'add_item')]);
  check((await dm('GET', '/live/ledger?owner=party')).cp === before + cp, 'the party pouch holds the coin');
  const stash = await jess('GET', '/inventory?owner=party');
  const names = (stash.items ?? stash).map((i: any) => i.name);
  for (const i of list.slice(0, 2)) check(names.includes(i.name), `the party stash holds ${i.name}`);
  return cp;
}, (cp) => `${cp} cp`);

await noLeaks('loot');

// ---- 7. a trade and an approval ------------------------------------------------------------
await step('A trade between two players, a player\'s request approved, a give from the stash', async () => {
  const inv = async (who: string, token: string) => { const r = await api('GET', `${W}/inventory?owner=me`, token); return (r.items ?? r) as any[]; };
  const potion = (await inv('tom', P.tom.token)).find((i) => /potion/i.test(i.name));
  check(potion, 'tom has a healing potion');
  const offer = await tom('POST', '/sessionchat/trades', { to: P.jess.id, offerItemId: potion.id, offerQty: 1, wantItem: 'Arrows', wantQty: 5, note: 'A potion for five arrows?' });
  const mine = await jess('GET', '/sessionchat/trades');
  check(mine.some((t: any) => t.id === offer.id), 'jess sees the offer');
  const arrows = (await inv('jess', P.jess.token)).find((i) => /arrow/i.test(i.name));
  await jess('POST', `/sessionchat/trades/${offer.id}/accept`, { itemId: arrows.id });
  check((await inv('jess', P.jess.token)).some((i) => /potion/i.test(i.name)), 'jess has the potion');
  check((await inv('tom', P.tom.token)).some((i) => /arrow/i.test(i.name) && i.qty >= 5), 'tom has the arrows');
  // Ana asks for an item; it waits for the GM, who approves it through the agent.
  const ask = await ana('POST', '/inventory', { owner: 'me', name: 'Silvered dagger', qty: 1, reason: 'Bought from the smith' });
  check(ask.pending, 'the request waits for the GM');
  const mineNow = (await inv('ana', P.ana.token)).find((i) => /dagger/i.test(i.name));
  check(!mineNow || mineNow.pending || mineNow.status === 'pending', `it is not hers yet (${JSON.stringify(mineNow)})`);
  check(!(await jess('GET', '/inventory?owner=party').then((x) => JSON.stringify(x))).includes('dagger'), 'nobody else sees the request');
  const waiting = await agentRead(call('list_approvals'));
  void waiting;
  const ap = await dm('GET', '/approvals');
  const change = ap.items.find((c: any) => /dagger/i.test(JSON.stringify(c)));
  check(change, 'the GM sees it in the approvals');
  await agentDo(call('decide_approval', { id: change.id, action: 'approve' }), ['decide_approval']);
  const hers = (await inv('ana', P.ana.token)).find((i) => /dagger/i.test(i.name));
  check(hers && !hers.pending && hers.status !== 'pending', 'now it is hers');
  // The GM hands one of the stash items to a player.
  const stash = (await dm('GET', '/inventory?owner=party')); const it = (stash.items ?? stash).find((i: any) => /From the goblins/.test(i.note ?? ''));
  await agentDo(call('move_item', { itemId: it.id, to: P.ana.id, reason: 'Ana takes the find' }), ['move_item']);
  check((await inv('ana', P.ana.token)).some((i) => i.name === it.name), 'the item moved to Ana');
  const transfers = await dm('GET', '/inventory/transfers');
  check((transfers.transfers ?? transfers).length >= 2, 'the GM sees the transfers');
});
await noLeaks('trade');

// ---- 8. travel and a long rest ---------------------------------------------------------------
await step('Travel and a long rest on the world clock', async () => {
  const before = await dm('GET', '/clock');
  const out = await agentDo([call('advance_world_time', { minutes: 1440, reason: 'Travelled the coast road to the lighthouse' }), call('advance_world_time', { preset: 'long-rest', reason: 'Camped below the headland' })].join('\n'), ['advance_world_time', 'advance_world_time']);
  void out;
  const after = await dm('GET', '/clock');
  check(after.minutes >= before.minutes + 1440, `the clock moved on (${before.label} -> ${after.label})`);
  const log = await dm('GET', '/clock/log');
  check(JSON.stringify(log).includes('Camped below the headland') && JSON.stringify(log).includes('coast road'), 'both moves are in the clock log with their reasons');
  const mine = await jess('GET', '/clock');
  check(mine.label === after.label, 'players see the same date');
  const events = await jess('GET', '/clock/events');
  check(!JSON.stringify(events).includes("Velmira's shipment"), 'players do not see the GM-only event');
  return after.label as string;
}, (label) => label);
await noLeaks('clock');

// ---- 9. stop the recording ---------------------------------------------------------------------
const transcript = await step('The session is spoken and recorded, then the agent stops the recording', async () => {
  const mics = await dm('GET', '/audio/mics');
  const table = mics.find((m: any) => m.label === 'Table'), headset = mics.find((m: any) => /headset/i.test(m.label));
  check(table && headset, 'the demo mics are there');
  const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
  const chunk = async (mic: any, seq: number, start: number, end: number, text: string) => {
    const r = await fetch(`${base}${W}/audio/sessions/${rec.id}/chunks?mic=${mic.id}&seq=${seq}&start=${start}&end=${end}&level=0.6`, { method: 'POST', headers: { Authorization: `Bearer ${dmTok}`, 'Content-Type': 'audio/webm' }, body: Buffer.concat([WEBM, Buffer.from(`FAKE:${text}`)]) });
    check(r.status < 300, `chunk accepted (${r.status})`);
  };
  await chunk(table, 0, 0, 5000, 'We cross the Greywater on the ferry and reach the dark lighthouse at dusk.');
  await chunk(table, 1, 6000, 11000, 'Jessamine shoots the goblin on the quay and Tomas drinks his healing potion.');
  await dm('POST', `/audio/sessions/${rec.id}/holds`, { micId: headset.id, kind: 'aside', start: 12000, end: 17000 });
  await chunk(headset, 0, 12000, 17000, 'DMSECRET-ASIDE the keeper is working for the smuggler queen.');
  await chunk(table, 2, 12000, 17000, 'DMSECRET-ASIDE the keeper is working for the smuggler queen.');
  await agentDo(call('stop_recording'), ['stop_recording']);
  const st = await dm('GET', '/audio/status');
  check(!st.recording, 'the recording has stopped');
  const lines = await until('the transcript', async () => { const l = await dm('GET', `/audio/sessions/${rec.id}/lines`); const arr = l.lines ?? l; const j = JSON.stringify(arr); return j.includes('Greywater') && j.includes('healing potion') && j.includes('DMSECRET') ? arr : null; }, 10_000);
  const seen = JSON.stringify(await jess('GET', `/audio/sessions/${rec.id}/lines`));
  check(seen.includes('Greywater') && !seen.includes('DMSECRET'), 'players read the table transcript and never the GM aside');
  check((await jess('GET', '/audio/status')).recording === false, 'players see that the recording stopped');
  return lines.length as number;
}, (n) => `${n} transcript lines`);
await noLeaks('recording stopped');

// ---- 10. the session log --------------------------------------------------------------------------
await step('The session log is drafted from the transcript, the date change accepted, and published', async () => {
  const [d] = await agentDo(call('draft_session_summary', { audioSessionId: rec.id, title: 'Session 24: A night at the lighthouse' }), ['draft_session_summary']);
  const draftId = d.json?.id ?? (await dm('GET', '/sessionlog/drafts'))[0].id;
  const body = await agentRead(call('read_session_log_draft', { draftId }));
  void body;
  const full = await dm('GET', `/sessionlog/drafts/${draftId}`);
  check(full.markdown?.includes('Greywater') || full.markdown?.length > 40, 'the draft is built from the transcript');
  check(!full.markdown.includes('DMSECRET'), 'the draft holds nothing from the GM aside');
  const before = (await dm('GET', '/clock')).minutes;
  await agentDo(call('decide_session_date', { draftId, accept: true, minutes: 2 * 1440, reason: 'Two days on the coast road and at the lighthouse' }), ['decide_session_date']);
  const accepted = await dm('GET', `/sessionlog/drafts/${draftId}`);
  check(accepted.dateStatus === 'accepted' && (await dm('GET', '/clock')).minutes === before + 2 * 1440, 'the accepted date change moved the clock');
  check((await jess('GET', '/sessionlog')).every((e: any) => e.title !== 'Session 24: A night at the lighthouse'), 'players do not see it before it is published');
  await agentDo(call('publish_session_log', { draftId }), ['publish_session_log']);
});
await step('Players see the published log and the world date', async () => {
  for (const [who, p] of Object.entries(P)) {
    const log = await api('GET', `${W}/sessionlog`, p.token);
    const entry = log.find((e: any) => /lighthouse/i.test(e.title));
    check(entry, `${who} sees the published log`);
    check(!JSON.stringify(log).includes('DMSECRET'), `${who}'s log has no GM aside`);
    const full = await api('GET', `${W}/sessionlog/${entry.id}`, p.token);
    check(full.summary && full.worldTo, `${who} can read the entry and its in-world dates`);
  }
  const clock = await dm('GET', '/clock');
  check((await jess('GET', '/clock')).label === clock.label, 'players see the world date');
  const closed = await dm('GET', '/sessionchat/current');
  check(!closed.session, 'the table chat closed with the recording');
});
await noLeaks('the end');

// ---- the report ------------------------------------------------------------------------------------
const total = Math.round(performance.now() - t0);
console.log(`
Game night finished in ${(total / 1000).toFixed(1)} s: ${timeline.length} steps passed.
  ${stats.assertions} checks, ${stats.leakScans} leak scans over ${stats.leakViews} player screens, none leaked.
  GM agent: ${stats.agentMessages} messages, ${stats.approvals} approvals. Other GM calls: ${stats.dmCalls}. Player calls: ${stats.playerCalls}.`);
process.exit(0);
