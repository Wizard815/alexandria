// The live session board: staging vs shown, per-player cards, player copies
// only (no DM notes or secret blocks), the combat card following the players'
// combat view, buying through approvals, picture checks, filtered live events.
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
const P: Record<string, string> = {};
let W = '';
const S = () => `/api/worlds/${W}/stage`;

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { json = null; }
  return { status: r.status, body: json, buf };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const SECRETS = ['Ashgrove cult', 'Mordane', 'cursed by the lich', 'Buried truth', 'haggle down'];
const noSecrets = (where: string, x: unknown) => {
  const s = typeof x === 'string' ? x : JSON.stringify(x);
  for (const w of SECRETS) assert.ok(!s.includes(w), `${where} leaked "${w}": ${s.slice(0, 500)}`);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const add = (body: Record<string, unknown>) => ok('POST', `${S()}/cards`, T.dm, body);
const stage = (tok: string) => ok('GET', S(), tok);
const ids = (b: any) => b.cards.map((c: any) => c.id);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-stage-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Stageland', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
  P.town = await page('places/Westmarch', 'party', `# Westmarch\nA harbour town under grey skies.\n\n> [!secret] DM\n> The Ashgrove cult runs the docks.\n\n## Docks\nBusy at dawn.\n`);
  P.hidden = await page('dm/Lair', 'dm', `# Lair\nThe Ashgrove cult meets here.\n`);
  P.shop = await page('shops/Mordo', 'party', `# Mordo's Sundries\nRope, lamps and odd things.\n\n- Rope (50 ft) - 1 gp\n- Lantern - 5 gp\n- Mystery box - priceless\n\n> [!secret] DM\n> Mordane the owner will haggle down to half.\n`);
  P.npcPage = await page('people/Brenna', 'party', `# Brenna\nA brisk innkeeper.\n\n> [!secret] DM\n> Brenna is cursed by the lich Mordane.\n`);
  // A person with a player-facing page, a party quote and a DM-only quote.
  P.npc = (await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Brenna', role: 'Innkeeper', attitude: 'friendly', pageId: P.npcPage, visibility: 'party' })).id;
  await ok('POST', `/api/worlds/${W}/people/${P.npc}/quotes`, T.dm, { text: 'Mind the stairs.', visibility: 'party' });
  await ok('POST', `/api/worlds/${W}/people/${P.npc}/quotes`, T.dm, { text: 'Buried truth: the cult pays me.', visibility: 'dm' });
  P.secretNpc = (await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Mordane', role: 'Lich', visibility: 'dm' })).id;
});

after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TestStage_StagedCardsAreHiddenFromPlayersAndShownCardsAreSeen', async () => {
  const c = await add({ kind: 'text', title: 'Rumour', text: 'The *bridge* is weak.' });
  assert.equal(c.visibility, 'dm');
  assert.deepEqual(ids(await stage(T.jess)), []);
  assert.ok(ids(await stage(T.dm)).includes(c.id));
  // Players cannot create, show or read history.
  assert.equal((await call('POST', `${S()}/cards`, T.jess, { kind: 'text', text: 'x' })).status, 403);
  assert.equal((await call('POST', `${S()}/cards/${c.id}/show`, T.jess, {})).status, 403);
  assert.equal((await call('GET', `${S()}/history`, T.jess)).status, 403);

  await ok('POST', `${S()}/cards/${c.id}/show`, T.dm, {});
  const seen = await stage(T.jess);
  assert.deepEqual(ids(seen), [c.id]);
  assert.equal(seen.cards[0].data.markdown, 'The *bridge* is weak.');
  assert.equal(seen.cards[0].label, undefined, 'players do not get staging fields');
  await ok('POST', `${S()}/cards/${c.id}/hide`, T.dm);
  assert.deepEqual(ids(await stage(T.tom)), []);
  const hist = await ok('GET', `${S()}/history`, T.dm);
  assert.deepEqual(hist.slice(0, 3).map((h: any) => h.action), ['hide', 'show', 'add']);
  await ok('DELETE', `${S()}/cards/${c.id}`, T.dm);
});

test('TestStage_PerPlayerCardsOnlyReachChosenPlayers', async () => {
  const c = await add({ kind: 'text', title: 'Whisper', text: 'Only Jess hears this.', to: [ID.jess] });
  assert.deepEqual(ids(await stage(T.jess)), [c.id]);
  assert.deepEqual(ids(await stage(T.tom)), []);
  assert.equal((await call('POST', `${S()}/cards/${c.id}/show`, T.dm, { to: ['someone-else'] })).status, 400);
  await ok('POST', `${S()}/cards/${c.id}/show`, T.dm, { to: 'all' });
  assert.deepEqual(ids(await stage(T.tom)), [c.id]);
  await ok('DELETE', `${S()}/cards/${c.id}`, T.dm);
});

test('TestStage_PageAndPersonCardsNeverIncludeDMNotesOrSecretBlocks', async () => {
  const place = await add({ kind: 'place', ref: P.town, show: true });
  const shop = await add({ kind: 'shop', ref: P.shop, show: true });
  const person = await add({ kind: 'person', ref: P.npc, show: true });
  for (const tok of [T.jess, T.dm]) {
    const b = await stage(tok);
    noSecrets(tok === T.dm ? 'dm board' : 'player board', b);
  }
  const b = await stage(T.jess);
  const pc = b.cards.find((c: any) => c.id === person.id);
  assert.equal(pc.data.person.name, 'Brenna');
  assert.deepEqual(pc.data.person.quotes.map((q: any) => q.text), ['Mind the stairs.']);
  assert.ok(JSON.stringify(pc.data.page).includes('brisk innkeeper'));
  const sc = b.cards.find((c: any) => c.id === shop.id);
  assert.deepEqual(sc.data.items.map((i: any) => [i.name, i.priceCp]), [['Rope (50 ft)', 100], ['Lantern', 500], ['Mystery box - priceless', null]]);
  assert.ok(b.cards.find((c: any) => c.id === place.id).data.page.title === 'Westmarch');
  // A DM-supplied preview is not trusted: extra fields are ignored.
  const sneaky = await add({ kind: 'place', ref: P.town, show: true, preview: 'Ashgrove cult', text: 'Mordane', caption: 'x' });
  noSecrets('sneaky place', await stage(T.jess));
  for (const x of [place, shop, person, sneaky]) await ok('DELETE', `${S()}/cards/${x.id}`, T.dm);
});

test('TestStage_DMOnlyPagesAndPeopleCannotBeShownAndFailClosedLater', async () => {
  assert.equal((await call('POST', `${S()}/cards`, T.dm, { kind: 'place', ref: P.hidden, show: true })).status, 409);
  assert.equal((await call('POST', `${S()}/cards`, T.dm, { kind: 'person', ref: P.secretNpc, show: true })).status, 409);
  assert.deepEqual(ids(await stage(T.dm)), [], 'a failed show leaves no card behind');
  // Staging is fine; the DM sees it is unavailable to players.
  const staged = await add({ kind: 'place', ref: P.hidden });
  assert.equal(staged.unavailable, true);
  await ok('DELETE', `${S()}/cards/${staged.id}`, T.dm);
  // A shown page that is later made DM-only drops off the players' board.
  const c = await add({ kind: 'place', ref: P.town, show: true });
  assert.deepEqual(ids(await stage(T.jess)), [c.id]);
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'places/Westmarch', visibility: 'dm', markdown: '# Westmarch\nNow secret.\n' });
  assert.deepEqual(ids(await stage(T.jess)), []);
  await ok('DELETE', `${S()}/cards/${c.id}`, T.dm);
});

test('TestStage_CombatCardFollowsThePlayersCombatView', async () => {
  const lv = (tok: string) => ok('GET', `/api/worlds/${W}/live/combat`, tok);
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Jess the Bold', accountId: ID.jess, initiative: 15, hp: 20, maxHp: 20 });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Goblin', initiative: 12, hp: 4, maxHp: 10 });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Ambusher in the Dark', initiative: 18, hp: 30, maxHp: 30, hidden: true, ac: 17 });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true });
  const c = await add({ kind: 'combat', show: true });
  for (const mode of ['words', 'none', 'exact']) {
    await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { monsterHealth: mode });
    const b = await stage(T.jess);
    const card = b.cards.find((x: any) => x.id === c.id);
    assert.deepEqual(card.data.view, await lv(T.jess), `combat card matches the live view (${mode})`);
    const s = JSON.stringify(card);
    assert.ok(!s.includes('Ambusher'), 'hidden foes stay hidden');
    assert.ok(!s.includes('"ac"'), 'no armor class');
    const gob = card.data.view.combatants.find((x: any) => x.name === 'Goblin');
    if (mode === 'none') assert.equal(gob.health, null);
    else assert.ok(gob.health, 'monster health follows the setting');
    assert.equal(card.data.view.combatants.find((x: any) => x.is_pc).health, null);
  }
  // The DM's card is the full tracker.
  const dmCard = (await stage(T.dm)).cards.find((x: any) => x.id === c.id);
  assert.ok(JSON.stringify(dmCard).includes('Ambusher'));
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { monsterHealth: 'words' });
  await ok('DELETE', `${S()}/cards/${c.id}`, T.dm);
});

test('TestStage_BuyGoesThroughApprovals', async () => {
  const shop = await add({ kind: 'shop', ref: P.shop, show: true });
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 1000, note: 'starting coin' });
  const coin = async () => (await ok('GET', `/api/worlds/${W}/live/ledger?owner=me`, T.jess));
  assert.equal((await coin()).cp, 1000);

  // The price comes from the page, whatever the request says.
  const r = await ok('POST', `${S()}/cards/${shop.id}/buy`, T.jess, { item: 'lantern', qty: 2, priceCp: 1 });
  assert.equal(r.pending, true);
  assert.equal(r.totalCp, 1000);
  assert.equal((await coin()).cp, 1000, 'coin has not moved until the DM approves');
  const inv = await ok('GET', `/api/worlds/${W}/inventory`, T.jess);
  const it = inv.items.find((x: any) => x.name === 'Lantern');
  assert.equal(it.status, 'pending');
  const ap = await ok('GET', `/api/worlds/${W}/approvals`, T.dm);
  assert.ok(ap.coin.some((c: any) => c.id === r.coinEntryId && c.amount_cp === -1000));
  assert.ok(ap.items.some((c: any) => c.id === r.changeId && c.kind === 'add'));
  // Waiting purchases reserve the coin.
  assert.equal((await call('POST', `${S()}/cards/${shop.id}/buy`, T.jess, { item: 'Rope (50 ft)' })).status, 402);

  await ok('POST', `/api/worlds/${W}/approvals/${r.coinEntryId}`, T.dm, { action: 'approve' });
  await ok('POST', `/api/worlds/${W}/approvals/${r.changeId}`, T.dm, { action: 'approve' });
  assert.equal((await coin()).cp, 0);
  assert.equal((await ok('GET', `/api/worlds/${W}/inventory`, T.jess)).items.find((x: any) => x.name === 'Lantern').qty, 2);

  // No price, unknown item, the DM, a card tom cannot see, and an unshown shop.
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 500 });
  assert.equal((await call('POST', `${S()}/cards/${shop.id}/buy`, T.jess, { item: 'Mystery box - priceless' })).status, 400);
  assert.equal((await call('POST', `${S()}/cards/${shop.id}/buy`, T.jess, { item: 'Sword' })).status, 404);
  assert.equal((await call('POST', `${S()}/cards/${shop.id}/buy`, T.dm, { item: 'Rope (50 ft)' })).status, 403);
  await ok('POST', `${S()}/cards/${shop.id}/hide`, T.dm);
  assert.equal((await call('POST', `${S()}/cards/${shop.id}/buy`, T.jess, { item: 'Rope (50 ft)' })).status, 404);
  await ok('POST', `${S()}/cards/${shop.id}/show`, T.dm, { to: [ID.jess] });
  assert.equal((await call('POST', `${S()}/cards/${shop.id}/buy`, T.tom, { item: 'Rope (50 ft)' })).status, 404);
  // With approvals off the purchase is immediate.
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { playerChangesNeedApproval: false });
  const r2 = await ok('POST', `${S()}/cards/${shop.id}/buy`, T.jess, { item: 'Rope (50 ft)' });
  assert.equal(r2.pending, false);
  assert.equal((await coin()).cp, 400);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { playerChangesNeedApproval: true });
  await ok('DELETE', `${S()}/cards/${shop.id}`, T.dm);
});

test('TestStage_ImageUploadChecksAndPlayersCannotFetchUnshownImages', async () => {
  // Magic bytes, not the header, decide; SVG and junk are refused.
  assert.equal((await call('POST', `${S()}/images`, T.dm, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), { 'Content-Type': 'image/png' })).status, 400);
  assert.equal((await call('POST', `${S()}/images`, T.dm, Buffer.alloc(4 * 1024 * 1024 + 10, 1), { 'Content-Type': 'image/png' })).status, 413);
  assert.equal((await call('POST', `${S()}/images`, T.jess, PNG, { 'Content-Type': 'image/png' })).status, 403);
  assert.equal((await call('POST', `${S()}/cards`, T.dm, { kind: 'image', ref: 'http://insecure.example/x.png' })).status, 400);
  assert.equal((await call('POST', `${S()}/cards`, T.dm, { kind: 'image', ref: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', `${S()}/cards`, T.dm, { kind: 'image', ref: 'stg_nope' })).status, 400);
  const up = await call('POST', `${S()}/images`, T.dm, PNG, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 201);
  const img = up.body.id;
  const via = await call('POST', `${S()}/images`, T.dm, { dataBase64: PNG.toString('base64') });
  assert.equal(via.status, 201);

  const c = await add({ kind: 'image', ref: img, caption: 'The old map' });
  // Staged: players cannot fetch it directly, and the DM's own ticket works.
  assert.equal((await call('GET', `${S()}/images/${img}`, T.jess)).status, 404);
  const dmUrl = (await stage(T.dm)).cards.find((x: any) => x.id === c.id).data.url as string;
  assert.ok(dmUrl.startsWith('/api/media/stage/'));
  const got = await call('GET', dmUrl);
  assert.equal(got.status, 200);
  assert.deepEqual(got.buf, PNG);

  // A ticket minted for Jess while the card is shown stops working once it is hidden.
  await ok('POST', `${S()}/cards/${c.id}/show`, T.dm, { to: [ID.jess] });
  const jessUrl = (await stage(T.jess)).cards[0].data.url as string;
  assert.equal((await call('GET', jessUrl)).status, 200);
  assert.equal((await call('GET', `${S()}/images/${img}`, T.jess)).status, 200);
  assert.equal((await call('GET', `${S()}/images/${img}`, T.tom)).status, 404);
  assert.equal((await call('GET', dmUrl.replace(/\.[^.]*$/, '.AAAA'))).status, 404, 'a forged ticket is refused');
  await ok('POST', `${S()}/cards/${c.id}/hide`, T.dm);
  assert.equal((await call('GET', jessUrl)).status, 404);
  assert.equal((await call('GET', `${S()}/images/${img}`, T.jess)).status, 404);
  // An https link card needs no upload.
  const link = await add({ kind: 'image', ref: 'https://example.com/map.jpg', show: true });
  assert.equal((await stage(T.tom)).cards.find((x: any) => x.id === link.id).data.url, 'https://example.com/map.jpg');
  for (const x of [c, link]) await ok('DELETE', `${S()}/cards/${x.id}`, T.dm);
});

test('TestStage_LayoutSpotlightAndGeometry', async () => {
  const a = await add({ kind: 'text', text: 'a', show: true });
  const b = await add({ kind: 'text', text: 'b' });
  await ok('PUT', `${S()}/layout`, T.dm, { layout: 'spotlight', spotlightId: a.id });
  let v = await stage(T.jess);
  assert.equal(v.layout, 'spotlight');
  assert.equal(v.spotlightId, a.id);
  // A staged card in the spotlight is not announced to players.
  await ok('PUT', `${S()}/layout`, T.dm, { spotlightId: b.id });
  assert.equal((await stage(T.jess)).spotlightId, null);
  assert.equal((await stage(T.dm)).spotlightId, b.id);
  assert.equal((await call('PUT', `${S()}/layout`, T.dm, { layout: 'masonry' })).status, 400);
  assert.equal((await call('PUT', `${S()}/layout`, T.jess, { layout: 'grid' })).status, 403);
  const moved = await ok('PATCH', `${S()}/cards/${a.id}`, T.dm, { x: 10, y: 20, w: 2, h: 3, raise: true });
  assert.deepEqual([moved.x, moved.y, moved.w, moved.h], [10, 20, 2, 3]);
  assert.ok(moved.z > b.z);
  assert.equal((await call('PATCH', `${S()}/cards/${a.id}`, T.dm, { w: 5000 })).status, 400);
  v = await stage(T.jess);
  await ok('PUT', `${S()}/layout`, T.dm, { layout: 'grid' });
  for (const x of [a, b]) await ok('DELETE', `${S()}/cards/${x.id}`, T.dm);
  assert.equal((await stage(T.dm)).spotlightId, null);
});

test('TestStage_EventCountdownAndMcpTools', async () => {
  assert.equal((await call('POST', `${S()}/cards`, T.dm, { kind: 'event', text: 'no title' })).status, 400);
  const e = await add({ kind: 'event', title: 'The bridge collapses!', text: 'Stone and dust.', countdownSec: 60 });
  assert.equal((await stage(T.dm)).cards.find((x: any) => x.id === e.id).data.endsAt, null, 'the clock starts when it is shown');
  await ok('POST', `${S()}/cards/${e.id}/show`, T.dm, { spotlight: true });
  const seen = (await stage(T.jess)).cards[0];
  assert.equal(seen.data.title, 'The bridge collapses!');
  assert.ok(Date.parse(seen.data.endsAt) > Date.now());
  await ok('DELETE', `${S()}/cards/${e.id}`, T.dm);

  const { default: feature } = await import('../src/features/stage/index.ts');
  const names = feature.mcpTools!.map((t) => t.name);
  assert.deepEqual(names, ['get_stage', 'show_on_stage', 'hide_stage_card']);
  const call2 = feature.mcpTools!.find((t) => t.name === 'show_on_stage')!.call({ kind: 'place', ref: P.npcPage, spotlight: true });
  assert.equal(call2.path, '/stage/cards');
  const made = await ok('POST', `${S()}/cards`, T.dm, call2.body);
  assert.equal(made.visibility, 'all');
  assert.equal((await stage(T.jess)).spotlightId, made.id);
  await ok('DELETE', `${S()}/cards/${made.id}`, T.dm);
});

test('TestStage_LiveEventsAreFilteredPerPlayer', async () => {
  const listen = async (tok: string) => {
    const ac = new AbortController();
    const r = await fetch(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${tok}` }, signal: ac.signal });
    const reader = r.body!.getReader();
    let text = '';
    const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } } catch { /* aborted */ } })();
    return { text: () => text, stop: async () => { ac.abort(); await pump; } };
  };
  const jess = await listen(T.jess);
  const tom = await listen(T.tom);
  const dm = await listen(T.dm);
  await new Promise((r) => setTimeout(r, 100));
  const staged = await add({ kind: 'text', title: 'Prep', text: 'Staged only SECRETPLAN' });
  const whisper = await add({ kind: 'text', title: 'Psst', text: 'For Jess WHISPER', to: [ID.jess] });
  await new Promise((r) => setTimeout(r, 200));
  const events = (t: string) => t.split('\n\n').filter((e) => e.startsWith('event: stage'));
  assert.ok(events(jess.text()).some((e) => e.includes('WHISPER')), 'jess is told');
  assert.ok(!jess.text().includes('SECRETPLAN'), 'jess never sees staged text');
  assert.ok(!tom.text().includes('WHISPER') && !tom.text().includes('SECRETPLAN'), 'tom sees neither');
  assert.ok(dm.text().includes('SECRETPLAN') && dm.text().includes('WHISPER'));
  await ok('POST', `${S()}/cards/${whisper.id}/hide`, T.dm);
  await new Promise((r) => setTimeout(r, 150));
  const last = events(jess.text()).pop()!;
  assert.ok(!last.includes('WHISPER'), 'hiding is pushed to jess');
  await jess.stop(); await tom.stop(); await dm.stop();
  for (const x of [staged, whisper]) await ok('DELETE', `${S()}/cards/${x.id}`, T.dm);
});
