// Free content sources: Open5e books and a fresh 5e SRD API copy become game
// modules, and in the same step their spells go into the Codex and their items
// into the shop. Both services are faked here (fixtures shaped like their real
// answers); the SRD converter is checked against the bundled module.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { castingTime, creatureOf, spellOf } from '../src/features/modules/open5e.ts';
import { buildSrd } from '../src/features/modules/srd5e.ts';
import { clearSourceCache } from '../src/features/modules/sources.ts';
import { builtin } from '../src/features/modules/store.ts';
import { normalizeModule } from '../src/features/modules/format.ts';

const FIX = JSON.parse(fs.readFileSync(new URL('./srd5e-fixture.json', import.meta.url), 'utf8'));

// ---- Open5e fixtures (trimmed real records) --------------------------------
const doc = (key: string, name: string, lic = 'ogl-10a') => ({ key, name, display_name: name, licenses: [{ name: lic === 'ogl-10a' ? 'OPEN GAME LICENSE Version 1.0a' : 'Creative Commons Attribution 4.0', key: lic }], publisher: { name: 'Kobold Press', key: 'kobold-press' }, gamesystem: { name: '5th Edition 2014', key: '5e-2014' }, permalink: `https://koboldpress.example/${key}`, desc: `*Tagline*\r\n\r\nThe ${name} is a big book of things for fifth edition games.` });
const DOCS = [doc('tob', 'Tome of Beasts'), doc('deepm', 'Deep Magic for 5th Edition'), doc('vom', 'Vault of Magic'), { ...doc('srd-2024', 'System Reference Document 5.2', 'cc-by-40'), gamesystem: { name: '5th Edition 2024', key: '5e-2024' } }];
const ref = (key: string) => ({ key, name: DOCS.find((d) => d.key === key)!.name });
const CREATURE = {
  key: 'tob_nihileth', name: 'Nihileth', document: ref('tob'), type: { name: 'Aberration', key: 'aberration' }, size: { name: 'Large', key: 'large' }, challenge_rating: 12.0,
  speed: { walk: 30, unit: 'feet', swim: 30, fly: 30, hover: true }, alignment: 'chaotic evil', languages: { as_string: 'Void Speech, telepathy 120 ft.' }, armor_class: 17, armor_detail: 'natural armor', hit_points: 135, hit_dice: '18d10+36',
  experience_points: 8400, ability_scores: { strength: 21, dexterity: 9, constitution: 15, intelligence: 18, wisdom: 15, charisma: 18 }, saving_throws: { constitution: 6, intelligence: 8 }, skill_bonuses: { history: 12, sleight_of_hand: 3 }, passive_perception: 12,
  resistances_and_immunities: { damage_immunities_display: 'cold, necrotic, poison', damage_immunities: [{ name: 'Cold' }], damage_resistances_display: '', damage_resistances: [{ name: 'Acid', key: 'acid' }], damage_vulnerabilities_display: '', damage_vulnerabilities: [], condition_immunities_display: '', condition_immunities: [] },
  darkvision_range: 120, blindsight_range: null, tremorsense_range: null, truesight_range: null,
  traits: [{ name: 'Dual State', desc: 'A nihileth exists in one of two forms.' }],
  actions: [
    { name: 'Void Body', desc: 'The nihileth reshapes itself.', action_type: 'LEGENDARY_ACTION', order_in_statblock: 5, legendary_action_cost: 2, usage_limits: null },
    { name: 'Tentacle', desc: 'Melee Weapon Attack: +9 to hit, reach 10 ft., one target. Hit: 12 (2d6 + 5) bludgeoning damage.', action_type: 'ACTION', order_in_statblock: 1, legendary_action_cost: null, usage_limits: null },
    { name: 'Void Gaze', desc: 'Each creature within 30 feet must make a DC 16 Wisdom saving throw.', action_type: 'ACTION', order_in_statblock: 2, usage_limits: { type: 'RECHARGE_ON_ROLL', param: 5 } },
    { name: 'Slip Away', desc: 'The nihileth moves.', action_type: 'BONUS_ACTION', order_in_statblock: 3 },
    { name: 'Repel', desc: 'The nihileth pushes back.', action_type: 'REACTION', order_in_statblock: 4 },
  ],
  environments: [{ name: 'Ocean', key: 'ocean' }, { name: 'Caves', key: 'caves' }],
};
const SPELL = {
  key: 'deepm_abhorrent-apparition', name: 'Abhorrent Apparition', document: ref('deepm'), school: { name: 'Illusion', key: 'illusion' }, classes: [{ name: 'Bard' }, { name: 'Wizard' }],
  desc: 'You imbue a terrifying visage onto a gourd and toss it ahead of you. Each creature within 30 feet must make a Wisdom saving throw, taking 4d6 psychic damage on a failed save.', level: 4,
  higher_level: 'The damage increases by 1d6 for each slot level above 4th.', range_text: '60 feet', range: 60, ritual: false, casting_time: 'bonus-action', verbal: true, somatic: true, material: true,
  material_specified: 'a gourd with a face carved on it', saving_throw_ability: 'wisdom', damage_types: ['psychic'], duration: 'instantaneous', concentration: false,
};
const SPELL2 = { ...SPELL, key: 'deepm_quick-ward', name: 'Quick Ward', level: 0, casting_time: '10minutes', duration: '1 hour', concentration: true, ritual: true, material: false, material_specified: '', damage_types: [], saving_throw_ability: '', desc: 'A faint ward hums around you.', higher_level: '' };
const SRD_SPELL = { ...SPELL, key: 'srd-2024_fireball', name: 'Fireball', document: ref('srd-2024'), level: 3, school: { name: 'Evocation' } };
const ITEM = { key: 'vom_aberrant-agreement', name: 'Aberrant Agreement', desc: 'This long scroll bears strange runes.', category: { name: 'Scroll', key: 'scroll' }, rarity: { name: 'Rare', key: 'rare' }, weight: '0.000', weight_unit: 'lb', cost: '0.00', requires_attunement: false, document: ref('vom') };
const ITEM2 = { ...ITEM, key: 'vom_amulet-of-the-void', name: 'Amulet of the Void', category: { name: 'Wondrous Item' }, rarity: { name: 'Very Rare' }, weight: '1.000', cost: '1500.00', requires_attunement: true, attunement_detail: 'by a warlock', desc: 'A black stone amulet.' };
const STRAY = { ...ITEM, key: 'srd_bag', name: 'Bag of Stray Things', document: { key: 'srd-2014', name: 'SRD 5.1' } };

const hits: string[] = [];
const fakeFetch = (async (url: any, init?: any) => {
  const u = new URL(String(url));
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.host === 'open5e.example.test') {
    hits.push(u.pathname + u.search);
    const list = u.pathname.replace(/^\/v2\/|\/$/g, '');
    if (list === 'documents') return json({ count: DOCS.length, next: null, results: DOCS });
    const want = (u.searchParams.get('document__key__in') ?? '').split(',');
    const all: Record<string, any[]> = { creatures: [CREATURE], spells: [SPELL, SPELL2, SRD_SPELL], magicitems: [ITEM, STRAY, ITEM2], items: [], conditions: [], feats: [{ key: 'tob_x', name: 'Void Touched', document: ref('tob'), desc: 'You have stared into the void.', prerequisite: '*Wisdom 13*', type: 'GENERAL', benefits: [{ desc: 'Increase your Wisdom by 1.' }] }], backgrounds: [], species: [] };
    if (!(list in all)) return json({ detail: 'Not found.' }, 404);
    // Magic items come in two pages, the second named on Open5e's own host (as the real API does).
    const rows = all[list].filter((x) => want.includes(x.document.key) || x === STRAY);
    if (list === 'magicitems') {
      const page = Number(u.searchParams.get('page') ?? 1);
      if (page === 1) return json({ count: rows.length, next: `https://api.open5e.com/v2/magicitems/?document__key__in=${want.join('%2C')}&limit=500&format=json&page=2`, results: rows.slice(0, 2) });
      return json({ count: rows.length, next: null, results: rows.slice(2) });
    }
    return json({ count: rows.length, next: null, results: rows });
  }
  if (u.host === 'srd.example.test') {
    hits.push(u.pathname);
    const m = /^\/db\/2014\/en\/5e-SRD-(.+)\.json$/.exec(u.pathname);
    if (m && FIX[m[1]]) return json(FIX[m[1]]);
    return new Response('404: Not Found', { status: 404 });
  }
  return fetch(url, init);
}) as typeof fetch;

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
let W = '';
const M = () => `/api/worlds/${W}/modules`;
async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
};
const O5 = { base: 'http://open5e.example.test' };

before(async () => {
  clearSourceCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-src-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ALLOW_LOCAL_URLS: '1', ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' }, fetch: fakeFetch });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Bookland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
});
after(() => { server?.close(); server?.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Sources: the SRD converter still makes the bundled module, term for term', async () => {
  const terms = await buildSrd('2014', async (n) => FIX[n] ?? []);
  const { module } = normalizeModule({ id: 'x', name: 'x', terms });
  const bundled = builtin('dnd-2014')!;
  for (const t of module.terms) {
    const b = bundled.terms.find((x) => x.id === t.id);
    assert.ok(b, `${t.id} is in the bundled module`);
    assert.deepEqual({ text: t.text, summary: t.summary, data: t.data ?? null }, { text: b.text, summary: b.summary, data: b.data ?? null }, t.id);
  }
  assert.equal(module.terms.length, 5);
});

test('Sources: Open5e records become the same shapes as SRD terms', () => {
  assert.equal(castingTime('bonus-action'), 'Bonus Action');
  assert.equal(castingTime('10minutes'), '10 minutes');
  assert.equal(castingTime('reaction', 'which you take when you are hit'), 'Reaction, which you take when you are hit');
  const m = creatureOf(CREATURE);
  const d: any = m.data;
  assert.equal(m.kind, 'monster');
  assert.deepEqual([d.cr, d.xp, d.ac, d.hp, d.hitDice, d.type, d.size], [12, 8400, 17, 135, '18d10 + 36', 'aberration', 'Large']);
  assert.deepEqual(d.abilities, { str: 21, dex: 9, con: 15, int: 18, wis: 15, cha: 18 });
  assert.deepEqual(d.speed, { walk: '30 ft.', swim: '30 ft.', fly: '30 ft.', hover: true });
  assert.deepEqual(d.savingThrows, { con: 6, int: 8 });
  assert.deepEqual(d.skills, { History: 12, 'Sleight Of Hand': 3 });
  assert.deepEqual(d.immunities, ['cold, necrotic, poison']);
  assert.deepEqual(d.resistances, ['acid']);
  assert.deepEqual(d.environments, ['Ocean', 'Caves']);
  assert.deepEqual(d.actions.map((a: any) => a.name), ['Tentacle', 'Void Gaze (Recharge 5–6)']);
  assert.deepEqual([d.bonusActions[0].name, d.reactions[0].name, d.legendaryActions[0].name], ['Slip Away', 'Repel', 'Void Body (Costs 2 Actions)']);
  assert.match(m.text, /^\*Large aberration, chaotic evil\*\n\n\*\*AC\*\* 17 \(natural armor\) · \*\*HP\*\* 135 \(18d10 \+ 36\) · \*\*Speed\*\* walk 30 ft\., swim 30 ft\., fly 30 ft\., hover/);
  assert.match(m.text, /\| 21 \(\+5\) \| 9 \(-1\) \|/);
  assert.match(m.text, /\*\*CR\*\* 12 \(8,400 XP\)/);
  assert.match(m.summary, /CR 12 · AC 17 · HP 135/);
  const s = spellOf(SPELL);
  assert.match(s.text, /^\*Level 4 Illusion \(Bard, Wizard\)\*\n\n\*\*Casting Time:\*\* Bonus Action/);
  assert.match(s.text, /\*\*Components:\*\* V, S, M \(a gourd with a face carved on it\)/);
  assert.match(s.text, /\*\*At Higher Levels\.\*\* The damage increases/);
  assert.deepEqual([(s.data as any).damageTypes, (s.data as any).saves, (s.data as any).duration], [['Psychic'], ['Wisdom'], 'Instantaneous']);
});

test('Sources: the DM sees the Open5e books; players do not', async () => {
  const r = await ok('GET', `${M()}/sources?open5e=${encodeURIComponent(O5.base)}`, T.dm);
  assert.deepEqual(r.open5e.documents.map((d: any) => d.key), ['srd-2024', 'tob', 'deepm', 'vom'], '2024 books first');
  assert.equal(r.open5e.documents[1].license, 'OGL-1.0a');
  assert.match(r.open5e.documents[1].desc, /big book of things/);
  assert.deepEqual(r.dnd5eapi.editions.map((e: any) => e.id), ['2024', '2014']);
  assert.equal((await call('GET', `${M()}/sources`, T.jess)).status, 403);
});

test('Sources: Open5e books import as one module; spells go to the Codex and items to the shop', async () => {
  const req = { type: 'open5e', ...O5, documents: ['tob', 'deepm', 'vom', 'nope'] };
  const pre = await ok('POST', `${M()}/import/preview`, T.dm, req);
  assert.equal(pre.module.id, 'open5e-tob-deepm-vom');
  assert.equal(pre.module.name, 'Open5e: Tome of Beasts + Deep Magic for 5th Edition + Vault of Magic');
  assert.equal(pre.module.license, 'OGL-1.0a');
  assert.match(pre.module.attribution, /Tome of Beasts by Kobold Press, used under the OPEN GAME LICENSE Version 1\.0a/);
  assert.deepEqual(pre.counts, { spell: 2, monster: 1, item: 2, other: 1 }, 'the stray record from another book is dropped');
  assert.ok(pre.warnings.some((w: string) => /no book "nope"/.test(w)));
  // Paging followed the next link on the base the DM chose, not Open5e's own host.
  assert.ok(hits.some((h) => h.includes('/v2/magicitems/') && h.includes('page=2')));
  const before = hits.length;
  const saved = await ok('POST', `${M()}/import`, T.dm, { ...req, feed: { spells: true, items: true } });
  assert.equal(hits.length, before, 'the save reuses what the preview fetched');
  assert.deepEqual(saved.fed.spells, { added: 2, replaced: 0, skipped: 0 });
  assert.equal(saved.fed.items.added, 2);
  assert.ok(saved.modules.some((m: any) => m.id === 'open5e-tob-deepm-vom'), 'the module is on');

  // The monster card: whole for the DM, without the numbers for a player.
  const hit = (await ok('GET', `${M()}/terms?q=nihileth&kind=monster`, T.dm)).terms[0];
  const dmCard = await ok('GET', `${M()}/terms/${encodeURIComponent(hit.id)}`, T.dm);
  assert.equal(dmCard.data.cr, 12);
  const pc = await ok('GET', `${M()}/terms/${encodeURIComponent(hit.id)}`, T.jess);
  assert.equal(pc.data.ac, undefined);
  assert.ok(!/\*\*AC\*\*|\| STR \|/.test(pc.text));

  // Spells in the Codex, each with its own book as the source.
  const sp = (await ok('GET', `/api/worlds/${W}/spells/list?q=abhorrent`, T.dm)).spells[0];
  assert.equal(sp.source, 'Deep Magic for 5th Edition');
  assert.equal(sp.level, 4);
  assert.equal(sp.castingTime, 'Bonus Action');
  const ward = (await ok('GET', `/api/worlds/${W}/spells/list?q=quick%20ward`, T.dm)).spells[0];
  assert.deepEqual([ward.level, ward.ritual, ward.concentration, ward.castingTime], [0, true, true, '10 minutes']);

  // Items in the shop's database: a set price is kept, a missing one comes from the rarity band.
  const amulet = (await ok('GET', `/api/worlds/${W}/shop/items?q=amulet%20of%20the%20void`, T.dm)).items[0];
  assert.deepEqual([amulet.rarity, amulet.costCp, amulet.attunement, amulet.weight], ['very rare', 150000, true, 1]);
  const scroll = (await ok('GET', `/api/worlds/${W}/shop/items?q=aberrant`, T.dm)).items[0];
  assert.equal(scroll.type, 'scroll');
  assert.ok(scroll.costCp > 0);

  // Again with replace: nothing is added twice.
  const again = await ok('POST', `${M()}/import`, T.dm, { ...req, replace: true, feed: { spells: true, items: true } });
  assert.deepEqual([again.fed.spells.added, again.fed.items.added], [0, 0]);
  await ok('DELETE', `${M()}/imported/open5e-tob-deepm-vom`, T.dm);
});

test('Sources: an SRD book from Open5e does not copy the Codex SRD spells; kinds narrow an import', async () => {
  const saved = await ok('POST', `${M()}/import`, T.dm, { type: 'open5e', ...O5, documents: ['srd-2024'], kinds: ['spell'], feed: { spells: true } });
  assert.equal(saved.module.id, 'open5e-srd-2024');
  assert.deepEqual(saved.counts, { spell: 1 });
  assert.deepEqual(saved.fed.spells, { added: 0, replaced: 0, skipped: 1 }, 'Fireball is already in the SRD list');
  assert.ok(!hits.some((h) => h.includes('/v2/creatures/') && h.includes('srd-2024')), 'only the spell list was read');
  await ok('DELETE', `${M()}/imported/open5e-srd-2024`, T.dm);
});

test('Sources: Open5e requests are checked', async () => {
  const pre = (b: unknown) => call('POST', `${M()}/import/preview`, T.dm, b);
  assert.equal((await pre({ type: 'open5e', ...O5 })).status, 400);
  assert.equal((await pre({ type: 'open5e', ...O5, documents: ['../etc'] })).status, 400);
  assert.equal((await pre({ type: 'open5e', ...O5, documents: ['nope'] })).status, 400);
  assert.equal((await pre({ type: 'open5e', ...O5, documents: ['tob'], kinds: ['dragon'] })).status, 400);
  assert.equal((await pre({ type: 'open5e', base: 'ftp://x.test', documents: ['tob'] })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.jess, { type: 'open5e', ...O5, documents: ['tob'] })).status, 403);
});

test('Sources: a fresh 5e SRD API copy imports as its own module', async () => {
  const req = { type: 'dnd5eapi', base: 'http://srd.example.test/db', edition: '2014' };
  const pre = await ok('POST', `${M()}/import/preview`, T.dm, req);
  assert.equal(pre.module.id, 'dnd5eapi-2014');
  assert.match(pre.module.attribution, /SRD 5\.1.*5e SRD API/s);
  assert.deepEqual(pre.counts, { condition: 1, spell: 1, monster: 1, item: 2 }, 'files the database lacks (404) are skipped');
  const some = await ok('POST', `${M()}/import/preview`, T.dm, { ...req, kinds: ['monster'] });
  assert.deepEqual(some.counts, { monster: 1 });
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { ...req, edition: '2030' })).status, 400);
  const saved = await ok('POST', `${M()}/import`, T.dm, { ...req, feed: { items: true } });
  assert.equal(saved.fed.items.added, 0, 'the SRD 5.1 items are already in the item database by name');
  await ok('DELETE', `${M()}/imported/dnd5eapi-2014`, T.dm);
});

test('Sources: the server content library pulls a book once and every world can turn it on', async () => {
  const A = '/api/admin/content';
  const src = await ok('GET', `${A}/sources?open5e=${encodeURIComponent(O5.base)}`, T.admin);
  assert.equal(src.open5e.documents[0].key, 'srd-2024', '2024 books first');
  assert.equal(src.open5e.documents[0].edition, '2024');
  assert.equal(src.open5e.documents.find((d: any) => d.key === 'tob').edition, '2014');
  assert.equal((await call('GET', A, T.dm)).status, 403, 'admins only');
  assert.equal((await call('POST', `${A}/preview`, T.admin, { type: 'git', url: 'https://x.test/r.git' })).status, 400);
  const pre = await ok('POST', `${A}/preview`, T.admin, { type: 'open5e', ...O5, documents: ['tob'] });
  assert.equal(pre.module.id, 'open5e-tob');
  assert.equal(pre.edition, '2014');
  const saved = await ok('POST', A, T.admin, { type: 'open5e', ...O5, documents: ['tob'] });
  assert.deepEqual(saved.modules.map((m: any) => [m.id, m.server, m.edition, m.counts.monster]), [['open5e-tob', true, '2014', 1]]);
  assert.equal((await call('POST', A, T.admin, { type: 'open5e', ...O5, documents: ['tob'] })).status, 409, 'replace must be asked for');

  // A world lists it as available, turns it on with nothing downloaded, and its monsters are there.
  const mods = await ok('GET', `${M()}/`, T.dm);
  const lib = mods.available.find((m: any) => m.id === 'open5e-tob');
  assert.ok(lib && lib.server === true && lib.terms === 2);
  const before = hits.length;
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2024', 'open5e-tob'] });
  const hit = (await ok('GET', `${M()}/terms?q=nihileth&kind=monster`, T.jess)).terms[0];
  assert.equal(hit.module, 'Tome of Beasts (Open5e)');
  assert.equal(hits.length, before, 'turning it on downloads nothing');
  // A world cannot import a second copy under the same id; it can feed it to the shop and Codex.
  assert.equal((await ok('POST', `${M()}/import/preview`, T.dm, { type: 'open5e', ...O5, documents: ['tob'] })).reserved, true);
  const fed = await ok('POST', `${M()}/feed`, T.dm, { id: 'open5e-tob' });
  assert.ok(fed.fed && fed.fed.spells === undefined, 'Tome of Beasts has no spells');
  assert.equal((await call('POST', `${M()}/feed`, T.jess, { id: 'open5e-tob' })).status, 403);

  // Pull again, then remove: the world loses it.
  clearSourceCache();
  const n = hits.length;
  await ok('POST', `${A}/open5e-tob/refresh`, T.admin);
  assert.ok(hits.length > n, 'refresh fetched again');
  await ok('DELETE', `${A}/open5e-tob`, T.admin);
  assert.equal((await ok('GET', `${M()}/terms?q=nihileth&kind=monster`, T.dm)).terms.length, 0);
  assert.ok(!(await ok('GET', `${M()}/`, T.dm)).available.some((m: any) => m.id === 'open5e-tob'));
});

test('Sources: a DM browses a module and leaves single entries out of the world', async () => {
  const req = { type: 'open5e', ...O5, documents: ['deepm', 'vom'] };
  await ok('POST', `${M()}/import`, T.dm, req);
  const id = 'open5e-deepm-vom';
  const b = await ok('GET', `${M()}/browse/${id}`, T.dm);
  assert.deepEqual([b.total, b.leftOut, b.counts.spell, b.counts.item], [4, 0, 2, 2]);
  const ward = b.terms.find((t: any) => t.term === 'Quick Ward');
  const amulet = b.terms.find((t: any) => t.term === 'Amulet of the Void');
  const one = await ok('GET', `${M()}/browse/${id}/${encodeURIComponent(ward.id)}`, T.dm);
  assert.match(one.text, /faint ward/);
  assert.equal((await call('GET', `${M()}/browse/${id}`, T.jess)).status, 403, 'DMs only');
  assert.equal((await call('PUT', `${M()}/left-out`, T.jess, { module: id, terms: [ward.id], out: true })).status, 403);
  assert.equal((await call('PUT', `${M()}/left-out`, T.dm, { module: 'nope', terms: [ward.id], out: true })).status, 404);

  const r = await ok('PUT', `${M()}/left-out`, T.dm, { module: id, terms: [ward.id, amulet.id], out: true });
  assert.equal(r.leftOut, 2);
  // Gone from the world's terms, still in the module's browser marked as left out.
  assert.equal((await ok('GET', `${M()}/terms?q=quick%20ward`, T.dm)).terms.length, 0);
  assert.ok((await ok('GET', `${M()}/terms?q=abhorrent`, T.dm)).terms.length > 0, 'the rest stay');
  const only = await ok('GET', `${M()}/browse/${id}?left=1`, T.dm);
  assert.deepEqual(only.terms.map((t: any) => [t.term, t.leftOut]).sort(), [['Amulet of the Void', true], ['Quick Ward', true]]);
  // Feeding skips them: the Codex and the shop do not get what the DM left out.
  const fed = await ok('POST', `${M()}/feed`, T.dm, { id });
  assert.equal(fed.fed.spells.added + fed.fed.spells.replaced + fed.fed.spells.skipped, 1);
  const it = fed.fed.items;
  assert.equal(Object.values(it).filter((v) => typeof v === 'number').reduce((a: number, v: any) => a + v, 0), 1, JSON.stringify(it));

  await ok('PUT', `${M()}/left-out`, T.dm, { module: id, terms: [ward.id], out: false });
  assert.equal((await ok('GET', `${M()}/terms?q=quick%20ward`, T.dm)).terms.length, 1, 'put back');
  await ok('DELETE', `${M()}/imported/${id}`, T.dm);
});

test('Sources: Open5e is a server mod; off hides the sources and the content library, the stored books stay', async () => {
  const A = '/api/admin/content';
  await ok('POST', A, T.admin, { type: 'open5e', ...O5, documents: ['vom'], replace: true });
  assert.ok((await ok('GET', '/api/server-mods', T.dm)).on.includes('open5e'), 'on by default');
  await ok('PUT', '/api/admin/mods/open5e/enabled', T.admin, { on: false });
  assert.ok(!(await ok('GET', '/api/server-mods', T.dm)).on.includes('open5e'));
  const off = await call('GET', A, T.admin);
  assert.equal(off.status, 404);
  assert.match(JSON.stringify(off.body), /turned off/);
  assert.equal((await call('GET', `${M()}/sources`, T.dm)).status, 404);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'open5e', ...O5, documents: ['tob'] })).status, 404);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'dnd5eapi', edition: '2014' })).status, 404);
  // A book already pulled is still there for worlds: nothing needs the network.
  assert.ok((await ok('GET', `${M()}/`, T.dm)).available.some((m: any) => m.id === 'open5e-vom'));
  await ok('PUT', '/api/admin/mods/open5e/enabled', T.admin, { on: true });
  assert.ok((await ok('GET', A, T.admin)).modules.some((m: any) => m.id === 'open5e-vom'));
  await ok('DELETE', `${A}/open5e-vom`, T.admin);
});
