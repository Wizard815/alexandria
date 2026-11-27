// The Obsidian Portal connector against a fake Obsidian Portal that follows its API v1 help pages (wiki pages, characters, users/me).
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { oauthHeader, opShared } from '../src/intake/connectors/obsidianportal.ts';

const player = { accountId: 'p', role: 'player' as const };
const dm = { accountId: 'a', role: 'dm' as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const KEYS = { consumerKey: 'ck_123', consumerSecret: 'cs_456', accessToken: 'at_789', accessSecret: 'as_000' };

test('TestObsidianPortal_OAuthSignatureMatchesRfc5849', () => {
  // RFC 5849 section 1.2's worked example (it is the HMAC-SHA1 signature of the photos request).
  const h = oauthHeader('GET', 'http://photos.example.net/photos?file=vacation.jpg&size=original',
    { consumerKey: 'dpf43f3p2l4k3l03', consumerSecret: 'kd94hf93k423kf44', token: 'nnch734d00sl2jdk', tokenSecret: 'pfkkdhi9sl3r4s00' }, {}, 'kllo9940pd9333jh', '1191242096');
  assert.match(h, /oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"/);
  assert.ok(h.startsWith('OAuth ') && h.includes('oauth_token="nnch734d00sl2jdk"'));
});

test('TestObsidianPortal_VisibilityFailsClosed', () => {
  assert.equal(opShared({ is_game_master_only: false }, false), true);
  assert.equal(opShared({ is_game_master_only: true }, false), false);
  assert.equal(opShared({}, false), false, 'not said: the GM\'s');
  assert.equal(opShared({ is_game_master_only: false, visibility: 'public' }, true), true);
  assert.equal(opShared({ is_game_master_only: false, visibility: 'friends' }, true), true);
  assert.equal(opShared({ is_game_master_only: false, visibility: 'private' }, true), false);
  assert.equal(opShared({ is_game_master_only: false }, true), false);
});

test('TestObsidianPortal_SyncKeepsGmOnlyPagesAndGmInfoFromPlayers', async () => {
  const seen: string[] = [];
  let badSig = 0;
  const wikis = [
    { id: 'w1', slug: 'port-town', name: 'Port Town', type: 'WikiPage', wiki_page_url: '/campaigns/realm/wikis/port-town', updated_at: '2026-11-01T00:00:00Z', tags: ['town'] },
    { id: 'w2', slug: 'the-plot', name: 'The plot', type: 'WikiPage', wiki_page_url: '/campaigns/realm/wikis/the-plot', updated_at: '2026-11-01T00:00:00Z' },
    { id: 'w3', slug: 'session-1', name: 'Session 1', type: 'Post', wiki_page_url: '/campaigns/realm/wikis/session-1', updated_at: '2026-11-01T00:00:00Z' },
  ];
  const full: Record<string, any> = {
    w1: { ...wikis[0], is_game_master_only: false, body_html: '<h2>Harbour</h2><p>A busy harbour. <a href="https://realm.obsidianportal.com/characters/mira">Mira</a> runs the inn.</p>', game_master_info_html: '<p>SMUGGLERS use the old pier.</p>' },
    w2: { ...wikis[1], is_game_master_only: true, body_html: '<p>PLOTTWIST the duke is a lich.</p>' },
    w3: { ...wikis[2], is_game_master_only: false, body_html: '<p>We met at the inn.</p>', post_title: 'Arrival', post_time: '2026-10-01T19:00:00Z' },
  };
  const chars = [
    { id: 'c1', slug: 'mira', name: 'Mira', character_url: '/campaigns/realm/characters/mira', visibility: 'public', updated_at: '2026-11-01T00:00:00Z', avatar_url: 'https://cdn.obsidianportal.com/mira.png' },
    { id: 'c2', slug: 'vorn', name: 'Vorn', character_url: '/campaigns/realm/characters/vorn', visibility: 'private', updated_at: '2026-11-01T00:00:00Z' },
  ];
  const cfull: Record<string, any> = {
    c1: { ...chars[0], is_game_master_only: false, is_player_character: false, tagline: 'Innkeeper', description_html: '<p>Keeps the inn.</p>', game_master_info: 'SPYMASTER for the duke' },
    c2: { ...chars[1], is_game_master_only: false, description_html: '<p>VORNSECRET the lich</p>' },
  };
  const f = (async (url: string, init: any = {}) => {
    seen.push(url);
    if (url === 'https://cdn.obsidianportal.com/mira.png') { assert.equal(init.headers?.Authorization, undefined, 'no keys sent to the picture host'); return new Response('nf', { status: 404 }); }
    const auth = String(init.headers?.Authorization ?? '');
    const nonce = /oauth_nonce="([^"]+)"/.exec(auth)?.[1] ?? '';
    const ts = /oauth_timestamp="([^"]+)"/.exec(auth)?.[1] ?? '';
    const expect = oauthHeader('GET', url, { consumerKey: KEYS.consumerKey, consumerSecret: KEYS.consumerSecret, token: KEYS.accessToken, tokenSecret: KEYS.accessSecret }, {}, nonce, ts);
    if (auth !== expect) { badSig++; return json({ error: 'bad signature' }, 401); }
    const p = new URL(url).pathname;
    if (p === '/v1/users/me.json') return json({ id: 'u1', username: 'gm', campaigns: [{ id: 'camp1', name: 'The Realm', slug: 'realm', role: 'game_master', campaign_url: 'https://realm.obsidianportal.com' }] });
    if (p === '/v1/campaigns/camp1/wikis.json') return json(wikis);
    if (p === '/v1/campaigns/camp1/characters.json') return json(chars);
    let m = /^\/v1\/campaigns\/camp1\/wikis\/(\w+)\.json$/.exec(p);
    if (m) return full[m[1]] ? json(full[m[1]]) : json({}, 404);
    m = /^\/v1\/campaigns\/camp1\/characters\/(\w+)\.json$/.exec(p);
    if (m) return cfull[m[1]] ? json(cfull[m[1]]) : json({}, 404);
    return json({}, 404);
  }) as unknown as typeof fetch;
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', 'obsidian-portal', 'S', ?, 'party')`, JSON.stringify({ campaign: 'https://www.obsidianportal.com/campaigns/realm', ...KEYS }));
  const lib = new Library(db, null);
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: f, env: {}, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  assert.equal(badSig, 0, 'every request is signed correctly');
  assert.ok(seen.every((u) => u.startsWith('https://api.obsidianportal.com/v1/') || u.endsWith('mira.png')), 'only the API host (and the portrait)');
  assert.deepEqual(lib.list('w', dm).map((p: any) => p.title).sort(), ['Mira', 'Port Town', 'Session 1', 'The plot', 'Vorn']);
  assert.deepEqual(lib.list('w', player).map((p: any) => p.title).sort(), ['Mira', 'Port Town', 'Session 1'], 'GM-only pages and private characters stay GM-only');
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const pl = JSON.stringify(lib.get('w', town.id, player));
  assert.ok(pl.includes('busy harbour') && !pl.includes('SMUGGLERS'), 'GM info is a secret');
  assert.ok(JSON.stringify(lib.get('w', town.id, dm)).includes('SMUGGLERS'));
  assert.ok(pl.includes('op:c1'), 'the link to Mira points at her page here');
  const mira = lib.list('w', player).find((p: any) => p.title === 'Mira') as any;
  const mj = JSON.stringify(lib.get('w', mira.id, player));
  assert.ok(mj.includes('Innkeeper') && !mj.includes('SPYMASTER'));
});
