// The live session: who is here, the party pouch and coin ledger, and the
// combat tracker. Players get a computed view: no hidden combatants, no
// health numbers for the party, monster health only as the DM's setting allows.
import { Router, type Response } from 'express';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { one, all, run } from '../core/db.ts';
import { combatViewFor } from '../core/combatView.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { featureSetting, type Viewer, type WorldSettings } from '../core/policy.ts';
import { HttpError, id, int, now, parseJson, str } from '../core/util.ts';
import { applyDamage, applyHeal, gainTempHp, isDying, rollDeathSave, syncDeathTags, tickEffects, type Concentration, type DeathSaves, type Effect, type Fighter } from '../core/combatRules.ts';
import { rollMonsterInitiative } from '../features/modules/search.ts';
import { ctx, isDM, me, memberIds, readerFor, settings } from './_shared.ts';

export default function liveRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  const combatView = (worldId: string, v: Viewer, s: WorldSettings) => combatViewFor(db, worldId, v, s);
  const pushCombat = (res: Response) => {
    const c = ctx(res);
    const s = settings(res);
    d.hub.emitPer(c.world.id, 'combat', (v) => combatView(c.world.id, v, s));
  };

  // Balances count approved entries only; player changes wait for the DM.
  const balance = (worldId: string, owner: string) => one<any>(db, `SELECT COALESCE(SUM(amount_cp), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status = 'approved'`, worldId, owner)!.cp as number;

  const combatantIds = (worldId: string) => all<any>(db, 'SELECT id, name FROM combatants WHERE world_id = ?', worldId) as { id: string; name: string }[];
  // Whose turn it is right now (null when combat is not running).
  const currentId = (worldId: string): string | null => {
    const st = one<any>(db, 'SELECT active, turn FROM combat WHERE world_id = ?', worldId);
    if (!st?.active) return null;
    const l = all<any>(db, 'SELECT id FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', worldId);
    return l.length ? l[st.turn % l.length].id : null;
  };

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
  r.get('/combat', (req, res) => res.json(combatView(ctx(res).world.id, readerFor(req, res), settings(res))));
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
    const list = all<any>(db, 'SELECT id, name, account_id, is_pc, hp, death_saves, effects FROM combatants WHERE world_id = ? ORDER BY initiative DESC, name', c.world.id);
    const n = list.length || 1;
    const cur = one<any>(db, 'SELECT * FROM combat WHERE world_id = ?', c.world.id) ?? { active: 0, round: 1, turn: 0 };
    const turn = (cur.turn + 1) % n;
    const round = turn === 0 ? cur.round + 1 : cur.round;
    run(db, `INSERT INTO combat (world_id, active, round, turn) VALUES (?, 1, ?, ?) ON CONFLICT (world_id) DO UPDATE SET active = 1, round = excluded.round, turn = excluded.turn`, c.world.id, round, turn);
    // Timed conditions count down on a new round or end on their creature's turn. Nobody's turn ends when combat only just started.
    const ending = cur.active && list.length ? list[cur.turn % n].id : null;
    const { changed, ended } = tickEffects(list.map((x) => ({ id: x.id, effects: parseJson<Effect[]>(x.effects, []) })), { ending, starting: list[turn]?.id ?? null, newRound: turn === 0 });
    for (const ch of changed) run(db, 'UPDATE combatants SET effects = ? WHERE id = ?', JSON.stringify(ch.effects), ch.id);
    const named = ended.map((e) => ({ ...e, combatant: list.find((x) => x.id === e.combatantId)?.name ?? '?' }));
    if (named.length) audit(db, c.world.id, me(res), 'combat.effects_ended', named.map((e) => `${e.name} on ${e.combatant} (${e.why})`).join('; '));
    pushCombat(res);
    // A PC who is down rolls a death save when their turn comes up: say so for the DM (and the agent).
    const up = list[turn];
    const deathSaveDue = up && isDying({ hp: up.hp, isPc: !!up.is_pc, deathSaves: parseJson(up.death_saves, null) }) ? up.name : undefined;
    res.json({ ...combatView(c.world.id, c.viewer, settings(res)), ...(named.length ? { ended: named } : {}), ...(deathSaveDue ? { deathSaveDue } : {}) });
  });
  r.post('/combatants', requireDM, (req, res) => {
    const c = ctx(res);
    const b = req.body ?? {};
    let acc = b.accountId ? str(b.accountId, 'accountId', { max: 60 }) : null;
    if (acc && !memberIds(db, c.world.id).includes(acc)) throw new HttpError(400, 'Player not found');
    // A party member added by name is that player's character (death saves, the player's own view), not a monster:
    // the assistant often adds "Anselm" with no account. Exactly one player's character or display name must match.
    if (!acc && b.monster !== true && typeof b.name === 'string') {
      const n = b.name.trim().toLowerCase();
      const hits = all<any>(db, "SELECT m.account_id AS id, m.character_name AS ch, a.display_name AS dn FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", c.world.id)
        .filter((m) => [m.ch, m.dn].some((x) => typeof x === 'string' && x.trim().toLowerCase() === n));
      if (hits.length === 1 && !one(db, 'SELECT 1 FROM combatants WHERE world_id = ? AND account_id = ?', c.world.id, hits[0].id)) acc = hits[0].id;
    }
    // Two creatures with one name can't be told apart ("Wolf 2 takes 9"): number them, and the first one too.
    let nm = str(b.name, 'name', { max: 80 }).trim();
    if (!acc && !/\s\d+$/.test(nm)) {
      const same = all<any>(db, 'SELECT id, name FROM combatants WHERE world_id = ? AND (name = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE)', c.world.id, nm, `${nm.replace(/[\\%_]/g, (m) => '\\' + m)} %`).filter((r) => r.name.toLowerCase() === nm.toLowerCase() || /^\d+$/.test(r.name.slice(nm.length + 1)));
      if (same.length) {
        const plain = same.find((r) => r.name.toLowerCase() === nm.toLowerCase());
        if (plain) run(db, 'UPDATE combatants SET name = ? WHERE id = ?', `${plain.name} 1`, plain.id);
        const top = Math.max(1, ...same.map((r) => Number(r.name.slice(nm.length + 1)) || 1));
        nm = `${nm} ${top + 1}`;
      }
    }
    const x = { id: id('cb_'), name: nm, initiative: int(b.initiative, 'initiative', { min: -20, max: 60, optional: true }), hp: int(b.hp, 'hp', { min: -999, max: 99999, optional: true }), max_hp: int(b.maxHp, 'maxHp', { min: 0, max: 99999, optional: true }) };
    // No initiative given for a monster: roll d20 plus Dexterity when its rules statblock is known (or `roll` asks for a plain d20).
    let rolled: { d20: number; dex: number | null; total: number } | undefined;
    if (x.initiative === null && !acc) {
      const rl = rollMonsterInitiative(db, c.world.id, nm, !!b.roll);
      if (rl) { rolled = rl; x.initiative = rl.total; }
    }
    // Armor class and the statblock page are DM-only; the player view never sends them.
    const ac = int(b.ac, 'ac', { min: 0, max: 99, optional: true });
    const sbPage = b.statblockPage ? str(b.statblockPage, 'statblockPage', { max: 80 }) : null;
    const eff = normEffects(b.effects, { ids: combatantIds(c.world.id), selfId: x.id, currentId: null, existing: [] });
    run(db, 'INSERT INTO combatants (id, world_id, name, account_id, is_pc, initiative, hp, max_hp, effects, hidden, ac, statblock_page, temp_hp, concentration, death_saves) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', x.id, c.world.id, x.name, acc, acc ? 1 : 0, x.initiative ?? 0, x.hp, x.max_hp ?? x.hp, JSON.stringify(eff), b.hidden ? 1 : 0, ac, sbPage,
      b.tempHp !== undefined ? int(b.tempHp, 'tempHp', { min: 0, max: 99999 }) : 0, jsonOrNull(b.concentration === undefined ? null : concInput(b.concentration)), jsonOrNull(deathInput(b.deathSaves)));
    pushCombat(res);
    res.status(201).json({ id: x.id, initiative: x.initiative ?? 0, ...(rolled ? { rolled } : {}) });
  });
  r.patch('/combatants/:cid', requireDM, (req, res) => {
    const c = ctx(res);
    const x = one<any>(db, 'SELECT * FROM combatants WHERE id = ? AND world_id = ?', String(req.params.cid), c.world.id);
    if (!x) throw new HttpError(404, 'Combatant not found');
    const b = req.body ?? {};
    const isPc = !!x.account_id;
    const known = (v: number | null | undefined) => v !== null && v !== undefined;
    // { damage } / { heal } let the scroll wheel or numpad change HP by an amount.
    let f: Fighter = { hp: b.hp !== undefined ? int(b.hp, 'hp', { min: -999, max: 99999 }) : x.hp, maxHp: x.max_hp, tempHp: x.temp_hp ?? 0, isPc, concentration: parseJson<Concentration | null>(x.concentration, null), deathSaves: parseJson<DeathSaves | null>(x.death_saves, null) };
    const notes: string[] = [];
    let absorbed = 0, concentrationSave: { spell: string; dc: number } | null = null, concentrationEnded: string | null = null, dropped = false, died = false;
    // A PC lifted above 0 by any means is no longer dying.
    if (b.hp !== undefined && isPc && known(f.hp) && f.hp! > 0) f.deathSaves = null;
    if (b.setTempHp !== undefined) f.tempHp = int(b.setTempHp, 'setTempHp', { min: 0, max: 99999 })!;
    if (b.tempHp !== undefined) {
      const grant = int(b.tempHp, 'tempHp', { min: 0, max: 99999 })!;
      const had = f.tempHp;
      f.tempHp = gainTempHp(had, grant);
      notes.push(grant > had ? `temporary HP now ${f.tempHp}` : `kept ${had} temporary HP (they do not stack; ${grant} is not higher)`);
    }
    if (b.damage !== undefined) {
      const hit = applyDamage(f, int(b.damage, 'damage', { min: 0, max: 99999 })!, !!b.crit);
      ({ absorbed, concentrationSave, concentrationEnded, dropped, died } = hit);
      notes.push(...hit.notes);
      f = hit;
    }
    if (b.heal !== undefined) {
      const h = applyHeal(f, int(b.heal, 'heal', { min: 0, max: 99999 })!);
      if (h.revived) notes.push('back above 0 HP: death saves reset');
      f = { ...f, hp: h.hp, deathSaves: h.deathSaves };
    }
    // Concentration: start (a new spell replaces the old), drop, or settle the pending save.
    if (b.concentration !== undefined) f.concentration = concInput(b.concentration);
    if (b.concentrationSave !== undefined) {
      const cs = f.concentration;
      if (!cs) throw new HttpError(400, 'Not concentrating on anything');
      if (cs.dc === null) throw new HttpError(400, 'No concentration save is due');
      const sv = b.concentrationSave;
      const pass = sv?.result === 'pass' ? true : sv?.result === 'fail' ? false : Number.isFinite(Number(sv?.roll)) && sv?.roll !== null && sv?.roll !== '' ? Number(sv.roll) >= cs.dc : null;
      if (pass === null) throw new HttpError(400, 'concentrationSave needs { result: "pass" | "fail" } or { roll }');
      if (pass) { f.concentration = { spell: cs.spell, dc: null }; notes.push(`kept concentration on ${cs.spell}`); }
      else { f.concentration = null; concentrationEnded = cs.spell; notes.push(`lost concentration on ${cs.spell}`); }
    }
    // Down at 0 HP ends concentration however the HP got there.
    if (f.concentration && known(f.hp) && f.hp! <= 0 && !(known(x.hp) && x.hp <= 0)) { concentrationEnded = f.concentration.spell; notes.push(`concentration on ${f.concentration.spell} ends (down at 0 HP)`); f.concentration = null; }
    if (b.deathSave !== undefined) {
      if (!isDying(f)) throw new HttpError(400, isPc ? 'Only a player character at 0 HP who is not stable or dead rolls death saves' : 'Only player characters roll death saves');
      const roll = b.deathSave?.roll !== undefined ? int(b.deathSave.roll, 'deathSave.roll', { min: 1, max: 20 })! : undefined;
      const out = rollDeathSave(f.deathSaves, roll !== undefined ? { roll } : { result: oneOfResult(b.deathSave?.result) });
      f = { ...f, deathSaves: out.deathSaves, hp: out.regained ? 1 : f.hp };
      died = died || !!out.deathSaves?.dead;
      notes.push(out.text);
    }
    if (b.deathSaves !== undefined) f.deathSaves = deathInput(b.deathSaves);
    const hp = f.hp;
    // A monster dropped to 0 HP is marked Defeated (and, if the DM turned that on, taken out of the tracker).
    const had: Effect[] = parseJson<Effect[]>(x.effects, []);
    let eff: Effect[] = b.effects !== undefined ? normEffects(b.effects, { ids: combatantIds(c.world.id), selfId: x.id, currentId: currentId(c.world.id), existing: had }) : had;
    const fell = !x.account_id && known(hp) && hp! <= 0 && !(known(x.hp) && x.hp <= 0);
    if (fell && !eff.some((e) => String(e?.name ?? e).toLowerCase() === 'defeated')) eff = [...eff, { name: 'Defeated' }];
    // Stable and Dead tags follow the death saves, unless the DM is setting the conditions by hand.
    if (isPc && b.effects === undefined && (b.damage !== undefined || b.deathSave !== undefined || b.deathSaves !== undefined || b.heal !== undefined || b.hp !== undefined)) eff = syncDeathTags(eff, f.deathSaves);
    run(db, 'UPDATE combatants SET name = ?, initiative = ?, hp = ?, max_hp = ?, effects = ?, hidden = ?, ac = ?, temp_hp = ?, concentration = ?, death_saves = ? WHERE id = ?',
      b.name !== undefined ? str(b.name, 'name', { max: 80 }) : x.name,
      b.initiative !== undefined ? int(b.initiative, 'initiative', { min: -20, max: 60 }) : x.initiative,
      hp, b.maxHp !== undefined ? int(b.maxHp, 'maxHp', { min: 0, max: 99999 }) : x.max_hp,
      JSON.stringify(eff),
      b.hidden !== undefined ? (b.hidden ? 1 : 0) : x.hidden,
      b.ac !== undefined ? int(b.ac, 'ac', { min: 0, max: 99 }) : x.ac ?? null,
      f.tempHp, jsonOrNull(f.concentration), jsonOrNull(f.deathSaves), x.id);
    const removed = fell && featureSetting<boolean>(settings(res), 'combatRemoveDefeated') === true;
    if (removed) run(db, 'DELETE FROM combatants WHERE id = ? AND world_id = ?', x.id, c.world.id);
    pushCombat(res);
    res.json({
      ok: true, hp, tempHp: f.tempHp, defeated: fell, removed,
      ...(absorbed ? { absorbed } : {}), ...(dropped ? { droppedToZero: true } : {}), ...(died ? { died: true } : {}),
      concentration: f.concentration, ...(concentrationSave ? { concentrationSave: { ability: 'Constitution', ...concentrationSave } } : {}), ...(concentrationEnded ? { concentrationEnded } : {}),
      deathSaves: f.deathSaves, ...(notes.length ? { notes } : {}),
    });
  });
  r.delete('/combatants/:cid', requireDM, (req, res) => {
    if (!run(db, 'DELETE FROM combatants WHERE id = ? AND world_id = ?', String(req.params.cid), ctx(res).world.id)) throw new HttpError(404, 'Combatant not found');
    pushCombat(res);
    res.json({ ok: true });
  });

  return r;
}

const jsonOrNull = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const oneOfResult = (v: unknown): 'success' | 'failure' => {
  if (v === 'success' || v === 'failure') return v;
  throw new HttpError(400, 'deathSave needs { roll: 1-20 } or { result: "success" | "failure" }');
};

/** A spell name (or {spell, dc}) starts concentration, a new one replacing the old; null or "" drops it. */
function concInput(v: unknown): Concentration | null {
  if (v === null || v === '') return null;
  // A model sometimes sends the object as text ('{"spell": "Bless"}'): read it as the object it is.
  if (typeof v === 'string' && /^\s*\{/.test(v)) { try { return concInput(JSON.parse(v)); } catch (e) { if (e instanceof HttpError) throw e; } }
  if (typeof v === 'string') return { spell: str(v, 'concentration', { max: 80 }), dc: null };
  if (v && typeof v === 'object') {
    const o = v as any;
    const dc = o.dc === null || o.dc === undefined ? null : int(o.dc, 'concentration.dc', { min: 1, max: 99 });
    return { spell: str(o.spell, 'concentration.spell', { max: 80 }), dc };
  }
  throw new HttpError(400, 'concentration must be a spell name or null');
}

function deathInput(v: unknown): DeathSaves | null {
  if (v === null || v === undefined) return null;
  const o = v as any;
  if (typeof o !== 'object') throw new HttpError(400, 'deathSaves must be an object or null');
  return { successes: int(o.successes ?? 0, 'deathSaves.successes', { min: 0, max: 3 })!, failures: int(o.failures ?? 0, 'deathSaves.failures', { min: 0, max: 3 })!, stable: !!o.stable, dead: !!o.dead };
}

interface EffectCtx { ids: { id: string; name: string }[]; selfId: string; currentId: string | null; existing: Effect[] }
/**
 * Conditions: a name, or an object with a duration. `rounds` counts down each new round; `untilEndOf` / `untilStartOf`
 * (a combatant id, name or "self") end it on that creature's turn. A bare name keeps the timer of the same condition
 * already on the creature, so re-sending the list never silently makes a timed condition permanent.
 */
function normEffects(v: unknown, cx: EffectCtx): Effect[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw new HttpError(400, 'effects must be a list');
  const who = (raw: unknown, f: string): string => {
    const s = String(raw ?? '').trim();
    // "Until the end of his next turn": the model writes the turn, not the creature ("next turn", "his next turn", "own").
    if (/^(self|own|itself|themselves|(?:(?:his|her|its|their|my|your|the) )?(?:own )?(?:next |current )?turn)$/i.test(s)) return cx.selfId;
    const hit = cx.ids.find((c) => c.id === s) ?? cx.ids.find((c) => c.name.toLowerCase() === s.toLowerCase());
    if (hit) return hit.id;
    throw new HttpError(400, `${f}: no such combatant`);
  };
  return v.map((e, i): Effect => {
    if (typeof e === 'string') {
      const name = str(e, `effects[${i}]`, { max: 60 });
      return cx.existing.find((o) => o.name.toLowerCase() === name.toLowerCase()) ?? { name };
    }
    if (!e || typeof e !== 'object') throw new HttpError(400, 'Bad effect');
    const o = e as any;
    const out: Effect = { name: str(o.name, `effects[${i}].name`, { max: 60 }) };
    if (o.rounds !== undefined) out.rounds = int(o.rounds, `effects[${i}].rounds`, { min: 1, max: 1000 })!;
    const end = o.untilEndOf ?? (o.until?.at === 'end' ? o.until.of : undefined);
    const start = o.untilStartOf ?? (o.until?.at === 'start' ? o.until.of : undefined);
    if (end !== undefined && start !== undefined) throw new HttpError(400, 'A condition ends at the end or the start of a turn, not both');
    if (end !== undefined) { const of = who(end, `effects[${i}].untilEndOf`); out.until = { of, at: 'end', skip: o.until?.skip !== undefined ? !!o.until.skip : of === cx.currentId }; }
    else if (start !== undefined) out.until = { of: who(start, `effects[${i}].untilStartOf`), at: 'start' };
    return out;
  });
}
