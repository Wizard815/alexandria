// The information broker and DM approvals, end to end over HTTP.
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
const B = () => `/api/worlds/${W}/broker`;

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-brk-'));
  const { app } = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: {} });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Brokerland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  // Shared pages at each knowledge level, plus DM-only text the broker must never use.
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: `---\nknowledge: local\n---\n# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council of seven captains.\n\n> [!secret] DM\n> The harbour council secretly answers to the smuggler queen Velmira.\n` });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'lore/Hearts', visibility: 'party', markdown: `---\nknowledge: deep\n---\n# The Hearts\nThe nine Hearts were forged before the sundering to bind the elder storms.\n` });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'party/Road', visibility: 'party', markdown: `---\nknowledge: common\n---\n# The road north\nThe party took the road north past the burned mill near Greywater ford.\n` });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'dm/Velmira', visibility: 'dm', markdown: `# Velmira\nVelmira the smuggler queen keeps her treasury beneath the lighthouse.\n` });
  // Give the players coin (DM entries are approved straight away).
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 2000, note: 'Starting coin' });
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.tom, amountCp: 20, note: 'Starting coin' });
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const jessCoin = async () => (await ok('GET', `/api/worlds/${W}/live/ledger`, T.jess)).entries.filter((e: any) => e.status === 'approved' && e.owner === ID.jess).reduce((a: number, e: any) => a + e.amount_cp, 0);

test('TestBroker_ConfigDefaultsAndDMOnlyEdits', async () => {
  const c = await ok('GET', `${B()}/config`, T.jess);
  assert.deepEqual(c.tiers.map((t: any) => t.knowledge), ['common', 'local', 'deep', 'secret']);
  assert.equal(c.tiers[0].costCp, 0);
  assert.equal((await call('PUT', `${B()}/config`, T.jess, c)).status, 403);
  assert.equal((await call('POST', `${B()}/clock`, T.jess, { addMinutes: 60 })).status, 403);
  assert.equal((await call('PUT', `${B()}/config`, T.dm, { ...c, tiers: c.tiers.slice(0, 2) })).status, 400, 'every knowledge level keeps a tier');
  const changed = structuredClone(c);
  changed.persona.name = 'Old Wick';
  await ok('PUT', `${B()}/config`, T.dm, changed);
  assert.equal((await ok('GET', `${B()}/config`, T.tom)).persona.name, 'Old Wick');
});

test('TestBroker_QuoteUsesPartyLibraryAndNeverCharges', async () => {
  const before = await jessCoin();
  const common = await ok('GET', `${B()}/quote?question=${encodeURIComponent('What happened at the burned mill near Greywater?')}`, T.jess);
  assert.equal(common.tier, 'common');
  assert.equal(common.cost_cp, 0);
  const local = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  assert.equal(local.tier, 'local');
  assert.equal(local.cost_cp, 50);
  assert.deepEqual(local.wait, { amount: 1, unit: 'hours', clock: 'game' });
  const full = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?', length: 'full' });
  assert.equal(full.cost_cp, 100, 'full answers cost double');
  const deep = await ok('POST', `${B()}/quote`, T.jess, { question: 'What are the nine Hearts and the elder storms?' });
  assert.equal(deep.tier, 'deep');
  assert.equal(deep.cost_cp, 200);
  // Only DM pages know this: the library has no match, so the DM prices it.
  const secret = await ok('POST', `${B()}/quote`, T.jess, { question: 'Where is the treasury beneath the lighthouse?' });
  assert.equal(secret.tier, 'secret');
  assert.equal(secret.cost_cp, null);
  assert.equal(await jessCoin(), before, 'quotes never charge');
});

test('TestBroker_AskChargesAndHidesAnswerUntilGameTime', async () => {
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  assert.equal((await call('POST', `${B()}/ask`, T.tom, { quoteId: q.quoteId })).status, 404, 'a quote belongs to its asker');
  const before = await jessCoin();
  const r = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  assert.equal(r.status, 'waiting');
  assert.equal(r.wait_clock, 'game');
  assert.equal(r.answer, undefined, 'answer hidden while waiting');
  assert.equal(await jessCoin(), before - 50);
  assert.equal((await call('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId })).status, 404, 'a quote is used once');
  const led = (await ok('GET', `/api/worlds/${W}/live/ledger`, T.jess)).entries.find((e: any) => e.amount_cp === -50);
  assert.match(led.note, /Saltmarsh/);
  assert.equal(led.status, 'approved', 'broker charges are system entries');

  // DM sees the prepared answer; it holds only player-copy text.
  const dmView = (await ok('GET', B(), T.dm)).requests.find((x: any) => x.id === r.id);
  assert.match(dmView.answer, /harbour council of seven captains/);
  assert.doesNotMatch(dmView.answer, /Velmira|smuggler queen/);
  assert.equal(dmView.asker, ID.jess);

  await ok('POST', `${B()}/clock`, T.dm, { addMinutes: 30 });
  assert.equal((await ok('GET', B(), T.jess)).requests[0].status, 'waiting');
  await ok('POST', `${B()}/clock`, T.dm, { addMinutes: 30 });
  const done = (await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r.id);
  assert.equal(done.status, 'answered');
  assert.match(done.answer, /seven captains/);
  assert.doesNotMatch(JSON.stringify(done), /Velmira|smuggler/);
  assert.ok(done.sources.some((s: any) => s.title === 'Saltmarsh'));
  assert.ok(done.voice.startsWith('Old Wick'));
});

test('TestBroker_RealTimeWaitAndDeliverEarly', async () => {
  const c = await ok('GET', `${B()}/config`, T.dm);
  c.tiers.find((t: any) => t.knowledge === 'deep').wait = { amount: 2, unit: 'hours', clock: 'real' };
  await ok('PUT', `${B()}/config`, T.dm, c);
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'What are the nine Hearts and the elder storms?' });
  const r = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  assert.equal(r.wait_clock, 'real');
  const wait = Date.parse(r.ready_at) - Date.now();
  assert.ok(wait > 7_000_000 && wait <= 7_200_000, `ready about 2 hours out (${wait})`);
  await ok('POST', `${B()}/clock`, T.dm, { addMinutes: 10_000 });
  assert.equal((await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r.id).status, 'waiting', 'game time does not move real waits');
  assert.equal((await call('POST', `${B()}/${r.id}/deliver`, T.jess)).status, 403);
  await ok('POST', `${B()}/${r.id}/deliver`, T.dm);
  const done = (await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r.id);
  assert.equal(done.status, 'answered');
  assert.match(done.answer, /forged before the sundering/);
});

test('TestBroker_InsufficientCoinIsRefused', async () => {
  const q = await ok('POST', `${B()}/quote`, T.tom, { question: 'What are the nine Hearts and the elder storms?' });
  const r = await call('POST', `${B()}/ask`, T.tom, { quoteId: q.quoteId });
  assert.equal(r.status, 402);
  assert.match(r.body.error, /Not enough coin/);
  assert.equal((await ok('GET', B(), T.tom)).requests.length, 0, 'nothing recorded');
  const tomCoin = (await ok('GET', `/api/worlds/${W}/live/ledger`, T.tom)).entries.filter((e: any) => e.owner === ID.tom && e.status === 'approved').reduce((a: number, e: any) => a + e.amount_cp, 0);
  assert.equal(tomCoin, 20);
});

test('TestBroker_SecretGoesToDMThenOfferAcceptRefund', async () => {
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Where is the treasury beneath the lighthouse?' });
  const before = await jessCoin();
  const r = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  assert.equal(r.status, 'pricing');
  assert.equal(await jessCoin(), before, 'no charge until priced and accepted');
  assert.equal((await call('POST', `${B()}/${r.id}/price`, T.jess, { costCp: 1 })).status, 403);
  await ok('POST', `${B()}/${r.id}/price`, T.dm, { costCp: 120, waitAmount: 0, answer: 'Under the old lighthouse, they say.', note: 'Costly, this one.' });
  const offered = (await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r.id);
  assert.equal(offered.status, 'offered');
  assert.equal(offered.cost_cp, 120);
  assert.equal(offered.answer, undefined);
  await ok('POST', `${B()}/${r.id}/accept`, T.jess);
  assert.equal(await jessCoin(), before - 120);
  const got = (await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r.id);
  assert.equal(got.status, 'answered', 'no wait: answered at once');
  assert.equal(got.answer, 'Under the old lighthouse, they say.');
  await ok('POST', `${B()}/${r.id}/refund`, T.dm, { note: 'Bad info' });
  assert.equal(await jessCoin(), before);
  assert.equal((await call('POST', `${B()}/${r.id}/refund`, T.dm)).status, 409, 'refund once');
});

test('TestBroker_RefuseWaitingRefundsAndEditAnswer', async () => {
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  const before = await jessCoin();
  const r = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  await ok('PATCH', `${B()}/${r.id}`, T.dm, { answer: 'Seven captains, all of them crooked.' });
  const q2 = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  const r2 = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q2.quoteId });
  assert.equal(await jessCoin(), before - 100);
  await ok('POST', `${B()}/${r2.id}/refuse`, T.dm, { note: 'The broker went fishing.' });
  assert.equal(await jessCoin(), before - 50);
  assert.equal((await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r2.id).status, 'refunded');
  await ok('POST', `${B()}/${r.id}/deliver`, T.dm);
  assert.equal((await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === r.id).answer, 'Seven captains, all of them crooked.');
});

test('TestBroker_PlayersSeeOnlyTheirOwnRequests', async () => {
  const jess = (await ok('GET', B(), T.jess)).requests;
  assert.ok(jess.length > 0);
  assert.equal((await ok('GET', B(), T.tom)).requests.length, 0);
  assert.equal((await call('POST', `${B()}/${jess[0].id}/accept`, T.tom)).status, 404);
  assert.equal((await call('POST', `${B()}/${jess[0].id}/decline`, T.tom)).status, 404);
  assert.ok(jess.every((x: any) => x.asker === undefined), 'players do not get asker ids');
  assert.ok((await ok('GET', B(), T.dm)).requests.length >= jess.length);
});

test('TestBroker_DisabledFailsClosed', async () => {
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerEnabled: false });
  assert.equal((await call('POST', `${B()}/quote`, T.jess, { question: 'Saltmarsh?' })).status, 404);
  assert.equal((await call('GET', B(), T.jess)).status, 404);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerEnabled: true });
});

test('TestBroker_PartyPayer', async () => {
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerPayer: 'party', partyPurse: true });
  const q = await ok('POST', `${B()}/quote`, T.tom, { question: 'Who rules Saltmarsh harbour?' });
  assert.equal((await call('POST', `${B()}/ask`, T.tom, { quoteId: q.quoteId })).status, 402, 'empty purse');
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: 'party', amountCp: 500 });
  const q2 = await ok('POST', `${B()}/quote`, T.tom, { question: 'Who rules Saltmarsh harbour?' });
  const r = await ok('POST', `${B()}/ask`, T.tom, { quoteId: q2.quoteId });
  assert.equal(r.payer, 'party');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerPayer: 'self' });
});

test('TestApprovals_PlayerCoinWaitsForDM', async () => {
  const before = await jessCoin();
  const r = await call('POST', `/api/worlds/${W}/live/ledger`, T.jess, { owner: 'me', amountCp: 1000, note: 'Found a chest' });
  assert.equal(r.status, 202);
  assert.equal(await jessCoin(), before, 'pending coin does not count');
  assert.equal((await call('GET', `/api/worlds/${W}/approvals`, T.jess)).status, 403);
  const mine = await ok('GET', `/api/worlds/${W}/approvals/mine`, T.jess);
  assert.ok(mine.coin.some((c: any) => c.id === r.body.id && c.status === 'pending'));
  const q = await ok('GET', `/api/worlds/${W}/approvals`, T.dm);
  assert.ok(q.coin.some((c: any) => c.id === r.body.id));
  await ok('POST', `/api/worlds/${W}/approvals/${r.body.id}`, T.dm, { action: 'edit', amountCp: 400 });
  assert.equal(await jessCoin(), before + 400);
  const r2 = await call('POST', `/api/worlds/${W}/live/ledger`, T.jess, { owner: 'me', amountCp: 999 });
  await ok('POST', `/api/worlds/${W}/approvals/${r2.body.id}`, T.dm, { action: 'reject' });
  assert.equal(await jessCoin(), before + 400);
  assert.equal((await call('POST', `/api/worlds/${W}/approvals/${r2.body.id}`, T.dm, { action: 'approve' })).status, 404, 'decided once');
});

test('TestApprovals_PlayerItemsArePendingUntilApproved', async () => {
  const add = await call('POST', `/api/worlds/${W}/inventory`, T.jess, { owner: 'me', name: 'Silver dagger', qty: 1 });
  assert.equal(add.status, 202);
  const list = await ok('GET', `/api/worlds/${W}/inventory`, T.jess);
  const it = (list.items ?? list).find((x: any) => x.name === 'Silver dagger');
  assert.equal(it.status, 'pending');
  const tomSees = await ok('GET', `/api/worlds/${W}/approvals/mine`, T.tom);
  assert.ok(!tomSees.items.some((x: any) => x.item_id === it.id), 'other players do not see my proposals');
  await ok('POST', `/api/worlds/${W}/approvals/${it.pendingChange.id}`, T.dm, { action: 'approve' });
  const after = (await ok('GET', `/api/worlds/${W}/inventory`, T.jess));
  assert.equal((after.items ?? after).find((x: any) => x.id === it.id).status, 'approved');
  // An edit waits too, and the item keeps its old values until approved.
  const ed = await ok('PATCH', `/api/worlds/${W}/inventory/${it.id}`, T.jess, { qty: 5 });
  assert.ok(ed.pending ?? ed.pendingChange);
  const still = (await ok('GET', `/api/worlds/${W}/inventory`, T.jess));
  const cur = (still.items ?? still).find((x: any) => x.id === it.id);
  assert.equal(cur.qty, 1);
  await ok('POST', `/api/worlds/${W}/approvals/${cur.pendingChange.id}`, T.dm, { action: 'reject' });
  const fin = (await ok('GET', `/api/worlds/${W}/inventory`, T.jess));
  assert.equal((fin.items ?? fin).find((x: any) => x.id === it.id).qty, 1);
});

test('TestApprovals_DMChangeAlertsOwnerDisputeAndRevert', async () => {
  const list = await ok('GET', `/api/worlds/${W}/inventory`, T.jess);
  const it = (list.items ?? list).find((x: any) => x.name === 'Silver dagger');
  assert.equal((await call('PATCH', `/api/worlds/${W}/inventory/${it.id}`, T.dm, { qty: 0 })).status, 400, 'a reason is required');
  await ok('PATCH', `/api/worlds/${W}/inventory/${it.id}`, T.dm, { qty: 0, reason: 'It broke on the golem' });
  const mine = await ok('GET', `/api/worlds/${W}/approvals/mine`, T.jess);
  const alert = mine.alerts.find((a: any) => a.item_id === it.id && a.status === 'alert');
  assert.equal(alert.reason, 'It broke on the golem');
  assert.equal((await call('POST', `/api/worlds/${W}/approvals/${alert.id}/dispute`, T.tom, { note: 'no' })).status, 404, 'only the owner answers');
  await ok('POST', `/api/worlds/${W}/approvals/${alert.id}/dispute`, T.jess, { note: 'It was the iron golem, silver is immune' });
  const q = await ok('GET', `/api/worlds/${W}/approvals`, T.dm);
  assert.ok(q.disputes.some((x: any) => x.id === alert.id));
  await ok('POST', `/api/worlds/${W}/approvals/${alert.id}`, T.dm, { action: 'revert' });
  const back = await ok('GET', `/api/worlds/${W}/inventory`, T.jess);
  assert.equal((back.items ?? back).find((x: any) => x.id === it.id).qty, 1);
  // And "Looks right".
  await ok('PATCH', `/api/worlds/${W}/inventory/${it.id}`, T.dm, { note: 'Etched with runes', reason: 'Identified' });
  const a2 = (await ok('GET', `/api/worlds/${W}/approvals/mine`, T.jess)).alerts.find((a: any) => a.status === 'alert');
  await ok('POST', `/api/worlds/${W}/approvals/${a2.id}/ack`, T.jess);
  assert.equal((await ok('GET', `/api/worlds/${W}/approvals/mine`, T.jess)).alerts.find((a: any) => a.id === a2.id).status, 'ok');
});

test('TestBroker_MCPQuoteToolNeverCharges', async () => {
  // A read key can quote (GET) but not ask.
  const k = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'ai', access: 'read' });
  const before = await jessCoin();
  const q = await ok('GET', `${B()}/quote?question=Saltmarsh%20harbour`, k.key);
  assert.equal(q.tier, 'local');
  assert.equal((await call('POST', `${B()}/ask`, k.key, { quoteId: q.quoteId })).status, 403);
  assert.equal(await jessCoin(), before);
});
