// What the spell rules engine needs to remember per character between casts
// (Spell_Plan.md §3-4): caster levels per caster type, the Dual cast ability,
// leveled spells this turn, and what a short or long rest resets (echo
// strain counts, the surge cast, the dual cast and its Arcana penalty, the
// high-level spells already cast).
import { type DB, one, run } from '../../core/db.ts';
import { now, parseJson } from '../../core/util.ts';
import type { CasterType } from './rules.ts';

export const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS spells_state (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  caster_levels TEXT NOT NULL DEFAULT '{}',
  dual_ability INTEGER NOT NULL DEFAULT 0,
  silent_ability INTEGER NOT NULL DEFAULT 0,
  turn_leveled INTEGER NOT NULL DEFAULT 0,
  surge_used INTEGER NOT NULL DEFAULT 0,
  dual_used INTEGER NOT NULL DEFAULT 0,
  dual_penalty INTEGER NOT NULL DEFAULT 0,
  echo TEXT NOT NULL DEFAULT '{}',
  high_used TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, account_id)
);
`;

export type CasterLevels = Partial<Record<Exclude<CasterType, 'none'>, number>>;

export interface CastMemory {
  casterLevels: CasterLevels;
  dualAbility: boolean;
  /** Silent casting: no verbal or somatic components, no extra mana (an ability the DM grants). */
  silentAbility: boolean;
  turnLeveled: number;
  surgeUsed: boolean;
  dualUsed: boolean;
  dualPenalty: number;
  /** Casts of each leveled spell since the last short rest. */
  echo: Record<string, number>;
  /** High-level spells cast since the last long rest. */
  highUsed: string[];
}

export function castMemory(db: DB, worldId: string, accountId: string): CastMemory {
  const r = one<any>(db, 'SELECT * FROM spells_state WHERE world_id = ? AND account_id = ?', worldId, accountId);
  return {
    casterLevels: parseJson<CasterLevels>(r?.caster_levels, {}),
    dualAbility: !!r?.dual_ability,
    silentAbility: !!r?.silent_ability,
    turnLeveled: r?.turn_leveled ?? 0,
    surgeUsed: !!r?.surge_used,
    dualUsed: !!r?.dual_used,
    dualPenalty: r?.dual_penalty ?? 0,
    echo: parseJson<Record<string, number>>(r?.echo, {}),
    highUsed: parseJson<string[]>(r?.high_used, []),
  };
}

export function saveMemory(db: DB, worldId: string, accountId: string, patch: Partial<CastMemory>) {
  const m = { ...castMemory(db, worldId, accountId), ...patch };
  run(db, `INSERT INTO spells_state (world_id, account_id, caster_levels, dual_ability, silent_ability, turn_leveled, surge_used, dual_used, dual_penalty, echo, high_used, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(world_id, account_id) DO UPDATE SET caster_levels = excluded.caster_levels, dual_ability = excluded.dual_ability, silent_ability = excluded.silent_ability, turn_leveled = excluded.turn_leveled, surge_used = excluded.surge_used,
      dual_used = excluded.dual_used, dual_penalty = excluded.dual_penalty, echo = excluded.echo, high_used = excluded.high_used, updated_at = excluded.updated_at`,
    worldId, accountId, JSON.stringify(m.casterLevels), m.dualAbility ? 1 : 0, m.silentAbility ? 1 : 0, m.turnLeveled, m.surgeUsed ? 1 : 0, m.dualUsed ? 1 : 0, m.dualPenalty, JSON.stringify(m.echo), JSON.stringify(m.highUsed), now());
}

/** Does the character have any caster levels set? */
export const hasCasterLevels = (m: CastMemory): boolean => Object.values(m.casterLevels).some((n) => (n ?? 0) > 0);

/** What a rest resets: a short rest the per-short-rest uses and echo counts; a long rest also the high-level spells. Both end the turn. */
export function restMemory(db: DB, worldId: string, accountId: string, kind: 'short' | 'long') {
  saveMemory(db, worldId, accountId, { turnLeveled: 0, surgeUsed: false, dualUsed: false, dualPenalty: 0, echo: {}, ...(kind === 'long' ? { highUsed: [] } : {}) });
}

/** Check caster levels from a request: full, half and third, each 0 to 20, together at most 20. */
export function normalizeCasterLevels(v: unknown): CasterLevels {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('casterLevels must be an object like {"full": 5, "half": 2}');
  const out: CasterLevels = {};
  let sum = 0;
  for (const [k, x] of Object.entries(v)) {
    if (!['full', 'half', 'third'].includes(k)) throw new Error(`Unknown caster type: ${k.slice(0, 20)} (use full, half or third)`);
    if (x === null || x === '' || x === 0) continue;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`${k} levels must be 0 to 20`);
    out[k as keyof CasterLevels] = n;
    sum += n;
  }
  if (sum > 20) throw new Error('Caster levels add up to more than 20');
  return out;
}
