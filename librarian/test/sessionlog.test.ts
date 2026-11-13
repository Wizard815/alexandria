// Session log: drafts from players' lines only, a model summary and date
// proposal, versions, accepting the date, the leak check on publish, and
// what players see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
let modelOn = false;
const SL = () => `/api/worlds/${W}/sessionlog`;

const DM_LINE = 'the baron is actually a vampire who feeds on the orphans of the lower docks';
const ASIDE_LINE = 'privately the harbour master keeps a ledger of every smuggled crate beneath the north pier';
const PAGE_SECRET = 'The council vault hides a cursed crown that whispers to anyone who wears it at midnight.';

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
  if (!modelOn) throw new Error('model down');
  const body = JSON.parse(init.body);
  const sys = String(body.messages[0].content);
  let content: string;
  if (body.response_format) content = JSON.stringify({ minutes: 4320, reason: 'Travelled to Saltmarsh', travel: { from: 'Greywater', to: 'Saltmarsh', days: 3, route: 'the coast road' }, rests: [{ kind: 'long', minutesIn: 1440 }] });
  else if (sys.includes('Return the full revised')) content = '## Recap\nA shorter recap.\n\n## Key moments\n- Arrived.\n';
  else content = '## Recap\nThe party reached Saltmarsh and met the council.\n\n## Key moments\n- A fight at the docks.\n\n## Loot & coin\n- Some coin.\n\n## People met\n- Captain Aldous\n\n## Open threads\n- Who owns the lighthouse?\n';
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-slog-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_CHAT_URL: 'http://fake/v1', ALX_MODEL_CHAT_MODEL: 'fake' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Logland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' });
  T.jess = j.token; ID.jess = j.account.id;

  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Crown', visibility: 'dm', markdown: `# Crown\n${PAGE_SECRET}\n` });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: `# Saltmarsh\nA fishing town.\n\n> [!secret] DM\n> The mayor poisons the wells with nightshade every single winter solstice.\n` });

  // A recorded session: a players' line, a DM-only line and an aside line.
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at, stopped_at) VALUES ('as1', ?, 'Table', '2026-01-01T18:00:00.000Z', '2026-01-01T21:00:00.000Z')", W);
  run(deps.db, "INSERT INTO audio_mics (id, world_id, account_id, device_id, label, mode, players_transcript, aside, room, created_at) VALUES ('mic_a', ?, ?, 'd1', 'Aside mic', 'always', 0, 1, 0, '2026-01-01T00:00:00.000Z')", W, ID.dm);
  const line = (n: number, text: string, audience: string, sources = '[]') => run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `l${n}`, 'as1', W, n * 10000, n * 10000 + 5000, 'Someone', text, audience, '2026-01-01T18:00:00.000Z');
  line(1, 'We rode into Saltmarsh and met Captain Aldous at the busy harbour gate', 'players');
  line(2, DM_LINE, 'dm');
  line(3, ASIDE_LINE, 'dm');
  run(deps.db, "UPDATE audio_lines SET sources = '[\"mic_a\"]' WHERE id = 'l3'");
  run(deps.db, 'INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'lg1', W, 'party', 2500, 'Bandit purse', ID.dm, '2026-01-01T19:00:00.000Z', 'approved');
});
after(async () => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('SessionLog: a draft without a model uses only the players\' lines', async () => {
  modelOn = false;
  const d = await ok('POST', `${SL()}/drafts`, T.dm, { audioSessionId: 'as1' });
  assert.equal(d.usedModel, false);
  assert.equal(d.proposal, null);
  assert.equal(d.version, 1);
  for (const h of ['## Recap', '## Key moments', '## Loot & coin', '## People met', '## Open threads']) assert.ok(d.markdown.includes(h), h);
  assert.ok(d.markdown.includes('Captain Aldous'));
  assert.ok(d.markdown.includes('Bandit purse'));
  assert.ok(!d.markdown.includes('vampire'), 'DM line in summary');
  assert.ok(!d.markdown.includes('smuggled crate'), 'aside line in summary');
  assert.ok(d.dmNotes.includes('vampire'), 'DM notes keep the DM lines');
  assert.ok(d.dmNotes.includes('(aside)'));
});

let draftId = '';
test('SessionLog: with a model, a summary and a date proposal; revising makes a version', async () => {
  modelOn = true;
  const d = await ok('POST', `${SL()}/drafts`, T.dm, { audioSessionId: 'as1', title: 'The road to Saltmarsh' });
  draftId = d.id;
  assert.equal(d.usedModel, true);
  assert.ok(d.markdown.includes('met the council'));
  assert.equal(d.proposal.minutes, 4320);
  assert.equal(d.proposal.travel.to, 'Saltmarsh');
  assert.equal(d.dateStatus, 'pending');
  const rev = await ok('POST', `${SL()}/drafts/${draftId}/revise`, T.dm, { instruction: 'Make it shorter' });
  assert.equal(rev.version, 2);
  assert.ok(rev.markdown.includes('A shorter recap'));
  const put = await ok('PUT', `${SL()}/drafts/${draftId}`, T.dm, { markdown: '## Recap\nHand edit.\n' });
  assert.equal(put.version, 3);
  assert.equal(put.versions.length, 3);
  const back = await ok('POST', `${SL()}/drafts/${draftId}/restore`, T.dm, { version: 1 });
  assert.equal(back.version, 4);
  assert.ok(back.markdown.includes('met the council'));
  modelOn = false;
  const r = await call('POST', `${SL()}/drafts/${draftId}/revise`, T.dm, { instruction: 'x' });
  assert.equal(r.status, 503);
});

test('SessionLog: nothing moves until the DM accepts; accepting moves the clock and adds a travel event', async () => {
  const before = await ok('GET', `/api/worlds/${W}/clock`, T.dm);
  const d = await ok('GET', `${SL()}/drafts/${draftId}`, T.dm);
  assert.equal((await ok('GET', `/api/worlds/${W}/clock`, T.dm)).minutes, before.minutes);
  const out = await ok('POST', `${SL()}/drafts/${draftId}/date`, T.dm, { accept: true, minutes: 2880 });
  assert.equal(out.dateStatus, 'accepted');
  assert.equal(out.dateApplied.minutes, 2880);
  const after = await ok('GET', `/api/worlds/${W}/clock`, T.dm);
  assert.equal(after.minutes, before.minutes + 2880);
  const log = await ok('GET', `/api/worlds/${W}/clock/log`, T.dm);
  assert.ok(log.some((e: any) => /Saltmarsh/.test(e.reason)), JSON.stringify(log[0]));
  const events = await ok('GET', `/api/worlds/${W}/clock/events?from=${before.minutes - 10}&to=${after.minutes + 10}`, T.dm);
  const list = Array.isArray(events) ? events : events.events;
  const travel = list.find((e: any) => e.kind === 'travel');
  assert.ok(travel && travel.visibility === 'party');
  assert.equal((await call('POST', `${SL()}/drafts/${draftId}/date`, T.dm, { accept: true })).status, 409);
  assert.ok(d.id);
});

test('SessionLog: publish blocks DM-only overlaps; asides never publish, even with force', async () => {
  await ok('PUT', `${SL()}/drafts/${draftId}`, T.dm, { markdown: `## Recap\nWe learned that ${PAGE_SECRET.toLowerCase()}\n` });
  const blocked = await call('POST', `${SL()}/drafts/${draftId}/publish`, T.dm, {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.forceAllowed, true);
  assert.ok(blocked.body.overlaps[0].text.toLowerCase().includes('cursed crown'));
  assert.ok(blocked.body.overlaps[0].source.includes('dm/Crown'));

  await ok('PUT', `${SL()}/drafts/${draftId}`, T.dm, { markdown: '## Recap\nThe mayor poisons the wells with nightshade every single winter solstice.\n' });
  assert.equal((await call('POST', `${SL()}/drafts/${draftId}/publish`, T.dm, {})).status, 409, 'secret block');

  await ok('PUT', `${SL()}/drafts/${draftId}`, T.dm, { markdown: `## Recap\nThe baron: ${DM_LINE}.\n` });
  assert.equal((await call('POST', `${SL()}/drafts/${draftId}/publish`, T.dm, {})).status, 409, 'DM line');

  await ok('PUT', `${SL()}/drafts/${draftId}`, T.dm, { markdown: `## Recap\nWe heard ${ASIDE_LINE}.\n` });
  const a = await call('POST', `${SL()}/drafts/${draftId}/publish`, T.dm, { force: true });
  assert.equal(a.status, 409);
  assert.equal(a.body.forceAllowed, false);
  assert.ok(a.body.overlaps[0].aside);
  assert.equal((await ok('GET', SL(), T.dm)).length, 0);
});

test('SessionLog: players never see drafts or DM notes; a published entry reaches them with a live event', async () => {
  for (const p of [`${SL()}/drafts`, `${SL()}/drafts/${draftId}`, `${SL()}/drafts/${draftId}/leakcheck`]) assert.equal((await call('GET', p, T.jess)).status, 403, p);
  assert.equal((await call('POST', `${SL()}/drafts`, T.jess, { audioSessionId: 'as1' })).status, 403);
  assert.deepEqual(await ok('GET', SL(), T.jess), []);

  // A live stream for the player.
  const ctl = new AbortController();
  let streamed = '';
  const res = await fetch(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${T.jess}` }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; streamed += new TextDecoder().decode(value); } } catch { /* aborted */ } })();
  await new Promise((r) => setTimeout(r, 100));

  await ok('PUT', `${SL()}/drafts/${draftId}`, T.dm, { markdown: '## Recap\nThe party reached Saltmarsh and met Captain Aldous.\n' });
  const pub = await ok('POST', `${SL()}/drafts/${draftId}/publish`, T.dm, {});
  assert.equal(pub.number, 1);
  assert.ok(pub.worldFrom && pub.worldTo);
  await new Promise((r) => setTimeout(r, 150));
  ctl.abort();
  await pump.catch(() => {});
  assert.ok(streamed.includes('event: sessionlog'), streamed);

  const list = await ok('GET', SL(), T.jess);
  assert.equal(list.length, 1);
  assert.ok(list[0].summary.includes('Captain Aldous'));
  const text = JSON.stringify(list) + JSON.stringify(await ok('GET', `${SL()}/${pub.id}`, T.jess));
  for (const bad of ['vampire', 'smuggled', 'cursed crown', 'draftId', 'dmNotes']) assert.ok(!text.includes(bad), `leaked ${bad}`);

  // The calendar shows the session.
  const events = await ok('GET', `/api/worlds/${W}/clock/events?from=0&to=99999999`, T.jess);
  assert.ok((Array.isArray(events) ? events : events.events).some((e: any) => e.kind === 'session'));

  // Unpublish hides it from players, and the DM can republish it under the same number.
  await ok('POST', `${SL()}/${pub.id}/unpublish`, T.dm);
  assert.deepEqual(await ok('GET', SL(), T.jess), []);
  assert.equal((await call('GET', `${SL()}/${pub.id}`, T.jess)).status, 404);
  const again = await ok('POST', `${SL()}/drafts/${draftId}/publish`, T.dm, {});
  assert.equal(again.number, 1);
  assert.equal((await ok('GET', SL(), T.jess)).length, 1);
});

test('SessionLog: MCP tools: players read the log, only the DM write key drafts', async () => {
  const dk = await ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dm ai', access: 'write' });
  const pk = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'ai', access: 'read' });
  const rpc = async (key: string, method: string, params?: unknown) => JSON.stringify((await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method, params })).body);
  assert.ok((await rpc(dk.key, 'tools/list')).includes('draft_session_summary'));
  const pl = await rpc(pk.key, 'tools/list');
  assert.ok(pl.includes('list_session_log') && !pl.includes('draft_session_summary'));
  const got = await rpc(pk.key, 'tools/call', { name: 'list_session_log', arguments: {} });
  assert.ok(got.includes('Captain Aldous') && !got.includes('vampire'));
  assert.ok((await rpc(pk.key, 'tools/call', { name: 'draft_session_summary', arguments: {} })).includes('error'));
});
