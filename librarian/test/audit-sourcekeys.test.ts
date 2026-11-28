// Audit: source keys, page shares and escalations, attacked from the edges.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';
import { one, run } from '../src/core/db.ts';
import { CAMPAIGN, KANKA_API, TOKENS, fakeKanka, type FakeEntity } from './sourcekeys-fake.ts';

const ENTITIES: FakeEntity[] = [
  { id: 1, name: 'Harbour Guild', entry: 'The guild meets at dawn on the quay.', priv: false },
  { id: 2, name: 'Jessamine Backstory', entry: 'Jessamine grew up in the salt flats ZJ1PUBLIC.', priv: true },
  { id: 3, name: 'Tomas Backstory', entry: 'Tomas once served the red fleet ZT1PUBLIC.', priv: true },
  { id: 5, name: 'Sealed Vault Plot', entry: 'The queen plans the flood ZD1GMPLOT.', priv: true },
];
const SEES = { [TOKENS.gm]: 'all' as const, [TOKENS.jess]: [1, 2], [TOKENS.tom]: [1, 3], [TOKENS.blanket]: 'all' as const };
const kanka = fakeKanka(((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch, { entities: ENTITIES, sees: SEES });

let k: Kit;
let SRC = '';
const PG: Record<number, string> = {};
before(async () => {
  k = await boot({ fetch: kanka.fetch });
  SRC = (await k.ok('POST', `/api/admin/worlds/${k.W}/sources`, k.T.admin, { kind: 'kanka-api', name: 'Kanka', config: { campaignId: CAMPAIGN, token: TOKENS.gm, apiUrl: KANKA_API }, defaultVisibility: 'party' })).id;
  await k.ok('POST', `/api/admin/sources/${SRC}/sync?wait=1`, k.T.admin);
  for (const n of [1, 2, 3, 5]) PG[n] = one<any>(k.deps.db, 'SELECT id FROM pages WHERE world_id = ? AND external_id = ?', k.W, `kanka:${n}`).id;
});
after(() => k?.close());

const SK = () => k.w('/source-keys');
const MODEL = { 'X-Alexandria-Caller': 'model' };

test('Audit_SourceKeys: the GM agent\'s live lookup does not name a classified page to the model', async () => {
  run(k.deps.db, "UPDATE pages SET visibility = 'classified', ai_body = NULL, ai_blocks = NULL, ai_properties = NULL, ai_frontmatter = NULL, player_body = NULL, broker_body = NULL WHERE id = ?", PG[5]);
  k.deps.library.touchClassified();
  const key = await k.ok('POST', SK(), k.T.gm, { sourceId: SRC, secret: TOKENS.gm, trust: 'per-user', uses: ['agent'], users: [k.ID.gm] });
  assert.ok(key.id);
  const r = await k.call('GET', `${SK()}/lookup?q=${encodeURIComponent('Sealed Vault Plot')}`, k.T.gm, undefined, MODEL);
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.text.includes('Sealed Vault Plot'), `a classified page title reached a model: ${r.text.slice(0, 300)}`);
  assert.ok(!r.text.includes('ZD1GMPLOT'));
});
