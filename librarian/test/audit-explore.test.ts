import { test, after } from 'node:test';
import { boot } from './audit-kit.ts';
const k = await boot();
after(() => k.close());
test('Audit_Explore: smoke', async () => {
  const r = await k.call('GET', k.w('/members'), k.T.dm);
  console.log(r.status, r.text.slice(0, 400));
  const s = await k.call('GET', k.w('/settings'), k.T.dm);
  console.log(s.text);
});
