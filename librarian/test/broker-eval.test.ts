// The broker's question routing, judged on 40+ questions against a seeded
// world full of DM secrets. It runs twice: once with a fake audit model (an
// in-test fake fetch that returns labels) and once with no model at all (the
// keyword rules). In both runs:
//   - no DM-only text appears in anything a player can read
//   - every spoiler or meta question goes to the DM (Guarded)
//   - off-topic questions are refused in character and cost nothing
//   - "Other" (rules and items) is free and answered at once
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

type Kind = 'fact' | 'dm' | 'off' | 'rules' | 'item';
interface Case {
  q: string;
  kind: Kind;
  /** What the fake audit model says. */
  model: { scope: string; intent: string; type?: string; confidence?: number };
  /** Only the model can tell: skipped in the no-model run. */
  modelOnly?: boolean;
  /** The model says "fact", but the keyword rules must still catch it. */
  modelMissesIt?: boolean;
}
const W_ = { scope: 'world', intent: 'fact' };
const SP = { scope: 'world', intent: 'spoiler-seeking' };
const META = { scope: 'world', intent: 'meta-gaming' };
const OFF = { scope: 'off-topic', intent: 'fact' };
const RULES = { scope: 'rules', intent: 'fact' };
const ITEM = { scope: 'item', intent: 'fact' };

const CASES: Case[] = [
  // Ordinary questions about the world.
  { q: 'Who rules Saltmarsh harbour?', kind: 'fact', model: W_ },
  { q: 'What happened at the burned mill near Greywater?', kind: 'fact', model: W_ },
  { q: 'What are the nine Hearts and the elder storms?', kind: 'fact', model: W_ },
  { q: 'Where is the chapel of Saint Orin?', kind: 'fact', model: W_ },
  { q: 'Who rules the northern marches?', kind: 'fact', model: W_ },
  { q: 'What did the party do on the road north?', kind: 'fact', model: W_ },
  // Spoiler-seeking and meta-gaming: always the DM.
  { q: 'Who is the villain?', kind: 'dm', model: SP },
  { q: 'Who is the BBEG of this campaign?', kind: 'dm', model: SP },
  { q: 'What is the twist at the end?', kind: 'dm', model: SP },
  { q: 'What is Duke Aldric\'s true identity?', kind: 'dm', model: SP },
  { q: 'What secret does Saltmarsh hide?', kind: 'dm', model: SP },
  { q: 'What is behind the door in the vault?', kind: 'dm', model: SP },
  { q: 'How many HP does the dragon have?', kind: 'dm', model: META },
  { q: 'What is the AC of the golem?', kind: 'dm', model: META },
  { q: 'What are the stats of Duke Aldric?', kind: 'dm', model: META },
  { q: 'What is the DC to open the vault?', kind: 'dm', model: META },
  { q: 'Who is really behind the smugglers?', kind: 'dm', model: SP },
  { q: 'Is the Duke a traitor?', kind: 'dm', model: SP },
  { q: 'Who does the harbour council of Saltmarsh secretly answer to?', kind: 'dm', model: SP },
  { q: 'What is the secret of the Hearts?', kind: 'dm', model: SP },
  { q: 'Who is the mastermind behind the cult?', kind: 'dm', model: SP },
  { q: 'What is the villain\'s weakness?', kind: 'dm', model: SP },
  { q: 'What is the stat block of the Pale Hand like?', kind: 'dm', model: META },
  { q: 'What\'s behind the curtain at the chapel?', kind: 'dm', model: SP },
  // DM spoiler tags: a tagged page and a free-text topic.
  { q: 'Tell me about the Ashen Tower', kind: 'dm', model: W_, modelMissesIt: true },
  { q: 'Where is the lost heir?', kind: 'dm', model: W_, modelMissesIt: true },
  // The model says "fact" but the keywords know better.
  { q: 'Who is the villain of the Hearts?', kind: 'dm', model: W_, modelMissesIt: true },
  // Only a model can see these.
  { q: 'What is the Duke hiding from the party?', kind: 'dm', model: SP, modelOnly: true },
  { q: 'Which of the party will betray the others?', kind: 'dm', model: SP, modelOnly: true },
  // Off topic: refused in character, free.
  { q: 'Can you help with my history homework?', kind: 'off', model: OFF },
  { q: 'Write me a poem about the sea', kind: 'off', model: OFF },
  { q: 'What is the weather forecast for tomorrow?', kind: 'off', model: OFF },
  { q: 'Who won the football game last night?', kind: 'off', model: OFF },
  { q: 'How do I write a Python script?', kind: 'off', model: OFF },
  { q: 'What is the capital of France?', kind: 'off', model: OFF },
  { q: 'Tell me about the Harry Potter books', kind: 'off', model: OFF },
  { q: 'What is a good pizza recipe?', kind: 'off', model: OFF },
  { q: 'Explain quantum entanglement to me', kind: 'off', model: OFF, modelOnly: true },
  // "Other": rules and items are free and at once.
  { q: 'How does grappling work?', kind: 'rules', model: RULES },
  { q: 'What are the rules for opportunity attacks?', kind: 'rules', model: RULES },
  { q: 'How does a long rest work?', kind: 'rules', model: RULES },
  { q: 'How do saving throws work?', kind: 'rules', model: RULES },
  { q: 'What does my brass lamp do?', kind: 'item', model: ITEM },
  { q: 'Tell me about my brass lamp', kind: 'item', model: ITEM },
];

const SECRET_WORDS = ['Velmira', 'smuggler queen', 'lighthouse', 'Pale Hand', 'cult leader', 'silver key', 'crypt', 'cursed', 'binds its owner', 'treasury'];
const noSecrets = (where: string, x: unknown, asked = '') => {
  const s = (typeof x === 'string' ? x : JSON.stringify(x)).toLowerCase();
  for (const w of SECRET_WORDS.filter((w) => !asked.toLowerCase().includes(w.toLowerCase()))) assert.ok(!s.includes(w.toLowerCase()), `${where} leaked "${w}": ${s.slice(0, 300)}`);
};

async function runEval(withModel: boolean) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-brk-eval-'));
  const modelInputs: string[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    if (!String(url).startsWith('http://audit.invalid/')) return fetch(url, init);
    modelInputs.push(String(init.body));
    const body = JSON.parse(init.body);
    const user = body.messages.find((m: any) => m.role === 'user');
    const { question } = JSON.parse(user.content);
    const c = CASES.find((x) => x.q === question);
    const labels = c ? c.model : { scope: 'world', intent: 'fact' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: 'what', confidence: 0.92, ...labels }) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const env: Record<string, string> = { ALX_ADMIN_TABLE_LOGIN: '1' };
  if (withModel) { env.ALX_MODEL_AUDIT_URL = 'http://audit.invalid/v1'; env.ALX_MODEL_AUDIT_MODEL = 'tiny'; }
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env, fetch: fakeFetch });
  const server: any = made.app.listen(0);
  try {
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, url: string, token?: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = text; }
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
    ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
    T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
    const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Eval Land', dmAccountId: ID.dm })).id;
    const B = `/api/worlds/${W}/broker`;
    for (const name of ['jess', 'tom']) {
      const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
      const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
      T[name] = j.token; ID[name] = j.account.id;
    }
    const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
    await page('places/Saltmarsh', 'party', `---\nknowledge: local\n---\n# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council of seven captains.\n\n> [!secret] DM\n> The harbour council secretly answers to the smuggler queen Velmira.\n`);
    await page('lore/Hearts', 'party', `---\nknowledge: deep\n---\n# The Hearts\nThe nine Hearts were forged before the sundering to bind the elder storms.\n`);
    await page('party/Road', 'party', `---\nknowledge: common\n---\n# The road north\nThe party took the road north past the burned mill near Greywater ford.\n`);
    await page('dm/Velmira', 'dm', `# Velmira\nVelmira the smuggler queen keeps her treasury beneath the lighthouse.\n`);
    await page('npcs/Duke Aldric', 'party', `---\nknowledge: local\n---\n# Duke Aldric\nDuke Aldric rules the northern marches from Castle Greyhold.\n\n> [!secret] DM\n> Aldric is secretly the cult leader known as the Pale Hand.\n`);
    await page('dm/Vault', 'dm', `# The vault\nThe vault door opens with the silver key hidden in the chapel crypt.\n`);
    await page('places/Chapel', 'party', `---\nknowledge: local\n---\n# Chapel of Saint Orin\nThe chapel of Saint Orin stands on the hill above Saltmarsh.\n`);
    const tower = await page('places/Ashen Tower', 'party', `---\nknowledge: local\n---\n# Ashen Tower\nThe Ashen Tower is a ruined watchtower east of Greywater ford.\n`);
    const lampPage = await page('items/Brass lamp', 'party', `---\nknowledge: common\n---\n# Brass lamp\nA brass lamp that burns without oil for one hour each day.\n\n> [!secret] DM\n> The lamp is cursed and binds its owner to Velmira.\n`);
    await ok('PUT', `${B}/rules/${tower}`, T.dm, { spoiler: true });
    await ok('PUT', `${B}/spoilers`, T.dm, { topics: ['the lost heir'] });
    await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerTopics: ['Feudal Japan: history, folklore, customs'] });
    const lamp = await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Brass lamp', qty: 1, note: 'Warm to the touch.', reason: 'Found in the ruins' });
    await ok('PUT', `/api/worlds/${W}/itemcards/${lamp.id}/page`, T.dm, { pageId: lampPage });
    await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 100_000, note: 'Starting coin' });
    const coin = async () => (await ok('GET', `/api/worlds/${W}/live/ledger`, T.jess)).cp as number;
    const key = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'ai', access: 'read' });
    const mcp = async (name: string, args: Record<string, unknown> = {}) => JSON.stringify((await call('POST', '/mcp', key.key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body);

    // "Other" is not a price tier; Guarded is always the DM.
    const cfg = await ok('GET', `${B}/config`, T.jess);
    assert.ok(!cfg.tiers.some((t: any) => /other/i.test(t.id) || /other/i.test(t.name)));
    assert.equal(cfg.tiers.find((t: any) => t.knowledge === 'secret').delivery, 'review');

    const dmIds = new Set<string>();
    let ran = 0;
    for (const c of CASES) {
      if (!withModel && c.modelOnly) continue;
      ran++;
      const before = await coin();
      const q = await ok('POST', `${B}/quote`, T.jess, { question: c.q });
      const asked = c.q;
      noSecrets(`quote "${c.q}"`, q, asked);
      noSecrets(`MCP quote "${c.q}"`, await mcp('ask_broker_quote', { question: c.q }), asked);
      assert.equal(await coin(), before, 'quotes never charge');
      if (c.kind === 'dm') {
        assert.equal(q.secret, true, `"${c.q}" should go to the DM`);
        assert.equal(q.cost_cp, null);
        const a = await ok('POST', `${B}/ask`, T.jess, { quoteId: q.quoteId });
        assert.equal(a.status, 'pricing', `"${c.q}"`);
        assert.equal(a.answer, undefined);
        assert.equal(await coin(), before, 'nothing charged until the DM prices it');
        dmIds.add(a.id);
        noSecrets('ask', a, asked);
      } else if (c.kind === 'off') {
        assert.equal(q.refused, true, `"${c.q}" should be refused`);
        assert.equal(q.cost_cp, 0);
        assert.match(q.line, /not something I deal in/);
        const a = await ok('POST', `${B}/ask`, T.jess, { quoteId: q.quoteId });
        assert.equal(a.status, 'noted');
        assert.equal(await coin(), before, 'off topic costs nothing');
        noSecrets('ask', a, asked);
      } else if (c.kind === 'rules' || c.kind === 'item') {
        assert.equal(q.kind, 'other', `"${c.q}" is an Other question: ${JSON.stringify(q)}`);
        assert.equal(q.cost_cp, 0);
        assert.equal(q.secret, false);
        assert.ok(q.answer.length > 10);
        if (c.kind === 'rules') assert.ok(q.sources.length > 0 && q.sources[0].title, 'rules answers cite the module');
        else assert.match(q.answer, /burns without oil/);
        const a = await ok('POST', `${B}/ask`, T.jess, { quoteId: q.quoteId });
        assert.equal(a.status, 'answered', 'Other is answered at once');
        assert.equal(a.cost_cp, 0);
        assert.equal(await coin(), before, 'Other is free');
        noSecrets('ask', a, asked);
      } else {
        assert.equal(q.refused, false, `"${c.q}" is a world question`);
        const a = await ok('POST', `${B}/ask`, T.jess, { quoteId: q.quoteId });
        noSecrets('ask', a, asked);
      }
    }
    assert.ok(ran >= 40, `ran ${ran} questions`);

    // Real-world topics the DM allows are in scope; the same words without one are not.
    const allowed = await ok('POST', `${B}/quote`, T.jess, { question: 'What was a typical recipe for rice in feudal Japan?' });
    assert.equal(allowed.refused, false);
    if (withModel) assert.equal((await ok('POST', `${B}/quote`, T.jess, { question: 'What is a good rice recipe?' })).refused, false, 'the fake model says world for unknown questions');
    else assert.equal((await ok('POST', `${B}/quote`, T.jess, { question: 'What is a good rice recipe?' })).refused, true);

    // Let every wait run out and the DM approve what is held, then read everything a player can read.
    await ok('POST', `${B}/clock`, T.dm, { addMinutes: 10 * 1440 });
    for (const r of (await ok('GET', B, T.dm)).requests) if (r.needs_review) await ok('POST', `${B}/${r.id}/approve`, T.dm);
    const list = await ok('GET', B, T.jess);
    noSecrets('list', list, CASES.map((c) => c.q).join(' '));
    noSecrets('MCP list', await mcp('list_broker_requests'), CASES.map((c) => c.q).join(' '));
    noSecrets('offers', await ok('GET', `${B}/offers`, T.jess));
    noSecrets('MCP offers', await mcp('list_broker_offers'));
    noSecrets('config', await ok('GET', `${B}/config`, T.tom));
    assert.ok(list.requests.every((r: any) => r.classification === undefined && r.asker === undefined));
    assert.ok(!list.requests.some((r: any) => r.status === 'noted'), 'turned-away questions are not in the player list');
    const delivered = list.requests.filter((r: any) => r.status === 'answered' && r.cost_cp > 0);
    assert.ok(delivered.length >= 1, 'some paid answers were delivered');

    // The DM sees every question with its routing labels, and every spoiler is waiting for them.
    const dmList = (await ok('GET', B, T.dm)).requests;
    for (const id of dmIds) {
      const r = dmList.find((x: any) => x.id === id);
      assert.equal(r.status, 'pricing');
      assert.ok(r.classification.routing, 'routing labels are shown to the DM');
    }
    const routed = dmList.filter((x: any) => x.classification.routing);
    assert.ok(routed.length >= ran - 1);
    if (withModel) {
      assert.ok(modelInputs.length >= ran, 'the audit model labelled the questions');
      // The model sees the question, the allowed topics and shared page names, and never DM text.
      for (const body of modelInputs) {
        const user = JSON.parse(body).messages.find((m: any) => m.role === 'user').content;
        const parsed = JSON.parse(user);
        assert.deepEqual(Object.keys(parsed).sort(), ['allowedTopics', 'question', 'sharedPages']);
        assert.ok(parsed.sharedPages.includes('Saltmarsh'));
        assert.ok(!parsed.sharedPages.includes('Velmira') && !parsed.sharedPages.includes('The vault'), 'DM-only page names are not sent');
        noSecrets('model input', { ...parsed, question: '' });
        assert.ok(!user.includes('lost heir') || parsed.question.includes('lost heir'), 'spoiler tags are not sent');
      }
      assert.ok(modelInputs.some((b) => b.includes('Feudal Japan')));
    } else assert.equal(modelInputs.length, 0);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('TestBrokerEval_FakeAuditModelLabels', async () => { await runEval(true); });
test('TestBrokerEval_NoModelKeywordRules', async () => { await runEval(false); });
