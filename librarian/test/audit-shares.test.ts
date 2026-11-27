// Audit: page shares and the player copy of hand-written pages.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

test('Audit_Shares: a GM share dies when the page rises above dm, and never reaches search or bulk', async () => {
  const p = await k.ok('PUT', k.w('/library/pages'), k.T.dm, { path: 'shared/Toll Road.md', visibility: 'dm', body: '# Toll Road\nThe toll road ZSHARE1PUBLIC is watched.\n\n> [!secret]\n> ZSHARE1SECRET the keeper is bribed\n' });
  const asJess = (u: string) => k.call('GET', k.w(u), k.T.jess);
  assert.equal((await asJess(`/library/pages/${p.id}`)).status, 404, 'not shared yet');
  await k.ok('POST', k.w(`/library/pages/${p.id}/share`), k.T.dm, { to: [k.ID.jess] });
  const open = await asJess(`/library/pages/${p.id}`);
  console.log('shared hand-written dm page ->', open.status, open.text.slice(0, 200));
  if (open.status === 200) assert.ok(!open.text.includes('ZSHARE1SECRET'));
  await k.ok('PUT', k.w(`/library/pages/${p.id}/level`), k.T.dm, { level: 'broker' });
  for (const u of [`/library/pages/${p.id}`, `/library/pages/${p.id}/markdown`, `/library/search?q=Toll`, `/library/pages`]) {
    const r = await asJess(u);
    assert.ok(!r.text.includes('ZSHARE1') && !r.text.includes('Toll Road'), `${u} still shows a page that rose to broker: ${r.text.slice(0, 200)}`);
  }
  const bulk = await k.call('POST', k.w('/library/pages/bulk'), k.T.jess, { ids: [p.id] });
  assert.ok(!bulk.text.includes('ZSHARE1'), bulk.text.slice(0, 200));
  await k.ok('PUT', k.w(`/library/pages/${p.id}/level`), k.T.dm, { level: 'dm' });
  const back = await asJess(`/library/pages/${p.id}`);
  console.log('after the level fell back to dm ->', back.status);
});
