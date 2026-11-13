// The broker has no clock of its own: game-time waits run on the world clock
// (features/clock). Worlds that had broker game minutes are moved over once.
import type { DB } from '../../core/db.ts';
import { one, run } from '../../core/db.ts';
import { advance, getCalendar, getClock, minutesToDate, setDate } from '../clock/api.ts';

/** Move the world clock to an absolute minute (forward by advancing, back by setting the date). */
export function moveClockTo(db: DB, hub: any, worldId: string, minutes: number, reason: string, by: string | null) {
  const cur = getClock(db, worldId).minutes;
  if (minutes > cur) advance(db, hub, worldId, minutes - cur, reason, by);
  else if (minutes < cur) setDate(db, hub, worldId, minutesToDate(getCalendar(db, worldId).definition, minutes), reason, by);
}

/** Once per world: an untouched world clock starts where the broker's old clock was. */
export function migrateBrokerClock(db: DB, worldId: string) {
  const row = one<{ game_minutes: number; clock_migrated: number }>(db, 'SELECT game_minutes, clock_migrated FROM broker_config WHERE world_id = ?', worldId);
  if (!row || row.clock_migrated) return;
  try {
    const cur = getClock(db, worldId).minutes;
    const touched = !!one(db, 'SELECT 1 FROM clock_log WHERE world_id = ?', worldId) || cur !== 8 * 60;
    if (!touched && row.game_minutes > 0 && row.game_minutes !== cur) moveClockTo(db, null, worldId, row.game_minutes, 'Moved from the broker clock', null);
  } catch { /* no such world: nothing to move */ }
  run(db, 'UPDATE broker_config SET clock_migrated = 1 WHERE world_id = ?', worldId);
}
