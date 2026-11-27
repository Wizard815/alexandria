// The player sheet: a small, modular companion to the paper character sheet.
// Each player arranges their own modules (health and conditions, mana,
// inventory, allies and enemies, quick notes, recently seen people and
// places, and their own text, counters and checklists). Every HP and mana
// change is logged, and the GM gets each player's health and mana in one
// status bar (GET /party).
//
// Mana belongs to the spells feature (features/spells): this reads and
// changes it only through that feature's own store and rules, and its changes
// go to the spells log like any other.
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { requireGM, requirePlayerOrGM } from '../../core/auth.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { gmAnd } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { ctx, isGM, me, memberIds, settings } from '../../routes/_shared.ts';
import { manaRules } from '../spells/index.ts';
import { poolMax, poolNow } from '../spells/mana.ts';
import { character, logEntry, saveCharacter } from '../spells/store.ts';
import type { Feature } from '../types.ts';
import { cleanModules, DEFAULT_MODULES, shownTo, type Module } from './modules.ts';
import { recentFor } from './recent.ts';
import { changeReroll, REROLL_SCHEMA, rerollsOf } from './rerolls.ts';
import { changeVitals, vitalsLog, vitalsOf, type VitalsChange } from './vitals.ts';

const audit = (db: Deps['db'], worldId: string, accountId: string, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const CONDITIONS_MAX = 20;
const settingsOf = (db: Deps['db'], worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) });

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;

  /** `me`, or (for the GM) any player. Players may only name themselves. */
  function who(res: Response, raw: unknown): string {
    const v = String(raw ?? 'me');
    let aid = v === 'me' ? me(res) : v;
    // The GM (and the assistant) may name a player by character or display name.
    if (isGM(res) && aid !== me(res) && !memberIds(db, W(res), ['player', 'gm']).includes(aid)) {
      const n = v.trim().toLowerCase();
      const hits = all<any>(db, "SELECT m.account_id, m.character_name, a.display_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", W(res))
        .filter((m) => [m.character_name, m.display_name].some((x) => typeof x === 'string' && x.trim().toLowerCase() === n));
      if (hits.length === 1) aid = hits[0].account_id;
    }
    if (!isGM(res) && aid !== me(res)) throw new HttpError(404, 'Sheet not found');
    if (!memberIds(db, W(res), ['player', 'gm']).includes(aid)) throw new HttpError(404, 'Sheet not found');
    return aid;
  }
  const nameOf = (worldId: string, aid: string) => {
    const m = one<any>(db, 'SELECT a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.account_id = ?', worldId, aid);
    return { name: m?.character_name || m?.display_name || '', player: m?.display_name ?? '' };
  };
  const manaOf = (res: Response, aid: string) => {
    const rules = manaRules(settings(res));
    if (!rules.on) return { on: false as const };
    const c = character(db, W(res), aid);
    const max = poolMax(c, rules);
    return { on: true as const, now: poolNow(c, max), max };
  };
  const modulesOf = (worldId: string, aid: string): Module[] => {
    const raw = one<any>(db, 'SELECT modules FROM sheets WHERE world_id = ? AND account_id = ?', worldId, aid)?.modules;
    return raw ? parseJson<Module[]>(raw, DEFAULT_MODULES) : DEFAULT_MODULES;
  };
  const changed = (worldId: string, aid: string, combat = false) => {
    d.hub.emit(worldId, 'sheet', { accountId: aid }, gmAnd(aid));
    if (combat) { const s = settingsOf(db, worldId); d.hub.emitPer(worldId, 'combat', (v) => combatViewFor(db, worldId, v, s)); }
  };

  // ---- the GM's status bar: every player's health and mana ----
  r.get('/party', requireGM, (_req, res) => {
    const w = W(res);
    const rows = all<any>(db, "SELECT m.account_id FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player' ORDER BY COALESCE(NULLIF(m.character_name, ''), a.display_name) COLLATE NOCASE", w);
    res.json({
      players: rows.map(({ account_id: aid }) => {
        const cb = one<any>(db, 'SELECT death_saves FROM combatants WHERE world_id = ? AND account_id = ? LIMIT 1', w, aid);
        return { accountId: aid, ...nameOf(w, aid), ...vitalsOf(db, w, aid), mana: manaOf(res, aid), rerolls: rerollsOf(db, settings(res), w, aid), inCombat: !!cb, deathSaves: cb ? parseJson(cb.death_saves, null) : null };
      }),
    });
  });

  // ---- every HP and mana change, newest first ----
  r.get('/log', (req, res) => {
    const aid = isGM(res) ? (req.query.account ? who(res, req.query.account) : null) : me(res);
    const w = W(res);
    const hp = vitalsLog(db, w, aid).map((x) => ({ id: x.id, accountId: x.account_id, kind: x.kind, before: x.before, after: x.after, amount: x.amount, note: x.note, source: x.source, by: x.by_id, at: x.at }));
    let mana: any[] = [];
    try {
      mana = all<any>(db, `SELECT * FROM spells_log WHERE world_id = ? AND amount IS NOT NULL ${aid ? 'AND account_id = ?' : ''} ORDER BY at DESC, rowid DESC LIMIT 200`, w, ...(aid ? [aid] : []))
        .map((x) => ({ id: x.id, accountId: x.account_id, kind: 'mana', before: x.mana_after !== null && x.amount !== null ? x.mana_after - x.amount : null, after: x.mana_after, amount: x.amount, note: x.note, source: x.kind, by: x.by_id, at: x.at }));
    } catch { /* no spells tables */ }
    res.json({ log: [...hp, ...mana].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 200) });
  });

  // ---- one sheet ----
  r.get('/:aid', (req, res) => {
    const aid = who(res, req.params.aid);
    const w = W(res);
    const own = aid === me(res);
    res.json({ accountId: aid, ...nameOf(w, aid), mine: own, ...vitalsOf(db, w, aid), mana: manaOf(res, aid), rerolls: rerollsOf(db, settings(res), w, aid), modules: shownTo(modulesOf(w, aid), own), fromGm: gmNotes(w, aid) });
  });

  // ---- notes and goals the GM sets for one player: only that player and the GM see them ----
  const gmNotes = (w: string, aid: string) => all<any>(db, 'SELECT * FROM sheet_gm_notes WHERE world_id = ? AND account_id = ? ORDER BY kind DESC, done, created_at', w, aid)
    .map((x) => ({ id: x.id, kind: x.kind, text: x.text, done: !!x.done, createdAt: x.created_at, updatedAt: x.updated_at }));
  const noteText = (v: unknown) => {
    const t = String(v ?? '').trim();
    if (!t || t.length > 2000) throw new HttpError(400, 'text must be 1 to 2000 characters');
    return t;
  };
  const noteKind = (v: unknown): 'note' | 'goal' => {
    if (v !== 'note' && v !== 'goal') throw new HttpError(400, 'kind must be note or goal');
    return v;
  };
  r.post('/:aid/gm-notes', requireGM, (req, res) => {
    const aid = who(res, req.params.aid);
    if (aid === me(res)) throw new HttpError(400, 'Pick a player');
    const w = W(res);
    const nid = id('sdn_');
    run(db, 'INSERT INTO sheet_gm_notes (id, world_id, account_id, kind, text, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', nid, w, aid, noteKind(req.body?.kind ?? 'note'), noteText(req.body?.text), now(), now());
    changed(w, aid);
    res.status(201).json({ fromGm: gmNotes(w, aid) });
  });
  // The GM edits anything; the player may only tick a goal done or not.
  r.patch('/:aid/gm-notes/:nid', requirePlayerOrGM, (req, res) => {
    const aid = who(res, req.params.aid);
    const w = W(res);
    const x = one<any>(db, 'SELECT * FROM sheet_gm_notes WHERE id = ? AND world_id = ? AND account_id = ?', String(req.params.nid), w, aid);
    if (!x) throw new HttpError(404, 'Note not found');
    const b = req.body ?? {};
    if (!isGM(res) && (b.text !== undefined || b.kind !== undefined)) throw new HttpError(403, 'Only the GM changes what it says');
    if (!isGM(res) && x.kind !== 'goal') throw new HttpError(400, 'Only goals can be ticked');
    run(db, 'UPDATE sheet_gm_notes SET kind = ?, text = ?, done = ?, updated_at = ? WHERE id = ?',
      b.kind !== undefined ? noteKind(b.kind) : x.kind, b.text !== undefined ? noteText(b.text) : x.text, b.done !== undefined ? (b.done ? 1 : 0) : x.done, now(), x.id);
    changed(w, aid);
    res.json({ fromGm: gmNotes(w, aid) });
  });
  r.delete('/:aid/gm-notes/:nid', requireGM, (req, res) => {
    const aid = who(res, req.params.aid);
    if (!run(db, 'DELETE FROM sheet_gm_notes WHERE id = ? AND world_id = ? AND account_id = ?', String(req.params.nid), W(res), aid)) throw new HttpError(404, 'Note not found');
    changed(W(res), aid);
    res.json({ fromGm: gmNotes(W(res), aid) });
  });

  r.get('/:aid/recent', (req, res) => {
    const aid = who(res, req.params.aid);
    // What that player may see, even when the GM asks.
    res.json(recentFor(d, W(res), { accountId: aid, role: 'player' }));
  });

  // Only the player arranges their own sheet.
  r.put('/me/modules', requirePlayerOrGM, (req, res) => {
    const w = W(res);
    const mods = cleanModules(req.body?.modules);
    run(db, `INSERT INTO sheets (world_id, account_id, conditions, modules, updated_at) VALUES (?, ?, '[]', ?, ?)
      ON CONFLICT (world_id, account_id) DO UPDATE SET modules = excluded.modules, updated_at = excluded.updated_at`, w, me(res), JSON.stringify(mods), now());
    changed(w, me(res));
    res.json({ modules: mods });
  });

  // HP, max HP, temporary HP and conditions: the player or the GM.
  r.post('/:aid/vitals', requirePlayerOrGM, (req, res) => {
    const aid = who(res, req.params.aid);
    const b = req.body ?? {};
    const n = (k: string, min: number, max: number, nullable = false): number | null | undefined => {
      if (b[k] === undefined) return undefined;
      if (nullable && (b[k] === null || b[k] === '')) return null;
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${k} must be a whole number from ${min} to ${max}`);
      return v;
    };
    const ch: VitalsChange = {};
    const set = <K extends keyof VitalsChange>(k: K, v: VitalsChange[K] | undefined) => { if (v !== undefined) ch[k] = v; };
    set('damage', n('damage', 0, 99999) as number | undefined);
    set('heal', n('heal', 0, 99999) as number | undefined);
    set('hp', n('hp', -999, 99999, true));
    set('maxHp', n('maxHp', 0, 99999, true));
    set('tempHp', n('tempHp', 0, 99999) as number | undefined);
    set('setTempHp', n('setTempHp', 0, 99999) as number | undefined);
    if (b.crit === true) ch.crit = true;
    if (b.conditions !== undefined) {
      if (!Array.isArray(b.conditions) || b.conditions.length > CONDITIONS_MAX) throw new HttpError(400, `conditions must be a list of up to ${CONDITIONS_MAX} names`);
      const seen = new Set<string>();
      ch.conditions = b.conditions.map((c: unknown) => String(c ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)).filter((c: string) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
    }
    if (!Object.keys(ch).length) throw new HttpError(400, 'Send damage, heal, hp, maxHp, tempHp, setTempHp or conditions');
    const note = String(b.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const source = isGM(res) && aid !== me(res) ? 'gm' : 'sheet';
    const out = tx(db, () => changeVitals(db, W(res), aid, ch, source, me(res), note));
    changed(W(res), aid, out.combat);
    res.json({ ...out.after, notes: out.notes });
  });

  // Mana up or down (a potion, a lost focus): the player within their pool, the GM any amount. The spells log keeps it.
  r.post('/:aid/mana', requirePlayerOrGM, (req, res) => {
    const aid = who(res, req.params.aid);
    const w = W(res);
    const rules = manaRules(settings(res));
    if (!rules.on) throw new HttpError(409, 'Mana is off in this world');
    const b = req.body ?? {};
    const gm = isGM(res);
    // The MANA branch's world setting (default on); the GM is never stopped by it.
    if (!gm && featureSetting<boolean>(settings(res), 'spellManaPlayerEdit') === false) throw new HttpError(403, 'The GM changes mana in this world');
    const note = String(b.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const out = tx(db, () => {
      const c = character(db, w, aid);
      const max = poolMax(c, rules);
      if (max === null) throw new HttpError(409, 'Set the character level (or a mana maximum) first');
      const cur = poolNow(c, max) ?? max;
      let next = b.full === true ? max : b.set !== undefined ? Number(b.set) : cur + Number(b.delta);
      if (!Number.isInteger(next) || next < -9999 || next > 99999) throw new HttpError(400, 'Send delta (a whole number), set (the new amount) or full: true');
      if (!gm) next = Math.max(0, Math.min(max, next));
      if (next !== cur) {
        saveCharacter(db, w, aid, { mana: next });
        logEntry(db, w, aid, 'adjust', me(res), { amount: next - cur, manaAfter: next, note: note || (gm ? 'Adjusted by the GM' : 'Changed on the sheet') });
      }
      return { now: next, max, changed: next !== cur, before: cur };
    });
    if (out.changed) {
      if (!gm) audit(db, w, me(res), 'spells.mana.player', `${out.before} -> ${out.now}${note ? ` (${note})` : ''}`);
      d.hub.emit(w, 'spells-char', { accountId: aid }, gmAnd(aid));
      changed(w, aid);
    }
    res.json({ on: true, now: out.now, max: out.max });
  });

  // House rule: re-roll tokens. The GM gives or takes back; a player spends their own.
  r.post('/:aid/rerolls', requirePlayerOrGM, (req, res) => {
    const aid = who(res, req.params.aid);
    const w = W(res);
    const note = String(req.body?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const out = tx(db, () => changeReroll(db, settings(res), w, aid, req.body?.kind, req.body?.delta, me(res), isGM(res), note));
    changed(w, aid);
    res.json({ ...out, rerolls: rerollsOf(db, settings(res), w, aid) });
  });

  return r;
}

const feature: Feature = {
  id: 'sheet',
  schema: `
    CREATE TABLE IF NOT EXISTS sheets (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      hp INTEGER,
      max_hp INTEGER,
      temp_hp INTEGER NOT NULL DEFAULT 0,
      conditions TEXT NOT NULL DEFAULT '[]',
      modules TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (world_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS sheet_log (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      before INTEGER,
      after INTEGER,
      amount INTEGER,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      by_id TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sheet_log_world ON sheet_log (world_id, account_id, at);
    CREATE TABLE IF NOT EXISTS sheet_gm_notes (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('note', 'goal')),
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sheet_gm_notes_player ON sheet_gm_notes (world_id, account_id);
    ${REROLL_SCHEMA}
  `,
  settings: {
    sheetRerolls: { type: 'boolean', default: false },
    sheetRerollCap: { type: 'int', default: 3, min: 1, max: 20 },
  },
  worldMount: 'sheet',
  worldRoutes: routes,
  mcpTools: [
    {
      name: 'party_status', gmOnly: true,
      description: "Every player character's HP, max HP, temporary HP, conditions and mana (the GM's status bar).",
      props: {}, call: () => ({ method: 'GET', path: '/sheet/party' }),
    },
    {
      name: 'change_player_hp', write: true,
      description: "Change a player character's HP on their sheet (also the combat tracker if they are in it): damage, heal, set hp or maxHp, temporary HP, or the list of conditions. Logged.",
      props: {
        accountId: { type: 'string', description: 'The player: account id (from party_status) or character name' },
        damage: { type: 'integer', minimum: 0 }, heal: { type: 'integer', minimum: 0 }, hp: { type: 'integer' }, maxHp: { type: 'integer', minimum: 0 },
        tempHp: { type: 'integer', minimum: 0, description: 'Temporary HP gained (the higher amount stays)' },
        conditions: { type: 'array', items: { type: 'string' }, description: 'The whole new list of conditions' },
        note: { type: 'string', description: 'Why, for the log' },
      },
      required: ['accountId'],
      call: ({ accountId, ...rest }) => ({ method: 'POST', path: `/sheet/${encodeURIComponent(String(accountId))}/vitals`, body: rest }),
    },
    {
      name: 'give_reroll', write: true,
      description: "House rule (when the world uses re-rolls): give a player a re-roll token as a reward for good role play, or take one back with a negative delta. Kinds: personal (re-roll their own roll), party (re-roll anyone's roll), gm (make the GM re-roll). Logged.",
      props: {
        accountId: { type: 'string', description: 'The player: account id (from party_status) or character name' },
        kind: { type: 'string', enum: ['personal', 'party', 'gm'] },
        delta: { type: 'integer', description: 'How many to give (negative takes back)', default: 1 },
        note: { type: 'string', description: 'Why, for the log (the role play it rewards)' },
      },
      required: ['accountId', 'kind'],
      call: ({ accountId, delta, ...rest }) => ({ method: 'POST', path: `/sheet/${encodeURIComponent(String(accountId))}/rerolls`, body: { delta: delta ?? 1, ...rest } }),
    },
  ],
};
export default feature;
