// Spells: the SRD 5.2.1 list and its search filters, imports and dedupe,
// homebrew, mana (spend, upcast, overdraw, rests from the world clock, GM
// adjustments, max castable level), spell crafting (eligibility with 1-5
// prerequisites, items, ability scores, level and mana; learning with and
// without the GM's approval; items used up) and what players may see.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { normalizeSpell, parseCsv, isCostly, isConsumed } from '../src/features/spells/format.ts';
import { castCost, compile, poolMax, restGain, DEFAULT_COSTS, DEFAULT_POOL, DEFAULT_REST, DEFAULT_MAX_LEVEL } from '../src/features/spells/mana.ts';
import { queryFrom, search } from '../src/features/spells/search.ts';
import { srd } from '../src/features/spells/store.ts';
import { tiers } from '../src/features/spells/craft.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const SP = () => `/api/worlds/${W}/spells`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const settings = (patch: Record<string, unknown>) => ok('PATCH', `/api/worlds/${W}/settings`, T.dm, patch);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-spells-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Spellholm', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---- pure parts --------------------------------------------------------------------------------------

test('Spells: the bundled SRD 5.2.1 list is complete, structured and attributed', () => {
  const b = srd();
  assert.equal(b.spells.length, 339);
  assert.equal(b.license, 'CC-BY-4.0');
  assert.match(b.attribution, /System Reference Document 5\.2\.1/);
  assert.match(b.attribution, /creativecommons\.org\/licenses\/by\/4\.0/);
  const fb = b.spells.find((s) => s.name === 'Fireball')!;
  assert.deepEqual([fb.level, fb.school, fb.castingTime, fb.range, fb.duration], [3, 'Evocation', 'Action', '150 feet', 'Instantaneous']);
  assert.deepEqual(fb.components, { v: true, s: true, m: true });
  assert.deepEqual(fb.damageTypes, ['Fire']);
  assert.deepEqual(fb.saves, ['Dexterity']);
  const rev = b.spells.find((s) => s.name === 'Revivify')!;
  assert.ok(rev.materialCost && rev.materialConsumed);
  const alarm = b.spells.find((s) => s.name === 'Alarm')!;
  assert.ok(alarm.ritual && alarm.castingTime === '1 minute');
  const bless = b.spells.find((s) => s.name === 'Bless')!;
  assert.ok(bless.concentration);
  assert.equal(b.spells.find((s) => s.name === 'Scorching Ray')!.attack, 'ranged');
  // Every spell has the four fields and a description.
  for (const s of b.spells) assert.ok(s.castingTime && s.range && s.duration && s.text.length > 20 && (s.components.v || s.components.s || s.components.m), s.name);
});

test('Spells: search filters (level, school, class, components, costly, consumed, casting time, range, duration, concentration, ritual, damage, save)', () => {
  const all = srd().spells;
  const q = (p: Record<string, string>) => search(all, queryFrom(p)).map((s) => s.name);
  assert.ok(q({ q: 'fire' }).slice(0, 3).includes('Fire Bolt'));
  assert.ok(q({ level: '0' }).every((n) => all.find((s) => s.name === n)!.level === 0));
  assert.ok(q({ level: '1-2', school: 'evocation', class: 'Wizard' }).includes('Scorching Ray'));
  assert.ok(!q({ level: '1-2', school: 'evocation', class: 'Wizard' }).includes('Fireball'));
  assert.ok(q({ v: '1', s: '0', m: '0' }).includes('Power Word Kill'));
  assert.ok(q({ costly: '1', consumed: '1' }).includes('Revivify'));
  assert.ok(!q({ costly: '1' }).includes('Fireball'));
  assert.ok(q({ material: 'diamond' }).includes('Revivify'));
  assert.ok(q({ castingTime: 'bonus' }).includes('Healing Word'));
  assert.ok(!q({ castingTime: 'action' }).includes('Healing Word'));
  assert.ok(q({ castingTime: 'reaction' }).includes('Shield'));
  assert.ok(q({ range: 'self' }).includes('Shield'));
  assert.ok(q({ duration: '24 hours' }).includes('Alarm') === false && q({ duration: '8 hours' }).includes('Alarm'));
  assert.ok(q({ concentration: '1' }).includes('Bless') && !q({ concentration: '1' }).includes('Fireball'));
  assert.ok(q({ ritual: '1' }).includes('Detect Magic') && !q({ ritual: '1' }).includes('Fireball'));
  assert.ok(q({ damage: 'fire', level: '3' }).includes('Fireball'));
  assert.ok(q({ save: 'wis', level: '1' }).includes('Command'));
  assert.ok(q({ q: 'fire', text: '1' }).length > q({ q: 'fire' }).length + 10);
});

test('Spells: normalising other shapes, CSV and costly/consumed detection', () => {
  const s = normalizeSpell({ name: 'Ember Lance', level: '2nd', school: 'evoc', casting_time: '1 bonus action', components: 'V, M (a coal worth 50 gp, which the spell consumes)', duration: 'Concentration, up to 1 minute', desc: ['A lance. Each creature makes a Dexterity saving throw, taking 2d6 Fire damage.'], higher_level: ['More fire.'] }, 'Test');
  assert.equal(s.level, 2);
  assert.equal(s.school, 'Evocation');
  assert.ok(s.concentration && s.duration === 'Up to 1 minute');
  assert.ok(s.components.v && !s.components.s && s.components.m);
  assert.ok(s.materialCost && s.materialConsumed);
  assert.deepEqual(s.damageTypes, ['Fire']);
  assert.deepEqual(s.saves, ['Dexterity']);
  assert.match(s.text, /Using a Higher-Level Spell Slot/);
  assert.throws(() => normalizeSpell({ name: 'No level' }, 'x'), /level/);
  assert.throws(() => normalizeSpell({ level: 1 }, 'x'), /name/);
  const rows = parseCsv('name,level,school,casting time,components,duration,text\n"Frost, Lance",1,Evocation,Action,"V, S",Instantaneous,"Cold. 1d8 Cold damage, ""brr"""\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Frost, Lance');
  assert.equal(rows[0].castingTime, 'Action');
  assert.match(rows[0].text, /"brr"/);
  assert.ok(isCostly('a pearl worth at least 100 GP') && !isCostly('a feather'));
  assert.ok(isConsumed('which the spell consumes') && !isConsumed('a bell'));
});

test('Spells: mana formulas, costs, upcasting and rests', () => {
  assert.throws(() => compile('level * '), /ends too early/);
  assert.throws(() => compile('level + secret'), /Unknown name/);
  const rules = { on: true, costs: DEFAULT_COSTS, pool: DEFAULT_POOL, rest: DEFAULT_REST, maxLevel: DEFAULT_MAX_LEVEL, overdraw: false };
  const c: any = { accountId: 'a', name: '', class: '', level: 3, abilities: { int: 16 }, castingAbility: 'int', manaMax: null, mana: null, from: {} };
  assert.equal(poolMax(c, rules), 3 * 4 + 3);
  assert.equal(poolMax({ ...c, level: null }, rules), null);
  assert.equal(poolMax({ ...c, manaMax: 7 }, rules), 7);
  assert.equal(poolMax(c, { ...rules, pool: { ...DEFAULT_POOL, formula: 'max(level * 2, intMod * 5)' } }), 15);
  assert.equal(poolMax(c, { ...rules, pool: { ...DEFAULT_POOL, mode: 'table' } }), 12);
  assert.equal(castCost({ level: 1 }, 1, rules), 2);
  assert.equal(castCost({ level: 1 }, 3, rules), 6);
  assert.equal(castCost({ level: 1, manaOverride: 5 }, 1, rules), 5);
  assert.equal(castCost({ level: 1, manaOverride: 5 }, 2, rules), 7);
  assert.equal(restGain('half', 3, 10), 8);
  assert.equal(restGain('full', 3, 10), 10);
  assert.equal(restGain('none', 3, 10), 3);
  assert.equal(restGain('quarter', 9, 10), 10);
});

test('Spells: recipe tiers follow chains and survive cycles', () => {
  const r = (id: string, resultId: string, prereqs: string[]) => ({ id, resultId, prereqs } as any);
  const t = tiers([r('a', 'ray', ['bolt', 'hands']), r('b', 'ball', ['ray', 'hands']), r('c', 'x', ['y']), r('d', 'y', ['x'])]);
  assert.equal(t.get('a'), 1);
  assert.equal(t.get('b'), 2);
  assert.ok((t.get('c') ?? 0) >= 1 && (t.get('d') ?? 0) >= 1);
});

// ---- the API -----------------------------------------------------------------------------------------

test('Spells: players read only spells they know or the GM made public; GM notes never reach them', async () => {
  const dmList = await ok('GET', `${SP()}/list?q=fire%20bolt`, T.dm);
  assert.equal(dmList.spells[0].id, 'srd:fire-bolt');
  assert.equal(dmList.spells[0].manaCost, 0);
  assert.equal((await ok('GET', `${SP()}/list`, T.jess)).total, 0, 'nothing is public by default');
  assert.equal((await call('GET', `${SP()}/s/srd:fireball`, T.jess)).status, 404);
  await ok('PUT', `${SP()}/s/srd:fireball/meta`, T.dm, { public: true, dmNotes: 'ZQX-SPELLNOTE the dragon fears it', manaOverride: 7 });
  const seen = await ok('GET', `${SP()}/s/srd:fireball`, T.jess);
  assert.equal(seen.name, 'Fireball');
  assert.equal(seen.manaCost, 7);
  assert.equal(seen.dmNotes, undefined);
  assert.equal(seen.manaOverride, undefined);
  const dmSees = await ok('GET', `${SP()}/s/srd:fireball`, T.dm);
  assert.match(dmSees.dmNotes, /ZQX-SPELLNOTE/);
  for (const u of ['/list', '/list?full=1', '/facets', '/', '/codex', '/recipes', '/s/srd:fireball']) {
    const r = await call('GET', `${SP()}${u}`, T.jess);
    assert.ok(!r.text.includes('ZQX-SPELLNOTE'), `${u} leaks the GM note`);
  }
  // A known spell is readable; others stay hidden.
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: 'Fire Bolt' });
  assert.equal((await ok('GET', `${SP()}/s/srd:fire-bolt`, T.jess)).known, true);
  assert.equal((await call('GET', `${SP()}/s/srd:fire-bolt`, T.tom)).status, 404);
  const mine = await ok('GET', `${SP()}/list?known=1`, T.jess);
  assert.deepEqual(mine.spells.map((s: any) => s.name), ['Fire Bolt']);
  // The world switch opens every SRD spell.
  await settings({ spellsPublicSrd: true });
  assert.equal((await ok('GET', `${SP()}/list?limit=1`, T.tom)).total, 339);
  await settings({ spellsPublicSrd: false });
  // Only the GM changes spells.
  assert.equal((await call('PUT', `${SP()}/s/srd:fireball/meta`, T.jess, { public: false })).status, 403);
  assert.equal((await call('POST', `${SP()}/s`, T.jess, { name: 'Mine', level: 1 })).status, 403);
});

test('Spells: homebrew, import from JSON, CSV, a game module and library pages, deduplicated by name and source', async () => {
  const hb = await ok('POST', SP() + '/s', T.dm, { name: 'Ember Lance', level: 2, school: 'Evocation', castingTime: 'Action', range: '60 feet', components: 'V, S', duration: 'Instantaneous', text: 'A lance of embers: 3d6 Fire damage.', dmNotes: 'secret twist' });
  assert.equal(hb.source, 'Homebrew');
  assert.deepEqual(hb.damageTypes, ['Fire']);
  assert.equal((await call('POST', SP() + '/s', T.dm, { name: 'ember lance', level: 1 })).status, 409, 'same name and source');
  const edited = await ok('PUT', `${SP()}/s/${encodeURIComponent(hb.id)}`, T.dm, { range: '90 feet' });
  assert.equal(edited.range, '90 feet');
  assert.equal((await call('PUT', `${SP()}/s/srd:fireball`, T.dm, { range: '1 mile' })).status, 400, 'SRD spells are not edited');

  const json = [{ name: 'Moonflare', level: 3, school: 'Evocation', casting_time: '1 action', range: '120 feet', components: ['V', 'S', 'M'], material: 'a silver mirror worth 25 gp', duration: 'Instantaneous', desc: ['Radiant light. 4d8 Radiant damage; Constitution saving throw.'] }, { name: 'Bad one' }];
  const pre = await ok('POST', `${SP()}/import/preview`, T.dm, { type: 'json', json, source: 'Moon Book' });
  assert.equal(pre.count, 1);
  assert.equal(pre.warnings.length, 1);
  const imp = await ok('POST', `${SP()}/import`, T.dm, { type: 'json', json, source: 'Moon Book' });
  assert.equal(imp.added.length, 1);
  const again = await ok('POST', `${SP()}/import`, T.dm, { type: 'json', json, source: 'Moon Book' });
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped[0].why, 'already imported');
  assert.equal((await ok('POST', `${SP()}/import`, T.dm, { type: 'json', json: [{ ...json[0], range: '150 feet' }], source: 'Moon Book', replace: true })).replaced.length, 1);
  // The same name from another source is a second spell.
  assert.equal((await ok('POST', `${SP()}/import`, T.dm, { type: 'json', json, source: 'Other Book' })).added.length, 1);
  // A spell with an SRD name and the SRD as its source is a duplicate.
  assert.equal((await ok('POST', `${SP()}/import`, T.dm, { type: 'json', json: [{ name: 'Fireball', level: 3 }], source: 'SRD 5.2.1' })).skipped[0].why, 'already in the SRD list');
  const moon = await ok('GET', `${SP()}/list?q=moonflare&source=Moon%20Book`, T.dm);
  assert.equal(moon.total, 1);
  assert.ok(moon.spells[0].materialCost);
  assert.equal(moon.spells[0].range, '150 feet');

  const csv = 'name,level,school,casting time,range,components,duration,concentration,mana cost,text\nFrostbite Lash,1,Evocation,Bonus Action,30 feet,"V, S","1 minute",yes,3,"Cold: 1d8 Cold damage."\n';
  const c = await ok('POST', `${SP()}/import`, T.dm, { type: 'csv', csv, source: 'Frost Folio' });
  assert.equal(c.added.length, 1);
  const lash = (await ok('GET', `${SP()}/list?q=frostbite`, T.dm)).spells[0];
  assert.ok(lash.concentration);
  assert.equal(lash.manaCost, 3, 'a cost given by the source');

  // A game module's spells (the SRD 5.1 module ships with the app).
  const mod = await ok('POST', `${SP()}/import`, T.dm, { type: 'module', moduleId: 'dnd-2014' });
  assert.ok(mod.added.length > 250);
  const old = (await ok('GET', `${SP()}/list?q=magic%20missile&source=${encodeURIComponent('5e 2014 (SRD 5.1)')}`, T.dm));
  assert.equal(old.total, 1);
  assert.match(old.spells[0].attribution, /5\.1/);
  assert.equal((await ok('POST', `${SP()}/import`, T.dm, { type: 'module', moduleId: 'dnd-2014' })).added.length, 0);

  // Library pages: frontmatter gives the fields; GM-only parts and classified pages stay out.
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Spells/Gloom Veil.md', visibility: 'dm', frontmatter: { level: 2, school: 'Illusion', castingTime: 'Action', range: 'Self', components: 'V, S', duration: '1 hour' }, body: '# Gloom Veil\n\nShadows wrap you.\n\n<!-- dm -->ZQX-LIBSECRET the cult made it<!-- /dm -->\n' });
  await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: 'Spells/Sealed Word.md', visibility: 'classified', frontmatter: { level: 9 }, body: 'Never read.' });
  const lib = await ok('POST', `${SP()}/import`, T.dm, { type: 'library', folder: 'Spells' });
  assert.equal(lib.added.length, 1);
  assert.match(lib.warnings.join(' '), /classified/);
  const gloom = (await ok('GET', `${SP()}/list?q=gloom&full=1`, T.dm)).spells[0];
  assert.equal(gloom.source, 'Library: Spells/Gloom Veil.md');
  assert.match(gloom.text, /Shadows wrap you/);
  assert.ok(!gloom.text.includes('ZQX-LIBSECRET'));

  // Export as CSV and JSON.
  const ex = await call('GET', `${SP()}/export?format=csv`, T.dm);
  assert.match(ex.text, /^name,level,school/);
  assert.match(ex.text, /Ember Lance/);
  assert.equal((await call('GET', `${SP()}/export`, T.jess)).status, 403);
  // A spell used by a recipe cannot be removed.
  const del = await ok('POST', SP() + '/s', T.dm, { name: 'Throwaway', level: 0, castingTime: 'Action', range: 'Self', components: 'V', duration: 'Instantaneous', text: 'Gone soon.' });
  await ok('DELETE', `${SP()}/s/${encodeURIComponent(del.id)}`, T.dm);
  assert.equal((await call('DELETE', `${SP()}/s/srd:fireball`, T.dm)).status, 400);
});

test('Spells: mana pool, casting, upcasting, overdraw, GM adjustments, max level and rests from the clock', async () => {
  assert.equal((await call('POST', `${SP()}/characters/${ID.jess}/mana`, T.dm, { delta: 1 })).status, 409, 'mana is off');
  const off = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fire-bolt' });
  assert.equal(off.cost, 0);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellManaCosts: [1, 2, 3] })).status, 400);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellManaPool: { mode: 'formula', formula: 'level +', table: DEFAULT_POOL.table } })).status, 400);
  await settings({ spellMana: true, spellManaRest: { long: 'full', short: 'half' } });
  // No level yet: no pool.
  assert.equal((await call('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fire-bolt' })).status, 409);
  await ok('PUT', `${SP()}/characters/me`, T.jess, { class: 'Wizard', level: 2, abilities: { int: 12 } });
  let me = await ok('GET', `${SP()}/characters/me`, T.jess);
  assert.deepEqual([me.mana.now, me.mana.max], [9, 9]);
  assert.equal((await call('PUT', `${SP()}/characters/me`, T.jess, { manaMax: 99 })).status, 403, 'players do not set their own maximum');
  assert.equal((await call('PUT', `${SP()}/characters/${ID.tom}`, T.jess, { level: 3 })).status, 404, 'nor anyone else');
  // Casting needs a known spell; it spends the table cost (or the spell's own), more when cast higher.
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: 'srd:burning-hands' });
  assert.equal((await call('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fireball' })).status, 403, 'public but not known');
  let c = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:burning-hands' });
  assert.deepEqual([c.cost, c.mana], [2, 7]);
  c = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:burning-hands', level: 3 });
  assert.deepEqual([c.cost, c.mana], [6, 1]);
  const over = await call('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:burning-hands' });
  assert.equal(over.status, 409);
  assert.match(over.body.error, /Not enough mana/);
  await settings({ spellManaOverdraw: true });
  c = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:burning-hands' });
  assert.equal(c.mana, -1);
  await settings({ spellManaOverdraw: false });
  // The GM adjusts and sets a maximum by hand.
  me = await ok('POST', `${SP()}/characters/${ID.jess}/mana`, T.dm, { delta: 3, note: 'Potion' });
  assert.equal(me.mana.now, 2);
  me = await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { manaMax: 20 });
  assert.equal(me.mana.max, 20);
  assert.equal((await call('POST', `${SP()}/characters/${ID.jess}/mana`, T.jess, { delta: 50 })).status, 403);
  // A short rest gives half back, a long rest all, also when the GM rests from the world clock.
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'short-rest' });
  me = await ok('GET', `${SP()}/characters/me`, T.jess);
  assert.equal(me.mana.now, 12);
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'long-rest' });
  me = await ok('GET', `${SP()}/characters/me`, T.jess);
  assert.equal(me.mana.now, 20);
  await ok('POST', `${SP()}/characters/${ID.jess}/mana`, T.dm, { set: 4 });
  const rest = await ok('POST', `${SP()}/rest`, T.dm, { kind: 'long' });
  assert.ok(rest.characters.some((x: any) => x.accountId === ID.jess && x.after === 20));
  // A limit on the spell level mana casts.
  await settings({ spellManaMaxLevel: { on: true, table: DEFAULT_MAX_LEVEL.table } });
  const high = await call('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:burning-hands', level: 2 });
  assert.equal(high.status, 409);
  assert.match(high.body.error, /level 1 or lower/);
  await settings({ spellManaMaxLevel: { on: false, table: DEFAULT_MAX_LEVEL.table } });
  // The log: the player's own, the GM's all.
  const log = await ok('GET', `${SP()}/log`, T.jess);
  assert.ok(log.log.some((x: any) => x.kind === 'cast') && log.log.some((x: any) => x.kind === 'rest') && log.log.some((x: any) => x.kind === 'adjust'));
  assert.ok(log.log.every((x: any) => x.accountId === ID.jess));
  assert.equal((await ok('GET', `${SP()}/log`, T.tom)).log.filter((x: any) => x.accountId === ID.jess).length, 0);
  await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { manaMax: null });
});

test('Spells: recipes, eligibility (prerequisites, items, ability scores, level, mana) and learning with the GM approving', async () => {
  assert.equal((await call('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: [] })).status, 400, 'at least one prerequisite');
  assert.equal((await call('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: ['Fire Bolt', 'Burning Hands', 'Light', 'Shield', 'Sleep', 'Thunderwave'] })).status, 400, 'at most five');
  assert.equal((await call('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: ['Scorching Ray'] })).status, 400, 'not itself');
  assert.equal((await call('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: ['No Such Spell'] })).status, 400);
  assert.equal((await call('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: ['Fire Bolt'], stats: { luck: 3 } })).status, 400);
  const ray = await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: ['Fire Bolt', 'Burning Hands'], stats: { int: 13 }, items: [{ name: 'Ruby Dust', qty: 2, consumed: true }, { name: 'Brass Rod', qty: 1 }], minLevel: 2, manaCost: 3, dmNotes: 'ZQX-RECIPENOTE ties to the volcano' });
  assert.equal(ray.tier, 1);
  const ball = await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Fireball', prereqs: ['Scorching Ray', 'Burning Hands'], visibility: 'visible' });
  assert.equal(ball.tier, 2);
  const hidden = await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Wall of Fire', prereqs: ['Fireball'], visibility: 'hidden', dmNotes: 'ZQX-HIDDENRECIPE' });
  const draft = await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Fire Shield', prereqs: ['Fire Bolt'], draft: true });

  // Crafting is off by default: players see nothing and cannot ask.
  assert.deepEqual((await ok('GET', `${SP()}/recipes`, T.jess)).recipes, []);
  assert.equal((await call('POST', `${SP()}/learn`, T.jess, { recipeId: ray.id })).status, 403);
  await settings({ spellCrafting: true });
  const seen = await ok('GET', `${SP()}/recipes`, T.jess);
  assert.deepEqual(seen.recipes.map((x: any) => x.result.name).sort(), ['Fireball', 'Scorching Ray']);
  assert.equal(seen.mystery, 1);
  for (const u of ['/recipes', '/codex', '/learn']) {
    const r = await call('GET', `${SP()}${u}`, T.jess);
    for (const secret of ['ZQX-RECIPENOTE', 'ZQX-HIDDENRECIPE', 'Wall of Fire', 'Fire Shield', hidden.id, draft.id]) assert.ok(!r.text.includes(secret), `${u} shows ${secret}`);
  }
  await settings({ spellCraftHidden: 'hide' });
  assert.equal((await ok('GET', `${SP()}/recipes`, T.jess)).mystery, 0);
  assert.deepEqual((await ok('GET', `${SP()}/codex`, T.jess)).mystery, []);
  await settings({ spellCraftHidden: 'mystery' });
  assert.equal((await ok('GET', `${SP()}/codex`, T.jess)).mystery.length, 1);
  assert.equal((await call('POST', `${SP()}/learn`, T.jess, { recipeId: hidden.id })).status, 404, 'a hidden recipe cannot be asked for');
  assert.equal((await call('POST', `${SP()}/learn`, T.jess, { recipeId: draft.id })).status, 404, 'nor a draft');

  // Jess knows Fire Bolt and Burning Hands, is level 2 with INT 12: missing INT 13 and the items; mana is fine.
  await ok('POST', `${SP()}/characters/${ID.jess}/mana`, T.dm, { full: true });
  let codex = await ok('GET', `${SP()}/codex`, T.jess);
  let row = codex.next.find((x: any) => x.id === ray.id);
  assert.equal(row.status, 'locked');
  assert.deepEqual(row.missing.map((m: any) => m.kind).sort(), ['item', 'item', 'stat']);
  assert.deepEqual(row.missing.find((m: any) => m.kind === 'stat'), { kind: 'stat', ability: 'int', need: 13, have: 12 });
  assert.equal(codex.next.find((x: any) => x.id === ball.id).missing.find((m: any) => m.kind === 'spell').name, 'Scorching Ray');
  assert.equal((await call('POST', `${SP()}/learn`, T.jess, { recipeId: ray.id })).status, 409);

  // Meet it: INT 13 (from the sheet), the items in her own pack (party items do not count).
  await ok('PUT', `${SP()}/characters/me`, T.jess, { abilities: { int: 13 } });
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: 'party', name: 'Ruby Dust', qty: 5, reason: 'loot' });
  codex = await ok('GET', `${SP()}/codex`, T.jess);
  assert.equal(codex.next.find((x: any) => x.id === ray.id).missing.length, 2);
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'ruby dust', qty: 3, reason: 'loot' });
  await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Brass Rod', qty: 1, reason: 'loot' });
  codex = await ok('GET', `${SP()}/codex`, T.jess);
  row = codex.ready.find((x: any) => x.id === ray.id);
  assert.ok(row, 'learnable now');
  assert.deepEqual(row.items.map((i: any) => i.have), [3, 1]);

  // Asking waits for the GM; asking twice is refused; the GM sees the request.
  const reqd = await ok('POST', `${SP()}/learn`, T.jess, { recipeId: ray.id });
  assert.equal(reqd.status, 'pending');
  assert.equal((await call('POST', `${SP()}/learn`, T.jess, { recipeId: ray.id })).status, 409);
  assert.equal((await ok('GET', `${SP()}/codex`, T.jess)).ready.find((x: any) => x.id === ray.id).pending, reqd.id);
  assert.equal((await ok('GET', `${SP()}/learn?status=pending`, T.dm)).requests.length, 1);
  assert.equal((await ok('GET', `${SP()}/learn`, T.tom)).requests.length, 0);
  assert.equal((await call('POST', `${SP()}/learn/${reqd.id}/approve`, T.jess)).status, 403);
  const before = (await ok('GET', `${SP()}/characters/me`, T.jess)).mana.now;
  const done = await ok('POST', `${SP()}/learn/${reqd.id}/approve`, T.dm, {});
  assert.equal(done.status, 'approved');
  assert.deepEqual(done.consumed, [{ name: 'Ruby Dust', qty: 2 }]);
  // The spell is known, 2 dust were used (1 left), the rod stays, 3 mana spent, and Jess is told about her items.
  const meNow = await ok('GET', `${SP()}/characters/me`, T.jess);
  assert.ok(meNow.known.some((s: any) => s.name === 'Scorching Ray' && s.how === 'crafted'));
  assert.equal(meNow.mana.now, before - 3);
  const inv = await ok('GET', `/api/worlds/${W}/inventory?owner=me`, T.jess);
  assert.equal(inv.items.find((i: any) => /ruby dust/i.test(i.name)).qty, 1);
  assert.equal(inv.items.find((i: any) => i.name === 'Brass Rod').qty, 1);
  assert.equal((await ok('GET', `/api/worlds/${W}/inventory?owner=party`, T.jess)).items.find((i: any) => i.name === 'Ruby Dust').qty, 5);
  const alerts = await ok('GET', `/api/worlds/${W}/approvals/mine`, T.jess);
  assert.match(JSON.stringify(alerts), /Used up learning Scorching Ray/);
  assert.ok((await ok('GET', `${SP()}/log`, T.jess)).log.some((x: any) => x.kind === 'learn' && /Scorching Ray from Fire Bolt \+ Burning Hands/.test(x.note)));
  // The next tier opens: Fireball needs Scorching Ray and Burning Hands, both known now.
  codex = await ok('GET', `${SP()}/codex`, T.jess);
  assert.ok(codex.ready.some((x: any) => x.id === ball.id));
  assert.ok(codex.learnedRecipes.includes(ray.id));

  // Auto approval: learned at once. A rejected request changes nothing.
  await settings({ spellCraftApproval: 'auto' });
  const auto = await ok('POST', `${SP()}/learn`, T.jess, { recipeId: ball.id });
  assert.equal(auto.status, 'approved');
  assert.ok((await ok('GET', `${SP()}/characters/me`, T.jess)).known.some((s: any) => s.name === 'Fireball'));
  await settings({ spellCraftApproval: 'dm' });
  await ok('POST', `${SP()}/characters/${ID.tom}/known`, T.dm, { spellId: 'srd:fireball' });
  const hiddenNow = await ok('GET', `${SP()}/codex`, T.tom);
  assert.equal(hiddenNow.mystery[0].buildsOnKnown, true);
  const ask = await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Light', prereqs: ['Fireball'] });
  const r1 = await ok('POST', `${SP()}/learn`, T.tom, { recipeId: ask.id });
  const rej = await ok('POST', `${SP()}/learn/${r1.id}/reject`, T.dm, { reason: 'Not yet' });
  assert.equal(rej.status, 'rejected');
  assert.ok(!(await ok('GET', `${SP()}/characters/me`, T.tom)).known.some((s: any) => s.name === 'Light'));
  const r2 = await ok('POST', `${SP()}/learn`, T.tom, { recipeId: ask.id });
  assert.equal((await ok('POST', `${SP()}/learn/${r2.id}/cancel`, T.tom)).status, 'cancelled');

  // A draft is approved by the GM before anyone can use it; drafts from the assistant come in as drafts.
  await ok('POST', `${SP()}/recipes/${draft.id}/approve`, T.dm);
  assert.ok((await ok('GET', `${SP()}/recipes`, T.jess)).recipes.some((x: any) => x.id === draft.id));

  // Export and import by name.
  const ex = await ok('GET', `${SP()}/recipes/export`, T.dm);
  assert.ok(ex.recipes.some((x: any) => x.result === 'Scorching Ray' && x.prereqs.includes('Fire Bolt')));
  const back = await ok('POST', `${SP()}/recipes/import`, T.dm, { recipes: ex.recipes });
  assert.equal(back.added, 0, 'the same recipes are skipped');
  const fresh = await ok('POST', `${SP()}/recipes/import`, T.dm, { recipes: [{ result: 'Cone of Cold', prereqs: ['Ray of Frost', 'Ice Knife'], stats: { INT: 15 } }, { result: 'Nope', prereqs: ['Fire Bolt'] }] });
  assert.equal(fresh.added, 1);
  assert.equal(fresh.skipped.length, 1);
  assert.equal((await call('POST', `${SP()}/recipes/import`, T.jess, { recipes: [] })).status, 403);
  // Deleting a recipe cancels its waiting requests.
  await ok('DELETE', `${SP()}/recipes/${ask.id}`, T.dm);
  assert.equal((await call('GET', `${SP()}/recipes`, T.dm)).body.recipes.some((x: any) => x.id === ask.id), false);
});

test('Spells: the assistant tools are listed and a suggested recipe lands as a draft', async () => {
  const key = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dm write', access: 'write' })).key;
  const pkey = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', worldId: W, label: 'jess read', access: 'read' })).key;
  const rpc = async (k: string, method: string, params: unknown) => (await call('POST', '/mcp', k, { jsonrpc: '2.0', id: 1, method, params })).body;
  const names = (await rpc(key, 'tools/list', {})).result.tools.map((t: any) => t.name);
  for (const n of ['list_spells', 'read_spell', 'list_spell_recipes', 'draft_spell_recipe']) assert.ok(names.includes(n), n);
  const pnames = (await rpc(pkey, 'tools/list', {})).result.tools.map((t: any) => t.name);
  assert.ok(pnames.includes('list_spells') && pnames.includes('my_spell_codex') && !pnames.includes('list_spell_recipes') && !pnames.includes('draft_spell_recipe'));
  const found = await rpc(key, 'tools/call', { name: 'list_spells', arguments: { query: 'ray', level: '2', damage: 'Fire' } });
  assert.match(JSON.stringify(found), /Scorching Ray/);
  const made = await rpc(key, 'tools/call', { name: 'draft_spell_recipe', arguments: { result: 'Ice Storm', prereqs: ['Ray of Frost', 'Thunderwave'], stats: { wis: 13 }, dmNotes: 'cold theme' } });
  assert.ok(!made.result?.isError, JSON.stringify(made));
  const all = (await ok('GET', `${SP()}/recipes`, T.dm)).recipes;
  const storm = all.find((x: any) => x.result.name === 'Ice Storm');
  assert.ok(storm.draft && storm.createdBy === 'assistant');
  assert.ok(!(await ok('GET', `${SP()}/recipes`, T.jess)).recipes.some((x: any) => x.result.name === 'Ice Storm'));
  const pc = await rpc(pkey, 'tools/call', { name: 'my_spell_codex', arguments: {} });
  assert.match(JSON.stringify(pc), /Scorching Ray/);
  assert.ok(!JSON.stringify(pc).includes('cold theme'));
});
