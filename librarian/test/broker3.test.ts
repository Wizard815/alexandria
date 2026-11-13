// Broker v3: the world clock, delivery mode per tier, the scope lock, "Other",
// the site link, spoiler tags and the audit-model routing rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';

interface Ctx { call: any; ok: any; T: Record<string, string>; ID: Record<string, string>; W: string; B: string; deps: any; coin: (who: string) => Promise<number>; page: any }

async function withWorld(opts: { fetch?: typeof fetch; env?: Record<string, string> }, fn: (c: Ctx) => Promise<void>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-brk3-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ...opts.env }, fetch: opts.fetch });
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
    const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Three Land', dmAccountId: ID.dm })).id;
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
    await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 100_000, note: 'Starting coin' });
    const coin = async (who: string) => (await ok('GET', `/api/worlds/${W}/live/ledger`, T[who])).cp as number;
    await fn({ call, ok, T, ID, W, B: `/api/worlds/${W}/broker`, deps: made.deps, coin, page });
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const ask = async (c: Ctx, who: string, question: string) => {
  const q = await c.ok('POST', `${c.B}/quote`, c.T[who], { question });
  return { q, a: await c.ok('POST', `${c.B}/ask`, c.T[who], { quoteId: q.quoteId }) };
};
const mine = async (c: Ctx, who: string, id: string) => (await c.ok('GET', c.B, c.T[who])).requests.find((x: any) => x.id === id);
const advance = (c: Ctx, minutes: number) => c.ok('POST', `/api/worlds/${c.W}/clock/advance`, c.T.dm, { minutes });

test('TestBrokerClock_WaitsRunOnTheWorldClock', async () => {
  await withWorld({}, async (c) => {
    const before = (await c.ok('GET', `/api/worlds/${c.W}/clock`, c.T.dm)).minutes;
    const { a } = await ask(c, 'jess', 'Who rules Saltmarsh harbour?');
    assert.equal(a.status, 'waiting');
    assert.equal(a.ready_at_game, before + 60, 'one game hour on the world clock');
    assert.ok(a.ready_at_game_label);
    await advance(c, 59);
    assert.equal((await mine(c, 'jess', a.id)).status, 'waiting');
    await advance(c, 1);
    assert.equal((await mine(c, 'jess', a.id)).status, 'answered', 'the world clock passing the wait finishes it');
    // POST /broker/clock is a thin wrapper over the world clock.
    const w = await c.ok('POST', `${c.B}/clock`, c.T.dm, { addMinutes: 30 });
    assert.equal(w.minutes, before + 90);
    assert.equal((await c.ok('GET', `/api/worlds/${c.W}/clock`, c.T.dm)).minutes, before + 90);
    const log = await c.ok('GET', `/api/worlds/${c.W}/clock/log`, c.T.dm);
    assert.ok(log.some((e: any) => e.reason === 'Broker clock'));
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).clock.minutes, before + 90);
    assert.equal((await c.call('POST', `${c.B}/clock`, c.T.jess, { addMinutes: 1 })).status, 403);
  });
});

test('TestBrokerClock_OldBrokerMinutesMoveOverOnce', async () => {
  await withWorld({}, async (c) => {
    // A world from before: the broker had its own game minutes, the world clock was never touched.
    run(c.deps.db, `INSERT INTO broker_config (world_id, config, game_minutes, clock_migrated) VALUES (?, '{}', 5000, 0)`, c.W);
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).clock.minutes, 5000);
    assert.equal((await c.ok('GET', `/api/worlds/${c.W}/clock`, c.T.dm)).minutes, 5000);
    await advance(c, 10);
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).clock.minutes, 5010, 'moved once, not again');
  });
  await withWorld({}, async (c) => {
    // A world clock the DM already moved is left alone.
    await advance(c, 100);
    const cur = (await c.ok('GET', `/api/worlds/${c.W}/clock`, c.T.dm)).minutes;
    run(c.deps.db, `INSERT INTO broker_config (world_id, config, game_minutes, clock_migrated) VALUES (?, '{}', 9000, 0)`, c.W);
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).clock.minutes, cur);
  });
});

test('TestBrokerDelivery_AutoAndReviewPerTier', async () => {
  await withWorld({}, async (c) => {
    const cfg = await c.ok('GET', `${c.B}/config`, c.T.dm);
    const by = (k: string) => cfg.tiers.find((t: any) => t.knowledge === k);
    assert.deepEqual(['common', 'local', 'deep', 'secret'].map((k) => by(k).delivery), ['auto', 'auto', 'review', 'review'], 'defaults');

    // Auto: delivered when the wait is over, no DM step.
    const local = await ask(c, 'jess', 'Who rules Saltmarsh harbour?');
    await advance(c, 60);
    assert.equal((await mine(c, 'jess', local.a.id)).status, 'answered');

    // Deep is "DM reviews": still waiting after its wait, until the DM approves.
    const deep = await ask(c, 'jess', 'What are the nine Hearts and the elder storms?');
    assert.equal(deep.q.delivery, 'review');
    await advance(c, 2 * 1440);
    assert.equal((await mine(c, 'jess', deep.a.id)).status, 'waiting');
    assert.equal((await mine(c, 'jess', deep.a.id)).answer, undefined, 'the player sees nothing yet');
    const dmRow = (await c.ok('GET', c.B, c.T.dm)).requests.find((x: any) => x.id === deep.a.id);
    assert.equal(dmRow.needs_review, true);
    assert.match(dmRow.answer, /forged before the sundering/);
    assert.equal((await c.call('POST', `${c.B}/${deep.a.id}/approve`, c.T.jess)).status, 403);
    // Edit, then approve.
    await c.ok('PATCH', `${c.B}/${deep.a.id}`, c.T.dm, { answer: 'The nine Hearts bind the elder storms, so the old songs say.' });
    await c.ok('POST', `${c.B}/${deep.a.id}/approve`, c.T.dm);
    const done = await mine(c, 'jess', deep.a.id);
    assert.equal(done.status, 'answered');
    assert.match(done.answer, /old songs/);

    // Switch the local tier to review: it now waits for the DM, and a refusal refunds.
    const c2 = structuredClone(cfg);
    c2.tiers.find((t: any) => t.knowledge === 'local').delivery = 'review';
    await c.ok('PUT', `${c.B}/config`, c.T.dm, c2);
    const coinBefore = await c.coin('jess');
    const rev = await ask(c, 'jess', 'Who rules Saltmarsh harbour?');
    assert.equal(await c.coin('jess'), coinBefore - 50);
    await advance(c, 120);
    assert.equal((await mine(c, 'jess', rev.a.id)).status, 'waiting');
    await c.ok('POST', `${c.B}/${rev.a.id}/refuse`, c.T.dm, { note: 'Not today.' });
    assert.equal(await c.coin('jess'), coinBefore);
    assert.equal((await mine(c, 'jess', rev.a.id)).status, 'refunded');

    // "Auto for all tiers except Guarded".
    assert.equal((await c.call('POST', `${c.B}/delivery/auto`, c.T.jess)).status, 403);
    const auto = await c.ok('POST', `${c.B}/delivery/auto`, c.T.dm);
    assert.deepEqual(auto.tiers.map((t: any) => t.delivery), ['auto', 'auto', 'auto', 'review']);
  });
});

test('TestBrokerDelivery_GuardedIsAlwaysTheDMWhateverTheSettings', async () => {
  await withWorld({}, async (c) => {
    const cfg = await c.ok('GET', `${c.B}/config`, c.T.dm);
    // Trying to make Guarded auto is accepted but ignored.
    const wanted = structuredClone(cfg);
    for (const t of wanted.tiers) t.delivery = 'auto';
    const saved = await c.ok('PUT', `${c.B}/config`, c.T.dm, wanted);
    assert.equal(saved.tiers.find((t: any) => t.knowledge === 'secret').delivery, 'review');
    assert.equal((await c.call('PUT', `${c.B}/config`, c.T.dm, { ...wanted, tiers: wanted.tiers.map((t: any) => ({ ...t, delivery: 'sometimes' })) })).status, 400);
    await c.ok('POST', `${c.B}/delivery/auto`, c.T.dm);
    const { q, a } = await ask(c, 'jess', 'Where does Velmira keep her treasury?');
    assert.equal(q.secret, true);
    assert.equal(a.status, 'pricing');
    await advance(c, 30 * 1440);
    const row = await mine(c, 'jess', a.id);
    assert.equal(row.status, 'pricing', 'never delivered on its own');
    assert.equal(row.answer, undefined);
    // Even once the DM prices and the player accepts, the DM's own answer is what is delivered.
    await c.ok('POST', `${c.B}/${a.id}/price`, c.T.dm, { costCp: 10, waitAmount: 0, answer: 'Under the old lighthouse.' });
    await c.ok('POST', `${c.B}/${a.id}/accept`, c.T.jess);
    assert.equal((await mine(c, 'jess', a.id)).answer, 'Under the old lighthouse.');
  });
});

test('TestBrokerDelivery_OutputCheckHoldsDMTextForTheDM', async () => {
  await withWorld({}, async (c) => {
    // A machine-built answer that somehow holds a DM-only line is never auto-delivered.
    const { a } = await ask(c, 'jess', 'Who rules Saltmarsh harbour?');
    run(c.deps.db, 'UPDATE broker_requests SET answer = ? WHERE id = ?', 'The harbour council secretly answers to the smuggler queen Velmira.', a.id);
    await advance(c, 120);
    const row = await mine(c, 'jess', a.id);
    assert.equal(row.status, 'waiting');
    assert.equal(row.answer, undefined);
    assert.ok(!JSON.stringify(row).includes('Velmira'));
    const dm = (await c.ok('GET', c.B, c.T.dm)).requests.find((x: any) => x.id === a.id);
    assert.equal(dm.needs_review, true, 'held for the DM');
    // A DM-written answer is the DM's call.
    await c.ok('PATCH', `${c.B}/${a.id}`, c.T.dm, { answer: 'Ask the queen herself.' });
    await c.ok('POST', `${c.B}/${a.id}/approve`, c.T.dm);
    assert.equal((await mine(c, 'jess', a.id)).answer, 'Ask the queen herself.');
  });
});

test('TestBrokerScope_SettingsSiteLinkAndSpoilerTagsAreSafe', async () => {
  await withWorld({}, async (c) => {
    // Site link: only when set, and only http(s).
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).site, null);
    await c.ok('PATCH', `/api/worlds/${c.W}/settings`, c.T.dm, { brokerSiteUrl: 'https://example.com/campaign', brokerSiteLabel: 'Campaign wiki' });
    assert.deepEqual((await c.ok('GET', `${c.B}/config`, c.T.jess)).site, { url: 'https://example.com/campaign', label: 'Campaign wiki' });
    await c.ok('PATCH', `/api/worlds/${c.W}/settings`, c.T.dm, { brokerSiteUrl: 'javascript:alert(1)' });
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).site, null);
    await c.ok('PATCH', `/api/worlds/${c.W}/settings`, c.T.dm, { brokerSiteUrl: '' });
    assert.equal((await c.ok('GET', `${c.B}/config`, c.T.jess)).site, null);
    // Allowed topics are validated and shown.
    assert.equal((await c.call('PATCH', `/api/worlds/${c.W}/settings`, c.T.dm, { brokerTopics: 'Feudal Japan' })).status, 400);
    await c.ok('PATCH', `/api/worlds/${c.W}/settings`, c.T.dm, { brokerTopics: ['Feudal Japan: history, folklore'] });
    assert.deepEqual((await c.ok('GET', `${c.B}/config`, c.T.jess)).topics, ['Feudal Japan: history, folklore']);
    // Spoiler topics are DM only.
    assert.equal((await c.call('GET', `${c.B}/spoilers`, c.T.jess)).status, 403);
    assert.equal((await c.call('PUT', `${c.B}/spoilers`, c.T.jess, { topics: ['x'] })).status, 403);
    await c.ok('PUT', `${c.B}/spoilers`, c.T.dm, { topics: ['the Midnight Pact'] });
    assert.deepEqual((await c.ok('GET', `${c.B}/spoilers`, c.T.dm)).topics, ['the Midnight Pact']);
    assert.ok(!JSON.stringify(await c.ok('GET', `${c.B}/config`, c.T.jess)).includes('Midnight'));
    assert.ok(!JSON.stringify(await c.ok('GET', `/api/worlds/${c.W}/settings`, c.T.jess)).includes('Midnight'));
    // A question that names a spoiler topic goes to the DM and looks like any unknown one.
    const sp = await ask(c, 'jess', 'What can you tell me about the midnight pact?');
    const unk = await ask(c, 'jess', 'What colour are the moon cheese caravans?');
    assert.equal(sp.a.status, 'pricing');
    assert.equal(sp.q.line, unk.q.line);
    assert.deepEqual(Object.keys(sp.q).sort(), Object.keys(unk.q).sort());
    const dm = (await c.ok('GET', c.B, c.T.dm)).requests.find((x: any) => x.id === sp.a.id);
    assert.match(dm.classification.reason, /Midnight Pact/);
    assert.equal(dm.classification.routing.scope, 'world');
    // Off topic is refused, free, and invisible to the player's list.
    const off = await ask(c, 'jess', 'What is the weather forecast for tomorrow?');
    assert.equal(off.a.status, 'noted');
    assert.equal(off.q.cost_cp, 0);
    assert.ok(!(await c.ok('GET', c.B, c.T.jess)).requests.some((x: any) => x.id === off.a.id));
    assert.equal((await c.ok('GET', c.B, c.T.dm)).requests.find((x: any) => x.id === off.a.id).classification.routing.scope, 'off-topic');
  });
});

test('TestBrokerOther_NoRulesSourceSaysSoAndItemsAreThePlayersOwn', async () => {
  const labels: Record<string, any> = {
    'What does the brass lamp do?': { scope: 'item', intent: 'fact', confidence: 0.9 },
    'How does flarbling work?': { scope: 'rules', intent: 'fact', confidence: 0.9 },
    'What does my ring do?': { scope: 'item', intent: 'fact', confidence: 0.9 },
    'Who rules Saltmarsh harbour?': { scope: 'world', intent: 'fact', confidence: 0.3 },
    'Is it nice out?': { scope: 'off-topic', intent: 'fact', confidence: 0.2 },
  };
  let calls = 0;
  const fake = (async (url: any, init: any) => {
    if (!String(url).startsWith('http://audit.invalid/')) return fetch(url, init);
    calls++;
    const user = JSON.parse(init.body).messages.find((m: any) => m.role === 'user').content;
    const l = labels[JSON.parse(user).question];
    if (!l) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ type: 'what', ...l })}\n\`\`\`` } }] }), { status: 200 });
  }) as typeof fetch;
  await withWorld({ fetch: fake, env: { ALX_MODEL_AUDIT_URL: 'http://audit.invalid/v1', ALX_MODEL_AUDIT_MODEL: 'tiny' } }, async (c) => {
    const lampPage = await c.page('items/Brass lamp', 'party', `# Brass lamp\nA brass lamp that burns without oil for one hour each day.\n\n> [!secret] DM\n> The lamp is cursed and binds its owner to Velmira.\n`);
    const lamp = await c.ok('POST', `/api/worlds/${c.W}/inventory`, c.T.dm, { owner: c.ID.jess, name: 'Brass lamp', qty: 1, note: 'Warm to the touch.', reason: 'Loot' });
    await c.ok('PUT', `/api/worlds/${c.W}/itemcards/${lamp.id}/page`, c.T.dm, { pageId: lampPage });
    const jess = await c.ok('POST', `${c.B}/quote`, c.T.jess, { question: 'What does the brass lamp do?' });
    assert.equal(jess.kind, 'other');
    assert.match(jess.answer, /Brass lamp/);
    assert.match(jess.answer, /Warm to the touch/);
    assert.match(jess.answer, /burns without oil/);
    assert.ok(!/cursed|Velmira/.test(JSON.stringify(jess)), 'player copy only');
    assert.equal(jess.sources[0].title, 'Brass lamp');
    // Tom cannot see Jess's lamp.
    const tom = await c.ok('POST', `${c.B}/quote`, c.T.tom, { question: 'What does the brass lamp do?' });
    assert.equal(tom.kind, 'other');
    assert.match(tom.answer, /don’t see anything like that/);
    assert.ok(!tom.answer.includes('without oil'));
    // No rules source for it: it says so and does not guess.
    const rules = await c.ok('POST', `${c.B}/quote`, c.T.jess, { question: 'How does flarbling work?' });
    assert.equal(rules.kind, 'other');
    assert.match(rules.answer, /no rules book/);
    assert.deepEqual(rules.sources, []);
    // Low confidence goes to the DM, never auto-answered or refused.
    const low = await ask(c, 'jess', 'Who rules Saltmarsh harbour?');
    assert.equal(low.a.status, 'pricing');
    const lowOff = await ask(c, 'jess', 'Is it nice out?');
    assert.equal(lowOff.a.status, 'pricing');
    const dm = (await c.ok('GET', c.B, c.T.dm)).requests.find((x: any) => x.id === low.a.id);
    assert.equal(dm.classification.routing.confidence, 0.3);
    // A model that fails or rambles falls back to the keyword rules.
    const fallback = await ask(c, 'jess', 'Who is the villain?');
    assert.equal(fallback.a.status, 'pricing');
    assert.equal((await c.ok('GET', c.B, c.T.dm)).requests.find((x: any) => x.id === fallback.a.id).classification.routing.source, 'rules');
    assert.ok(calls >= 5);
  });
});
