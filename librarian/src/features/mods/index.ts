// House rules: Alexandria's mods. A house rule is a mod file (format.ts) that
// adds counters, actions, chat words and rule text, or switches a whole
// system on through presets (spell points, MANA, spell crafting). The DM turns
// rules on under World settings → House rules; players use them from their
// sheet and session chat; the assistant can explain, grant, spend and draft
// them. See docs/MODS.md.
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { all, one, run, type DB } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import { DEFAULT_SETTINGS, settingsFor, type Role } from '../../core/policy.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { ctx, isDM, me, names } from '../../routes/_shared.ts';
import { addTermSource } from '../modules/store.ts';
import { canRead, type Channel } from '../sessionchat/chat.ts';
import { addCommandResolver, latestRoll, postChat, rollMessage } from '../sessionchat/hooks.ts';
import type { Feature } from '../types.ts';
import { checkMod, commandActions, presetValues, val, type Action, type ModFile } from './format.ts';
import {
  SCHEMA, act, counters, enabledMods, getMod, importMod, listMods, planAct, playerIds, readLog, removeMod, runTriggers, setEnabled, setOptions,
  type Actor, type Installed,
} from './store.ts';

const audit = (db: DB, worldId: string, accountId: string, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const worldSettings = (db: DB, worldId: string) => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {}) });

/** A rule as the app shows it. Players see only rules that are on, without the settings they switch. */
function view(m: Installed, dm: boolean) {
  const mod = m.mod;
  return {
    id: mod.id, name: mod.name, summary: mod.summary, version: mod.version, author: mod.author, group: mod.group || null,
    source: m.source, feature: m.feature ?? null, enabled: m.enabled, options: m.options, optionSpecs: mod.options,
    resources: mod.resources.map((r) => ({ id: r.id, label: r.label, icon: r.icon, private: r.private })),
    actions: mod.actions.map((a) => ({ id: a.id, label: a.label, by: a.by, resource: a.resource, askReason: a.askReason, reroll: a.effect?.reroll?.whose ?? null })),
    commands: commandActions(mod).map((c) => `/${c.word}${c.arg ? ` ${c.arg}` : ''}`),
    sheet: mod.sheet, dmBand: mod.dmBand, table: mod.table, rules: mod.rules,
    ...(dm ? { presets: presetValues(mod, m.options), missing: m.missing, waiting: m.waiting } : {}),
  };
}

/** A player by account id, character name or display name. */
function findPlayer(db: DB, worldId: string, who: unknown): string {
  const s = typeof who === 'string' ? who.trim() : '';
  if (!s) throw new HttpError(400, 'Say which player');
  const rows = all<any>(db, "SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId);
  const hit = rows.find((r) => r.id === s) ?? rows.find((r) => (r.character_name ?? '').toLowerCase() === s.toLowerCase()) ?? rows.find((r) => r.display_name.toLowerCase() === s.toLowerCase());
  if (!hit) throw new HttpError(404, `No player called ${s.slice(0, 60)} in this world`);
  return hit.id;
}

const label = (m: Installed, rid: string) => m.mod.resources.find((r) => r.id === rid)?.label ?? rid;

/** The roll a reroll effect applies to: the one named, or the latest that fits in the channel. */
function rerollTarget(db: DB, worldId: string, a: Action, actor: Actor, owner: string, rollId: string | null, channel: Channel) {
  const whose = a.effect!.reroll!.whose;
  const fits = (author: string, role: Role) => (whose === 'own' ? author === owner : whose === 'anyPlayer' ? role === 'player' : role === 'dm');
  const want = whose === 'own' ? 'one of your own rolls' : whose === 'anyPlayer' ? 'a player\'s roll' : 'one of the DM\'s rolls';
  if (rollId) {
    const r = rollMessage(db, worldId, rollId);
    if (!r || !canRead(actor, r.row.channel)) throw new HttpError(404, 'That roll is not in this chat');
    if (one(db, 'SELECT 1 FROM sessionchat_sessions WHERE id = ? AND ended_at IS NOT NULL', r.row.session_id)) throw new HttpError(409, 'That roll is from a session that has ended');
    if (!fits(r.row.author_id, r.authorRole)) throw new HttpError(409, `This reroll works on ${want}`);
    return r.row;
  }
  const row = latestRoll(db, worldId, channel, fits);
  if (!row) throw new HttpError(409, `There is no roll to reroll: it works on ${want} in this session's chat`);
  return row;
}

function rerollBody(db: DB, worldId: string, m: Installed, rid: string, row: any): string {
  const roll = parseJson<any>(row.roll, null);
  if (!roll?.expr) throw new HttpError(409, 'That roll cannot be rolled again');
  const who = names(db, worldId)[row.author_id] ?? 'someone';
  return `/roll ${roll.expr} ${roll.note ? `${roll.note} · ` : ''}reroll of ${who}'s ${roll.total} (${label(m, rid)})`.slice(0, 400);
}

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  const actor = (res: Response): Actor => ({ accountId: me(res), role: ctx(res).viewer.role });

  const changedList = (w: string) => d.hub.emit(w, 'mods', {}, () => true);
  const changedSettings = (w: string) => { const s = worldSettings(db, w); d.hub.emitPer(w, 'settings', (v) => settingsFor(s, v.role)); };
  const changedCounts = (w: string, aid: string) => d.hub.emit(w, 'mods-counts', { accountId: aid }, (v) => v.role === 'dm' || v.accountId === aid);

  // Rests on the world clock and session start/end run the rules' triggers (server-only events).
  d.hub.tap((worldId, type, data: any) => {
    const when = type === 'rest' ? (data?.kind === 'long' ? 'longRest' : data?.kind === 'short' ? 'shortRest' : null) : type === 'session-start' ? 'sessionStart' : type === 'session-end' ? 'sessionEnd' : null;
    if (!when) return;
    for (const aid of runTriggers(db, worldId, when)) changedCounts(worldId, aid);
  });

  r.get('/', (_req, res) => {
    const dm = isDM(res);
    res.json({ mods: listMods(db, W(res)).filter((m) => dm || m.enabled).map((m) => view(m, dm)) });
  });

  r.get('/rules', (_req, res) => {
    res.json({ rules: enabledMods(db, W(res)).flatMap((m) => m.mod.rules.map((x) => ({ mod: m.mod.id, name: m.mod.name, ...x }))) });
  });

  // ---- the DM: check, import, export, turn on and off, options, remove ----

  r.post('/check', requireDM, (req, res) => {
    const { mod, errors } = checkMod(req.body?.mod);
    if (!mod) { res.json({ ok: false, errors }); return; }
    const notes: string[] = [];
    for (const k of Object.keys(mod.presets)) if (!(k in DEFAULT_SETTINGS)) notes.push(`presets.${k} is not a setting of this Alexandria yet; it is skipped until it exists`);
    for (const k of mod.requires.settings) if (!(k in DEFAULT_SETTINGS)) notes.push(`requires ${k}, which this Alexandria does not have: the rule cannot be turned on here yet`);
    const taken = listMods(db, W(res)).find((m) => m.mod.id === mod.id);
    if (taken) notes.push(taken.source === 'shipped' ? `the id ${mod.id} belongs to a rule that comes with Alexandria: pick another id` : `saving replaces the world's rule ${mod.id} (counters of kept resources stay)`);
    res.json({ ok: true, errors: [], notes, mod });
  });

  r.post('/import', requireDM, (req, res) => {
    const out = importMod(db, W(res), req.body?.mod, me(res));
    audit(db, W(res), me(res), out.updated ? 'mods.update' : 'mods.import', out.mod.id);
    changedList(W(res));
    res.status(out.updated ? 200 : 201).json(view(getMod(db, W(res), out.mod.id), true));
  });

  r.get('/:id/export', requireDM, (req, res) => {
    const m = getMod(db, W(res), String(req.params.id));
    res.setHeader('Content-Disposition', `attachment; filename="${m.mod.id}.alxmod.json"`);
    res.json(m.mod);
  });

  r.put('/:id/enabled', requireDM, (req, res) => {
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
    const id = String(req.params.id);
    const out = setEnabled(db, W(res), id, req.body.on, me(res));
    audit(db, W(res), me(res), req.body.on ? 'mods.on' : 'mods.off', [id, ...out.turnedOff.map((x) => `-${x}`)].join(','));
    changedList(W(res));
    if (out.settingsChanged) changedSettings(W(res));
    res.json({ ...view(getMod(db, W(res), id), true), turnedOff: out.turnedOff });
  });

  r.put('/:id/options', requireDM, (req, res) => {
    const id = String(req.params.id);
    const out = setOptions(db, W(res), id, req.body?.options, me(res));
    audit(db, W(res), me(res), 'mods.options', id);
    changedList(W(res));
    if (out.settingsChanged) changedSettings(W(res));
    res.json(view(getMod(db, W(res), id), true));
  });

  r.delete('/:id', requireDM, (req, res) => {
    const id = String(req.params.id);
    const was = getMod(db, W(res), id).enabled;
    removeMod(db, W(res), id, me(res));
    audit(db, W(res), me(res), 'mods.remove', id);
    changedList(W(res));
    if (was) changedSettings(W(res));
    res.json({ ok: true });
  });

  // ---- counters and the log ----

  r.get('/counters', (req, res) => {
    const w = W(res);
    const dm = isDM(res);
    const nm = names(db, w);
    const ids = dm ? playerIds(db, w) : [me(res)];
    const mods = enabledMods(db, w).filter((m) => m.mod.resources.length);
    res.json({
      players: ids.map((aid) => ({ accountId: aid, name: nm[aid] ?? '', mods: Object.fromEntries(mods.map((m) => [m.mod.id, counters(db, w, m, aid)])) })),
    });
  });

  r.get('/log', (req, res) => {
    const w = W(res);
    const q = req.query;
    const accountId = isDM(res) ? (typeof q.accountId === 'string' && q.accountId ? q.accountId : undefined) : me(res);
    res.json({ log: readLog(db, w, { accountId, modId: typeof q.mod === 'string' && q.mod ? q.mod : undefined, limit: Number(q.limit) || 50 }) });
  });

  /**
   * Run an action: { action, player? (id or name; default: me), resource? (for a '*' action), note?, rollId?, channel?, atTable? }.
   * A reroll rerolls the roll named (or the latest that fits) on the server and posts it under the old one; atTable: true
   * spends the token for a roll made with real dice.
   */
  r.post('/:id/act', requirePlayerOrDM, (req, res) => {
    const w = W(res);
    const m = getMod(db, w, String(req.params.id));
    const b = req.body ?? {};
    const who = actor(res);
    const target = b.player === undefined && who.role === 'player' ? who.accountId : findPlayer(db, w, b.player);
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
    const p = planAct(db, w, m, String(b.action ?? ''), who, target, typeof b.resource === 'string' ? b.resource : null);
    const reroll = p.a.effect?.reroll;
    let roll: any = null;
    if (reroll && b.atTable !== true) {
      const channel: Channel = b.channel === 'party' ? 'party' : 'table';
      const row = rerollTarget(db, w, p.a, who, target, typeof b.rollId === 'string' ? b.rollId : null, channel);
      const body = rerollBody(db, w, m, p.r.id, row);
      const out = act(db, w, m, p.a.id, who, target, p.r.id, note || `reroll of ${row.id}`);
      const posted = postChat(d, w, row.channel, who.accountId, who.role, body, row.id);
      roll = { id: posted.id, total: parseJson<any>(posted.roll, null)?.total ?? null, was: parseJson<any>(row.roll, null)?.total ?? null };
      if (val(reroll.keepBetter, m.options) && roll.total !== null && roll.was !== null) {
        roll.kept = Math.max(roll.total, roll.was);
        postChat(d, w, row.channel, who.accountId, who.role, `Keeps the better roll: ${roll.kept}`, posted.id);
      }
      changedCounts(w, target);
      res.json({ ...out, roll });
      return;
    }
    const out = act(db, w, m, p.a.id, who, target, p.r.id, note || (reroll ? 'at the table' : ''));
    afterEffects(d, w, m, p.a, who, target, note);
    changedCounts(w, target);
    res.json(out);
  });

  return r;
}

/** The chat and DM-note effects of an action (rerolls are handled where the roll is known). */
function afterEffects(d: Deps, w: string, m: Installed, a: Action, who: Actor, target: string, note: string) {
  const e = a.effect;
  if (!e) return;
  const nm = names(d.db, w)[target] ?? 'someone';
  const fill = (s: string) => s.replace(/\{name\}/g, nm).replace(/\{note\}/g, note);
  if (e.chat) { try { postChat(d, w, 'table', who.accountId, who.role, fill(e.chat)); } catch { /* no session running: the log has it */ } }
  if (e.dmnote) d.hub.emit(w, 'mods-note', { mod: m.mod.id, text: fill(e.dmnote), accountId: target }, (v) => v.role === 'dm');
}

// ---- chat words ("/reroll personal") --------------------------------------------------------------------------------

addCommandResolver((d, call) => {
  const { db } = d;
  const mods = enabledMods(db, call.worldId);
  const hits = mods.flatMap((m) => commandActions(m.mod).filter((c) => c.word === call.word).map((c) => ({ m, c })));
  if (!hits.length) return null;
  const arg = call.args[0] ?? null;
  const hit = hits.find((h) => h.c.arg === arg) ?? (hits.length === 1 && hits[0].c.arg === null ? hits[0] : undefined);
  if (!hit) throw new HttpError(400, `Use ${hits.map((h) => `/${h.c.word}${h.c.arg ? ` ${h.c.arg}` : ''}`).join(', ')}`);
  const who: Actor = { accountId: call.viewer.accountId, role: call.viewer.role };
  const target = who.accountId;
  const p = planAct(db, call.worldId, hit.m, hit.c.action, who, target, null);
  const note = call.args.slice(hit.c.arg ? 1 : 0).join(' ').slice(0, 300);
  if (p.a.effect?.reroll) {
    const row = rerollTarget(db, call.worldId, p.a, who, target, call.replyTo, call.channel);
    const body = rerollBody(db, call.worldId, hit.m, p.r.id, row);
    act(db, call.worldId, hit.m, p.a.id, who, target, p.r.id, note || `reroll of ${row.id}`);
    d.hub.emit(call.worldId, 'mods-counts', { accountId: target }, (v) => v.role === 'dm' || v.accountId === target);
    return { body, replyTo: row.id };
  }
  const out = act(db, call.worldId, hit.m, p.a.id, who, target, p.r.id, note);
  d.hub.emit(call.worldId, 'mods-counts', { accountId: target }, (v) => v.role === 'dm' || v.accountId === target);
  return { body: `${p.a.label}: ${label(hit.m, p.r.id)} ${out.before} → ${out.after}${note ? ` (${note})` : ''}` };
});

// ---- rule text in the glossary (hover cards, rules lookups, the broker and the assistant) ----------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'rule';
addTermSource((db, worldId) => enabledMods(db, worldId).filter((m) => m.mod.rules.length).map((m) => ({
  moduleId: `house-${m.mod.id}`,
  moduleName: `House rule: ${m.mod.name}`,
  terms: m.mod.rules.map((x) => ({ id: slug(x.term), term: x.term, aliases: [], kind: 'rule' as const, summary: x.text.replace(/[*`_]/g, '').split(/(?<=\.)\s/)[0].slice(0, 200), text: x.text })),
})));

const enc = encodeURIComponent;

/**
 * Worlds that used the player sheet's re-roll switch before it became the inspiration house rule: the rule is turned
 * on with their cap, and the counts move over (kind "party" is the rule's "everyone"). Runs on every start; does
 * nothing once a world has a row for the rule.
 */
export function migrateSheetRerolls(db: DB) {
  const hasOld = !!one<any>(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sheet_rerolls'");
  for (const w of all<any>(db, 'SELECT id, settings FROM worlds')) {
    if (one(db, "SELECT 1 FROM mods WHERE world_id = ? AND id = 'inspiration-rerolls'", w.id)) continue;
    const s = parseJson<any>(w.settings, {});
    const counts = hasOld ? all<any>(db, 'SELECT account_id, kind, count FROM sheet_rerolls WHERE world_id = ?', w.id) : [];
    if (s.sheetRerolls !== true && !counts.length) continue;
    const cap = Number.isInteger(s.sheetRerollCap) ? Math.min(9, Math.max(1, s.sheetRerollCap)) : 3;
    run(db, `INSERT INTO mods (world_id, id, source, json, enabled, options, saved, updated_at, updated_by) VALUES (?, 'inspiration-rerolls', 'shipped', NULL, ?, ?, ?, ?, NULL)`,
      w.id, s.sheetRerolls === true ? 1 : 0, JSON.stringify({ cap }), JSON.stringify(s.sheetRerolls === true ? { sheetRerolls: false, sheetRerollCap: 3 } : {}), now());
    for (const c of counts) {
      const res = c.kind === 'party' ? 'everyone' : c.kind;
      run(db, 'INSERT OR IGNORE INTO mod_counts (world_id, mod_id, account_id, resource, value) VALUES (?, ?, ?, ?, ?)', w.id, 'inspiration-rerolls', c.account_id, res, c.count);
    }
  }
}

const feature: Feature = {
  id: 'mods',
  schema: SCHEMA,
  migrate: migrateSheetRerolls,
  worldMount: 'mods',
  worldRoutes: routes,
  mcpTools: [
    {
      name: 'house_rules', description: "The world's house rules (mods) that are on: what each does, its rule text, its counters (e.g. reroll tokens) and the actions and chat words it adds. The DM also sees rules that are off. Use it to explain a house rule or before granting or spending.",
      props: {}, call: () => ({ method: 'GET', path: '/mods' }),
    },
    {
      name: 'house_rule_counters', description: 'How many of each house rule counter (reroll tokens, hero points...) each player holds. A player sees their own.',
      props: {}, call: () => ({ method: 'GET', path: '/mods/counters' }),
    },
    {
      name: 'house_rule_grant', write: true, dmOnly: true,
      description: 'Run a DM action of a house rule on a player, usually Grant (e.g. give Mira a personal reroll for good roleplay). Always pass the reason as note: it is logged and shown to the player.',
      props: {
        mod: { type: 'string', description: 'House rule id, e.g. inspiration-rerolls' },
        player: { type: 'string', description: 'Player account id or character name' },
        action: { type: 'string', description: 'Action id (default grant)' },
        resource: { type: 'string', description: 'Which counter, e.g. personal, everyone or dm' },
        note: { type: 'string', description: 'Why (the roleplay being rewarded)' },
      },
      required: ['mod', 'player'],
      call: (a) => ({ method: 'POST', path: `/mods/${enc(a.mod)}/act`, body: { action: a.action ?? 'grant', player: a.player, resource: a.resource, note: a.note } }),
    },
    {
      name: 'house_rule_spend', playerOnly: true,
      description: "Spend one of your own house rule counters (e.g. a personal reroll). A reroll rerolls your latest roll in session chat on the server, or pass atTable: true for a roll made with real dice.",
      props: {
        mod: { type: 'string' }, action: { type: 'string', description: 'Action id, e.g. use-personal' },
        rollId: { type: 'string', description: 'The chat roll to reroll (default: the latest that fits)' },
        atTable: { type: 'boolean', description: 'The roll was made with real dice' }, note: { type: 'string' },
      },
      required: ['mod', 'action'],
      call: (a) => ({ method: 'POST', path: `/mods/${enc(a.mod)}/act`, body: { action: a.action, rollId: a.rollId, atTable: a.atTable, note: a.note } }),
    },
    {
      name: 'house_rule_check', dmOnly: true,
      description: 'Check a draft house rule (mod file JSON, see the House rules guide) without saving it. Returns plain errors to fix, notes and the cleaned file. Use it until ok is true, then show the DM and save with house_rule_save.',
      props: { mod: { type: 'object', description: 'The mod file' } }, required: ['mod'],
      call: (a) => ({ method: 'POST', path: '/mods/check', body: { mod: a.mod } }),
    },
    {
      name: 'house_rule_save', write: true, dmOnly: true,
      description: "Save a checked house rule to the world (it starts off; the DM turns it on under World settings → House rules). Saving a rule with an existing id replaces it and keeps its counters.",
      props: { mod: { type: 'object', description: 'The mod file' } }, required: ['mod'],
      call: (a) => ({ method: 'POST', path: '/mods/import', body: { mod: a.mod } }),
    },
  ],
};
export default feature;

export type { ModFile };
