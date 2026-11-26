// House rule "Inspiration as re-rolls" (off by default; World settings →
// Player sheets). Instead of plain inspiration the DM rewards good role play
// with re-roll tokens of three kinds:
//   personal: re-roll one of your own rolls;
//   party:    re-roll anyone's roll at the table, yours or a friend's;
//   dm:       make the DM re-roll one of their rolls.
// The DM gives and takes them back; a player spends their own. Every change
// is logged in sheet_log (kind "reroll").
import type { DB } from '../../core/db.ts';
import { all, run } from '../../core/db.ts';
import { featureSetting, type WorldSettings } from '../../core/policy.ts';
import { HttpError, now } from '../../core/util.ts';
import { logVitals } from './vitals.ts';

export const REROLLS = ['personal', 'party', 'dm'] as const;
export type Reroll = (typeof REROLLS)[number];
export const REROLL_LABEL: Record<Reroll, string> = { personal: 'Personal re-roll', party: 'Everyone re-roll', dm: 'DM re-roll' };

export const rerollRules = (s: WorldSettings) => ({ on: featureSetting<boolean>(s, 'sheetRerolls') === true, cap: featureSetting<number>(s, 'sheetRerollCap') ?? 3 });

export function rerollsOf(db: DB, s: WorldSettings, worldId: string, aid: string) {
  const r = rerollRules(s);
  if (!r.on) return { on: false as const };
  const counts: Record<Reroll, number> = { personal: 0, party: 0, dm: 0 };
  for (const x of all<any>(db, 'SELECT kind, count FROM sheet_rerolls WHERE world_id = ? AND account_id = ?', worldId, aid)) if (x.kind in counts) counts[x.kind as Reroll] = x.count;
  return { on: true as const, cap: r.cap, ...counts };
}

/** Give (+), take back or spend (−) re-rolls. Returns the new count. */
export function changeReroll(db: DB, s: WorldSettings, worldId: string, aid: string, kind: unknown, delta: unknown, by: string, dm: boolean, note: string) {
  const r = rerollRules(s);
  if (!r.on) throw new HttpError(409, 'Re-rolls are off in this world');
  if (!(REROLLS as readonly unknown[]).includes(kind)) throw new HttpError(400, `kind must be one of ${REROLLS.join(', ')}`);
  const k = kind as Reroll;
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 20) throw new HttpError(400, 'delta must be a whole number from -20 to 20, not 0');
  if (!dm && d > 0) throw new HttpError(403, 'Only the DM gives re-rolls');
  const cur = (rerollsOf(db, s, worldId, aid) as any)[k] as number;
  if (cur + d < 0) throw new HttpError(409, `No ${REROLL_LABEL[k].toLowerCase()} left`);
  const next = Math.min(r.cap, cur + d);
  if (next === cur) throw new HttpError(409, `Already at the most (${r.cap})`);
  run(db, `INSERT INTO sheet_rerolls (world_id, account_id, kind, count, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (world_id, account_id, kind) DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`, worldId, aid, k, next, now());
  const what = next < cur ? (dm ? 'taken back' : 'used') : 'given';
  logVitals(db, worldId, aid, 'reroll', cur, next, [`${REROLL_LABEL[k]} ${what}`, note].filter(Boolean).join(' · '), dm ? 'dm' : 'sheet', by);
  return { kind: k, before: cur, now: next, used: !dm && next < cur };
}

export const REROLL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sheet_rerolls (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (world_id, account_id, kind)
  );`;
