// The gateway: health, security headers, backups, rate limit, public URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';

async function start(env: Record<string, string> = {}) {
  const { app } = createApp({ env, noScheduler: true });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('TestGateway_HealthHeadersAndBackup', async () => {
  const { server, base } = await start();
  try {
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('x-frame-options'), 'DENY');
    assert.equal((await h.json() as any).status, 'ok');
    const setup = await (await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'wizard', password: 'correct horse battery' }) })).json() as any;
    assert.equal((await fetch(`${base}/api/admin/backup`)).status, 401);
    const b = await fetch(`${base}/api/admin/backup`, { headers: { Authorization: `Bearer ${setup.token}` } });
    assert.equal(b.status, 200);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alx-b-')), 'b.db');
    fs.writeFileSync(tmp, Buffer.from(await b.arrayBuffer()));
    const copy = new DatabaseSync(tmp);
    assert.equal((copy.prepare('SELECT username FROM accounts').get() as any).username, 'wizard', 'the backup is a working database');
    copy.close();
    const o = await (await fetch(`${base}/api/admin/overview`, { headers: { Authorization: `Bearer ${setup.token}` } })).json() as any;
    assert.ok(Array.isArray(o.runs) && o.system && 'publicUrl' in o.system);
  } finally {
    server.close();
  }
});

test('TestGateway_RateLimit', async () => {
  const { server, base } = await start({ ALX_RATE_LIMIT: '5' });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await fetch(`${base}/api/setup`)).status);
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(codes[6], 429);
    assert.equal((await fetch(`${base}/health`)).status, 200, 'health is not limited');
  } finally {
    server.close();
  }
});
