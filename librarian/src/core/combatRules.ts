// The 5e combat bookkeeping the tracker keeps for the DM: temporary HP,
// concentration, death saves and timed conditions. Pure functions over plain
// values so the live route, the agent tools and the tests share one rule set.

export interface Concentration { spell: string; /** A Constitution save is due at this DC; null once settled. */ dc: number | null }
export interface DeathSaves { successes: number; failures: number; stable: boolean; dead: boolean }
/** A timed condition: `rounds` count down each new round; `until` ends it on a creature's turn. */
export interface Effect { name: string; rounds?: number; until?: { of: string; at: 'start' | 'end'; /** The turn it was set on is not "next". */ skip?: boolean } }

export const noDeathSaves = (): DeathSaves => ({ successes: 0, failures: 0, stable: false, dead: false });

/** DC for keeping concentration after a hit: half the damage, never under 10. */
export const concentrationDc = (damage: number): number => Math.max(10, Math.floor(damage / 2));

/** Temporary HP do not stack: a new grant only counts when it is higher than what is left. */
export const gainTempHp = (cur: number, grant: number): number => Math.max(cur, grant);

export interface Fighter {
  hp: number | null; maxHp: number | null; tempHp: number; isPc: boolean;
  concentration: Concentration | null; deathSaves: DeathSaves | null;
}
export interface HitResult extends Fighter {
  absorbed: number;
  /** HP actually lost (after temp HP). */
  lost: number;
  /** Fell to 0 or below from above it. */
  dropped: boolean;
  died: boolean;
  /** A Constitution save is now due. */
  concentrationSave: { spell: string; dc: number } | null;
  concentrationEnded: string | null;
  notes: string[];
}

/** Damage: temp HP first, then HP. A hit at 0 HP costs a PC a death save failure (two on a crit). */
export function applyDamage(f: Fighter, amount: number, crit = false): HitResult {
  const out: HitResult = { ...f, absorbed: 0, lost: 0, dropped: false, died: false, concentrationSave: null, concentrationEnded: null, notes: [] };
  if (amount <= 0) return out;
  out.absorbed = Math.min(f.tempHp, amount);
  out.tempHp = f.tempHp - out.absorbed;
  const rem = amount - out.absorbed;
  out.lost = rem;
  if (out.absorbed) out.notes.push(`${out.absorbed} absorbed by temporary HP (${out.tempHp} left)`);
  const was = f.hp;
  // Unknown HP stays unknown, but the rest of the rules (temp HP, concentration) still apply.
  if (was !== null && was !== undefined && rem > 0) {
    if (f.isPc) {
      out.hp = Math.max(0, was - rem);
      const ds = f.deathSaves ? { ...f.deathSaves } : noDeathSaves();
      if (was > 0 && out.hp === 0) {
        out.dropped = true;
        // Left over damage that equals the PC's max HP kills outright.
        if (f.maxHp && rem - was >= f.maxHp) { ds.dead = true; out.died = true; out.notes.push('massive damage: killed outright'); }
        out.deathSaves = ds;
      } else if (was === 0 && !ds.dead) {
        // Damage wakes a stable PC and counts as a failed save.
        if (ds.stable) { ds.stable = false; ds.successes = 0; ds.failures = 0; }
        ds.failures = Math.min(3, ds.failures + (crit ? 2 : 1));
        if (ds.failures >= 3) { ds.dead = true; out.died = true; }
        if (f.maxHp && rem >= f.maxHp) { ds.dead = true; out.died = true; }
        out.notes.push(out.died ? 'dying hit: dead' : `death save failure${crit ? 's (critical hit)' : ''}: ${ds.failures}/3`);
        out.deathSaves = ds;
      }
    } else {
      out.hp = was - rem;
      out.dropped = was > 0 && out.hp <= 0;
    }
  }
  if (f.concentration) {
    if (out.dropped || out.died) {
      out.concentrationEnded = f.concentration.spell;
      out.concentration = null;
      out.notes.push(`concentration on ${f.concentration.spell} ends (down at 0 HP)`);
    } else {
      // Every hit asks for a save; keep the hardest still unresolved.
      const dc = Math.max(f.concentration.dc ?? 0, concentrationDc(amount));
      out.concentration = { spell: f.concentration.spell, dc };
      out.concentrationSave = { spell: f.concentration.spell, dc };
      out.notes.push(`Constitution save DC ${dc} to keep concentrating on ${f.concentration.spell}`);
    }
  }
  return out;
}

/** Healing never touches temp HP. A PC lifted above 0 is no longer dying. */
export function applyHeal(f: Fighter, amount: number): { hp: number | null; deathSaves: DeathSaves | null; revived: boolean } {
  if (f.hp === null || f.hp === undefined) return { hp: f.hp, deathSaves: f.deathSaves, revived: false };
  const hp = Math.min(f.hp + amount, f.maxHp ?? Infinity);
  const revived = f.isPc && f.hp <= 0 && hp > 0;
  return { hp, deathSaves: revived ? null : f.deathSaves, revived };
}

export type DeathSaveInput = { roll: number } | { result: 'success' | 'failure' };
export interface DeathSaveOutcome { deathSaves: DeathSaves | null; hp: number | null; text: string; regained: boolean }

/** One death save. A natural 20 brings the PC back at 1 HP, a natural 1 counts as two failures. */
export function rollDeathSave(cur: DeathSaves | null, input: DeathSaveInput): DeathSaveOutcome {
  const ds = cur ? { ...cur } : noDeathSaves();
  if ('roll' in input) {
    const r = input.roll;
    if (r === 20) return { deathSaves: null, hp: 1, regained: true, text: 'natural 20: back on their feet with 1 HP' };
    const add = r === 1 ? 2 : r >= 10 ? 0 : 1;
    if (r >= 10) ds.successes++; else ds.failures = Math.min(3, ds.failures + add);
    return settle(ds, r === 1 ? 'natural 1: two failures' : r >= 10 ? `rolled ${r}: success` : `rolled ${r}: failure`);
  }
  if (input.result === 'success') ds.successes++; else ds.failures++;
  return settle(ds, input.result);
}
function settle(ds: DeathSaves, why: string): DeathSaveOutcome {
  if (ds.failures >= 3) { ds.failures = 3; ds.dead = true; return { deathSaves: ds, hp: null, regained: false, text: `${why}; 3 failures: dead` }; }
  if (ds.successes >= 3) { ds.successes = 3; ds.stable = true; return { deathSaves: ds, hp: null, regained: false, text: `${why}; 3 successes: stable` }; }
  return { deathSaves: ds, hp: null, regained: false, text: `${why} (${ds.successes} successes, ${ds.failures} failures)` };
}

/** A PC who is down and still needs saves. */
export const isDying = (f: { hp: number | null; isPc: boolean; deathSaves: DeathSaves | null }): boolean =>
  f.isPc && f.hp !== null && f.hp <= 0 && !f.deathSaves?.stable && !f.deathSaves?.dead;

/** Keep the Stable / Dead tags in step with the death saves. */
export function syncDeathTags(eff: Effect[], ds: DeathSaves | null): Effect[] {
  const rest = eff.filter((e) => !['stable', 'dead'].includes(e.name.toLowerCase()));
  return [...rest, ...(ds?.dead ? [{ name: 'Dead' }] : ds?.stable ? [{ name: 'Stable' }] : [])];
}

export interface Ended { combatantId: string; name: string; why: string }

/**
 * One step of the turn order: the creature `ending` finishes its turn, `starting` begins its turn, and `newRound`
 * says the order wrapped. Round counters tick on a new round; "until" conditions end on their creature's turn.
 */
export function tickEffects(list: { id: string; effects: Effect[] }[], step: { ending: string | null; starting: string | null; newRound: boolean }): { changed: { id: string; effects: Effect[] }[]; ended: Ended[] } {
  const ids = new Set(list.map((x) => x.id));
  const changed: { id: string; effects: Effect[] }[] = [];
  const ended: Ended[] = [];
  for (const x of list) {
    let touched = false;
    const keep: Effect[] = [];
    for (const e of x.effects) {
      let next: Effect = e;
      let why = '';
      if (typeof e.rounds === 'number' && step.newRound) {
        next = { ...next, rounds: e.rounds - 1 };
        touched = true;
        if (next.rounds! <= 0) why = 'its rounds ran out';
      }
      if (!why && e.until) {
        if (!ids.has(e.until.of)) why = 'its source left the fight';
        else if (e.until.at === 'end' && e.until.of === step.ending) {
          if (e.until.skip) { next = { ...next, until: { ...e.until, skip: false } }; touched = true; }
          else why = 'the turn it lasted through ended';
        } else if (e.until.at === 'start' && e.until.of === step.starting) why = 'the turn it lasted until began';
      }
      if (why) { touched = true; ended.push({ combatantId: x.id, name: e.name, why }); } else keep.push(next);
    }
    if (touched) changed.push({ id: x.id, effects: keep });
  }
  return { changed, ended };
}

/** Ability score to modifier. */
export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);
