// Audit: deleting a world, and recreating one with the same name, must leave nothing of the old world on disk or in the new one.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

const files = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : []);

test('Audit_WorldDelete: a deleted world leaves no vault, party or _api files, so a new world of the same name starts empty', async () => {
  await k.ok('PUT', k.w('/library/pages'), k.T.dm, { path: 'old/Secret.md', visibility: 'dm', body: '# Secret\nZQXOLDWORLDSECRET' });
  await k.ok('PUT', k.w('/library/pages'), k.T.dm, { path: 'old/Shared.md', visibility: 'party', body: '# Shared\nZQXOLDWORLDPARTY' });
  const dir = path.join(k.tmp, 'data', 'worlds', 'harbourtown');
  assert.ok(files(dir).length > 0, 'the world has files while it exists');
  await k.ok('DELETE', `/api/admin/worlds/${k.W}`, k.T.admin, { confirm: true });
  const left = files(dir);
  assert.deepEqual(left, [], `files of a deleted world are still on disk: ${left.join(', ')}`);
  // Same slug again, another DM.
  const nw = await k.ok('POST', '/api/admin/worlds', k.T.admin, { name: 'Harbourtown', dmAccountId: k.ID.dm2 });
  const mirrored = files(dir).filter((f) => f.endsWith('.md'));
  assert.deepEqual(mirrored, [], `the new world starts with the old world's files: ${mirrored.join(', ')}`);
  void nw;
});
