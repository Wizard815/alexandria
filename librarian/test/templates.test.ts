// Templates & guides: trigger matching, guide injection into the DM's assistant, web query blocking (fail closed:
// DM-only and classified words never leave), drafting with the assistant and deriving a guide from example pages.
// The chat model and the web search are the fake models server (scripts/fake-models.ts): it answers SearXNG's
// GET /search too, so every outgoing search is visible in its request log.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { fillQuery, matchGuides, namedGuide, nearIn, referenceIn, triggerRe, type Matchable } from '../src/features/templates/match.ts';
import { commonStructure, heuristicDraft } from '../src/features/templates/draft.ts';
import { blockedQuery, secretTerms } from '../src/features/templates/web.ts';
import { startFakeModels } from '../scripts/fake-models.ts';

// ---- a world, the fake models server, and the assistant ----
// (Every top-level await comes before the first test: a test registered before one ends the run early.)

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const fakes = await startFakeModels(0);
cleanups.push(() => fakes.close());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-templates-'));
cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_CHAT_URL: fakes.baseUrl, ALX_MODEL_CHAT_MODEL: 'fake-chat' } });
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
const T: Record<string, string> = {};
T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
const ads = (await ok('POST', '/api/admin-auth/login', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
const dmId = (await ok('POST', '/api/admin/accounts', ads, { username: 'dungeon', password: 'dm password 123' })).account.id;
T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
const W = (await ok('POST', '/api/admin/worlds', ads, { name: 'Guideland', dmAccountId: dmId })).id;
const w = (p: string) => `/api/worlds/${W}${p}`;
const inv = await ok('POST', w('/invites'), T.dm, { role: 'player' });
T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
const dm = (m: string, p: string, b?: unknown) => ok(m, w(p), T.dm, b);

const CLASSIFIED = 'The Moonvault opens only when the Quorlith sigil burns under three moons at once';
const page = async (p: string, visibility: string, markdown: string) => (await dm('PUT', '/library/pages', { path: p, visibility, markdown })).id as string;
const PG: Record<string, string> = {};
PG.saltmarsh = await page('Places/Towns/Saltmarsh', 'party', '---\ntags: [town, coast]\n---\n# Saltmarsh\n## Overview\nA fishing town on the coast, ruled by a harbour council. The [[Greywater Ferry]] crosses the river.\n## People\nFishers and ferrymen.\n## Rumours\nThe lighthouse is dark.\n> [!secret] DM\n> The council answers to Velmira, the smuggler queen.\n');
PG.ferry = await page('Places/Towns/Greywater Ferry', 'party', '---\ntags: [town, river]\n---\n# Greywater Ferry\n## Overview\nA ferry hamlet on the Greywater, linked to [[Saltmarsh]].\n## People\nBoatwrights.\n## Rumours\nA drowned bell rings at night.\n');
PG.mill = await page('Places/Towns/Brindle Mill', 'party', '---\ntags: [town]\n---\n# Brindle Mill\n## Overview\nA mill village upriver.\n## Trade\nFlour.\n## People\nMillers.\n## Rumors\nThe wheel turns by itself.\n');
PG.velmira = await page('People/Velmira', 'dm', '# Velmira\nThe smuggler queen of the coast. She keeps her treasury beneath the dark lighthouse.');
PG.vault = await page('Secrets/The Moonvault', 'classified', `# The Moonvault\n${CLASSIFIED}.`);

const AGENT = w('/agent');
async function ask(text: string, chatId?: string) {
  const chat = chatId ?? (await ok('POST', `${AGENT}/chats`, T.dm, {})).id;
  const seen = fakes.requests.length;
  await ok('POST', `${AGENT}/chats/${chat}/messages`, T.dm, { text });
  for (let i = 0; i < 200; i++) {
    const c = (await ok('GET', `${AGENT}/chats/${chat}`, T.dm));
    if (!c.busy) return { chat: c, requests: fakes.requests.slice(seen) };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the assistant did not answer');
}
const modelContexts = (reqs: typeof fakes.requests) => reqs.filter((r) => r.path === '/v1/chat/completions' && !r.body?.plugins).map((r) => JSON.stringify(r.body?.messages ?? []));
const searches = () => fakes.requests.filter((r) => r.path === '/search');
const searxUrl = fakes.baseUrl.replace(/\/v1$/, '');

test('Templates: DM only; versioned; on and off; classified text is refused', async () => {
  assert.equal((await call('GET', w('/templates'), T.jess)).status, 403);
  assert.equal((await call('POST', w('/templates/draft'), T.jess, { kind: 'guide', description: 'x' })).status, 403);
  assert.equal((await call('POST', w('/templates/web/search'), T.jess, { queries: ['x'] })).status, 403);
  const t = await dm('POST', '/templates', { kind: 'library', name: 'Shop page', spec: { folder: 'Places/Shops', sections: ['Overview', 'Stock'] } });
  assert.equal(t.version, 1);
  const t2 = await dm('PUT', `/templates/${t.id}`, { spec: { sections: ['Overview', 'Stock', 'Owner'] } });
  assert.equal(t2.version, 2);
  assert.equal(t2.spec.folder, 'Places/Shops', 'a partial spec keeps the rest');
  // On/off is not a new version.
  assert.equal((await dm('PUT', `/templates/${t.id}`, { enabled: false })).version, 2);
  const back = await dm('POST', `/templates/${t.id}/restore`, { version: 1 });
  assert.deepEqual(back.spec.sections, ['Overview', 'Stock']);
  assert.equal(back.version, 3);
  assert.equal((await dm('GET', `/templates/${t.id}`)).versions.length, 3);
  // Classified text never goes into a template (templates go to the model).
  const bad = await call('POST', w('/templates'), T.dm, { kind: 'guide', name: 'Leaky', spec: { instructions: CLASSIFIED } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /classified/);
  await dm('DELETE', `/templates/${t.id}`);
});

test('Web research: off by default; DM-only and classified words never leave (fail closed)', async () => {
  assert.equal((await dm('GET', '/templates/web')).config.enabled, false);
  const off = await call('POST', w('/templates/web/search'), T.dm, { queries: ['Tomonoura Japan'] });
  assert.equal(off.status, 403);
  await dm('PUT', '/templates/web', { enabled: true, provider: 'searxng', searxUrl });
  const terms = secretTerms(deps, W);
  assert.ok(terms.dm.has('velmira'), 'a DM-only name');
  assert.ok(terms.classified.has('quorlith') && terms.classified.has('moonvault'), 'classified words');
  assert.ok(!terms.dm.has('saltmarsh') && !terms.dm.has('fishing'), 'public names and common words are not secret');
  assert.equal(blockedQuery(deps, W, ['Tomonoura Japan town history']), null);
  assert.equal(blockedQuery(deps, W, ['Velmira smuggler queen'])?.level, 'dm');
  assert.equal(blockedQuery(deps, W, ['quorlith sigil meaning'])?.level, 'classified');
  const before = searches().length;
  const dmTerm = await call('POST', w('/templates/web/search'), T.dm, { queries: ['Tomonoura history', 'Velmira'] });
  assert.equal(dmTerm.status, 422);
  assert.match(dmTerm.body.error, /DM-only name/);
  const cl = await call('POST', w('/templates/web/search'), T.dm, { queries: ['Moonvault Quorlith'] });
  assert.equal(cl.status, 422);
  assert.ok(!/quorlith|moonvault/i.test(cl.body.error), 'a classified word is never repeated');
  assert.equal(searches().length, before, 'nothing was sent for a refused query, not even the allowed one beside it');
  // The DM may allow a DM-only word, never a classified one.
  await dm('PUT', '/templates/web', { allowTerms: ['velmira', 'quorlith'] });
  assert.equal(blockedQuery(deps, W, ['Velmira']), null);
  assert.equal(blockedQuery(deps, W, ['Quorlith'])?.level, 'classified');
  await dm('PUT', '/templates/web', { allowTerms: [] });
  const okr = await dm('POST', '/templates/web/search', { queries: ['Tomonoura Japan town'] });
  assert.equal(okr.results.length, 2);
  assert.match(okr.results[0].url, /^https:\/\/example\.org\//);
  const sent = searches().at(-1)!;
  assert.equal(sent.path, '/search');
  assert.ok(all<any>(deps.db, `SELECT 1 FROM audit WHERE world_id = ? AND action = 'templates.web_blocked'`, W).length >= 2);
  await dm('PUT', '/templates/web', { enabled: false });
});

test('Templates: draft with the assistant, then derive a guide from example pages (fake model)', async () => {
  const dr = await dm('POST', '/templates/draft', { kind: 'guide', description: 'Towns: for my world always research the IRL Japanese town as well as my own world lore and the towns around it. Always do that.' });
  assert.equal(dr.template.name, 'Towns');
  assert.ok(dr.template.spec.steps.some((s: any) => s.kind === 'web'));
  assert.ok(Array.isArray(dr.questions) && dr.questions.length > 0, 'the assistant asks a few questions');
  // Answering a question is a new draft without that question.
  const dr2 = await dm('POST', '/templates/draft', { kind: 'guide', description: dr.template.description, answers: [{ q: dr.questions[0], a: 'Tomonoura' }], current: dr.template });
  assert.ok(!dr2.questions.includes(dr.questions[0]));
  const seen = fakes.requests.length;
  const der = await dm('POST', '/templates/derive', { pageIds: [PG.saltmarsh, PG.ferry, PG.mill, PG.vault] });
  assert.deepEqual(der.template.spec.sections, ['Overview', 'People', 'Rumours']);
  assert.deepEqual(der.template.spec.exemplars.sort(), [PG.saltmarsh, PG.ferry, PG.mill].sort());
  assert.equal(der.template.spec.folder, 'Places/Towns');
  assert.ok(der.template.triggers.includes('town'));
  assert.deepEqual(der.skipped, [PG.vault], 'a classified page is never read for a guide');
  // The model was asked for the wording; nothing classified went with it.
  const asked = fakes.requests.slice(seen).filter((r) => r.path === '/v1/chat/completions');
  assert.ok(asked.length >= 1);
  assert.ok(!asked.some((r) => /quorlith|moonvault/i.test(JSON.stringify(r.body))));
  assert.equal((await call('POST', w('/templates/derive'), T.dm, { pageIds: [PG.vault] })).status, 400);
});

test('Guides: a matching request gets the guide, its steps run, and the chat shows "Using guide"', async () => {
  const guide = await dm('POST', '/templates', {
    kind: 'guide', name: 'Towns', triggers: ['town', 'village', 'city'],
    spec: {
      task: 'Make a town', instructions: 'Keep the coast towns poor and proud.', sections: ['Overview', 'People', 'Rumours', 'Secrets (DM)'], folder: 'Places/Towns',
      steps: [
        { kind: 'library', text: 'Search the library for lore.' },
        { kind: 'neighbours', text: 'Find the towns around it.' },
        { kind: 'web', text: 'Research the real Japanese town.', query: '{reference} Japan town history' },
        { kind: 'exemplars', text: 'Read two town pages.' },
      ],
    },
  });
  // Web research off: the step says so, nothing is searched, the rest runs.
  const before = searches().length;
  const r1 = await ask('Make a town called Kirihama based on Tomonoura, near Saltmarsh');
  const reply = r1.chat.messages.at(-1);
  assert.equal(reply.guides.length, 1);
  assert.equal(reply.guides[0].name, 'Towns');
  const st = Object.fromEntries(reply.guides[0].steps.map((s: any) => [s.kind, s]));
  assert.equal(st.library.status, 'done');
  assert.equal(st.neighbours.status, 'done');
  assert.match(st.neighbours.detail, /Greywater Ferry/);
  assert.equal(st.exemplars.status, 'done');
  assert.equal(st.web.status, 'skipped');
  assert.match(st.web.detail, /off/);
  assert.equal(searches().length, before);
  const ctx = modelContexts(r1.requests).join('\n');
  assert.match(ctx, /GUIDE IN USE: Towns/);
  assert.match(ctx, /Keep the coast towns poor and proud/);
  assert.match(ctx, /Neighbouring places \(around Saltmarsh\)/);
  assert.match(ctx, /Exemplar \[/);
  assert.ok(!/quorlith|moonvault/i.test(ctx), 'nothing classified in the context');
  // A question about a town is not a request to make one.
  assert.equal((await ask('how many people live in the town of Saltmarsh?')).chat.messages.at(-1).guides.length, 0);

  // Web research on, Ask first: the search is a card with the query, nothing is sent until the DM approves.
  await dm('PUT', '/templates/web', { enabled: true, provider: 'searxng', searxUrl });
  await dm('PATCH', '/settings', { agentAuto: false });
  const r2 = await ask('Make a town called Kirihama based on Tomonoura, near Saltmarsh');
  const card = r2.chat.actions.find((a: any) => a.tool === 'web_research');
  assert.ok(card && card.status === 'pending', 'a card for the search');
  assert.match(card.summary, /Search the web for "Tomonoura Japan town history"/);
  assert.equal(card.args.guide, guide.id);
  assert.equal(searches().length, before, 'nothing sent before the approval');
  assert.equal(r2.chat.messages.at(-1).guides[0].steps.find((s: any) => s.kind === 'web').status, 'waiting');
  const approved = await call('POST', `${AGENT}/actions/${card.id}`, T.dm, { decision: 'approve' });
  assert.equal(approved.body.status, 'done');
  assert.equal(searches().length, before + 1);
  assert.equal(new URL(searches().at(-1)!.path, 'http://x').pathname, '/search');
  // The results come into the chat, and the assistant carries on with them (the guide again, no second search).
  let c: any;
  for (let i = 0; i < 200; i++) { c = await ok('GET', `${AGENT}/chats/${r2.chat.id}`, T.dm); if (!c.busy && c.messages.length >= 5) break; await new Promise((r) => setTimeout(r, 25)); }
  assert.ok(c.messages.some((m: any) => /Web research results \(2/.test(m.text) && /example\.org/.test(m.text)));
  const cont = c.messages.at(-1);
  assert.equal(cont.guides[0]?.name, 'Towns');
  assert.equal(cont.guides[0].steps.find((s: any) => s.kind === 'web').status, 'done');
  assert.equal(searches().length, before + 1);

  // Auto: the search runs at once and its sources are cited.
  await dm('PATCH', '/settings', { agentAuto: true });
  const r3 = await ask('Write a new village called Hamazaki based on Kotohira near Saltmarsh');
  const web3 = r3.chat.messages.at(-1).guides[0].steps.find((s: any) => s.kind === 'web');
  assert.equal(web3.status, 'done', JSON.stringify(web3));
  assert.ok(r3.chat.messages.at(-1).citations.some((x: any) => x.kind === 'web' && /^https:\/\/example\.org\//.test(x.id)));
  assert.match(modelContexts(r3.requests).join('\n'), /Web research for \\"Kotohira Japan town history\\"/);
  // A reference that is a DM-only name is blocked before anything is sent, in Auto too.
  const n = searches().length;
  const r4 = await ask('Make a town based on Velmira near Saltmarsh');
  assert.equal(r4.chat.messages.at(-1).guides[0].steps.find((s: any) => s.kind === 'web').status, 'blocked');
  assert.equal(searches().length, n);
  // The model asking for a blocked search directly is refused too (no card, nothing sent).
  const r5 = await ask('FAKE_CALL web_research {"queries":["Velmira smuggler"]}');
  assert.equal(r5.chat.actions.filter((a: any) => a.tool === 'web_research').length, 0);
  assert.equal(searches().length, n);
  // Turned off, the guide is not used.
  await dm('PUT', `/templates/${guide.id}`, { enabled: false });
  assert.equal((await ask('Make a town called Ushio based on Tomonoura')).chat.messages.at(-1).guides.length, 0);
  await dm('PATCH', '/settings', { agentAuto: false });
  await dm('PUT', '/templates/web', { enabled: false });
});

test('Templates: a shop generation template steers the shop generator', async () => {
  const t = await dm('POST', '/templates', { kind: 'shop', name: 'Herb shops', spec: { shopType: 'apothecary', guide: '6 items, no magic, markup 20%', stock: ['healing herbs'] } });
  const r = await dm('POST', `/templates/${t.id}/shop`, {});
  assert.equal(r.draft.kind, 'alchemist', 'the free-text type picks the generator kind');
  assert.equal(r.draft.guided, true);
  assert.ok(r.draft.stock.length > 0 && r.draft.stock.length <= 6, `stock follows the guide: ${r.draft.stock.length}`);
  assert.equal(r.draft.markupPct, 20);
  assert.equal((await call('POST', w(`/templates/${t.id}/shop`), T.jess, {})).status, 403);
});

test('Templates: the agent tools list, read, create and update templates', async () => {
  const names = (await import('../src/routes/mcpServer.ts')).toolsFor(true).map((t: any) => t.name);
  for (const n of ['list_dm_templates', 'get_dm_template', 'create_dm_template', 'update_dm_template', 'web_research']) assert.ok(names.includes(n), n);
  // Players' keys never list them.
  const playerNames = (await import('../src/routes/mcpServer.ts')).toolsFor(false).map((t: any) => t.name);
  assert.ok(!playerNames.includes('web_research') && !playerNames.includes('create_dm_template'));
  const r = await ask('FAKE_CALL create_dm_template {"kind":"guide","name":"NPCs","triggers":["npc"],"spec":{"sections":["Look","Wants"]}}');
  const card = r.chat.actions.find((a: any) => a.tool === 'create_dm_template');
  assert.equal(card.status, 'pending');
  assert.match(card.summary, /Save the guide template "NPCs"/);
  assert.equal((await call('POST', `${AGENT}/actions/${card.id}`, T.dm, { decision: 'approve' })).body.status, 'done');
  const got = await dm('GET', '/templates/NPCs');
  assert.deepEqual(got.spec.sections, ['Look', 'Wants']);
});

// ---- trigger matching (pure) ----

const G = (id: string, name: string, triggers: string[], extra: Partial<Matchable> = {}): Matchable => ({ id, name, kind: 'guide', triggers, enabled: true, spec: {}, ...extra });
const TOWNS = G('t1', 'Towns', ['town', 'village', 'city']);
const TAVERNS = G('t2', 'Taverns', ['tavern', 'inn']);
const OFF = G('t3', 'Dungeons', ['dungeon'], { enabled: false });
const MACRO = G('t4', 'Ambush macro', ['town'], { kind: 'macro' });
const LIST = [TOWNS, TAVERNS, OFF, MACRO];
const names = (text: string) => matchGuides(text, LIST).map((m) => m.t.name);

test('Guides: trigger words match whole words and plurals, in a request to make something', () => {
  assert.deepEqual(names('Make a village by the river'), ['Towns']);
  assert.deepEqual(names('Create two new cities on the coast'), ['Towns']);
  assert.deepEqual(names('write up a tavern for the docks'), ['Taverns']);
  // Both, the one with more hits first.
  assert.deepEqual(names('make a town with a city gate and an inn'), ['Towns', 'Taverns']);
  // Not inside other words, and not a plain question.
  assert.deepEqual(names('make a downtown market'), []);
  assert.deepEqual(names('how big is the town?'), []);
  // Off, and kinds the assistant does not read (a macro template), never match.
  assert.deepEqual(names('make a dungeon'), []);
  assert.ok(triggerRe('city').test('three cities') && triggerRe('inn').test('two inns') && !triggerRe('inn').test('dinner'));
  // A guide marked `always` matches without a verb.
  assert.deepEqual(matchGuides('the tavern by the bridge', [G('a', 'Always taverns', ['tavern'], { spec: { always: true } })]).map((m) => m.t.name), ['Always taverns']);
});

test('Guides: "use guide X" names one; talking about guides, or "no guide", does not trigger', () => {
  assert.equal(namedGuide('use guide Towns: make a port'), 'Towns');
  assert.equal(namedGuide('please follow the Taverns guide for this'), 'Taverns');
  const m = matchGuides('use guide taverns to write up the harbour', LIST);
  assert.equal(m[0].t.name, 'Taverns');
  assert.equal(m[0].why, 'named');
  // A named guide works even without a "make" verb, and its name may be followed by more words.
  assert.equal(matchGuides('Continue with the results above, using guide Towns.', LIST)[0]?.t.name, 'Towns');
  assert.deepEqual(names('make a guide for towns'), []);
  assert.deepEqual(names('make a town, no guide'), []);
});

test('Guides: the reference, the name and the places nearby are read from the request', () => {
  const req = 'Make a town called Kirihama based on Tomonoura, near Saltmarsh';
  assert.equal(referenceIn(req), 'Tomonoura');
  assert.deepEqual(nearIn(req), ['Saltmarsh']);
  assert.equal(fillQuery('{reference} Japan town history', req), 'Tomonoura Japan town history');
  // A query that needs a reference the request does not give is not made.
  assert.equal(fillQuery('{reference} Japan town', 'Make a town called Kirihama'), '');
});

test('Templates: the assistant\'s draft from a description works with no model', () => {
  const d = heuristicDraft('guide', 'Towns: for my world always research the IRL Japanese town as well as my own world lore and the towns around it. Always do that.');
  assert.equal(d.template.name, 'Towns');
  assert.ok(d.template.triggers.includes('town') && d.template.triggers.includes('village'));
  const kinds = (d.template.spec as any).steps.map((s: any) => s.kind);
  for (const k of ['library', 'neighbours', 'web', 'exemplars']) assert.ok(kinds.includes(k), `a ${k} step`);
  assert.match((d.template.spec as any).steps.find((s: any) => s.kind === 'web').query, /^\{reference\} Japan town/);
  assert.ok(d.questions.length >= 1 && d.questions.length <= 3);
  const macro = heuristicDraft('macro', 'Open the shop {{shop}} and play calm music');
  assert.deepEqual((macro.template.spec as any).params.map((p: any) => p.name), ['shop']);
});

test('Templates: the common structure of example pages', () => {
  const st = commonStructure([
    { id: 'a', title: 'A', path: 'Places/Towns/A', tags: ['town', 'coast'], body: '# A\n## Overview\nx [[B]]\n## People\ny\n## Rumours\nz\n> [!secret] DM\n> s' },
    { id: 'b', title: 'B', path: 'Places/Towns/B', tags: ['town'], body: '# B\n## Overview\nx [[A]]\n## Trade\nq\n## People\ny\n## Rumours\nz\n> [!secret] DM\n> s' },
    { id: 'c', title: 'C', path: 'Places/Towns/C', tags: ['town', 'river'], body: '# C\n## Overview\nx\n## People\ny\n## Rumors\nz' },
  ]);
  assert.deepEqual(st.sections, ['Overview', 'People', 'Rumours']);
  assert.deepEqual(st.tags, ['town']);
  assert.equal(st.folder, 'Places/Towns');
  assert.ok(st.secrets && st.links);
});

test('Templates: export a package and import it into another world (all or none; same name updates)', async () => {
  const g = await dm('POST', '/templates', { kind: 'guide', name: 'Make a town', triggers: ['town'], spec: { task: 'Make a town', sections: ['Overview', 'People'], exemplars: [PG.saltmarsh] } });
  const m = await dm('POST', '/templates', { kind: 'macro', name: 'Weather', spec: { prompt: 'Roll the weather for {place}', params: [{ name: 'place', label: 'Place', default: 'here' }] } });
  assert.equal((await call('GET', w('/templates/export'), T.jess)).status, 403);
  const pkg = await dm('GET', `/templates/export?ids=${g.id},${m.id}`);
  assert.equal(pkg.type, 'alexandria-templates');
  assert.equal(pkg.templates.length, 2);
  assert.deepEqual(pkg.templates[0].spec.exemplars, [], "example pages are this world's library, so they stay home");
  assert.ok(!JSON.stringify(pkg).includes(g.id), 'no ids travel');
  // Another world (same DM).
  const W2 = (await ok('POST', '/api/admin/worlds', ads, { name: 'Elsewhere', dmAccountId: dmId })).id;
  const w2 = (p: string) => `/api/worlds/${W2}${p}`;
  const checked = await ok('POST', w2('/templates/import'), T.dm, { file: pkg, check: true });
  assert.equal(checked.templates.length, 2);
  assert.equal((await ok('GET', w2('/templates'), T.dm)).templates.length, 0, 'a check saves nothing');
  const r1 = await ok('POST', w2('/templates/import'), T.dm, { file: pkg });
  assert.deepEqual(r1.created.sort(), ['Make a town', 'Weather']);
  // Again: nothing changed. Changed: a new version of the same template, not a copy.
  assert.deepEqual((await ok('POST', w2('/templates/import'), T.dm, { file: pkg })).unchanged.length, 2);
  pkg.templates[1].spec.prompt = 'Roll the weather and the wind for {place}';
  const r3 = await ok('POST', w2('/templates/import'), T.dm, { file: pkg });
  assert.deepEqual(r3.updated, ['Weather']);
  const list = (await ok('GET', w2('/templates'), T.dm)).templates;
  assert.equal(list.length, 2);
  assert.equal(list.find((t: any) => t.name === 'Weather').version, 2);
  // A bare template works too; a bad one, or classified text, saves nothing at all.
  assert.deepEqual((await ok('POST', w2('/templates/import'), T.dm, { file: { kind: 'library', name: 'NPC page', spec: { sections: ['Look'] } } })).created, ['NPC page']);
  const bad = await call('POST', w2('/templates/import'), T.dm, { file: { type: 'alexandria-templates', templates: [{ kind: 'library', name: 'Good one' }, { kind: 'nope', name: 'Bad' }] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Template 2/);
  const leak = await call('POST', w('/templates/import'), T.dm, { file: { type: 'alexandria-templates', templates: [{ kind: 'library', name: 'Fine' }, { kind: 'guide', name: 'Leaky', spec: { instructions: CLASSIFIED } }] } });
  assert.equal(leak.status, 400);
  assert.ok(!(await dm('GET', '/templates')).templates.some((t: any) => t.name === 'Fine'), 'all or none');
  const dup = await call('POST', w2('/templates/import'), T.dm, { file: { type: 'alexandria-templates', templates: [{ kind: 'library', name: 'Twin' }, { kind: 'library', name: 'twin' }] } });
  assert.equal(dup.status, 400);
  assert.equal((await call('POST', w2('/templates/import'), T.dm, { file: { type: 'alexandria-house-rules', mods: [] } })).status, 400);
  await dm('DELETE', `/templates/${g.id}`);
  await dm('DELETE', `/templates/${m.id}`);
});

test('Templates: starter packs ship 8 of each kind; adding them makes ordinary templates and leaves changed ones alone', async () => {
  const W3 = (await ok('POST', '/api/admin/worlds', ads, { name: 'Starterville', dmAccountId: dmId })).id;
  const w3 = (p: string) => `/api/worlds/${W3}${p}`;
  assert.equal((await call('GET', w('/templates/starters'), T.jess)).status, 403);
  const { packs } = await ok('GET', w3('/templates/starters'), T.dm);
  const kinds = new Map<string, number>();
  for (const p of packs) for (const t of p.templates) kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
  assert.deepEqual([...kinds.entries()].sort(), [['assist', 8], ['event', 8], ['generator', 8], ['guide', 8], ['library', 8], ['macro', 8], ['shop', 8], ['spell', 8]]);
  const one = await ok('POST', w3('/templates/starters/add'), T.dm, { pack: 'guides', names: ['Towns'] });
  assert.deepEqual(one.created, ['Towns']);
  const towns = (await ok('GET', w3('/templates'), T.dm)).templates.find((t: any) => t.name === 'Towns');
  await ok('PUT', w3(`/templates/${towns.id}`), T.dm, { description: 'My own towns' });
  for (const p of packs) await ok('POST', w3('/templates/starters/add'), T.dm, { pack: p.id });
  const all = (await ok('GET', w3('/templates'), T.dm)).templates;
  assert.equal(all.length, 64);
  assert.equal(all.find((t: any) => t.name === 'Towns').description, 'My own towns', 'a changed starter is not reset');
  assert.ok((await ok('GET', w3('/templates/starters'), T.dm)).packs.every((p: any) => p.templates.every((t: any) => t.added)));
  assert.equal((await call('POST', w3('/templates/starters/add'), T.dm, { pack: 'nope' })).status, 404);
});
