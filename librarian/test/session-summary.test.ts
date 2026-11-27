// The running session summary: folded forward as lines come in, two summaries per session (the GM's from every
// line, the players' from player lines only), never a classified line sent to a model, in the assistant's
// context and in the session log's material.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { updateBoth, updateSummary, latestSummary, SUMMARY_LINES } from '../src/features/audio/summary.ts';
import { gather, material, resolveRange } from '../src/features/sessionlog/api.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const DM_SECRET = 'the baron is really a vampire';
const CLASSIFIED = 'the Glass Throne cipher word is never spoken aloud in the hall of the seven captains';
const asked: string[] = [];

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
// The fake chat model writes the new summary as "previous + one bullet per new line", so folding can be checked.
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('http://fake/')) return fetch(input, init);
  const body = JSON.parse(init.body);
  const user = String(body.messages.at(-1).content);
  if (String(body.messages[0].content).startsWith('You check how a tabletop')) {
    asked.push('RULES ' + user);
    const content = /^Rule: Counterspell/.test(user) && /Arcana check/.test(user) ? JSON.stringify({ ok: false, note: 'In the 2024 rules Counterspell has no ability check: the caster of the spell makes a Constitution save.' }) : JSON.stringify({ ok: true });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  asked.push(user);
  const prev = /Summary so far:\n([\s\S]*?)\n\nNew transcript lines/.exec(user)?.[1] ?? '';
  const fresh = (user.split('New transcript lines (oldest first):\n')[1] ?? '').split('\n').filter(Boolean);
  const content = `${prev.startsWith('(nothing yet') ? '' : prev}\n${fresh.map((l) => `- ${l}`).join('\n')}`.trim();
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

let n = 0;
const line = (text: string, audience: 'players' | 'dm') => {
  n++;
  run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `l${n}`, 'ss1', W, n * 5000, n * 5000 + 4000, 'Table', text, audience, new Date(Date.now() + n).toISOString());
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-ssum-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_CHAT_URL: 'http://fake/v1', ALX_MODEL_CHAT_MODEL: 'fake' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sumland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).token;
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'vault/Glass', visibility: 'classified', markdown: `# Glass\nIn Saltreach ${CLASSIFIED}.\n` });
  run(deps.db, "INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES ('ss1', ?, 'Session 9', ?)", W, new Date().toISOString());
});
after(async () => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('SessionSummary: waits for enough lines, then folds them in; the next pass only sends what is new', async () => {
  line('We reach the harbour at dusk', 'players');
  const early = await updateSummary(deps, W, 'ss1', 'party');
  assert.equal(early.ran, false, 'one line is not enough yet');
  for (let i = 0; i < SUMMARY_LINES; i++) line(`Jessamine haggles with the fishmonger, round ${i}`, 'players');
  const r = await updateSummary(deps, W, 'ss1', 'party');
  assert.ok(r.ran && r.lines === SUMMARY_LINES + 1, JSON.stringify(r));
  line('A gull steals the map', 'players');
  asked.length = 0;
  const forced = await updateSummary(deps, W, 'ss1', 'party', { force: true });
  assert.equal(forced.lines, 1);
  assert.ok(asked[0].includes('harbour at dusk') && asked[0].split('New transcript lines')[1].includes('gull steals the map') && !asked[0].split('New transcript lines')[1].includes('harbour at dusk'), 'only the new line is sent, the rest rides in the summary');
});

test('SessionSummary: the players\' summary never holds a GM line; no classified line reaches a model', async () => {
  line(`GM aside: ${DM_SECRET}`, 'dm');
  line(`Tomas says ${CLASSIFIED}`, 'players');
  asked.length = 0;
  await updateBoth(deps, W, 'ss1', { force: true });
  assert.ok(asked.every((a) => !a.includes(CLASSIFIED)), 'a classified line is left out');
  const party = (await ok('GET', `/api/worlds/${W}/audio/sessions/ss1/summary`, T.jess)).text;
  const dmSum = (await ok('GET', `/api/worlds/${W}/audio/sessions/ss1/summary`, T.dm)).text;
  assert.ok(!party.includes(DM_SECRET), 'players get the party summary');
  assert.ok(dmSum.includes(DM_SECRET), 'the GM summary has every line the GM can read');
  assert.equal((await call('POST', `/api/worlds/${W}/audio/sessions/ss1/summary/refresh`, T.jess)).status, 403);
});

test('SessionSummary: the assistant\'s context and the session log notes use the right one', async () => {
  assert.ok(latestSummary(deps, W, 'dm')!.text.includes(DM_SECRET));
  assert.ok(!latestSummary(deps, W, 'party')!.text.includes(DM_SECRET));
  const g = gather(deps.db, W, resolveRange(deps.db, W, { audioSessionId: 'ss1' }));
  const mat = material(g);
  assert.ok(mat.includes('RUNNING NOTES') && mat.includes('gull steals the map'));
  assert.ok(!mat.includes(DM_SECRET), 'the session log only ever gets the players\' notes');
});

test('SessionSummary: a line repeating classified text is left out of the assistant\'s live lines, so its requests still go', async () => {
  const { liveLines } = await import('../src/features/minerva/live.ts');
  const live = liveLines(deps, W, true, 200);
  assert.ok(live.lines.length > 0);
  assert.ok(live.lines.every((l: any) => !l.text.includes('Glass Throne')), 'the classified line is not handed to the harness');
});

test('RulesCheck: a rules term said at the table is checked once; a clear mistake becomes a GM-only note', async () => {
  const { rulesPass, ruleNotes } = await import('../src/features/audio/rulescheck.ts');
  await rulesPass(deps, W, 'ss1'); // everything said so far is seen first
  line('Jessamine: I cast counter spell on the mage!', 'players');
  line('GM: Okay, make an Arcana check for the counterspell.', 'players');
  asked.length = 0;
  const r = await rulesPass(deps, W, 'ss1');
  assert.equal(r.flagged, 1, JSON.stringify(r));
  assert.ok(asked.some((a) => a.startsWith('RULES') && a.includes('Counterspell')), 'the rule text and the lines went to the model');
  const notes = ruleNotes(deps, 'ss1', { onlyFlags: true });
  assert.equal(notes[0].term, 'Counterspell');
  assert.match(notes[0].note, /Constitution save/);
  line('GM: and counter spell again next round', 'players');
  assert.equal((await rulesPass(deps, W, 'ss1')).checked, 0, 'not the same term again within ten minutes');
  assert.equal((await call('GET', `/api/worlds/${W}/audio/sessions/ss1/rule-notes`, T.jess)).status, 403, 'players never see the checks');
  assert.equal((await ok('GET', `/api/worlds/${W}/audio/sessions/ss1/rule-notes`, T.dm)).notes.length, 1);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { rulesCheck: 'off' });
  line('I cast Shield as a reaction', 'players');
  assert.equal((await rulesPass(deps, W, 'ss1')).checked, 0, 'off is off');
});

test('SessionHandoff: when a recording ends Minerva drafts "Last session" for the GM; approved, the next session reads it', async () => {
  const { draftHandoff } = await import('../src/features/minerva/after.ts');
  const { minervaBrief } = await import('../src/features/minerva/context.ts');
  assert.equal(draftHandoff(deps, W, 'ss1'), 'off', 'nothing while Minerva is off');
  await ok('POST', `/api/worlds/${W}/minerva/enable`, T.dm, {});
  run(deps.db, "UPDATE audio_sessions SET stopped_at = ? WHERE id = 'ss1'", new Date().toISOString());
  assert.equal(draftHandoff(deps, W, 'ss1'), 'created');
  assert.equal(draftHandoff(deps, W, 'ss1'), 'kept', 'once per recording');
  assert.ok(!minervaBrief(deps, W).includes('gull steals the map'), 'not before the GM approves');
  await ok('POST', `/api/worlds/${W}/minerva/review/approve-all`, T.dm, {});
  const brief = minervaBrief(deps, W);
  assert.match(brief, /Last session \(approved hand-off\)/);
  assert.ok(brief.includes('gull steals the map'), 'the next session starts from it');
});
