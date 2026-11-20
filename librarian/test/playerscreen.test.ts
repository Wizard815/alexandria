// The players' screen: the endpoint builds the player view even for a DM
// token (a DM-only card, page, person or foe never reaches it), media writes
// are DM-only, hidden media never reaches players or the screen, YouTube
// links are validated, library pictures are served only while players could
// open them, and the slideshow clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import feature, { embedUrl, tick, youtubeId } from '../src/features/playerscreen/index.ts';

let base = '';
let server: any;
let deps: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const SC = () => `/api/worlds/${W}/screen`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
const upload = async (name: string, query: Record<string, string>) => {
  const q = new URLSearchParams({ name, ...query });
  const r = await call('POST', `/api/worlds/${W}/files?${q}`, T.dm, PNG);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const screen = (tok: string) => ok('GET', `${SC()}/players`, tok);
const dmMedia = () => ok('GET', `${SC()}/media`, T.dm);
const addYt = (id = 'dQw4w9WgXcQ', extra: Record<string, unknown> = {}) => ok('POST', `${SC()}/media/items`, T.dm, { kind: 'youtube', url: `https://youtu.be/${id}`, ...extra });
const wipe = () => ok('POST', `${SC()}/media/clear`, T.dm, {});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-pscreen-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Screenland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
});

after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TestPlayerScreen_YoutubeLinksAreValidated', () => {
  const id = 'dQw4w9WgXcQ';
  for (const good of [`https://www.youtube.com/watch?v=${id}`, `https://youtube.com/watch?v=${id}&t=5s`, `https://m.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=x`, `youtu.be/${id}`,
    `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube-nocookie.com/embed/${id}`, id]) assert.equal(youtubeId(good), id, good);
  for (const bad of ['', 'hello', 'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', 'https://evil.com/?u=youtube.com&v=dQw4w9WgXcQ',
    'javascript:alert(1)', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/watch?v="><script>', 'https://www.youtube.com/', 'https://vimeo.com/123456789', 'ftp://youtu.be/dQw4w9WgXcQ', 'data:text/html,dQw4w9WgXcQ', null, 42]) {
    assert.equal(youtubeId(bad as any), null, String(bad));
  }
  assert.equal(embedUrl(id), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
});

test('TestPlayerScreen_RouteRefusesBadYoutubeLinks', async () => {
  for (const url of ['https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=nope', 'javascript:alert(1)']) {
    assert.equal((await call('POST', `${SC()}/media/items`, T.dm, { kind: 'youtube', url })).status, 400, url);
  }
  assert.equal((await call('POST', `${SC()}/media/items`, T.dm, { kind: 'video', ref: 'lf_x' })).status, 400);
  assert.equal((await dmMedia()).items.length, 0);
  // Only the 11-character id is stored and embedded.
  const m = await addYt('dQw4w9WgXcQ', { play: true });
  assert.equal(m.items[0].ref, 'dQw4w9WgXcQ');
  const s = await screen(T.jess);
  assert.equal(s.media.current.embed, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
  await wipe();
});

test('TestPlayerScreen_WritesAreDMOnly', async () => {
  const m = await addYt();
  const iid = m.items[0].id;
  const writes: [string, string, unknown][] = [
    ['POST', '/media/items', { kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }], ['PATCH', `/media/items/${iid}`, { hidden: true }], ['DELETE', `/media/items/${iid}`, undefined],
    ['PUT', '/media/order', { ids: [iid] }], ['POST', '/media/folder', { folder: '' }], ['PUT', '/media', { mode: 'queue' }], ['POST', '/media/focus', { id: iid }],
    ['POST', '/media/next', {}], ['POST', '/media/previous', {}], ['POST', '/media/clear', {}],
  ];
  for (const [method, p, body] of writes) assert.equal((await call(method, SC() + p, T.jess, body)).status, 403, `${method} ${p}`);
  assert.equal((await call('GET', `${SC()}/media`, T.jess)).status, 403);
  assert.equal((await call('GET', `${SC()}/media/sources`, T.jess)).status, 403);
  assert.equal((await call('POST', `${SC()}/media/clear`, undefined, {})).status, 401);
  assert.equal((await dmMedia()).items.length, 1, 'the refused writes changed nothing');
  await wipe();
});

test('TestPlayerScreen_DMOnlyCardsAndPagesNeverReachTheScreen', async () => {
  const S = `/api/worlds/${W}/stage`;
  const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
  const open = await page('places/Harbour', 'party', '# Harbour\nGulls and rope.\n\n> [!secret] DM\n> The Sunken Crown is under pier nine.\n');
  const closed = await page('dm/Vault', 'dm', '# Vault\nSunken Crown vault plans.\n');
  const npc = (await ok('POST', `/api/worlds/${W}/people`, T.dm, { name: 'Hidden Duke', role: 'Villain', visibility: 'dm' })).id;
  const add = (b: Record<string, unknown>) => ok('POST', `${S}/cards`, T.dm, b);
  // Staged for the DM only (never shown), shown to one player only, and shown to everyone.
  await add({ kind: 'text', title: 'STAGED-ONLY', text: 'staged-secret-1' });
  await add({ kind: 'text', title: 'ONE-PLAYER', text: 'whisper-secret-2', to: [ID.jess] });
  await add({ kind: 'place', ref: closed });
  await add({ kind: 'person', ref: npc });
  const shown = await add({ kind: 'text', title: 'For everyone', text: 'The bridge is out.', show: true });
  const place = await add({ kind: 'place', ref: open, show: true, spotlight: true });
  // A DM-only page and person cannot even be shown (the stage refuses), so nothing leaks that way either.
  assert.equal((await call('POST', `${S}/cards`, T.dm, { kind: 'place', ref: closed, show: true })).status, 409);
  assert.equal((await call('POST', `${S}/cards`, T.dm, { kind: 'person', ref: npc, show: true })).status, 409);
  // A foe in hiding and the DM-only numbers of a visible one.
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Goblin', initiative: 12, hp: 4, maxHp: 10, ac: 15 });
  await ok('POST', `/api/worlds/${W}/live/combatants`, T.dm, { name: 'Lurking Assassin', initiative: 18, hp: 30, maxHp: 30, hidden: true, ac: 17 });
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true });

  for (const mode of ['words', 'none', 'exact']) {
    await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { monsterHealth: mode });
    const forDm = await screen(T.dm);
    const forPlayer = await screen(T.jess);
    // The DM's token gets exactly what a player's gets.
    assert.deepEqual(forDm.stage, forPlayer.stage, `DM token gets the player view (${mode})`);
    for (const view of [forDm, forPlayer]) {
      const s = JSON.stringify(view);
      for (const bad of ['STAGED-ONLY', 'staged-secret-1', 'ONE-PLAYER', 'whisper-secret-2', 'Sunken Crown', 'Vault', 'Hidden Duke', 'Lurking', '"ac"', '"temp_hp"', 'concentration', '"hidden"', 'dm_note']) assert.ok(!s.includes(bad), `screen leaked ${bad} (${mode}): ${s.slice(0, 400)}`);
      assert.deepEqual(view.stage.cards.map((c: any) => c.id).sort(), [shown.id, place.id].sort());
      assert.equal(view.stage.spotlightId, place.id);
      const gob = view.stage.combat.combatants.find((x: any) => x.name === 'Goblin');
      if (mode === 'none') assert.equal(gob.health, null); else assert.ok(gob.health, 'monster health follows the setting');
      if (mode === 'exact') assert.equal(gob.health, '4/10');
      assert.equal(view.stage.monsterHealth, mode);
    }
  }
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { monsterHealth: 'words' });
  // Nothing about combat while no fight is on.
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: false });
  assert.equal((await screen(T.dm)).stage.combat, null);
  // Taking a card off the board takes it off the screen; the combat card is not repeated among the cards.
  await ok('POST', `${S}/cards/${shown.id}/hide`, T.dm);
  assert.deepEqual((await screen(T.dm)).stage.cards.map((c: any) => c.id), [place.id]);
  await ok('PUT', `/api/worlds/${W}/live/combat`, T.dm, { active: true });
  await add({ kind: 'combat', show: true });
  assert.ok((await screen(T.dm)).stage.cards.every((c: any) => c.kind !== 'combat'));
});

test('TestPlayerScreen_HiddenMediaIsNeverSent', async () => {
  const a = (await addYt('aaaaaaaaaaa', { title: 'Secret reveal' })).items[0].id;
  const b = (await addYt('bbbbbbbbbbb', { title: 'Opening scene' })).items[1].id;
  await ok('PUT', `${SC()}/media`, T.dm, { mode: 'queue' });
  const m1 = await ok('POST', `${SC()}/media/focus`, T.dm, { id: b });
  assert.equal(m1.focusId, b);
  await ok('POST', `${SC()}/media/focus`, T.dm, { id: null });
  // Hiding the current item: the screen moves to the next visible one; the hidden one is nowhere in what players get.
  await ok('PATCH', `${SC()}/media/items/${a}`, T.dm, { hidden: true });
  for (const tok of [T.jess, T.dm]) {
    const s = await screen(tok);
    const text = JSON.stringify(s);
    assert.ok(!text.includes('aaaaaaaaaaa') && !text.includes('Secret reveal'), 'hidden item leaked');
    assert.equal(s.media.current.id, b);
    assert.ok(!('items' in s.media), 'the queue itself is not sent, only the current item');
  }
  // The DM still sees and can unhide it.
  const dm = await dmMedia();
  assert.equal(dm.items.find((i: any) => i.id === a).hidden, true);
  // A hidden item cannot be focused.
  assert.equal((await call('POST', `${SC()}/media/focus`, T.dm, { id: a })).status, 409);
  // Mode off: nothing is current.
  await ok('PUT', `${SC()}/media`, T.dm, { mode: 'off' });
  assert.equal((await screen(T.jess)).media.current, null);
  await wipe();
});

test('TestPlayerScreen_LibraryPicturesNeedPartyLevelAndAreRecheckedOnFetch', async () => {
  const open = await upload('torch.png', { level: 'party', folder: 'Handouts', title: 'Torch' });
  const closed = await upload('vault-map.png', { level: 'dm', folder: 'Handouts', title: 'Vault map' });
  const secret = await upload('seal.png', { level: 'classified', folder: 'Handouts', title: 'Seal' });
  // A file players cannot open is refused (fail closed), whatever the DM asks.
  for (const f of [closed, secret]) assert.equal((await call('POST', `${SC()}/media/items`, T.dm, { kind: 'image', ref: f.id })).status, 409);
  assert.equal((await call('POST', `${SC()}/media/items`, T.dm, { kind: 'image', ref: 'lf_nope' })).status, 400);
  assert.equal((await call('POST', `${SC()}/media/items`, T.dm, { kind: 'image', ref: 'stg_nope' })).status, 400);
  const m = await ok('POST', `${SC()}/media/items`, T.dm, { kind: 'image', ref: open.id, play: true });
  const cur = (await screen(T.jess)).media.current;
  assert.equal(cur.kind, 'image');
  const got = await call('GET', cur.url);
  assert.equal(got.status, 200);
  assert.equal(got.buf.length, PNG.length);
  // A hidden item's picture is not served; neither is any picture once the media is off.
  await ok('PATCH', `${SC()}/media/items/${m.items[0].id}`, T.dm, { hidden: true });
  assert.equal((await call('GET', cur.url)).status, 404, 'hidden picture is gone');
  await ok('PATCH', `${SC()}/media/items/${m.items[0].id}`, T.dm, { hidden: false });
  assert.equal((await call('GET', cur.url)).status, 200);
  // The file stops being for players: the ticket stops working at once.
  await ok('PATCH', `/api/worlds/${W}/files/${open.id}`, T.dm, { level: 'dm' });
  assert.equal((await call('GET', cur.url)).status, 404, 'level changed to dm');
  await ok('PATCH', `/api/worlds/${W}/files/${open.id}`, T.dm, { level: 'party' });
  await ok('PUT', `${SC()}/media`, T.dm, { mode: 'off' });
  assert.equal((await call('GET', cur.url)).status, 404, 'media off');
  // A forged ticket is nothing.
  assert.equal((await call('GET', '/api/media/screen/abc.def')).status, 404);
  await wipe();
});

test('TestPlayerScreen_StagePicturesServeWhileShownOrQueued', async () => {
  const S = `/api/worlds/${W}/stage`;
  const up = await ok('POST', `${S}/images`, T.dm, { dataBase64: PNG.toString('base64') });
  const m = await ok('POST', `${SC()}/media/items`, T.dm, { kind: 'image', ref: up.id, play: true });
  const url = (await screen(T.dm)).media.current.url;
  assert.equal((await call('GET', url)).status, 200);
  await ok('DELETE', `${SC()}/media/items/${m.items[0].id}`, T.dm);
  assert.equal((await call('GET', url)).status, 404, 'removed from the queue');
  // On a card shown to everyone it is on the board, and the board's picture url is a screen ticket.
  const card = await ok('POST', `${S}/cards`, T.dm, { kind: 'image', ref: up.id, show: true });
  const boardUrl = (await screen(T.dm)).stage.cards.find((c: any) => c.id === card.id).data.url;
  assert.ok(boardUrl.startsWith('/api/media/screen/'));
  assert.equal((await call('GET', boardUrl)).status, 200);
  await ok('POST', `${S}/cards/${card.id}/hide`, T.dm);
  assert.equal((await call('GET', boardUrl)).status, 404, 'card hidden');
  await ok('DELETE', `${S}/cards/${card.id}`, T.dm);
});

test('TestPlayerScreen_FolderBecomesASlideshowAndSkipsUnsharedPictures', async () => {
  await upload('one.png', { level: 'party', folder: 'Maps/Coast', title: 'Coast one' });
  await upload('two.png', { level: 'party', folder: 'Maps/Coast', title: 'Coast two' });
  await upload('three.png', { level: 'dm', folder: 'Maps/Coast', title: 'Coast three' });
  await upload('dm.png', { level: 'dm', folder: 'Maps/Hidden', title: 'Hidden one' });
  const src = await ok('GET', `${SC()}/media/sources`, T.dm);
  assert.deepEqual(src.folders.find((f: any) => f.folder === 'Maps/Coast'), { folder: 'Maps/Coast', images: 3, shared: 2 });
  const r = await ok('POST', `${SC()}/media/folder`, T.dm, { folder: 'Maps/Coast', intervalSec: 5 });
  assert.equal(r.loaded, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.mode, 'slideshow');
  assert.equal(r.intervalSec, 5);
  assert.equal(r.items.length, 2);
  assert.equal((await call('POST', `${SC()}/media/folder`, T.dm, { folder: 'Maps/Hidden' })).status, 409, 'nothing in it is shared');
  assert.equal((await call('POST', `${SC()}/media/folder`, T.dm, { folder: 'Nowhere' })).status, 404);
  assert.equal((await call('PUT', `${SC()}/media`, T.dm, { intervalSec: 1 })).status, 400);
  await wipe();
});

test('TestPlayerScreen_SlideshowClockNextPreviousLoopAndFocus', async () => {
  const p = await upload('s1.png', { level: 'party', folder: 'Show', title: 'S1' });
  const q = await upload('s2.png', { level: 'party', folder: 'Show', title: 'S2' });
  const r3 = await upload('s3.png', { level: 'party', folder: 'Show', title: 'S3' });
  const loaded = await ok('POST', `${SC()}/media/folder`, T.dm, { folder: 'Show', intervalSec: 3 });
  const [i1, i2, i3] = loaded.items.map((i: any) => i.id);
  assert.deepEqual(loaded.items.map((i: any) => i.ref), [p.id, q.id, r3.id]);
  const cur = async () => (await screen(T.jess)).media.current?.id;
  assert.equal(await cur(), i1);
  // Hide the middle one: the slideshow skips it.
  await ok('PATCH', `${SC()}/media/items/${i2}`, T.dm, { hidden: true });
  const t0 = Date.now() + 10_000;
  assert.equal(tick(deps, Date.now() + 1000), 0, 'interval not up yet');
  assert.equal(tick(deps, t0), 1);
  assert.equal(await cur(), i3);
  assert.equal(tick(deps, t0 + 3000), 1);
  assert.equal(await cur(), i1, 'loops');
  // Paused: the clock does nothing.
  await ok('PUT', `${SC()}/media`, T.dm, { playing: false });
  assert.equal(tick(deps, Date.now() + 999_000), 0);
  // Manual next / previous work while paused.
  await ok('POST', `${SC()}/media/next`, T.dm, {});
  assert.equal(await cur(), i3);
  await ok('POST', `${SC()}/media/previous`, T.dm, {});
  assert.equal(await cur(), i1);
  // Without loop a slideshow stops at the end.
  await ok('PUT', `${SC()}/media`, T.dm, { playing: true, loop: false });
  await ok('POST', `${SC()}/media/next`, T.dm, {});
  await ok('POST', `${SC()}/media/next`, T.dm, {});
  assert.equal(await cur(), i3);
  assert.equal((await dmMedia()).playing, false, 'paused at the end');
  // Focus shows one item only; next/previous are refused; the slideshow clock is off; unfocus restores the mode.
  await ok('PUT', `${SC()}/media`, T.dm, { playing: true, loop: true });
  await ok('POST', `${SC()}/media/focus`, T.dm, { id: i3 });
  assert.equal((await screen(T.jess)).media.mode, 'focus');
  assert.equal(await cur(), i3);
  assert.equal((await call('POST', `${SC()}/media/next`, T.dm, {})).status, 409);
  assert.equal(tick(deps, Date.now() + 999_000), 0);
  await ok('POST', `${SC()}/media/focus`, T.dm, { id: null });
  assert.equal((await screen(T.jess)).media.mode, 'slideshow');
  // Removing the focused item ends the focus; reorder is honoured.
  await ok('POST', `${SC()}/media/focus`, T.dm, { id: i1 });
  await ok('DELETE', `${SC()}/media/items/${i1}`, T.dm);
  assert.equal((await dmMedia()).focusId, null);
  assert.equal((await screen(T.jess)).media.mode, 'slideshow');
  const o = await ok('PUT', `${SC()}/media/order`, T.dm, { ids: [i3, i2] });
  assert.deepEqual(o.items.map((i: any) => i.id), [i3, i2]);
  const c = await ok('POST', `${SC()}/media/clear`, T.dm, {});
  assert.deepEqual([c.items.length, c.mode], [0, 'off']);
});

test('TestPlayerScreen_ShowOneQueuedItemNow', async () => {
  const a = (await addYt('aaaaaaaaaaa')).items[0].id;
  const b = (await addYt('bbbbbbbbbbb')).items[1].id;
  const m = await ok('PUT', `${SC()}/media`, T.dm, { mode: 'queue', currentId: b });
  assert.equal(m.currentId, b);
  assert.equal((await screen(T.jess)).media.current.id, b);
  await ok('PATCH', `${SC()}/media/items/${a}`, T.dm, { hidden: true });
  assert.equal((await call('PUT', `${SC()}/media`, T.dm, { currentId: a })).status, 409, 'a hidden item cannot be shown');
  assert.equal((await call('PUT', `${SC()}/media`, T.dm, { currentId: 'nope' })).status, 404);
  await wipe();
});

test('TestPlayerScreen_AgentToolsAreDMWrites', () => {
  const tools = feature.mcpTools!;
  assert.deepEqual(tools.map((t) => t.name), ['queue_media', 'show_media']);
  assert.ok(tools.every((t) => t.write === true));
  assert.equal(tools[0].call({ url: 'https://youtu.be/dQw4w9WgXcQ', play: true }).path, '/screen/media/items');
  assert.equal(tools[1].call({ action: 'next' }).path, '/screen/media/next');
  assert.deepEqual(tools[1].call({ action: 'unfocus' }).body, { id: null });
});
