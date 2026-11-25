// The player chooses how to pay the broker once a price is set: their own coin or the party pouch.
// Checked on the server: balances, the world setting, the log the party sees, and no double spend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { all, one, run } from '../src/core/db.ts';
import { balance } from '../src/core/coin.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const B = () => `/api/worlds/${W}/broker`;

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
const set = (patch: Record<string, unknown>) => ok('PATCH', `/api/worlds/${W}/settings`, T.dm, patch);
const coin = (owner: string) => balance(deps.db, W, owner);
const setCoin = (owner: string, cp: number) => { run(deps.db, 'DELETE FROM ledger WHERE world_id = ? AND owner = ?', W, owner); if (cp) run(deps.db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, 'Test', ?, ?, 'approved')`, `led_t${Math.random()}`, W, owner, cp, ID.dm, new Date().toISOString()); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-bpf-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Payland', dmAccountId: ID.dm })).id;
  for (const [u, c] of [['jess', 'Jess'], ['tom', 'Tom']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: u, password: 'player pass 123', characterName: c });
    T[u] = j.token; ID[u] = j.account.id;
  }
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: `---\nknowledge: local\n---\n# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council of seven captains.\n` });
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const offer = (price = 500, targets: unknown = 'party', title = 'The lantern route') => ok('POST', `${B()}/offers`, T.dm, { title, teaser: 'Psst.', info: 'Follow the lanterns.', priceCp: price, targets });

test('TestBrokerPayFrom_OptionsShowBothBalancesAndTheSetting', async () => {
  setCoin(ID.jess, 300); setCoin('party', 900);
  const o = await ok('GET', `${B()}/pay-options`, T.jess);
  assert.equal(o.self.cp, 300);
  assert.equal(o.party.cp, 900);
  assert.equal(o.party.allowed, true);
  await set({ brokerPartyPay: false });
  const off = await ok('GET', `${B()}/pay-options`, T.jess);
  assert.equal(off.party.allowed, false);
  assert.match(off.party.reason, /DM/);
  await set({ brokerPartyPay: true });
  assert.equal((await call('GET', `${B()}/pay-options`)).status, 401);
});

test('TestBrokerPayFrom_TheSettingDefaultsOnAndIsDmOnly', async () => {
  const c = await ok('GET', `/api/worlds/${W}/settings`, T.dm);
  assert.equal(c.brokerPartyPay, true);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.jess, { brokerPartyPay: false })).status, 403);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { brokerPartyPay: 'no' })).status, 400);
});

test('TestBrokerPayFrom_OfferPaidFromThePartyPouchIsLoggedForTheParty', async () => {
  setCoin(ID.jess, 100); setCoin('party', 800);
  const o = await offer(500);
  const paid = await ok('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paid_from_party, true);
  assert.equal(coin('party'), 300);
  assert.equal(coin(ID.jess), 100, 'her own coin was not touched');
  const row = one<any>(deps.db, `SELECT note, by_id, amount_cp FROM ledger WHERE world_id = ? AND owner = 'party' AND amount_cp = -500`, W)!;
  assert.equal(row.note, 'Broker: The lantern route (paid by Jess from the party pouch)');
  assert.equal(row.by_id, ID.jess);
  // Another player reads the party log and sees who paid.
  const log = await ok('GET', `/api/worlds/${W}/live/ledger?owner=party`, T.tom);
  assert.ok(log.entries.some((e: any) => e.note.includes('paid by Jess from the party pouch')));
  // The DM sees who paid and from where.
  const dm = (await ok('GET', `${B()}/offers`, T.dm)).find((x: any) => x.id === o.id);
  assert.equal(dm.paid_by_name, 'Jess');
  assert.equal(dm.paid_from, 'party');
});

test('TestBrokerPayFrom_OfferPaidFromOwnCoinDefaultsToSelf', async () => {
  setCoin(ID.tom, 700); setCoin('party', 5000);
  const o = await offer(200, 'party', 'A smaller secret');
  await ok('POST', `${B()}/offers/${o.id}/pay`, T.tom, {});
  assert.equal(coin(ID.tom), 500);
  assert.equal(coin('party'), 5000);
  const dm = (await ok('GET', `${B()}/offers`, T.dm)).find((x: any) => x.id === o.id);
  assert.equal(dm.paid_from, ID.tom, 'own coin is recorded as the payer');
});

test('TestBrokerPayFrom_ADisabledSettingBlocksThePartyPouch', async () => {
  setCoin(ID.jess, 100); setCoin('party', 5000);
  await set({ brokerPartyPay: false });
  const o = await offer(300, 'party', 'Closed pouch');
  const r = await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /party pouch/i);
  assert.equal(coin('party'), 5000);
  // The old world setting that made the pouch pay by default falls back to the player's own coin.
  await set({ brokerPayer: 'party' });
  setCoin(ID.jess, 1000);
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  const asked = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  assert.notEqual(asked.payer, 'party');
  await set({ brokerPayer: 'self', brokerPartyPay: true });
});

test('TestBrokerPayFrom_PartyPouchOffWhollyRefusesIt', async () => {
  await set({ partyPurse: false });
  setCoin(ID.jess, 1000);
  const o = await offer(100, 'party', 'No pouch');
  assert.equal((await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' })).status, 400);
  assert.equal((await ok('GET', `${B()}/pay-options`, T.jess)).party.allowed, false);
  await set({ partyPurse: true });
});

test('TestBrokerPayFrom_NotEnoughInThePurseChosenIsRefusedAndNothingMoves', async () => {
  setCoin(ID.jess, 50); setCoin('party', 200);
  const o = await offer(500, 'party', 'Too dear');
  const own = await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'self' });
  assert.equal(own.status, 402);
  assert.match(own.body.error, /you have/);
  const party = await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' });
  assert.equal(party.status, 402);
  assert.match(party.body.error, /party pouch has/);
  assert.equal(coin('party'), 200);
  assert.equal(coin(ID.jess), 50);
  assert.equal(one<any>(deps.db, 'SELECT status FROM broker_offers WHERE id = ?', o.id)!.status, 'open', 'the offer stays open');
  assert.equal((await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'wallet' })).status, 400);
});

test('TestBrokerPayFrom_TwoPlayersPayingTheSamePouchAtOnceSpendItOnce', async () => {
  setCoin(ID.jess, 0); setCoin(ID.tom, 0); setCoin('party', 500);
  const a = await offer(500, 'party', 'Race one');
  const b = await offer(500, 'party', 'Race two');
  const results = await Promise.all([
    call('POST', `${B()}/offers/${a.id}/pay`, T.jess, { from: 'party' }),
    call('POST', `${B()}/offers/${b.id}/pay`, T.tom, { from: 'party' }),
  ]);
  const good = results.filter((r) => r.status === 200).length;
  assert.equal(good, 1, JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.some((r) => r.status === 402));
  assert.equal(coin('party'), 0, 'the pouch never goes below zero');
});

test('TestBrokerPayFrom_TheSameOfferPaidTwiceAtOnceIsPaidOnce', async () => {
  setCoin(ID.jess, 2000); setCoin(ID.tom, 2000);
  const o = await offer(300, 'party', 'Double pay');
  const results = await Promise.all([
    call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'self' }),
    call('POST', `${B()}/offers/${o.id}/pay`, T.tom, { from: 'self' }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.equal(coin(ID.jess) + coin(ID.tom), 4000 - 300);
  assert.equal(all<any>(deps.db, `SELECT 1 FROM ledger WHERE world_id = ? AND note LIKE 'Broker: Double pay%'`, W).length, 1);
});

test('TestBrokerPayFrom_AQuotedQuestionCanBePaidFromTheParty', async () => {
  setCoin(ID.jess, 10); setCoin('party', 1000);
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  assert.ok(q.cost_cp > 0, 'a priced quote');
  // Own coin cannot cover it: refused, and the quote survives so another purse can be chosen.
  const no = await call('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId, from: 'self' });
  assert.equal(no.status, 402);
  const yes = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId, from: 'party' });
  assert.equal(yes.payer, 'party');
  assert.equal(coin('party'), 1000 - q.cost_cp);
  const row = one<any>(deps.db, `SELECT note FROM ledger WHERE world_id = ? AND owner = 'party' AND amount_cp = ?`, W, -q.cost_cp)!;
  assert.match(row.note, /\(paid by Jess from the party pouch\)$/);
  // The DM sees who paid and from where on the request.
  const dm = (await ok('GET', B(), T.dm)).requests.find((x: any) => x.id === yes.id);
  assert.equal(dm.paid_by_name, 'Jess');
  assert.equal(dm.paid_from, 'party');
  const mine = (await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === yes.id);
  assert.equal(mine.paid_by, undefined, 'players are not told more than they need');
});

test('TestBrokerPayFrom_AcceptingAPricedSecretFromTheParty', async () => {
  setCoin(ID.tom, 0); setCoin('party', 900);
  const q = await ok('POST', `${B()}/quote`, T.tom, { question: 'Where does the smuggler queen hide her treasury?' });
  const asked = await ok('POST', `${B()}/ask`, T.tom, { quoteId: q.quoteId });
  assert.equal(asked.status, 'pricing');
  await ok('POST', `${B()}/${asked.id}/price`, T.dm, { costCp: 400, waitAmount: 0, waitUnit: 'minutes', clock: 'real', answer: 'Beneath the lighthouse.' });
  assert.equal((await call('POST', `${B()}/${asked.id}/accept`, T.tom, { from: 'self' })).status, 402);
  assert.equal((await call('POST', `${B()}/${asked.id}/accept`, T.jess, { from: 'party' })).status, 404, 'only the asker accepts');
  const done = await ok('POST', `${B()}/${asked.id}/accept`, T.tom, { from: 'party' });
  assert.notEqual(done.status, 'offered');
  assert.equal(coin('party'), 500);
  assert.equal((await call('POST', `${B()}/${asked.id}/accept`, T.tom, { from: 'party' })).status, 409, 'cannot be accepted twice');
  assert.equal(coin('party'), 500);
});

test('TestBrokerPayFrom_PartyPaymentIsAnnouncedLiveToThePartyOnly', async () => {
  setCoin(ID.jess, 0); setCoin('party', 400);
  const hub = deps.hub as any;
  const seen: { type: string; data: any; aud: (v: any) => boolean }[] = [];
  const real = hub.emit.bind(hub);
  hub.emit = (w: string, type: string, data: any, aud: any) => { seen.push({ type, data, aud }); return real(w, type, data, aud); };
  const o = await offer(100, 'party', 'Live one');
  await ok('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' });
  hub.emit = real;
  const ev = seen.find((e) => e.type === 'coin' && e.data.owner === 'party');
  assert.ok(ev, 'a coin event for the party pouch');
  assert.equal(ev!.data.balance, 300);
  assert.equal(ev!.data.by, 'Jess');
  assert.equal(ev!.aud({ accountId: ID.tom, role: 'player' }), true);
  assert.equal(ev!.aud({ accountId: '', role: 'guest' }), false);
});

const pendingDebit = (owner: string, cp: number) => run(deps.db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, 'Waiting', ?, ?, 'pending')`, `led_p${Math.random()}`, W, owner, -cp, ID.jess, new Date().toISOString());
const clearPending = () => run(deps.db, `DELETE FROM ledger WHERE world_id = ? AND status = 'pending'`, W);

test('TestBrokerPayFrom_APendingDebitCountsAgainstWhatCanBeSpent', async () => {
  setCoin(ID.jess, 600); setCoin('party', 600);
  pendingDebit(ID.jess, 300); pendingDebit('party', 300);
  const opts = await ok('GET', `${B()}/pay-options`, T.jess);
  assert.equal(opts.self.cp, 600, 'the approved balance is unchanged');
  assert.equal(opts.self.available, 300);
  assert.equal(opts.party.available, 300);
  const o = await offer(400, 'party', 'Promised coin');
  const own = await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'self' });
  assert.equal(own.status, 402, 'own coin promised to a waiting debit is not spent twice');
  assert.match(own.body.error, /you have 3 gp/);
  const party = await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' });
  assert.equal(party.status, 402, 'the pouch cannot be overdrawn by a waiting debit either');
  assert.equal(coin(ID.jess), 600);
  assert.equal(coin('party'), 600);
  // A pending credit is not coin yet.
  run(deps.db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, 1000, 'Hoped for', ?, ?, 'pending')`, `led_c${Math.random()}`, W, ID.jess, ID.jess, new Date().toISOString());
  assert.equal((await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'self' })).status, 402);
  // What is left after the promise can still be spent.
  const small = await offer(300, 'party', 'Just enough');
  await ok('POST', `${B()}/offers/${small.id}/pay`, T.jess, { from: 'self' });
  assert.equal(coin(ID.jess), 300);
  clearPending();
});

test('TestBrokerPayFrom_APendingDebitBlocksAGiftThatWouldOverdraw', async () => {
  setCoin(ID.jess, 500); pendingDebit(ID.jess, 400);
  const r = await call('POST', `/api/worlds/${W}/inventory/coin/transfer`, T.jess, { from: 'me', to: ID.tom, amountCp: 200 });
  assert.equal(r.status, 402, JSON.stringify(r.body));
  assert.equal(coin(ID.jess), 500);
  clearPending();
});

test('TestBrokerPayFrom_ThePartyLogNamesOnlyWhatEveryPlayerMaySee', async () => {
  setCoin(ID.jess, 0); setCoin('party', 5000);
  // An offer to Jess alone, paid from the pouch: Tom reads the pouch log and must not learn its title.
  const o = await offer(200, [ID.jess], 'The secret of the drowned bell');
  const hub = deps.hub as any;
  const seen: any[] = [];
  const real = hub.emit.bind(hub);
  hub.emit = (w: string, type: string, data: any, aud: any) => { seen.push({ type, data }); return real(w, type, data, aud); };
  await ok('POST', `${B()}/offers/${o.id}/pay`, T.jess, { from: 'party' });
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh harbour?' });
  // A question is the asker's own: paid from the pouch it reads as a neutral line too.
  await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId, from: 'party' });
  hub.emit = real;
  const log = await ok('GET', `/api/worlds/${W}/live/ledger?owner=party`, T.tom);
  assert.ok(!JSON.stringify(log).includes('drowned bell'), 'a private offer title stays off the party log');
  assert.ok(!JSON.stringify(log).includes('Saltmarsh'), 'the question stays off the party log');
  assert.equal(log.entries.filter((e: any) => e.note === 'Broker purchase (paid by Jess from the party pouch)').length, 2);
  const live = await ok('GET', `/api/worlds/${W}/live`, T.tom);
  assert.ok(!/drowned bell|Saltmarsh/.test(JSON.stringify(live.purse)));
  const partyEvents = seen.filter((e) => e.type === 'coin' && e.data.owner === 'party');
  assert.equal(partyEvents.length, 2);
  assert.ok(!/drowned bell|Saltmarsh/.test(JSON.stringify(partyEvents)), 'the live pouch event is neutral too');
  // Jess still sees her own offer by name.
  assert.ok((await ok('GET', `${B()}/offers`, T.jess)).some((x: any) => x.title === 'The secret of the drowned bell'));
});
