// Combat bookkeeping: temp HP, concentration, death saves, timed conditions and
// monster initiative with Dexterity. The rule functions on their own, then the
// live routes, the agent tools, Active mode (cues and undo) and the player view.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';
import { applyDamage, applyHeal, concentrationDc, gainTempHp, rollDeathSave, tickEffects, type Fighter } from '../src/core/combatRules.ts';
import { dexModifier, findMonster } from '../src/features/modules/search.ts';
import { allCues } from '../src/features/active/cues.ts';
import { build } from '../src/features/active/intents.ts';
import { execCalls, setPort } from '../src/features/active/exec.ts';
import { harnessTools } from '../src/features/agent/harness.ts';
import { all } from '../src/core/db.ts';

let k: Kit;
before(async () => {
  k = await boot();
  setPort(k.deps, Number(new URL(k.base).port));
});
after(() => k?.close());

const C = (p = '') => k.w(`/live/combatants${p}`);
const add = async (b: Record<string, unknown>) => (await k.ok('POST', C(), k.T.gm, b)).id as string;
const patch = async (id: string, b: Record<string, unknown>) => k.ok('PATCH', C(`/${id}`), k.T.gm, b);
const view = async (id: string) => (await k.ok('GET', k.w('/live/combat'), k.T.gm)).combatants.find((x: any) => x.id === id);
const fighter = (o: Partial<Fighter> = {}): Fighter => ({ hp: 20, maxHp: 20, tempHp: 0, isPc: false, concentration: null, deathSaves: null, ...o });

test('Combat_TempHp: damage eats temporary HP first and only the rest reaches HP', () => {
  const r = applyDamage(fighter({ tempHp: 5 }), 8);
  assert.equal(r.tempHp, 0);
  assert.equal(r.hp, 17);
  assert.equal(r.absorbed, 5);
  const small = applyDamage(fighter({ tempHp: 10 }), 4);
  assert.deepEqual([small.tempHp, small.hp], [6, 20], 'a small hit leaves HP alone');
});

test('Combat_TempHp: temporary HP never stack, the higher value wins, and healing does not touch them', () => {
  assert.equal(gainTempHp(5, 8), 8);
  assert.equal(gainTempHp(8, 5), 8);
  assert.equal(gainTempHp(0, 0), 0);
  const h = applyHeal(fighter({ hp: 10, tempHp: 4 }), 3);
  assert.equal(h.hp, 13);
});

test('Combat_TempHp: through the route, with the result saying what was absorbed', async () => {
  const id = await add({ name: 'Temp bandit', initiative: 5, hp: 20, maxHp: 20 });
  assert.equal((await patch(id, { tempHp: 6 })).tempHp, 6);
  const kept = await patch(id, { tempHp: 4 });
  assert.equal(kept.tempHp, 6, 'a lower grant does not replace or add');
  assert.equal((await patch(id, { tempHp: 9 })).tempHp, 9);
  const hit = await patch(id, { damage: 12 });
  assert.deepEqual([hit.hp, hit.tempHp, hit.absorbed], [17, 0, 9]);
  const x = await view(id);
  assert.equal(x.temp_hp, 0);
  assert.equal((await patch(id, { setTempHp: 3 })).tempHp, 3, 'setTempHp is the exact correction');
});

test('Combat_Concentration: the save DC is half the damage, never under 10', () => {
  assert.equal(concentrationDc(1), 10);
  assert.equal(concentrationDc(20), 10);
  assert.equal(concentrationDc(21), 10);
  assert.equal(concentrationDc(22), 11);
  assert.equal(concentrationDc(45), 22);
});

test('Combat_Concentration: damage records a Constitution save, even when temp HP absorb it', () => {
  const f = fighter({ tempHp: 30, concentration: { spell: 'Bless', dc: null } });
  const r = applyDamage(f, 24);
  assert.deepEqual(r.concentrationSave, { spell: 'Bless', dc: 12 });
  assert.equal(r.hp, 20, 'temp HP took it all');
  assert.equal(applyDamage(fighter(), 30).concentrationSave, null, 'not concentrating: no save');
  // A second hit keeps the hardest save still owed.
  const again = applyDamage({ ...r }, 4);
  assert.equal(again.concentration?.dc, 12);
});

test('Combat_Concentration: marked, damaged, saved or lost through the route', async () => {
  const id = await add({ name: 'Mage Ilsa', initiative: 9, hp: 30, maxHp: 30 });
  assert.deepEqual((await patch(id, { concentration: 'Hold Person' })).concentration, { spell: 'Hold Person', dc: null });
  const hit = await patch(id, { damage: 26 });
  assert.deepEqual(hit.concentrationSave, { ability: 'Constitution', spell: 'Hold Person', dc: 13 });
  assert.match(hit.notes.join(' '), /Constitution save DC 13 .* Hold Person/);
  assert.equal((await view(id)).concentration.dc, 13, 'the tracker shows the pending save');
  const kept = await patch(id, { concentrationSave: { roll: 15 } });
  assert.deepEqual(kept.concentration, { spell: 'Hold Person', dc: null }, 'a pass keeps the spell and settles the save');
  assert.equal((await call(id, { concentrationSave: { result: 'fail' } })).status, 400, 'nothing is owed now');
  await patch(id, { damage: 2 });
  const lost = await patch(id, { concentrationSave: { result: 'fail' } });
  assert.equal(lost.concentration, null);
  assert.equal(lost.concentrationEnded, 'Hold Person');
  await patch(id, { concentration: 'Bless' });
  assert.equal((await patch(id, { concentration: null })).concentration, null, 'loses concentration clears it');
  await patch(id, { concentration: 'Haste' });
  const down = await patch(id, { damage: 99 });
  assert.equal(down.concentration, null, 'falling unconscious ends it');
});
const call = (id: string, b: Record<string, unknown>) => k.call('PATCH', C(`/${id}`), k.T.gm, b);

test('Combat_DeathSaves: a natural 20 stands them up, a natural 1 is two failures', () => {
  assert.deepEqual([rollDeathSave(null, { roll: 20 }).hp, rollDeathSave(null, { roll: 20 }).deathSaves], [1, null]);
  assert.equal(rollDeathSave(null, { roll: 1 }).deathSaves?.failures, 2);
  assert.equal(rollDeathSave(null, { roll: 9 }).deathSaves?.failures, 1);
  assert.equal(rollDeathSave(null, { roll: 10 }).deathSaves?.successes, 1);
});

test('Combat_DeathSaves: stable at three successes, dead at three failures', () => {
  let ds = rollDeathSave(null, { result: 'success' }).deathSaves;
  ds = rollDeathSave(ds, { result: 'success' }).deathSaves;
  assert.equal(ds?.stable, false);
  const done = rollDeathSave(ds, { roll: 14 });
  assert.equal(done.deathSaves?.stable, true);
  assert.match(done.text, /stable/);
  let f = rollDeathSave(null, { result: 'failure' }).deathSaves;
  f = rollDeathSave(f, { roll: 1 }).deathSaves;
  assert.equal(f?.dead, true, 'one failure then a natural 1 is three');
});

test('Combat_DeathSaves: damage at 0 HP adds a failure, a crit adds two, healing resets', () => {
  const down = fighter({ hp: 0, isPc: true, deathSaves: { successes: 1, failures: 0, stable: false, dead: false } });
  const one = applyDamage(down, 3);
  assert.equal(one.deathSaves?.failures, 1);
  const crit = applyDamage(one, 3, true);
  assert.equal(crit.deathSaves?.dead, true, '1 + 2 failures is dead');
  const stable = applyDamage(fighter({ hp: 0, isPc: true, deathSaves: { successes: 3, failures: 0, stable: true, dead: false } }), 2);
  assert.deepEqual([stable.deathSaves?.stable, stable.deathSaves?.failures], [false, 1], 'a stable PC who is hit is dying again');
  const healed = applyHeal(down, 4);
  assert.deepEqual([healed.hp, healed.deathSaves], [4, null]);
  // Dropping to 0 starts the count; temp HP soaking the blow causes no failure.
  assert.equal(applyDamage(fighter({ isPc: true, hp: 5 }), 9).hp, 0);
  assert.equal(applyDamage(fighter({ hp: 0, isPc: true, tempHp: 6 }), 4).deathSaves, null);
  assert.equal(applyDamage(fighter({ isPc: true, hp: 5, maxHp: 20 }), 30).died, true, 'the overflow equals max HP: killed outright');
});

test('Combat_DeathSaves: only a PC at 0 HP rolls them, through the route', async () => {
  const pc = await add({ name: 'Tomas', initiative: 14, hp: 12, maxHp: 12, accountId: k.ID.tom });
  const goblin = await add({ name: 'Plain Goblin', initiative: 3, hp: 7, maxHp: 7 });
  assert.equal((await call(pc, { deathSave: { roll: 12 } })).status, 400, 'standing up: no death save');
  assert.equal((await call(goblin, { deathSave: { roll: 12 } })).status, 400, 'monsters do not roll them');
  const drop = await patch(pc, { damage: 15 });
  assert.equal(drop.hp, 0, 'a PC never goes below 0');
  assert.equal(drop.droppedToZero, true);
  assert.deepEqual(drop.deathSaves, { successes: 0, failures: 0, stable: false, dead: false });
  const fail = await patch(pc, { damage: 2 });
  assert.equal(fail.deathSaves.failures, 1);
  const crit = await patch(pc, { damage: 2, crit: true });
  assert.equal(crit.deathSaves.dead, true);
  assert.ok((await view(pc)).effects.some((e: any) => e.name === 'Dead'), 'a Dead tag follows');
  const up = await patch(pc, { heal: 5 });
  assert.equal(up.deathSaves, null);
  assert.ok(!(await view(pc)).effects.some((e: any) => e.name === 'Dead'));
  await patch(pc, { hp: 0 });
  await patch(pc, { deathSave: { roll: 15 } });
  await patch(pc, { deathSave: { result: 'success' } });
  const st = await patch(pc, { deathSave: { roll: 11 } });
  assert.equal(st.deathSaves.stable, true);
  assert.ok((await view(pc)).effects.some((e: any) => e.name === 'Stable'));
  assert.equal((await call(pc, { deathSave: { roll: 11 } })).status, 400, 'a stable PC rolls no more');
  const nat = await patch(pc, { damage: 1 });
  assert.equal(nat.deathSaves.stable, false);
  const back = await patch(pc, { deathSave: { roll: 20 } });
  assert.equal(back.hp, 1);
  assert.equal(back.deathSaves, null);
});

test('Combat_Conditions: rounds count down on a new round and expired ones are removed and logged', async () => {
  for (const x of (await k.ok('GET', k.w('/live/combat'), k.T.gm)).combatants) await k.ok('DELETE', C(`/${x.id}`), k.T.gm);
  const a = await add({ name: 'Axel', initiative: 20, hp: 10, maxHp: 10 });
  const b = await add({ name: 'Brin', initiative: 10, hp: 10, maxHp: 10 });
  await k.ok('PUT', k.w('/live/combat'), k.T.gm, { active: true, round: 1, turn: 0 });
  await patch(b, { effects: [{ name: 'Poisoned', rounds: 2 }, 'Prone'] });
  const n1 = await k.ok('POST', k.w('/live/combat/next'), k.T.gm); // Brin's turn, same round
  assert.equal(n1.ended, undefined);
  const n2 = await k.ok('POST', k.w('/live/combat/next'), k.T.gm); // new round: 2 -> 1
  assert.equal(n2.round, 2);
  assert.equal(n2.combatants.find((x: any) => x.id === b).effects.find((e: any) => e.name === 'Poisoned').rounds, 1);
  await k.ok('POST', k.w('/live/combat/next'), k.T.gm);
  const n4 = await k.ok('POST', k.w('/live/combat/next'), k.T.gm); // round 3: 1 -> 0, gone
  assert.deepEqual(n4.ended.map((e: any) => [e.combatant, e.name]), [['Brin', 'Poisoned']]);
  assert.deepEqual(n4.combatants.find((x: any) => x.id === b).effects.map((e: any) => e.name), ['Prone'], 'an untimed condition stays');
  assert.ok(all<any>(k.deps.db, `SELECT detail FROM audit WHERE action = 'combat.effects_ended'`).some((r) => /Poisoned on Brin/.test(r.detail)), 'what ended is logged');
  void a;
});

test('Combat_Conditions: until the end of X\'s next turn, and until the start of it', async () => {
  for (const x of (await k.ok('GET', k.w('/live/combat'), k.T.gm)).combatants) await k.ok('DELETE', C(`/${x.id}`), k.T.gm);
  const a = await add({ name: 'Cora', initiative: 20, hp: 10, maxHp: 10 });
  const b = await add({ name: 'Dov', initiative: 10, hp: 10, maxHp: 10 });
  await k.ok('PUT', k.w('/live/combat'), k.T.gm, { active: true, round: 1, turn: 0 });
  // Set on Cora's own turn: her current turn's end does not count, the next one does.
  await patch(a, { effects: [{ name: 'Stunned', untilEndOf: 'self' }] });
  await patch(b, { effects: [{ name: 'Marked', untilStartOf: 'Cora' }] });
  assert.equal((await view(a)).effects[0].until.skip, true);
  const n1 = await k.ok('POST', k.w('/live/combat/next'), k.T.gm); // Cora ends, Dov starts
  assert.equal(n1.ended, undefined, 'the turn it was set on does not count');
  const n2 = await k.ok('POST', k.w('/live/combat/next'), k.T.gm); // Dov ends, Cora starts: Marked ends
  assert.deepEqual(n2.ended.map((e: any) => e.name), ['Marked']);
  const n3 = await k.ok('POST', k.w('/live/combat/next'), k.T.gm); // Cora ends: Stunned ends
  assert.deepEqual(n3.ended.map((e: any) => e.name), ['Stunned']);
  assert.equal((await call(a, { effects: [{ name: 'X', untilEndOf: 'Nobody' }] })).status, 400);
  // Sending the plain name again keeps a timer instead of making the condition permanent.
  await patch(b, { effects: [{ name: 'Slowed', rounds: 3 }] });
  await patch(b, { effects: ['Slowed', 'Prone'] });
  assert.equal((await view(b)).effects.find((e: any) => e.name === 'Slowed').rounds, 3);
});

test('Combat_Conditions: tickEffects drops a timer whose source left the fight', () => {
  const r = tickEffects([{ id: 'a', effects: [{ name: 'Charmed', until: { of: 'gone', at: 'end' } }] }], { ending: 'a', starting: 'b', newRound: false });
  assert.equal(r.ended.length, 1);
  assert.match(r.ended[0].why, /left the fight/);
});

test('Combat_Conditions: next_turn names a dying PC whose turn it is', async () => {
  for (const x of (await k.ok('GET', k.w('/live/combat'), k.T.gm)).combatants) await k.ok('DELETE', C(`/${x.id}`), k.T.gm);
  await add({ name: 'Warden', initiative: 20, hp: 10, maxHp: 10 });
  const pc = await add({ name: 'Jessa', initiative: 10, hp: 5, maxHp: 5, accountId: k.ID.jess });
  await k.ok('PUT', k.w('/live/combat'), k.T.gm, { active: true, round: 1, turn: 0 });
  await patch(pc, { damage: 9 });
  assert.equal((await k.ok('POST', k.w('/live/combat/next'), k.T.gm)).deathSaveDue, 'Jessa');
});

test('Combat_Initiative: a statblock monster added with no initiative rolls d20 plus its Dexterity', async () => {
  const t = findMonster(k.deps.db, k.W, 'Goblins');
  assert.ok(t, 'the rules module has a goblin');
  assert.equal(dexModifier(t!), 2);
  const seen = new Set<number>();
  for (let i = 0; i < 12; i++) {
    const r = await k.ok('POST', C(), k.T.gm, { name: 'Goblin', hp: 7 });
    assert.equal(r.rolled.dex, 2);
    assert.equal(r.initiative, r.rolled.d20 + 2);
    assert.ok(r.initiative >= 3 && r.initiative <= 22);
    seen.add(r.initiative);
  }
  assert.ok(seen.size > 1, 'it is a roll, not a constant');
  const none = await k.ok('POST', C(), k.T.gm, { name: 'Mister Nobody' });
  assert.equal(none.initiative, 0, 'no statblock: nothing is made up');
  assert.equal(none.rolled, undefined);
  const given = await k.ok('POST', C(), k.T.gm, { name: 'Goblin', initiative: 11 });
  assert.equal(given.initiative, 11, 'a given initiative is kept');
  const pc = await k.ok('POST', C(), k.T.gm, { name: 'Goblin', accountId: k.ID.jess });
  assert.equal(pc.rolled, undefined, 'a player character never rolls from a monster statblock');
});

test('Combat_Initiative: Dexterity is read from the module text table, with negative modifiers', () => {
  const text = '**AC** 11\n\n| STR | DEX | CON | INT | WIS | CHA |\n|---|---|---|---|---|---|\n| 21 (+5) | 9 (-1) | 15 (+2) | 2 (-4) | 6 (-2) | 5 (-3) |\n';
  assert.equal(dexModifier({ text, data: undefined }), -1);
  assert.equal(dexModifier({ text: text.replace('9 (-1)', '30'), data: undefined }), 10, 'a bare score is converted');
  assert.equal(dexModifier({ text: 'No table here', data: undefined }), null);
  assert.equal(dexModifier({ text: '', data: { abilities: { dex: 15 } } }), 2);
});

test('Combat_Agent: the damage tool result carries the concentration save for the GM', async () => {
  const id = await add({ name: 'Cleric Oran', initiative: 6, hp: 40, maxHp: 40 });
  await patch(id, { concentration: 'Spirit Guardians' });
  const tools = await harnessTools('gm');
  const dmg = tools.find((t) => t.name === 'damage_combatant')!;
  const call = dmg.call({ combatant: id, amount: 30 });
  assert.deepEqual(call.body, { damage: 30, crit: undefined });
  const r = await k.ok('PATCH', k.w(call.path.replace(/^\/live/, '/live')), k.T.gm, call.body);
  assert.equal(r.concentrationSave.dc, 15);
  for (const n of ['give_temp_hp', 'set_concentration', 'concentration_save', 'death_save', 'set_combatant_state']) assert.ok(tools.find((t) => t.name === n && t.write), n);
  assert.deepEqual(tools.find((t) => t.name === 'death_save')!.call({ combatant: 'x', roll: 20 }).body, { deathSave: { roll: 20 } });
});

test('Combat_Players: the player view never carries temp HP, concentration, death saves or timer sources', async () => {
  for (const x of (await k.ok('GET', k.w('/live/combat'), k.T.gm)).combatants) await k.ok('DELETE', C(`/${x.id}`), k.T.gm);
  const hidden = await add({ name: 'Shadow', initiative: 5, hp: 30, maxHp: 30, hidden: true });
  const foe = await add({ name: 'Cultist', initiative: 8, hp: 30, maxHp: 30 });
  const pc = await add({ name: 'Jessa', initiative: 9, hp: 10, maxHp: 10, accountId: k.ID.jess });
  await patch(foe, { tempHp: 7, concentration: 'Secret Spell', effects: [{ name: 'Marked', untilEndOf: hidden }, { name: 'Dazed', rounds: 2 }] });
  await patch(pc, { damage: 12 });
  await k.ok('PUT', k.w('/live/combat'), k.T.gm, { active: true });
  await k.ok('PATCH', k.w('/settings'), k.T.gm, { initiativeVisible: true, monsterHealth: 'none' });
  const pv = await k.ok('GET', k.w('/live/combat'), k.T.jess);
  const text = JSON.stringify(pv);
  assert.ok(!/temp|concentrat|Secret Spell|death|until|skip|Shadow/i.test(text), text);
  assert.deepEqual(pv.combatants.find((x: any) => x.id === foe).effects, [{ name: 'Marked' }, { name: 'Dazed', rounds: 2 }]);
  assert.equal(pv.combatants.find((x: any) => x.id === pc).health, null);
});

test('Combat_Active: cues for concentration, temp HP, death saves and timed conditions', () => {
  const ctx: any = { combat: { active: true, turn: 0, combatants: [
    { id: 'm', name: 'Ilsa', hp: 20, effects: [], isPc: false, concentration: { spell: 'Bless', dc: 12 } },
    { id: 't', name: 'Tomas', hp: 0, effects: ['Prone'], isPc: true, accountId: 'a' },
  ] }, party: [], pages: [], sfx: [], initiativeOpen: false };
  const gm = (text: string) => allCues({ id: 'x', text, speaker: 'gm', role: 'gm', accountId: null, aside: false }, ctx);
  assert.deepEqual(gm('Ilsa loses concentration.').map((c: any) => [c.kind, c.action]), [['concentration', 'lose']]);
  assert.deepEqual(gm('Ilsa fails the concentration save.').map((c: any) => [c.kind, c.action]), [['concentration', 'lose']]);
  assert.deepEqual(gm('Ilsa is concentrating on hold person.').map((c: any) => [c.kind, c.action, c.spell]), [['concentration', 'start', 'Hold Person']]);
  assert.deepEqual(gm('Tomas gains 8 temporary hit points.').map((c: any) => [c.kind, c.amount]), [['temp_hp', 8]]);
  assert.deepEqual(gm('Tomas rolls a 14 on his death save.').map((c: any) => [c.kind, c.roll]), [['death_save', 14]]);
  assert.deepEqual(gm('Tomas rolls a natural 20 on his death save.').map((c: any) => [c.kind, c.roll]), [['death_save', 20]]);
  const st = gm('The club leaves Tomas stunned until the end of his next turn.');
  assert.equal((st[0] as any).until, 'end');
  const d: any = k.deps;
  const lose = build(d, k.W, ctx, gm('Ilsa loses concentration.')[0], 'x')!;
  assert.deepEqual(lose.calls, [{ tool: 'concentration_save', args: { combatant: 'm', result: 'fail' } }], 'a pending save is failed');
  const tmp = build(d, k.W, ctx, gm('Tomas gains 8 temporary hit points.')[0], 'x')!;
  assert.deepEqual(tmp.calls, [{ tool: 'give_temp_hp', args: { combatant: 't', amount: 8 } }], 'temp HP are never a heal');
  const timed = build(d, k.W, ctx, st[0], 'x')!;
  assert.deepEqual(timed.calls[0].args.conditions, ['Prone', { name: 'Stunned', untilEndOf: 't' }]);
  const ds = build(d, k.W, ctx, gm('Tomas rolls a 14 on his death save.')[0], 'x')!;
  assert.deepEqual(ds.calls, [{ tool: 'death_save', args: { combatant: 't', roll: 14 } }]);
  const up = { ...ctx, combat: { ...ctx.combat, combatants: [ctx.combat.combatants[0], { ...ctx.combat.combatants[1], hp: 6 }] } };
  assert.equal(build(d, k.W, up, gm('Tomas rolls a 14 on his death save.')[0], 'x'), null, 'only a downed PC rolls');
});

test('Combat_Active: undo puts temp HP, concentration, death saves and timed conditions back', async () => {
  for (const x of (await k.ok('GET', k.w('/live/combat'), k.T.gm)).combatants) await k.ok('DELETE', C(`/${x.id}`), k.T.gm);
  const id = await add({ name: 'Wren', initiative: 12, hp: 20, maxHp: 20 });
  const pc = await add({ name: 'Tomas', initiative: 11, hp: 6, maxHp: 6, accountId: k.ID.tom });
  await patch(id, { tempHp: 5, concentration: 'Fly', effects: [{ name: 'Slowed', rounds: 3 }] });
  const hit = await execCalls(k.deps, k.W, [{ tool: 'damage_combatant', args: { combatant: id, amount: 9 } }]);
  assert.ok(hit.ok && hit.undo, 'damage that moves temp HP and concentration can be undone');
  let x = await view(id);
  assert.deepEqual([x.hp, x.temp_hp, x.concentration.dc], [16, 0, 10]);
  const back = await execCalls(k.deps, k.W, hit.undo!);
  assert.ok(back.ok, JSON.stringify(back));
  x = await view(id);
  assert.deepEqual([x.hp, x.temp_hp, x.concentration, x.effects], [20, 5, { spell: 'Fly', dc: null }, [{ name: 'Slowed', rounds: 3 }]]);
  // A PC hit at 0 HP and the death save failure it caused.
  await patch(pc, { damage: 8 });
  const down = await execCalls(k.deps, k.W, [{ tool: 'damage_combatant', args: { combatant: pc, amount: 2, crit: true } }]);
  assert.equal((await view(pc)).death_saves.failures, 2);
  await execCalls(k.deps, k.W, down.undo!);
  assert.equal((await view(pc)).death_saves.failures, 0);
  // Turn timers that counted down or ended come back with the turn.
  await patch(id, { effects: [{ name: 'Slowed', rounds: 1 }] });
  await k.ok('PUT', k.w('/live/combat'), k.T.gm, { active: true, round: 1, turn: 1 });
  const nx = await execCalls(k.deps, k.W, [{ tool: 'next_turn', args: {} }]);
  assert.deepEqual((await view(id)).effects, [], 'it ended on the new round');
  await execCalls(k.deps, k.W, nx.undo!);
  assert.deepEqual((await view(id)).effects, [{ name: 'Slowed', rounds: 1 }]);
});

test('Combat_Migration: the new columns are additive on an existing database', () => {
  const cols = (k.deps.db.prepare('PRAGMA table_info(combatants)').all() as any[]).map((c) => c.name);
  for (const c of ['temp_hp', 'concentration', 'death_saves']) assert.ok(cols.includes(c), c);
});


test('Combat_ConcentrationSentAsJsonTextIsReadAsTheObject', async () => {
  const id = await add({ name: 'Mage Orrin', initiative: 7, hp: 20, maxHp: 20 });
  assert.deepEqual((await patch(id, { concentration: '{"spell": "Bless", "dc": 10}' })).concentration, { spell: 'Bless', dc: 10 }, 'what a model sends as text');
});
