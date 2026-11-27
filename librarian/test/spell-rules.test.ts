// The spell rules engine (Spell_Plan.md step 1): every formula against the
// plan's own worked numbers, the setting's validation and merge, and the
// /spells/rules route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { DEFAULT_COSTS } from '../src/features/spells/mana.ts';
import {
  DEFAULT_SPELL_RULES as R, PLAN_COSTS, casterLevel, checkSpellRules, complexity, dailyProgress, dualCastUnlocked, extraRecipeSpells, fuseInsight,
  gradeFinalCheck, highestSpellLevel, isHybrid, learnGates, levelUpInsightBank, lineMastery, multiclassHighest, multiclassPool, poolFor, preview,
  quoteCast, quoteDual, memoryLearn, resolveRules, scroll, studyCoin, studyDays, studyPoints, upcastCost, type CastState, type LearnInput,
} from '../src/features/spells/rules.ts';

const C = PLAN_COSTS;
const fresh: CastState = { mana: 50, max: 50, characterLevel: 9, leveledThisTurn: 0, surgeUsed: false, echoCount: 0, highUsed: false };

test('SpellRules: the plan cost table is the default mana cost table', () => {
  assert.deepEqual(DEFAULT_COSTS, PLAN_COSTS);
});

test('SpellRules: pools and highest spell level per caster type and for multiclass', () => {
  assert.equal(poolFor('full', 1, R), 4);
  assert.equal(poolFor('full', 20, R), 139);
  assert.equal(poolFor('half', 9, R), 27);
  assert.equal(poolFor('third', 2, R), 0);
  assert.equal(poolFor('third', 3, R), 4);
  assert.equal(poolFor('none', 20, R), 0);
  assert.equal(poolFor('full', 0, R), 0);
  assert.deepEqual([1, 3, 17, 20].map((l) => highestSpellLevel('full', l)), [1, 2, 9, 9]);
  assert.deepEqual([1, 4, 5, 9, 13, 17].map((l) => highestSpellLevel('half', l)), [1, 1, 2, 3, 4, 5]);
  assert.deepEqual([2, 3, 7, 13, 19].map((l) => highestSpellLevel('third', l)), [0, 1, 2, 3, 4]);
  assert.equal(highestSpellLevel('none', 20), 0);
  // Wizard 5 / Paladin 5 / Eldritch Knight 3: 5 + 2 + 1 = caster level 8 on the full table.
  assert.equal(casterLevel({ full: 5, half: 5, third: 3 }), 8);
  assert.equal(multiclassPool({ full: 5, half: 5, third: 3 }, R), 44);
  assert.equal(multiclassHighest({ full: 5, half: 5, third: 3 }), 4);
  assert.equal(multiclassPool({ half: 6 }, R), 15, 'one caster type keeps its own table');
  assert.equal(multiclassPool({ none: 10 }, R), 0);
});

test('SpellRules: upcasting adds the surcharge per level raised', () => {
  assert.deepEqual([3, 4, 5].map((l) => upcastCost(3, l, C, R)), [5, 7, 9], 'Fireball 5 / 7 / 9');
  assert.equal(upcastCost(3, 5, C, { upcastSurcharge: 0 }), 7);
  assert.equal(upcastCost(1, 2, C, R, 4), 4 + 1 + 1, 'own cost plus the table step plus the surcharge');
  assert.equal(upcastCost(3, 1, C, R), 5, 'never below the spell level');
});

test('SpellRules: casting limits: echo strain, one per turn, surge, high level, overchannel, low mana', () => {
  const fb = { level: 3 };
  assert.deepEqual([0, 1, 2].map((n) => quoteCast(fb, 3, { ...fresh, echoCount: n }, C, R).cost), [5, 6, 7], 'echo strain');
  assert.equal(quoteCast({ level: 0 }, 0, { ...fresh, echoCount: 5, leveledThisTurn: 1 }, C, R).allowed, true, 'cantrips ignore echo and the per-turn limit');
  const surge = quoteCast(fb, 3, { ...fresh, leveledThisTurn: 1 }, C, R);
  assert.equal(surge.surge, true);
  assert.equal(surge.cost, 10);
  assert.deepEqual(surge.saves, [{ ability: 'con', dc: 13, why: 'Surge cast', onFail: '1 fatigue' }]);
  assert.equal(quoteCast(fb, 3, { ...fresh, leveledThisTurn: 1, surgeUsed: true }, C, R).allowed, false);
  assert.equal(quoteCast(fb, 3, { ...fresh, leveledThisTurn: 1 }, C, { ...R, surge: { ...R.surge, on: false } }).allowed, false);
  const high = quoteCast({ level: 6 }, 6, { ...fresh, highUsed: true }, C, R);
  assert.equal(high.allowed, false);
  assert.match(high.reasons[0], /once per long rest/);
  // 3 mana, Fireball costs 5: 2 short, within -9; CON DC 12.
  const over = quoteCast(fb, 3, { ...fresh, mana: 3 }, C, R);
  assert.equal(over.allowed, true);
  assert.equal(over.manaAfter, -2);
  assert.deepEqual(over.saves.map((s) => s.dc), [12]);
  assert.equal(quoteCast({ level: 9 }, 9, { ...fresh, mana: 0, characterLevel: 9 }, C, R).allowed, false, 'not below minus the character level');
  assert.match(quoteCast(fb, 3, { ...fresh, mana: 3 }, C, { ...R, overchannel: { ...R.overchannel, on: false } }).reasons[0], /Not enough mana/);
  const low = { ...R, lowMana: { on: true, belowPct: 25 } };
  assert.equal(quoteCast(fb, 3, { ...fresh, mana: 16, max: 50 }, C, low).lowMana, true);
  assert.equal(quoteCast(fb, 3, { ...fresh, mana: 50, max: 50 }, C, low).lowMana, false);
  assert.equal(quoteCast(fb, 4, fresh, C, R).breakdown.map((b) => b.mana).reduce((a, b) => a + b), 7, 'the breakdown adds up');
});

test('SpellRules: dual cast empower and fuse, the Arcana DC, the unlock and the fuse insight', () => {
  const fireball = { id: 'fb', level: 3 }, ray = { id: 'ray', level: 2, concentration: true }, web = { id: 'web', level: 2, concentration: true };
  const ctx = { characterLevel: 5, hasAbility: true, usedSinceShortRest: false, penalty: 0 };
  const emp = quoteDual(fireball, fireball, ctx, C, R);
  assert.deepEqual([emp.allowed, emp.cost, emp.effectiveLevel, emp.dc], [true, 10, 5, 16]);
  const fuse = quoteDual(fireball, ray, ctx, C, R);
  assert.deepEqual([fuse.allowed, fuse.cost, fuse.dc], [true, 12, 15], '(5 + 3) × 1.5');
  assert.equal(quoteDual(ray, web, ctx, C, R).allowed, false, 'two concentration spells');
  assert.equal(quoteDual(fireball, ray, { ...ctx, penalty: 2 }, C, R).dc, 17, 'the next roll after a failure');
  assert.match(quoteDual(fireball, ray, { ...ctx, hasAbility: false, characterLevel: 20 }, C, R).reasons[0], /needs the Dual cast ability/, 'an ability by default, not a level');
  const byLevel = { ...R, dualCast: { ...R.dualCast, unlock: 'level' as const } };
  assert.equal(quoteDual(fireball, ray, { ...ctx, hasAbility: false, characterLevel: 4 }, C, byLevel).allowed, false);
  assert.equal(quoteDual(fireball, ray, { ...ctx, hasAbility: false, characterLevel: 5 }, C, byLevel).allowed, true);
  assert.equal(quoteDual(fireball, ray, { ...ctx, usedSinceShortRest: true }, C, R).allowed, false);
  assert.equal(dualCastUnlocked(20, false, R), false);
  assert.equal(dualCastUnlocked(1, true, R), true);
  assert.deepEqual(fuseInsight(['fb', 'ray'], 'fb', 'ray', 0, 13, R), { banked: 1, reveal: true });
  assert.deepEqual(fuseInsight(['fb', 'ray'], 'fb', 'ray', 6, 13, R), { banked: 6, reveal: true }, 'never past half');
  assert.deepEqual(fuseInsight(['fb', 'ray'], 'fb', 'web', 0, 13, R), { banked: 0, reveal: false });
});

test('SpellRules: study points, days and materials match the plan table', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((l) => {
    const c = complexity(l, C), p = studyPoints(c, {}, R);
    return [studyDays(p, 0, dailyProgress('alone', false, R)), studyDays(p, 0, dailyProgress('text', false, R)), studyDays(p, 0, dailyProgress('mentor', false, R)), studyCoin(c, 'alone', R).materials];
  });
  assert.deepEqual(rows, [
    [2, 1, 1, 40], [5, 3, 2, 90], [13, 7, 5, 250], [18, 9, 6, 360], [25, 13, 9, 490],
    [41, 21, 14, 810], [61, 31, 21, 1210], [85, 43, 29, 1690], [113, 57, 38, 2250],
  ]);
  assert.equal(complexity(0, C), 1, 'a cantrip counts as 1');
  assert.equal(studyPoints(5, { hybrid: true }, R), 17, 'ceil(13 × 1.25)');
  assert.equal(studyPoints(5, { extraSpells: 1 }, R), 12, '13 × 0.9');
  assert.equal(studyPoints(5, { extraSpells: 5 }, R), 11, 'the discount stops at 20%');
  assert.equal(extraRecipeSpells(4, 3, R), 2);
  assert.equal(dailyProgress('mentor', true, R), 4, 'a lab adds 1');
  assert.equal(studyDays(13, 10, 2), 2, 'banked progress counts');
  assert.deepEqual(studyCoin(5, 'mentor', R), { materials: 250, mentorFee: 250 });
});

test('SpellRules: the graded final check and the shortcuts', () => {
  // 3rd level: DC 15. 250 coin of materials, 13 points banked.
  assert.deepEqual(['outcome', 'learned', 'refund'].map((k) => (gradeFinalCheck(20, 5, 3, 13, 250, R) as any)[k]), ['great', true, 125]);
  assert.equal(gradeFinalCheck(10, 5, 3, 13, 250, R).outcome, 'success');
  const fail = gradeFinalCheck(8, 5, 3, 13, 250, R);
  assert.deepEqual([fail.outcome, fail.banked, fail.coinLost, fail.fatigue], ['fail', 13, 0, 0]);
  const setback = gradeFinalCheck(1, 30, 3, 13, 250, R);
  assert.deepEqual([setback.outcome, setback.banked, setback.fatigue], ['setback', 10, 1], 'a natural 1 always sets back');
  assert.equal(gradeFinalCheck(3, 2, 3, 13, 250, R).outcome, 'setback', 'failed by 10');
  const coin = { ...R, learning: { ...R.learning, failCoinLoss: 0.1, setbackCoinLoss: 0.5 } };
  assert.equal(gradeFinalCheck(8, 5, 3, 13, 250, coin).coinLost, 25);
  assert.equal(gradeFinalCheck(1, 5, 3, 13, 250, coin).coinLost, 125);
  assert.equal(levelUpInsightBank(13, 0, R), 6);
  assert.equal(levelUpInsightBank(13, 9, R), 9, 'never lowers progress');
  assert.deepEqual(memoryLearn(3, null, 13, 0, R), { learned: true, dc: null, banked: 0, exhaustion: 0 }, 'a full memory teaches at once');
  const saving = { ...R, learning: { ...R.learning, memory: { ...R.learning.memory, save: true } } };
  assert.deepEqual(memoryLearn(3, 16, 13, 0, saving), { learned: true, dc: 16, banked: 0, exhaustion: 0 });
  assert.deepEqual(memoryLearn(3, 15, 13, 0, saving), { learned: false, dc: 16, banked: 3, exhaustion: 1 });
  assert.deepEqual(scroll(3, 13, R), { hours: 3, points: 3 }, 'a scroll only adds study points');
});

test('SpellRules: learning gates list what is missing', () => {
  const base: LearnInput = { spellLevel: 3, castCost: 5, knownRecipeLevels: [2, 2], highest: 3, casterLevel: 5, abilityScore: 14, poolMax: 27, source: 'alone', research: false, arcanaPassed: false };
  assert.deepEqual(learnGates(base, R), []);
  assert.deepEqual(learnGates({ ...base, knownRecipeLevels: [2, 1] }, R), [{ kind: 'gate', need: 2, from: 'below', have: 1 }]);
  assert.deepEqual(learnGates({ ...base, abilityScore: 12 }, R).map((m) => m.kind), ['ability']);
  assert.deepEqual(learnGates({ ...base, highest: 2 }, R).map((m) => m.kind), ['level']);
  assert.deepEqual(learnGates({ ...base, poolMax: 9 }, R).map((m) => m.kind), ['pool']);
  assert.deepEqual(learnGates({ ...base, spellLevel: 4, castCost: 6, knownRecipeLevels: [3, 3], highest: 4 }, R).map((m) => m.kind), ['arcana']);
  assert.deepEqual(learnGates({ ...base, spellLevel: 6, castCost: 9, knownRecipeLevels: [5, 5, 5], highest: 6, abilityScore: 16, poolMax: 60 }, R).map((m) => m.kind), ['source'], '6th: text or mentor');
  assert.deepEqual(learnGates({ ...base, spellLevel: 8, castCost: 13, knownRecipeLevels: [7, 7, 7], highest: 9, abilityScore: 18, poolMax: 100, source: 'text' }, R).map((m) => m.kind), ['research']);
  assert.deepEqual(learnGates({ ...base, spellLevel: 1, castCost: 2, knownRecipeLevels: [0, 0], highest: 1, abilityScore: 12, poolMax: 4 }, R), [], '1st: 2 cantrips');
  assert.deepEqual(learnGates({ ...base, hybridMastery: { fire: 2, air: 1 } }, R), [{ kind: 'mastery', line: 'air', need: 2, have: 1 }]);
});

test('SpellRules: line mastery counts gifts by default, and hybrids', () => {
  const lines: Record<string, string[]> = { bolt: ['fire'], gust: ['air'], blast: ['fire', 'air'] };
  const known = [{ id: 'bolt', how: 'craft' }, { id: 'blast', how: 'gift' }, { id: 'gust', how: 'dm' }];
  assert.deepEqual(lineMastery(known, (id) => lines[id] ?? [], R), { fire: 2, air: 2 });
  assert.deepEqual(lineMastery(known, (id) => lines[id] ?? [], { ...R, lines: { ...R.lines, giftsCountForMastery: false } }), { fire: 1, air: 1 });
  assert.equal(isHybrid(['fire', 'air']), true);
  assert.equal(isHybrid(['fire', 'fire']), false);
});

test('SpellRules: the setting is validated and laid over the defaults', () => {
  checkSpellRules({});
  checkSpellRules({ dualCast: { unlock: 'level' }, learning: { gates: [{}, {}, {}, {}, {}, {}, { sources: ['alone'] }, {}, {}, {}] } });
  assert.throws(() => checkSpellRules([]), /must be an object/);
  assert.throws(() => checkSpellRules({ nope: 1 }), /Unknown spell rule: nope/);
  assert.throws(() => checkSpellRules({ dualCast: { unlock: 'ritual' } }), /dualCast.unlock must be one of ability, level/);
  assert.throws(() => checkSpellRules({ pools: { third: [1, 2] } }), /pools.third must have 20 entries/);
  assert.throws(() => checkSpellRules({ upcastSurcharge: -1 }), /0 to 100000/);
  assert.throws(() => checkSpellRules({ echoStrain: { on: 'yes' } }), /true or false/);
  assert.throws(() => checkSpellRules({ learning: { gates: [{}, {}, {}, {}, {}, {}, {}, {}, {}, { from: 'up' }] } }), /from must be one of cantrip, below, any/);
  assert.throws(() => checkSpellRules({ learning: { gates: [{ sources: ['dream'] }, {}, {}, {}, {}, {}, {}, {}, {}, {}] } }), /sources must list some of/);
  const r = resolveRules({ dualCast: { unlock: 'level' }, pools: { third: Array(20).fill(1) }, learning: { gates: [{}, {}, {}, {}, {}, {}, { sources: ['alone'] }, {}, {}, {}] } });
  assert.equal(r.dualCast.unlock, 'level');
  assert.equal(r.dualCast.level, 5, 'the rest keeps its default');
  assert.equal(r.pools.third[0], 1);
  assert.deepEqual(r.pools.full, R.pools.full);
  assert.deepEqual(r.learning.gates[6].sources, ['alone']);
  assert.equal(r.learning.gates[6].known, 3);
  assert.deepEqual(resolveRules(undefined), R);
  assert.notEqual(resolveRules(undefined).pools, R.pools, 'a copy, never the defaults themselves');
  const p = preview(C, R);
  assert.equal(p.study[6].days.alone, null, 'a source the gate forbids shows no days');
  assert.equal(p.study[8].researchOnly, true);
  assert.equal(p.highest.half[16], 5);
});

// ---- the route ---------------------------------------------------------------------------------------------

let base = '';
let server: any;
let tmp = '';
let hub: any;
const T: Record<string, string> = {};
let W = '';
let W2 = '';
const ID: Record<string, string> = {};
const SP = (w = W) => `/api/worlds/${w}/spells`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-spellrules-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  hub = made.deps.hub;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await call('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).body.token;
  const dm = (await call('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).body.account.id;
  T.dm = (await call('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).body.token;
  W = (await call('POST', '/api/admin/worlds', T.admin, { name: 'Runeholm', dmAccountId: dm })).body.id;
  W2 = (await call('POST', '/api/admin/worlds', T.admin, { name: 'Ashmark', dmAccountId: dm })).body.id;
  const inv = (await call('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' })).body;
  const j = (await call('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).body;
  T.jess = j.token;
  ID.jess = j.account.id;
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('SpellRules: the DM sets spellRules; everyone reads the merged rules and the preview', async () => {
  let r = await call('GET', `/api/worlds/${W}/spells/rules`, T.jess);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rules, R);
  assert.deepEqual(r.body.preview.costs, PLAN_COSTS);
  assert.equal(r.body.preview.study[3].days.alone, 13);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellRules: { dualCast: { unlock: 'never' } } })).status, 400);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.jess, { spellRules: { upcastSurcharge: 0 } })).status, 403);
  assert.equal((await call('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellRules: { upcastSurcharge: 0, lines: { giftsCountForMastery: false } } })).status, 200);
  r = await call('GET', `/api/worlds/${W}/spells/rules`, T.jess);
  assert.equal(r.body.rules.upcastSurcharge, 0);
  assert.equal(r.body.rules.lines.giftsCountForMastery, false);
  assert.equal(r.body.rules.lines.hybridMastery, 2);
});

test('SpellRules: the DM makes spell lines and tags spells; players see only spells they may read', async () => {
  const fire = await call('POST', `${SP()}/lines`, T.dm, { name: 'Fire', color: '#e25822', theme: 'Heat and flame', spells: ['Fire Bolt', 'srd:burning-hands'] });
  assert.equal(fire.status, 201, JSON.stringify(fire.body));
  assert.deepEqual(fire.body.spells.sort(), ['srd:burning-hands', 'srd:fire-bolt']);
  assert.equal((await call('POST', `${SP()}/lines`, T.dm, { name: 'fire' })).status, 409, 'names are unique, case aside');
  assert.equal((await call('POST', `${SP()}/lines`, T.dm, { name: 'Air', color: 'blue' })).status, 400);
  assert.match((await call('POST', `${SP()}/lines`, T.dm, { name: 'Air', spells: ['No Such Spell'] })).body.error, /Unknown spell: No Such Spell/);
  assert.equal((await call('POST', `${SP()}/lines`, T.jess, { name: 'Air' })).status, 403);
  const air = (await call('POST', `${SP()}/lines`, T.dm, { name: 'Air', color: '#8ecae6' })).body;
  // A hybrid: Burning Hands in Fire and Air.
  const tag = await call('PUT', `${SP()}/s/srd:burning-hands/lines`, T.dm, { lines: ['Fire', air.id] });
  assert.equal(tag.status, 200, JSON.stringify(tag.body));
  assert.equal((await call('PUT', `${SP()}/s/srd:burning-hands/lines`, T.dm, { lines: ['Frost'] })).status, 400);
  let list = (await call('GET', `${SP()}/lines`, T.dm)).body.lines;
  assert.deepEqual(list.map((l: any) => [l.name, l.spells.length]), [['Air', 1], ['Fire', 2]]);
  // The player knows neither spell and the SRD is not public: the lines show, their spells do not.
  list = (await call('GET', `${SP()}/lines`, T.jess)).body.lines;
  assert.deepEqual(list.map((l: any) => [l.name, l.spells.length]), [['Air', 0], ['Fire', 0]]);
  const ren = await call('PUT', `${SP()}/lines/${air.id}`, T.dm, { name: 'Wind' });
  assert.equal(ren.body.name, 'Wind');
  assert.equal(ren.body.color, '#8ecae6', 'what is not sent is kept');
  assert.equal((await call('PUT', `${SP()}/lines/${air.id}`, T.dm, { name: 'Fire' })).status, 409);
  assert.equal((await call('DELETE', `${SP()}/lines/${air.id}`, T.dm)).status, 200);
  assert.equal((await call('DELETE', `${SP()}/lines/${air.id}`, T.dm)).status, 404);
});

test('SpellRules: a profile exports by name and imports into another world with a preview', async () => {
  await call('POST', `${SP()}/recipes`, T.dm, { result: 'Scorching Ray', prereqs: ['Fire Bolt', 'Burning Hands'] });
  const prof = await call('GET', `${SP()}/profile/export`, T.dm);
  assert.equal(prof.status, 200);
  assert.equal((await call('GET', `${SP()}/profile/export`, T.jess)).status, 403);
  const p = prof.body;
  assert.equal(p.format, 'alexandria-spell-rules');
  assert.deepEqual(p.settings.spellRules, { upcastSurcharge: 0, lines: { giftsCountForMastery: false } }, 'only what the world changed');
  assert.deepEqual(p.settings.spellManaCosts, PLAN_COSTS);
  assert.deepEqual(p.lines, [{ name: 'Fire', color: '#e25822', theme: 'Heat and flame', spells: ['Burning Hands', 'Fire Bolt'] }]);
  assert.deepEqual(p.recipes.map((x: any) => [x.result, x.prereqs]), [['Scorching Ray', ['Fire Bolt', 'Burning Hands']]]);
  // Into the other world: a spell it lacks is named, nothing changes on a preview.
  const withMissing = { ...p, lines: [...p.lines, { name: 'Shadow', spells: ['Umbral Lance'] }] };
  const pre = await call('POST', `${SP(W2)}/profile/import/preview`, T.dm, { profile: withMissing });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.deepEqual(pre.body.settings, ['spellRules']);
  assert.deepEqual(pre.body.lines, { added: ['Fire', 'Shadow'], updated: [] });
  assert.deepEqual(pre.body.missingSpells, ['Shadow: Umbral Lance']);
  assert.equal(pre.body.recipes.added, 1);
  assert.deepEqual((await call('GET', `${SP(W2)}/lines`, T.dm)).body.lines, [], 'a preview writes nothing');
  assert.equal((await call('GET', `${SP(W2)}/rules`, T.dm)).body.rules.upcastSurcharge, 1);
  const done = await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: JSON.stringify(withMissing) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await call('GET', `${SP(W2)}/rules`, T.dm)).body.rules.upcastSurcharge, 0);
  assert.deepEqual((await call('GET', `${SP(W2)}/lines`, T.dm)).body.lines.map((l: any) => [l.name, l.spells.length]), [['Fire', 2], ['Shadow', 0]]);
  assert.equal((await call('GET', `${SP(W2)}/recipes`, T.dm)).body.recipes.length, 1);
  // Again: lines update in place, the recipe is already there.
  const again = (await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: p })).body;
  assert.deepEqual([again.lines.updated, again.recipes.added, again.settings], [['Fire'], 0, []]);
  // Replace clears the lines and recipes first.
  const rep = (await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: { ...p, lines: [], recipes: [] }, replace: true })).body;
  assert.deepEqual([rep.lines.added, rep.recipes.added], [[], 0]);
  assert.deepEqual((await call('GET', `${SP(W2)}/lines`, T.dm)).body.lines, []);
  assert.equal((await call('GET', `${SP(W2)}/recipes`, T.dm)).body.recipes.length, 0);
  // Refused whole: a bad setting, a key a profile does not carry, another format.
  assert.equal((await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: { settings: { spellRules: { dualCast: { unlock: 'never' } } } } })).status, 400);
  assert.match((await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: { settings: { agentAuto: true } } })).body.error, /carries only/);
  assert.equal((await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: { format: 'alexandria-spell-recipes' } })).status, 400);
  assert.equal((await call('POST', `${SP(W2)}/profile/import`, T.dm, { profile: { lines: [{ name: 'Bad', color: 'red' }] } })).status, 400);
  assert.equal((await call('GET', `${SP(W2)}/lines`, T.dm)).body.lines.length, 0, 'a refused import changes nothing');
  assert.equal((await call('POST', `${SP()}/profile/import`, T.jess, { profile: p })).status, 403);
});

test('SpellRules: in play: caster levels set the pool, casts follow the limits, dual cast needs the ability, rests reset', async () => {
  const ok = async (m: string, u: string, t: string, b?: unknown) => { const r = await call(m, u, t, b); assert.ok(r.status < 300, `${m} ${u} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  // Off until the DM turns the engine on.
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellMana: true, spellRules: {} });
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: 'srd:fireball' });
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: 'srd:scorching-ray' });
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: 'srd:fire-bolt' });
  assert.equal((await call('POST', `${SP()}/cast/quote`, T.jess, { spellId: 'srd:fireball' })).status, 409, 'the engine is off');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellRulesOn: true });
  assert.equal((await call('PUT', `${SP()}/characters/me/caster`, T.jess, { casterLevels: { full: 25 } })).status, 400);
  assert.equal((await call('PUT', `${SP()}/characters/me/caster`, T.jess, { dualAbility: true })).status, 403, 'only the DM grants the ability');
  // Wizard 5: pool 27, 3rd-level spells.
  let me = await ok('PUT', `${SP()}/characters/me/caster`, T.jess, { casterLevels: { full: 5 } });
  assert.deepEqual([me.mana.max, me.mana.now, me.mana.maxCastLevel], [27, 27, 3]);
  assert.equal((await call('POST', `${SP()}/cast/quote`, T.jess, { spellId: 'srd:fireball', level: 4 })).status, 409, 'above the highest level');
  const q = await ok('POST', `${SP()}/cast/quote`, T.jess, { spellId: 'srd:fireball' });
  assert.deepEqual([q.allowed, q.cost], [true, 5]);
  let c = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fireball' });
  assert.deepEqual([c.cost, c.mana], [5, 22]);
  // Same turn: a surge cast, ×2 with echo strain (5 + 1) and a CON save.
  c = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fireball' });
  assert.deepEqual([c.cost, c.mana, c.surge, c.saves[0].dc], [12, 10, true, 13]);
  assert.match((await call('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:scorching-ray' })).body.error, /Surge cast is used up/);
  assert.equal((await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fire-bolt' })).cost, 0, 'cantrips are free of the turn limit');
  // A new turn: echo strain makes the third Fireball 7.
  await ok('POST', `${SP()}/characters/me/turn`, T.jess);
  assert.equal((await ok('POST', `${SP()}/cast/quote`, T.jess, { spellId: 'srd:fireball' })).cost, 7);
  // Dual cast needs the ability, then counts as the turn's leveled spell.
  assert.match((await ok('POST', `${SP()}/dual/quote`, T.jess, { spellA: 'srd:scorching-ray' })).reasons[0], /Dual cast ability/);
  await ok('PUT', `${SP()}/characters/${ID.jess}/caster`, T.dm, { dualAbility: true });
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'long-rest' });
  me = await ok('GET', `${SP()}/characters/me`, T.jess);
  assert.deepEqual([me.mana.now, me.mana.casting.echo, me.mana.casting.surgeUsed, me.mana.casting.dualAbility], [27, {}, false, true], 'a long rest refills and resets');
  const dq = await ok('POST', `${SP()}/dual/quote`, T.jess, { spellA: 'srd:scorching-ray', spellB: 'srd:fireball' });
  assert.deepEqual([dq.kind, dq.allowed, dq.cost, dq.dc], ['fuse', true, 12, 15]);
  assert.equal((await call('POST', `${SP()}/dual`, T.jess, { spellA: 'srd:scorching-ray', spellB: 'srd:fireball' })).status, 400, 'the Arcana total is needed');
  const fail = await ok('POST', `${SP()}/dual`, T.jess, { spellA: 'srd:scorching-ray', spellB: 'srd:fireball', arcana: 9 });
  assert.deepEqual([fail.success, fail.mana], [false, 15], 'the mana is spent on a failure');
  me = await ok('GET', `${SP()}/characters/me`, T.jess);
  assert.deepEqual([me.mana.casting.dualUsed, me.mana.casting.dualPenalty, me.mana.casting.turnLeveled], [true, 2, 1]);
  assert.match((await call('POST', `${SP()}/dual`, T.jess, { spellA: 'srd:fireball', arcana: 30 })).body.error, /used up until a short rest/);
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'short-rest' });
  const emp = await ok('POST', `${SP()}/dual/quote`, T.jess, { spellA: 'srd:fireball' });
  assert.deepEqual([emp.kind, emp.cost, emp.effectiveLevel, emp.dc], ['empower', 10, 5, 16], 'a short rest clears the use and the penalty');
  assert.equal((await call('POST', `${SP()}/dual/quote`, T.jess, { spellA: 'srd:fire-bolt' })).status, 400, 'not for cantrips');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellRulesOn: false, spellMana: false });
});

test('SpellRules: studying a spell: the plan, days, DM approval, the final check, a long rest retry, the scroll', async () => {
  const ok = async (m: string, u: string, t: string, b?: unknown) => { const r = await call(m, u, t, b); assert.ok(r.status < 300, `${m} ${u} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  assert.deepEqual((await ok('GET', `${SP()}/study`, T.jess)).studies, [], 'off: no studies');
  assert.equal((await call('POST', `${SP()}/study/plan`, T.jess, { spellId: 'srd:lightning-bolt' })).status, 409, 'the engine is off');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellMana: true, spellRulesOn: true, spellCrafting: true, spellCraftApproval: 'dm' });
  await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { level: 5, castingAbility: 'int', abilities: { int: 16 } });
  await ok('PUT', `${SP()}/characters/me/caster`, T.jess, { casterLevels: { full: 5 } });
  await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Lightning Bolt', prereqs: ['Misty Step', 'Scorching Ray'] });
  // The plan: what is missing, and the plan's table for a 3rd-level spell.
  let plan = await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: 'srd:lightning-bolt', source: 'text' });
  assert.deepEqual(plan.missing, ['know Misty Step', "know 2 of its recipe's spells that are one level lower (knows 1)"]);
  assert.deepEqual([plan.needed, plan.perDay, plan.days, plan.materials, plan.mentorFee, plan.finalDC, plan.checkBonus, plan.scrollPoints], [13, 2, { alone: 13, text: 7, mentor: 5 }, 250, 0, 15, 6, 3]);
  assert.equal((await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: 'srd:lightning-bolt', source: 'mentor' })).mentorFee, 250, 'a mentor doubles the gold: 500 in all');
  assert.deepEqual(plan.gold, { alone: 250, text: 250, mentor: 500 }, 'the plan table');
  assert.match((await call('POST', `${SP()}/study`, T.jess, { spellId: 'srd:lightning-bolt', source: 'text' })).body.error, /Not yet: know Misty Step/);
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: 'srd:misty-step' });
  plan = await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: 'srd:lightning-bolt', source: 'text' });
  assert.equal(plan.canStart, true, JSON.stringify(plan.missing));
  // Start with a text: 7 days left.
  const st = await call('POST', `${SP()}/study`, T.jess, { spellId: 'srd:lightning-bolt', source: 'text' });
  assert.equal(st.status, 201, JSON.stringify(st.body));
  const sid = st.body.id;
  assert.deepEqual([st.body.status, st.body.banked, st.body.needed, st.body.daysLeft, st.body.materials], ['studying', 0, 13, 7, 250]);
  assert.equal((await call('POST', `${SP()}/study/${sid}/check`, T.jess, { d20: 20 })).status, 409, 'not complete yet');
  // A player's days wait for the DM.
  let x = await ok('POST', `${SP()}/study/${sid}/days`, T.jess, { days: 3 });
  assert.deepEqual([x.banked, x.pendingDays], [0, 3]);
  assert.equal((await call('POST', `${SP()}/study/${sid}/approve`, T.jess)).status, 403);
  x = await ok('POST', `${SP()}/study/${sid}/approve`, T.dm);
  assert.deepEqual([x.banked, x.pendingDays, x.days, x.daysLeft], [6, 0, 3, 4]);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellCraftApproval: 'auto' });
  x = await ok('POST', `${SP()}/study/${sid}/days`, T.jess, { days: 5 });
  assert.deepEqual([x.banked, x.status, x.daysLeft], [13, 'ready', 0], 'points stop at what is needed');
  assert.equal((await call('POST', `${SP()}/study/${sid}/days`, T.jess, { days: 1 })).status, 409);
  // The tree shows it as studied, by school.
  let tree = await ok('GET', `${SP()}/tree`, T.jess);
  const evo = tree.schools.find((s: any) => s.name === 'Evocation');
  const lb = evo.spells.find((s: any) => s.id === 'srd:lightning-bolt');
  assert.deepEqual([lb.status, lb.study.banked, lb.study.needed], ['studying', 13, 13]);
  // A failed check (2 + 6 vs 15) waits for a long rest; the points stay.
  let chk = await ok('POST', `${SP()}/study/${sid}/check`, T.jess, { d20: 2 });
  assert.deepEqual([chk.outcome, chk.learned, chk.total, chk.study.banked, chk.study.waitLongRest], ['fail', false, 8, 13, true]);
  assert.match((await call('POST', `${SP()}/study/${sid}/check`, T.jess, { d20: 20 })).body.error, /after a long rest/);
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'long-rest' });
  chk = await ok('POST', `${SP()}/study/${sid}/check`, T.jess, { d20: 12 });
  assert.deepEqual([chk.outcome, chk.learned, chk.study.status, chk.study.attempts], ['success', true, 'learned', 2]);
  assert.ok((await ok('GET', `${SP()}/characters/me`, T.jess)).known.some((k: any) => (k.spellId ?? k.id) === 'srd:lightning-bolt'));
  // A scroll adds a quarter of the points and is kept; casting it first loses that help.
  await ok('POST', `${SP()}/recipes`, T.dm, { result: 'Hypnotic Pattern', prereqs: ['Misty Step', 'Scorching Ray'] });
  const s2 = await ok('POST', `${SP()}/study`, T.jess, { spellId: 'srd:hypnotic-pattern', scroll: true });
  assert.deepEqual([s2.source, s2.banked, s2.scrollHelp, s2.daysLeft], ['alone', 3, true, 10]);
  x = await ok('POST', `${SP()}/study/${s2.id}/scroll-cast`, T.jess);
  assert.deepEqual([x.banked, x.scrollHelp], [0, false]);
  assert.equal((await call('POST', `${SP()}/study/${s2.id}/scroll-cast`, T.jess)).status, 409);
  // Stop keeps the points; starting again picks the same study up.
  await ok('POST', `${SP()}/study/${s2.id}/days`, T.jess, { days: 2 });
  x = await ok('POST', `${SP()}/study/${s2.id}/stop`, T.jess);
  assert.deepEqual([x.status, x.banked], ['stopped', 2]);
  const again = await call('POST', `${SP()}/study`, T.jess, { spellId: 'srd:hypnotic-pattern', source: 'mentor' });
  assert.deepEqual([again.status, again.body.id, again.body.status, again.body.banked, again.body.daysLeft], [200, s2.id, 'studying', 2, 4]);
  // The DM sees every study and can set the points by hand.
  assert.equal((await ok('GET', `${SP()}/study`, T.dm)).studies.length, 2);
  assert.equal((await call('PUT', `${SP()}/study/${s2.id}`, T.jess, { banked: 13 })).status, 403);
  assert.equal((await ok('PUT', `${SP()}/study/${s2.id}`, T.dm, { banked: 13 })).status, 'ready');
  tree = await ok('GET', `${SP()}/tree`, T.jess);
  const all = [...tree.schools.flatMap((s: any) => s.spells), ...tree.hybrids];
  assert.ok(all.length > 300, `every SRD spell is on the tree (${all.length})`);
  assert.equal(all.find((s: any) => s.id === 'srd:lightning-bolt').status, 'known');
  assert.equal(all.find((s: any) => s.id === 'srd:wish').status, 'dark', 'no recipe: darkened');
  assert.equal(tree.counts.studying, 1);
  // The assistant's compact view: a flat list, filtered.
  const flat = await ok('GET', `${SP()}/tree?compact=1&status=known,studying&limit=5`, T.jess);
  assert.ok(flat.spells.length > 0 && flat.spells.length <= 5 && flat.spells.every((s: any) => ['known', 'studying'].includes(s.status)));
  assert.equal(flat.counts.studying, 1);
  assert.ok(!('schools' in flat));
  const named = await ok('GET', `${SP()}/tree?compact=1&q=hypnotic`, T.jess);
  assert.deepEqual(named.spells.map((s: any) => [s.name, s.status]), [['Hypnotic Pattern', 'studying']]);
  // Any class may study any spell; one on their own class list needs 25% fewer points (learning.classDiscount).
  const cls0 = (await ok('GET', `${SP()}/characters/me`, T.jess)).class ?? '';
  await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { class: 'Cleric' });
  const names = (await ok('GET', `${SP()}/tree?compact=1&status=learn&limit=500`, T.jess)).spells.map((s: any) => s.name);
  assert.ok(names.includes('Eldritch Blast') && names.includes('Sacred Flame'), 'other classes\' cantrips are open too');
  const off = await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: 'srd:misty-step', source: 'text' });
  assert.deepEqual([off.ownClass, off.needed, off.days, off.missing.filter((m: string) => /class/.test(m))], [false, 5, { alone: 5, text: 3, mentor: 2 }, []], 'no penalty off the list');
  await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { class: 'Paladin 4 / Wizard 6' });
  const on = await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: 'srd:misty-step', source: 'text' });
  assert.deepEqual([on.ownClass, on.classDiscount, on.needed], [true, 0.25, 4], 'a multiclass has both lists');
  await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { class: cls0 });
  // Bubbles: a school's spells sit in bubbles of about four; one known spell in a bubble opens the next.
  const tb = await ok('GET', `${SP()}/tree`, T.jess);
  const flatT = [...tb.schools.flatMap((g: any) => g.spells), ...tb.hybrids];
  const knownT = new Set(flatT.filter((x: any) => x.status === 'known' || x.status === 'gift').map((x: any) => x.id));
  const byB = new Map(tb.bubbles.map((b: any) => [b.id, b]));
  assert.ok(tb.bubbles.length > 100 && tb.bubbles.every((b: any) => b.spells.length >= 1 && b.spells.length <= 5), `${tb.bubbles.length} bubbles`);
  const shut = tb.bubbles.find((b: any) => b.level === 1 && b.parent && !(byB.get(b.parent) as any).spells.some((id: string) => knownT.has(id)) && !b.spells.some((id: string) => knownT.has(id)));
  const par: any = byB.get(shut.parent);
  let bp = await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: shut.spells[0] });
  assert.ok(bp.missing.includes(`learn a spell in the ${par.name}`), bp.missing.join('; '));
  assert.deepEqual([bp.bubble.open, bp.bubble.parent], [false, par.name]);
  await ok('POST', `${SP()}/characters/${ID.jess}/known`, T.dm, { spellId: par.spells[0] });
  bp = await ok('POST', `${SP()}/study/plan`, T.jess, { spellId: shut.spells[0] });
  assert.ok(bp.bubble.open && !bp.missing.some((m: string) => m.startsWith('learn a spell in')), bp.missing.join('; '));
  await ok('DELETE', `${SP()}/characters/${ID.jess}/known/${encodeURIComponent(par.spells[0])}`, T.dm);
  // A DownTime task linked to the study: each 8 hours worked is a study day, the rest carries over.
  const eb = await ok('POST', `${SP()}/study`, T.jess, { spellId: 'srd:eldritch-blast', source: 'alone' });
  hub.emit(W, 'downtime-day', { accountId: ID.jess, minutes: 200, link: { kind: 'spell-study', ref: eb.id } }, () => false);
  let ebs = (await ok('GET', `${SP()}/study`, T.jess)).studies.find((x: any) => x.id === eb.id);
  assert.deepEqual([ebs.banked, ebs.carryMin, ebs.status], [0, 200, 'studying']);
  hub.emit(W, 'downtime-day', { accountId: ID.jess, minutes: 300, link: { kind: 'spell-study' } }, () => false);
  ebs = (await ok('GET', `${SP()}/study`, T.jess)).studies.find((x: any) => x.id === eb.id);
  assert.deepEqual([ebs.banked, ebs.days, ebs.carryMin, ebs.status], [1, 1, 20, 'ready']);
  await ok('POST', `${SP()}/study/${eb.id}/stop`, T.jess);
  await ok('PUT', `${SP()}/characters/${ID.jess}`, T.dm, { class: cls0 });
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellRulesOn: false, spellMana: false, spellCraftApproval: 'dm' });
});

test('SpellRules: silent casting is an ability the DM grants, at no extra mana', async () => {
  const ok = async (m: string, u: string, t: string, b?: unknown) => { const r = await call(m, u, t, b); assert.ok(r.status < 300, `${m} ${u} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellMana: true, spellRulesOn: true });
  await ok('POST', `/api/worlds/${W}/clock/advance`, T.dm, { preset: 'long-rest' });
  assert.match((await call('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fireball', silent: true })).body.error, /Silent casting is an ability/);
  assert.equal((await call('PUT', `${SP()}/characters/me/caster`, T.jess, { silentAbility: true })).status, 403);
  await ok('PUT', `${SP()}/characters/${ID.jess}/caster`, T.dm, { silentAbility: true });
  const quiet = await ok('POST', `${SP()}/cast`, T.jess, { spellId: 'srd:fireball', silent: true });
  assert.deepEqual([quiet.silent, quiet.cost], [true, 5], 'the same cost as a normal cast');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { spellRulesOn: false, spellMana: false });
});
