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
const T: Record<string, string> = {};
let W = '';

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-spellrules-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await call('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).body.token;
  const dm = (await call('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).body.account.id;
  T.dm = (await call('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).body.token;
  W = (await call('POST', '/api/admin/worlds', T.admin, { name: 'Runeholm', dmAccountId: dm })).body.id;
  const inv = (await call('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' })).body;
  T.jess = (await call('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' })).body.token;
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
