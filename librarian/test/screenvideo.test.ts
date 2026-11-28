// Video in the library and on the players' screen: sniffing, streamed uploads
// with their own limit, Range responses, video items, the "ended" report
// rules, mixed folders, GM-only files shown by the GM's choice, and sharing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';
import { sniffFile } from '../src/features/libfiles/sniff.ts';
import { tick } from '../src/features/playerscreen/index.ts';

let base = '';
let server: any;
let deps: any;
let tmp = '';
let W = '';
const T: Record<string, string> = {};
const SC = () => `/api/worlds/${W}/screen`;
const MB = 1024 * 1024;

const box = (brand: string, compat: string[], size: number) => {
  const head = Buffer.alloc(16 + compat.length * 4);
  head.writeUInt32BE(head.length, 0);
  head.write('ftyp', 4, 'latin1');
  head.write(brand, 8, 'latin1');
  compat.forEach((c, i) => head.write(c, 16 + i * 4, 'latin1'));
  const body = Buffer.alloc(Math.max(0, size - head.length));
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 255;
  return Buffer.concat([head, body]);
};
const mp4 = (size = 5000) => box('isom', ['isom', 'iso2', 'mp41'], size);
const mov = (size = 5000) => box('qt  ', ['qt  '], size);
const webm = (size = 5000) => {
  const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...Buffer.from('webm')]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 3)]);
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)]);

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { json = null; }
  return { status: r.status, body: json, buf, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const upload = async (name: string, query: Record<string, string>, bytes: Buffer, expect = 201) => {
  const r = await call('POST', `/api/worlds/${W}/files?${new URLSearchParams({ name, ...query })}`, T.gm, bytes);
  assert.equal(r.status, expect, JSON.stringify(r.body));
  return r.body;
};
const screen = (tok: string) => ok('GET', `${SC()}/players`, tok);
const wipe = () => ok('POST', `${SC()}/media/clear`, T.gm, {});
const addFile = (ref: string, extra: Record<string, unknown> = {}) => ok('POST', `${SC()}/media/items`, T.gm, { kind: 'video', ref, ...extra });
const backdate = () => run(deps.db, 'UPDATE screen_media SET advanced_at = advanced_at - 60000');
const incoming = () => { try { return fs.readdirSync(path.join(tmp, 'data', 'libfiles', '.incoming')); } catch { return []; } };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-svideo-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_LIBFILE_MAX_MB: '1', ALX_LIBFILE_VIDEO_MAX_MB: '8' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const gm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'gm password 123' });
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Videoland', gmAccountId: gm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'jess' })).token;
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('TestVideo_SniffAcceptsMp4WebmMovAndStillRefusesRenamedPrograms', () => {
  assert.deepEqual(sniffFile(mp4(), 'a.bin'), { mime: 'video/mp4', ext: 'mp4', family: 'video' });
  assert.equal((sniffFile(webm(), 'clip') as any).mime, 'video/webm');
  assert.equal((sniffFile(mov(), 'clip.mov') as any).mime, 'video/quicktime');
  // The name is not the type: a program called .mp4, HTML called .webm, and a name that is itself refused.
  for (const [b, n] of [[Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]), 'movie.mp4'], [Buffer.from('<html><body>hi</body></html>'), 'movie.webm'], [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'a.mov'], [mp4(), 'movie.exe'], [mp4(), 'movie.html']] as const) {
    assert.ok('error' in sniffFile(b, n), n);
  }
  // A still picture in an ftyp box (HEIC) and a Matroska file that is not WebM are not videos.
  assert.ok('error' in sniffFile(box('heic', ['mif1', 'heic'], 200), 'a.heic'));
  assert.ok('error' in sniffFile(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88]), Buffer.from('matroska'), Buffer.alloc(40)]), 'a.mkv'));
});

test('TestVideo_UploadIsStreamedWithItsOwnLimitAndImagesKeepTheirs', async () => {
  const pg = await ok('PUT', `/api/worlds/${W}/library/pages`, T.gm, { path: 'lore/Clips.md', visibility: 'party', body: 'clips' });
  const q = { page: pg.id, level: 'party' };
  // 3 MB is over the 1 MB picture limit and fine for a video.
  const big = mp4(3 * MB);
  const f = await upload('intro.mp4', q, big);
  assert.equal([f.family, f.mime, f.size].join(), `video,video/mp4,${big.length}`);
  const got = await call('GET', f.url);
  assert.equal(got.status, 200);
  assert.ok(got.buf.equals(big), 'bytes are stored as sent');
  assert.equal(got.headers.get('content-type'), 'video/mp4');
  assert.equal(got.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(incoming(), [], 'no temp file left');
  // A picture of the same size still hits the picture limit; a video over the video limit is refused and leaves nothing.
  await upload('big.png', q, Buffer.concat([PNG, Buffer.alloc(MB)]), 413);
  await upload('huge.mp4', q, mp4(9 * MB), 413);
  assert.deepEqual(incoming(), []);
  assert.equal((await ok('GET', `/api/worlds/${W}/files?page=${pg.id}`, T.gm)).videoMax, 8 * MB);
  // A text file with a video name is not let in by the video path; players cannot upload.
  await upload('lie.mp4', q, Buffer.from('hello there, not a video at all'), 415);
  const pl = await call('POST', `/api/worlds/${W}/files?name=a.mp4&page=${pg.id}`, T.jess, mp4());
  assert.equal(pl.status, 403);
  assert.equal((await call('POST', `/api/worlds/${W}/files?name=a.mp4&page=${pg.id}&kind=map`, T.gm, mp4())).status, 400, 'a map must be a picture');
  assert.equal((await call('POST', `/api/worlds/${W}/files?name=a.mp4&page=${pg.id}&send=x`, T.gm, mp4())).status, 400, 'videos are not sent to sources');
});

test('TestVideo_AnAbortedUploadLeavesNoFile', async () => {
  const before = fs.existsSync(path.join(tmp, 'data', 'libfiles', W)) ? fs.readdirSync(path.join(tmp, 'data', 'libfiles', W)).length : 0;
  await new Promise<void>((resolve) => {
    const req = http.request(`${base}/api/worlds/${W}/files?name=cut.mp4&folder=Cut&title=Cut`, { method: 'POST', headers: { Authorization: `Bearer ${T.gm}`, 'Content-Length': String(4 * MB), 'Content-Type': 'application/octet-stream' } });
    req.on('error', () => {});
    req.write(mp4(600 * 1024));
    setTimeout(() => { req.destroy(); resolve(); }, 200);
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(incoming(), [], 'temp file cleaned up');
  const after = fs.existsSync(path.join(tmp, 'data', 'libfiles', W)) ? fs.readdirSync(path.join(tmp, 'data', 'libfiles', W)).length : 0;
  assert.equal(after, before);
  const pages = await ok('GET', `/api/worlds/${W}/library/pages`, T.gm);
  assert.ok(!JSON.stringify(pages).includes('Cut.md'), 'no file page was made for the aborted upload');
});

test('TestVideo_RangeRequestsAnswer206WithTheRightBytes', async () => {
  const bytes = mp4(100_000);
  const f = await upload('seek.mp4', { folder: 'Range', title: 'Seek', level: 'party' }, bytes);
  const range = (url: string, h: string) => call('GET', url, undefined, undefined, { Range: h });
  const check = async (url: string) => {
    let r = await range(url, 'bytes=10-19');
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 10-19/100000');
    assert.equal(r.headers.get('content-length'), '10');
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.ok(r.buf.equals(bytes.subarray(10, 20)));
    r = await range(url, 'bytes=99990-');
    assert.equal(r.status, 206);
    assert.ok(r.buf.equals(bytes.subarray(99990)));
    r = await range(url, 'bytes=-5');
    assert.equal(r.status, 206);
    assert.ok(r.buf.equals(bytes.subarray(99995)));
    r = await range(url, 'bytes=50000-999999999');
    assert.equal(r.headers.get('content-range'), 'bytes 50000-99999/100000');
    r = await range(url, 'bytes=100000-100010');
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */100000');
    assert.equal((await call('GET', url)).status, 200);
  };
  await check(f.url);
  // The same from the screen's ticket route, while the item is in the media.
  await addFile(f.id, { play: true });
  const url = (await screen(T.jess)).media.current.url;
  await check(url);
  await wipe();
});

test('TestVideo_VideoItemsHiddenNeverSentAndPlayersCannotAdd', async () => {
  const f = await upload('hid.mp4', { folder: 'Items', title: 'Hid', level: 'party' }, mp4());
  assert.equal((await call('POST', `${SC()}/media/items`, T.jess, { kind: 'video', ref: f.id })).status, 403);
  assert.equal((await call('POST', `${SC()}/media/items`, T.gm, { kind: 'video', ref: 'lf_nope' })).status, 400);
  const png = await upload('pic.png', { folder: 'Items', title: 'Pic', level: 'party' }, PNG);
  assert.equal((await call('POST', `${SC()}/media/items`, T.gm, { kind: 'video', ref: png.id })).status, 400, 'a picture is not a video');
  const m = await addFile(f.id, { play: true, sound: false, playSecs: 30 });
  const item = m.items[0];
  assert.deepEqual([item.kind, item.sound, item.playSecs, item.loopVideo], ['video', false, 30, false]);
  const cur = (await screen(T.jess)).media.current;
  assert.deepEqual([cur.kind, cur.sound, cur.playSecs, cur.loop], ['video', false, 30, false]);
  assert.equal((await call('GET', cur.url)).status, 200);
  assert.equal((await call('PATCH', `${SC()}/media/items/${item.id}`, T.jess, { sound: true })).status, 403);
  assert.equal((await call('PATCH', `${SC()}/media/items/${item.id}`, T.gm, { playSecs: 1 })).status, 400);
  await ok('PATCH', `${SC()}/media/items/${item.id}`, T.gm, { hidden: true });
  const s = await screen(T.jess);
  assert.equal(s.media.current, null, 'hidden: not sent');
  assert.ok(!JSON.stringify(s).includes(f.id) && !JSON.stringify(s).includes(item.id));
  assert.equal((await call('GET', cur.url)).status, 404, 'hidden: not served');
  // Sound, play time and loop belong to videos only.
  const img = await ok('POST', `${SC()}/media/items`, T.gm, { kind: 'image', ref: png.id });
  assert.equal((await call('PATCH', `${SC()}/media/items/${img.items[1].id}`, T.gm, { loopVideo: true })).status, 400);
  await wipe();
});

test('TestVideo_EndedReportRules', async () => {
  const a = await upload('e1.webm', { folder: 'Ended', title: 'E1', level: 'party' }, webm());
  const b = await upload('e2.webm', { folder: 'Ended', title: 'E2', level: 'party' }, webm());
  const c = await upload('e3.png', { folder: 'Ended', title: 'E3', level: 'party' }, PNG);
  const loaded = await ok('POST', `${SC()}/media/folder`, T.gm, { folder: 'Ended', intervalSec: 5 });
  const [i1, i2, i3] = loaded.items.map((i: any) => i.id);
  assert.deepEqual(loaded.items.map((i: any) => i.ref), [a.id, b.id, c.id]);
  const cur = async () => (await screen(T.jess)).media;
  const report = (tok: string, id: string, version: number) => call('POST', `${SC()}/media/ended`, tok, { id, version });
  let m = await cur();
  assert.equal(m.current.id, i1);
  // Too soon after it came up: refused (the report cannot skip through a queue).
  assert.equal((await report(T.jess, i1, m.version)).body.reason, 'early');
  backdate();
  // Only the item showing now, only the version the screen saw.
  assert.equal((await report(T.jess, i2, m.version)).body.reason, 'not-current');
  assert.equal((await report(T.jess, i1, m.version - 1)).body.reason, 'stale');
  assert.equal((await report(T.jess, i1, m.version + 5)).body.reason, 'stale');
  assert.equal((await call('POST', `${SC()}/media/ended`, T.jess, { version: 1 })).status, 400);
  assert.equal((await call('POST', `${SC()}/media/ended`, undefined, { id: i1, version: 1 })).status, 401);
  assert.equal((await cur()).current.id, i1, 'nothing moved yet');
  // The first report moves on; the same report from a second screen (same version) is stale.
  const first = await report(T.jess, i1, m.version);
  assert.equal(first.body.accepted, true);
  assert.equal((await cur()).current.id, i2);
  const dup = await report(T.gm, i1, m.version);
  assert.deepEqual([dup.body.accepted, dup.body.reason], [false, 'stale']);
  assert.equal((await cur()).current.id, i2);
  // The GM stops the slideshow: a report changes nothing while paused.
  m = await cur();
  backdate();
  await ok('PUT', `${SC()}/media`, T.gm, { playing: false });
  backdate();
  m = await cur();
  assert.equal((await report(T.jess, i2, m.version)).body.reason, 'paused');
  await ok('PUT', `${SC()}/media`, T.gm, { playing: true });
  backdate();
  m = await cur();
  // A video with its own play time or on loop is not moved by a report (the clock or the GM moves it).
  await ok('PATCH', `${SC()}/media/items/${i2}`, T.gm, { loopVideo: true });
  backdate();
  m = await cur();
  assert.equal((await report(T.jess, i2, m.version)).body.reason, 'timed');
  assert.equal(tick(deps, Date.now() + 999_000), 0, 'a looping video with no play time stays');
  await ok('PATCH', `${SC()}/media/items/${i2}`, T.gm, { loopVideo: false, playSecs: 4 });
  run(deps.db, 'UPDATE screen_media SET advanced_at = ?', Date.now());
  assert.equal(tick(deps, Date.now() + 1000), 0);
  assert.equal(tick(deps, Date.now() + 5000), 1, 'play for N seconds moves it on');
  assert.equal((await cur()).current.id, i3);
  // A picture is not a video, and the picture slide still uses the interval.
  backdate();
  m = await cur();
  assert.equal((await report(T.jess, i3, m.version)).body.reason, 'not-video');
  assert.equal(tick(deps, Date.now() + 6000), 1);
  // Queue mode: a video ending moves to the next item; at the end without loop it stays.
  await ok('PATCH', `${SC()}/media/items/${i2}`, T.gm, { playSecs: 0 });
  await ok('PUT', `${SC()}/media`, T.gm, { mode: 'queue', currentId: i1, loop: false });
  backdate();
  m = await cur();
  assert.equal((await report(T.jess, i1, m.version)).body.accepted, true);
  assert.equal((await cur()).current.id, i2);
  backdate();
  m = await cur();
  assert.equal((await report(T.jess, i2, m.version)).body.accepted, true);
  assert.equal((await cur()).current.id, i3);
  // Focus and off: a report does nothing.
  await ok('POST', `${SC()}/media/focus`, T.gm, { id: i1 });
  backdate();
  m = await cur();
  assert.equal((await report(T.jess, i1, m.version)).body.reason, 'mode');
  await wipe();
});

test('TestVideo_FolderLoadsPicturesGifsAndVideosMixedInNameOrder', async () => {
  await upload('b-clip.mp4', { folder: 'Mixed', title: 'Clip B', level: 'party' }, mp4());
  await upload('a-map.png', { folder: 'Mixed', title: 'Map A', level: 'party' }, PNG);
  await upload('c-fire.gif', { folder: 'Mixed', title: 'Fire C', level: 'party' }, GIF);
  await upload('10-last.webm', { folder: 'Mixed', title: 'Last', level: 'party' }, webm());
  await upload('2-second.png', { folder: 'Mixed', title: 'Second', level: 'party' }, PNG);
  await upload('notes.txt', { folder: 'Mixed', title: 'Notes', level: 'party' }, Buffer.from('words'));
  const r = await ok('POST', `${SC()}/media/folder`, T.gm, { folder: 'Mixed', intervalSec: 3 });
  assert.deepEqual(r.items.map((i: any) => `${i.kind}:${i.title}`), ['image:2-second', 'video:10-last', 'image:a-map', 'video:b-clip', 'image:c-fire']);
  assert.equal(r.loaded, 5);
  const src = await ok('GET', `${SC()}/media/sources`, T.gm);
  const fo = src.folders.find((x: any) => x.folder === 'Mixed');
  assert.deepEqual([fo.images, fo.videos], [3, 2]);
  assert.ok(src.files.some((x: any) => x.family === 'video'));
  assert.equal((await call('GET', `${SC()}/media/sources`, T.jess)).status, 403);
  // A GIF is a picture: it keeps the slideshow interval; a video waits for its end.
  const gif = r.items.find((i: any) => i.title === 'c-fire');
  await ok('PUT', `${SC()}/media`, T.gm, { currentId: gif.id });
  assert.equal(tick(deps, Date.now() + 1000), 0);
  assert.equal(tick(deps, Date.now() + 4000), 1);
  assert.equal((await screen(T.jess)).media.current.kind, 'image');
  await wipe();
});

test('TestVideo_GmOnlyFilesCanBeShownOnlyWhileCurrentAndClassifiedNever', async () => {
  const dmv = await upload('secret.mp4', { folder: 'Private', title: 'Private clip', level: 'gm' }, mp4());
  const gmp = await upload('secret.png', { folder: 'Private', title: 'Private pic', level: 'gm' }, PNG);
  const cls = await upload('sealed.mp4', { folder: 'Private', title: 'Sealed clip', level: 'classified' }, mp4());
  assert.equal((await call('POST', `${SC()}/media/items`, T.gm, { kind: 'video', ref: cls.id })).status, 409, 'classified is refused');
  const folderLoad = await ok('POST', `${SC()}/media/folder`, T.gm, { folder: 'Private' });
  assert.equal(folderLoad.loaded, 2);
  assert.equal(folderLoad.skipped, 1, 'the classified file is skipped');
  assert.ok(!folderLoad.items.some((i: any) => i.ref === cls.id));
  await wipe();
  // A GM-only video: shown now (play), served while it is the current visible item.
  const m = await addFile(dmv.id, { play: true });
  assert.equal(m.items[0].gmOnly, true);
  const url = (await screen(T.jess)).media.current.url;
  assert.equal((await call('GET', url)).status, 200);
  assert.equal((await call('GET', url, undefined, undefined, { Range: 'bytes=0-3' })).status, 206);
  // Queued but not current: not served (the ticket is the same, the item is not showing).
  const other = await ok('POST', `${SC()}/media/items`, T.gm, { kind: 'image', ref: gmp.id });
  const otherId = other.items[1].id;
  await ok('PUT', `${SC()}/media`, T.gm, { mode: 'queue', currentId: otherId });
  assert.equal((await call('GET', url)).status, 404, 'no longer current');
  const picUrl = (await screen(T.jess)).media.current.url;
  assert.equal((await call('GET', picUrl)).status, 200);
  await ok('PATCH', `${SC()}/media/items/${otherId}`, T.gm, { hidden: true });
  assert.equal((await call('GET', picUrl)).status, 404, 'hidden');
  await ok('PATCH', `${SC()}/media/items/${otherId}`, T.gm, { hidden: false });
  assert.equal((await call('GET', picUrl)).status, 200);
  await ok('PUT', `${SC()}/media`, T.gm, { mode: 'off' });
  assert.equal((await call('GET', picUrl)).status, 404, 'media off');
  await ok('PUT', `${SC()}/media`, T.gm, { mode: 'queue', currentId: otherId });
  // The file becomes classified: it is no longer sent or served.
  await ok('PATCH', `/api/worlds/${W}/files/${gmp.id}`, T.gm, { level: 'classified' });
  assert.equal((await call('GET', picUrl)).status, 404, 'classified now');
  assert.equal((await screen(T.jess)).media.current, null);
  // It never appears in what players can see of the library.
  for (const tok of [T.jess]) {
    const files = await ok('GET', `/api/worlds/${W}/files`, tok);
    assert.ok(!files.files.some((f: any) => [dmv.id, gmp.id, cls.id].includes(f.id)), 'not in the file list');
    const found = await ok('GET', `/api/worlds/${W}/library/search?q=${encodeURIComponent('Private')}`, tok);
    assert.ok(!JSON.stringify(found).includes('Private clip') && !JSON.stringify(found).includes('Private pic'), 'not in search');
    const pages = await ok('GET', `/api/worlds/${W}/library/pages`, tok);
    assert.ok(!JSON.stringify(pages).includes('Private clip'));
    assert.equal((await call('GET', `/api/worlds/${W}/files/${dmv.id}`, tok)).status, 404);
  }
  await wipe();
});

test('TestVideo_ShareWithPartyIsGmOnlyAndOpensTheFilePage', async () => {
  const f = await upload('share.mp4', { folder: 'Shareme', title: 'Share me', level: 'gm' }, mp4());
  assert.equal((await call('POST', `${SC()}/media/share`, T.jess, { fileId: f.id })).status, 403);
  assert.equal((await call('POST', `${SC()}/media/share`, T.gm, { fileId: 'lf_nope' })).status, 404);
  assert.equal((await call('POST', `${SC()}/media/share`, T.gm, {})).status, 400);
  const before = (await ok('GET', `${SC()}/media/sources`, T.gm)).files.find((x: any) => x.id === f.id);
  assert.equal(before.shared, false);
  assert.equal((await ok('GET', `/api/worlds/${W}/files`, T.jess)).files.some((x: any) => x.id === f.id), false);
  await ok('POST', `${SC()}/media/share`, T.gm, { fileId: f.id });
  const after = (await ok('GET', `${SC()}/media/sources`, T.gm)).files.find((x: any) => x.id === f.id);
  assert.equal(after.shared, true);
  assert.equal((await ok('GET', `/api/worlds/${W}/files`, T.jess)).files.some((x: any) => x.id === f.id), true, 'players can open it now');
  // A page with its own text is not opened by sharing a file on it.
  const pg = await ok('PUT', `/api/worlds/${W}/library/pages`, T.gm, { path: 'secret/Plot.md', visibility: 'gm', body: 'The duke did it.' });
  const g = await upload('plot.mp4', { page: pg.id, level: 'gm' }, mp4());
  const r = await call('POST', `${SC()}/media/share`, T.gm, { fileId: g.id });
  assert.equal(r.status, 409);
  const still = (await ok('GET', `${SC()}/media/sources`, T.gm)).files.find((x: any) => x.id === g.id);
  assert.equal(still.shared, false);
  assert.ok(!JSON.stringify(await ok('GET', `/api/worlds/${W}/library/pages`, T.jess)).includes('duke'));
});
