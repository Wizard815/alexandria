// Audit: an admin who is not a GM (docs/SECURITY.md: "being admin does not open a world's secrets").
// Every GET admin route is read as the table admin and the secrets seeded by the GM are searched for in the answers.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { recordMounts, listRoutes } from './security-kit.ts';

recordMounts();
const { boot } = await import('./audit-kit.ts');
type Kit = Awaited<ReturnType<typeof boot>>;
let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

const S = { page: 'ZQXADMINPAGE', body: 'ZQXADMINBODY', coin: 'ZQXADMINCOIN', item: 'ZQXADMINITEM', person: 'ZQXADMINPERSON', note: 'ZQXADMINNOTE' };

test('Audit_Admin: admin routes show plumbing, not what a GM keeps secret', async () => {
  const dm = (m: string, u: string, b?: unknown) => k.call(m, k.w(u), k.T.dm, b);
  await dm('PUT', '/library/pages', { path: `dm/${S.page}.md`, visibility: 'dm', body: `# T\n${S.body}` });
  await dm('POST', '/live/ledger', { owner: 'party', amountCp: 100, note: S.coin });
  await dm('POST', '/inventory', { owner: 'party', name: 'Ring', dmNote: S.item, reason: 'x' });
  await dm('POST', '/people', { name: S.person, visibility: 'dm' });
  await dm('POST', '/broker/notes', { topic: S.note, text: S.note });
  const routes = listRoutes(k.app).filter((r) => r.method === 'GET' && /^\/api\/admin\//.test(r.path));
  const found: string[] = [];
  for (const r of routes) {
    const url = r.path.replace(':world', k.W).replace(':wid', k.W).replace(/:id|:cid|:sid|:rid|:pid|:job/g, k.W);
    const res = await k.call('GET', url, k.T.admin);
    for (const [name, token] of Object.entries(S)) if (res.text.includes(token)) found.push(`${name} in ${url} (${res.status})`);
  }
  assert.deepEqual(found, [], 'an admin (not a member of the world) can read GM-only text');
});
