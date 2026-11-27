// A share made by someone who then loses sight of the page ends with theirs,
// down the chain, and does not come back when the first share is made again.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { all } from '../src/core/db.ts';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

const rows = (page: string) => all<any>(k.deps.db, 'SELECT from_id, to_id, kind FROM sourcekeys_shares WHERE world_id = ? AND page_id = ?', k.W, page);
const status = async (who: string, page: string) => (await k.call('GET', k.w(`/library/pages/${page}`), k.T[who])).status;
const newPage = async (name: string) => (await k.ok('PUT', k.w('/library/pages'), k.T.dm, { path: `shared/${name}.md`, visibility: 'dm', body: `# ${name}\nThe ${name} TEXT is for sharing.\n` })).id as string;

test('Shares_UnshareCascadesToWhatTheSharerSharedOnward', async () => {
  const p = await newPage('Cascade One');
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.dm, { to: [k.ID.jess] });
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.jess, { to: [k.ID.tom] });
  assert.equal(await status('tom', p), 200);
  assert.equal(rows(p).length, 2);
  // The GM stops sharing with jess: tom's access ends and the row goes too.
  await k.ok('DELETE', k.w(`/library/pages/${p}/share?to=${k.ID.jess}`), k.T.dm);
  assert.equal(await status('jess', p), 404);
  assert.equal(await status('tom', p), 404);
  assert.deepEqual(rows(p), [], 'no orphan row is left to come back');
  // Sharing with jess again does not revive tom.
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.dm, { to: [k.ID.jess] });
  assert.equal(await status('jess', p), 200);
  assert.equal(await status('tom', p), 404, 'tom must be shared with again');
  assert.equal(rows(p).length, 1);
});

test('Shares_ChainsOfThreeEndTogether', async () => {
  const p = await newPage('Cascade Chain');
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.dm, { to: [k.ID.jess] });
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.jess, { to: [k.ID.tom] });
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.tom, { to: 'party' });
  assert.equal(rows(p).length, 3);
  await k.ok('DELETE', k.w(`/library/pages/${p}/share`), k.T.dm);
  assert.deepEqual(rows(p), []);
});

test('Shares_LevelChangeAndMemberRemovalEndShares', async () => {
  const p = await newPage('Cascade Level');
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.dm, { to: [k.ID.jess] });
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.jess, { to: [k.ID.tom] });
  await k.ok('PUT', k.w(`/library/pages/${p}/level`), k.T.dm, { level: 'broker' });
  assert.deepEqual(rows(p), [], 'a level change ends them all');
  await k.ok('PUT', k.w(`/library/pages/${p}/level`), k.T.dm, { level: 'dm' });
  assert.equal(await status('tom', p), 404);

  // A removed member: what they shared onward ends with them, and does not return if they are added back.
  const q = await newPage('Cascade Member');
  await k.ok('POST', k.w(`/library/pages/${q}/share`), k.T.dm, { to: [k.ID.jess] });
  await k.ok('POST', k.w(`/library/pages/${q}/share`), k.T.jess, { to: [k.ID.tom] });
  assert.equal(await status('tom', q), 200);
  await k.ok('DELETE', `/api/admin/worlds/${k.W}/members/${k.ID.jess}`, k.T.admin);
  assert.deepEqual(rows(q), []);
  assert.equal(await status('tom', q), 404);
  await k.ok('PUT', `/api/admin/worlds/${k.W}/members/${k.ID.jess}`, k.T.admin, { role: 'player' });
  await k.ok('POST', k.w(`/library/pages/${q}/share`), k.T.dm, { to: [k.ID.jess] });
  assert.equal(await status('tom', q), 404, 'jess being back does not bring tom back');
});

test('Shares_APlayerCannotRemoveSomeoneElsesShareAndTheViewSaysWhoMadeIt', async () => {
  const p = await newPage('Cascade Mine');
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.dm, { to: [k.ID.jess] });
  const asJess = await k.ok('GET', k.w(`/library/pages/${p}/share`), k.T.jess);
  const mineFirst = asJess.shares.find((s: any) => s.to === k.ID.jess);
  assert.equal(mineFirst.from, k.ID.dm);
  assert.equal(mineFirst.mine, false, 'jess did not make the GM share');
  await k.ok('POST', k.w(`/library/pages/${p}/share`), k.T.jess, { to: [k.ID.tom] });
  const again = await k.ok('GET', k.w(`/library/pages/${p}/share`), k.T.jess);
  assert.equal(again.shares.find((s: any) => s.to === k.ID.tom).mine, true);
  // Trying to end the GM's share as jess says so, instead of silently doing nothing.
  const r = await k.call('DELETE', k.w(`/library/pages/${p}/share?to=${k.ID.jess}`), k.T.jess);
  assert.equal(r.status, 403, r.text);
  assert.match(r.body.error, /did not make|only the person/i);
  assert.equal(await status('jess', p), 200);
});
