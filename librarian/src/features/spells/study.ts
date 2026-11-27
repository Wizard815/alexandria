// Studying a spell (Spell_Plan.md §6, the study flow): a character picks a
// spell whose recipe they can start, a way to study (alone, a text, a mentor,
// a lab) and studies on downtime days. Each 8-hour day earns 1 to 3 study
// points. When the points are complete they roll the final check; a failed
// check waits for a long rest. A scroll of the spell helps (a quarter of the
// points) and is kept; casting the scroll first loses that help.
import { type DB, all, one, run } from '../../core/db.ts';
import { now } from '../../core/util.ts';
import type { StudySource } from './rules.ts';

export const STUDY_SCHEMA = `
CREATE TABLE IF NOT EXISTS spells_study (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  spell_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  source TEXT NOT NULL,
  lab INTEGER NOT NULL DEFAULT 0,
  research INTEGER NOT NULL DEFAULT 0,
  needed INTEGER NOT NULL,
  banked INTEGER NOT NULL DEFAULT 0,
  pending_days INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  materials INTEGER NOT NULL DEFAULT 0,
  mentor_fee INTEGER NOT NULL DEFAULT 0,
  scroll_help INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'studying',
  wait_long_rest INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_check TEXT NOT NULL DEFAULT '',
  carry_min INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spells_study_who ON spells_study(world_id, account_id, status);
`;

/** Older databases: the minutes of downtime short of a whole study day (added 2026-11). */
export function migrateStudy(db: DB) {
  const cols = all<any>(db, 'PRAGMA table_info(spells_study)').map((c) => c.name);
  if (cols.length && !cols.includes('carry_min')) db.exec('ALTER TABLE spells_study ADD COLUMN carry_min INTEGER NOT NULL DEFAULT 0');
}

/** The 8-hour study day, in minutes of downtime. */
export const STUDY_DAY_MIN = 480;

export type StudyStatus = 'studying' | 'ready' | 'learned' | 'stopped';

export interface Study {
  id: string;
  accountId: string;
  spellId: string;
  recipeId: string;
  source: StudySource;
  lab: boolean;
  research: boolean;
  needed: number;
  banked: number;
  pendingDays: number;
  days: number;
  materials: number;
  mentorFee: number;
  scrollHelp: boolean;
  status: StudyStatus;
  /** A failed final check: the next try waits for a long rest. */
  waitLongRest: boolean;
  attempts: number;
  lastCheck: string;
  /** Downtime minutes short of a whole study day, carried to the next. */
  carryMin: number;
  createdAt: string;
  updatedAt: string;
}

export const rowToStudy = (r: any): Study => ({
  id: r.id, accountId: r.account_id, spellId: r.spell_id, recipeId: r.recipe_id, source: r.source, lab: !!r.lab, research: !!r.research,
  needed: r.needed, banked: r.banked, pendingDays: r.pending_days, days: r.days, materials: r.materials, mentorFee: r.mentor_fee, scrollHelp: !!r.scroll_help,
  status: r.status, waitLongRest: !!r.wait_long_rest, attempts: r.attempts, lastCheck: r.last_check ?? '', carryMin: r.carry_min ?? 0, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const studies = (db: DB, worldId: string, accountId?: string): Study[] =>
  (accountId
    ? all<any>(db, 'SELECT * FROM spells_study WHERE world_id = ? AND account_id = ? ORDER BY created_at', worldId, accountId)
    : all<any>(db, 'SELECT * FROM spells_study WHERE world_id = ? ORDER BY created_at', worldId)).map(rowToStudy);

export const studyById = (db: DB, worldId: string, sid: string): Study | null => { const r = one<any>(db, 'SELECT * FROM spells_study WHERE world_id = ? AND id = ?', worldId, sid); return r ? rowToStudy(r) : null; };

/** The open study of a spell (studying, ready or stopped), so starting again picks up the banked points. */
export const openStudy = (db: DB, worldId: string, accountId: string, spellId: string): Study | null => {
  const r = one<any>(db, "SELECT * FROM spells_study WHERE world_id = ? AND account_id = ? AND spell_id = ? AND status != 'learned' ORDER BY created_at DESC", worldId, accountId, spellId);
  return r ? rowToStudy(r) : null;
};

const COLS: Record<string, string> = {
  recipeId: 'recipe_id', source: 'source', lab: 'lab', research: 'research', needed: 'needed', banked: 'banked', pendingDays: 'pending_days', days: 'days',
  materials: 'materials', mentorFee: 'mentor_fee', scrollHelp: 'scroll_help', status: 'status', waitLongRest: 'wait_long_rest', attempts: 'attempts', lastCheck: 'last_check', carryMin: 'carry_min',
};

export function saveStudy(db: DB, worldId: string, sid: string, patch: Partial<Study>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = COLS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return;
  run(db, `UPDATE spells_study SET ${sets.join(', ')}, updated_at = ? WHERE world_id = ? AND id = ?`, ...vals, now(), worldId, sid);
}

/** A long rest lets every failed final check of this character be tried again. */
export const studyLongRest = (db: DB, worldId: string, accountId: string) => run(db, 'UPDATE spells_study SET wait_long_rest = 0 WHERE world_id = ? AND account_id = ? AND wait_long_rest = 1', worldId, accountId);

/** Proficiency bonus by character level (2 at 1-4, up to 6 at 17-20). */
export const proficiency = (level: number | null): number => 2 + Math.floor((Math.max(1, Math.min(20, level ?? 1)) - 1) / 4);
