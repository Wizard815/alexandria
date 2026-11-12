// The live session: who is here, the party pouch and coin ledger, and the
// combat tracker. Players get a computed view: no hidden combatants, no
// health numbers for the party, monster health only as the DM's setting allows.
import { Router, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { healthForPlayers, type Viewer, type WorldSettings } from '../core/policy.ts';
import { HttpError, id, int, now, parseJson, str } from '../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from './_shared.ts';

export default function liveRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  function combatView(worldId: string, v: Viewer, s: WorldSettings) {
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
  const pushCombat = (res: Response) => {
    const c = ctx(res);
    const s = settings(res);
    d.hub.emitPer(c.world.id, 'combat', (v) => combatView(c.world.id, v, s));
  };

  // Balances count approved entries only; player changes wait for the DM.
  const balance = (worldId: string, owner: string) => one<any>(db, `SELECT COALESCE(SUM(amount_cp), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status = 'approved'`, worldId, owner)!.cp as number;

  r.get('/', (req, res) => {
    const c = ctx(res);
    const s = settings(res);
    const label = typeof req.query.session === 'string' ? req.query.session : null;
    const here = all(db, `SELECT p.account_id, p.location, p.at, a.display_name, m.character_name, m.role FROM presence p
      JOIN accounts a ON a.id = p.account_id JOIN members m ON m.account_id = p.account_id AND m.world_id = p.world_id
      WHERE p.world_id = ? ORDER BY m.role, a.display_name`, c.world.id);
    res.json({
      here,
      members: memberIds(db, c.world.id).length,
      purse: s.partyPurse ? {
        cp: balance(c.world.id, 'party'),
        recent: all(db, `SELECT id, amount_cp, note, session_label, at, status FROM ledger WHERE world_id = ? AND owner = 'party' AND status IN ('approved', 'pending') ${label ? 'AND session_label = ?' : ''} ORDER BY at DESC LIMIT 20`, ...(label ? [c.world.id, label] : [c.world.id])),
      } : null,
      myCoin: balance(c.world.id, me(res)),
      combat: combatView(c.world.id, c.viewer, s),
      captions: s.captions,
    });
  });

  r.put('/presence', (req, res) => {
    const c = ctx(res);
    const location = str(req.body?.location, 'location', { max: 60, optional: true }) || 'Here';
    run(db, `INSERT INTO presence (world_id, account_id, location, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (world_id, account_id) DO UPDATE SET location = excluded.location, at = excluded.at`, c.world.id, me(res), location, now());
    d.hub.emit(c.world.id, 'presence', { accountId: me(res), location }, () => true);
    res.json({ ok: true });
  });
  r.delete('/presence', (_req, res) => {
    const c = ctx(res);
    run(db, 'DELETE FROM presence WHERE world_id = ? AND account_id = ?', c.world.id, me(res));
    d.hub.emit(c.world.id, 'presence', { accountId: me(res), location: null }, () => true);
    res.json({ ok: true });
  });
  r.delete('/presence/all', requireDM, (_req, res) => {
    run(db, 'DELETE FROM presence WHERE world_id = ?', ctx(res).world.id);
    res.json({ ok: true });
  });

  // Coin ledger. owner: 'party', 'me', or (DM) an account id.
  r.get('/ledger', (req, res) => {
    const c = ctx(res);
    const owner = resolveOwner(res, String(req.query.owner ?? 'me'), false);
    // Players see approved entries plus their own pending ones.
    const entries = all<any>(db, `SELECT * FROM ledger WHERE world_id = ? AND owner = ? AND (status = 'approved' OR (status = 'pending' AND (? OR by_id = ?))) ORDER BY at DESC LIMIT 200`, c.world.id, owner, isDM(res) ? 1 : 0, me(res));
    res.json({ cp: balance(c.world.id, owner), pending: entries.filter((x) => x.status === 'pending').reduce((n, x) => n + x.amount_cp, 0), entries });
  });
  r.post('/ledger', requirePlayerOrDM, (req, res) => {
    const c = ctx(res);
    const owner = resolveOwner(res, String(req.body?.owner ?? 'me'), true);
    // A player's change is only a request until the DM approves it.
    const pending = !isDM(res) && settings(res).playerChangesNeedApproval;
    const e = { id: id('led_'), world_id: c.world.id, owner, amount_cp: int(req.body?.amountCp, 'amountCp', { min: -100_000_000, max: 100_000_000 })!, note: str(req.body?.note, 'note', { max: 200, optional: true }), session_label: str(req.body?.session, 'session', { max: 40, optional: true }) || null, by_id: me(res), at: now(), status: pending ? 'pending' : 'approved' };
    if (e.amount_cp === 0) throw new HttpError(400, 'amountCp cannot be zero');
    run(db, 'INSERT INTO ledger (id, world_id, owner, amount_cp, note, session_label, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', e.id, e.world_id, e.owner, e.amount_cp, e.note, e.session_label, e.by_id, e.at, e.status);
    audit(db, c.world.id, me(res), pending ? 'coin.request' : 'coin', `${owner} ${e.amount_cp} ${e.note}`);
    if (pending) d.hub.emit(c.world.id, 'approval', { kind: 'coin', id: e.id }, dmAnd(me(res)));
    else d.hub.emit(c.world.id, 'coin', { ...e, balance: balance(c.world.id, owner) }, owner === 'party' ? () => true : dmAnd(owner));
    res.status(pending ? 202 : 201).json({ ...e, pending, balance: balance(c.world.id, owner) });
  });

  function resolveOwner(res: Response, raw: string, writing: boolean): string {
    const s = settings(res);
    if (raw === 'party') {
      if (!s.partyPurse) throw new HttpError(404, 'The party pouch is off for this world');
      return 'party';
    }
    if (raw === 'me') return me(res);
    if (!isDM(res)) throw new HttpError(403, 'You can only see your own coin and the party pouch');
    if (writing && !s.dmEditsInventory) throw new HttpError(403, 'DM edits to player coin are off in World settings');
    if (!memberIds(db, ctx(res).world.id).includes(raw)) throw new HttpError(404, 'Player not found');
    return raw;
  }

  // Combat (DM)
  r.get('/combat', (_req, res) => res.json(combatView(ctx(res).world.id, ctx(res).viewer, settings(res))));
  r.put('/combat', requireDM, (req, res) => {
    const c = ctx(res);
    const cur = one<any>(db, 'SELECT * FROM combat WHERE world_id = ?', c.world.id) ?? { active: 0, round: 1, turn: 0 };
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : cur.active;
    const round = int(req.body?.round, 'round', { min: 1, max: 9999, optional: true }) ?? cur.round;
    const turn = int(req.body?.turn, 'turn', { min: 0, max: 999, optional: true }) ?? cur.turn;
    run(db, `INSERT INTO combat (world_id, active, round, turn) VALUES (?, ?, ?, ?) ON CONFLICT (world_id) DO UPDATE SET active = excluded.active, round = excluded.round, turn = excluded.turn`, c.world.id, active, round, turn);
    pushCombat(res);
    res.json(combatView(c.world.id, c.viewer, settings(res)));
  });
  r.post('/combat/next', requireDM, (_req, res) => {
    const c = ctx(res);
    const n = one<any>(db, 'SELECT COUNT(*) AS n FROM combatants WHERE world_id = ?', c.world.id)!.n || 1;
    const cur = one<any>(db, 'SELECT * FROM combat WHERE world_id = ?', c.world.id) ?? { round: 1, turn: 0 };
    const turn = (cur.turn + 1) % n;
    const round = turn === 0 ? cur.round + 1 : cur.round;
    run(db, `INSERT INTO combat (world_id, active, round, turn) VALUES (?, 1, ?, ?) ON CONFLICT (world_id) DO UPDATE SET active = 1, round = excluded.round, turn = excluded.turn`, c.world.id, round, turn);
    // Effects with a duration in rounds tick down when a new round starts.
    if (turn === 0) {
      for (const x of all<any>(db, 'SELECT id, effects FROM combatants WHERE world_id = ?', c.world.id)) {
        const eff = parseJson<any[]>(x.effects, []).map((e) => (typeof e.rounds === 'number' ? { ...e, rounds: e.rounds - 1 } : e)).filter((e) => typeof e.rounds !== 'number' || e.rounds > 0);
        run(db, 'UPDATE combatants SET effects = ? WHERE id = ?', JSON.stringify(eff), x.id);
      }
    }
    pushCombat(res);
    res.json(combatView(c.world.id, c.viewer, settings(res)));
  });
  r.post('/combatants', requireDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    const acc = b.accountId ? str(b.accountId, 'accountId', { max: 60 }) : null;
    if (acc && !memberIds(db, c.world.id).includes(acc)) throw new HttpError(400, 'Player not found');
    const x = { id: id('cb_'), name: str(b.name, 'name', { max: 80 }), initiative: int(b.initiative, 'initiative', { min: -20, max: 60, optional: true }) ?? 0, hp: int(b.hp, 'hp', { min: -999, max: 99999, optional: true }), max_hp: int(b.maxHp, 'maxHp', { min: 0, max: 99999, optional: true }) };
    run(db, 'INSERT INTO combatants (id, world_id, name, account_id, is_pc, initiative, hp, max_hp, effects, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', x.id, c.world.id, x.name, acc, acc ? 1 : 0, x.initiative, x.hp, x.max_hp ?? x.hp, JSON.stringify(effects(b.effects)), b.hidden ? 1 : 0);
    pushCombat(res);
    res.status(201).json({ id: x.id });
  });
  r.patch('/combatants/:cid', requireDM, (req, res) => {
    const c = ctx(res);
    const x = one<any>(db, 'SELECT * FROM combatants WHERE id = ? AND world_id = ?', String(req.params.cid), c.world.id);
    if (!x) throw new HttpError(404, 'Combatant not found');
    const b = req.body ?? {};
    // { damage } / { heal } let the scroll wheel or numpad change HP by an amount.
    let hp = b.hp !== undefined ? int(b.hp, 'hp', { min: -999, max: 99999 }) : x.hp;
    if (b.damage !== undefined) hp = (hp ?? 0) - int(b.damage, 'damage', { min: 0, max: 99999 })!;
    if (b.heal !== undefined) hp = Math.min((hp ?? 0) + int(b.heal, 'heal', { min: 0, max: 99999 })!, x.max_hp ?? Infinity);
    run(db, 'UPDATE combatants SET name = ?, initiative = ?, hp = ?, max_hp = ?, effects = ?, hidden = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 'name', { max: 80 }) : x.name,
      b.initiative !== undefined ? int(b.initiative, 'initiative', { min: -20, max: 60 }) : x.initiative,
      hp, b.maxHp !== undefined ? int(b.maxHp, 'maxHp', { min: 0, max: 99999 }) : x.max_hp,
      b.effects !== undefined ? JSON.stringify(effects(b.effects)) : x.effects,
      b.hidden !== undefined ? (b.hidden ? 1 : 0) : x.hidden, x.id);
    pushCombat(res);
    res.json({ ok: true, hp });
  });
  r.delete('/combatants/:cid', requireDM, (req, res) => {
    if (!run(db, 'DELETE FROM combatants WHERE id = ? AND world_id = ?', String(req.params.cid), ctx(res).world.id)) throw new HttpError(404, 'Combatant not found');
    pushCombat(res);
    res.json({ ok: true });
  });

  return r;
}

function effects(v: unknown) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw new HttpError(400, 'effects must be a list');
  return v.map((e, i) => {
    if (typeof e === 'string') return { name: str(e, `effects[${i}]`, { max: 60 }) };
    if (e && typeof e === 'object') return { name: str((e as any).name, `effects[${i}].name`, { max: 60 }), ...((e as any).rounds !== undefined ? { rounds: int((e as any).rounds, `effects[${i}].rounds`, { min: 1, max: 1000 }) } : {}) };
    throw new HttpError(400, 'Bad effect');
  });
}
