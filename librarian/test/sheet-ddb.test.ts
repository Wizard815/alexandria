// Importing a character from D&D Beyond onto the player sheet: reading the
// character link, mapping D&D Beyond's (undocumented) character JSON to the
// sheet, what a player and the DM may apply, the warning that it is not an
// official API, and the errors when D&D Beyond says no.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { cleanCharacter, ddbCharacterId, mapDdb } from '../src/features/sheet/ddb.ts';
import { cleanModules } from '../src/features/sheet/modules.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
let realFetch: typeof fetch;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const SH = () => `/api/worlds/${W}/sheet`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

/** A small character in the shape D&D Beyond's character service sends. */
function ddbJson(over: Record<string, unknown> = {}) {
  return {
    id: 87654321, success: true, message: 'Character successfully received.',
    data: {
      id: 87654321, name: 'Brindle Ashvale', readonlyUrl: 'https://www.dndbeyond.com/characters/87654321',
      race: { fullName: 'Hill Dwarf', baseName: 'Dwarf', weightSpeeds: { normal: { walk: 25 } }, racialTraits: [{ definition: { name: 'Darkvision' } }, { definition: { name: 'Dwarven Resilience' } }] },
      spellSlots: [{ level: 1, used: 3, available: 0 }, { level: 2, used: 0, available: 0 }],
      inspiration: true,
      traits: { personalityTraits: 'Reads at the table.', ideals: 'Knowledge.', bonds: 'My spellbook.', flaws: 'Too curious.' },
      notes: { backstory: 'Raised in a library.\nLeft to find a lost page.' },
      actions: {
        class: [
          { name: 'Arcane Recovery', limitedUse: { maxUses: 1, numberUsed: 0, resetType: 2 } },
          { name: 'Second Wind', limitedUse: { maxUses: 1, numberUsed: 1, resetType: 1 } },
          { name: 'Not counted', limitedUse: null },
        ],
        race: [], feat: [{ name: 'Lucky', limitedUse: { maxUses: 0, useProficiencyBonus: true, numberUsed: 1, resetType: 2 } }],
      },
      background: { definition: { name: 'Sage' } }, alignmentId: 2,
      classes: [
        { level: 4, isStartingClass: true, hitDiceUsed: 1,
          definition: { name: 'Wizard', hitDice: 6, spellCastingAbilityId: 4, canCastSpells: true, spellRules: { multiClassSpellSlotDivisor: 1, multiClassSpellSlotRounding: 1, levelSpellSlots: [[], [2], [3], [4, 2], [4, 3]] } },
          classFeatures: [{ definition: { name: 'Arcane Recovery', requiredLevel: 1 } }, { definition: { name: 'Spellcasting', requiredLevel: 1 } }, { definition: { name: 'Ability Score Improvement', requiredLevel: 4 } }, { definition: { name: 'Arcane Tradition Feature', requiredLevel: 6 } }],
          subclassDefinition: { name: 'School of Evocation', classFeatures: [{ definition: { name: 'Sculpt Spells', requiredLevel: 2 } }] } },
        { level: 1, definition: { name: 'Fighter', hitDice: 10, spellCastingAbilityId: null, canCastSpells: false }, subclassDefinition: null, classFeatures: [{ definition: { name: 'Second Wind', requiredLevel: 1 } }] },
      ],
      stats: [{ id: 1, value: 10 }, { id: 2, value: 14 }, { id: 3, value: 13 }, { id: 4, value: 15 }, { id: 5, value: 12 }, { id: 6, value: 8 }],
      bonusStats: [{ id: 1, value: null }, { id: 2, value: null }, { id: 3, value: null }, { id: 4, value: 1 }, { id: 5, value: null }, { id: 6, value: null }],
      overrideStats: [{ id: 1, value: null }, { id: 2, value: null }, { id: 3, value: null }, { id: 4, value: null }, { id: 5, value: null }, { id: 6, value: null }],
      baseHitPoints: 32, bonusHitPoints: null, overrideHitPoints: null, removedHitPoints: 7, temporaryHitPoints: 3,
      modifiers: {
        race: [
          { type: 'bonus', subType: 'constitution-score', value: 2 },
          { type: 'bonus', subType: 'wisdom-score', value: 1 },
          { type: 'bonus', subType: 'hit-points-per-level', value: 1 },
          { type: 'language', subType: 'common', friendlySubtypeName: 'Common' },
          { type: 'language', subType: 'dwarvish', friendlySubtypeName: 'Dwarvish' },
        ],
        class: [
          { type: 'proficiency', subType: 'intelligence-saving-throws' },
          { type: 'proficiency', subType: 'wisdom-saving-throws' },
          { type: 'proficiency', subType: 'arcana' },
          { type: 'expertise', subType: 'history' },
        ],
        background: [{ type: 'language', subType: 'common', friendlySubtypeName: 'Common' }],
        item: [{ type: 'bonus', subType: 'armor-class', value: 1 }],
        feat: [], condition: [],
      },
      inventory: [
        { quantity: 1, equipped: true, definition: { name: 'Leather Armor', armorClass: 11, armorTypeId: 1, filterType: 'Armor' } },
        { quantity: 1, equipped: true, definition: { name: 'Shield', armorClass: 2, armorTypeId: 4, filterType: 'Armor' } },
        { quantity: 1, equipped: false, definition: { name: 'Plate Armor', armorClass: 18, armorTypeId: 3, filterType: 'Armor' } },
        { quantity: 20, equipped: false, definition: { name: 'Crossbow Bolts', filterType: 'Other Gear' } },
        { quantity: 1, equipped: true, definition: { name: 'Dagger', filterType: 'Weapon', attackType: 1, range: 20, longRange: 60, damage: { diceString: '1d4' }, damageType: 'Piercing', properties: [{ name: 'Finesse' }, { name: 'Thrown' }] } },
        { quantity: 1, equipped: true, definition: { name: 'Light Crossbow +1', filterType: 'Weapon', attackType: 2, range: 80, longRange: 320, damage: { diceString: '1d8' }, damageType: 'Piercing', grantedModifiers: [{ type: 'bonus', subType: 'magic', value: 1 }] } },
        { quantity: 1, equipped: true, definition: { name: 'Ring of Protection', filterType: 'Ring' } },
      ],
      currencies: { cp: 12, sp: 0, gp: 85, ep: 0, pp: 1 },
      conditions: [{ id: 11, level: null }, { id: 4, level: 2 }],
      feats: [{ definition: { name: 'Tough' } }],
      classSpells: [{ characterClassId: 1, spells: [{ definition: { name: 'Magic Missile', level: 1 } }, { definition: { name: 'Fire Bolt', level: 0 } }, { definition: { name: 'Shield', level: 1 } }] }],
      spells: { race: [], class: [], item: [{ definition: { name: 'Blorbo’s Homebrew Bolt', level: 2 } }], feat: [] },
      characterValues: [],
      ...over,
    },
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-ddb-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  realFetch = deps.fetch;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Beyondholm', dmAccountId: ID.dm })).id;
  for (const name of ['jess', 'tom']) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : 'Tomas' });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
});

test('SheetDdb_IsAHouseRule: off until the DM turns on the D&D Beyond import house rule, which switches sheetDdbImport', async () => {
  const off = await call('POST', `${SH()}/me/import/ddb`, T.jess, { json: JSON.stringify(ddbJson()), dryRun: true });
  assert.equal(off.status, 403);
  assert.match(off.body.error, /DM has not turned on/);
  assert.match((await call('POST', `${SH()}/me/import/ddb`, T.dm, { json: '{}', dryRun: true })).body.error, /House rules/);
  await ok('PUT', `/api/worlds/${W}/mods/dndbeyond-import/enabled`, T.dm, { on: true });
  const s = await ok('GET', `/api/worlds/${W}/settings`, T.dm);
  assert.equal(s.sheetDdbImport, true);
  assert.equal((await ok('POST', `${SH()}/me/import/ddb`, T.jess, { json: JSON.stringify(ddbJson()), dryRun: true })).character.name, 'Brindle Ashvale');
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** D&D Beyond as the server sees it: `answer` decides what each character id returns. */
function fakeDdb(answer: (id: string) => { status: number; body: unknown }) {
  const seen: string[] = [];
  deps.fetch = (async (url: any) => {
    const u = String(url);
    seen.push(u);
    const m = u.match(/^https:\/\/character-service\.dndbeyond\.com\/character\/v5\/character\/(\d+)$/);
    if (!m) return new Response('not here', { status: 599 });
    const a = answer(m[1]);
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

test('SheetDdb_CharacterId: links, share links, the service URL and bare ids; nothing from other sites', () => {
  assert.equal(ddbCharacterId('https://www.dndbeyond.com/characters/87654321'), '87654321');
  assert.equal(ddbCharacterId('dndbeyond.com/characters/87654321/AbC123'), '87654321');
  assert.equal(ddbCharacterId('https://www.dndbeyond.com/profile/someone/characters/87654321'), '87654321');
  assert.equal(ddbCharacterId('https://character-service.dndbeyond.com/character/v5/character/87654321'), '87654321');
  assert.equal(ddbCharacterId(' 87654321 '), '87654321');
  assert.equal(ddbCharacterId('https://evil.example/characters/87654321'), null);
  assert.equal(ddbCharacterId('https://dndbeyond.com.evil.example/characters/87654321'), null);
  assert.equal(ddbCharacterId('https://www.dndbeyond.com/campaigns/123456'), null);
  assert.equal(ddbCharacterId(''), null);
});

test('SheetDdb_Map: scores with bonuses, HP from base + Con + per level, AC estimate, proficiencies, spells, items, conditions', () => {
  const c = mapDdb(ddbJson());
  assert.equal(c.name, 'Brindle Ashvale');
  assert.equal(c.race, 'Hill Dwarf');
  assert.equal(c.level, 5);
  assert.deepEqual(c.classes, [{ name: 'Wizard', subclass: 'School of Evocation', level: 4 }, { name: 'Fighter', subclass: '', level: 1 }]);
  assert.deepEqual(c.abilities, { str: 10, dex: 14, con: 15, int: 16, wis: 13, cha: 8 });
  assert.equal(c.castingAbility, 'int');
  // 32 base + (Con +2 and Dwarven Toughness +1) x 5 levels = 47; 7 taken.
  assert.deepEqual(c.hp, { max: 47, now: 40, temp: 3 });
  // Leather 11 + Dex 2 + shield 2 + ring 1 (plate is not worn).
  assert.equal(c.ac, 16);
  assert.equal(c.speed, 25);
  assert.equal(c.prof, 3);
  assert.deepEqual(c.saves, ['int', 'wis']);
  assert.deepEqual(c.skills, [{ name: 'Arcana', expertise: false }, { name: 'History', expertise: true }]);
  assert.deepEqual(c.languages, ['Common', 'Dwarvish']);
  assert.deepEqual(c.feats, ['Tough']);
  assert.deepEqual(c.spells.map((s) => s.name), ['Fire Bolt', 'Magic Missile', 'Shield', 'Blorbo’s Homebrew Bolt']);
  assert.equal(c.items.find((i) => i.name === 'Crossbow Bolts')?.qty, 20);
  assert.deepEqual(c.coins, { pp: 1, gp: 85, cp: 12 });
  assert.deepEqual(c.conditions, ['Poisoned', 'Exhaustion 2']);
  assert.equal(c.url, 'https://www.dndbeyond.com/characters/87654321');
  // More from the sheet: initiative, passive Perception, hit dice, slots, attacks, features, limited uses, personality.
  assert.equal(c.initiative, 2);
  assert.equal(c.passivePerception, 11);
  assert.equal(c.inspiration, true);
  assert.deepEqual(c.hitDice, [{ die: 6, total: 4, used: 1 }, { die: 10, total: 1, used: 0 }]);
  // One spellcasting class (Fighter 1 casts nothing): the Wizard's own table at level 4, 3 first-level slots used.
  assert.deepEqual(c.slots, [{ level: 1, max: 4, used: 3 }, { level: 2, max: 3, used: 0 }]);
  assert.equal(c.pact, null);
  assert.deepEqual(c.attacks, [
    { name: 'Dagger', hit: 5, damage: '1d4 + 2 piercing', range: '20/60 ft' },
    { name: 'Light Crossbow +1', hit: 6, damage: '1d8 + 3 piercing', range: '80/320 ft' },
  ]);
  assert.deepEqual(c.features.map((f) => f.name), ['Arcane Recovery', 'Sculpt Spells', 'Second Wind', 'Darkvision', 'Dwarven Resilience']);
  assert.deepEqual(c.uses, [
    { name: 'Arcane Recovery', max: 1, used: 0, reset: 'long rest' },
    { name: 'Second Wind', max: 1, used: 1, reset: 'short rest' },
    { name: 'Lucky', max: 3, used: 1, reset: 'long rest' },
  ]);
  assert.equal(c.traits.flaws, 'Too curious.');
  assert.match(c.traits.backstory, /library\.\nLeft/);
});

test('SheetDdb_MulticlassSlots: caster levels add up on the multiclass table; a warlock keeps pact slots apart', () => {
  const rules = (div: number, table: number[][]) => ({ multiClassSpellSlotDivisor: div, multiClassSpellSlotRounding: 1, levelSpellSlots: table });
  const c = mapDdb(ddbJson({
    classes: [
      { level: 3, definition: { name: 'Wizard', hitDice: 6, spellRules: rules(1, []) } },
      { level: 4, definition: { name: 'Paladin', hitDice: 10, spellRules: rules(2, []) } },
      { level: 2, definition: { name: 'Warlock', hitDice: 8, spellRules: rules(1, [[], [1], [2], [0, 2]]) } },
    ],
    spellSlots: [{ level: 1, used: 1 }], pactMagic: [{ level: 1, used: 2 }],
  }));
  // Wizard 3 + Paladin 4/2 = caster level 5.
  assert.deepEqual(c.slots, [{ level: 1, max: 4, used: 1 }, { level: 2, max: 3, used: 0 }, { level: 3, max: 2, used: 0 }]);
  assert.deepEqual(c.pact, { level: 1, max: 2, used: 2 });
});

test('SheetDdb_MapIsForgiving: overrides win, missing parts stay empty, an error body or other JSON is refused', () => {
  const c = mapDdb(ddbJson({ overrideHitPoints: 60, overrideStats: [{ id: 1, value: 19 }], characterValues: [{ typeId: 1, value: 20 }], inventory: undefined, modifiers: undefined, conditions: 'nope' }));
  assert.equal(c.hp.max, 60);
  assert.equal(c.abilities.str, 19);
  assert.equal(c.ac, 20);
  assert.deepEqual(c.items, []);
  assert.deepEqual(c.conditions, []);
  // The bare character object (no { data } wrapper) works too.
  assert.equal(mapDdb(ddbJson().data).name, 'Brindle Ashvale');
  assert.throws(() => mapDdb({ success: false, message: 'Unauthorized' }), /Unauthorized/);
  assert.throws(() => mapDdb({ hello: 'world' }), /does not look like a D&D Beyond character/);
  assert.throws(() => mapDdb('text'), /does not look like/);
});

test('SheetDdb_ModuleIsChecked: a hand-saved Character module keeps only the import shape, bounded', () => {
  const clean = cleanCharacter({ ...mapDdb(ddbJson()), url: 'https://evil.example/x', name: 'x'.repeat(500), extra: 'dropped', abilities: { str: 999 } }) as any;
  assert.equal(clean.url, '');
  assert.equal(clean.name.length, 80);
  assert.equal(clean.extra, undefined);
  assert.equal(clean.abilities.str, 30);
  assert.deepEqual(cleanCharacter({ source: 'somewhere else' }), {});
  assert.throws(() => cleanModules([{ type: 'character' }, { type: 'character' }]), /Only one Character module/);
});

test('SheetDdb_Preview: dryRun reads the character and the warning without changing the sheet', async () => {
  const seen = fakeDdb(() => ({ status: 200, body: ddbJson() }));
  try {
    const out = await ok('POST', `${SH()}/me/import/ddb`, T.jess, { url: 'https://www.dndbeyond.com/characters/87654321', dryRun: true });
    assert.equal(out.character.name, 'Brindle Ashvale');
    assert.match(out.warning, /no official API/);
    assert.match(out.warning, /without notice/);
    assert.deepEqual(seen, ['https://character-service.dndbeyond.com/character/v5/character/87654321']);
    const sheet = await ok('GET', `${SH()}/me`, T.jess);
    assert.equal(sheet.hp, null);
    assert.ok(!sheet.modules.some((m: any) => m.type === 'character'));
  } finally { deps.fetch = realFetch; }
});

test('SheetDdb_PlayerImport: Character module first, HP and conditions logged as an import, name and ability scores; spells stay the DM’s', async () => {
  fakeDdb(() => ({ status: 200, body: ddbJson() }));
  try {
    const out = await ok('POST', `${SH()}/me/import/ddb`, T.jess, { url: '87654321', apply: { spells: true } });
    assert.deepEqual(out.applied, ['counters', 'sheetStats', 'character', 'health', 'conditions', 'name', 'stats']);
    assert.equal(out.learned, 0);
    const sheet = await ok('GET', `${SH()}/me`, T.jess);
    assert.equal(sheet.modules[0].type, 'character');
    assert.equal(sheet.modules[0].data.level, 5);
    // The Stats module: the default rows filled from D&D Beyond.
    const stats = Object.fromEntries(sheet.modules.find((m: any) => m.type === 'stats').data.entries.map((e: any) => [e.label, e.value]));
    assert.deepEqual(stats, { AC: '16', Initiative: '+2', Speed: '25 ft', Proficiency: '+3', 'Passive Perception': '11', 'Passive Insight': '11', 'Passive Investigation': '13', 'Spell save DC': '14', 'Spell attack': '+6' });
    const counters = sheet.modules.find((m: any) => m.type === 'counters').data.entries;
    assert.deepEqual(counters.filter((e: any) => /Arcane|Second|Lucky|Hit dice/.test(e.label)).map((e: any) => [e.label, e.value, e.max]),
      [['Arcane Recovery', 1, 1], ['Second Wind', 0, 1], ['Lucky', 2, 3], ['Hit dice (d6)', 3, 4], ['Hit dice (d10)', 1, 1]]);
    assert.equal(sheet.name, 'Brindle Ashvale');
    assert.deepEqual([sheet.hp, sheet.maxHp, sheet.tempHp], [40, 47, 3]);
    assert.deepEqual(sheet.conditions, ['Poisoned', 'Exhaustion 2']);
    const log = (await ok('GET', `${SH()}/log`, T.jess)).log;
    assert.ok(log.some((x: any) => x.kind === 'max' && x.after === 47 && x.source === 'import' && /D&D Beyond/.test(x.note)));
    const sp = await ok('GET', `/api/worlds/${W}/spells/characters/me`, T.jess);
    assert.equal(sp.level, 5);
    assert.equal(sp.class, 'Wizard');
    assert.equal(sp.abilities.int, 16);
    assert.equal(sp.known.length, 0);

    // Importing again replaces the module rather than adding a second one.
    fakeDdb(() => ({ status: 200, body: ddbJson({ removedHitPoints: 0, conditions: [] }) }));
    await ok('POST', `${SH()}/me/import/ddb`, T.jess, { url: '87654321', apply: { name: false } });
    const again = await ok('GET', `${SH()}/me`, T.jess);
    assert.equal(again.modules.filter((m: any) => m.type === 'character').length, 1);
    assert.equal(again.hp, 47);
    // Counters with the same name are updated, not doubled.
    assert.equal(again.modules.find((m: any) => m.type === 'counters').data.entries.filter((e: any) => e.label === 'Lucky').length, 1);
    // A player's later layout save keeps the module.
    await ok('PUT', `${SH()}/me/modules`, T.jess, { modules: again.modules });
    assert.equal((await ok('GET', `${SH()}/me`, T.jess)).modules[0].data.name, 'Brindle Ashvale');
  } finally { deps.fetch = realFetch; }
});

test('SheetDdb_Permissions: a player imports only onto their own sheet; the DM onto anyone’s and may add known spells', async () => {
  fakeDdb(() => ({ status: 200, body: ddbJson({ name: 'Tomas of Beyond' }) }));
  try {
    assert.equal((await call('POST', `${SH()}/${ID.tom}/import/ddb`, T.jess, { url: '87654321' })).status, 404);
    const out = await ok('POST', `${SH()}/${ID.tom}/import/ddb`, T.dm, { url: '87654321', apply: { spells: true, name: false } });
    assert.ok(out.applied.includes('spells'));
    assert.ok(out.learned >= 2, `learned ${out.learned}`);
    assert.ok(out.notes.some((n: string) => /Blorbo/.test(n)), 'homebrew not in the list is named');
    const sp = await ok('GET', `/api/worlds/${W}/spells/characters/${ID.tom}`, T.dm);
    assert.ok(sp.known.some((s: any) => s.name === 'Magic Missile' && s.how === 'import'));
    const sheet = await ok('GET', `${SH()}/${ID.tom}`, T.dm);
    assert.equal(sheet.name, 'Tomas');
    assert.ok((await ok('GET', `${SH()}/log?account=${ID.tom}`, T.dm)).log.some((x: any) => x.source === 'import' && x.by === ID.dm));
  } finally { deps.fetch = realFetch; }
});

test('SheetDdb_Errors: private, missing, changed format, a bad link, pasted JSON as the fallback', async () => {
  fakeDdb((id) => (id === '111' ? { status: 403, body: { success: false } } : id === '222' ? { status: 404, body: {} } : id === '333' ? { status: 200, body: '<html>new site</html>' } : { status: 500, body: {} }));
  try {
    const priv = await call('POST', `${SH()}/me/import/ddb`, T.tom, { url: 'https://www.dndbeyond.com/characters/111', dryRun: true });
    assert.equal(priv.status, 403);
    assert.match(priv.body.error, /Character Privacy to Public/);
    assert.equal((await call('POST', `${SH()}/me/import/ddb`, T.tom, { url: '222', dryRun: true })).status, 404);
    const changed = await call('POST', `${SH()}/me/import/ddb`, T.tom, { url: '333', dryRun: true });
    assert.equal(changed.status, 502);
    assert.match(changed.body.error, /paste the character JSON/);
    assert.equal((await call('POST', `${SH()}/me/import/ddb`, T.tom, { url: '444', dryRun: true })).status, 502);
    const bad = await call('POST', `${SH()}/me/import/ddb`, T.tom, { url: 'https://example.com/characters/1234' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /dndbeyond\.com\/characters/);
    assert.equal((await call('POST', `${SH()}/me/import/ddb`, T.tom, { json: '{nope' })).status, 400);
    const pasted = await ok('POST', `${SH()}/me/import/ddb`, T.tom, { json: JSON.stringify(ddbJson({ name: 'Pasted Pal' })), dryRun: true });
    assert.equal(pasted.character.name, 'Pasted Pal');
  } finally { deps.fetch = realFetch; }
});

test('SheetDdb_DmKeepsStats: with spellPlayerStats off a player import leaves class, level and scores alone and says so', async () => {
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellPlayerStats: false });
  fakeDdb(() => ({ status: 200, body: ddbJson({ classes: [{ level: 9, definition: { name: 'Cleric', spellCastingAbilityId: 5 } }] }) }));
  try {
    const out = await ok('POST', `${SH()}/me/import/ddb`, T.tom, { url: '87654321', apply: { name: false } });
    assert.ok(!out.applied.includes('stats'));
    assert.ok(out.notes.some((n: string) => /DM keeps ability scores/.test(n)));
    assert.notEqual((await ok('GET', `/api/worlds/${W}/spells/characters/me`, T.tom)).level, 9);
  } finally {
    deps.fetch = realFetch;
    await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellPlayerStats: true });
  }
});
