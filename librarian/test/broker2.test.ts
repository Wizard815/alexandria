// Broker v2: question classification (secrets never leak), DM notes and page
// rules, special offers, free giving between players, coin requests and
// item pictures.
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
const P: Record<string, string> = {};
let W = '';
const B = () => `/api/worlds/${W}/broker`;
const I = () => `/api/worlds/${W}/inventory`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const coin = async (who: string) => (await ok('GET', `/api/worlds/${W}/live/ledger`, T[who])).cp as number;
const mcp = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return JSON.stringify(r.body);
};

const SECRET_WORDS = ['Velmira', 'smuggler queen', 'lighthouse', 'treasury'];
// Words the player typed themselves may echo back; everything else must not appear.
const noSecrets = (where: string, x: unknown, asked = '') => {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  for (const w of SECRET_WORDS.filter((w) => !asked.toLowerCase().includes(w.toLowerCase()))) assert.ok(!s.toLowerCase().includes(w.toLowerCase()), `${where} leaked "${w}": ${s.slice(0, 400)}`);
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-brk2-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: {} });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Brokerland Two', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
  P.salt = await page('places/Saltmarsh', 'party', `---\nknowledge: local\n---\n# Saltmarsh\nSaltmarsh is a fishing town ruled by the harbour council of seven captains.\n\n> [!secret] DM\n> The harbour council secretly answers to the smuggler queen Velmira.\n`);
  P.hearts = await page('lore/Hearts', 'party', `---\nknowledge: deep\n---\n# The Hearts\nThe nine Hearts were forged before the sundering to bind the elder storms.\n`);
  P.road = await page('party/Road', 'party', `---\nknowledge: common\n---\n# The road north\nThe party took the road north past the burned mill near Greywater ford.\n`);
  P.velmira = await page('dm/Velmira', 'dm', `# Velmira\nVelmira the smuggler queen keeps her treasury beneath the lighthouse.\n`);
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 2000, note: 'Starting coin' });
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.tom, amountCp: 20, note: 'Starting coin' });
});

after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TestBrokerClassify_SecretQuestionNeverReachesPlayers', async () => {
  const k = await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'ai', access: 'read' });
  const questions = ['Who does the harbour council of Saltmarsh secretly answer to?', 'Where does Velmira keep her treasury?'];
  for (const question of questions) {
    // The DM sees why it is a secret, with the DM-side lines.
    const c = await ok('POST', `${B()}/classify`, T.dm, { question });
    assert.equal(c.verdict, 'secret', `${question}: ${c.reason}`);
    assert.ok(JSON.stringify(c.dmEvidence).includes('Velmira'));
    assert.equal(c.player, null);
    // The player gets the same reply as for a question nobody can answer.
    const q = await ok('POST', `${B()}/quote`, T.jess, { question });
    const unknown = await ok('POST', `${B()}/quote`, T.jess, { question: 'What colour are the moon cheese caravans?' });
    assert.equal(q.secret, true);
    assert.equal(q.line, unknown.line);
    assert.deepEqual(Object.keys(q).sort(), Object.keys(unknown).sort());
    noSecrets('quote', q, question);
    const asked = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
    assert.equal(asked.status, 'pricing');
    noSecrets('ask', asked, question);
    assert.equal(asked.classification, undefined);
    noSecrets('MCP quote', await mcp(k.key, 'ask_broker_quote', { question }), question);
  }
  const mine = await ok('GET', B(), T.jess);
  noSecrets('list', mine, questions.join(' '));
  assert.ok(mine.requests.every((r: any) => r.classification === undefined));
  noSecrets('MCP list', await mcp(k.key, 'list_broker_requests'), questions.join(' '));
  // The DM's list carries the classification and evidence.
  const dmList = await ok('GET', B(), T.dm);
  const r = dmList.requests.find((x: any) => x.status === 'pricing');
  assert.equal(r.classification.verdict, 'secret');
  assert.ok(r.classification.reason);
});

test('TestBrokerClassify_SharedQuestionCitesPlayerCopyOnly', async () => {
  const c = await ok('POST', `${B()}/classify`, T.dm, { question: 'Who rules Saltmarsh?' });
  assert.equal(c.verdict, 'shared', c.reason);
  assert.equal(c.type, 'who');
  assert.ok(c.player.answer.includes('harbour council of seven captains'));
  noSecrets('shared answer', c.player);
  assert.deepEqual(c.player.sources.map((s: any) => s.id), [P.salt]);
  assert.ok(c.entities.some((e: any) => e.id === P.salt && e.shared));
});

test('TestBrokerNotes_DMNotesAreSoldAndCiteSafely', async () => {
  // A note tied to a DM-only page cites "the broker's own sources", never the page title.
  const n = await ok('POST', `${B()}/notes`, T.dm, { topic: 'Greywater ford ferryman toll', text: 'The ferryman at Greywater ford charges two silver a head, double after dark.', knowledge: 'local', pageId: P.velmira });
  assert.equal(n.page_title, 'Velmira');
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'What does the ferryman at Greywater ford charge?' });
  assert.equal(q.secret, false);
  assert.equal(q.tier, 'local');
  const a = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  await ok('POST', `${B()}/${a.id}/deliver`, T.dm);
  const got = (await ok('GET', B(), T.jess)).requests.find((x: any) => x.id === a.id);
  assert.ok(got.answer.includes('two silver a head'));
  noSecrets('note answer', got);
  // Turning the note off: the broker no longer knows it.
  await ok('PATCH', `${B()}/notes/${n.id}`, T.dm, { active: false });
  assert.equal((await ok('POST', `${B()}/quote`, T.jess, { question: 'What does the ferryman at Greywater ford charge?' })).secret, true);
  // Save a DM answer as a note.
  const saved = await ok('POST', `${B()}/${a.id}/note`, T.dm, { text: 'The ferryman is called Old Brann.' });
  assert.equal(saved.from_request, a.id);
  assert.equal((await call('GET', `${B()}/notes`, T.jess)).status, 403);
});

test('TestBrokerRules_NeverSellAndMultiplier', async () => {
  const before_ = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh?' });
  await ok('PUT', `${B()}/rules/${P.salt}`, T.dm, { multiplier: 3, knowledge: 'deep' });
  const after_ = await ok('POST', `${B()}/quote`, T.jess, { question: 'Who rules Saltmarsh?' });
  assert.equal(after_.tier, 'deep');
  assert.ok(after_.cost_cp > before_.cost_cp);
  await ok('PUT', `${B()}/rules/${P.hearts}`, T.dm, { neverSell: true });
  const c = await ok('POST', `${B()}/classify`, T.dm, { question: 'What were the nine Hearts forged to bind?' });
  assert.equal(c.verdict, 'secret');
  assert.equal((await ok('POST', `${B()}/quote`, T.jess, { question: 'What were the nine Hearts forged to bind?' })).secret, true);
  const rules = await ok('GET', `${B()}/rules`, T.dm);
  assert.equal(rules.length, 2);
  await ok('DELETE', `${B()}/rules/${P.salt}`, T.dm);
  await ok('DELETE', `${B()}/rules/${P.hearts}`, T.dm);
});

test('TestBroker_RefuseModeTurnsAwayAndOnlyDMSeesIt', async () => {
  const cfg = await ok('GET', `${B()}/config`, T.dm);
  await ok('PUT', `${B()}/config`, T.dm, { ...cfg, unknown: 'refuse' });
  const q = await ok('POST', `${B()}/quote`, T.jess, { question: 'Where does Velmira keep her treasury?' });
  assert.equal(q.refused, true);
  noSecrets('refused quote', q);
  const a = await ok('POST', `${B()}/ask`, T.jess, { quoteId: q.quoteId });
  assert.equal(a.status, 'noted');
  assert.ok(!(await ok('GET', B(), T.jess)).requests.some((x: any) => x.id === a.id));
  assert.ok((await ok('GET', B(), T.dm)).requests.some((x: any) => x.id === a.id && x.status === 'noted'));
  await ok('PUT', `${B()}/config`, T.dm, { ...cfg, unknown: 'dm' });
});

test('TestBrokerOffers_TargetPayDeclineExpire', async () => {
  // To Jess only: Tom never sees it.
  const o = await ok('POST', `${B()}/offers`, T.dm, { title: 'The lighthouse keeper', teaser: 'I know who pays the keeper.', info: 'The keeper is paid in pearls by someone on the council.', priceCp: 500, targets: [ID.jess], expiresSessions: 1 });
  assert.equal((await ok('GET', `${B()}/offers`, T.tom)).length, 0);
  const seen = (await ok('GET', `${B()}/offers`, T.jess))[0];
  assert.equal(seen.title, 'The lighthouse keeper');
  assert.equal(seen.info, undefined);
  assert.equal(seen.targets, undefined);
  const cp = await coin('jess');
  const paid = await ok('POST', `${B()}/offers/${o.id}/pay`, T.jess, {});
  assert.equal(paid.status, 'paid');
  assert.ok(paid.info.includes('pearls'));
  assert.equal(await coin('jess'), cp - 500);
  assert.equal((await call('POST', `${B()}/offers/${o.id}/pay`, T.jess, {})).status, 409);

  // To the party: one decline keeps it open for the other.
  const p = await ok('POST', `${B()}/offers`, T.dm, { title: 'A map of the caves', info: 'Third tunnel on the left.', priceCp: 100, targets: 'party', fallbackHours: 5 });
  assert.equal((await ok('POST', `${B()}/offers/${p.id}/decline`, T.tom)).status, 'open');
  assert.ok(!(await ok('GET', `${B()}/offers`, T.tom)).some((x: any) => x.id === p.id));
  assert.ok((await ok('GET', `${B()}/offers`, T.jess)).some((x: any) => x.id === p.id));
  assert.equal((await ok('POST', `${B()}/offers/${p.id}/decline`, T.jess)).status, 'declined');

  // Session-based expiry follows the calendar.
  const start = new Date(Date.now() + 86400_000).toISOString();
  const end = new Date(Date.now() + 86400_000 + 4 * 3600_000).toISOString();
  await ok('POST', `/api/worlds/${W}/calendar`, T.dm, { title: 'Game night', startsAt: start, endsAt: end });
  const s = await ok('POST', `${B()}/offers`, T.dm, { title: 'Until next session', info: 'x', priceCp: 1, targets: 'party', expiresSessions: 1 });
  assert.equal(Date.parse(s.expires_at), Date.parse(end));
  // Once its time has passed it disappears.
  const e = await ok('POST', `${B()}/offers`, T.dm, { title: 'Short-lived', info: 'y', priceCp: 1, targets: 'party', fallbackHours: 1 });
  run(deps.db, 'UPDATE broker_offers SET fallback_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), e.id);
  assert.ok(!(await ok('GET', `${B()}/offers`, T.jess)).some((x: any) => x.id === e.id));
  assert.equal((await ok('GET', `${B()}/offers`, T.dm)).find((x: any) => x.id === e.id).status, 'expired');
  assert.equal((await call('POST', `${B()}/offers/${e.id}/pay`, T.jess, {})).status, 404);
});

test('TestTransfers_CoinRequestFundsAnOffer', async () => {
  const o = await ok('POST', `${B()}/offers`, T.dm, { title: 'Who hired the assassin', info: 'A dockside fence named Pell.', priceCp: 300, targets: [ID.tom], fallbackHours: 48 });
  assert.equal((await call('POST', `${B()}/offers/${o.id}/pay`, T.tom, {})).status, 402);
  const rq = await ok('POST', `${I()}/coin-requests`, T.tom, { to: 'party', amountCp: 280, note: 'For the broker', offerId: o.id });
  const inc = await ok('GET', `${I()}/coin-requests`, T.jess);
  assert.ok(inc.incoming.some((x: any) => x.id === rq.id));
  const jessBefore = await coin('jess');
  const done = await ok('POST', `${I()}/coin-requests/${rq.id}/give`, T.jess, {});
  assert.equal(done.status, 'done');
  assert.equal(await coin('jess'), jessBefore - 280);
  assert.equal(await coin('tom'), 300);
  assert.equal((await ok('POST', `${B()}/offers/${o.id}/pay`, T.tom, {})).status, 'paid');
  // Gives are never pending, and the DM sees them.
  const ap = await ok('GET', `/api/worlds/${W}/approvals`, T.dm);
  assert.ok(ap.counts.transfers >= 1);
  assert.ok(ap.transfers.some((t: any) => t.kind === 'coin' && t.amount_cp === 280));
  assert.equal(ap.coin.length, 0);
});

test('TestTransfers_GiveCoinChecksAndSetting', async () => {
  const j = await coin('jess');
  await ok('POST', `${I()}/coin/transfer`, T.jess, { to: ID.tom, amountCp: 10, note: 'drinks' });
  assert.equal(await coin('jess'), j - 10);
  assert.equal((await call('POST', `${I()}/coin/transfer`, T.jess, { to: ID.tom, amountCp: 10_000_000 })).status, 402);
  assert.equal((await call('POST', `${I()}/coin/transfer`, T.tom, { from: ID.jess, to: ID.tom, amountCp: 5 })).status, 403);
  assert.equal((await call('POST', `${I()}/coin/transfer`, T.jess, { to: ID.jess, amountCp: 5 })).status, 400);
  // Into and out of the party purse.
  await ok('POST', `${I()}/coin/transfer`, T.jess, { to: 'party', amountCp: 50 });
  await ok('POST', `${I()}/coin/transfer`, T.tom, { from: 'party', to: 'me', amountCp: 20 });
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { playerTransfers: false });
  assert.equal((await call('POST', `${I()}/coin/transfer`, T.jess, { to: ID.tom, amountCp: 1 })).status, 403);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { playerTransfers: true });
});

test('TestTransfers_MoveSplitMergeItems', async () => {
  const rope = await ok('POST', I(), T.dm, { owner: ID.jess, name: 'Rope (50 ft)', qty: 3, reason: 'Bought in town', dmNote: 'One is frayed' });
  const m = await ok('POST', `${I()}/${rope.id}/move`, T.jess, { to: 'party', qty: 1 });
  assert.equal(m.left.qty, 2);
  assert.equal(m.moved.owner, 'party');
  assert.equal(m.moved.dm_note, undefined);
  // Moving more to the party stacks with what's there.
  const m2 = await ok('POST', `${I()}/${rope.id}/move`, T.jess, { to: 'party', qty: 1 });
  assert.equal(m2.moved.id, m.moved.id);
  assert.equal(m2.moved.qty, 2);
  // Tom can take from the stash but not from Jess.
  await ok('POST', `${I()}/${m.moved.id}/move`, T.tom, { to: 'me', qty: 1 });
  assert.equal((await call('POST', `${I()}/${rope.id}/move`, T.tom, { to: 'me' })).status, 403);
  assert.equal((await call('POST', `${I()}/${rope.id}/move`, T.jess, { to: ID.tom, qty: 5 })).status, 400);
  const toms = (await ok('GET', `${I()}?owner=me`, T.tom)).items;
  assert.ok(toms.some((x: any) => x.name === 'Rope (50 ft)' && x.qty === 1 && x.status === 'approved'));
  // The DM still has the private note on every stack.
  const dmView = (await ok('GET', `${I()}?owner=${ID.tom}`, T.dm)).items.find((x: any) => x.name === 'Rope (50 ft)');
  assert.equal(dmView.dm_note, 'One is frayed');
});

test('TestItemImages_UploadSniffAndVisibility', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const up = await ok('POST', `${I()}/images`, T.jess, { dataBase64: png.toString('base64') });
  assert.equal(up.mime, 'image/png');
  assert.equal((await call('POST', `${I()}/images`, T.jess, { dataBase64: Buffer.from('<svg onload=alert(1)>').toString('base64') })).status, 400);
  assert.equal((await call('POST', `${I()}/images`, T.jess, { dataBase64: Buffer.alloc(2 * 1024 * 1024 + 10, 0xff).toString('base64') })).status, 413);
  // Raw bytes work too.
  const raw = await fetch(`${base}${I()}/images`, { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${T.jess}` }, body: png });
  assert.equal(raw.status, 201);

  const lamp = await ok('POST', I(), T.dm, { owner: ID.jess, name: 'Brass lamp', image: up.id, reason: 'Found it' });
  assert.equal(lamp.image, up.id);
  const img = await call('GET', `${I()}/images/${up.id}`, T.jess);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await call('GET', `${I()}/images/${up.id}`, T.tom)).status, 404);
  await ok('POST', `${I()}/${lamp.id}/move`, T.jess, { to: 'party' });
  assert.equal((await call('GET', `${I()}/images/${up.id}`, T.tom)).status, 200);
  // Links: http(s) only.
  assert.equal((await call('POST', I(), T.dm, { owner: 'party', name: 'Odd', image: 'javascript:alert(1)', reason: 'test' })).status, 400);
  assert.equal((await ok('POST', I(), T.dm, { owner: 'party', name: 'Shield', image: 'https://example.com/shield.png', reason: 'Loot' })).image, 'https://example.com/shield.png');
});

test('TestBroker_MCPOfferAndNoteTools', async () => {
  const dk = await ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dm ai', access: 'write' });
  const pk = await ok('POST', '/api/keys', T.tom, { scope: 'scribe', worldId: W, label: 'tom ai', access: 'read' });
  const list = async (key: string) => JSON.stringify((await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body);
  assert.ok((await list(dk.key)).includes('send_broker_offer'));
  assert.ok(!(await list(pk.key)).includes('send_broker_offer'));
  assert.ok((await list(pk.key)).includes('list_broker_offers'));
  await mcp(dk.key, 'send_broker_offer', { title: 'From the AI', info: 'secret sauce', priceCp: 5, targets: ['party'], fallbackHours: 2 });
  const tomSees = await mcp(pk.key, 'list_broker_offers');
  assert.ok(tomSees.includes('From the AI'));
  assert.ok(!tomSees.includes('secret sauce'));
});
