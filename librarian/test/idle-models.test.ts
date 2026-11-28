// Idle means idle: a source that did not change is not saved again, a page that was only touched is not read by the embeddings model again,
// a page the model refuses is not asked about again after a restart, a session nobody is in is closed, and with no live session and nothing
// new the background work makes no model call at all.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';
import { all, one, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { readPages } from '../src/intake/detail.ts';
import { syncEmbeddings } from '../src/features/search/embeddings.ts';
import { syncBible } from '../src/features/bible/extract.ts';
import { bindBackoff, forgetBackoffMemory, forgetRefusals, isBackedOff, noteRefused } from '../src/features/search/copies.ts';
import { closeStaleSessions, recordingSessions } from '../src/features/audio/summary.ts';
import { FEATURES } from '../src/features/registry.ts';
import { resetBuckets } from '../src/intake/tiers.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const LK = 'https://www.legendkeeper.com/api/v3/projects/idle';
const calls = { embed: 0, embedInputs: 0, chat: 0, lk: 0, other: 0 };
const text: Record<string, string> = {};
let withTimes = false;
const N = 6;
const fake = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://models.test/v1')) {
    const body = (() => { try { return JSON.parse(String(init?.body ?? '{}')); } catch { return {}; } })();
    if (u.endsWith('/embeddings')) { calls.embed++; calls.embedInputs += (body.input ?? []).length; return json({ data: (body.input ?? []).map(() => ({ embedding: [0.3, 0.1, 0.2] })) }); }
    calls.chat++;
    return json({ choices: [{ message: { role: 'assistant', content: '{"facts": [], "ok": true}' }, finish_reason: 'stop' }] });
  }
  if (u.startsWith(LK)) {
    calls.lk++;
    const x = new URL(u);
    const p = x.pathname.slice('/api/v3/projects/idle'.length);
    const item = (i: number) => ({ id: `r${i}`, name: `Idle page ${i}`, parentId: null, tags: [], aliases: [], rank: `a${i}`, isHidden: false, ...(withTimes ? { updatedAt: '2026-01-01T00:00:00Z' } : {}), documents: [{ id: `d${i}`, name: 'Main', type: 'page' }], hasChildren: false });
    if (p === '/resources') return json({ data: Array.from({ length: N }, (_, i) => item(i + 1)), hasMore: false, nextCursor: null });
    if (p === '/calendars' || /\/features$/.test(p)) return json({ data: [] });
    let m = /^\/resources\/r(\d+)\/docs\/[^/]+\/blocks$/.exec(p);
    if (m) return json({ blocks: [{ kind: 'paragraph', content: [{ text: text[`r${m[1]}`] ?? `Body of idle page ${m[1]}. ${'The warden keeps the gate and the lantern. '.repeat(8)}` }] }] });
    m = /^\/resources\/r(\d+)$/.exec(p);
    if (m) return json({ ...item(Number(m[1])), permissions: { MEMBER: 5, ADMIN: 3, OWNER: 3 }, ancestors: [], properties: [], documents: [{ id: `d${m[1]}`, name: 'Main', type: 'page', isHidden: false, rank: 'a' }] });
  }
  calls.other++;
  return json({ error: 'unexpected' }, 404);
}) as typeof fetch;

const ENV = { ALX_MODEL_CHAT_URL: 'http://models.test/v1', ALX_MODEL_CHAT_MODEL: 'chat-mock', ALX_MODEL_EXTRA_URL: 'http://models.test/v1', ALX_MODEL_EXTRA_MODEL: 'embed-mock', ALX_CRAWL_RATE: '0' };
async function world(): Promise<{ k: Kit; sid: string; sd: any }> {
  resetBuckets();
  forgetRefusals();
  const k = await boot({ fetch: fake, env: ENV });
  cleanups.push(k.close);
  const src = await k.ok('POST', `/api/admin/worlds/${k.W}/sources`, k.T.admin, { kind: 'legendkeeper-api', name: 'Idle', config: { apiUrl: LK, apiKey: 'lk_idlekey_1234567890' }, defaultVisibility: 'party' });
  const sd = { db: k.deps.db, library: k.deps.library, dataDir: null, vaultsDir: null, fetch: fake, env: { ...ENV } as Record<string, string | undefined> };
  return { k, sid: src.id as string, sd };
}
const stamps = (k: Kit, sid: string) => Object.fromEntries(all<any>(k.deps.db, 'SELECT id, updated_at FROM pages WHERE source_id = ?', sid).map((r) => [r.id, r.updated_at]));
async function drain(k: Kit) { for (let i = 0; i < 20; i++) { const r = await syncEmbeddings(k.deps, { maxPages: 100 }); if (!r.remaining) break; } }

for (const times of [true, false]) {
  test(`Idle_ASecondSyncOfAnUnchangedSource${times ? '' : 'WithoutTimes'}ChangesNothingAndTheModelIsNotAsked`, async () => {
    withTimes = times;
    const { k, sid, sd } = await world();
    const first = await runSync(sd, sid, null);
    assert.equal(first.status, 'ok', first.error ?? '');
    assert.equal(first.stats.pages, N);
    await drain(k);
    assert.ok(calls.embed > 0, 'the first pass reads every page');
    const before = stamps(k, sid);
    const bodyBefore = all<any>(k.deps.db, 'SELECT id, ai_body, player_body FROM pages WHERE source_id = ?', sid);
    assert.equal(Object.keys(before).length, N);
    // Time passes (a scheduled sync): the stamps a changed page would get are later than these.
    await new Promise((r) => setTimeout(r, 1100));
    const e0 = calls.embed;
    const second = await runSync(sd, sid, null);
    assert.equal(second.status, 'ok');
    assert.deepEqual(stamps(k, sid), before, 'no page got a new updated_at');
    for (const b of bodyBefore) assert.equal(one<any>(k.deps.db, 'SELECT ai_body FROM pages WHERE id = ?', b.id).ai_body, b.ai_body, 'the copies were kept');
    await drain(k);
    assert.equal(calls.embed, e0, 'zero embedding calls on the second run');
    assert.equal(one<any>(k.deps.db, 'SELECT count(*) AS n FROM pages WHERE source_id = ? AND ai_body IS NULL', sid).n, 0);
  });
}

test('Idle_AChangedPageIsSavedAndReadAgainAndOnlyThatOne', async () => {
  withTimes = false;
  const { k, sid, sd } = await world();
  await runSync(sd, sid, null);
  await drain(k);
  const before = stamps(k, sid);
  await new Promise((r) => setTimeout(r, 1100));
  text.r3 = 'A new thing about the third page: the warden lost the key to the old cellar and the moat is dry. '.repeat(3);
  const inputs0 = calls.embedInputs;
  await runSync(sd, sid, null);
  const after_ = stamps(k, sid);
  const changed = Object.keys(after_).filter((id) => after_[id] !== before[id]);
  assert.equal(changed.length, 1, 'one page changed');
  assert.equal(one<any>(k.deps.db, 'SELECT title FROM pages WHERE id = ?', changed[0]).title, 'Idle page 3');
  await drain(k);
  assert.ok(calls.embedInputs > inputs0 && calls.embedInputs - inputs0 <= 3 * 3, `only that page was read again (${calls.embedInputs - inputs0} chunks, in each copy it has)`);
  delete text.r3;
});

test('Idle_APageOnlyTouchedIsNotEmbeddedAgain', async () => {
  withTimes = true;
  const { k, sid, sd } = await world();
  await runSync(sd, sid, null);
  await drain(k);
  const e0 = calls.embed;
  run(k.deps.db, `UPDATE pages SET updated_at = '2031-01-01T00:00:00.000Z' WHERE source_id = ?`, sid);
  await drain(k);
  assert.equal(calls.embed, e0, 'a new time alone does not make the model read a page again');
  const st = all<any>(k.deps.db, `SELECT s.updated_at FROM search_chunk_state s JOIN pages p ON p.id = s.page_id WHERE p.source_id = ?`, sid);
  assert.ok(st.length > 0 && st.every((r) => r.updated_at === '2031-01-01T00:00:00.000Z'), 'the stored state follows the page');
  // A real edit still is read.
  run(k.deps.db, `UPDATE pages SET ai_body = ai_body || ' and a new sentence about the harbour', player_body = player_body || ' and a new sentence about the harbour' WHERE source_id = ? AND id = (SELECT id FROM pages WHERE source_id = ? LIMIT 1)`, sid, sid);
  await drain(k);
  assert.ok(calls.embed > e0, 'an edited text is read');
  void readPages;
});

test('Idle_APageTheModelRefusesStaysRefusedAfterARestart', async () => {
  const { k } = await world();
  const r = { id: 'pg_x', scope: 'gm', updated_at: '2026-01-01T00:00:00Z' };
  noteRefused(r);
  assert.equal(isBackedOff(r), true);
  assert.equal(one<any>(k.deps.db, 'SELECT tries FROM embed_backoff WHERE page_id = ?', 'pg_x').tries, 1, 'kept in the database');
  forgetBackoffMemory(); // the process restarted
  assert.equal(isBackedOff(r), false, 'nothing in memory');
  bindBackoff(k.deps.db);
  assert.equal(isBackedOff(r), true, 'read back from the database at start');
  // An edit (a new updated_at) clears it.
  assert.equal(isBackedOff({ ...r, updated_at: '2026-02-01T00:00:00Z' }), false);
});

test('Idle_AnEmptyPageIsDoneNotRetriedForever', async () => {
  const { k } = await world();
  k.deps.library.save(k.W, { path: 'Empty.md', title: 'Empty', body: '', visibility: 'party' }, null);
  await drain(k);
  const e0 = calls.embed;
  const r = await syncEmbeddings(k.deps, { maxPages: 100 });
  assert.equal(r.remaining, false, 'nothing is waiting');
  assert.equal(calls.embed, e0);
  assert.ok(one(k.deps.db, `SELECT 1 FROM search_chunk_state s JOIN pages p ON p.id = s.page_id WHERE p.title = 'Empty'`), 'a state row says it was read (0 chunks)');
});

test('Idle_ASessionNobodyIsInIsClosedAndNotWorkedOn', async () => {
  const { k } = await world();
  const db = k.deps.db;
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  run(db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?, ?, ?, ?)', 'old1', k.W, 'Left open', ago(180));
  run(db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'l1', 'old1', k.W, 0, 1000, 'Jess', 'hello', 'players', ago(120));
  run(db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?, ?, ?, ?)', 'live1', k.W, 'Tonight', ago(40));
  run(db, 'INSERT INTO audio_lines (id, session_id, world_id, start_ms, end_ms, speaker_label, text, audience, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'l2', 'live1', k.W, 0, 1000, 'Jess', 'hello', 'players', ago(2));
  const list = recordingSessions(k.deps);
  assert.deepEqual(list.map((s) => s.sessionId), ['live1'], 'the live one stays, the stale one is gone from the list');
  const closed = one<any>(db, 'SELECT stopped_at FROM audio_sessions WHERE id = ?', 'old1');
  assert.ok(closed.stopped_at, 'closed');
  assert.ok(Math.abs(Date.parse(closed.stopped_at) - (Date.now() - 120 * 60_000)) < 5000, 'at the time of its last line, not now');
  assert.ok(one(db, `SELECT 1 FROM audit WHERE action = 'audio.auto_close' AND detail LIKE '%old1%'`), 'the audit says so');
  assert.equal(closeStaleSessions(k.deps).length, 0, 'once');
  assert.equal(one<any>(db, 'SELECT stopped_at FROM audio_sessions WHERE id = ?', 'live1').stopped_at, null);
});

test('Idle_WithNoLiveSessionAndNothingNewTheBackgroundTicksMakeNoModelCalls', async () => {
  withTimes = true;
  const { k, sid, sd } = await world();
  await runSync(sd, sid, null);
  // Bring everything up to date first: pages embedded, story bible read.
  await drain(k);
  for (let i = 0; i < 20; i++) { const r = await syncBible(k.deps, { maxPages: 100 }); if (!r.remaining || r.skipped) break; }
  // A session left open from before: it must not keep the passes busy.
  run(k.deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at) VALUES (?, ?, ?, ?)', 'ghost', k.W, 'Ghost', new Date(Date.now() - 5 * 3600_000).toISOString());
  const base = { ...calls };
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const stops: (() => void)[] = [];
  try {
    for (const f of FEATURES) { const stop = f.start?.({ ...k.deps, env: { ...k.deps.env } } as any); if (typeof stop === 'function') stops.push(stop); }
    // Ten minutes of ticks, in steps, letting the async work of each step finish.
    for (let i = 0; i < 40; i++) {
      mock.timers.tick(15_000);
      for (let j = 0; j < 20; j++) await new Promise((r) => setImmediate(r));
    }
  } finally {
    for (const s of stops) { try { s(); } catch { /* stopping */ } }
    mock.timers.reset();
  }
  assert.equal(calls.embed - base.embed, 0, 'no embedding call');
  assert.equal(calls.chat - base.chat, 0, 'no chat, audit or other model call');
  assert.ok(one<any>(k.deps.db, 'SELECT stopped_at FROM audio_sessions WHERE id = ?', 'ghost').stopped_at, 'and the ghost session was closed on the way');
});
