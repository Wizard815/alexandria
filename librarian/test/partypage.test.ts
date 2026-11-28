// The GM's Players page data (a card per player, then the party) and the player's Mine / Party summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

async function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-pp-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j: any = t;
    try { j = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: j };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  const ID: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Packland', gmAccountId: ID.gm })).id;
  for (const [u, c] of [['jess', 'Jess'], ['tom', 'Tom']]) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: u, password: 'player pass 123', characterName: c });
    T[u] = j.token; ID[u] = j.account.id;
  }
  const api = `/api/worlds/${W}`;
  return { deps: made.deps, W, T, ID, api, call, ok, close: () => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('TestPartyPage_OverviewHasACardPerPlayerThenTheParty', async () => {
  const e = await boot();
  try {
    await e.ok('POST', `${e.api}/live/ledger`, e.T.gm, { owner: e.ID.jess, amountCp: 2500, note: 'Reward' });
    await e.ok('POST', `${e.api}/live/ledger`, e.T.gm, { owner: 'party', amountCp: 10000, note: 'Hoard' });
    await e.ok('POST', `${e.api}/inventory`, e.T.gm, { owner: e.ID.jess, name: 'Rope', qty: 3, gmNote: 'frayed', reason: 'Found' });
    await e.ok('POST', `${e.api}/inventory`, e.T.gm, { owner: e.ID.tom, name: 'Torch', qty: 5, reason: 'x' });
    await e.ok('POST', `${e.api}/inventory`, e.T.gm, { owner: 'party', name: 'Tent', qty: 1 });
    const o = await e.ok('GET', `${e.api}/inventory/overview`, e.T.gm);
    assert.equal(o.players.length, 2);
    const jess = o.players.find((p: any) => p.id === e.ID.jess);
    assert.equal(jess.character, 'Jess');
    assert.equal(jess.cp, 2500);
    assert.deepEqual(jess.items.map((i: any) => [i.name, i.qty, i.gm_note]), [['Rope', 3, 'frayed']]);
    assert.equal(o.players.find((p: any) => p.id === e.ID.tom).cp, 0);
    assert.equal(o.party.cp, 10000);
    assert.deepEqual(o.party.items.map((i: any) => i.name), ['Tent']);
    assert.equal(o.partyPurse, true);
  } finally { e.close(); }
});

test('TestPartyPage_OverviewIsForTheGmOnlyAndKeepsGmNotesAway', async () => {
  const e = await boot();
  try {
    await e.ok('POST', `${e.api}/inventory`, e.T.gm, { owner: e.ID.jess, name: 'Ring', qty: 1, gmNote: 'CURSEDNOTE', reason: 'x' });
    assert.equal((await e.call('GET', `${e.api}/inventory/overview`, e.T.jess)).status, 403);
    assert.equal((await e.call('GET', `${e.api}/inventory/overview`)).status, 401);
    const s = await e.ok('GET', `${e.api}/inventory/summary`, e.T.jess);
    assert.ok(!JSON.stringify(s).includes('CURSEDNOTE'));
  } finally { e.close(); }
});

test('TestPartyPage_SummaryShowsMineAndPartySeparately', async () => {
  const e = await boot();
  try {
    await e.ok('POST', `${e.api}/live/ledger`, e.T.gm, { owner: e.ID.jess, amountCp: 700 });
    await e.ok('POST', `${e.api}/live/ledger`, e.T.gm, { owner: e.ID.tom, amountCp: 900 });
    await e.ok('POST', `${e.api}/live/ledger`, e.T.gm, { owner: 'party', amountCp: 5000 });
    await e.ok('POST', `${e.api}/inventory`, e.T.gm, { owner: e.ID.jess, name: 'Dagger', qty: 2, reason: 'x' });
    await e.ok('POST', `${e.api}/inventory`, e.T.gm, { owner: 'party', name: 'Map', qty: 1 });
    const s = await e.ok('GET', `${e.api}/inventory/summary`, e.T.jess);
    assert.equal(s.mine.cp, 700, 'only my own coin');
    assert.equal(s.mine.qty, 2);
    assert.equal(s.party.cp, 5000);
    assert.equal(s.party.kinds, 1);
    const t = await e.ok('GET', `${e.api}/inventory/summary`, e.T.tom);
    assert.equal(t.mine.cp, 900);
    assert.equal(t.mine.qty, 0);
  } finally { e.close(); }
});

test('TestPartyPage_PartyPurseOffHidesTheBalance', async () => {
  const e = await boot();
  try {
    await e.ok('PATCH', `${e.api}/settings`, e.T.gm, { partyPurse: false });
    const o = await e.ok('GET', `${e.api}/inventory/overview`, e.T.gm);
    assert.equal(o.party.cp, null);
    assert.equal((await e.ok('GET', `${e.api}/inventory/summary`, e.T.jess)).party.cp, null);
  } finally { e.close(); }
});
