// House rules: Alexandria's mods. A house rule is a mod file (format.ts) that
// adds counters, actions, chat words and rule text, or switches a whole
// system on through presets (spell points, MANA, spell crafting). The DM turns
// rules on under World settings → House rules; players use them from their
// sheet and session chat; the assistant can explain, grant, spend and draft
// them. See docs/MODS.md.
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { all, one, run, tx, type DB } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import { DEFAULT_SETTINGS, settingsFor, type Role } from '../../core/policy.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { ctx, isDM, me, names } from '../../routes/_shared.ts';
import { addTermSource, enabledIds as gameModuleIds } from '../modules/store.ts';
import { shippedMods, targetInfo } from './catalog.ts';
import { exampleFiles, guideText, previewMod } from './guide.ts';
import { keepDraft, takeDraft } from './drafts.ts';
import { satisfies } from './semver.ts';
import { canRead, type Channel } from '../sessionchat/chat.ts';
import { SCHEMA as RECORDS_SCHEMA, answerPrompt, closePrompt, listRecords, openPrompt, openRounds, readRecordLog, recordAct, runTimers, type Rec, type Said } from './recstore.ts';
import { addCommandResolver, latestRoll, postChat, rollMessage } from '../sessionchat/hooks.ts';
import type { Feature } from '../types.ts';
import { VERSION } from '../../version.ts';
import { MAX_PACKAGE, MOD_API, PERMISSIONS, commandActions, impliedPermissions, toFile, makePackage, presetValues, unpack, val, type Action, type ModFile } from './format.ts';
import {
  MAX_OWN, SCHEMA, act, tx as storeTx, counters, enabledMods, getMod, getModRaw, importMod, listMods, roomFor, planAct, playerIds, readLog, removeMod, runTriggers, setEnabled, setOptions,
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
    kit: mod.kit, targets: m.targets, requires: mod.requires.mods, conflicts: mod.conflicts,
    system: mod.system.records.length ? {
      records: mod.system.records.map((k) => ({ id: k.id, label: k.label, plural: k.plural, owned: k.owned, title: k.title, fields: k.fields })),
      recordActions: mod.system.recordActions.map((a) => ({ id: a.id, label: a.label, by: a.by, record: a.record, do: a.do, ask: a.ask, field: a.field ?? null, amount: a.amount ?? null, where: a.where })),
      prompts: mod.system.prompts, views: mod.system.views,
    } : null,
    ...(dm ? { presets: presetValues(mod, m.options), missing: m.missing, waiting: m.waiting, needs: m.needs, alexandria: mod.alexandria || null, api: mod.api, permissions: impliedPermissions(mod).map((k) => PERMISSIONS[k]) } : {}),
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
    // Data systems: timers on rests and sessions.
    for (const m of enabledMods(db, worldId)) {
      if (!m.mod.system.timers.some((t) => t.on === when)) continue;
      const out = runTimers(db, worldId, m, when, nameFn(worldId));
      if (out.players.length) { changedRecords(worldId, m.mod.id); say(worldId, null, out.said, m.mod.id); }
    }
  });

  // ---- data systems (kit 2): records, record actions, prompts ----

  const nameFn = (w: string) => { const nm = names(db, w); return (aid: string | null) => (aid ? nm[aid] ?? 'someone' : 'everyone'); };
  const changedRecords = (w: string, modId: string) => d.hub.emit(w, 'mods-records', { mod: modId }, () => true);
  /** Post what a change says: chat lines to the table (as the actor, or the DM), DM notes to the DM. */
  const say = (w: string, who: Actor | null, said: Said, modId: string) => {
    const author = who ?? (() => { const dm = one<any>(db, "SELECT account_id FROM members WHERE world_id = ? AND role = 'dm' ORDER BY rowid LIMIT 1", w); return dm ? { accountId: dm.account_id as string, role: 'dm' as Role } : null; })();
    for (const line of said.chat) if (author && line.trim()) { try { postChat(d, w, 'table', author.accountId, author.role, line); } catch { /* no session running: the log has it */ } }
    for (const line of said.dmnote) if (line.trim()) d.hub.emit(w, 'mods-note', { mod: modId, text: line }, (v) => v.role === 'dm');
  };
  /** A record as a viewer may see it: the DM all, a player shared records and their own. */
  const canSee = (res: Response, rec: Rec) => isDM(res) || rec.player === null || rec.player === me(res);
  const liveMod = (res: Response, idParam: string) => {
    const m = getModRaw(db, W(res), idParam);
    if (!m.enabled && !isDM(res)) throw new HttpError(404, `No house rule ${idParam.slice(0, 60)}`);
    return m;
  };

  r.get('/:id/records', requirePlayerOrDM, (req, res) => {
    const m = liveMod(res, String(req.params.id));
    const kinds = req.query.kind ? [String(req.query.kind)] : m.mod.system.records.map((k) => k.id);
    const player = typeof req.query.player === 'string' && req.query.player ? req.query.player : undefined;
    const out: Record<string, Rec[]> = {};
    for (const k of kinds) out[k] = listRecords(db, W(res), m, k, { player }).filter((x) => canSee(res, x));
    res.json({ records: out });
  });

  r.get('/:id/records-log', requirePlayerOrDM, (req, res) => {
    const m = liveMod(res, String(req.params.id));
    const lines = readRecordLog(db, W(res), { modId: m.mod.id, recordId: typeof req.query.record === 'string' ? req.query.record : undefined, player: isDM(res) ? (typeof req.query.player === 'string' ? req.query.player : undefined) : me(res), limit: Number(req.query.limit) || 100 });
    res.json({ log: lines });
  });

  r.post('/:id/records/:action', requirePlayerOrDM, (req, res) => {
    const w = W(res);
    const m = liveMod(res, String(req.params.id));
    const b = req.body ?? {};
    const who = actor(res);
    const player = b.player === undefined ? undefined : findPlayer(db, w, b.player);
    const out = tx(db, () => recordAct(db, w, m, String(req.params.action), who, { recordId: typeof b.recordId === 'string' ? b.recordId : undefined, player, values: b.values, amount: b.amount, note: typeof b.note === 'string' ? b.note.slice(0, 300) : '' }, nameFn(w)));
    audit(db, w, me(res), 'mods.record', `${m.mod.id}:${out.action}:${out.record.id}`);
    say(w, who, out.said, m.mod.id);
    changedRecords(w, m.mod.id);
    res.status(out.before === null ? 201 : 200).json(out);
  });

  // The DM opens a prompt: every player gets its choices.
  r.post('/:id/prompts/:prompt', requireDM, (req, res) => {
    const w = W(res);
    const m = getModRaw(db, w, String(req.params.id));
    const round = openPrompt(db, w, m, String(req.params.prompt), me(res));
    audit(db, w, me(res), 'mods.prompt', `${m.mod.id}:${round.prompt}`);
    d.hub.emit(w, 'mods-prompt', { mod: m.mod.id, round: round.id }, () => true);
    res.status(201).json(round);
  });

  r.get('/prompts/open', requirePlayerOrDM, (_req, res) => {
    const w = W(res);
    const rounds = openRounds(db, w).filter((x) => { try { return getModRaw(db, w, x.modId).enabled; } catch { return false; } });
    res.json({ rounds: rounds.map((x) => (isDM(res) ? x : { ...x, answers: x.answers[me(res)] ? { [me(res)]: x.answers[me(res)] } : {} })) });
  });

  r.post('/:id/prompts/round/:round/answer', requirePlayerOrDM, (req, res) => {
    const w = W(res);
    const m = liveMod(res, String(req.params.id));
    const b = req.body ?? {};
    const who = actor(res);
    const out = tx(db, () => answerPrompt(db, w, m, String(req.params.round), who, Number(b.choice), { recordId: typeof b.recordId === 'string' ? b.recordId : undefined, values: b.values, note: typeof b.note === 'string' ? b.note.slice(0, 300) : '' }, nameFn(w)));
    say(w, who, out.said, m.mod.id);
    changedRecords(w, m.mod.id);
    d.hub.emit(w, 'mods-prompt', { mod: m.mod.id, round: out.round.id }, (v) => v.role === 'dm' || v.accountId === who.accountId);
    res.json(out);
  });

  r.post('/:id/prompts/round/:round/close', requireDM, (req, res) => {
    const w = W(res);
    const round = closePrompt(db, w, String(req.params.round));
    d.hub.emit(w, 'mods-prompt', { mod: round.modId, round: round.id }, () => true);
    res.json(round);
  });

  r.get('/', (_req, res) => {
    const dm = isDM(res);
    res.json({ mods: listMods(db, W(res)).filter((m) => dm || m.enabled).map((m) => view(m, dm)) });
  });

  r.get('/rules', (_req, res) => {
    res.json({ rules: enabledMods(db, W(res)).flatMap((m) => m.mod.rules.map((x) => ({ mod: m.mod.id, name: m.mod.name, ...x }))) });
  });

  // ---- the Mod studio: what the assistant reads to write a rule ----

  const exampleIds = () => [...new Set([...exampleFiles().keys(), ...shippedMods().filter((s) => s.mod.scope !== 'server').map((s) => s.mod.id)])];
  r.get('/guide', requireDM, (req, res) => {
    const part = typeof req.query.part === 'string' ? req.query.part : undefined;
    res.json({ part: part ?? 'start', text: guideText(part, DEFAULT_SETTINGS as any, exampleIds()) });
  });

  // A rule as a file, to read, copy or change: the world's own and built-in rules, or an example from mods/examples.
  r.get('/:id/file', requireDM, (req, res) => {
    const id = String(req.params.id);
    const have = listMods(db, W(res)).find((m) => m.mod.id === id);
    if (have) { res.json({ id, source: have.source, enabled: have.enabled, file: toFile(have.mod), note: have.source === 'shipped' ? 'This rule comes with Alexandria: to change it, save a copy under a new id and name.' : 'Keep the id and raise the version to replace it.' }); return; }
    const ex = exampleFiles().get(id);
    if (ex) { res.json({ id, source: 'example', enabled: false, file: ex, note: 'An example to copy: give yours its own id if you change it.' }); return; }
    throw new HttpError(404, `No house rule or example ${id.slice(0, 40)}; examples: ${exampleIds().join(', ')}`);
  });

  // ---- the DM: check, import, export, turn on and off, options, remove ----

  r.post('/check', requireDM, (req, res) => {
    const { mods, errors, info } = unpack(req.body?.mod);
    if (!mods.length) { res.json({ ok: false, errors }); return; }
    const notes: string[] = [];
    const have = listMods(db, W(res));
    let games: string[] = [];
    try { games = gameModuleIds(db, W(res)); } catch { /* none */ }
    for (const mod of mods) {
      const at = mods.length > 1 ? `${mod.id}: ` : '';
      for (const k of Object.keys(mod.presets)) if (!(k in DEFAULT_SETTINGS)) notes.push(`${at}presets.${k} is not a setting of this Alexandria yet; it is skipped until it exists`);
      for (const k of mod.requires.settings) if (!(k in DEFAULT_SETTINGS)) notes.push(`${at}requires ${k}, which this Alexandria does not have: the rule cannot be turned on here yet`);
      if (mod.alexandria && !satisfies(VERSION, mod.alexandria)) notes.push(`${at}built for Alexandria ${mod.alexandria}; this server runs ${VERSION}, so it cannot be turned on here`);
      if (mod.api > MOD_API) notes.push(`${at}needs mod API ${mod.api}; this Alexandria offers ${MOD_API}`);
      for (const t of mod.targets.builtFor.map((x) => targetInfo(x, games))) if (!t.ok) notes.push(`${at}built for ${t.label}, which this world does not have: it cannot be turned on here`);
      for (const [rid, range] of Object.entries(mod.requires.mods)) {
        const r = have.find((m) => m.mod.id === rid)?.mod ?? mods.find((m) => m.id === rid);
        if (!r) notes.push(`${at}needs the house rule ${rid}, which this world does not have yet: add it too`);
        else if (!satisfies(r.version, range)) notes.push(`${at}needs ${r.name} ${range}, but the one here is ${r.version}`);
      }
      const taken = have.find((m) => m.mod.id === mod.id);
      if (taken) notes.push(taken.source === 'shipped' ? `${at}the id ${mod.id} belongs to a rule that comes with Alexandria: pick another id` : `${at}saving replaces the world's rule ${mod.id} (counters of kept resources stay)`);
    }
    res.json({ ok: true, errors: [], notes, draft: keepDraft(W(res), mods), preview: mods.length === 1 ? previewMod(mods[0]) : mods.map((m) => ({ id: m.id, lines: previewMod(m) })), mod: toFile(mods[0]), mods: mods.map(toFile), package: info });
  });

  r.post('/import', requireDM, (req, res) => {
    const draft = typeof req.body?.draft === 'string' && req.body.mod === undefined ? takeDraft(W(res), req.body.draft) : null;
    if (typeof req.body?.draft === 'string' && req.body.mod === undefined && !draft) throw new HttpError(404, `No checked draft ${req.body.draft.slice(0, 60)} (drafts last an hour): check the file again with house_rule_check`);
    const { mods, errors } = draft ? { mods: draft, errors: [] as string[] } : unpack(req.body?.mod);
    if (!mods.length) throw new HttpError(400, `This house rule has problems: ${errors.join('; ')}`);
    const shipped = mods.filter((m) => listMods(db, W(res)).some((x) => x.mod.id === m.id && x.source === 'shipped'));
    if (shipped.length) throw new HttpError(409, `${shipped.map((m) => m.id).join(', ')} ${shipped.length > 1 ? 'are ids' : 'is the id'} of a house rule that comes with Alexandria; give yours another id`);
    // A package goes in whole or not at all: room for every new rule first.
    const fresh = mods.filter((m) => !listMods(db, W(res)).some((x) => x.mod.id === m.id)).length;
    if (fresh > roomFor(db, W(res))) throw new HttpError(409, `A world holds at most ${MAX_OWN} imported house rules: this adds ${fresh} and there is room for ${Math.max(0, roomFor(db, W(res)))}`);
    const out = storeTx(db, () => mods.map((m) => importMod(db, W(res), toFile(m), me(res))));
    for (const o of out) audit(db, W(res), me(res), o.updated ? 'mods.update' : 'mods.import', o.mod.id);
    changedList(W(res));
    const views = out.map((o) => view(getMod(db, W(res), o.mod.id), true));
    // One rule: the rule itself (as before); a package: every rule it added.
    res.status(out.some((o) => !o.updated) ? 201 : 200).json(views.length === 1 ? views[0] : { rules: views });
  });

  // A package to share: the rules named in ?ids= (comma-separated), else every rule that is on.
  r.get('/export', requireDM, (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const mods = ids.length ? ids.slice(0, MAX_PACKAGE).map((id) => getMod(db, W(res), id).mod) : enabledMods(db, W(res)).map((m) => m.mod).slice(0, MAX_PACKAGE);
    if (!mods.length) throw new HttpError(400, 'No house rule to export: turn one on or name it');
    res.setHeader('Content-Disposition', `attachment; filename="${mods.length === 1 ? mods[0].id : 'house-rules'}.alxmod.json"`);
    res.json(makePackage(mods, { alexandria: VERSION }));
  });

  r.get('/:id/export', requireDM, (req, res) => {
    const m = getMod(db, W(res), String(req.params.id));
    res.setHeader('Content-Disposition', `attachment; filename="${m.mod.id}.alxmod.json"`);
    res.json(makePackage([m.mod], { alexandria: VERSION }));
  });

  r.put('/:id/enabled', requireDM, (req, res) => {
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'on must be true or false');
    const id = String(req.params.id);
    const out = setEnabled(db, W(res), id, req.body.on, me(res), { cascade: req.body.cascade === true });
    audit(db, W(res), me(res), req.body.on ? 'mods.on' : 'mods.off', [id, ...out.turnedOn.map((x) => `+${x}`), ...out.turnedOff.map((x) => `-${x}`)].join(','));
    changedList(W(res));
    if (out.settingsChanged) changedSettings(W(res));
    res.json({ ...view(getMod(db, W(res), id), true), turnedOff: out.turnedOff, turnedOn: out.turnedOn });
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
    const m = getModRaw(db, w, String(req.params.id));
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
  schema: SCHEMA + RECORDS_SCHEMA,
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
      name: 'house_rule_records',
      description: "A house rule's own lists (a data system such as downtime: its activities, each player's tasks and how far along they are). The DM sees every record; a player sees shared ones and their own. Use house_rules first to see each rule's record kinds and actions.",
      props: { mod: { type: 'string', description: 'The rule id, e.g. downtime' }, kind: { type: 'string', description: 'A record kind of the rule, e.g. task (default: all)' }, player: { type: 'string', description: 'DM: only this player\'s (account id)' } },
      required: ['mod'],
      call: (a) => ({ method: 'GET', path: `/mods/${enc(a.mod)}/records?${new URLSearchParams(Object.entries({ kind: a.kind, player: a.player }).filter(([, v]) => v) as [string, string][]).toString()}` }),
    },
    {
      name: 'house_rule_record_act', write: true, dmOnly: true,
      description: "DM: run one of a house rule's record actions: create a record (values for the fields it asks), change one (recordId), add to a number (amount, negative takes away, e.g. days of downtime lost) or remove one. Logged with the note. For a player's own record, pass player when creating.",
      props: {
        mod: { type: 'string' }, action: { type: 'string', description: 'The record action id' }, recordId: { type: 'string' },
        player: { type: 'string', description: 'Whose (account id or name), for a record a player owns' }, values: { type: 'object', description: 'Field values the action asks for' },
        amount: { type: 'number', description: 'For an add action that asks how much' }, note: { type: 'string' },
      },
      required: ['mod', 'action'],
      call: (a) => ({ method: 'POST', path: `/mods/${enc(a.mod)}/records/${enc(a.action)}`, body: { recordId: a.recordId, player: a.player, values: a.values, amount: a.amount, note: a.note } }),
    },
    {
      name: 'house_rule_prompt', write: true, dmOnly: true,
      description: "DM: open one of a house rule's prompts, e.g. a downtime day: every player gets its choices (keep working, start something, skip) and their answers move their records.",
      props: { mod: { type: 'string' }, prompt: { type: 'string', description: 'The prompt id' } },
      required: ['mod', 'prompt'],
      call: (a) => ({ method: 'POST', path: `/mods/${enc(a.mod)}/prompts/${enc(a.prompt)}`, body: {} }),
    },
    {
      name: 'house_rule_my_record', playerOnly: true,
      description: "Run one of a house rule's record actions on your own records (start a downtime activity, keep working, drop it) or make a shared one (a new activity), when the rule lets a player do it.",
      props: { mod: { type: 'string' }, action: { type: 'string' }, recordId: { type: 'string' }, values: { type: 'object' }, note: { type: 'string' } },
      required: ['mod', 'action'],
      call: (a) => ({ method: 'POST', path: `/mods/${enc(a.mod)}/records/${enc(a.action)}`, body: { recordId: a.recordId, values: a.values, note: a.note } }),
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
      name: 'house_rule_guide', dmOnly: true,
      description: 'How to write a house rule file (a mod): read it before making or changing one. Part start (default) says which kind fits and how to work; counters (points and tokens), data (lists, tasks, progress, a popup for each player such as downtime), presets (switch on spell points, MANA and other systems with world settings), manifest (targets, requires, conflicts) and assistant (how the DM assistant and the player helper help with the rule) give every field.',
      props: { part: { type: 'string', enum: ['start', 'counters', 'data', 'presets', 'manifest', 'assistant'], description: 'Which part (default start)' } },
      call: (a) => ({ method: 'GET', path: `/mods/guide${a.part ? `?part=${enc(a.part)}` : ''}` }),
    },
    {
      name: 'house_rule_file', dmOnly: true,
      description: "A house rule as its file: one of the world's rules (to change it), one that comes with Alexandria, or an example to copy (hero-points, downtime-lite). Read a close one before writing a new rule.",
      props: { mod: { type: 'string', description: 'The rule or example id' } }, required: ['mod'],
      call: (a) => ({ method: 'GET', path: `/mods/${enc(a.mod)}/file` }),
    },
    {
      name: 'house_rule_check', dmOnly: true,
      description: 'Check a draft house rule (mod file JSON, see house_rule_guide) without saving it. Returns plain errors to fix, notes, a preview (what the rule does, in plain words, to tell the DM), the cleaned file and a draft id. Use it until ok is true, then tell the DM the preview and save with house_rule_save { draft } once they agree.',
      props: { mod: { type: 'object', description: 'The mod file, or a package of several' } }, required: ['mod'],
      call: (a) => ({ method: 'POST', path: '/mods/check', body: { mod: a.mod } }),
    },
    {
      name: 'house_rule_save', write: true, dmOnly: true,
      description: "Save a checked house rule to the world (it starts off; the DM turns it on under House rules → Rules). Pass draft, the id house_rule_check gave, so exactly the checked file is saved; or the whole mod. Saving a rule with an existing id replaces it and keeps its counters. One rule or a package (several).",
      props: { draft: { type: 'string', description: 'The draft id from house_rule_check (preferred)' }, mod: { type: 'object', description: 'The mod file, or a package of several, when there is no draft' } },
      call: (a) => ({ method: 'POST', path: '/mods/import', body: a.draft ? { draft: a.draft } : { mod: a.mod } }),
    },
  ],
};
export default feature;

export type { ModFile };
