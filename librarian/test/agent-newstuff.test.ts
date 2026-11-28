// New things and the assistant: a house rule with no assistant part still brings its rule text, the compact house
// rules list puts the DM's own rules first, a new item the DM's message names reaches the assistant with the item
// tools, a player's helper learns what the items they hold are (never the DM's notes), and "what's new" lists what
// was added. See web/e2e/buildup-real.mjs for the same with real models.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { ruleHints } from '../src/features/mods/assist.ts';
import { heldItemFacts, itemHints } from '../src/features/shop/assist.ts';
import { selectTools } from '../src/features/agent/intent.ts';
import { allTools } from '../src/routes/mcpServer.ts';

let base = '';
let server: any;
let db: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';

async function ok(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(json)}`);
  return json;
}

const CORRUPTION = {
  kit: 2, id: 'shrine-corruption', name: 'Shrine corruption', version: '1.0.0', summary: 'The drowned shrine marks those who listen to it.',
  resources: [{ id: 'corruption', label: 'Corruption', icon: 'fa-skull', max: 5, start: 0 }],
  actions: [{ id: 'mark', label: 'Mark', by: 'dm', resource: 'corruption', add: 1 }],
  rules: [{ term: 'Corruption (house rule)', text: 'At **3 or more** corruption you have disadvantage on Wisdom saving throws.' }],
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-newstuff-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  db = made.deps.db;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Newholm', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' });
  T.jess = j.token;
  ID.jess = j.account.id;
  // A busy world: a few shipped rules on, then the DM's own.
  for (const id of ['luck-points', 'lingering-injuries', 'potion-bonus-action', 'stress', 'honor']) await ok('PUT', `/api/worlds/${W}/mods/${id}/enabled`, T.dm, { on: true, cascade: true });
  await ok('POST', `/api/worlds/${W}/mods/import`, T.dm, { mod: CORRUPTION });
  await ok('PUT', `/api/worlds/${W}/mods/shrine-corruption/enabled`, T.dm, { on: true });
  await ok('POST', `/api/worlds/${W}/shop/items`, T.dm, { name: 'Emberglass Lantern', type: 'wondrous item', rarity: 'uncommon', cost: '350 gp', description: 'Its light shows invisible undead within 30 feet.', dmNotes: 'Made by the shrine priests.' });
  await ok('POST', `/api/worlds/${W}/templates/import`, T.dm, { type: 'alexandria-templates', version: 1, name: 'Haunted', exported: '2026-11-27T00:00:00Z', alexandria: '0.1.0', templates: [{ kind: 'guide', name: 'Haunted inns', triggers: ['haunted inn'], spec: { task: 'Make a haunted inn', instructions: 'A ghost with unfinished business.', steps: [], sections: ['Overview'] } }] });
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('NewStuff: a house rule with no assistant part brings its own rule text to the player helper', () => {
  const h = ruleHints(db, W, 'what happens if my corruption keeps going up?', false, ID.jess);
  assert.deepEqual(h.mods, ['shrine-corruption']);
  assert.match(h.text, /The rule: At 3 or more corruption you have disadvantage on Wisdom saving throws/);
  assert.doesNotMatch(h.text, /\*\*/);
});

test('NewStuff: the compact house rules list puts the DM\'s own rules first and names the rest', async () => {
  const b = await ok('GET', `/api/worlds/${W}/mods?brief=1`, T.dm);
  assert.equal(b.on[0].id, 'shrine-corruption');
  assert.equal(b.on[0].source, 'added by the DM');
  assert.match(b.on[0].rule, /disadvantage on Wisdom/);
  assert.ok(b.off.length > 5 && b.off.every((x: unknown) => typeof x === 'string'));
  assert.ok(JSON.stringify(b).length < 8000, 'small enough for a tool result');
  const p = await ok('GET', `/api/worlds/${W}/mods?brief=1`, T.jess);
  assert.equal(p.off, undefined);
  assert.equal(allTools().find((t) => t.name === 'house_rules')!.call({}).path, '/mods?brief=1');
});

test('NewStuff: a new item the DM names reaches the assistant with the item tools', () => {
  const h = itemHints(db, W, 'Give Jessamine an Emberglass Lantern.');
  assert.deepEqual(h.items, ['Emberglass Lantern']);
  assert.match(h.text, /invisible undead/);
  assert.match(h.text, /350 gp/);
  assert.match(h.text, /DM notes: Made by the shrine priests/);
  for (const t of ['search_items', 'add_item']) assert.ok(h.tools.includes(t));
  assert.deepEqual(itemHints(db, W, 'Light a lantern').items, [], 'short or partial names do not match');
});

test('NewStuff: the helper learns what a held item is, without the DM notes', () => {
  const f = heldItemFacts(db, W, ['Emberglass Lantern', 'Bag of nothing']);
  assert.equal(f.size, 1);
  const line = [...f.values()][0];
  assert.match(line, /invisible undead/);
  assert.doesNotMatch(line, /shrine priests|350/);
});

test('NewStuff: what\'s new lists the house rule, the item and the templates, DM only', async () => {
  const n = await ok('GET', `/api/worlds/${W}/whats-new`, T.dm);
  assert.ok(n.houseRules.some((x: any) => /shrine-corruption/.test(x.what)));
  assert.ok(n.items.some((x: any) => /Emberglass Lantern/.test(x.what)));
  assert.ok(n.templates.some((x: any) => /Haunted inns/.test(x.what)));
  const r = await fetch(`${base}/api/worlds/${W}/whats-new`, { headers: { Authorization: `Bearer ${T.jess}` } });
  assert.equal(r.status, 403);
  const names = allTools().map((t) => t.name);
  assert.ok(selectTools('What have I added to this world lately?', names).includes('whats_new'));
  assert.ok(selectTools("what's new since last session", names).includes('whats_new'));
});
