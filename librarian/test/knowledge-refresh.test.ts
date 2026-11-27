// Refresh world and pictures stored here: a page's portrait and the pictures in its text are queued by a sync, downloaded by the picture
// downloader, served from this server in place of the source's address, and a GM-only picture never reaches a player. "Refresh world" runs
// sources, pictures, index and Minerva's codex links as one job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { entryPictures } from '../src/intake/images.ts';
import { drainPictures, waitingPictures } from '../src/intake/imagequeue.ts';
import { initRecords, pruneOrphanImages, saveRecords, MAX_TRIES } from '../src/intake/records.ts';
import type { Entry } from '../src/intake/model.ts';
import { codexUpsert } from '../src/features/minerva/codex.ts';
import { enable } from '../src/features/minerva/seed.ts';
import { readPage } from '../src/features/minerva/vault.ts';
import { relinkCodex, withLibraryLine } from '../src/features/minerva/relink.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201d0e6a3e20000000049454e44ae426082', 'hex');

async function world(fetchImpl?: typeof fetch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-know-'));
  const { app, deps } = createApp({ dbFile: path.join(tmp, 'a.db'), dataDir: tmp, noScheduler: true, ...(fetchImpl ? { fetch: fetchImpl } : {}), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } }) as any;
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (m: string, p: string, t?: string, b?: unknown) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  const admin = (await call('POST', '/api/setup', undefined, { username: 'admin', password: 'library admin 123' })).json.token;
  const dmA = (await call('POST', '/api/admin/accounts', admin, { username: 'dm', password: 'dm password 123' })).json.account.id;
  const dm = (await call('POST', '/api/auth/login', undefined, { username: 'dm', password: 'dm password 123' })).json.token;
  const W = (await call('POST', '/api/admin/worlds', admin, { name: 'Pictureland', dmAccountId: dmA })).json.id;
  const inv = (await call('POST', `/api/worlds/${W}/invites`, dm, { role: 'player' })).json;
  const jess = (await call('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).json.token;
  const close = () => { server.close(); server.closeAllConnections?.(); };
  return { deps, base, call, dm, dmA, jess, W, close };
}

test('TestKnowledge_EntryPicturesFollowThePageAndSecrets', () => {
  const e: Entry = {
    externalId: 'kanka:7', title: 'Mira', visibility: 'party', banner: 'https://img.example/mira.png',
    blocks: [
      { kind: 'paragraph', content: [{ text: 'hi' }] },
      { kind: 'image', url: 'https://img.example/a.png', alt: 'Gate' },
      { kind: 'image', url: 'https://img.example/a.png' },
      { kind: 'secret', children: [{ kind: 'bulletList', children: [{ kind: 'listItem', children: [{ kind: 'image', url: 'https://img.example/s.png' }] }] }] },
      { kind: 'image', url: 'javascript:alert(1)' },
      { kind: 'map', image: 'https://img.example/map.png', pins: [] },
    ],
  };
  const r = entryPictures(e) as any[];
  assert.deepEqual(r.map((x) => [x.url, x.visibility, !!x.inline, x.later]), [
    ['https://img.example/mira.png', 'party', false, true],
    ['https://img.example/a.png', 'party', true, true],
    ['https://img.example/s.png', 'dm', true, true],
  ], 'banner first, each address once, a secret picture is the GM\'s, no script address, maps left to the connector');
  assert.ok(r.every((x) => x.pageRef === 'kanka:7' && x.externalId.startsWith('kanka:7#pic:')));
  assert.ok(entryPictures({ ...e, visibility: 'dm' }).every((x: any) => x.visibility === 'dm'), 'a GM-only page gives only GM pictures');
});

test('TestKnowledge_PicturesAreStoredAndServedHere', async () => {
  const asked: string[] = [];
  const fake = (async (u: any) => {
    asked.push(String(u));
    if (String(u).endsWith('/broken.png')) return new Response('nope', { status: 404 });
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;
  const w = await world(fake);
  try {
    const { deps, W } = w;
    run(deps.db, "INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'push', 'Kanka', '{}', 'party')", W);
    const e: Entry = {
      externalId: 'p1', title: 'Mira', visibility: 'party', banner: 'https://img.example/mira.png', updatedAt: new Date().toISOString(),
      blocks: [
        { kind: 'image', url: 'https://img.example/gate.png', alt: 'Gate' },
        { kind: 'secret', children: [{ kind: 'image', url: 'https://img.example/secret.png' }] },
        { kind: 'image', url: 'https://img.example/broken.png' },
      ],
    };
    deps.library.saveEntry(W, 's1', null, e, null);
    deps.library.rebuildPlayerCopies(W);
    saveRecords(deps.db, W, 's1', entryPictures(e));
    assert.equal(waitingPictures(deps.db, { worldId: W }), 4);
    // Nothing is served before it is downloaded: the page still shows the source's addresses.
    let pg = (await w.call('GET', `/api/worlds/${W}/library/pages/${one<any>(deps.db, "SELECT id FROM pages WHERE external_id = 'p1'").id}`, w.dm)).json;
    assert.equal(pg.banner, 'https://img.example/mira.png');
    const q = await drainPictures({ db: deps.db, fetch: fake, env: {} }, 's1');
    assert.deepEqual([q.downloaded, q.failed], [3, 1]);
    assert.ok(asked.length === 4, 'one request a picture');
    const pid = one<any>(deps.db, "SELECT id FROM pages WHERE external_id = 'p1'").id;
    pg = (await w.call('GET', `/api/worlds/${W}/library/pages/${pid}`, w.dm)).json;
    assert.match(pg.banner, /^\/api\/media\/intake\//, 'the banner is served from here');
    assert.ok(pg.pictures[0].primary && pg.pictures[0].url === pg.banner, 'the banner copy is the primary picture');
    assert.equal(pg.pictures.length, 1, 'pictures in the text are not listed in the gallery');
    const imgs = JSON.stringify(pg.blocks);
    assert.ok(!imgs.includes('img.example/gate.png') && !imgs.includes('img.example/secret.png'), 'the GM sees every stored picture from here');
    assert.ok(imgs.includes('img.example/broken.png'), 'a picture that could not be stored keeps its address');
    const media = await fetch(w.base + pg.banner);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    // A player: the shared pictures from here, never the secret one (its block is not in their copy, and its file is not theirs either).
    const pj = (await w.call('GET', `/api/worlds/${W}/library/pages/${pid}`, w.jess)).json;
    assert.match(pj.banner, /^\/api\/media\/intake\//);
    assert.ok(!JSON.stringify(pj.blocks).includes('secret.png'));
    const sec = one<any>(deps.db, "SELECT id, visibility FROM intake_images WHERE url LIKE '%secret.png'");
    assert.equal(sec.visibility, 'dm');
    // Failing pictures are given up after MAX_TRIES and not asked for again.
    for (let i = 0; i < MAX_TRIES + 2; i++) await drainPictures({ db: deps.db, fetch: fake, env: {} }, 's1');
    assert.equal(asked.filter((u) => u.endsWith('broken.png')).length, MAX_TRIES);
    assert.equal(waitingPictures(deps.db, { worldId: W }), 0);
    // The same addresses again: nothing new is queued. A changed portrait is queued, and the old file is served until the new one arrives.
    saveRecords(deps.db, W, 's1', entryPictures(e));
    assert.equal(waitingPictures(deps.db, { worldId: W }), 0);
    const e2 = { ...e, banner: 'https://img.example/mira2.png' };
    saveRecords(deps.db, W, 's1', entryPictures(e2));
    assert.equal(one<any>(deps.db, "SELECT COUNT(*) AS n FROM intake_images WHERE url LIKE '%mira.png'")?.n, 0, 'a complete listing drops the old portrait');
    // A page removed takes its pictures with it.
    deps.library.removeMissing(W, 's1', new Set());
    assert.ok(pruneOrphanImages(deps.db, W, 's1') > 0);
    assert.equal(one<any>(deps.db, "SELECT COUNT(*) AS n FROM intake_images WHERE page_external = 'p1'")?.n, 0);
  } finally { w.close(); }
});

test('TestKnowledge_ReadingAPageReplacesOnlyItsOwnPictures', async () => {
  const w = await world();
  try {
    const { deps, W } = w;
    initRecords(deps.db);
    run(deps.db, "INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'push', 'LK', '{}', 'party')", W);
    const a: Entry = { externalId: 'a', title: 'A', visibility: 'party', blocks: [{ kind: 'image', url: 'https://img.example/a1.png' }, { kind: 'image', url: 'https://img.example/a2.png' }] };
    const b: Entry = { externalId: 'b', title: 'B', visibility: 'party', blocks: [{ kind: 'image', url: 'https://img.example/b1.png' }] };
    for (const e of [a, b]) deps.library.saveEntry(W, 's1', null, e, null);
    saveRecords(deps.db, W, 's1', [...entryPictures(a), ...entryPictures(b)]);
    // The map picture a connector stored itself is never touched by a page's own pictures.
    run(deps.db, "INSERT INTO intake_images (id, world_id, source_id, external_id, name, mime, size, data, visibility, page_ref, page_external, at, kind) VALUES ('m1', ?, 's1', 'a#mapimg', 'Map', 'image/png', 1, x'00', 'party', 'a', 'a', ?, 'map')", W, new Date().toISOString());
    const a2: Entry = { ...a, blocks: [{ kind: 'image', url: 'https://img.example/a1.png' }] };
    const all = new Set<'relation' | 'timeline' | 'calendar' | 'mapMarker' | 'image'>(['relation', 'timeline', 'calendar', 'mapMarker', 'image']);
    saveRecords(deps.db, W, 's1', entryPictures(a2), all, { relationOwners: new Set(), mapRefs: new Set(), pictureOwners: new Set(['a']) });
    const urls = (deps.db.prepare("SELECT COALESCE(url, external_id) AS u FROM intake_images ORDER BY u").all() as any[]).map((r) => r.u);
    assert.deepEqual(urls, ['a#mapimg', 'https://img.example/a1.png', 'https://img.example/b1.png']);
  } finally { w.close(); }
});

test('TestKnowledge_RelinkMendsCodexLinks', async () => {
  const w = await world();
  try {
    const { deps, W } = w;
    enable(deps, W, null);
    run(deps.db, "INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'push', 'Kanka', '{}', 'dm')", W);
    deps.library.saveEntry(W, 's1', null, { externalId: 'k1', title: 'Captain Vex', type: 'character', visibility: 'dm', blocks: [] }, null);
    deps.library.saveEntry(W, 's1', null, { externalId: 'k2', title: 'Old Mill', type: 'location', visibility: 'dm', blocks: [] }, null);
    const vex = one<any>(deps.db, "SELECT id FROM pages WHERE external_id = 'k1'").id;
    const made = codexUpsert(deps, W, { entity: vex, section: 'notes', text: 'Owes the party a favour.' });
    assert.match(readPage(deps, W, made.rel)!.body, /Library: \[\[Captain Vex\]\]/);
    // A page Minerva named before the library had it.
    const mill = codexUpsert(deps, W, { name: 'Old Mill', kind: 'place', section: 'notes', text: 'Burned down.' });
    assert.equal(readPage(deps, W, mill.rel)!.fm.entity, one<any>(deps.db, "SELECT id FROM pages WHERE external_id = 'k2'").id, 'found by name at once');
    run(deps.db, "UPDATE pages SET title = 'Admiral Vex' WHERE id = ?", vex);
    let r = relinkCodex(deps, W);
    assert.equal(r.renamed, 1);
    assert.match(readPage(deps, W, made.rel)!.body, /Library: \[\[Admiral Vex\]\]/);
    // Removed and added again under a new id: found again by its codex title or alias.
    run(deps.db, 'DELETE FROM pages WHERE id = ?', vex);
    deps.library.saveEntry(W, 's1', null, { externalId: 'k9', title: 'Captain Vex', type: 'character', visibility: 'dm', blocks: [] }, null);
    r = relinkCodex(deps, W);
    assert.equal(r.relinked, 1);
    assert.equal(readPage(deps, W, made.rel)!.fm.entity, one<any>(deps.db, "SELECT id FROM pages WHERE external_id = 'k9'").id);
    // Gone for good: reported, not guessed.
    run(deps.db, "DELETE FROM pages WHERE external_id IN ('k9', 'k2')");
    r = relinkCodex(deps, W);
    assert.deepEqual(r.broken.sort(), ['Captain Vex', 'Old Mill']);
    assert.equal(withLibraryLine('# T\n\nBody', 'X'), '# T\n\nLibrary: [[X]]\n\nBody');
  } finally { w.close(); }
});

test('TestKnowledge_RefreshWorldRunsEveryStep', async () => {
  const w = await world();
  try {
    const { deps, W } = w;
    enable(deps, W, null);
    assert.equal((await w.call('POST', `/api/worlds/${W}/knowledge/refresh`, w.jess, {})).status, 403, 'the GM refreshes');
    assert.equal((await w.call('GET', `/api/worlds/${W}/knowledge`, w.jess)).status, 403);
    const s = await w.call('POST', `/api/worlds/${W}/knowledge/refresh`, w.dm, {});
    assert.equal(s.status, 202);
    let st: any;
    for (let i = 0; i < 100; i++) { st = (await w.call('GET', `/api/worlds/${W}/knowledge`, w.dm)).json; if (!st.running) break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(st.running, false);
    assert.equal(st.refresh.status, 'ok');
    assert.deepEqual(st.refresh.steps.map((x: any) => [x.id, x.state]), [['sources', 'skipped'], ['pictures', 'done'], ['index', 'skipped'], ['minerva', 'done']]);
    assert.ok(st.minerva.on);
    assert.ok(one(deps.db, 'SELECT 1 AS x FROM knowledge_refreshes WHERE world_id = ?', W), 'the last run is kept');
    assert.ok(one(deps.db, "SELECT 1 AS x FROM audit WHERE action = 'world.refresh'"));
  } finally { w.close(); }
});
