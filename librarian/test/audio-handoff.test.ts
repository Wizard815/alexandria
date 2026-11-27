// The session summary after a recording: made again from the final transcript (and after an undo), and handed to the GM
// for review either way: Minerva's queue when it is on, a "Summary ready" card on Recordings when it is off. Nothing is
// written to the status doc or the session log without the GM's approval, and players never see the GM's summary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { afterFinal, afterRecording } from '../src/features/audio/handoff.ts';
import { getSummary } from '../src/features/audio/summary.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const GM_ASIDE = 'the innkeeper is the cult leader';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
// The fake model folds: the new summary is the previous one plus one bullet per new line.
const fakeFetch: typeof fetch = async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith('http://fake/')) return fetch(input, init);
  const body = JSON.parse(init.body);
  const user = String(body.messages.at(-1).content);
  const prev = /Summary so far:\n([\s\S]*?)\n\nNew transcript lines/.exec(user)?.[1] ?? '';
  const fresh = (user.split('New transcript lines (oldest first):\n')[1] ?? '').split('\n').filter(Boolean);
  const content = `${prev.startsWith('(nothing yet') ? '' : prev}\n${fresh.map((l) => `- ${l}`).join('\n')}`.trim();
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

let n = 0;
const line = (sid: string, text: string, audience: 'players' | 'gm' = 'players') => {
  n++;
  run(deps.db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', `l${n}`, sid, W, n * 5000, n * 5000 + 4000, 'Table', text, audience, new Date(Date.now() + n).toISOString());
};
const session = (sid: string, name: string) => run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, stopped_at) VALUES (?, ?, ?, ?, ?)', sid, W, name, new Date(Date.now() - 3600_000).toISOString(), new Date().toISOString());
/** What the final pass leaves behind: new lines in place of the live ones, and audio_final done. */
const finalTranscript = (sid: string, texts: string[], status: 'done' | 'undone' = 'done') => {
  run(deps.db, 'DELETE FROM audio_lines WHERE session_id = ?', sid);
  for (const t of texts) line(sid, t, t.startsWith('GM aside') ? 'gm' : 'players');
  run(deps.db, `INSERT INTO audio_final (session_id, status, step, pct, started_at, finished_at) VALUES (?, ?, 'Done', 100, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at`, sid, status, new Date().toISOString(), new Date().toISOString());
};
const A = (sid: string) => `/api/worlds/${W}/audio/sessions/${sid}`;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-handoff-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_MODEL_CHAT_URL: 'http://fake/v1', ALX_MODEL_CHAT_MODEL: 'fake' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' });
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Handland', gmAccountId: gm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).token;
});
after(async () => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Handoff_minervaOff: the GM still gets the summary, as a card on Recordings to approve, edit or discard', async () => {
  session('h1', 'Session 1');
  line('h1', 'We meet the ferryman at the docks');
  line('h1', `GM aside: ${GM_ASIDE}`, 'gm');
  await afterRecording(deps, W, 'h1');
  const v = await ok('GET', `${A('h1')}/handoff`, T.gm);
  assert.equal(v.minervaOn, false);
  assert.equal(v.where, 'recordings', 'the page says where the summary went');
  assert.equal(v.cards.length, 1);
  assert.equal(v.cards[0].status, 'pending');
  assert.equal(v.cards[0].source, 'live');
  assert.ok(v.cards[0].text.includes('ferryman'));
  // Players never see it, nor can they decide it.
  assert.equal((await call('GET', `${A('h1')}/handoff`, T.jess)).status, 403);
  assert.equal((await call('POST', `${A('h1')}/handoff/${v.cards[0].id}`, T.jess, { action: 'approve' })).status, 403);
  assert.equal((await call('GET', `${A('h1')}/handoff`)).status, 401);
  // Nothing in the session log until the GM approves.
  assert.equal(one<any>(deps.db, 'SELECT count(*) AS n FROM sessionlog_drafts WHERE world_id = ?', W).n, 0);
  // Again after the recording (no new lines): still one card.
  await afterRecording(deps, W, 'h1');
  assert.equal((await ok('GET', `${A('h1')}/handoff`, T.gm)).cards.length, 1);

  // The final transcript replaces the live lines: the pending card is brought up to date, from the final lines only.
  finalTranscript('h1', ['We meet the ferryman Oskar at the north docks', `GM aside: ${GM_ASIDE}`]);
  await afterFinal(deps, W, 'h1');
  const v2 = await ok('GET', `${A('h1')}/handoff`, T.gm);
  assert.equal(v2.cards.length, 1, 'the pending card is updated, not doubled');
  assert.equal(v2.cards[0].source, 'final');
  assert.ok(v2.cards[0].text.includes('Oskar') && !v2.cards[0].text.includes('ferryman at the docks'), 'made again from the final lines, not folded on top');
  assert.ok(!getSummary(deps, 'h1', 'party').text.includes(GM_ASIDE), 'the players\' summary is made again without GM lines');
  assert.ok(getSummary(deps, 'h1', 'party').text.includes('Oskar'));

  // Approve with the GM's edit: saved as a session log draft (GM only), not published.
  const edited = `${v2.cards[0].text}\n- The GM added this`;
  const r = await ok('POST', `${A('h1')}/handoff/${v2.cards[0].id}`, T.gm, { action: 'approve', text: edited });
  assert.ok(r.logDraftId);
  const ver = one<any>(deps.db, 'SELECT v.markdown FROM sessionlog_versions v JOIN sessionlog_drafts d ON d.id = v.draft_id WHERE d.id = ?', r.logDraftId);
  assert.ok(ver.markdown.includes('The GM added this') && ver.markdown.includes('# Session 1'));
  assert.equal(one<any>(deps.db, 'SELECT audio_session_id FROM sessionlog_drafts WHERE id = ?', r.logDraftId).audio_session_id, 'h1');
  assert.equal((await ok('GET', `/api/worlds/${W}/sessionlog`, T.jess)).length, 0, 'players see no session log entry: nothing was published');
  assert.equal((await call('POST', `${A('h1')}/handoff/${v2.cards[0].id}`, T.gm, { action: 'approve' })).status, 409, 'once');

  // Undo: the summary is made again from the live lines; the approved card is not touched, a second one is added.
  finalTranscript('h1', ['We meet the ferryman at the docks', 'A storm rolls in'], 'undone');
  await afterFinal(deps, W, 'h1');
  const v3 = await ok('GET', `${A('h1')}/handoff`, T.gm);
  assert.equal(v3.cards.length, 2);
  assert.equal(v3.cards[0].status, 'approved');
  assert.ok(v3.cards[0].text.includes('The GM added this'), 'the approved one is left as the GM approved it');
  assert.equal(v3.cards[1].status, 'pending');
  assert.ok(v3.cards[1].text.includes('storm'));
  // Discarded: a later change does not bring it back.
  await ok('POST', `${A('h1')}/handoff/${v3.cards[1].id}`, T.gm, { action: 'discard' });
  finalTranscript('h1', ['Something else entirely happens'], 'done');
  await afterFinal(deps, W, 'h1');
  const v4 = await ok('GET', `${A('h1')}/handoff`, T.gm);
  assert.deepEqual(v4.cards.map((c: any) => c.status), ['approved', 'discarded']);
});

test('Handoff_minervaOn: the final transcript updates a pending hand-off; an approved one gets a second draft; nothing reaches the status doc unapproved', async () => {
  await ok('POST', `/api/worlds/${W}/minerva/enable`, T.gm, {});
  const { minervaBrief } = await import('../src/features/minerva/context.ts');
  session('h2', 'Session 2');
  line('h2', 'The party sails for the Ember Isles');
  await afterRecording(deps, W, 'h2');
  const drafts = () => all<any>(deps.db, "SELECT id, status, title, op FROM minerva_drafts WHERE world_id = ? AND review = 'handoff-h2' ORDER BY created_at, rowid", W);
  assert.equal(drafts().length, 1);
  assert.match(drafts()[0].title, /running notes/);
  const v = await ok('GET', `${A('h2')}/handoff`, T.gm);
  assert.equal(v.where, 'minerva', 'the page says it went to Minerva');
  assert.equal(v.cards.length, 0, 'no second copy on Recordings');

  finalTranscript('h2', ['The party sails for the Ember Isles aboard the Gull']);
  await afterFinal(deps, W, 'h2');
  assert.equal(drafts().length, 1, 'updated in place while pending');
  assert.equal(drafts()[0].status, 'pending');
  assert.match(drafts()[0].title, /final transcript/);
  assert.ok(JSON.parse(drafts()[0].op).text.includes('aboard the Gull'));
  assert.ok(!minervaBrief(deps, W).includes('aboard the Gull'), 'not in the status doc before the GM approves');

  await ok('POST', `/api/worlds/${W}/minerva/review/${drafts()[0].id}`, T.gm, { decision: 'approve' });
  assert.ok(minervaBrief(deps, W).includes('aboard the Gull'));
  finalTranscript('h2', ['The party sails for the Ember Isles aboard the Gull', 'Kraken sighted off the bow'], 'done');
  await afterFinal(deps, W, 'h2');
  const ds = drafts();
  assert.equal(ds.length, 2, 'a second draft next to the approved one');
  assert.equal(ds[0].status, 'approved');
  assert.ok(!JSON.parse(ds[0].op).text.includes('Kraken'), 'the approved draft is not touched');
  assert.equal(ds[1].status, 'pending');
  assert.match(ds[1].title, /updated from the final transcript/);
  assert.ok(!minervaBrief(deps, W).includes('Kraken'), 'the second one waits for the GM too');
  // Rejected: left alone.
  await ok('POST', `/api/worlds/${W}/minerva/review/${ds[1].id}`, T.gm, { decision: 'reject' });
  finalTranscript('h2', ['Something new'], 'done');
  await afterFinal(deps, W, 'h2');
  assert.deepEqual(drafts().map((x) => x.status), ['approved', 'rejected']);
});

test('Handoff_watch: a final pass that says done remakes the summary by itself', async () => {
  session('h3', 'Session 3');
  line('h3', 'Live words about a lighthouse');
  await afterRecording(deps, W, 'h3');
  finalTranscript('h3', ['Final words about a lighthouse keeper']);
  deps.hub.emit(W, 'transcript-final', { sessionId: 'h3', status: 'done', step: 'Done', pct: 100 }, (v: any) => v.role === 'gm');
  for (let i = 0; i < 50 && !getSummary(deps, 'h3', 'gm').text.includes('keeper'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(getSummary(deps, 'h3', 'gm').text.includes('keeper'));
  assert.ok(!getSummary(deps, 'h3', 'gm').text.includes('Live words'));
});
