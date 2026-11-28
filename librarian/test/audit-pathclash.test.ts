// Audit: a page path that is also another page's folder. In its own file because the failure it shows poisons the world.
// Another agent owns core/library.ts, so this stays a todo until the patch in the audit report is applied
// (make Library.mirror best effort: the database is the source of truth, the files are a copy).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());
const put = (body: unknown) => k.call('PUT', k.w('/library/pages'), k.T.gm, body);

test('Audit_Paths: a page below another page\'s file name does not break saving every later page', async () => {
  assert.equal((await put({ path: 'clash/Dup.md', body: 'file first' })).status, 200);
  const b = await put({ path: 'clash/Dup.md/Child.md', body: 'a page below a file' });
  assert.ok(b.status < 500, `a page below another page's file name -> ${b.status} ${b.text.slice(0, 100)}`);
  const later = await put({ path: 'fine/Unrelated.md', body: 'an unrelated new page' });
  assert.equal(later.status, 200, `an unrelated new page can no longer be saved: ${later.status} ${later.text.slice(0, 100)}`);
});
