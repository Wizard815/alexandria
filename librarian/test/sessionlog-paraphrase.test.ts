// The session log's second and third leak checks: distinctive terms only
// GM-only text has, and the audit model. Paraphrases share no eight-word run
// with their source, so the shingle check alone misses them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { fullLeakCheck, rareTermCheck } from '../src/features/sessionlog/leak.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
let W = '';
let auditMode: 'off' | 'leak' | 'garbage' = 'off';
const sent: string[] = [];
const SL = () => `/api/worlds/${W}/sessionlog`;

const CLASSIFIED = 'CLASSIFIEDMARK the sealed vault opens only for the bearer of the nine pewter keys';
const PARAPHRASE = 'The keeper secretly answers to Velmira, the smuggler queen, whose payroll covers three captains. The Drowned King waits beneath the bay.';
const PLAIN = 'The party rode into Saltmarsh and met the lighthouse keeper at the busy harbour gate.';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('http://fake/')) return fetch(input, init);
  const body = JSON.parse(init.body);
  sent.push(JSON.stringify(body));
  if (auditMode === 'off') throw new Error('model down');
  const sys = String(body.messages[0].content);
  let content = '{}';
  if (/check a session summary/.test(sys)) content = auditMode === 'garbage' ? 'not json at all' : JSON.stringify({ leaks: [{ sentence: 'The town\'s chief official turns out to be the one robbing ships.', why: '[1] matches the note about the mayor' }] });
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-slogp-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_AUDIT_URL: 'http://fake/v1', ALX_MODEL_AUDIT_MODEL: 'fake' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' });
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Logland', gmAccountId: gm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).token;
  const put = (p: string, visibility: 'gm' | 'party', markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.gm, { path: p, visibility, markdown });
  await put('gm/Velmira', 'gm', '# Velmira\n\nVelmira, the smuggler queen, owns the lighthouse keeper. Her payroll: three captains of the harbour watch owe her silver. The Drowned King waits under the bay until the eclipse.\n');
  await put('gm/Mayor', 'gm', '# The mayor\n\nThe mayor is secretly the thief who robs the ships on the reef and blames the wreckers.\n');
  await put('gm/Vault', 'gm', `# Vault\n\n> [!classified] The vault\n> ${CLASSIFIED}.\n`);
  await put('places/Saltmarsh', 'party', '# Saltmarsh\n\nA fishing town with a lighthouse, a busy harbour gate and a market square.\n');
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at, stopped_at) VALUES ('as1', ?, 'Table', '2026-01-01T18:00:00.000Z', '2026-01-01T21:00:00.000Z')", W);
  run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'l1', 'as1', W, 10000, 15000, 'Jess', 'We met the lighthouse keeper at the harbour gate and he mentioned Odo Fennick', 'players', '2026-01-01T18:00:00.000Z');
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('SessionLogParaphrase: names and rare words from GM-only pages are flagged', () => {
  const hits = rareTermCheck(deps.db, W, PARAPHRASE);
  const texts = hits.map((h) => h.text).join(' | ');
  assert.ok(hits.some((h) => /Velmira/.test(h.text) && h.terms?.some((t) => /velmira/i.test(t))), `the sentence with Velmira: ${texts}`);
  assert.ok(hits.some((h) => /Drowned King/.test(h.text)), `the Drowned King sentence: ${texts}`);
  assert.ok(hits.every((h) => h.kind === 'terms' && h.source.startsWith('GM page: ')));
  // The payroll sentence on its own, with no name in it: two rare words from the same page.
  const only = rareTermCheck(deps.db, W, 'Her payroll covers three captains of the watch.');
  assert.equal(only.length, 1);
  assert.ok(['captains', 'payroll'].every((w) => only[0].terms?.map((t) => t.toLowerCase()).includes(w)), JSON.stringify(only));
});

test('SessionLogParaphrase: what the players saw or said is not flagged', () => {
  assert.deepEqual(rareTermCheck(deps.db, W, PLAIN), [], 'a plain recap');
  // Names the players said at the table are theirs.
  assert.deepEqual(rareTermCheck(deps.db, W, 'The party spoke with Odo Fennick about the lighthouse.'), []);
  assert.deepEqual(rareTermCheck(deps.db, W, 'Jessamine searched the market square in Saltmarsh.'), []);
});

test('SessionLogParaphrase: publish flags the paraphrase for review and force publishes it', async () => {
  const draft = await ok('POST', `${SL()}/drafts`, T.gm, { audioSessionId: 'as1', title: 'The road' });
  await ok('PUT', `${SL()}/drafts/${draft.id}`, T.gm, { markdown: `## Recap\n${PARAPHRASE}\n` });
  const check = await ok('GET', `${SL()}/drafts/${draft.id}/leakcheck`, T.gm);
  assert.ok(check.overlaps.length >= 2, JSON.stringify(check));
  assert.equal(check.blocked, false);
  const refused = await call('POST', `${SL()}/drafts/${draft.id}/publish`, T.gm, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.forceAllowed, true);
  assert.ok(refused.body.overlaps.some((o: any) => o.kind === 'terms'));
  // A clean text goes through.
  await ok('PUT', `${SL()}/drafts/${draft.id}`, T.gm, { markdown: `## Recap\n${PLAIN}\n` });
  const clean = await ok('POST', `${SL()}/drafts/${draft.id}/publish`, T.gm, {});
  assert.equal(clean.overlaps.length, 0);
  // Forcing the flagged text works, and says so in the audit log.
  const d2 = await ok('POST', `${SL()}/drafts`, T.gm, { audioSessionId: 'as1', title: 'Another' });
  await ok('PUT', `${SL()}/drafts/${d2.id}`, T.gm, { markdown: `## Recap\n${PARAPHRASE}\n` });
  const forced = await call('POST', `${SL()}/drafts/${d2.id}/publish`, T.gm, { force: true });
  assert.equal(forced.status, 200, forced.text);
});

test('SessionLogParaphrase: with an audit model, a leak with no shared words is flagged for the GM', async () => {
  const summary = "The town's chief official turns out to be the one robbing ships.";
  auditMode = 'off';
  const without = await fullLeakCheck(deps, W, summary);
  assert.equal(without.audited, false, 'no model: the other checks still run');
  assert.deepEqual(without.overlaps, []);
  auditMode = 'leak';
  sent.length = 0;
  const withModel = await fullLeakCheck(deps, W, summary);
  assert.equal(withModel.audited, true);
  const m = withModel.overlaps.find((o) => o.kind === 'model');
  assert.ok(m, JSON.stringify(withModel));
  assert.match(m!.source, /^GM page: /);
  assert.ok(sent.some((b) => b.includes('robs the ships')), 'the mayor note was put in front of the model');
  assert.ok(m!.why?.includes('mayor'));
  assert.equal(m!.aside, false, 'for the GM to review, not a hard stop');
  // Classified text is never sent to any model.
  assert.ok(sent.length >= 1);
  for (const body of sent) assert.ok(!body.includes('CLASSIFIEDMARK') && !body.includes('pewter'), 'classified text left the building');
  auditMode = 'garbage';
  const bad = await fullLeakCheck(deps, W, summary);
  assert.equal(bad.audited, false);
  auditMode = 'off';
});
