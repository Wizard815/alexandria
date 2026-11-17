// Files in the library: upload checks, levels, tickets, write-back, the admin view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, all, run } from '../src/core/db.ts';
import { mintTicket } from '../src/features/sound/ticket.ts';
import { sniffFile } from '../src/features/libfiles/sniff.ts';

const PNG = (extra = 'x') => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`pad ${extra} pad`)]);
const PDF = (extra = 'x') => Buffer.from(`%PDF-1.4\n% ${extra}\n%%EOF\n`);

interface Env {
  base: string; deps: any; W: string; tmp: string; T: Record<string, string>; ID: Record<string, string>;
  call: (method: string, url: string, token?: string, body?: unknown) => Promise<{ status: number; body: any }>;
  up: (token: string | undefined, query: string, bytes: Buffer | Uint8Array | string, world?: string) => Promise<{ status: number; body: any }>;
  bytes: (url: string) => Promise<{ status: number; text: string; type: string | null }>;
  ok: (method: string, url: string, token?: string, body?: unknown) => Promise<any>;
  close: () => void;
}

async function boot(opts: { fetch?: typeof fetch; env?: Record<string, string> } = {}): Promise<Env> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-lf-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: opts.fetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ...opts.env } });
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
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Filesland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
  ID.jess = j.account.id;
  const up = async (token: string | undefined, query: string, bytes: Buffer | Uint8Array | string, world = W) => {
    const r = await fetch(`${base}/api/worlds/${world}/files?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: bytes as any });
    const t = await r.text();
    let b: any = t;
    try { b = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: b };
  };
  const bytes = async (url: string) => { const r = await fetch(base + url); return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('latin1'), type: r.headers.get('content-type') }; };
  return { base, deps: made.deps, W, tmp, T, ID, call, up, bytes, ok, close: () => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

const page = (e: Env, p: string, visibility: string, body = 'text') => e.ok('PUT', `/api/worlds/${e.W}/library/pages`, e.T.dm, { path: p, visibility, body });
const listFor = async (e: Env, token: string, pageId: string) => (await e.ok('GET', `/api/worlds/${e.W}/files?page=${pageId}`, token)).files as any[];

test('TestLibFiles_SniffAcceptsPicturesPdfAndText', () => {
  assert.equal((sniffFile(PNG(), 'a.bin') as any).mime, 'image/png');
  assert.equal((sniffFile(PDF(), 'a') as any).family, 'pdf');
  assert.equal((sniffFile(Buffer.from('# hi'), 'n.md') as any).family, 'text');
  assert.equal((sniffFile(Buffer.from('a,b\n1,2'), 'n.csv') as any).family, 'csv');
  assert.equal((sniffFile(Buffer.from('{"a":1}'), 'n.json') as any).family, 'json');
});

test('TestLibFiles_SniffRefusesSvgHtmlProgramsAndLies', () => {
  const bad = (b: Buffer | string, name: string) => assert.ok('error' in sniffFile(typeof b === 'string' ? Buffer.from(b) : b, name), name);
  bad('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', 'map.svg');
  bad('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'map.png');
  bad('<!DOCTYPE html><script>alert(1)</script>', 'sheet.txt');
  bad('<html><body>x</body></html>', 'a.md');
  bad('<?xml version="1.0"?><x/>', 'a.txt');
  bad(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), 'tool.png');
  bad(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), 'a.pdf');
  bad('#!/bin/sh\necho hi', 'run.txt');
  bad(Buffer.from('PK\x03\x04zipzip'), 'a.zip');
  bad('not json {', 'a.json');
  bad('plain text', 'a.unknown');
  bad(Buffer.from([1, 2, 3, 0, 0, 5]), 'a.txt');
  bad('', 'a.txt');
  bad(PNG(), 'a.html');
});

test('TestLibFiles_UploadValidationAndSizeCap', async () => {
  const e = await boot({ env: { ALX_LIBFILE_MAX_MB: '1' } });
  try {
    const pg = await page(e, 'lore/Town.md', 'party');
    const q = `page=${pg.id}&name=map.png&kind=map`;
    assert.equal((await e.up(e.T.jess, q, PNG())).status, 403, 'players cannot upload');
    assert.equal((await e.up(undefined, q, PNG())).status, 401);
    assert.equal((await e.up(e.T.dm, q, '')).status, 400, 'empty');
    assert.equal((await e.up(e.T.dm, 'page=' + pg.id + '&name=x.svg', '<svg/>')).status, 415);
    assert.equal((await e.up(e.T.dm, 'page=' + pg.id + '&name=x.png', '<svg onload=1/>')).status, 415, 'a name is not a type');
    assert.equal((await e.up(e.T.dm, q, Buffer.concat([PNG(), Buffer.alloc(1024 * 1024)]))).status, 413, 'over the cap');
    assert.equal((await e.up(e.T.dm, `page=${pg.id}&name=a.pdf&kind=map`, PDF())).status, 400, 'a map must be a picture');
    assert.equal((await e.up(e.T.dm, `page=${pg.id}&name=a.png&level=secretish`, PNG())).status, 400, 'a bad level is refused, not defaulted to party');
    assert.equal((await e.up(e.T.dm, `page=${pg.id}x&name=a.png`, PNG())).status, 404, 'unknown page');
    assert.equal(all(e.deps.db, 'SELECT * FROM libfiles_files').length, 0);
    const good = await e.up(e.T.dm, q, PNG());
    assert.equal(good.status, 201);
    assert.equal(good.body.level, 'dm', 'no level means DM-only');
    assert.equal(good.body.mime, 'image/png');
  } finally { e.close(); }
});

test('TestLibFiles_NewFilePageInAChosenFolder', async () => {
  const e = await boot();
  try {
    const r = await e.up(e.T.dm, 'folder=Handouts/Act%201&title=Harbour%20Map&name=h.png&kind=map&level=party', PNG());
    assert.equal(r.status, 201);
    assert.equal(r.body.pageCreated, true);
    assert.equal(r.body.page.path, 'Handouts/Act 1/Harbour Map.md');
    const pg = one<any>(e.deps.db, 'SELECT visibility FROM pages WHERE id = ?', r.body.page.id);
    assert.equal(pg.visibility, 'party');
    assert.equal((await e.up(e.T.dm, 'folder=Handouts/Act%201&title=Harbour%20Map&name=h.png', PNG())).status, 409);
    const jess = await listFor(e, e.T.jess, r.body.page.id);
    assert.equal(jess.length, 1);
    assert.equal(jess[0].level, undefined, 'a player is not told the level');
  } finally { e.close(); }
});

test('TestLibFiles_LevelsDecideWhoSeesAFile', async () => {
  const e = await boot();
  try {
    const party = await page(e, 'lore/Open.md', 'party');
    const secret = await page(e, 'lore/Secret.md', 'dm');
    const up = async (pg: any, level: string, name: string) => (await e.up(e.T.dm, `page=${pg.id}&name=${name}&level=${level}`, PNG(name))).body;
    const fParty = await up(party, 'party', 'p.png');
    const fDm = await up(party, 'dm', 'dm.png');
    const fBroker = await up(party, 'broker', 'b.png');
    const fClass = await up(party, 'classified', 'c.png');
    const fOnSecret = await up(secret, 'party', 'onsecret.png');
    // The DM sees everything with its level.
    const dmList = await listFor(e, e.T.dm, party.id);
    assert.deepEqual(dmList.map((f) => f.level).sort(), ['broker', 'classified', 'dm', 'party']);
    // A player: only the party-level file of a shared page.
    assert.deepEqual((await listFor(e, e.T.jess, party.id)).map((f) => f.name), ['p.png']);
    assert.equal((await e.call('GET', `/api/worlds/${e.W}/files?page=${secret.id}`, e.T.jess)).status, 404, 'a DM-only page is not found');
    const all1 = (await e.ok('GET', `/api/worlds/${e.W}/files`, e.T.jess)).files as any[];
    assert.deepEqual(all1.map((f) => f.name), ['p.png']);
    for (const f of [fDm, fBroker, fClass, fOnSecret]) {
      assert.equal((await e.call('GET', `/api/worlds/${e.W}/files/${f.id}`, e.T.jess)).status, 404, f.name);
      const t = await e.bytes(`/api/media/libfile/${mintTicket({ w: e.W, k: 'libfile', f: f.id, a: e.ID.jess })}`);
      assert.equal(t.status, 404, `a ticket made for jess does not open ${f.name}`);
    }
    // A model asking for the DM's view never sees a classified file.
    const asModel = await fetch(`${e.base}/api/worlds/${e.W}/files?page=${party.id}`, { headers: { Authorization: `Bearer ${e.T.dm}`, 'X-Alexandria-Caller': 'model' } });
    const names = ((await asModel.json()) as any).files.map((f: any) => f.name).sort();
    assert.deepEqual(names, ['b.png', 'dm.png', 'p.png']);
    assert.equal((await fetch(`${e.base}/api/worlds/${e.W}/files/${fClass.id}`, { headers: { Authorization: `Bearer ${e.T.dm}`, 'X-Alexandria-Caller': 'model' } })).status, 404);
    // Lowering the page to DM-only takes the party file away at once, even on a ticket already handed out.
    const ticket = (await listFor(e, e.T.jess, party.id))[0].url as string;
    assert.equal((await e.bytes(ticket)).status, 200);
    await e.ok('PUT', `/api/worlds/${e.W}/library/pages/${party.id}/level`, e.T.dm, { level: 'dm' });
    assert.equal((await e.bytes(ticket)).status, 404, 'checked again on every fetch');
    // Making the file DM-only does the same.
    await e.ok('PUT', `/api/worlds/${e.W}/library/pages/${party.id}/level`, e.T.dm, { level: 'party' });
    assert.equal((await e.bytes(ticket)).status, 200);
    await e.ok('PATCH', `/api/worlds/${e.W}/files/${fParty.id}`, e.T.dm, { level: 'dm' });
    assert.equal((await e.bytes(ticket)).status, 404);
  } finally { e.close(); }
});

test('TestLibFiles_TicketsAreSignedForOneAccountAndKind', async () => {
  const e = await boot();
  try {
    const pg = await page(e, 'lore/Open.md', 'party');
    const f = (await e.up(e.T.dm, `page=${pg.id}&name=p.png&level=party`, PNG('ticketbytes'))).body;
    const ticket = f.url.split('/').pop() as string;
    const got = await e.bytes(f.url);
    assert.equal(got.status, 200);
    assert.ok(got.text.includes('ticketbytes'));
    assert.equal(got.type, 'image/png');
    // Not for another kind of file, not edited, not another account, not a non-member.
    assert.equal((await e.bytes(`/api/media/stage/${ticket}`)).status, 404);
    const [body, mac] = ticket.split('.');
    const edit = (patch: Record<string, unknown>) => `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), ...patch })).toString('base64url')}.${mac}`;
    assert.equal((await e.bytes(`/api/media/libfile/${edit({ a: e.ID.jess })}`)).status, 404);
    assert.equal((await e.bytes(`/api/media/libfile/${edit({ exp: Date.now() + 1e12 })}`)).status, 404);
    assert.equal((await e.bytes(`/api/media/libfile/${mintTicket({ w: e.W, k: 'intake', f: f.id, a: e.ID.dm })}`)).status, 404, 'wrong kind');
    assert.equal((await e.bytes(`/api/media/libfile/${mintTicket({ w: e.W, k: 'libfile', f: f.id, a: 'acc_nobody' })}`)).status, 404, 'not a member');
    // Headers: no sniffing, no scripts.
    const raw = await fetch(base(e) + f.url);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    assert.match(raw.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    // A player gets a ticket made for them.
    const mine = (await listFor(e, e.T.jess, pg.id))[0];
    assert.equal(JSON.parse(Buffer.from(mine.url.split('/').pop().split('.')[0], 'base64url').toString()).a, e.ID.jess);
    assert.equal((await e.bytes(mine.url)).status, 200);
    // The file is gone when its page is.
    await e.ok('DELETE', `/api/worlds/${e.W}/library/pages/${pg.id}`, e.T.dm);
    assert.equal((await e.bytes(f.url)).status, 404);
    assert.equal(all(e.deps.db, 'SELECT * FROM libfiles_files').length, 0);
  } finally { e.close(); }
});
const base = (e: Env) => e.base;

test('TestLibFiles_TextFilesAreServedAsPlainText', async () => {
  const e = await boot();
  try {
    const pg = await page(e, 'lore/Open.md', 'party');
    const f = (await e.up(e.T.dm, `page=${pg.id}&name=notes.md&level=party&kind=rules`, '# Rules\n<b>not html</b>')).body;
    const r = await fetch(base(e) + f.url);
    assert.match(r.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { e.close(); }
});

test('TestLibFiles_MapsAppearForTheMapPageOnlyWhenVisible', async () => {
  const e = await boot();
  try {
    const open = await page(e, 'lore/Open.md', 'party');
    await e.up(e.T.dm, `page=${open.id}&name=world.png&kind=map&level=party`, PNG('w'));
    await e.up(e.T.dm, `page=${open.id}&name=dm-map.png&kind=map&level=dm`, PNG('d'));
    await e.up(e.T.dm, `page=${open.id}&name=handout.png&kind=handout&level=party`, PNG('h'));
    assert.deepEqual((await e.ok('GET', `/api/worlds/${e.W}/files/maps`, e.T.jess)).map((f: any) => f.name), ['world.png']);
    assert.deepEqual((await e.ok('GET', `/api/worlds/${e.W}/files/maps`, e.T.dm)).map((f: any) => f.name), ['dm-map.png', 'world.png']);
  } finally { e.close(); }
});

// ---- write-back ---------------------------------------------------------------------------------

const KANKA = 'https://kanka.test/api/1.0';
const LK = 'https://lk.test/api/v3/projects/p1';
function fakes(calls: { url: string; method: string; auth: string; form: Record<string, any> }[], failKanka = false) {
  return (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input.url ?? input);
    if (!/^https:\/\/(kanka|lk)\.test\//.test(url)) return fetch(input, init);
    const form: Record<string, any> = {};
    if (init?.body instanceof FormData) for (const [k, v] of init.body.entries()) form[k] = typeof v === 'string' ? v : { filename: (v as File).name, size: (v as File).size, type: (v as File).type };
    calls.push({ url, method: String(init?.method ?? 'GET'), auth: String(init?.headers?.Authorization ?? ''), form });
    const json = (s: number, b: any) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.startsWith(KANKA)) return failKanka ? json(403, { message: 'no' }) : json(201, { data: { id: 9001 } });
    return json(201, { id: 'asset_77', url: 'https://cdn/x.png' });
  }) as typeof fetch;
}
const addSource = (e: Env, kind: string, cfg: Record<string, unknown>, pageId: string, ext: string) => {
  const id = `src_${Math.random().toString(36).slice(2, 10)}`;
  run(e.deps.db, 'INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES (?, ?, ?, ?, ?, ?)', id, e.W, kind, kind === 'kanka-api' ? 'My Kanka' : 'My LK', JSON.stringify(cfg), 'dm');
  run(e.deps.db, 'UPDATE pages SET source_id = ?, external_id = ? WHERE id = ?', id, ext, pageId);
  return id;
};

test('TestLibFiles_KankaWriteBackSendsAnEntityAssetAndNeverClassified', async () => {
  const calls: any[] = [];
  const e = await boot({ fetch: fakes(calls) });
  try {
    const pg = await page(e, 'Characters/Aldric.md', 'party');
    const src = addSource(e, 'kanka-api', { apiUrl: KANKA, campaignId: '77', token: 'kanka_token_0123456789abcdef' }, pg.id, 'kanka:555');
    // The option exists for a party or DM file, not for a classified one.
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/files/targets?page=${pg.id}&level=dm`, e.T.dm)).target.app, 'Kanka');
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/files/targets?page=${pg.id}&level=classified`, e.T.dm)).target, null);
    assert.equal((await e.call('GET', `/api/worlds/${e.W}/files/targets?page=${pg.id}`, e.T.jess)).status, 403);

    const r = await e.up(e.T.dm, `page=${pg.id}&name=aldric.png&level=party&send=${src}`, PNG());
    assert.equal(r.status, 201);
    assert.equal(r.body.remote.id, '9001');
    assert.equal(r.body.remote.error, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${KANKA}/campaigns/77/entities/555/entity_assets`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].auth, 'Bearer kanka_token_0123456789abcdef');
    assert.equal(calls[0].form.type_id, '1');
    assert.equal(calls[0].form.visibility_id, '1', 'a party file is visible to everyone');
    assert.equal(calls[0].form.file.filename, 'aldric.png');

    // A DM-only file goes up as admin-only.
    await e.up(e.T.dm, `page=${pg.id}&name=notes.pdf&level=dm&send=${src}`, PDF());
    assert.equal(calls[1].form.visibility_id, '2');

    // Classified: refused before anything is stored or sent.
    const before = calls.length;
    const c = await e.up(e.T.dm, `page=${pg.id}&name=secret.png&level=classified&send=${src}`, PNG('s'));
    assert.equal(c.status, 400);
    assert.equal(calls.length, before);
    assert.equal(all(e.deps.db, `SELECT * FROM libfiles_files WHERE level = 'classified'`).length, 0);
    // A classified file stays local even when sent later; so does one made classified after.
    const keep = (await e.up(e.T.dm, `page=${pg.id}&name=late.png&level=dm`, PNG('late'))).body;
    await e.ok('PATCH', `/api/worlds/${e.W}/files/${keep.id}`, e.T.dm, { level: 'classified' });
    assert.equal((await e.call('POST', `/api/worlds/${e.W}/files/${keep.id}/send`, e.T.dm, {})).status, 400);
    assert.equal(calls.length, before);
    // Players cannot send.
    assert.equal((await e.call('POST', `/api/worlds/${e.W}/files/${keep.id}/send`, e.T.jess, {})).status, 403);
    assert.ok(all<any>(e.deps.db, `SELECT action FROM audit WHERE action = 'libfile.send'`).length >= 2);
  } finally { e.close(); }
});

test('TestLibFiles_WriteBackFailureKeepsTheLocalCopyAndCanBeRetried', async () => {
  const calls: any[] = [];
  let fail = true;
  const inner = fakes(calls);
  const e = await boot({ fetch: (async (i: any, init?: any) => (fail && String(i).startsWith(KANKA) ? new Response('{}', { status: 403 }) : inner(i, init))) as typeof fetch });
  try {
    const pg = await page(e, 'Characters/Aldric.md', 'party');
    const src = addSource(e, 'kanka-api', { apiUrl: KANKA, campaignId: '77', token: 'kanka_token_0123456789abcdef' }, pg.id, 'kanka:555');
    const r = await e.up(e.T.dm, `page=${pg.id}&name=a.png&level=dm&send=${src}`, PNG());
    assert.equal(r.status, 201, 'the upload itself worked');
    assert.match(r.body.remote.error, /refused/);
    assert.equal(r.body.remote.id, null);
    assert.equal(all(e.deps.db, 'SELECT * FROM libfiles_files').length, 1);
    fail = false;
    const again = await e.ok('POST', `/api/worlds/${e.W}/files/${r.body.id}/send`, e.T.dm, {});
    assert.equal(again.remote.id, '9001');
    assert.equal(again.remote.error, null);
  } finally { e.close(); }
});

test('TestLibFiles_LegendKeeperWriteBackAndHiddenWhereUnsupported', async () => {
  const calls: any[] = [];
  const e = await boot({ fetch: fakes(calls) });
  try {
    const lk = await page(e, 'Places/Harbour.md', 'party');
    const src = addSource(e, 'legendkeeper-api', { apiUrl: LK, apiKey: 'lk_write_key_1234' }, lk.id, 'res_harbour');
    const r = await e.up(e.T.dm, `page=${lk.id}&name=harbour.png&kind=map&level=party&send=${src}`, PNG());
    assert.equal(r.status, 201);
    assert.equal(r.body.remote.id, 'asset_77');
    assert.equal(calls[0].url, `${LK}/assets`);
    assert.equal(calls[0].auth, 'Bearer lk_write_key_1234');
    assert.equal(calls[0].form.file.filename, 'harbour.png');
    // Sources with no upload offer nothing: the generic API (no upload role), the Markdown folder, mcp-kanka, a page with no source.
    const other = await page(e, 'Places/Other.md', 'party');
    const api = addSource(e, 'api', { baseUrl: 'https://api.test' }, other.id, 'x1');
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/files/targets?page=${other.id}`, e.T.dm)).target, null);
    assert.equal((await e.up(e.T.dm, `page=${other.id}&name=a.png&send=${api}`, PNG('o'))).status, 400);
    const mcp = await page(e, 'Places/Mcp.md', 'party');
    addSource(e, 'kanka-mcp', { url: 'https://mcp.test' }, mcp.id, 'kanka:12');
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/files/targets?page=${mcp.id}`, e.T.dm)).target, null);
    const plain = await page(e, 'Places/Plain.md', 'party');
    assert.equal((await e.ok('GET', `/api/worlds/${e.W}/files/targets?page=${plain.id}`, e.T.dm)).target, null);
    assert.equal(calls.length, 1);
  } finally { e.close(); }
});

// ---- the admin library ----------------------------------------------------------------------------

test('TestLibFiles_AdminWhoIsNotTheDmSeesOnlyThePartyCopyAndCannotUpload', async () => {
  const e = await boot();
  try {
    const open = await page(e, 'lore/Open.md', 'party', 'Shared words.\n\n> [!secret]\n> hidden words');
    const secret = await page(e, 'lore/Secret.md', 'dm', 'dm only words');
    await e.up(e.T.dm, `page=${open.id}&name=p.png&level=party&kind=map`, PNG('partybytes'));
    await e.up(e.T.dm, `page=${open.id}&name=d.png&level=dm`, PNG('dmbytes'));
    await e.up(e.T.dm, `page=${secret.id}&name=s.png&level=party`, PNG('onsecretbytes'));
    const A = `/api/admin/library/worlds/${e.W}`;
    // The admin is not the DM here: world routes refuse, the admin library answers with the party copy.
    assert.equal((await e.call('GET', `/api/worlds/${e.W}/library/pages`, e.T.admin)).status, 404);
    const worlds = await e.ok('GET', '/api/admin/library/worlds', e.T.admin);
    assert.deepEqual(worlds.map((w: any) => [w.name, w.view, w.role]), [['Filesland', 'party', null]]);
    const pages = await e.ok('GET', `${A}/library/pages`, e.T.admin);
    assert.deepEqual(pages.map((p: any) => p.title).sort(), ['Open']);
    const one1 = await e.ok('GET', `${A}/library/pages/${open.id}`, e.T.admin);
    assert.ok(JSON.stringify(one1).includes('Shared words'));
    assert.ok(!JSON.stringify(one1).includes('hidden words'));
    assert.equal((await e.call('GET', `${A}/library/pages/${secret.id}`, e.T.admin)).status, 404);
    assert.equal((await e.call('GET', `${A}/library/search?q=words`, e.T.admin)).body.some((h: any) => h.id === secret.id), false);
    const files = await e.ok('GET', `${A}/files`, e.T.admin);
    assert.deepEqual(files.files.map((f: any) => f.name), ['p.png']);
    assert.equal(files.canUpload, false);
    assert.equal(files.files[0].level, undefined);
    assert.equal((await e.bytes(files.files[0].url)).status, 200, 'the admin ticket opens the party file');
    for (const f of all<any>(e.deps.db, `SELECT id FROM libfiles_files WHERE name != 'p.png'`)) {
      assert.equal((await e.bytes(`/api/media/libfile/${mintTicket({ w: e.W, k: 'libfile', f: f.id, a: one<any>(e.deps.db, 'SELECT id FROM accounts WHERE username = ?', 'wizard').id })}`)).status, 404);
    }
    // Uploads and changes are refused for this admin.
    const r = await fetch(`${e.base}${A}/files?page=${open.id}&name=x.png`, { method: 'POST', headers: { Authorization: `Bearer ${e.T.admin}`, 'Content-Type': 'application/octet-stream' }, body: PNG('adm') });
    assert.equal(r.status, 403);
    assert.equal(all(e.deps.db, 'SELECT * FROM libfiles_files').length, 3);
    // Players and strangers do not open the admin library.
    assert.equal((await e.call('GET', `${A}/library/pages`, e.T.jess)).status, 403);
    assert.equal((await e.call('GET', `${A}/library/pages`)).status, 401);

    // An admin who is the world's DM gets the DM view and can upload.
    await e.ok('PUT', `/api/admin/worlds/${e.W}/members/${one<any>(e.deps.db, 'SELECT id FROM accounts WHERE username = ?', 'wizard').id}`, e.T.admin, { role: 'dm' });
    const dmView = await e.ok('GET', `${A}/library/pages`, e.T.admin);
    assert.equal(dmView.length, 2);
    const mine = await e.ok('GET', `${A}/files`, e.T.admin);
    assert.equal(mine.canUpload, true);
    assert.equal(mine.files.length, 3);
    const up = await fetch(`${e.base}${A}/files?page=${open.id}&name=x.png`, { method: 'POST', headers: { Authorization: `Bearer ${e.T.admin}`, 'Content-Type': 'application/octet-stream' }, body: PNG('adm') });
    assert.equal(up.status, 201);
  } finally { e.close(); }
});
