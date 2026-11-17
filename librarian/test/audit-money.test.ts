// Audit: coin and item transfers, offers and requests under double clicks and bad numbers. Nothing may go below zero or appear from nowhere.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); await k.ok('POST', k.w('/live/ledger'), k.T.dm, { owner: k.ID.jess, amountCp: 100, note: 'start' }); });
after(() => k?.close());
const coin = async (who: string) => (await k.ok('GET', k.w(`/live/ledger?owner=${who === 'party' ? 'party' : 'me'}`), who === 'party' ? k.T.jess : k.T[who])).cp as number;
const total = async () => (await coin('jess')) + (await coin('tom')) + (await coin('party'));
const give = (token: string, body: unknown) => k.call('POST', k.w('/inventory/coin/transfer'), token, body);

test('Audit_Money: a burst of simultaneous transfers cannot spend the same coin twice', async () => {
  const start = await total();
  const results = await Promise.all(Array.from({ length: 12 }, () => give(k.T.jess, { to: k.ID.tom, amountCp: 30 })));
  const done = results.filter((r) => r.status === 201).length;
  assert.equal(done, 3, `${done} of 12 transfers of 30 went through from a purse of 100: ${results.map((r) => r.status)}`);
  assert.equal(await coin('jess'), 10);
  assert.equal(await coin('tom'), 90);
  assert.equal(await total(), start, 'coin appeared or vanished');
});

test('Audit_Money: bad amounts are refused, nobody can give from another purse, and nothing goes negative', async () => {
  for (const amountCp of [0, -5, 1.5, '3.5', 1e12, null, 'lots', [30], true, 'NaN']) {
    const r = await give(k.T.tom, { to: k.ID.jess, amountCp });
    assert.ok(r.status === 400, `amount ${JSON.stringify(amountCp)} -> ${r.status} ${r.text.slice(0, 80)}`);
  }
  assert.equal((await give(k.T.tom, { from: k.ID.jess, to: k.ID.tom, amountCp: 5 })).status, 403, 'giving from someone else');
  assert.equal((await give(k.T.tom, { to: k.ID.tom, amountCp: 5 })).status, 400, 'giving to yourself');
  assert.equal((await give(k.T.tom, { to: 'acc_doesnotexist', amountCp: 5 })).status, 404);
  assert.equal((await give(k.T.visitor, { to: k.ID.tom, amountCp: 5 })).status, 403, 'a guest');
  assert.ok((await coin('jess')) >= 0 && (await coin('tom')) >= 0 && (await coin('party')) >= 0);
});

test('Audit_Money: a coin request cannot be paid twice, nor beyond what is asked', async () => {
  const req = await k.ok('POST', k.w('/inventory/coin-requests'), k.T.jess, { to: k.ID.tom, amountCp: 40, note: 'ale' });
  const before = await total();
  const pays = await Promise.all(Array.from({ length: 5 }, () => k.call('POST', k.w(`/inventory/coin-requests/${req.id}/give`), k.T.tom, {})));
  assert.equal(pays.filter((r) => r.status === 200).length, 1, `paid ${pays.filter((r) => r.status === 200).length} times: ${pays.map((r) => r.status)}`);
  assert.equal(await total(), before);
  const over = await k.ok('POST', k.w('/inventory/coin-requests'), k.T.jess, { to: k.ID.tom, amountCp: 10 });
  const r = await k.call('POST', k.w(`/inventory/coin-requests/${over.id}/give`), k.T.tom, { amountCp: 11 });
  assert.equal(r.status, 400, 'giving more than asked');
});

test('Audit_Money: a broker offer paid by two players at once is paid once; the party pouch cannot go negative', async () => {
  await k.ok('POST', k.w('/live/ledger'), k.T.dm, { owner: 'party', amountCp: 50, note: 'pouch' });
  const offer = await k.ok('POST', k.w('/broker/offers'), k.T.dm, { title: 'A rumour', info: 'Something', priceCp: 40, targets: 'party' });
  const before = await total();
  const pays = await Promise.all([k.call('POST', k.w(`/broker/offers/${offer.id}/pay`), k.T.jess, { from: 'party' }), k.call('POST', k.w(`/broker/offers/${offer.id}/pay`), k.T.tom, { from: 'party' })]);
  assert.equal(pays.filter((r) => r.status === 200).length, 1, `${pays.map((r) => r.status)}`);
  assert.equal(await total(), before - 40);
  assert.ok((await coin('party')) >= 0);
});

test('Audit_Money: item moves cannot create or lose items, and a stack move of more than there is is refused', async () => {
  const it = await k.ok('POST', k.w('/inventory'), k.T.dm, { owner: k.ID.jess, name: 'Arrow', qty: 5, reason: 'quiver' });
  const moves = await Promise.all(Array.from({ length: 8 }, () => k.call('POST', k.w(`/inventory/${it.id}/move`), k.T.jess, { to: 'party', qty: 1 })));
  const ok = moves.filter((r) => r.status === 200).length;
  const mine = await k.ok('GET', k.w('/inventory?owner=me'), k.T.jess);
  const party = await k.ok('GET', k.w('/inventory?owner=party'), k.T.jess);
  const qty = (inv: any) => inv.items.filter((i: any) => i.name === 'Arrow').reduce((n: number, i: any) => n + i.qty, 0);
  assert.equal(qty(mine) + qty(party), 5, `arrows now ${qty(mine)} + ${qty(party)} after ${ok} moves: ${moves.map((r) => r.status)}`);
  assert.equal(ok, 5);
  assert.ok([403, 404].includes((await k.call('POST', k.w(`/inventory/${it.id}/move`), k.T.tom, { to: k.ID.tom })).status), 'taking another player item');
  const bad = await k.call('POST', k.w(`/inventory/${it.id}/move`), k.T.jess, { to: 'party', qty: -1 });
  assert.ok([400, 404].includes(bad.status));
});
