// Minerva: the DM's agent and her campaign memory (docs/MINERVA.md). The vault,
// accretion and promotion, revelations and knowledge, the after-session review,
// arcs, Obsidian export and import, and the walls between the DM's memory and
// the players (who only ever meet the broker).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one } from '../src/core/db.ts';
import { readZip } from '../src/features/modules/zip.ts';
import { makeZip } from '../src/features/minerva/transfer.ts';
import { personaGiveaway } from '../src/features/minerva/player.ts';
import { BLOCKED_REPLY } from '../src/features/agent/leak.ts';

const DM_STATUS = 'STATUSMARK the harbour council will move against the lighthouse at the next new moon';
const DM_HIDDEN = 'HIDDENMARK the smuggler queen is the sister of the lighthouse keeper in disguise';
const JESS_JOURNAL = 'JESSJOURNAL I do not trust the ferryman because he knew my mother name';
const TOM_JOURNAL = 'TOMJOURNAL the old sword in my pack hums whenever the goblins are near';
const JESS_SHARED = 'JESSSHARED my character once served in the harbour guard of Saltmarsh';
const CODEX_SECRET = 'CODEXSECRET Odo Fennick is secretly paid by the smuggler queen every month';
const CLUE1 = 'a ledger page in the lighthouse cellar lists the darkened nights';
const CLUE2 = 'the keeper washed oil from his hands before dawn on every darkened night';
const CLUE3 = 'a smuggler boat was seen mooring near the lighthouse during the darkened nights';
const CONCLUSION = 'The keeper darkened the lamp for the smuggler queen CONCLUSIONMARK';

const prompts: { who: 'dm' | 'player' | 'other'; body: string }[] = [];
let scripted = 'The tide table says low water at dawn.';
const reply = (message: any) => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fakeFetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (!u.startsWith('http://fake.test/')) return fetch(url, init);
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  const sys = String(body?.messages?.[0]?.content ?? '');
  if (/^You are .*Dungeon Master/.test(sys)) { prompts.push({ who: 'dm', body: init.body }); return reply({ role: 'assistant', content: scripted }); }
  if (/information broker/.test(sys)) { prompts.push({ who: 'player', body: init.body }); return reply({ role: 'assistant', content: scripted }); }
  prompts.push({ who: 'other', body: init?.body ?? '' });
  if (/keep a campaign status document current/.test(sys)) return reply({ role: 'assistant', content: JSON.stringify({ changed: ['The lamp was darkened on purpose.'], next: ['Find who paid the keeper.'] }) });
  return reply({ role: 'assistant', content: JSON.stringify({ summary: 'The arc was about the dark lighthouse.' }) });
}) as typeof fetch;

let base = '';
let server: any;
let tmp = '';
let deps: any;
let W = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};

async function call(method: string, url: string, token?: string, body?: unknown, raw = false) {
  const r = await fetch(base + url, { method, headers: { ...(body === undefined || raw ? {} : { 'Content-Type': 'application/json' }), ...(raw ? { 'Content-Type': 'application/zip' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : raw ? (body as any) : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, body: json, text, buf };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.body;
};
const w = (p: string) => `/api/worlds/${W}${p}`;
const dm = (m: string, p: string, b?: unknown) => ok(m, w(p), T.dm, b);
const as = (who: string) => (m: string, p: string, b?: unknown) => ok(m, w(p), T[who], b);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean | Promise<boolean>, what: string) => { for (let i = 0; i < 300; i++) { if (await f()) return; await wait(20); } throw new Error(`timed out: ${what}`); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-minerva-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  T.ads = (await ok('POST', '/api/admin-auth/login', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.ads, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.ads, { name: 'Saltreach', dmAccountId: ID.dm })).id;
  for (const [name, character] of [['jess', 'Jessamine'], ['tom', 'Tomas']] as const) {
    const inv = await dm('POST', '/invites', { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: character });
    T[name] = j.token; ID[name] = j.account.id;
  }
  const inv = await dm('POST', '/invites', { role: 'guest' });
  T.guest = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'visitor', password: 'guest pass 1234', characterName: 'Visitor' })).token;
  await dm('PUT', '/library/pages', { path: 'people/Odo Fennick', visibility: 'party', markdown: '# Odo Fennick\nThe harbour clerk of Saltmarsh.\n' });
  await dm('PATCH', '/settings', { agentAutoApprove: [] });
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

const page = (rel: string) => dm('GET', `/minerva/page?rel=${encodeURIComponent(rel)}`);
const putPage = (rel: string, body: string, extra: Record<string, unknown> = {}) => dm('PUT', '/minerva/page', { rel, body, ...extra });

test('TestMinerva_EnableSeedsTheVault', async () => {
  assert.equal((await dm('GET', '/minerva')).enabled, false);
  assert.equal((await call('GET', w('/minerva/context'), T.dm)).status, 409, 'tools say to turn her on first');
  await dm('POST', '/minerva/enable', {});
  const s = await dm('GET', '/minerva');
  assert.equal(s.enabled, true);
  assert.equal(s.name, 'Minerva');
  assert.deepEqual(s.sections.map((x: any) => x.title), ['Now', 'Active threads', 'NPC agendas', 'What changed last session', 'Next session', 'Open questions']);
  const rels = (await dm('GET', '/minerva/pages')).pages.map((p: any) => p.rel);
  for (const need of ['HOME.md', 'dm/state/Campaign Status.md', 'chronicle/timeline.md', 'chronicle/calendar.md']) assert.ok(rels.includes(need), `has ${need}`);
  for (const who of ['jess', 'tom']) {
    for (const f of ['profile.md', 'shared.md', 'bonds.md', 'knowledge.md']) assert.ok(rels.includes(`players/${ID[who]}/${f}`), `${who} has ${f}`);
    assert.ok(rels.includes(`dm/players/${ID[who]}.md`));
  }
  assert.ok(rels.some((r: string) => r === 'codex/characters/pc/Jessamine.md'));
  // Front matter (§3): type, level, player.
  const prof = await page(`players/${ID.jess}/profile.md`);
  assert.equal(prof.fm.type, 'profile');
  assert.equal(prof.fm.level, 'party');
  assert.equal(prof.fm.player, ID.jess);
  assert.equal((await page('dm/state/Campaign Status.md')).level, 'dm');
  // The library stores every vault page DM-only (or broker/classified): none is a party page, so none shows to players.
  const vis = all<any>(deps.db, `SELECT DISTINCT visibility FROM pages WHERE world_id = ? AND path LIKE 'Minerva/%'`, W).map((r) => r.visibility);
  assert.deepEqual(vis, ['dm']);
  // Turning her on again changes nothing.
  await dm('POST', '/minerva/enable', {});
  assert.equal((await dm('GET', '/minerva/pages')).pages.length, rels.length);
});

test('TestMinerva_PlayersNeverSeeTheVaultOrHerName', async () => {
  await putPage('dm/state/Campaign Status.md', `# Campaign Status\n\n## Now\n${DM_STATUS}\n`);
  await putPage('dm/hidden-lore/Queen.md', `# Queen\n${DM_HIDDEN}.\n`);
  await putPage(`players/${ID.jess}/journal/session-1.md`, `# Session 1\n\n## Notes\n- ${JESS_JOURNAL}\n`);
  await putPage(`players/${ID.tom}/journal/session-1.md`, `# Session 1\n\n## Notes\n- ${TOM_JOURNAL}\n`);
  await putPage(`players/${ID.jess}/shared.md`, `# Shared with the party\n\n## Shared\n- ${JESS_SHARED}\n`);
  await dm('PATCH', '/settings', { agentName: 'Athena Prime' });
  for (const who of ['jess', 'tom', 'guest']) {
    const lib = await call('GET', w('/library/pages'), T[who]);
    assert.ok(!/minerva/i.test(lib.text), `${who}: no vault path in the library list`);
    const search = await call('GET', w('/library/search?q=harbour'), T[who]);
    assert.ok(!search.text.includes('STATUSMARK') && !search.text.includes('HIDDENMARK'));
    assert.ok(!/athena prime/i.test((await call('GET', w('/settings'), T[who])).text), `${who}: the assistant's name is not in settings`);
    assert.ok(!/athena prime/i.test((await call('GET', w(''), T[who])).text));
  }
  assert.ok(/athena prime/i.test((await call('GET', w('/settings'), T.dm)).text));
  assert.equal((await call('GET', w('/library/pages/Minerva%2Fdm%2Fstate%2FCampaign%20Status.md'), T.jess)).status, 404);
  // Every DM route refuses a player and a guest.
  for (const who of ['jess', 'tom', 'guest']) {
    for (const [m, p] of [['GET', '/minerva'], ['GET', '/minerva/pages'], ['GET', '/minerva/page?rel=HOME.md'], ['GET', '/minerva/export'], ['GET', '/minerva/review'], ['GET', '/minerva/who?name=Jessamine'], ['GET', '/minerva/context'], ['POST', '/minerva/enable'], ['POST', '/minerva/codex'], ['POST', '/minerva/import']] as const) {
      const r = await call(m, w(p), T[who], m === 'GET' ? undefined : {});
      assert.ok([401, 403, 404].includes(r.status), `${who} ${m} ${p} -> ${r.status}`);
    }
  }
  assert.equal((await call('GET', w('/minerva/me'), T.guest)).status, 404);
  // A player reads their own root and the party's shared lines, never another player's.
  const jess = await as('jess')('GET', '/minerva/me');
  assert.ok(JSON.stringify(jess).includes('JESSJOURNAL'));
  assert.ok(!JSON.stringify(jess).includes('TOMJOURNAL'));
  for (const bad of ['STATUSMARK', 'HIDDENMARK']) assert.ok(!JSON.stringify(jess).includes(bad), bad);
  const tom = await as('tom')('GET', '/minerva/me');
  assert.ok(!JSON.stringify(tom).includes('JESSJOURNAL'), 'another player\'s journal');
  assert.ok(JSON.stringify(tom).includes('JESSSHARED'), 'the "Shared with the party" lines are visible to the others');
  assert.ok(!/minerva|athena/i.test(JSON.stringify(tom)), 'no name in a player response');
});

test('TestMinerva_SecretBlocksInCodexPagesNeverReachPlayers', async () => {
  await dm('POST', '/minerva/codex', { name: 'Odo Fennick', section: 'secret', text: CODEX_SECRET });
  const odo = await dm('POST', '/minerva/codex', { name: 'Odo Fennick', section: 'appearances', text: 'Gave the party directions to the lighthouse.', session: 9 });
  assert.equal(odo.created, false);
  // The DM opens the codex page to the party; its secret block is still the DM's.
  await dm('PUT', '/minerva/page', { rel: odo.rel, level: 'party' });
  const body = (await page(odo.rel)).body;
  assert.ok(body.includes('> [!secret]') && body.includes('CODEXSECRET'));
  for (const who of ['jess', 'tom']) {
    const v = JSON.stringify(await as(who)('GET', '/minerva/me'));
    assert.ok(v.includes('Gave the party directions'), `${who} reads the party-level part`);
    assert.ok(!v.includes('CODEXSECRET'), `${who} never reads the secret block`);
  }
});

test('TestMinerva_CodexAccretesNeverDuplicates', async () => {
  const lib = one<any>(deps.db, `SELECT id FROM pages WHERE world_id = ? AND path = 'people/Odo Fennick.md'`, W);
  const before = (await dm('GET', '/minerva/pages?prefix=codex/')).pages.length;
  // By name, by library id, by a different case: one page, never two.
  const a = await dm('POST', '/minerva/codex', { name: 'Captain Brask', kind: 'npc', section: 'appearances', text: 'Seen on the quay.', session: 1 });
  assert.equal(a.created, true);
  const b = await dm('POST', '/minerva/codex', { name: 'captain brask', section: 'appearances', text: 'Seen again at the council.', session: 2 });
  assert.equal(b.created, false);
  assert.equal(b.rel, a.rel);
  await dm('PUT', '/minerva/page', { rel: a.rel, body: '# Captain Brask\n\n## Appearances\n- x\n' });
  const c = await dm('POST', '/minerva/codex', { entity: lib.id, section: 'changed', text: 'Now trusts the party.' });
  assert.equal(c.created, false, 'found by the library page id and its name');
  const d1 = await dm('POST', '/minerva/codex', { name: 'Odo Fennick', section: 'ties', text: 'Knows Jessamine.' });
  assert.equal(d1.rel, c.rel);
  const pgs = (await dm('GET', '/minerva/pages?prefix=codex/')).pages;
  assert.equal(pgs.length, before + 1, 'only Captain Brask was added');
  const brask = await page(a.rel);
  assert.equal((brask.body.match(/## Appearances/g) ?? []).length, 1);
  // who_is: name, alias, character and player.
  await dm('PUT', '/minerva/page', { rel: a.rel, body: brask.body });
  const who = (n: string) => dm('GET', `/minerva/who?name=${encodeURIComponent(n)}`).then((r) => r.matches);
  assert.ok((await who('Odo Fennick')).some((m: any) => m.type === 'codex'));
  const jessM = (await who('Jessamine')).find((m: any) => m.type === 'player');
  assert.equal(jessM.accountId, ID.jess);
  assert.equal((await who('jess')).find((m: any) => m.type === 'player')?.accountId, ID.jess, 'by the player name');
  assert.equal((await who('Nobody At All')).length, 0);
  // Appearing again later adds a dated line to the same page.
  const e = await dm('POST', '/minerva/codex', { name: 'Odo Fennick', section: 'appearances', text: 'Back at the harbour office.', session: 4 });
  assert.equal(e.created, false);
  assert.match((await page(e.rel)).body, /Back at the harbour office\. \(\[\[session-4\]\]\)/);
});

test('TestMinerva_PromotionNeedsThreeSessionsAnActiveThreadOrABond', async () => {
  const session = (n: number, people: string) => putPage(`chronicle/arcs/01-test/sessions/session-${n}.md`, `# Session ${n}\n\n## Recap\n- A quiet day.\n\n## People met\n${people}\n`, { level: 'party' });
  await session(1, '- Mara Quill: a ferrywoman');
  await session(2, '- Mara Quill: a ferrywoman\n- Dorn the Younger: a stable boy');
  let c = (await dm('GET', '/minerva/promotions')).candidates;
  assert.ok(!c.some((x: any) => x.name === 'Mara Quill'), 'two sessions are not enough');
  await session(3, '- Mara Quill: a ferrywoman');
  c = (await dm('GET', '/minerva/promotions')).candidates;
  const mara = c.find((x: any) => x.name === 'Mara Quill');
  assert.ok(mara && mara.sessions === 3 && /3 sessions/.test(mara.reasons.join()), JSON.stringify(c));
  assert.ok(!c.some((x: any) => x.name === 'Dorn the Younger'));
  // An active thread, or a player's bond, promotes at once.
  await putPage('dm/state/Campaign Status.md', '# Campaign Status\n\n## Active threads\n- [on] Find Dorn the Younger before the new moon\n');
  assert.ok((await dm('GET', '/minerva/promotions')).candidates.some((x: any) => x.name === 'Dorn the Younger' && /active thread/.test(x.reasons.join())));
  // Promoting makes the page from the mentions and removes the suggestion.
  const made = await dm('POST', '/minerva/promote', { name: 'Mara Quill' });
  assert.match(made.rel, /^codex\/characters\/npc\/Mara Quill\.md$/);
  assert.match((await page(made.rel)).body, /\[\[session-3\]\]/);
  assert.ok(!(await dm('GET', '/minerva/promotions')).candidates.some((x: any) => x.name === 'Mara Quill'));
  assert.equal((await call('POST', w('/minerva/promote'), T.dm, { name: 'Mara Quill' })).status, 409, 'no second page');
});

test('TestMinerva_RevelationMarksBecomeKnowledge', async () => {
  const bad = await call('POST', w('/minerva/revelations'), T.dm, { title: 'Who darkened the lighthouse?', conclusion: CONCLUSION, clues: [CLUE1, CLUE2] });
  assert.equal(bad.status, 400, 'a mystery needs three clues');
  const m = await dm('POST', '/minerva/revelations', { title: 'Who darkened the lighthouse?', conclusion: CONCLUSION, clues: [CLUE1, CLUE2, CLUE3] });
  assert.equal(m.clues.length, 3);
  const pg = await page('dm/revelations/who-darkened-the-lighthouse.md');
  assert.match(pg.body, /\| 1 \| a ledger page/);
  assert.equal(pg.fm.type, 'revelation');
  assert.equal(pg.level, 'dm');
  await dm('POST', '/minerva/revelations/mark', { mystery: 'Who darkened the lighthouse?', clue: 1, player: 'Jessamine', session: 2 });
  await dm('POST', '/minerva/revelations/mark', { mystery: 'who-darkened-the-lighthouse', clue: 'washed oil from his hands', player: ID.jess, session: 2 });
  await dm('POST', '/minerva/revelations/mark', { mystery: 'Who darkened the lighthouse?', clue: 3, player: 'Tomas', session: 3 });
  // The table and the minerva_ rows say who found what.
  const rows = all<any>(deps.db, 'SELECT clue_n, account_id FROM minerva_found WHERE world_id = ? ORDER BY clue_n', W);
  assert.deepEqual(rows.map((r) => [r.clue_n, r.account_id]), [[1, ID.jess], [2, ID.jess], [3, ID.tom]]);
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM minerva_clues WHERE world_id = ?', W).n, 3);
  assert.match((await page('dm/revelations/who-darkened-the-lighthouse.md')).body, /\| 1 \| .* \| Jessamine \|/);
  // Each player's knowledge has only their own clues; the conclusion is theirs only once the DM says they reached it.
  const jk = (await page(`players/${ID.jess}/knowledge.md`)).body;
  assert.ok(jk.includes(CLUE1) && jk.includes(CLUE2) && !jk.includes(CLUE3));
  assert.ok(!jk.includes('CONCLUSIONMARK'));
  const tk = (await page(`players/${ID.tom}/knowledge.md`)).body;
  assert.ok(tk.includes(CLUE3) && !tk.includes(CLUE1));
  await dm('POST', '/minerva/revelations/mark', { mystery: 'Who darkened the lighthouse?', player: 'Jessamine', kind: 'reached' });
  await dm('POST', '/minerva/revelations/mark', { mystery: 'Who darkened the lighthouse?', player: 'Jessamine', kind: 'theory', text: 'The ferryman is in on it' });
  assert.ok((await page(`players/${ID.jess}/knowledge.md`)).body.includes('CONCLUSIONMARK'));
  assert.ok(!(await page(`players/${ID.tom}/knowledge.md`)).body.includes('CONCLUSIONMARK'));
  // What a player reads is exactly their own marks.
  const jv = JSON.stringify(await as('jess')('GET', '/minerva/me'));
  assert.ok(jv.includes(CLUE1) && jv.includes('CONCLUSIONMARK') && jv.includes('The ferryman is in on it'));
  assert.ok(!JSON.stringify(await as('tom')('GET', '/minerva/me')).includes('CONCLUSIONMARK'));
  // The mystery page itself (who found what) is the DM's.
  assert.ok(!jv.includes('Who found') && !jv.includes('not found yet'));
});

test('TestMinerva_PlayerWritesAreDraftsOnTheDmsList', async () => {
  const jess = as('jess');
  const r = await jess('POST', '/minerva/me/journal', { text: 'Asked the ferryman about the dark nights', about: 'the ferryman' });
  assert.equal(r.queued, true);
  await jess('POST', '/minerva/me/goals', { goal: 'Find my brother', heat: 'on', text: 'He was last seen at the docks' });
  await jess('POST', '/minerva/me/share', { text: 'I can read old harbour script' });
  const rv = await dm('GET', '/minerva/review');
  assert.equal(rv.drafts.length, 3);
  assert.ok(rv.drafts.every((x: any) => x.byAccount === ID.jess));
  // Not applied yet: the player sees nothing new, the page is not there.
  assert.ok(!JSON.stringify(await jess('GET', '/minerva/me')).includes('Find my brother'));
  // The DM edits one and approves, rejects another.
  const j = rv.drafts.find((x: any) => x.kind === 'journal');
  await dm('POST', `/minerva/review/${j.id}`, { decision: 'approve', text: '- Asked the ferryman about the dark nights (the DM tidied this)' });
  const g = rv.drafts.find((x: any) => x.kind === 'goal');
  await dm('POST', `/minerva/review/${g.id}`, { decision: 'approve' });
  const sh = rv.drafts.find((x: any) => x.kind === 'share');
  await dm('POST', `/minerva/review/${sh.id}`, { decision: 'reject' });
  assert.equal((await call('POST', w(`/minerva/review/${j.id}`), T.dm, { decision: 'approve' })).status, 409, 'decided once');
  const v = await jess('GET', '/minerva/me');
  assert.ok(JSON.stringify(v.journal).includes('the DM tidied this'));
  assert.equal(v.goals.find((x: any) => x.title === 'Find my brother')?.heat, 'on');
  assert.ok(!JSON.stringify(await as('tom')('GET', '/minerva/me')).includes('I can read old harbour script'), 'a rejected share never shows');
  // Another player never sees it, and nothing a player sends can reach another root.
  assert.ok(!JSON.stringify(await as('tom')('GET', '/minerva/me')).includes('Find my brother'));
  const odd = await as('tom')('POST', '/minerva/me/journal', { text: 'x', rel: `players/${ID.jess}/journal/session-9.md`, accountId: ID.jess });
  assert.equal(odd.queued, true);
  const tomDraft = (await dm('GET', '/minerva/review')).drafts.find((x: any) => x.byAccount === ID.tom);
  assert.ok(tomDraft.op.rel.startsWith(`players/${ID.tom}/`), tomDraft.op.rel);
  await dm('POST', `/minerva/review/${tomDraft.id}`, { decision: 'reject' });
  // With auto-approve on for that tool, the write is applied at once.
  await dm('PATCH', '/settings', { agentAutoApprove: ['my_memory_log'] });
  const auto = await jess('POST', '/minerva/me/journal', { text: 'Auto approved note about the quay' });
  assert.equal(auto.queued, false);
  assert.ok(JSON.stringify((await jess('GET', '/minerva/me')).journal).includes('Auto approved note'));
  await dm('PATCH', '/settings', { agentAutoApprove: [] });
});

test('TestMinerva_AfterSessionDraftsAreOneReview', async () => {
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const draft = await dm('POST', '/sessionlog/drafts', { from, to: new Date().toISOString(), title: 'Into the harbour' });
  await dm('PUT', `/sessionlog/drafts/${draft.id}`, { markdown: '## Recap\n- The party reached the harbour office and spoke to Odo Fennick about the dark lamp.\n- Jessamine searched the cellar.\n\n## Key moments\n- The keeper confessed that the lamp was darkened on purpose.\n\n## People met\n- Odo Fennick: the harbour clerk\n- Sister Ilse: a healer from the hill chapel\n\n## Open threads\n- Who paid the keeper to darken the lamp?\n' });
  await dm('POST', `/sessionlog/drafts/${draft.id}/publish`, {});
  await until(() => !!one(deps.db, 'SELECT 1 FROM minerva_sessions WHERE world_id = ?', W), 'the session was filed');
  const filed = one<any>(deps.db, 'SELECT * FROM minerva_sessions WHERE world_id = ?', W);
  assert.match(filed.rel, /^chronicle\/arcs\/01-.*\/sessions\/session-1\.md$/);
  await until(() => (one<any>(deps.db, `SELECT COUNT(*) AS n FROM minerva_drafts WHERE world_id = ? AND review = 'session-1'`, W)?.n ?? 0) > 0, 'drafts made');
  const arcs = (await dm('GET', '/minerva/arcs')).arcs;
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].status, 'open');
  const pg = await page(filed.rel);
  assert.equal(pg.fm.type, 'session');
  assert.ok(pg.body.includes('The party reached the harbour office'));
  const rv = await dm('GET', '/minerva/review');
  const kinds = new Set(rv.drafts.filter((x: any) => x.review === 'session-1').map((x: any) => x.kind));
  for (const k of ['status', 'journal', 'codex']) assert.ok(kinds.has(k), `drafts of kind ${k}: ${[...kinds]}`);
  // The model's status text is a draft with a before and after, not yet in the doc.
  const st = rv.drafts.find((x: any) => x.kind === 'status' && /what changed/i.test(x.title));
  assert.match(st.preview.after, /The lamp was darkened on purpose/);
  assert.ok(!(await page('dm/state/Campaign Status.md')).body.includes('The lamp was darkened on purpose'));
  // Filing the same entry again changes nothing.
  const again = await dm('POST', `/minerva/sessions/${filed.entry_id}/file`);
  assert.equal(again.already, true);
  assert.equal((await dm('GET', '/minerva/review')).drafts.length, rv.drafts.length);
  // Approve everything: the status doc, the codex page and every player's journal follow.
  const done = await dm('POST', '/minerva/review/approve-all', { review: 'session-1' });
  assert.equal(done.failed, 0);
  assert.match((await page('dm/state/Campaign Status.md')).body, /What changed last session\n- The lamp was darkened on purpose/);
  assert.match((await page('codex/characters/npc/Odo Fennick.md')).body, /session-1/);
  const jv = await as('jess')('GET', '/minerva/me');
  assert.ok(JSON.stringify(jv.journal).includes('harbour office'), 'a journal entry for the session');
  assert.equal((await dm('GET', '/minerva/review')).drafts.filter((x: any) => x.review === 'session-1').length, 0);
  assert.ok(!/minerva|athena/i.test(JSON.stringify(jv)));
});

test('TestMinerva_ArcsStartAndCloseWithASummaryDraft', async () => {
  assert.equal((await call('POST', w('/minerva/arcs'), T.dm, { title: 'Second' })).status, 409, 'one arc is open');
  const closed = await dm('POST', '/minerva/arcs/open/close');
  assert.equal(closed.arc.status, 'closed');
  const dr = (await dm('GET', '/minerva/review')).drafts.find((x: any) => x.id === closed.draft);
  assert.match(dr.op.rel, /^chronicle\/arcs\/01-.*\/summary\.md$/);
  assert.match(dr.op.body, /dark lighthouse|What mattered/);
  await dm('POST', `/minerva/review/${dr.id}`, { decision: 'approve' });
  assert.ok(await page(dr.op.rel));
  const next = await dm('POST', '/minerva/arcs', { title: 'The Drowned Bell' });
  assert.equal(next.n, 2);
  assert.match(next.slug, /^02-the-drowned-bell$/);
  assert.equal((await dm('GET', '/minerva/arcs')).open.slug, next.slug);
});

test('TestMinerva_ToolsKeepToTheirSides', async () => {
  const { toolsFor } = await import('../src/routes/mcpServer.ts');
  const dmTools = toolsFor(true).map((t) => t.name);
  const playerTools = toolsFor(false).filter((t) => !t.dmOnly && !t.write).map((t) => t.name);
  for (const n of ['context_for', 'who_is', 'memory_log', 'memory_capture', 'conversation_log', 'status_update', 'revelation_mark', 'codex_upsert', 'promote', 'arc_close', 'goal_update']) assert.ok(dmTools.includes(n), n);
  for (const n of ['context_for', 'who_is', 'memory_log', 'status_update', 'revelation_mark', 'codex_upsert', 'promote', 'arc_close', 'goal_update', 'conversation_log']) assert.ok(!playerTools.includes(n), `a player is not offered ${n}`);
  for (const n of ['my_context', 'my_who_is', 'my_memory_log', 'my_memory_capture', 'my_goal_update']) { assert.ok(playerTools.includes(n), n); assert.ok(!dmTools.includes(n), `the DM harness does not list the player form ${n}`); }
  const all_ = toolsFor(true).concat(toolsFor(false));
  for (const t of all_.filter((x) => x.playerOnly)) assert.ok(!/minerva|assistant|DM's agent/i.test(`${t.name} ${t.description}`), `${t.name} does not name her`);
  // The DM's write tools are proposals for the DM; the player forms can never write.
  for (const t of all_.filter((x) => x.playerOnly)) assert.ok(!t.write);
});

test('TestMinerva_BrokerSpeaksAsTheBrokerAndKnowsOnlyThePlayer', async () => {
  await dm('PUT', '/broker', { persona: { name: 'Old Marrow', title: 'Fence of Saltmarsh', description: 'x', greeting: 'Hm.', voice: 'leans in', portrait: '' }, tiers: (await dm('GET', '/broker')).tiers, lengths: (await dm('GET', '/broker')).lengths, unknown: 'dm' }).catch(() => {});
  const ask = async (who: string, text: string) => {
    const chat = await as(who)('POST', '/agent/chats', {});
    await as(who)('POST', `/agent/chats/${chat.id}/messages`, { text });
    let c: any;
    for (let i = 0; i < 300; i++) { c = await as(who)('GET', `/agent/chats/${chat.id}`); if (!c.busy) break; await wait(15); }
    return c.messages.filter((m: any) => m.role === 'assistant').at(-1);
  };
  prompts.length = 0;
  scripted = 'The tide table says low water at dawn.';
  const r1 = await ask('jess', 'What do I know about the lighthouse lamp?');
  assert.equal(r1.status, 'done');
  const pj = prompts.filter((p) => p.who === 'player').map((p) => p.body).join('\n');
  assert.ok(pj.includes(CLUE1), 'the broker is given what this player found');
  for (const bad of [DM_STATUS, DM_HIDDEN, 'STATUSMARK', 'HIDDENMARK', 'TOMJOURNAL', CLUE3, 'CODEXSECRET', 'Athena Prime']) assert.ok(!pj.includes(bad), `a player prompt must not carry ${bad.slice(0, 20)}`);
  assert.ok(!/minerva/i.test(pj), 'no mention of her in a player prompt');
  assert.match(pj, /information broker/);
  // The persona name is the world's broker, never her.
  assert.ok(prompts.some((p) => p.who === 'player' && /You are (Old Marrow|The Broker)/.test(JSON.parse(p.body).messages[0].content)));
  // And Tom is not given Jess's findings.
  prompts.length = 0;
  await ask('tom', 'What do I know about the lighthouse lamp?');
  const tj = prompts.filter((p) => p.who === 'player').map((p) => p.body).join('\n');
  assert.ok(tj.includes(CLUE3) && !tj.includes(CLUE1) && !tj.includes('JESSJOURNAL'));
  // The DM harness is told her name (Athena Prime was set) and sees the status.
  prompts.length = 0;
  await ask('dm', 'Where are we in the campaign?');
  const dj = prompts.filter((p) => p.who === 'dm').map((p) => p.body).join('\n');
  assert.match(dj, /You are Athena Prime, the assistant of the Dungeon Master/);
  assert.ok(dj.includes('Find Dorn the Younger'), 'the status doc is in front of her');
  // A reply that gives her away is blocked and rewritten, whichever way it is said.
  for (const bad of ['I am Minerva, and I keep notes for the table.', 'I work for the DM, you see.', "I am the DM's assistant, friend.", 'Athena Prime says the tide is low.']) {
    scripted = bad;
    const r = await ask('jess', 'Who are you really?');
    assert.equal(r.text, BLOCKED_REPLY, bad);
    assert.ok(!/minerva|athena/i.test(r.text));
  }
  scripted = 'Nothing but the tide.';
  assert.notEqual((await ask('jess', 'Who are you?')).text, BLOCKED_REPLY);
  // DM-only vault text in a reply is blocked the same way, while the player's own text is allowed.
  scripted = 'Truly the smuggler queen is the sister of the lighthouse keeper in disguise, they say.';
  assert.equal((await ask('jess', 'Tell me a rumour')).text, BLOCKED_REPLY);
  scripted = "Truly I do not trust the ferryman because he knew my mother name, as you wrote.";
  assert.notEqual((await ask('jess', 'What did I write about the ferryman?')).text, BLOCKED_REPLY, 'a player may hear their own journal');
  scripted = "Truly I do not trust the ferryman because he knew my mother name, said Jessamine.";
  assert.equal((await ask('tom', 'What did Jessamine write?')).text, BLOCKED_REPLY, 'but not another player\'s');
  // The check itself.
  assert.ok(personaGiveaway('The Minerva memory vault') && personaGiveaway('assistant to the Dungeon Master') && !personaGiveaway('The market was busy.'));
});

test('TestMinerva_ExportAndImportRoundTrip', async () => {
  const r = await call('GET', w('/minerva/export'), T.dm);
  assert.equal(r.status, 200);
  const files = readZip(r.buf);
  const names = files.map((f) => f.name);
  for (const need of ['HOME.md', 'dm/state/Campaign Status.md', `players/${ID.jess}/knowledge.md`, 'dm/revelations/who-darkened-the-lighthouse.md']) assert.ok(names.includes(need), `zip has ${need}`);
  assert.ok(!names.some((n) => n.startsWith('Minerva/')), 'paths are relative to the vault');
  const status = files.find((f) => f.name === 'dm/state/Campaign Status.md')!.read().toString('utf8');
  assert.match(status, /^---\ntype: status\nlevel: dm/);
  assert.ok(status.includes('Find Dorn the Younger'));
  // Lose a page and a clue, then bring them back from the zip.
  await call('DELETE', w('/minerva/page?rel=' + encodeURIComponent('dm/hidden-lore/Queen.md')), T.dm);
  assert.equal((await call('GET', w('/minerva/page?rel=dm%2Fhidden-lore%2FQueen.md'), T.dm)).status, 404);
  const imp = await call('POST', w('/minerva/import'), T.dm, r.buf, true);
  assert.equal(imp.status, 200, imp.text);
  assert.equal(imp.body.created, 1);
  assert.ok(imp.body.updated >= names.length - 1);
  assert.deepEqual(imp.body.skipped, []);
  assert.ok((await page('dm/hidden-lore/Queen.md')).body.includes('HIDDENMARK'));
  assert.equal((await page(`players/${ID.jess}/profile.md`)).fm.level, 'party');
  assert.equal(one<any>(deps.db, 'SELECT COUNT(*) AS n FROM minerva_found WHERE world_id = ? AND kind = ?', W, 'clue').n, 3, 'clue marks survive an import of the same vault');
});

test('TestMinerva_ImportChecksPathsAndLevels', async () => {
  const md = (fm: string, body = 'Text.\n') => Buffer.from(`${fm ? `---\n${fm}\n---\n` : ''}# Page\n${body}`);
  const zip = makeZip([
    { name: '../evil.md', data: md('level: party') },
    { name: 'dm/../../escape.md', data: md('') },
    { name: '/abs/path.md', data: md('') },
    { name: 'notes/elsewhere.md', data: md('') },
    { name: 'players/not-a-player/profile.md', data: md('level: party') },
    { name: `players/${ID.tom}/notes/imported.md`, data: md('type: note\nlevel: party', 'Imported for Tom.\n') },
    { name: 'dm/hidden-lore/Open Attempt.md', data: md('type: lore\nlevel: party', 'Trying to open the DM folder.\n') },
    { name: 'codex/lore/No Level.md', data: md('type: codex\nkind: topic', 'No level given.\n') },
    { name: 'codex/lore/Weird Level.md', data: md('type: codex\nlevel: everyone', 'Unknown level.\n') },
    { name: 'codex/lore/Classified.md', data: md('type: codex\nlevel: classified', 'CLASSIFIEDIMPORT the vault under the old lighthouse opens only for bearers of three silver keys\n') },
    { name: 'Minerva/codex/lore/Prefixed.md', data: md('type: codex\nlevel: broker', 'Came in a zip of the folder.\n') },
    { name: 'readme.txt', data: Buffer.from('not markdown') },
  ]);
  const r = await call('POST', w('/minerva/import'), T.dm, zip, true);
  assert.equal(r.status, 200, r.text);
  const skipped = r.body.skipped.map((s: any) => s.path);
  for (const bad of ['../evil.md', 'dm/../../escape.md', 'notes/elsewhere.md', 'players/not-a-player/profile.md']) assert.ok(skipped.some((s: string) => s.includes(bad.replace(/^\//, ''))), `${bad} was skipped: ${skipped}`);
  assert.equal(r.body.created, 6);
  assert.equal((await page('dm/hidden-lore/Open Attempt.md')).level, 'dm', 'dm/ is never opened to players');
  assert.equal((await page('codex/lore/No Level.md')).level, 'dm', 'no level means dm');
  assert.equal((await page('codex/lore/Weird Level.md')).level, 'dm', 'an unknown level means dm');
  assert.equal((await page('codex/lore/Classified.md')).level, 'classified');
  assert.equal((await page('codex/lore/Prefixed.md')).level, 'broker');
  assert.equal(one<any>(deps.db, `SELECT visibility FROM pages WHERE world_id = ? AND path = 'Minerva/codex/lore/Classified.md'`, W).visibility, 'classified');
  assert.equal(one<any>(deps.db, `SELECT visibility FROM pages WHERE world_id = ? AND path = 'Minerva/codex/lore/Prefixed.md'`, W).visibility, 'broker');
  // Nothing outside the vault appeared in the library.
  assert.ok(!one(deps.db, `SELECT 1 FROM pages WHERE world_id = ? AND (path LIKE '%evil%' OR path LIKE '%escape%')`, W));
  // The imported party page is Tom's alone; nothing from the DM folder reached a player.
  const tv = JSON.stringify(await as('tom')('GET', '/minerva/me'));
  assert.ok(tv.includes('Imported for Tom'));
  assert.ok(!tv.includes('Trying to open the DM folder') && !tv.includes('CLASSIFIEDIMPORT'));
  assert.ok(!JSON.stringify(await as('jess')('GET', '/minerva/me')).includes('Imported for Tom'));
  // A broken body is refused.
  assert.equal((await call('POST', w('/minerva/import'), T.dm, Buffer.from('not a zip'), true)).status, 400);
});

test('TestMinerva_WorksWithoutAModel', async () => {
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data2'), vaultsDir: path.join(tmp, 'vaults2'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  const srv = made.app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const j = async (m: string, u: string, t?: string, body?: unknown) => { const r = await fetch(b + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const x = await r.json().catch(() => ({})); assert.ok(r.status < 300, `${m} ${u} ${r.status} ${JSON.stringify(x)}`); return x as any; };
    const admin = (await j('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
    const ads = (await j('POST', '/api/admin-auth/login', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
    const dmId = (await j('POST', '/api/admin/accounts', ads, { username: 'gm', password: 'dm password 123' })).account.id;
    const tok = (await j('POST', '/api/auth/login', undefined, { username: 'gm', password: 'dm password 123' })).token;
    const wid = (await j('POST', '/api/admin/worlds', ads, { name: 'Quietland', dmAccountId: dmId })).id;
    void admin;
    const st = await j('POST', `/api/worlds/${wid}/minerva/enable`, tok, {});
    assert.equal(st.enabled, true);
    const s = await j('GET', `/api/worlds/${wid}/minerva`, tok);
    assert.equal(s.model, false);
    await j('POST', `/api/worlds/${wid}/minerva/arcs`, tok, { title: 'First' });
    const c = await j('POST', `/api/worlds/${wid}/minerva/codex`, tok, { name: 'Ayla', kind: 'npc', section: 'notes', text: 'A scout.' });
    assert.equal(c.created, true);
    assert.equal(all(made.deps.db, 'SELECT 1 FROM minerva_drafts').length, 0);
  } finally { srv.close(); srv.closeAllConnections?.(); }
});
