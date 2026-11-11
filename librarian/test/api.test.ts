// End-to-end tests over HTTP. Most of them check the leak guard: that
// nothing DM-only reaches a player through any route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-'));
  const vaults = path.join(tmp, 'vaults');
  fs.mkdirSync(path.join(vaults, 'bloodearth', 'people'), { recursive: true });
  fs.writeFileSync(path.join(vaults, 'bloodearth', 'people', 'Ysolde.md'), `---
title: Lady Ysolde Varn
visibility: party
children: ["[[Aldric Varn]]"]
secret:
  lovers: ["[[Brother Tamsin]]"]
  note: Her son is not her husband's.
---
Head of House Varn.

> [!secret] DM
> She poisoned the old lord.

Public part again.
`);
  fs.writeFileSync(path.join(vaults, 'bloodearth', 'people', 'Tamsin.md'), `---
title: Brother Tamsin
---
DM-only page by default.
`);
  const { app } = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: vaults, env: {} });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TestSetup_FirstAccountIsAdminAndSetupCloses', async () => {
  assert.equal((await ok('GET', '/api/setup')).needsSetup, true);
  const r = await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' });
  T.admin = r.token;
  ID.admin = r.account.id;
  assert.equal(r.account.is_admin, 1);
  assert.equal((await call('POST', '/api/setup', undefined, { username: 'x2', password: 'correct horse battery' })).status, 409);
  assert.equal((await call('POST', '/api/auth/login', undefined, { username: 'wizard', password: 'wrong password!' })).status, 401);
  assert.ok((await ok('POST', '/api/auth/login', undefined, { username: 'wizard', password: 'correct horse battery' })).token);
});

test('TestAdmin_CreatesWorldDmAndInviteJoin', async () => {
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const w = await ok('POST', '/api/admin/worlds', T.admin, { name: 'BloodEarth', dmAccountId: ID.dm });
  W = w.id;
  // Admin flag alone does not open the world.
  assert.equal((await call('GET', `/api/worlds/${W}/library/pages`, T.admin)).status, 404);

  for (const [name, char] of [['jess', 'Mira'], ['tom', 'Brannoc']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: char });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  await ok('POST', '/api/join', undefined, { code: inv.code, username: 'reuse1', password: 'player pass 123' });
  assert.equal((await call('POST', '/api/join', undefined, { code: inv.code, username: 'reuse2', password: 'player pass 123' })).status, 400, 'invite codes work once');
  assert.equal((await call('POST', `/api/worlds/${W}/invites`, T.jess, { role: 'player' })).status, 403);
});

test('TestReset_AdminCodeResetsPassword', async () => {
  const acc = await ok('POST', '/api/admin/accounts', T.admin, { username: 'forgetful' });
  assert.ok(acc.resetCode);
  assert.equal((await call('POST', '/api/auth/reset', undefined, { username: 'forgetful', code: 'NOPE-NOPE', password: 'new password 123' })).status, 400);
  await ok('POST', '/api/auth/reset', undefined, { username: 'forgetful', code: acc.resetCode, password: 'new password 123' });
  assert.equal((await call('POST', '/api/auth/reset', undefined, { username: 'forgetful', code: acc.resetCode, password: 'other password 1' })).status, 400, 'codes work once');
});

test('TestLibrary_VaultImportAndPlayerCopy', async () => {
  const src = await ok('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'vault', name: 'Lokus vault', config: { folder: 'bloodearth' } });
  assert.equal((await call('POST', `/api/admin/worlds/${W}/sources`, T.admin, { kind: 'vault', name: 'escape', config: { folder: '../../etc' } })).status, 400);
  assert.equal((await ok('POST', `/api/admin/sources/${src.id}/sync?wait=1`, T.admin)).pages, 2);

  const dmPages = await ok('GET', `/api/worlds/${W}/library/pages`, T.dm);
  assert.equal(dmPages.length, 2);
  const pPages = await ok('GET', `/api/worlds/${W}/library/pages`, T.jess);
  assert.deepEqual(pPages.map((p: any) => p.title), ['Lady Ysolde Varn']);
  const tamsin = dmPages.find((p: any) => p.title === 'Brother Tamsin');
  assert.equal((await call('GET', `/api/worlds/${W}/library/pages/${tamsin.id}`, T.jess)).status, 404);

  const pg = await ok('GET', `/api/worlds/${W}/library/pages/${pPages[0].id}`, T.jess);
  const all = JSON.stringify(pg);
  assert.ok(all.includes('Head of House Varn') && all.includes('Public part again'));
  for (const leak of ['poisoned', 'not her husband', 'Tamsin', 'secret']) assert.ok(!all.includes(leak), `player page leaked "${leak}"`);

  // DM copy keeps everything.
  const dmCopy = JSON.stringify(await ok('GET', `/api/worlds/${W}/library/pages/${pPages[0].id}`, T.dm));
  assert.ok(dmCopy.includes('poisoned') && dmCopy.includes('not her husband'));

  // The mirror on disk has a party folder without the secrets.
  const partyFile = fs.readFileSync(path.join(tmp, 'data', 'worlds', 'bloodearth', 'party', 'people', 'Ysolde.md'), 'utf8');
  assert.ok(!partyFile.includes('poisoned') && !partyFile.includes('Tamsin'));
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'worlds', 'bloodearth', 'party', 'people', 'Tamsin.md')));
});

test('TestLibrary_SearchUsesPartyIndexForPlayers', async () => {
  const dm = await ok('GET', `/api/worlds/${W}/library/search?q=poisoned`, T.dm);
  assert.equal(dm.length, 1);
  assert.equal((await ok('GET', `/api/worlds/${W}/library/search?q=poisoned`, T.jess)).length, 0);
  assert.equal((await ok('GET', `/api/worlds/${W}/library/search?q=Tamsin`, T.jess)).length, 0);
  assert.equal((await ok('GET', `/api/worlds/${W}/library/search?q=Varn`, T.jess)).length, 1);
});

test('TestLibrary_RelationsHideSecretsAndDmPages', async () => {
  const dm = await ok('GET', `/api/worlds/${W}/library/relations`, T.dm);
  assert.ok(dm.some((r: any) => r.to_title === 'Brother Tamsin' && r.visibility === 'dm'));
  const pl = await ok('GET', `/api/worlds/${W}/library/relations`, T.jess);
  assert.deepEqual(pl.map((r: any) => [r.from_title, r.kind, r.to_title]), [['Lady Ysolde Varn', 'parent of', 'Aldric Varn']]);
});

test('TestLibrary_DmHeadingsAndCommentsAreRedacted', async () => {
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Old Kesh', visibility: 'party', markdown: `# Old Kesh\nA port. %%the harbourmaster is a spy%%\n\n## Secrets\nThe smugglers own the docks.\n\n## Markets\nFish and rope.\n<!-- dm -->Trapdoor under the inn.<!-- /dm -->\n` });
  const list = await ok('GET', `/api/worlds/${W}/library/pages`, T.jess);
  const kesh = list.find((p: any) => p.title === 'Old Kesh');
  const body = (await ok('GET', `/api/worlds/${W}/library/pages/${kesh.id}`, T.jess)).body;
  assert.ok(body.includes('Fish and rope'));
  for (const leak of ['spy', 'smugglers', 'Trapdoor']) assert.ok(!body.includes(leak), leak);
  assert.equal((await call('PUT', `/api/worlds/${W}/library/pages`, T.jess, { path: 'x', body: 'hi' })).status, 403);
  assert.equal((await call('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: '../escape', body: 'hi' })).status, 400);
});

test('TestRequests_VisibilityAndApply', async () => {
  const list = await ok('GET', `/api/worlds/${W}/library/pages`, T.jess);
  const kesh = list.find((p: any) => p.title === 'Old Kesh');
  const priv = await ok('POST', `/api/worlds/${W}/requests`, T.jess, { kind: 'edit', pageId: kesh.id, title: 'Add the Gull inn', body: 'The Gull is an inn on the quay.' });
  assert.equal(priv.visibility, 'dm', 'default comes from World settings');
  assert.equal((await ok('GET', `/api/worlds/${W}/requests`, T.tom)).length, 0, 'other players do not see a DM-only request');
  const tamsinId = (await ok('GET', `/api/worlds/${W}/library/pages`, T.dm)).find((p: any) => p.title === 'Brother Tamsin').id;
  assert.equal((await call('POST', `/api/worlds/${W}/requests`, T.jess, { kind: 'edit', pageId: tamsinId, title: 'x', body: 'y' })).status, 404, 'cannot target hidden pages');
  const dec = await ok('POST', `/api/worlds/${W}/requests/${priv.id}/decide`, T.dm, { decision: 'accepted', apply: { mode: 'append' } });
  assert.equal(dec.applied.path, 'places/Old Kesh.md');
  const body = (await ok('GET', `/api/worlds/${W}/library/pages/${kesh.id}`, T.tom)).body;
  assert.ok(body.includes('The Gull is an inn'));
  assert.ok(!body.includes('smugglers'), 'applying an edit keeps redaction');
});

test('TestMessages_OnlyMembersReadAndOnlyStarterKeeps', async () => {
  const t = await ok('POST', `/api/worlds/${W}/messages`, T.jess, { members: [ID.tom] });
  await ok('POST', `/api/worlds/${W}/messages/${t.id}`, T.jess, { body: 'Don’t tell Sela about the ring.' });
  assert.equal((await call('GET', `/api/worlds/${W}/messages/${t.id}`, T.dm)).status, 404, 'DM is not in this chat');
  assert.equal((await ok('GET', `/api/worlds/${W}/messages/${t.id}`, T.tom)).messages.length, 1);
  assert.equal((await call('POST', `/api/worlds/${W}/messages/${t.id}/keep`, T.tom)).status, 403);
  assert.equal((await ok('POST', `/api/worlds/${W}/messages/${t.id}/keep`, T.jess)).kept, true);
  assert.equal((await call('POST', `/api/worlds/${W}/messages`, T.jess, { members: [ID.admin] })).status, 400, 'only world members');
});

test('TestQuickEvents_NoDcOrOutcomeLeak', async () => {
  const ev = await ok('POST', `/api/worlds/${W}/quick-events`, T.dm, { kind: 'recall', title: 'Grey sails', prompt: 'Where have you heard of grey sails?', skill: 'History', dc: 14, successText: 'A ship in mourning.', failText: 'Nothing comes.', audience: [ID.jess], timerS: 60 });
  const seen = await ok('GET', `/api/worlds/${W}/quick-events`, T.jess);
  const s = JSON.stringify(seen);
  assert.ok(s.includes('Grey sails') && !s.includes('mourning') && !s.includes('"dc"'));
  assert.equal((await ok('GET', `/api/worlds/${W}/quick-events`, T.tom)).length, 0, 'not in audience');
  assert.equal((await call('POST', `/api/worlds/${W}/quick-events/${ev.id}/respond`, T.tom, {})).status, 404);
  await ok('POST', `/api/worlds/${W}/quick-events/${ev.id}/respond`, T.jess, { roll: 13, modifier: 2 });
  await ok('POST', `/api/worlds/${W}/quick-events/${ev.id}/resolve`, T.dm, {});
  const after = (await ok('GET', `/api/worlds/${W}/quick-events`, T.jess))[0];
  assert.equal(after.mine.result, 'success');
  assert.equal(after.outcome, 'A ship in mourning.');
  assert.ok(!JSON.stringify(after).includes('Nothing comes'));

  const vote = await ok('POST', `/api/worlds/${W}/quick-events`, T.dm, { kind: 'vote', title: 'Where tonight?', prompt: 'Sleep where?', options: ['The Gull', 'Camp'], publicVotes: true });
  await ok('POST', `/api/worlds/${W}/quick-events/${vote.id}/respond`, T.jess, { choice: 0 });
  const v = (await ok('GET', `/api/worlds/${W}/quick-events`, T.tom)).find((x: any) => x.id === vote.id);
  assert.deepEqual(v.tally, [1, 0]);
});

test('TestCalendar_RsvpChatRescheduleAndFeed', async () => {
  const s = await ok('POST', `/api/worlds/${W}/calendar`, T.dm, { title: 'Session 14', startsAt: new Date(Date.now() + 4 * 864e5).toISOString(), endsAt: new Date(Date.now() + 4 * 864e5 + 4 * 36e5).toISOString(), location: "Wizard's table" });
  assert.equal((await call('POST', `/api/worlds/${W}/calendar`, T.jess, { title: 'x', startsAt: '2026-11-07T19:00:00Z', endsAt: '2026-11-07T23:00:00Z' })).status, 403);
  await ok('PUT', `/api/worlds/${W}/calendar/${s.id}/rsvp`, T.jess, { answer: 'yes' });
  await ok('POST', `/api/worlds/${W}/calendar/${s.id}/chat`, T.tom, { body: 'I’ll bring snacks.' });
  const rs = await ok('POST', `/api/worlds/${W}/calendar/${s.id}/reschedule`, T.jess, { reason: 'Family visit', proposed: [new Date(Date.now() + 5 * 864e5).toISOString()] });
  const cal = await ok('GET', `/api/worlds/${W}/calendar`, T.tom);
  assert.equal(cal[0].rsvps.length, 1);
  assert.equal(cal[0].reschedules.length, 1);
  await ok('POST', `/api/worlds/${W}/calendar/${s.id}/reschedule/${rs.id}`, T.dm, { status: 'accepted', moveTo: rs.proposed[0] });
  assert.equal((await ok('GET', `/api/worlds/${W}/calendar`, T.tom))[0].rsvps.length, 0, 'moving clears RSVPs');

  const key = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'phone calendar', worldId: W })).key;
  const ics = await fetch(`${base}/dav/worlds/${W}/sessions.ics`, { headers: { Authorization: 'Basic ' + Buffer.from(`jess:${key}`).toString('base64') } });
  const text = await ics.text();
  assert.equal(ics.status, 200);
  assert.ok(text.includes('SUMMARY:Session 14') && text.includes("LOCATION:Wizard's table"));
  assert.ok(!text.includes('snacks'), 'feed carries no chat');
});

test('TestKeys_ScribeKeyIsBoundToItsWorldAndNotAdmin', async () => {
  const k = (await ok('POST', '/api/keys', T.admin, { scope: 'admin', label: 'mcp' })).key;
  assert.ok(k.startsWith('alx_adm_'));
  await ok('GET', '/api/admin/accounts', k);
  assert.equal((await call('POST', '/api/keys', T.jess, { scope: 'admin', label: 'nope' })).status, 403);
  const sk = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'mcp', worldId: W })).key;
  assert.ok(sk.startsWith('alx_scr_'));
  assert.equal((await ok('GET', '/api/worlds', sk)).length, 1);
  const w2 = await ok('POST', '/api/admin/worlds', T.admin, { name: 'Other World', dmAccountId: ID.jess });
  assert.equal((await call('GET', `/api/worlds/${w2.id}/library/pages`, sk)).status, 403);
  assert.equal((await call('POST', '/api/keys', sk, { scope: 'scribe', label: 'chain', worldId: W })).status, 403, 'keys cannot mint keys');
});

test('TestLive_CombatViewHidesHealthAndHidden', async () => {
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Mira', accountId: ID.jess, initiative: 18, hp: 31, maxHp: 38 });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Dock thug', initiative: 12, hp: 5, maxHp: 11, effects: [{ name: 'Prone', rounds: 1 }] });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Sniper on the roof', initiative: 20, hp: 20, maxHp: 20, hidden: true });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true, turn: 1 });
  const v = await ok('GET', `/api/worlds/${W}/live/combat`, T.jess);
  const s = JSON.stringify(v);
  assert.ok(!s.includes('Sniper') && !s.includes('31') && !s.includes('"hp"'));
  assert.equal(v.combatants.find((c: any) => c.name === 'Dock thug').health, 'Bloodied');
  assert.equal(v.combatants.find((c: any) => c.name === 'Mira').health, null, 'no health for the party');
  assert.equal(v.myTurn, true);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { monsterHealth: 'none' });
  assert.equal((await ok('GET', `/api/worlds/${W}/live/combat`, T.jess)).combatants.find((c: any) => c.name === 'Dock thug').health, null);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.jess, { monsterHealth: 'exact' })).status, 403);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { bogus: true })).status, 400);
});

test('TestLive_PresenceAndPurse', async () => {
  await ok('PUT', `/api/worlds/${W}/live/presence`, T.jess, { location: 'At the table' });
  await ok('PUT', `/api/worlds/${W}/live/presence`, T.tom, { location: 'Discord' });
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: 'party', amountCp: 4000, note: 'Odda’s favour', session: 'S14' });
  // A player's coin change waits for the DM and does not count until approved.
  const req = await ok('POST', `/api/worlds/${W}/live/ledger`, T.tom, { owner: 'party', amountCp: -60, note: 'Room at the Gull', session: 'S14' });
  assert.equal(req.pending, true);
  assert.equal((await ok('GET', `/api/worlds/${W}/live?session=S14`, T.jess)).purse.cp, 4000);
  await ok('POST', `/api/worlds/${W}/approvals/${req.id}`, T.dm, { action: 'approve' });
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 2700, note: 'Share' });
  const live = await ok('GET', `/api/worlds/${W}/live?session=S14`, T.jess);
  assert.equal(live.here.length, 2);
  assert.equal(live.purse.cp, 3940);
  assert.equal(live.myCoin, 2700);
  assert.equal((await call('GET', `/api/worlds/${W}/live/ledger?owner=${ID.jess}`, T.tom)).status, 403, 'cannot read another player’s coin');
});

test('TestInventory_WeightOffAndDmNotesPrivate', async () => {
  assert.equal((await call('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Mother’s ring' })).status, 400, 'the DM gives a reason when changing a player’s items');
  const it = await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Mother’s ring', weight: 0.1, dmNote: 'It is cursed.', reason: 'Found in the vault' });
  const mine = await ok('GET', `/api/worlds/${W}/inventory?owner=me`, T.jess);
  const s = JSON.stringify(mine);
  assert.equal(mine.trackWeight, false);
  assert.ok(s.includes('Mother’s ring') && !s.includes('cursed') && !s.includes('weight"'));
  assert.equal((await call('PATCH', `/api/worlds/${W}/inventory/${it.id}`, T.tom, { qty: 0 })).status, 403);
  const move = await ok('PATCH', `/api/worlds/${W}/inventory/${it.id}`, T.jess, { owner: 'party' });
  assert.equal(move.pending, true);
  assert.equal((await ok('GET', `/api/worlds/${W}/inventory?owner=party`, T.tom)).items.length, 0, 'moving waits for the DM');
  await ok('POST', `/api/worlds/${W}/approvals/${move.pendingChange.id}`, T.dm, { action: 'approve' });
  assert.equal((await ok('GET', `/api/worlds/${W}/inventory?owner=party`, T.tom)).items.length, 1);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { trackWeight: true });
  assert.equal((await ok('GET', `/api/worlds/${W}/inventory?owner=party`, T.tom)).items[0].weight, 0.1);
});

test('TestMap_MarksRespectVisibilityAndSettings', async () => {
  await ok('POST', `/api/worlds/${W}/map/reach/marks`, T.jess, { kind: 'pin', x: 22, y: 64, label: 'Watch tower', visibility: 'me' });
  await ok('POST', `/api/worlds/${W}/map/reach/marks`, T.tom, { kind: 'note', x: 55, y: 74, text: 'Bring rope' });
  await ok('POST', `/api/worlds/${W}/map/reach/marks`, T.tom, { kind: 'route', points: [{ x: 30, y: 56 }, { x: 44, y: 62 }] });
  const s1 = await ok('POST', `/api/worlds/${W}/map/reach/marks`, T.tom, { kind: 'stop', x: 30, y: 56 });
  const s2 = await ok('POST', `/api/worlds/${W}/map/reach/marks`, T.jess, { kind: 'stop', x: 44, y: 62 });
  assert.deepEqual([s1.data.n, s2.data.n], [1, 2]);
  assert.equal((await ok('GET', `/api/worlds/${W}/map/reach/marks`, T.tom)).length, 4, 'Mira’s private pin is hidden');
  assert.equal((await ok('GET', `/api/worlds/${W}/map/reach/marks`, T.dm)).length, 4, 'even from the DM');
  assert.equal((await call('POST', `/api/worlds/${W}/map/reach/marks`, T.tom, { kind: 'pin', x: 120, y: 0 })).status, 400);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { mapDraw: false });
  assert.equal((await call('POST', `/api/worlds/${W}/map/reach/marks`, T.tom, { kind: 'route', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })).status, 403);
});

test('TestPeople_ProfileBlocksAndPrivateNotes', async () => {
  await ok('PUT', `/api/worlds/${W}/profiles/me/blocks`, T.jess, { section: 'story', title: 'Backstory', body: 'Grew up on the docks.', visibility: 'party' });
  await ok('PUT', `/api/worlds/${W}/profiles/me/blocks`, T.jess, { section: 'story', title: 'What the DM knows', body: 'The letter.', visibility: 'dm' });
  await ok('PUT', `/api/worlds/${W}/profiles/me/blocks`, T.jess, { section: 'goals', title: 'Secret goal', body: 'Revenge on Varn.', visibility: 'me' });
  const titles = async (tok: string) => (await ok('GET', `/api/worlds/${W}/profiles/${ID.jess}`, tok)).blocks.map((b: any) => b.title).sort();
  assert.deepEqual(await titles(T.jess), ['Backstory', 'Secret goal', 'What the DM knows']);
  assert.deepEqual(await titles(T.dm), ['Backstory', 'What the DM knows']);
  assert.deepEqual(await titles(T.tom), ['Backstory']);

  const p = await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Odda', role: 'Harbourmaster', kind: 'neutral' });
  const hidden = await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'The Grey Widow', visibility: 'dm' });
  await ok('POST', `/api/worlds/${W}/people/${p.id}/quotes`, T.dm, { text: 'Forty gold, or a favour.' });
  await ok('POST', `/api/worlds/${W}/people/${p.id}/quotes`, T.dm, { text: 'She works for the Widow.', visibility: 'dm' });
  await ok('POST', `/api/worlds/${W}/people/${p.id}/recalls`, T.dm, { accountId: ID.jess, text: 'She is afraid, not lying', success: true });
  await ok('PUT', `/api/worlds/${W}/people/${p.id}/note`, T.jess, { body: 'Scared of House Varn.' });
  const tom = await ok('GET', `/api/worlds/${W}/people`, T.tom);
  const s = JSON.stringify(tom);
  assert.equal(tom.length, 1);
  assert.ok(s.includes('Forty gold') && s.includes('afraid') && !s.includes('Widow') && !s.includes('Scared'));
  assert.equal((await ok('GET', `/api/worlds/${W}/people`, T.jess))[0].myNote, 'Scared of House Varn.');
  assert.equal((await call('PUT', `/api/worlds/${W}/people/${hidden.id}/note`, T.tom, { body: 'x' })).status, 404);
});

test('TestWhiteboard_VersionsAndWipe', async () => {
  const a = await ok('PUT', `/api/worlds/${W}/whiteboard`, T.jess, { baseVersion: 0, doc: { shapes: [{ t: 'line' }] } });
  assert.equal((await call('PUT', `/api/worlds/${W}/whiteboard`, T.tom, { baseVersion: 0, doc: { shapes: [] } })).status, 409);
  assert.equal((await call('POST', `/api/worlds/${W}/whiteboard/wipe`, T.tom, { confirm: true })).status, 403, 'wipe is DM-only by default');
  assert.equal((await call('POST', `/api/worlds/${W}/whiteboard/wipe`, T.dm, {})).status, 400, 'wipe needs confirm');
  await ok('POST', `/api/worlds/${W}/whiteboard/wipe`, T.dm, { confirm: true });
  assert.deepEqual((await ok('GET', `/api/worlds/${W}/whiteboard/history/${a.version}`, T.tom)).doc, { shapes: [{ t: 'line' }] });
});

test('TestEvents_PlayerStreamGetsNoDmEvents', async () => {
  const ctl = new AbortController();
  const r = await fetch(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${T.tom}` }, signal: ctl.signal });
  const reader = r.body!.getReader();
  let got = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got += new TextDecoder().decode(value);
      }
    } catch { /* aborted */ }
  })();
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'secret/Plot', body: 'The Widow is Ysolde.' });
  await ok('PATCH', `/api/worlds/${W}/live/combatants/${(await ok('GET', `/api/worlds/${W}/live/combat`, T.dm)).combatants[0].id}`, T.dm, { damage: 3 });
  await ok('POST', `/api/worlds/${W}/requests`, T.jess, { kind: 'question', title: 'Is Odda lying?', body: 'DM only please', visibility: 'dm' });
  await new Promise((res) => setTimeout(res, 150));
  ctl.abort();
  await pump;
  assert.ok(got.includes('event: combat'), 'gets the filtered combat view');
  for (const leak of ['Plot', 'Widow', 'Sniper', 'Odda lying', '"hp"']) assert.ok(!got.includes(leak), `stream leaked ${leak}`);
});

test('TestModels_ProxyNeedsAuth', async () => {
  assert.equal((await call('POST', '/v1/chat/completions', undefined, { messages: [] })).status, 401);
  assert.equal((await call('GET', '/v1/models', T.jess)).status, 503, 'no endpoint configured');
});

test('TestKeys_ReadKeysCannotWriteAndOnlyDmGetsWrite', async () => {
  const rk = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'phone', worldId: W })).key;
  assert.equal((await call('POST', `/api/worlds/${W}/messages`, rk, { members: [ID.tom] })).status, 403, 'read key cannot post');
  assert.equal((await call('GET', `/api/worlds/${W}/library/pages`, rk)).status, 200);
  assert.equal((await call('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'w', worldId: W, access: 'write' })).status, 403, 'players get read keys only');
  const wk = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', label: 'dm tools', worldId: W, access: 'write' })).key;
  await ok('PUT', `/api/worlds/${W}/library/pages`, wk, { path: 'from-key', body: 'hi' });
});

test('TestMcpServer_ReadAndWriteTools', async () => {
  const rpc = async (key: string, method: string, params: any = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: r.status, body: await r.json() as any };
  };
  const rk = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'ai', worldId: W })).key;
  const wk = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', label: 'ai', worldId: W, access: 'write' })).key;
  assert.equal((await rpc(T.jess, 'initialize')).status, 401, 'sessions cannot use /mcp');
  assert.ok((await rpc(rk, 'initialize')).body.result.instructions.includes('read-only'));
  const readTools = (await rpc(rk, 'tools/list')).body.result.tools.map((t: any) => t.name);
  const writeTools = (await rpc(wk, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(readTools.includes('search_library') && !readTools.includes('save_page'));
  assert.ok(writeTools.includes('save_page'));
  const denied = await rpc(rk, 'tools/call', { name: 'save_page', arguments: { path: 'x', markdown: 'y' } });
  assert.ok(denied.body.error, 'read key cannot call write tools');
  const s = await rpc(rk, 'tools/call', { name: 'search_library', arguments: { query: 'poisoned' } });
  assert.equal(JSON.parse(s.body.result.content[0].text).length, 0, 'player AI search uses the party index');
  const saved = await rpc(wk, 'tools/call', { name: 'save_page', arguments: { path: 'mcp/Note', markdown: 'From the DM AI.' } });
  assert.equal(saved.body.result.isError, false);
  assert.equal(JSON.parse(saved.body.result.content[0].text).visibility, 'dm');
});

test('TestJoin_AutoReadOnlyMcpKeyAndSignedInJoin', async () => {
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'newbie', password: 'player pass 123' });
  assert.equal(j.mcp.access, 'read');
  assert.ok(j.mcp.key.startsWith('alx_scr_') && j.mcp.url.endsWith('/mcp'));
  assert.equal(j.mcp.config.mcpServers.alexandria.headers.Authorization, `Bearer ${j.mcp.key}`);
  assert.equal((await call('POST', `/api/worlds/${W}/messages`, j.mcp.key, { members: [ID.tom] })).status, 403, 'auto key is read-only');
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${j.mcp.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.ok(!(await r.json() as any).result.tools.some((t: any) => t.name === 'save_page'));
  // An existing signed-in player joins another world with a code.
  const w2 = await ok('POST', '/api/admin/worlds', T.admin, { name: 'Second World', dmAccountId: ID.dm });
  const inv2 = await ok('POST', `/api/worlds/${w2.id}/invites`, T.dm, { role: 'player' });
  const j2 = await ok('POST', '/api/join', T.tom, { code: inv2.code });
  assert.equal(j2.account.id, ID.tom);
  assert.equal(j2.token, T.tom);
});
