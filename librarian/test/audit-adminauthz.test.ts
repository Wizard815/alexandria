// Audit: no admin route (including /api/admin/gateway/*) answers a DM, a player or a guest.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { recordMounts, listRoutes } from './security-kit.ts';

recordMounts();
const { boot } = await import('./audit-kit.ts');
type Kit = Awaited<ReturnType<typeof boot>>;
let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

test('Audit_Admin: admin routes refuse non-admins, and the admin gets no world content from the gateway routes', async () => {
  const routes = listRoutes(k.app).filter((r) => /^\/api\/admin\//.test(r.path) && !/\/crawl|\/sync|\/test|\/warm|\/unload|\/discover|\/backup/.test(r.path));
  assert.ok(routes.some((r) => r.path.startsWith('/api/admin/gateway/')), 'the gateway routes are listed');
  await k.call('PUT', k.w('/library/pages'), k.T.dm, { path: 'dm/ZQXGATEWAYPAGE.md', visibility: 'dm', body: '# T\nZQXGATEWAYBODY' });
  const bad: string[] = [];
  for (const who of ['dm', 'jess', 'visitor']) {
    for (const r of routes) {
      const res = await k.call(r.method, r.path.replace(/:[A-Za-z]+/g, k.W), k.T[who], r.method === 'GET' ? undefined : {});
      if (![401, 403].includes(res.status)) bad.push(`${who} ${r.method} ${r.path} -> ${res.status}`);
    }
  }
  assert.deepEqual(bad, []);
  const leaks: string[] = [];
  for (const r of routes.filter((x) => x.path.startsWith('/api/admin/gateway/') || x.path.includes('/worlds'))) {
    const res = await k.call(r.method, r.path.replace(/:[A-Za-z]+/g, k.W), k.T.admin, r.method === 'GET' ? undefined : {});
    if (/ZQXGATEWAY/.test(res.text)) leaks.push(`${r.method} ${r.path}`);
  }
  assert.deepEqual(leaks, []);
});
