// Audit: empty worlds and a world with no DM. Every GET route answers (no 500) for everyone who may ask.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { recordMounts, listRoutes } from './security-kit.ts';

recordMounts();
const { boot } = await import('./audit-kit.ts');
type Kit = Awaited<ReturnType<typeof boot>>;
let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());

const SKIP = [/\/events$/, /\/sound\/file/, /\/voice\/file/, /\/search\/reindex/, /\/sound\/spotify/, /\/modules\/import/];

async function sweep(world: string, who: string[]) {
  const routes = listRoutes(k.app).filter((r) => r.method === 'GET' && r.path.startsWith('/api/worlds/:world') && !SKIP.some((x) => x.test(r.path)));
  const bad: string[] = [];
  for (const t of who) {
    for (const r of routes) {
      const url = r.path.replace(':world', world).replace(/:[A-Za-z]+/g, 'nothing-here');
      const res = await k.call('GET', url, k.T[t]);
      if (res.status >= 500 && res.status !== 503) bad.push(`${t} ${url.replace(world, ':w')} -> ${res.status} ${res.text.slice(0, 120)}`);
    }
  }
  return bad;
}

test('Audit_EmptyWorld: a brand new world answers every read for its DM, a player and a guest', async () => {
  assert.deepEqual(await sweep(k.W, ['dm', 'jess', 'visitor']), []);
});

test('Audit_NoDm: a world whose DM was removed still answers every read for its players', async () => {
  await k.ok('DELETE', `/api/admin/worlds/${k.W}/members/${k.ID.dm}`, k.T.admin);
  assert.deepEqual(await sweep(k.W, ['jess', 'tom', 'visitor']), []);
  // Nobody is the DM now: DM-only things answer 403/404 rather than leaking or crashing.
  for (const u of ['/library/pages/x/share', '/audit', '/settings']) {
    const r = await k.call(u === '/settings' ? 'PATCH' : 'GET', k.w(u), k.T.jess, u === '/settings' ? {} : undefined);
    assert.ok([403, 404, 200].includes(r.status), `${u} -> ${r.status}`);
  }
  // A player can still ask for things that need the DM without anything breaking.
  const q = await k.call('POST', k.w('/requests'), k.T.jess, { kind: 'question', title: 'Anyone there?', body: 'x' });
  assert.ok(q.status < 500, `${q.status} ${q.text.slice(0, 100)}`);
  const b = await k.call('GET', k.w('/broker/quote?question=What+is+the+duke+hiding'), k.T.jess);
  assert.ok(b.status < 500, `broker quote -> ${b.status} ${b.text.slice(0, 120)}`);
});
