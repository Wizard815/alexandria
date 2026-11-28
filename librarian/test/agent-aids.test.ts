// The aids the GM agent can be given, each with a scripted fake model: tool
// selection (keywords, all, core, embeddings, hybrid), concise descriptions,
// hybrid library retrieval, the system prompt without its rules, the broker
// router's examples and Active mode's scan examples. Every embedding-based
// part must give back the plain behaviour when no embeddings model is set,
// and a player's retrieval must never reach a GM-only page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { agentOptions } from '../src/features/agent/options.ts';
import { chooseTools, prefetchHybrid, prefetchLibrary, systemPrompt, type Caller } from '../src/features/agent/harness.ts';
import { selectTools, GM_CORE_TOOLS } from '../src/features/agent/intent.ts';
import { CONCISE } from '../src/features/agent/descriptions.ts';
import { nearestTools } from '../src/features/agent/toolselect.ts';
import { syncEmbeddings } from '../src/features/search/embeddings.ts';
import { routeQuestion, nearCaution, examplesMode, keywordLabels } from '../src/features/broker2/routing.ts';
import { EXAMPLES, similarExamples } from '../src/features/broker2/examples.ts';
import { LINE_EXAMPLES, examplesOn, similarLineExamples } from '../src/features/active/examples.ts';
import { run } from '../src/core/db.ts';

// A tiny fake embeddings model with topics: words of one topic share an axis, so a paraphrase with no shared word still lands close.
const TOPICS: string[][] = [
  ['music', 'melody', 'soundtrack', 'spooky', 'tense', 'song'],
  ['harbour', 'harbor', 'docks', 'quay', 'council', 'fees', 'wharf'],
  ['coin', 'gold', 'silver', 'pouch', 'treasure'],
  ['damage', 'hurt', 'wounded', 'hit'],
  ['secret', 'hidden', 'villain', 'mastermind', 'twist', 'traitor'],
  ['hit', 'points', 'armor', 'stat', 'class'],
  ['weather', 'recipe', 'poem', 'football', 'homework'],
  ['bell', 'tolls', 'chime', 'ring'],
];
const embedText = (t: string): number[] => {
  const v = new Array<number>(TOPICS.length + 1).fill(0);
  const words = String(t).toLowerCase().match(/[a-z]+/g) ?? [];
  for (const w of words) TOPICS.forEach((g, i) => { if (g.includes(w)) v[i] += 1; });
  v[TOPICS.length] = 0.05;
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
};

let embedCalls = 0;
let chatBodies: any[] = [];
let chatReply: any = { scope: 'world', intent: 'fact', type: 'what', confidence: 0.9 };
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.endsWith('/embeddings')) {
    const body = JSON.parse(init.body);
    embedCalls++;
    return new Response(JSON.stringify({ data: body.input.map((t: string, i: number) => ({ index: i, embedding: embedText(t) })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.endsWith('/chat/completions')) {
    chatBodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(chatReply) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

function boot(extra: Record<string, string> = {}, withEmbeddings = true) {
  const env: Record<string, string> = { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_AUDIT_URL: 'http://fake.test/v1', ALX_MODEL_AUDIT_MODEL: 'fake-audit', ...extra };
  if (withEmbeddings) { env.ALX_MODEL_EXTRA_URL = 'http://fake.test/v1'; env.ALX_MODEL_EXTRA_MODEL = 'fake-embed'; }
  const made = createApp({ noScheduler: true, fetch: fake, env });
  const wid = 'w_aids';
  run(made.deps.db, `INSERT INTO accounts (id, username, display_name, pass_hash, is_admin, created_at) VALUES ('a_gm', 'gm', 'GM', 'x', 0, '2025-01-01')`);
  run(made.deps.db, `INSERT INTO accounts (id, username, display_name, pass_hash, is_admin, created_at) VALUES ('a_p', 'pl', 'Player', 'x', 0, '2025-01-01')`);
  run(made.deps.db, `INSERT INTO worlds (id, slug, name, created_at) VALUES (?, 'aids', 'Aids', '2025-01-01')`, wid);
  const caller = (harness: 'gm' | 'player'): Caller => ({ worldId: wid, worldName: 'Aids', accountId: harness === 'gm' ? 'a_gm' : 'a_p', viewer: harness === 'gm' ? { accountId: 'a_gm', role: 'gm' } : { accountId: 'a_p', role: 'player' }, harness, token: 't', port: 0, settings: {} as any });
  return { ...made, wid, caller };
}

test('TestAgentOptions_ParseAndDefaults', () => {
  const d: any = { env: {} };
  assert.equal(agentOptions(d).tools, 'hybrid', 'the adopted defaults');
  assert.equal(agentOptions(d).desc, 'concise');
  assert.equal(agentOptions(d).skills, 'lite');
  assert.equal(agentOptions(d).retrieval, 'hybrid');
  assert.equal(agentOptions({ env: { ALX_AGENT_OPTS: '{"tools":"hybrid","desc":"concise","status":false,"embedK":7}' } } as any).tools, 'hybrid');
  const o = agentOptions({ env: { ALX_AGENT_OPTS: '{"tools":"nonsense","embedK":-3,"skills":"no"}' } } as any);
  assert.equal(o.tools, 'hybrid', 'an unknown value falls back to the default');
  assert.equal(o.embedK, 10);
  assert.equal(o.skills, 'lite');
  assert.equal(agentOptions({ env: { ALX_AGENT_OPTS: '{"skills":"lite"}' } } as any).skills, 'lite');
  assert.equal(agentOptions({ env: { ALX_AGENT_OPTS: '{"skills":false}' } } as any).skills, 'off');
  assert.equal(agentOptions({ env: { ALX_AGENT_OPTS: 'not json' } } as any).desc, 'concise');
});

test('TestAgentDescriptions_NamesAreRealTools', async () => {
  const m = await import('../src/routes/mcpServer.ts');
  const names = new Set(m.toolsFor(true).map((t: any) => t.name));
  for (const [n, d] of Object.entries(CONCISE)) {
    assert.ok(names.has(n), `${n} is not a tool`);
    assert.match(d, /^Use /, `${n} should say when to use it`);
    assert.ok(d.length <= 330, `${n} is too long`);
  }
});

test('TestAgentTools_ModesOfferWhatTheyShould', async () => {
  const h = boot();
  const m = await import('../src/routes/mcpServer.ts');
  const tools = m.toolsFor(true).filter((t: any) => !t.name.startsWith('my_'));
  const names = tools.map((t: any) => t.name);
  const text = 'put on a bit of spooky melody';
  const opts = (tools_: string) => agentOptions({ env: { ALX_AGENT_OPTS: JSON.stringify({ tools: tools_ }) } } as any);
  const kw = await chooseTools(h.deps, opts('keywords'), text, text, tools, names, true);
  const all = await chooseTools(h.deps, opts('all'), text, text, tools, names, true);
  assert.equal(all.length, names.length, 'every GM tool');
  const core = await chooseTools(h.deps, opts('core'), text, text, tools, names, true);
  assert.deepEqual([...core].sort(), GM_CORE_TOOLS.filter((n) => names.includes(n)).sort());
  const emb = await chooseTools(h.deps, opts('embed'), text, text, tools, names, true);
  assert.ok(emb.length > core.length, 'the nearest tools were added');
  for (const c of core) assert.ok(emb.includes(c), 'the core always stays');
  const hyb = await chooseTools(h.deps, opts('hybrid'), text, text, tools, names, true);
  for (const k of kw) assert.ok(hyb.includes(k), 'hybrid keeps every keyword pick');
  assert.ok(embedCalls > 0);
  // The player harness never uses the embedding modes.
  const pl = await chooseTools(h.deps, opts('embed'), text, text, tools, names, false);
  assert.deepEqual(pl, selectTools(text, names, undefined, false));
});

test('TestAgentTools_EmbeddingModesFallBackWithoutAModel', async () => {
  const h = boot({}, false);
  const m = await import('../src/routes/mcpServer.ts');
  const tools = m.toolsFor(true).filter((t: any) => !t.name.startsWith('my_'));
  const names = tools.map((t: any) => t.name);
  const text = 'put on a bit of spooky melody';
  const before = embedCalls;
  const kw = await chooseTools(h.deps, agentOptions({ env: {} } as any), text, text, tools, names, true);
  for (const mode of ['embed', 'hybrid']) {
    const got = await chooseTools(h.deps, agentOptions({ env: { ALX_AGENT_OPTS: JSON.stringify({ tools: mode }) } } as any), text, text, tools, names, true);
    assert.deepEqual(got, kw, `${mode} without an embeddings model is the keyword selection`);
  }
  assert.equal(await nearestTools(h.deps, text, tools, 5), null);
  assert.equal(embedCalls, before, 'no embeddings call was made');
});

test('TestAgentTools_AnEmbeddingsErrorFallsBack', async () => {
  const h = boot();
  const m = await import('../src/routes/mcpServer.ts');
  const tools = m.toolsFor(true).filter((t: any) => !t.name.startsWith('my_'));
  const broken: any = { ...h.deps, fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch };
  assert.equal(await nearestTools(broken, 'play music', tools, 5), null);
});

test('TestAgentRetrieval_HybridFindsAParaphraseKeywordMisses', async () => {
  const h = boot();
  h.deps.library.save(h.wid, { path: 'Factions/Harbour Council', title: 'Harbour Council', body: 'Seven captains who set the harbour fees and settle disputes at the quay.', visibility: 'party' }, null);
  h.deps.library.save(h.wid, { path: 'Items/Brass Bell', title: 'Brass Bell', body: 'A small bell that chimes by itself at night.', visibility: 'party' }, null);
  await syncEmbeddings(h.deps, { maxPages: 50 });
  const c = h.caller('gm');
  const q = 'who runs the docks';
  assert.deepEqual(prefetchLibrary(h.deps, c, q, 5).map((x) => x.title), [], 'the keyword search finds nothing for a question that shares no word');
  const hy = await prefetchHybrid(h.deps, c, q, 5);
  assert.equal(hy[0]?.title, 'Harbour Council');
  // A named page stays on top, and the keyword hits are kept.
  const named = await prefetchHybrid(h.deps, c, 'what does the Brass Bell do', 5);
  assert.equal(named[0]?.title, 'Brass Bell');
});

test('TestAgentRetrieval_HybridIsKeywordOnlyWithoutAModel', async () => {
  const h = boot({}, false);
  h.deps.library.save(h.wid, { path: 'Factions/Harbour Council', title: 'Harbour Council', body: 'Seven captains who set the harbour fees.', visibility: 'party' }, null);
  const c = h.caller('gm');
  assert.deepEqual((await prefetchHybrid(h.deps, c, 'harbour fees', 5)).map((x) => x.title), prefetchLibrary(h.deps, c, 'harbour fees', 5).map((x) => x.title));
  assert.deepEqual(await prefetchHybrid(h.deps, c, 'who runs the docks', 5), []);
});

test('TestAgentRetrieval_PlayerNeverGetsADmOnlyPage', async () => {
  const h = boot();
  h.deps.library.save(h.wid, { path: 'Secrets/Smuggler Queen', title: 'Smuggler Queen', body: 'The hidden mastermind behind the docks: she bribes the harbour council. SECRETBRIBE.', visibility: 'gm' }, null);
  h.deps.library.save(h.wid, { path: 'Places/Quay', title: 'Quay', body: 'The wharf where boats tie up.', visibility: 'party' }, null);
  await syncEmbeddings(h.deps, { maxPages: 50 });
  const gm = await prefetchHybrid(h.deps, h.caller('gm'), 'which hidden mastermind is behind the docks', 5);
  assert.ok(gm.some((x) => x.title === 'Smuggler Queen'), 'the GM harness can reach it');
  const pl = await prefetchHybrid(h.deps, h.caller('player'), 'which hidden mastermind is behind the docks', 5);
  assert.ok(!pl.some((x) => x.title === 'Smuggler Queen'), 'the player harness cannot');
  assert.ok(!JSON.stringify(pl).includes('SECRETBRIBE'), 'nor its text');
});

test('TestAgentSystemPrompt_SkillsOffKeepsIdentityAndBrevity', () => {
  const on = systemPrompt({ harness: 'gm', worldName: 'W' }, '', {}, true);
  const off = systemPrompt({ harness: 'gm', worldName: 'W' }, '', {}, false);
  assert.ok(off.length < on.length / 3);
  assert.match(off, /Game Master/);
  assert.match(off, /brief/i);
  assert.doesNotMatch(off, /How to work/);
  const lite = systemPrompt({ harness: 'gm', worldName: 'W' }, '', {}, 'lite');
  assert.ok(lite.length < on.length && lite.length > off.length);
  assert.match(lite, /call the tool that does exactly that/);
  assert.match(lite, /never invent/i, 'the grounding rule stays');
  // The player harness has one prompt: the switch does not change what a player's broker is told.
  assert.equal(systemPrompt({ harness: 'player', worldName: 'W' }, '', {}, false), systemPrompt({ harness: 'player', worldName: 'W' }, '', {}, true));
});

test('TestBrokerExamples_NearestCautionCanOnlyAddCaution', async () => {
  const near = (intent: string, sim: number) => ({ example: { q: 'x', scope: 'world' as const, intent: intent as any }, sim });
  assert.equal(nearCaution([near('spoiler-seeking', 0.8), near('spoiler-seeking', 0.7)]), 'spoiler-seeking');
  assert.equal(nearCaution([near('spoiler-seeking', 0.4), near('spoiler-seeking', 0.4)]), null, 'not close enough');
  assert.equal(nearCaution([near('spoiler-seeking', 0.8), near('fact', 0.7)]), null, 'the two nearest disagree');
  assert.equal(nearCaution([near('fact', 0.9), near('fact', 0.9)]), null, 'a plain example adds nothing');

  // The audit model calls a question plain that the nearest examples call a spoiler: the router takes the cautious label.
  const h = boot({ ALX_BROKER_EXAMPLES: 'nn' });
  chatReply = { scope: 'world', intent: 'fact', type: 'who', confidence: 0.9 };
  const labels = await routeQuestion(h.deps, h.wid, 'Which hidden traitor is the mastermind?', [], []);
  assert.equal(labels.intent, 'spoiler-seeking');
  assert.equal(labels.source, 'audit+rules');
  // The audit model calls it a spoiler and the examples say plain: it stays a spoiler.
  chatReply = { scope: 'world', intent: 'spoiler-seeking', type: 'who', confidence: 0.9 };
  const kept = await routeQuestion(h.deps, h.wid, 'What are the harbour fees at the quay?', [], []);
  assert.equal(kept.intent, 'spoiler-seeking');
});

test('TestBrokerRouting_WhoRulesIsNotARulesQuestion', () => {
  const h = boot({});
  assert.equal(keywordLabels(h.deps, h.wid, 'Who rules the lighthouse?', [], []).scope, 'world');
});

test('TestBrokerExamples_FewShotRidesInThePromptAndDegrades', async () => {
  chatReply = { scope: 'world', intent: 'fact', type: 'what', confidence: 0.9 };
  const h = boot({ ALX_BROKER_EXAMPLES: 'fewshot' });
  chatBodies = [];
  await routeQuestion(h.deps, h.wid, 'Which hidden traitor is the mastermind?', [], []);
  const user = JSON.parse(chatBodies.at(-1).messages.find((m: any) => m.role === 'user').content);
  assert.equal(user.examples.length, 6);
  assert.ok(user.examples.every((e: any) => e.question && e.scope && e.intent));
  assert.ok(user.examples.some((e: any) => e.intent === 'spoiler-seeking'), 'the nearest examples are the spoiler ones');
  // With no embeddings model the prompt is the plain one.
  const plain = boot({ ALX_BROKER_EXAMPLES: 'both' }, false);
  chatBodies = [];
  await routeQuestion(plain.deps, plain.wid, 'Which hidden traitor is the mastermind?', [], []);
  const u2 = JSON.parse(chatBodies.at(-1).messages.find((m: any) => m.role === 'user').content);
  assert.equal(u2.examples, undefined);
  assert.equal(await similarExamples(plain.deps, 'anything', 6), null);
  assert.equal(examplesMode({ env: {} } as any), 'none');
  assert.ok(EXAMPLES.length >= 50 && EXAMPLES.every((e) => e.q && e.scope && e.intent));
});

test('TestActiveExamples_NearestLinesAndDegrade', async () => {
  const h = boot({ ALX_ACTIVE_EXAMPLES: '1' });
  assert.equal(examplesOn(h.deps), true);
  const got = await similarLineExamples(h.deps, ['The great bell begins to toll across the harbour.'], 4);
  assert.ok(got && got.length > 0 && got.length <= 4);
  assert.ok(got![0].line.toLowerCase().includes('bell'), 'the bell example is nearest');
  const off = boot({}, false);
  assert.equal(examplesOn(off.deps), false);
  assert.equal(await similarLineExamples(off.deps, ['anything at all'], 4), null);
  assert.ok(LINE_EXAMPLES.some((e) => e.actions.length === 0), 'negative examples are in the bank');
});
