// Generators hub: names, NPCs, monsters, taverns and maps work from tables with no
// model; they are seeded and repeat; monster numbers stay near the CR table; maps
// are valid, deterministic, connected and small; saving makes a DM page and a map
// file; the world only ever lends a place or faction that a model could see (never
// classified); players are refused everywhere and only get what the DM shares.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { genNames, RACES } from '../src/features/quickgen/api.ts';
import { crRow, CR_STEPS, parseCr, crForParty } from '../src/features/generators/cr.ts';
import { genMonster, genHumanoid, MONSTER_PRESETS, MONSTER_TYPES } from '../src/features/generators/monster.ts';
import { genNpc, NPC_PRESETS } from '../src/features/generators/npc.ts';
import { genPlaceNames, PLACE_FLAVOURS, PLACE_KINDS } from '../src/features/generators/names.ts';
import { genTavern, priceText, TAVERN_PRESETS } from '../src/features/generators/tavern.ts';
import { genMap, MAP_KINDS, toPng, toSvg } from '../src/features/generators/maps/index.ts';
import { emptyWorld, tiesFrom, type WorldInfo } from '../src/features/generators/world.ts';
import { normalizeStatblock } from '../src/features/agent/statblock.ts';
import { makeRng } from '../src/features/quickgen/rng.ts';
import { isOffensive } from '../src/features/quickgen/names.ts';

const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

const SECRET = 'The harbour council secretly answers to the smuggler queen Velmira every single night';
const CLASSIFIED_PLACE = 'Blackwater Reliquary';

async function boot(opts: { model?: (body: any) => unknown } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-gen-'));
  const calls: any[] = [];
  const fake = (async (url: any, init?: any) => {
    if (String(url).startsWith('http://fake.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      calls.push(body);
      const content = JSON.stringify(opts.model ? opts.model(body) : {});
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, init);
  }) as typeof fetch;
  const env: Record<string, string> = { ALX_ADMIN_TABLE_LOGIN: '1' };
  if (opts.model) { env.ALX_MODEL_CHAT_URL = 'http://fake.test/v1'; env.ALX_MODEL_CHAT_MODEL = 'fake'; }
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env, fetch: fake });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let json: any = t;
    try { json = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: json, headers: r.headers };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Genland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  const page = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown });
  await page('Places/Saltmarsh.md', 'party', `---\nkind: place\ntags: [place]\n---\n# Saltmarsh\nSaltmarsh is a fishing town of grey roofs and gulls.\n\n> [!secret] DM\n> ${SECRET}.\n`);
  await page('Places/Hollow Mill.md', 'dm', `---\nkind: place\ntags: [place]\n---\n# Hollow Mill\nA dm-only ruin upriver.\n`);
  await page('Places/Blackwater Reliquary.md', 'classified', `---\nkind: place\ntags: [place]\n---\n# ${CLASSIFIED_PLACE}\nThe sunken bell opens only when three silver keys turn together at the ebb tide.\n`);
  await page('Factions/Lantern Guild.md', 'party', `---\nkind: faction\ntags: [faction]\n---\n# Lantern Guild\nA guild of lamplighters.\n`);
  const G = `/api/worlds/${W}/generators`;
  return { T, W, G, call, ok, calls, made };
}

const world = (over: Partial<WorldInfo> = {}): WorldInfo => ({ ...emptyWorld(), ...over });

// ---- names ---------------------------------------------------------------

test('Generators_names: dark style works for every race, places and businesses repeat by seed, avoid used titles', () => {
  for (const race of RACES) {
    const a = genNames({ race, style: 'dark', count: 12, seed: 'd' + race });
    assert.ok(a.names.length >= 10, race);
    assert.ok(a.names.every((n) => n.race === race && !isOffensive(n.name) && /^[A-Z][a-z'-]+( [A-Z][a-z'-]+)?$/.test(n.name)), race);
    assert.deepEqual(a, genNames({ race, style: 'dark', count: 12, seed: 'd' + race }));
  }
  assert.throws(() => genNames({ style: 'bogus' }), RangeError);
  for (const kind of PLACE_KINDS) for (const flavour of PLACE_FLAVOURS) {
    const a = genPlaceNames({ kind, flavour, count: 10, seed: 'p' });
    assert.equal(a.names.length, 10, `${kind} ${flavour}`);
    assert.equal(new Set(a.names.map((n) => n.toLowerCase())).size, 10);
    assert.ok(a.names.every((n) => !isOffensive(n)));
    assert.deepEqual(a, genPlaceNames({ kind, flavour, count: 10, seed: 'p' }));
  }
  const first = genPlaceNames({ kind: 'tavern', count: 5, seed: 'z' }).names;
  const next = genPlaceNames({ kind: 'tavern', count: 5, seed: 'z', avoid: first.slice(0, 3).map((s) => s.toUpperCase()) }).names;
  assert.ok(!next.some((n) => first.slice(0, 3).includes(n)), 'used titles are skipped');
  assert.throws(() => genPlaceNames({ kind: 'castle of doom' }), RangeError);
});

// ---- NPCs ----------------------------------------------------------------

test('Generators_npc: every preset works offline, repeats by seed, and fills every field', () => {
  for (const preset of NPC_PRESETS) {
    for (let i = 0; i < 6; i++) {
      const a = genNpc({ preset, seed: `${preset}${i}`, statblock: true });
      for (const k of ['name', 'race', 'look', 'voice', 'want', 'secret', 'hook']) assert.ok(a.fields[k]?.trim().length > 2, `${preset} ${k}`);
      assert.ok((RACES as readonly string[]).includes(a.fields.race));
      assert.ok(!isOffensive(a.fields.name));
      assert.ok(a.statblock && normalizeStatblock(a.statblock).ac > 0, `${preset} statblock`);
      assert.equal(a.tie, null, 'no world, no tie');
      assert.deepEqual(a, genNpc({ preset, seed: `${preset}${i}`, statblock: true }));
    }
  }
  assert.equal(genNpc({ preset: 'dwarf', seed: 1 }).fields.race, 'dwarf');
  assert.equal(genNpc({ preset: 'elf', seed: 1 }).fields.race, 'elf');
  assert.throws(() => genNpc({ preset: 'dragonlord' }), RangeError);
  assert.throws(() => genNpc({ race: 'beholder' }), RangeError);
  // a race option is respected for names
  assert.equal(genNpc({ preset: 'noble', race: 'tiefling', seed: 2 }).fields.race, 'tiefling');
});

test('Generators_npc: locking a field keeps it while the rest is rerolled', () => {
  const a = genNpc({ preset: 'rogue', seed: 'one' });
  const b = genNpc({ preset: 'rogue', seed: 'two', locks: { name: a.fields.name, race: a.fields.race, secret: a.fields.secret } });
  assert.equal(b.fields.name, a.fields.name);
  assert.equal(b.fields.race, a.fields.race);
  assert.equal(b.fields.secret, a.fields.secret);
  assert.notEqual(b.fields.look, a.fields.look);
});

test('Generators_npc: world ties come only from places and factions the AI view lists, and are skipped when there are none', () => {
  const rows = [
    { id: 'p1', title: 'Saltmarsh', path: 'Places/Saltmarsh.md', kind: 'place', tags: [], visibility: 'party' },
    { id: 'p2', title: 'Hollow Mill', path: 'Places/Hollow Mill.md', kind: 'place', tags: [], visibility: 'dm' },
    { id: 'f1', title: 'Lantern Guild', path: 'Factions/Lantern Guild.md', kind: 'faction', tags: [], visibility: 'party' },
    { id: 'x1', title: 'A generated tavern', path: 'Generated/Taverns/A generated tavern.md', kind: 'tavern', tags: ['generated', 'gen-tavern'], visibility: 'dm' },
    { id: 'y1', title: 'Captain Orsk', path: 'People/Captain Orsk.md', kind: 'person', tags: [], visibility: 'dm' },
  ];
  const { places, factions } = tiesFrom(rows);
  assert.deepEqual(places.map((p) => p.title).sort(), ['Hollow Mill', 'Saltmarsh']);
  assert.deepEqual(factions.map((p) => p.title), ['Lantern Guild']);
  const w = world({ places, factions });
  const titles = new Set<string>();
  for (let i = 0; i < 40; i++) { const n = genNpc({ preset: 'random', seed: `t${i}`, world: w }); assert.ok(n.tie, 'a tie is found'); titles.add(n.tie!.title); assert.match(n.fields.tie, new RegExp(n.tie!.title)); }
  assert.deepEqual([...titles].sort(), ['Hollow Mill', 'Lantern Guild', 'Saltmarsh']);
  assert.equal(genNpc({ preset: 'noble', seed: 1, world: world() }).tie, null);
  assert.ok(!genNpc({ preset: 'noble', seed: 1 }).fields.tie, 'no tie text without a world');
});

// ---- monsters ------------------------------------------------------------

test('Generators_cr: the CR table grows with CR and parses', () => {
  let prev = crRow(0);
  for (const cr of CR_STEPS.slice(1)) {
    const row = crRow(cr);
    assert.ok(row.hp >= prev.hp && row.ac >= prev.ac && row.atk >= prev.atk && row.dmg >= prev.dmg && row.dc >= prev.dc && row.xp > prev.xp, `CR ${cr}`);
    prev = row;
  }
  assert.equal(parseCr('1/4'), 0.25);
  assert.equal(parseCr('CR 3'), 3);
  assert.throws(() => parseCr('99'), RangeError);
  assert.ok(crForParty(5, 4, true) > crForParty(5, 4, false));
  assert.ok(crForParty(5, 6, true) > crForParty(5, 3, true));
});

test('Generators_monster: every preset gives a valid statblock whose numbers sit near the CR table', () => {
  for (const preset of MONSTER_PRESETS) {
    for (let i = 0; i < 10; i++) {
      const m = genMonster({ preset, seed: `${preset}-${i}`, concept: preset === 'homebrew' ? 'a hungry swamp hag who lurks in the reeds' : undefined, base: 'builtin' });
      const sb = normalizeStatblock(m.statblock);
      const t = crRow(m.cr);
      assert.ok(sb.hp / t.hp > 0.65 && sb.hp / t.hp < 1.35, `${preset} ${sb.name} CR ${m.crLabel} HP ${sb.hp} vs ${t.hp}`);
      assert.ok(Math.abs(sb.ac - t.ac) <= 3, `${preset} AC ${sb.ac} vs ${t.ac}`);
      const atk = Number(/Attack Roll: ([+-]\d+)/.exec(sb.actions.map((a) => a.text).join(' '))?.[1]);
      assert.ok(Math.abs(atk - t.atk) <= 2, `${preset} attack ${atk} vs ${t.atk}`);
      assert.ok(sb.actions.length >= 1 && sb.xp === t.xp);
      assert.ok(!isOffensive(sb.name));
      assert.deepEqual(m.statblock, genMonster({ preset, seed: `${preset}-${i}`, concept: preset === 'homebrew' ? 'a hungry swamp hag who lurks in the reeds' : undefined, base: 'builtin' }).statblock);
    }
  }
  const type = genMonster({ preset: 'undead', seed: 'u', base: 'builtin' });
  assert.equal(type.statblock.type, 'undead');
  assert.equal(genMonster({ preset: 'demon', seed: 'u', base: 'builtin' }).statblock.type, 'fiend');
  assert.throws(() => genMonster({ preset: 'homebrew' }), RangeError);
  assert.throws(() => genMonster({ preset: 'dragon', cr: 'lots' }), RangeError);
  assert.throws(() => genMonster({ type: 'banana' }), RangeError);
});

test('Generators_monster: a boss has legendary actions and lair actions; low CR stays low; party level sets the CR', () => {
  for (const type of MONSTER_TYPES) {
    const b = genMonster({ preset: 'boss', type, cr: 9, seed: `b-${type}` });
    assert.equal(b.cr, 9);
    assert.ok(b.statblock.legendaryActions.length === 3, type);
    assert.ok(b.statblock.traits.some((t) => /Legendary Resistance/.test(t.name)), type);
    assert.ok(b.lair.length >= 3, `${type} lair`);
  }
  for (let i = 0; i < 20; i++) assert.ok(genMonster({ preset: 'low-cr', seed: `l${i}` }).cr <= 4);
  const solo = genMonster({ preset: 'random', partyLevel: 10, partySize: 4, seed: 's', base: 'builtin' });
  const big = genMonster({ preset: 'random', partyLevel: 10, partySize: 8, seed: 's', base: 'builtin' });
  assert.ok(big.cr > solo.cr);
  const h = genHumanoid('wizard', 3, 'Test Mage', makeRng('x'));
  assert.equal(h.type, 'humanoid');
  assert.ok(h.actions.length >= 2);
});

test('Generators_monster: a game-module monster is reskinned and retuned to the target CR, with its attribution', () => {
  const pool = [{ ref: 'm:wolf', name: 'Wolf', moduleName: 'Test SRD', attribution: 'From the Test SRD, CC-BY.', data: { size: 'Medium', type: 'beast', alignment: 'unaligned', cr: 0.25, xp: 50, ac: 13, hp: 11, speed: { walk: '40 ft.' }, abilities: { str: 14, dex: 15, con: 12, int: 3, wis: 12, cha: 6 }, actions: [{ name: 'Bite', text: 'Melee Attack Roll: +4, reach 5 ft. Hit: 7 (2d4 + 2) Piercing damage. Strength Saving Throw: DC 11.' }] } }];
  const a = genMonster({ preset: 'beast', cr: 0.25, seed: 'w', pool });
  assert.equal(a.source.kind, 'module');
  assert.equal(a.source.attribution, 'From the Test SRD, CC-BY.');
  assert.equal(a.statblock.hp, 11);
  const b = genMonster({ preset: 'beast', cr: 1, seed: 'w', pool });
  assert.equal(b.source.kind, 'module');
  assert.ok(b.statblock.hp > 25, 'HP retuned up');
  assert.match(b.statblock.actions[0].text, /Attack Roll: \+5/);
  assert.match(b.statblock.actions[0].text, /DC 12/);
  assert.ok(b.notes.some((n) => /Retuned/.test(n)));
  // too far from any module monster: built from the math instead
  assert.equal(genMonster({ preset: 'beast', cr: 12, seed: 'w', pool }).source.kind, 'builtin');
  assert.equal(genMonster({ preset: 'beast', cr: 0.25, seed: 'w', pool, base: 'builtin' }).source.kind, 'builtin');
});

// ---- taverns -------------------------------------------------------------

test('Generators_tavern: every flavour gives a name, owner, priced menu in the world coins, rooms, patrons, rumours and a map', () => {
  assert.equal(priceText(150, 'gsc'), '1 gp, 5 sp');
  assert.equal(priceText(8, 'gsc'), '8 cp');
  assert.equal(priceText(150, 'gold'), '1.5 gp');
  assert.equal(priceText(4, 'gold'), '0.04 gp');
  for (const flavour of TAVERN_PRESETS) {
    const t = genTavern({ flavour, seed: `tav-${flavour}`, coins: 'gsc' });
    for (const k of ['name', 'atmosphere', 'menu', 'rooms', 'patrons', 'rumours']) assert.ok(t.fields[k].length > 10, `${flavour} ${k}`);
    assert.match(t.fields.menu, /\d+ (cp|sp|gp)/);
    assert.equal(t.owner.preset, 'tavern-keeper');
    assert.equal(t.map.kind, 'tavern');
    assert.equal(t.map.title, t.fields.name);
    assert.ok(t.map.key.length >= 8);
    assert.deepEqual(t.fields, genTavern({ flavour, seed: `tav-${flavour}`, coins: 'gsc' }).fields);
  }
  assert.equal(genTavern({ flavour: 'dwarven', seed: 1 }).owner.fields.race, 'dwarf');
  assert.equal(genTavern({ flavour: 'elven', seed: 1 }).owner.fields.race, 'elf');
  assert.match(genTavern({ flavour: 'pirate', seed: 1, coins: 'gold' }).fields.menu, /gp/);
  assert.doesNotMatch(genTavern({ flavour: 'pirate', seed: 1, coins: 'gold' }).fields.menu, /\b(sp|cp)\b/);
  // rumours come from what the party already knows when the world has it
  const w = world({ rumours: ['The lighthouse keeper has not been seen since the storm'] });
  assert.ok([1, 2, 3, 4, 5, 6].some((i) => /lighthouse keeper/.test(genTavern({ flavour: 'common', seed: `r${i}`, world: w }).fields.rumours)));
  assert.throws(() => genTavern({ flavour: 'martian' }), RangeError);
});

// ---- maps ----------------------------------------------------------------

const wellFormed = (svg: string) => {
  assert.ok(svg.startsWith('<svg ') && svg.trimEnd().endsWith('</svg>'));
  assert.ok(!/<script|onload=|javascript:/i.test(svg));
  const tags = [...svg.matchAll(/<(\/?)([a-z]+)([^>]*?)(\/?)>/g)];
  const stack: string[] = [];
  for (const [, close, name, , self] of tags) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, 'tags nest');
    else stack.push(name);
  }
  assert.equal(stack.length, 0);
};
const isPng = (b: Buffer) => b.length > 100 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' && b.toString('latin1', b.length - 8, b.length - 4) === 'IEND';

test('Generators_maps: every kind and size is deterministic, valid SVG and PNG, fast and small', () => {
  for (const kind of MAP_KINDS) {
    for (const size of ['small', 'medium', 'large'] as const) {
      const t0 = Date.now();
      const a = genMap(kind, { seed: 'det', size });
      const svg = toSvg(a.canvas, { dm: true });
      assert.ok(Date.now() - t0 < 1000, `${kind} ${size} took ${Date.now() - t0} ms`);
      assert.equal(svg, toSvg(genMap(kind, { seed: 'det', size }).canvas, { dm: true }), `${kind} ${size} repeats by seed`);
      assert.notEqual(svg, toSvg(genMap(kind, { seed: 'other', size }).canvas, { dm: true }), `${kind} ${size} differs by seed`);
      wellFormed(svg);
      assert.ok(svg.length < 600_000, `${kind} ${size} svg is ${svg.length}`);
      assert.ok(a.canvas.w <= 1800 && a.canvas.h <= 1400, `${kind} ${size} canvas ${a.canvas.w}x${a.canvas.h}`);
      assert.ok(a.key.length >= 1 && a.title && a.seed === 'det');
      assert.ok(a.key.every((k) => k.n && k.name && k.text));
    }
    const png = toPng(genMap(kind, { seed: 'det', size: 'medium' }).canvas, { dm: true });
    assert.ok(isPng(png) && png.length < 1_500_000, `${kind} png ${png.length}`);
  }
  assert.throws(() => genMap('spaceship'), RangeError);
});

test('Generators_maps: dungeon and cave rooms connect, and the player view hides secret doors and traps', () => {
  for (let i = 0; i < 30; i++) {
    for (const kind of ['dungeon', 'cave', 'castle', 'tavern', 'forest', 'region'] as const) {
      const m = genMap(kind, { seed: `conn-${i}`, size: i % 3 === 0 ? 'small' : i % 3 === 1 ? 'medium' : 'large' });
      if (kind === 'region') continue;
      assert.equal(m.stats.connected, true, `${kind} seed conn-${i}: ${m.stats.reached} of ${m.stats.total} connect`);
      assert.equal(m.stats.reached, m.stats.total);
    }
  }
  const d = genMap('dungeon', { seed: 'secret-door', size: 'large' });
  assert.ok(Number(d.stats.secretDoors) >= 1);
  const dmSvg = toSvg(d.canvas, { dm: true });
  const playerSvg = toSvg(d.canvas, { dm: false });
  assert.match(dmSvg, /fill="#c9a0e8"/);
  assert.doesNotMatch(playerSvg, /#c9a0e8|#f2b8b0/);
  assert.ok(playerSvg.length < dmSvg.length);
  assert.notDeepEqual(toPng(d.canvas, { dm: true }), toPng(d.canvas, { dm: false }));
  // options pick the flavour and theme
  assert.equal(genMap('dungeon', { seed: 1, flavour: 'crypt' }).flavour, 'crypt');
  assert.equal(genMap('battlemap', { seed: 1, theme: 'river' }).flavour, 'river');
  assert.equal(genMap('forest', { seed: 1, theme: 'swamp' }).flavour, 'swamp');
  assert.equal(genMap('tavern', { seed: 1, flavour: 'pirate' }).flavour, 'pirate');
});

// ---- the app --------------------------------------------------------------

test('Generators_routes: the DM generates every kind; players are refused everywhere', async () => {
  const e = await boot();
  const out = await e.ok('GET', `${e.G}/options`, e.T.dm);
  assert.ok(out.npc.presets.includes('villain') && out.map.kinds.includes('region') && out.model === false);
  for (const spec of [
    { kind: 'npc', preset: 'villain', options: { statblock: true } }, { kind: 'monster', preset: 'dragon', options: { cr: 8 } }, { kind: 'tavern', preset: 'haunted' },
    { kind: 'map', preset: 'dungeon', options: { size: 'small' } }, { kind: 'names', options: { nameKind: 'tavern', flavour: 'pirate' } }, { kind: 'names', options: { nameKind: 'person', style: 'dark', race: 'dwarf' } },
  ]) {
    const r = await e.ok('POST', `${e.G}/generate`, e.T.dm, { ...spec, seed: 'abc' });
    assert.equal(r.kind, spec.kind);
    assert.equal(r.seed, 'abc');
    assert.ok(r.title && r.sections.length && r.md.length > 20);
    assert.deepEqual(r, await e.ok('POST', `${e.G}/generate`, e.T.dm, { ...spec, seed: 'abc' }), 'a seed repeats');
  }
  const map = await e.ok('POST', `${e.G}/generate`, e.T.dm, { kind: 'map', preset: 'city', seed: 'q' });
  assert.ok(map.map.svg.startsWith('<svg'));
  assert.equal((await e.ok('POST', `${e.G}/generate?compact=1`, e.T.dm, { kind: 'map', preset: 'city', seed: 'q' })).map.svg, undefined);
  // bad input is a 400, not a crash
  assert.equal((await e.call('POST', `${e.G}/generate`, e.T.dm, { kind: 'npc', preset: 'dragonlord' })).status, 400);
  assert.equal((await e.call('POST', `${e.G}/generate`, e.T.dm, { kind: 'spaceship' })).status, 400);
  assert.equal((await e.call('POST', `${e.G}/generate`, e.T.dm, { kind: 'map', preset: 'spaceship' })).status, 400);
  assert.equal((await e.call('POST', `${e.G}/generate`, e.T.dm, { kind: 'monster', preset: 'homebrew' })).status, 400);
  // players: refused on every route
  for (const [m, u, b] of [
    ['GET', '/options'], ['POST', '/generate', { kind: 'npc' }], ['POST', '/save', { kind: 'npc' }], ['POST', '/stage', { kind: 'npc' }],
    ['GET', '/library'], ['GET', '/bestiary'], ['GET', '/names'],
  ] as [string, string, unknown?][]) {
    const r = await e.call(m, `${e.G}${u}`, e.T.jess, b);
    assert.ok([401, 403, 404].includes(r.status), `${m} ${u} gave a player ${r.status}`);
    assert.doesNotMatch(JSON.stringify(r.body), /sections|statblock|svg/);
  }
  assert.equal((await e.call('GET', `${e.G}/options`)).status, 401);
});

test('Generators_world: ties use visible places and factions only, never a classified page, and the library lists what is there', async () => {
  const e = await boot();
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const r = await e.ok('POST', `${e.G}/generate`, e.T.dm, { kind: 'npc', preset: 'random', seed: `w${i}` });
    if (r.tie) seen.add(r.tie.title);
    assert.ok(!JSON.stringify(r).includes(CLASSIFIED_PLACE), 'a classified title never appears');
    assert.ok(!JSON.stringify(r).includes('ebb tide'), 'classified text never appears');
  }
  assert.ok(seen.has('Saltmarsh') && seen.has('Lantern Guild'), [...seen].join(','));
  assert.ok(!seen.has(CLASSIFIED_PLACE));
  const opts = await e.ok('GET', `${e.G}/options`, e.T.dm);
  assert.equal(opts.world.places, 2, 'Saltmarsh and Hollow Mill, not the classified place');
  assert.equal(opts.world.factions, 1);
  // used titles are skipped in generated names
  const taken = await e.ok('GET', `${e.G}/names?nameKind=town&count=40&seed=1`, e.T.dm);
  assert.ok(!taken.names.includes('Saltmarsh'));
});

test('Generators_save: a result is saved as a DM page, a map also as a map file, nothing reaches players, and the library lists it', async () => {
  const e = await boot();
  const spec = { kind: 'map', preset: 'dungeon', seed: 'save1', options: { size: 'small' } };
  const saved = await e.ok('POST', `${e.G}/save`, e.T.dm, spec);
  assert.equal(saved.page.level, 'dm');
  assert.match(saved.page.path, /^Generated\/Maps\//);
  assert.equal(saved.files.length, 2);
  const png = saved.files.find((f: any) => f.kind === 'map');
  assert.ok(png && png.level === 'dm' && png.mime === 'image/png');
  // the page is DM level with the key; the Map page can use the picture
  const page = await e.ok('GET', `/api/worlds/${e.W}/library/pages/${saved.page.id}`, e.T.dm);
  assert.equal(page.visibility, 'dm');
  assert.match(page.body, /Key/);
  const maps = await e.ok('GET', `/api/worlds/${e.W}/files/maps`, e.T.dm);
  assert.ok(maps.some((m: any) => m.name.startsWith(saved.page.title)), 'the Map page lists it');
  const bytes = await fetch(`http://127.0.0.1:${(e.made.app as any).address?.()?.port ?? ''}`).catch(() => null);
  void bytes;
  // a player sees nothing of it
  const pm = await e.ok('GET', `/api/worlds/${e.W}/files/maps`, e.T.jess);
  assert.equal(pm.length, 0);
  assert.equal((await e.call('GET', `/api/worlds/${e.W}/library/pages/${saved.page.id}`, e.T.jess)).status, 404);
  assert.doesNotMatch(JSON.stringify((await e.ok('GET', `/api/worlds/${e.W}/library/pages`, e.T.jess))), /Generated/);
  // a second save of the same spec gets its own path
  const again = await e.ok('POST', `${e.G}/save`, e.T.dm, spec);
  assert.notEqual(again.page.path, saved.page.path);
  // NPC and monster pages, with a statblock the combat importer can read
  const npc = await e.ok('POST', `${e.G}/save`, e.T.dm, { kind: 'npc', preset: 'wizard', seed: 'n1', options: { statblock: true } });
  const npcPage = await e.ok('GET', `/api/worlds/${e.W}/library/pages/${npc.page.id}`, e.T.dm);
  assert.match(npcPage.body, /statblock-json/);
  const mon = await e.ok('POST', `${e.G}/save`, e.T.dm, { kind: 'monster', preset: 'boss', seed: 'm1', options: { type: 'dragon', cr: 10, base: 'builtin' } });
  const combat = await e.ok('POST', `/api/worlds/${e.W}/agent/statblock/${mon.page.id}/combat`, e.T.dm, { initiative: 12 });
  assert.ok(combat.combatant.hp > 100, 'added to combat from the saved page');
  const lib = await e.ok('GET', `${e.G}/library`, e.T.dm);
  assert.equal(lib.total, 4);
  assert.deepEqual(lib.pages.map((p: any) => p.kind).sort(), ['map', 'map', 'monster', 'npc']);
  assert.equal((await e.ok('GET', `${e.G}/library?q=wizard`, e.T.dm)).total, 1, 'search covers title, path and preset');
  assert.equal((await e.ok('GET', `${e.G}/library?q=zzzzqq`, e.T.dm)).total, 0);
  assert.equal((await e.ok('GET', `${e.G}/library?kind=map`, e.T.dm)).total, 2);
  // generated pages are never used as world ties
  const opts = await e.ok('GET', `${e.G}/options`, e.T.dm);
  assert.equal(opts.world.places, 2);
});

test('Generators_save: at party level players read the public part only; the secrets stay in secret blocks; a party map has no DM marks', async () => {
  const e = await boot();
  const gen = await e.ok('POST', `${e.G}/generate`, e.T.dm, { kind: 'npc', preset: 'villain', seed: 'party1', options: { statblock: true } });
  const npc = await e.ok('POST', `${e.G}/save`, e.T.dm, { kind: 'npc', preset: 'villain', seed: 'party1', level: 'party', options: { statblock: true } });
  assert.equal(npc.page.level, 'party');
  assert.equal(npc.title, gen.title, 'saving gives the result the DM saw');
  const asPlayer = await e.ok('GET', `/api/worlds/${e.W}/library/pages/${npc.page.id}`, e.T.jess);
  const text = JSON.stringify(asPlayer);
  assert.ok(text.includes(gen.title), 'the name is public');
  assert.ok(text.includes(gen.fields.look.slice(0, 20)), 'the look is public');
  for (const k of ['secret', 'want', 'hook']) assert.ok(!text.includes(gen.fields[k]), `${k} is not in the player copy`);
  assert.doesNotMatch(text, /statblock-json/);
  // the DM still has the secrets on the page
  const asDm = await e.ok('GET', `/api/worlds/${e.W}/library/pages/${npc.page.id}`, e.T.dm);
  assert.ok(asDm.body.includes(gen.fields.secret));
  // a party map: picture at party level, without the DM's marks
  const m = await e.ok('POST', `${e.G}/save`, e.T.dm, { kind: 'map', preset: 'dungeon', seed: 'secret-door', level: 'party', options: { size: 'large' } });
  assert.equal(m.files.find((f: any) => f.kind === 'map').level, 'party');
  const pm = await e.ok('GET', `/api/worlds/${e.W}/files/maps`, e.T.jess);
  assert.equal(pm.length, 1);
  const mp = JSON.stringify(await e.ok('GET', `/api/worlds/${e.W}/library/pages/${m.page.id}`, e.T.jess));
  assert.doesNotMatch(mp, /Occupants|Treasure|DM:/);
  // a result that repeats DM-only words is refused at party level
  const leak = await e.call('POST', `${e.G}/save`, e.T.dm, { kind: 'npc', preset: 'noble', seed: 'x', level: 'party', locks: { look: `Looks like ${SECRET}` } });
  assert.equal(leak.status, 409);
});

test('Generators_stage: send to table stages a card with the public text only, and the map picture without DM marks', async () => {
  const e = await boot();
  const gen = await e.ok('POST', `${e.G}/generate`, e.T.dm, { kind: 'npc', preset: 'cleric', seed: 'stg' });
  const r = await e.ok('POST', `${e.G}/stage`, e.T.dm, { kind: 'npc', preset: 'cleric', seed: 'stg' });
  assert.ok(r.cardId && r.shown === false);
  const board = await e.ok('GET', `/api/worlds/${e.W}/stage`, e.T.dm);
  const card = board.cards.find((c: any) => c.id === r.cardId);
  assert.ok(card);
  assert.ok(card.text.includes(gen.fields.look.slice(0, 20)));
  assert.ok(!card.text.includes(gen.fields.secret) && !card.text.includes(gen.fields.want));
  // not shown yet: a player's board has nothing
  const pb = await e.ok('GET', `/api/worlds/${e.W}/stage`, e.T.jess);
  assert.equal(pb.cards.length, 0);
  const shown = await e.ok('POST', `${e.G}/stage`, e.T.dm, { kind: 'map', preset: 'cave', seed: 'c', show: true });
  assert.ok(shown.imageCardId && shown.shown === true);
  assert.equal((await e.ok('GET', `/api/worlds/${e.W}/stage`, e.T.jess)).cards.length, 1);
});

test('Generators_bestiary: module monsters filter by CR and type', async () => {
  const e = await boot();
  const all = await e.ok('GET', `${e.G}/bestiary?limit=5`, e.T.dm);
  assert.ok(all.total > 100 && all.monsters.length === 5 && all.types.includes('dragon'));
  const low = await e.ok('GET', `${e.G}/bestiary?crMax=0.5&type=undead&limit=200`, e.T.dm);
  assert.ok(low.monsters.length > 2 && low.monsters.every((m: any) => m.cr <= 0.5 && m.type.startsWith('undead')));
  const dragons = await e.ok('GET', `${e.G}/bestiary?crMin=10&crMax=20&type=dragon&limit=200`, e.T.dm);
  assert.ok(dragons.monsters.length > 3 && dragons.monsters.every((m: any) => m.cr >= 10 && m.cr <= 20 && m.type === 'dragon'));
  assert.equal((await e.call('GET', `${e.G}/bestiary?crMin=x`, e.T.dm)).status, 400);
  // reskinned from the built-in module when one fits, with its attribution
  const m = await e.ok('POST', `${e.G}/generate`, e.T.dm, { kind: 'monster', preset: 'undead', seed: 'mod', options: { cr: 1 } });
  assert.match(m.attribution, /System Reference Document/);
  assert.match(m.notes.join(' '), /Based on/);
});

test('Generators_model: without a chat model the tables fill everything; with one the text is improved, locks are kept, and nothing classified is sent', async () => {
  const none = await boot();
  const plain = await none.ok('POST', `${none.G}/generate`, none.T.dm, { kind: 'npc', preset: 'rogue', seed: 'm', enrich: true });
  assert.equal(plain.enriched, false);
  const withModel = await boot({ model: (body) => { const u = JSON.parse(body.messages[1].content); return Object.fromEntries(Object.keys(u.fields).map((k) => [k, `improved ${k}`])); } });
  const r = await withModel.ok('POST', `${withModel.G}/generate`, withModel.T.dm, { kind: 'npc', preset: 'rogue', seed: 'm', enrich: true, locks: { want: 'a locked want' } });
  assert.equal(r.enriched, true);
  assert.equal(r.fields.look, 'improved look');
  assert.equal(r.fields.want, 'a locked want');
  assert.equal(r.fields.name, plain.fields.name);
  assert.ok(withModel.calls.length >= 1);
  assert.ok(withModel.calls.every((c) => !JSON.stringify(c).includes('ebb tide') && !JSON.stringify(c).includes(CLASSIFIED_PLACE)), 'no classified text in a model request');
  // enrich is off by default: no model call
  const before = withModel.calls.length;
  await withModel.ok('POST', `${withModel.G}/generate`, withModel.T.dm, { kind: 'npc', preset: 'rogue', seed: 'm2' });
  assert.equal(withModel.calls.length, before);
  // a model that answers badly leaves the table text alone
  const bad = await boot({ model: () => 'not an object' });
  const b = await bad.ok('POST', `${bad.G}/generate`, bad.T.dm, { kind: 'tavern', preset: 'elven', seed: 'x', enrich: true });
  assert.equal(b.enriched, false);
  assert.ok(b.fields.atmosphere.length > 10);
});

test('Generators_mcp: generate, generate_map and save_generated are DM-only tools', async () => {
  const e = await boot();
  const { toolsFor } = await import('../src/routes/mcpServer.ts');
  const dm = toolsFor(true).map((t: any) => t.name);
  const read = toolsFor(false).map((t: any) => t.name);
  for (const n of ['generate', 'generate_map', 'save_generated']) assert.ok(dm.includes(n), n);
  assert.ok(read.includes('generate') && read.includes('generate_map') && !read.includes('save_generated'), 'saving needs a write key');
  for (const t of toolsFor(true).filter((x: any) => ['generate', 'generate_map', 'save_generated'].includes(x.name))) assert.equal(t.dmOnly, true, `${t.name} is dmOnly`);
  // what a tool call does against the real route
  const t = toolsFor(true).find((x: any) => x.name === 'generate_map')!;
  const c = t.call({ kind: 'castle', seed: 's', size: 'small' });
  const r = await e.ok(c.method, `/api/worlds/${e.W}${c.path}`, e.T.dm, c.body);
  assert.equal(r.map.kind, 'castle');
  assert.equal(r.map.svg, undefined, 'the agent gets the key, not the picture');
  const sv = toolsFor(true).find((x: any) => x.name === 'save_generated')!.call({ kind: 'map', map_kind: 'cave', seed: 'k' });
  const saved = await e.ok(sv.method, `/api/worlds/${e.W}${sv.path}`, e.T.dm, sv.body);
  assert.equal(saved.page.level, 'dm');
  assert.equal((await e.call(sv.method, `/api/worlds/${e.W}${sv.path}`, e.T.jess, sv.body)).status, 403);
});
