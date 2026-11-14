// The combat tracker as one viewer may see it. Lives in core so the live
// routes and the stage's combat card share one visibility rule (no runtime
// import of app.ts, which features must not do).
import { type DB, one, all } from './db.ts';
import { healthForPlayers, type Viewer, type WorldSettings } from './policy.ts';
import { parseJson } from './util.ts';

/** What a viewer may see of the combat tracker (the DM everything; players no hidden foes, monster health as the setting allows). Also used by the stage's combat card. */
export function combatViewFor(db: DB, worldId: string, v: Viewer, s: WorldSettings) {
  const state = one<any>(db, 'SELECT * FROM combat WHERE world_id = ?', worldId) ?? { active: 0, round: 1, turn: 0 };
  const list = all<any>(db, 'SELECT * FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', worldId);
  if (v.role === 'dm') return { active: !!state.active, round: state.round, turn: state.turn, combatants: list.map((x) => ({ ...x, effects: parseJson(x.effects, []), hidden: !!x.hidden, is_pc: !!x.is_pc })) };
  const shown = list.filter((x) => !x.hidden);
  const current = list[state.turn % Math.max(list.length, 1)];
  const myTurn = !!state.active && current?.account_id === v.accountId;
  if (!s.initiativeVisible) return { active: !!state.active, round: state.round, myTurn };
  return {
    active: !!state.active, round: state.round, myTurn,
    currentId: current && !current.hidden ? current.id : null,
    combatants: shown.map((x) => ({
      id: x.id, name: x.name, is_pc: !!x.is_pc, mine: x.account_id === v.accountId,
      effects: parseJson(x.effects, []),
      health: x.is_pc ? null : healthForPlayers(x.hp, x.max_hp, s.monsterHealth),
    })),
  };
}
