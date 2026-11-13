// Library endpoints used by the Library browser: page, Markdown download,
// bulk fetch for offline saves. Players get only their player copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run } from '../src/core/db.ts';

test('TestLibrary_DownloadAndBulkGivePlayersOnlyTheirCopy', async () => {
  const { app, deps } = createApp({ env: { ALX_ADMIN_TABLE_LOGIN: '1' }, noScheduler: true });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* markdown */ }
    return { status: r.status, body: json, text, type: r.headers.get('content-type') ?? '', disp: r.headers.get('content-disposition') ?? '' };
  };
  try {
    const a = (await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).body;
    const w = (await call('POST', '/api/admin/worlds', a.token, { name: 'W', dmAccountId: a.account.id })).body;
    const inv = (await call('POST', `/api/worlds/${w.id}/invites`, a.token, { role: 'player' })).body;
    const p = (await call('POST', '/api/join', null, { code: inv.code, username: 'jess', password: 'player pass 123' })).body;

    const shared = (await call('PUT', `/api/worlds/${w.id}/library/pages`, a.token, { path: 'Places/Port', visibility: 'party', markdown: '---\ntags: [town]\n---\n# Port\nFish.\n\n> [!secret]\n> Smugglers.\n' })).body;
    const hidden = (await call('PUT', `/api/worlds/${w.id}/library/pages`, a.token, { path: 'Plot', markdown: 'The twist.' })).body;

    // An imported structured page with a secret and an unknown block.
    run(deps.db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'api', 'Wiki', '{}', 'party')`, w.id);
    const ent = deps.library.saveEntry(w.id, 's1', 'wiki', {
      externalId: 'e1', title: 'Imported', visibility: 'party', folder: ['Lore'],
      blocks: [{ kind: 'paragraph', content: [{ text: 'Open text.' }] }, { kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: 'Buried truth.' }] }] }, { kind: 'unsupported', sourceKind: 'widget' }],
    }, null);
    deps.library.rebuildPlayerCopies(w.id);

    const md = await call('GET', `/api/worlds/${w.id}/library/pages/${shared.id}/markdown`, p.token);
    assert.equal(md.status, 200);
    assert.ok(md.type.startsWith('text/markdown'));
    assert.ok(md.disp.includes('Port.md'));
    assert.ok(md.text.includes('title: Port') && md.text.includes('Fish.'));
    assert.ok(!md.text.includes('Smugglers') && !md.text.includes('visibility'));
    const dmMd = await call('GET', `/api/worlds/${w.id}/library/pages/${shared.id}/markdown`, a.token);
    assert.ok(dmMd.text.includes('Smugglers') && dmMd.text.includes('visibility: party'));
    assert.equal((await call('GET', `/api/worlds/${w.id}/library/pages/${hidden.id}/markdown`, p.token)).status, 404);

    const bulk = await call('POST', `/api/worlds/${w.id}/library/pages/bulk`, p.token, { ids: [shared.id, hidden.id, ent.id, 'nope'] });
    assert.equal(bulk.status, 200);
    assert.deepEqual(bulk.body.map((x: any) => x.title).sort(), ['Imported', 'Port']);
    const s = JSON.stringify(bulk.body);
    for (const leak of ['Smugglers', 'Buried truth', 'widget', '"secret"', 'unsupported', 'twist']) assert.ok(!s.includes(leak), leak);
    const dmBulk = (await call('POST', `/api/worlds/${w.id}/library/pages/bulk`, a.token, { ids: [ent.id] })).body;
    assert.ok(JSON.stringify(dmBulk).includes('Buried truth') && JSON.stringify(dmBulk).includes('unsupported'));
    assert.equal((await call('POST', `/api/worlds/${w.id}/library/pages/bulk`, p.token, { ids: 'x' })).status, 400);

    const list = (await call('GET', `/api/worlds/${w.id}/library/pages`, p.token)).body;
    assert.deepEqual(list.map((x: any) => x.title).sort(), ['Imported', 'Port']);
    assert.ok(list.every((x: any) => !('visibility' in x)));
    assert.deepEqual(list.find((x: any) => x.title === 'Imported').folder, ['Lore']);
  } finally {
    server.close();
  }
});
