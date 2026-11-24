// A LegendKeeper map: the picture and its frame come with the document, pins are placed on it, and players get no pin they may not see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { initRecords } from '../src/intake/records.ts';

test('Map_ImportedPinsFollowLevelsAndFrame', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-mapimp-'));
  const { app, deps } = createApp({ dbFile: path.join(tmp, 'a.db'), dataDir: tmp, noScheduler: true, env: { ALX_ADMIN_TABLE_LOGIN: '1' } }) as any;
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (m: string, p: string, t?: string, b?: unknown) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) as any }; };
  try {
    const admin = (await call('POST', '/api/setup', undefined, { username: 'admin', password: 'library admin 123' })).json.token;
    const dmA = (await call('POST', '/api/admin/accounts', admin, { username: 'dm', password: 'dm password 123' })).json.account.id;
    const dm = (await call('POST', '/api/auth/login', undefined, { username: 'dm', password: 'dm password 123' })).json.token;
    const W = (await call('POST', '/api/admin/worlds', admin, { name: 'Mapland', dmAccountId: dmA })).json.id;
    const inv = (await call('POST', `/api/worlds/${W}/invites`, dm, { role: 'player' })).json;
    const jess = (await call('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).json.token;
    run(deps.db, "INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'push', 'LK', '{}', 'party')", W);
    const at = new Date().toISOString();
    deps.library.saveEntry(W, 's1', null, { externalId: 'town', title: 'Town', blocks: [], visibility: 'party', updatedAt: at }, null);
    deps.library.saveEntry(W, 's1', null, { externalId: 'm', title: 'The map', type: 'map', visibility: 'party', updatedAt: at, blocks: [{ kind: 'map', image: 'https://x/y.png', width: 3072, height: 4096, bounds: [[-256, 0], [0, 192]], pins: [
      { name: 'Town', lat: -128, lng: 96, type: 'house', color: '#8b5e3c', ref: 'town' }, { name: 'Secret', lat: -10, lng: 10, dm: true }, { name: 'Off', lat: 50, lng: 10 }] }] }, null);
    deps.library.rebuildPlayerCopies(W);
    initRecords(deps.db);
    run(deps.db, "INSERT INTO intake_images (id, world_id, source_id, external_id, name, mime, size, data, visibility, page_ref, page_external, at, kind) VALUES ('img1', ?, 's1', 'm#mapimg', 'The map', 'image/png', 1, x'00', 'party', 'm', 'm', ?, 'map')", W, at);
    const d = (await call('GET', `/api/worlds/${W}/map/imported/img1/pins`, dm)).json;
    assert.deepEqual(d.pins.map((p: any) => [p.name, p.x, p.y, p.icon, p.color, p.dm]), [['Town', 50, 50, 'house', '#8b5e3c', false], ['Secret', (10 / 192) * 100, (10 / 256) * 100, null, null, true]]);
    assert.ok(d.pins[0].pageId);
    const j = (await call('GET', `/api/worlds/${W}/map/imported/img1/pins`, jess)).json;
    assert.deepEqual(j.pins.map((p: any) => p.name), ['Town'], 'a DM-only pin is never sent to a player');
    // Scale: the DM sets it, everyone reads it.
    assert.equal((await call('PUT', `/api/worlds/${W}/map/scale`, jess, { pic: 'imp:img1', width: 400, unit: 'miles' })).status, 403);
    assert.equal((await call('PUT', `/api/worlds/${W}/map/scale`, dm, { pic: 'imp:img1', width: 400, unit: 'miles' })).status, 200);
    assert.deepEqual((await call('GET', `/api/worlds/${W}/map/scale?pic=imp:img1`, jess)).json, { width: 400, unit: 'miles' });
    // A page that stops being shared takes its pins with it.
    run(deps.db, "UPDATE pages SET visibility = 'dm' WHERE external_id = 'm'"); deps.library.rebuildPlayerCopies(W);
    assert.deepEqual((await call('GET', `/api/worlds/${W}/map/imported/img1/pins`, jess)).json, { page: null, pins: [] });
    assert.ok(one(deps.db, 'SELECT 1 AS x FROM map_scales'));
  } finally { server.close(); server.closeAllConnections?.(); }
});
