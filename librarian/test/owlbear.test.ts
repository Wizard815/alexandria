// Owlbear Rodeo: the link key, which map pictures may go to Owlbear (only what players may see), the fog going out as
// rectangles and coming back as a bitmask, and the extension's own files (framed by Owlbear, manifest with CORS).
// The extension's geometry (web/src/owlbear/geometry.ts) runs here too, so the whole round trip is checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { FOG_GRID, isFogged, type FogState } from '../src/core/fog.ts';
import { initRecords } from '../src/intake/records.ts';
import { fogRects, rectsOf, readMask, stateFromMask } from '../src/features/owlbear/mask.ts';
import { fogOf } from '../src/features/fog/index.ts';
// @ts-ignore: a web file, run here for its pure geometry
import * as geo from '../../web/src/owlbear/geometry.ts';

let base = '', server: any, tmp = '', deps: any, W = '', KEY = '';
const T: Record<string, string> = {};

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

// A 4 × 2 PNG is enough: Owlbear only needs its size and bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEUlEQVR4nGNgYGD4z8DAwMAAAAgAAZ2dN3QAAAAASUVORK5CYII=', 'base64');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-owlbear-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } }) as any;
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dmId = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Owlhold', dmAccountId: dmId })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).token;
  // Two imported maps: the town (its page shared with the players) and the lair (DM only).
  run(deps.db, "INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'push', 'LK', '{}', 'party')", W);
  const at = new Date().toISOString();
  deps.library.saveEntry(W, 's1', null, { externalId: 'town', title: 'Town', type: 'map', blocks: [], visibility: 'party', updatedAt: at }, null);
  deps.library.saveEntry(W, 's1', null, { externalId: 'lair', title: 'Lair', type: 'map', blocks: [], visibility: 'dm', updatedAt: at }, null);
  deps.library.rebuildPlayerCopies(W);
  initRecords(deps.db);
  const img = "INSERT INTO intake_images (id, world_id, source_id, external_id, name, mime, size, data, visibility, page_ref, page_external, at, kind) VALUES (?, ?, 's1', ?, ?, 'image/png', ?, ?, ?, ?, ?, ?, 'map')";
  run(deps.db, img, 'town1', W, 'town#map', 'Town map', PNG.length, PNG, 'party', 'town', 'town', at);
  run(deps.db, img, 'lair1', W, 'lair#map', 'Lair map', PNG.length, PNG, 'party', 'lair', 'lair', at);
});

after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestOwlbear_RectsOf: merges cells into the fewest rows-then-down rectangles', () => {
  const on = new Set(['0,0', '1,0', '0,1', '1,1', '3,1']);
  assert.deepEqual(rectsOf(4, 2, (i, j) => on.has(`${i},${j}`)), [[0, 0, 2, 2], [3, 1, 1, 1]]);
  assert.deepEqual(rectsOf(3, 3, () => true), [[0, 0, 3, 3]]);
  assert.deepEqual(rectsOf(3, 3, () => false), []);
  const s: FogState = { enabled: true, base: null, ops: [{ k: 'r', x: 0, y: 0, w: 0.5, h: 1, v: 1 }] };
  assert.deepEqual(fogRects(s, 10, 4), [[5, 0, 5, 4]], 'the left half revealed: the right half is one rectangle');
  assert.deepEqual(fogRects({ ...s, enabled: false }, 10, 4), [], 'fog off draws nothing');
});

test('TestOwlbear_MaskToStrokes: a bitmask becomes one undoable stroke that reads back the same', () => {
  const bytes = Buffer.alloc((FOG_GRID * FOG_GRID + 7) >> 3);
  // Fog only the top half.
  for (let j = 0; j < FOG_GRID / 2; j++) for (let i = 0; i < FOG_GRID; i++) { const n = j * FOG_GRID + i; bytes[n >> 3] |= 1 << (n & 7); }
  const m = readMask(bytes.toString('base64'))!;
  const s = stateFromMask(m, 7);
  assert.equal(s.ops[0].k, 'all');
  assert.ok(s.ops.every((o) => o.g === 7), 'one stroke');
  assert.ok(isFogged(s, 0.5, 0.2) && !isFogged(s, 0.5, 0.8));
  assert.equal(readMask('nope!'), null);
  assert.equal(readMask(Buffer.alloc(10).toString('base64')), null);
});

test('TestOwlbear_Keys: only the DM makes a key; other keys and sessions are refused', async () => {
  assert.equal((await call('POST', `/api/worlds/${W}/owlbear/key`, T.jess)).status, 403);
  assert.equal((await call('GET', `/api/worlds/${W}/owlbear`, T.jess)).status, 403);
  const st0 = await ok('GET', `/api/worlds/${W}/owlbear`, T.dm);
  assert.equal(st0.key, null);
  assert.match(st0.manifestUrl, /\/owlbear\/manifest\.json$/);
  const first = (await ok('POST', `/api/worlds/${W}/owlbear/key`, T.dm)).key;
  assert.match(first, /^alx_obr_/);
  KEY = (await ok('POST', `/api/worlds/${W}/owlbear/key`, T.dm)).key;
  assert.equal((await call('GET', '/api/owlbear/state', first)).status, 401, 'a replaced key stops working');
  assert.equal((await call('GET', '/api/owlbear/state', 'alx_obr_nope')).status, 401);
  assert.equal((await call('GET', '/api/owlbear/state', T.dm)).status, 401, 'a DM session is not a link key');
  assert.equal((await call('GET', '/api/owlbear/state')).status, 401);
});

test('TestOwlbear_Pictures: only what players may see goes to Owlbear; the table screen is followed', async () => {
  const h = await ok('GET', '/api/owlbear/hello?room=r1&player=Wiz', KEY);
  assert.equal(h.world.name, 'Owlhold');
  assert.deepEqual(h.pictures.map((p: any) => p.value), ['imp:town1'], 'the DM-only lair is not offered');
  assert.equal(h.link.follow, true);
  assert.equal(h.target.pic, null);
  // The DM puts the lair on the table screen: Owlbear shows nothing and says why.
  await ok('PUT', `/api/worlds/${W}/fog/table`, T.dm, { mapId: 'world', pic: 'imp:lair1' });
  let st = await ok('GET', '/api/owlbear/state', KEY);
  assert.equal(st.target.pic, null);
  assert.equal(st.target.hidden, true);
  assert.equal((await call('PUT', '/api/owlbear/link', KEY, { follow: false, pic: 'imp:lair1' })).status, 400);
  // The town on the table screen: Owlbear follows.
  await ok('PUT', `/api/worlds/${W}/fog/table`, T.dm, { mapId: 'world', pic: 'imp:town1' });
  st = await ok('GET', '/api/owlbear/state', KEY);
  assert.equal(st.target.pic, 'imp:town1');
  assert.match(st.target.url, /^\/api\/owlbear\/pic\/[^/]+\/imp%3Atown1$/);
  // The picture: served with CORS for Owlbear, no sign-in; never a DM-only one, never with a wrong secret.
  const pic = await fetch(base + st.target.url);
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await pic.arrayBuffer()), PNG);
  assert.equal((await fetch(base + st.target.url.replace('imp%3Atown1', 'imp%3Alair1'))).status, 404);
  assert.equal((await fetch(base + st.target.url.replace(/pic\/[^/]+/, 'pic/wrong'))).status, 404);
  // The DM page sees the extension as connected, with the room's GM.
  const dmSt = await ok('GET', `/api/worlds/${W}/owlbear`, T.dm);
  assert.equal(dmSt.online, true);
  assert.equal(dmSt.player, 'Wiz');
  assert.equal(dmSt.target.pic, 'imp:town1');
  // Unsharing the town's page takes it off Owlbear at once.
  run(deps.db, "UPDATE pages SET visibility = 'dm' WHERE external_id = 'town'"); deps.library.rebuildPlayerCopies(W);
  assert.equal((await fetch(base + st.target.url)).status, 404);
  assert.equal((await ok('GET', '/api/owlbear/state', KEY)).target.pic, null);
  run(deps.db, "UPDATE pages SET visibility = 'party' WHERE external_id = 'town'"); deps.library.rebuildPlayerCopies(W);
});

test('TestOwlbear_FogRoundTrip: Alexandria fog out as a path, Owlbear fog back as strokes', async () => {
  // Alexandria leads: fog on, a circle revealed in the middle.
  await ok('PUT', `/api/worlds/${W}/fog/map/world/enabled`, T.dm, { pic: 'imp:town1', enabled: true });
  await ok('POST', `/api/worlds/${W}/fog/map/world/ops`, T.dm, { pic: 'imp:town1', op: { k: 'c', x: 0.5, y: 0.5, r: 0.2, v: 1 } });
  const st = await ok('GET', '/api/owlbear/state', KEY);
  assert.equal(st.fog.enabled, true);
  const cells = await ok('GET', '/api/owlbear/fog?cols=120&rows=60', KEY);
  assert.equal(cells.cols, 120);
  assert.ok(cells.rects.length > 4);
  const inRect = (u: number, v: number) => cells.rects.some(([x, y, w, h]: number[]) => u * 120 >= x && u * 120 < x + w && v * 60 >= y && v * 60 < y + h);
  assert.ok(inRect(0.05, 0.05) && !inRect(0.5, 0.5), 'corner fogged, centre clear');

  // The extension draws it as a path on a picture placed at (300, 200), scaled 2×, 2000 × 1000 px at 100 dpi in a 150 dpi scene.
  const pic = { position: { x: 300, y: 200 }, rotation: 0, scale: { x: 2, y: 2 }, image: { width: 2000, height: 1000, mime: 'image/png', url: '' }, grid: { dpi: 100, offset: { x: 0, y: 0 } } };
  const f = geo.frameOf(pic, 150);
  const commands = geo.rectCommands(cells.rects, cells.cols, cells.rows, f);
  const path = { type: 'PATH', layer: 'FOG', visible: true, position: pic.position, rotation: 0, scale: pic.scale, commands, fillRule: 'nonzero', metadata: {} };
  // Read back the way Owlbear-leads mode reads Owlbear's fog: the same fog, cell for cell (up to the grids' rounding).
  const mask = geo.fogMask([path], pic, 150);
  const back = stateFromMask(readMask(mask)!, 1);
  const orig = fogOf(deps, W, 'world', 'imp:town1');
  let wrong = 0;
  for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) { const u = (i + 0.5) / 40, v = (j + 0.5) / 40; if (isFogged(back, u, v) !== isFogged(orig, u, v)) wrong++; }
  assert.ok(wrong <= 40, `${wrong} of 1600 samples differ`);

  // Owlbear leads only when switched: until then a push is refused.
  assert.equal((await call('PUT', '/api/owlbear/fog', KEY, { mask })).status, 409);
  await ok('PUT', '/api/owlbear/link', KEY, { lead: 'owlbear' });
  // The GM reveals the left half with an Owlbear rectangle cut into a fogged picture (an even-odd path with a hole).
  const W2 = 2000 * 1.5, H2 = 1000 * 1.5; // the picture's local units (k = 1.5)
  const cut = { type: 'PATH', layer: 'FOG', visible: true, position: pic.position, rotation: 0, scale: pic.scale, fillRule: 'evenodd', metadata: {},
    commands: [[0, 0, 0], [1, W2, 0], [1, W2, H2], [1, 0, H2], [5], [0, 0, 0], [1, W2 / 2, 0], [1, W2 / 2, H2], [1, 0, H2], [5]] };
  const left = geo.fogMask([cut], pic, 150);
  const v = (await ok('PUT', '/api/owlbear/fog', KEY, { mask: left })).version;
  const now = fogOf(deps, W, 'world', 'imp:town1');
  assert.equal(now.version, v);
  assert.ok(!isFogged(now, 0.2, 0.5) && isFogged(now, 0.8, 0.5) && isFogged(now, 0.6, 0.1));
  // A player's map marks follow: under Owlbear's fog, a party pin is not sent.
  await ok('POST', `/api/worlds/${W}/map/world/marks`, T.dm, { kind: 'pin', x: 80, y: 50, label: 'Hidden inn', visibility: 'party' });
  await ok('POST', `/api/worlds/${W}/map/world/marks`, T.dm, { kind: 'pin', x: 20, y: 50, label: 'Open gate', visibility: 'party' });
  assert.deepEqual((await ok('GET', `/api/worlds/${W}/map/world/marks`, T.jess)).map((m: any) => m.data.label), ['Open gate']);
  // The whole push is one stroke: one undo on Alexandria's side takes it back.
  await ok('POST', `/api/worlds/${W}/fog/map/world/undo`, T.dm, { pic: 'imp:town1' });
  const undone = fogOf(deps, W, 'world', 'imp:town1');
  assert.ok(isFogged(undone, 0.05, 0.05) && !isFogged(undone, 0.5, 0.5), 'back to the circle');
  await ok('PUT', '/api/owlbear/link', KEY, { lead: 'alexandria' });
});

test('TestOwlbear_Geometry: Owlbear shapes, transforms and fill rules read as Owlbear draws them', () => {
  const pic = { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, image: { width: 960, height: 960, mime: 'image/png', url: '' }, grid: { dpi: 150, offset: { x: 0, y: 0 } } };
  const has = (mask: string, u: number, v: number) => { const b = Buffer.from(mask, 'base64'); const n = Math.floor(v * 96) * 96 + Math.floor(u * 96); return (b[n >> 3] & (1 << (n & 7))) !== 0; };
  // A rectangle shape from its corner, a circle from its centre, a rotated rectangle.
  const rect = { type: 'SHAPE', shapeType: 'RECTANGLE', width: 480, height: 480, position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, visible: true, metadata: {} };
  let m = geo.fogMask([rect], pic, 150);
  assert.ok(has(m, 0.25, 0.25) && !has(m, 0.75, 0.75));
  const circle = { ...rect, shapeType: 'CIRCLE', width: 200, height: 200, position: { x: 720, y: 720 } };
  m = geo.fogMask([circle], pic, 150);
  assert.ok(has(m, 0.75, 0.75) && !has(m, 0.9, 0.9) && !has(m, 0.25, 0.25));
  const turned = { ...rect, width: 960, height: 100, position: { x: 480, y: 0 }, rotation: 90 };
  m = geo.fogMask([turned], pic, 150);
  assert.ok(has(m, 0.47, 0.5) && !has(m, 0.55, 0.5), 'rotated 90°: a strip running down, left of x = 480');
  // Hidden fog does not count; a curve is a polygon.
  assert.ok(!has(geo.fogMask([{ ...rect, visible: false }], pic, 150), 0.25, 0.25));
  const tri = { type: 'CURVE', points: [{ x: 0, y: 0 }, { x: 960, y: 0 }, { x: 0, y: 960 }], position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 }, visible: true, metadata: {}, style: { closed: true } };
  m = geo.fogMask([tri], pic, 150);
  assert.ok(has(m, 0.2, 0.2) && !has(m, 0.8, 0.8));
  // A picture moved and scaled in Owlbear: the fog shape is read in the picture's frame.
  const moved = { ...pic, position: { x: 1000, y: 0 }, scale: { x: 0.5, y: 0.5 } };
  const over = { ...rect, width: 240, height: 480, position: { x: 1000, y: 0 } };
  m = geo.fogMask([over], moved, 150);
  assert.ok(has(m, 0.4, 0.5) && !has(m, 0.6, 0.5), 'covers the left half of the half-size picture');
  // Picture-local units round trip.
  const f = geo.frameOf({ image: { width: 1000, height: 500 }, grid: { dpi: 100, offset: { x: 50, y: 0 } } } as any, 150);
  const p = geo.toLocal(f, 0.3, 0.6);
  assert.deepEqual(geo.toUnit(f, p), { x: 0.3, y: 0.6 });
});

test('TestOwlbear_ExtensionFiles: the manifest with CORS; only the extension pages may be framed by Owlbear', async () => {
  const r = await call('GET', '/owlbear/manifest.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.equal(r.body.manifest_version, 1);
  assert.equal(r.body.action.popover, '/owlbear/popover.html');
  assert.equal(r.body.background_url, '/owlbear/background.html');
  const icon = await fetch(base + '/owlbear/icon.svg');
  assert.equal(icon.headers.get('access-control-allow-origin'), '*');
  assert.match(icon.headers.get('content-type') ?? '', /svg/);
  // No built web app in this test: the page itself is a 404, but its headers already allow Owlbear to frame it.
  const pg = await fetch(base + '/owlbear/popover.html');
  assert.equal(pg.headers.get('x-frame-options'), null);
  assert.match(pg.headers.get('content-security-policy') ?? '', /frame-ancestors https:\/\/www\.owlbear\.rodeo/);
  const other = await fetch(base + '/api/owlbear/state');
  assert.equal(other.headers.get('x-frame-options'), 'DENY', 'everything else stays unframeable');
});
