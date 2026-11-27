// Data systems in a world (house rules kit 2): a rule's own records, the
// record actions that change them, timers, DM prompts and the log of every
// change. The checks are in system.ts; the routes and assistant tools in
// index.ts go through here.
import { type DB, all, one, run } from '../../core/db.ts';
import type { Role } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { val } from './format.ts';
import { fieldError, type RecordAction, type RecordKind, type Timer } from './system.ts';
import type { Installed } from './store.ts';

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mod_records (
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    mod_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    account_id TEXT,                  -- the player it belongs to (owned kinds)
    data TEXT NOT NULL DEFAULT '{}',
    removed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_by TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (world_id, mod_id, id)
  );
  CREATE INDEX IF NOT EXISTS mod_records_kind ON mod_records(world_id, mod_id, kind);
  CREATE TABLE IF NOT EXISTS mod_record_log (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    mod_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    account_id TEXT,
    action TEXT NOT NULL,             -- a record action id, timer:<id>, or seed
    by TEXT,
    before TEXT,
    after TEXT,
    note TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mod_record_log_world ON mod_record_log(world_id, mod_id, at);
  CREATE TABLE IF NOT EXISTS mod_prompts (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    mod_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    opened_by TEXT,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    answers TEXT NOT NULL DEFAULT '{}' -- account id → { choice, recordId?, at }
  );
`;

export interface Rec { id: string; kind: string; player: string | null; createdAt: string; updatedAt: string; removed: boolean; [field: string]: unknown }
export interface Actor { accountId: string; role: Role }
/** What a change says in chat or to the DM, for index.ts to post. */
export interface Said { chat: string[]; dmnote: string[] }

const toRec = (r: any): Rec => ({ ...parseJson(r.data, {}), id: r.id, kind: r.kind, player: r.account_id ?? null, createdAt: r.created_at, updatedAt: r.updated_at, removed: !!r.removed });
const kindOf = (m: Installed, kind: string): RecordKind => {
  const k = m.mod.system.records.find((x) => x.id === kind);
  if (!k) throw new HttpError(404, `${m.mod.name} keeps no ${String(kind).slice(0, 40)}`);
  return k;
};
const dataOf = (r: Rec) => Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'kind', 'player', 'createdAt', 'updatedAt', 'removed'].includes(k)));
const matches = (r: Rec, where: Record<string, unknown>, opts: Record<string, unknown>) => Object.entries(where).every(([k, v]) => r[k] === val(v as any, opts));

function log(db: DB, worldId: string, m: Installed, r: { id: string; kind: string; player: string | null }, action: string, by: string | null, before: unknown, after: unknown, note: string) {
  run(db, 'INSERT INTO mod_record_log (id, world_id, mod_id, kind, record_id, account_id, action, by, before, after, note, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id('mrl_'), worldId, m.mod.id, r.kind, r.id, r.player, action, by, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), note.slice(0, 300), now());
}

export function getRecord(db: DB, worldId: string, m: Installed, recordId: string): Rec {
  const r = one<any>(db, 'SELECT * FROM mod_records WHERE world_id = ? AND mod_id = ? AND id = ?', worldId, m.mod.id, recordId);
  if (!r) throw new HttpError(404, `No ${m.mod.name} record ${String(recordId).slice(0, 40)}`);
  return toRec(r);
}

export function listRecords(db: DB, worldId: string, m: Installed, kind: string, opts: { player?: string; where?: Record<string, unknown>; removed?: boolean; limit?: number } = {}): Rec[] {
  kindOf(m, kind);
  const args: unknown[] = [worldId, m.mod.id, kind];
  let sql = 'SELECT * FROM mod_records WHERE world_id = ? AND mod_id = ? AND kind = ?';
  if (!opts.removed) sql += ' AND removed = 0';
  if (opts.player) { sql += ' AND account_id = ?'; args.push(opts.player); }
  sql += ' ORDER BY created_at, rowid LIMIT ?';
  args.push(Math.min(1000, Math.max(1, opts.limit ?? 500)));
  return all<any>(db, sql, ...args).map(toRec).filter((r) => !opts.where || matches(r, opts.where, m.options));
}

/** The first time a rule is on in a world, its seed records are made (ready-made activities). Never again, so the DM's removals stay. */
export function seedRecords(db: DB, worldId: string, m: Installed) {
  for (const k of m.mod.system.records) {
    if (!k.seed.length) continue;
    if (one<any>(db, 'SELECT 1 FROM mod_records WHERE world_id = ? AND mod_id = ? AND kind = ? LIMIT 1', worldId, m.mod.id, k.id)) continue;
    for (const s of k.seed) {
      const data = withDefaults(k, s, m.options);
      const rid = id('rec_');
      run(db, 'INSERT INTO mod_records (world_id, mod_id, kind, id, account_id, data, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)', worldId, m.mod.id, k.id, rid, JSON.stringify(data), now(), now());
    }
  }
}

function withDefaults(k: RecordKind, data: Record<string, unknown>, opts: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [fid, f] of Object.entries(k.fields)) {
    const v = data[fid] !== undefined ? val(data[fid] as any, opts) : f.default;
    if (v !== undefined) out[fid] = v;
  }
  return out;
}

/** May `actor` run `a` (on `rec`, or creating one for `target`)? */
function may(a: RecordAction, actor: Actor, ownerOf: string | null): boolean {
  switch (a.by) {
    case 'dm': return actor.role === 'dm';
    case 'player': return actor.role === 'player';
    case 'owner': return actor.role === 'player' && (ownerOf === null || ownerOf === actor.accountId);
    case 'any': return actor.role === 'dm' || (actor.role === 'player' && (ownerOf === null || ownerOf === actor.accountId));
  }
}

export interface RecordActInput { recordId?: string; player?: string; values?: Record<string, unknown>; amount?: number; note?: string }
export interface RecordActResult { action: string; record: Rec; before: Record<string, unknown> | null; after: Record<string, unknown> | null; said: Said }

/** Run a record action. Checks who may, the fields asked for and `where`; logs the change; returns what to post. */
export function recordAct(db: DB, worldId: string, m: Installed, actionId: string, actor: Actor, input: RecordActInput, names: (accountId: string | null) => string): RecordActResult {
  if (!m.enabled) throw new HttpError(409, `${m.mod.name} is off in this world`);
  const a = m.mod.system.recordActions.find((x) => x.id === actionId);
  if (!a) throw new HttpError(404, `${m.mod.name} has no record action ${String(actionId).slice(0, 40)}`);
  const k = kindOf(m, a.record);
  const opts = m.options;
  const given = input.values && typeof input.values === 'object' ? input.values : {};
  for (const key of Object.keys(given)) if (!a.ask.includes(key)) throw new HttpError(400, `${a.label} does not take ${key.slice(0, 40)} (it asks for ${a.ask.join(', ') || 'nothing'})`);
  const asked: Record<string, unknown> = {};
  for (const f of a.ask) {
    const v = given[f];
    const e = fieldError(k.fields[f], v);
    if (e) throw new HttpError(400, `${k.fields[f].label || f} ${e}`);
    if (v !== undefined && v !== '') asked[f] = v;
    if (k.fields[f].type === 'ref' && v) {
      const ref = getRecord(db, worldId, m, String(v));
      if (ref.kind !== k.fields[f].ref || ref.removed) throw new HttpError(400, `${k.fields[f].label || f}: that is not a ${k.fields[f].ref}`);
    }
  }
  const fixed = Object.fromEntries(Object.entries(a.set).map(([f, v]) => [f, val(v as any, opts)]));
  const said: Said = { chat: [], dmnote: [] };

  if (a.do === 'create') {
    // Whose: an owned kind belongs to the player who runs it, or the player the DM names.
    let owner: string | null = null;
    if (k.owned) {
      owner = actor.role === 'dm' ? String(input.player ?? '') : actor.accountId;
      if (!owner || one<any>(db, "SELECT role FROM members WHERE world_id = ? AND account_id = ?", worldId, owner)?.role !== 'player') throw new HttpError(400, 'Say which player this is for');
    }
    if (!may(a, actor, owner)) throw new HttpError(403, a.by === 'dm' ? 'Only the DM can do that' : 'You cannot do that');
    const data: Record<string, unknown> = { ...asked, ...fixed };
    if (a.copy) {
      const refId = data[a.copy.via];
      if (refId) {
        const ref = getRecord(db, worldId, m, String(refId));
        for (const [mine, theirs] of Object.entries(a.copy.fields)) if (data[mine] === undefined) { const v = theirs.startsWith('$') ? opts[theirs.slice(1)] : ref[theirs]; if (v !== undefined && v !== null) data[mine] = v; }
      }
    }
    const full = withDefaults(k, data, opts);
    for (const [fid, f] of Object.entries(k.fields)) { const e = fieldError(f, full[fid]); if (e) throw new HttpError(400, `${f.label || fid} ${e}`); }
    const count = (one<any>(db, 'SELECT COUNT(*) AS n FROM mod_records WHERE world_id = ? AND mod_id = ? AND removed = 0', worldId, m.mod.id)?.n ?? 0);
    if (count >= 5000) throw new HttpError(409, `${m.mod.name} already keeps 5000 records in this world`);
    const rid = id('rec_');
    const at = now();
    run(db, 'INSERT INTO mod_records (world_id, mod_id, kind, id, account_id, data, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', worldId, m.mod.id, k.id, rid, owner, JSON.stringify(full), at, actor.accountId, at);
    const rec = getRecord(db, worldId, m, rid);
    log(db, worldId, m, rec, a.id, actor.accountId, null, full, input.note ?? '');
    speak(db, worldId, m, a.effect, rec, names, said, { actor: actor.accountId, note: input.note ?? '' });
    return { action: a.id, record: rec, before: null, after: full, said };
  }

  if (!input.recordId) throw new HttpError(400, `Say which ${k.label.toLowerCase()}`);
  const rec = getRecord(db, worldId, m, input.recordId);
  if (rec.kind !== k.id || rec.removed) throw new HttpError(404, `That is not a ${k.label.toLowerCase()} of ${m.mod.name}`);
  if (!may(a, actor, rec.player)) throw new HttpError(403, a.by === 'dm' ? 'Only the DM can do that' : 'Only its player can do that');
  if (!matches(rec, a.where, opts)) throw new HttpError(409, `${a.label} does not fit this ${k.label.toLowerCase()} now`);
  const before = dataOf(rec);
  if (a.do === 'remove') {
    run(db, 'UPDATE mod_records SET removed = 1, updated_at = ? WHERE world_id = ? AND mod_id = ? AND id = ?', now(), worldId, m.mod.id, rec.id);
    log(db, worldId, m, rec, a.id, actor.accountId, before, null, input.note ?? '');
    speak(db, worldId, m, a.effect, rec, names, said, { actor: actor.accountId, note: input.note ?? '' });
    return { action: a.id, record: { ...rec, removed: true }, before, after: null, said };
  }
  const after: Record<string, unknown> = { ...before, ...asked, ...fixed };
  if (a.do === 'add') {
    const amount = a.amount === 'ask' ? input.amount : Number(val(a.amount as any, opts));
    if (!Number.isInteger(amount) || Math.abs(amount as number) > 100_000) throw new HttpError(400, 'Say how much, a whole number (negative takes away)');
    const f = k.fields[a.field!];
    let next = Number(before[a.field!] ?? 0) + (amount as number);
    // A fixed amount is a spend or a gain (use a point from the pool): past the field's limit it is refused, not
    // quietly cut. An amount the caller says (the DM adds or takes days) is held at the limit.
    if (a.amount !== 'ask' && ((f.min !== undefined && next < f.min) || (f.max !== undefined && next > f.max))) {
      throw new HttpError(409, next < (f.min ?? 0) ? `Not enough ${f.label || a.field} left (${before[a.field!] ?? 0})` : `${f.label || a.field} is already at its most (${f.max})`);
    }
    if (f.min !== undefined) next = Math.max(f.min, next);
    if (f.max !== undefined) next = Math.min(f.max, next);
    after[a.field!] = next;
  }
  for (const [fid, f] of Object.entries(k.fields)) { const e = fieldError(f, after[fid]); if (e) throw new HttpError(400, `${f.label || fid} ${e}`); }
  save(db, worldId, m, rec, after);
  log(db, worldId, m, rec, a.id, actor.accountId, before, after, input.note ?? '');
  const updated = getRecord(db, worldId, m, rec.id);
  speak(db, worldId, m, a.effect, updated, names, said, { actor: actor.accountId, note: input.note ?? '' });
  // An "add" may finish a timer goal at once (the DM adds the last days).
  if (a.do === 'add') finishIfDone(db, worldId, m, updated, m.mod.system.timers.filter((t) => t.record === k.id && t.field === a.field), names, said);
  return { action: a.id, record: getRecord(db, worldId, m, rec.id), before, after, said };
}

function save(db: DB, worldId: string, m: Installed, rec: Rec, data: Record<string, unknown>) {
  run(db, 'UPDATE mod_records SET data = ?, updated_at = ? WHERE world_id = ? AND mod_id = ? AND id = ?', JSON.stringify(data), now(), worldId, m.mod.id, rec.id);
}

/**
 * "{name} finished {activity.name}": {name} and {player} are the record's player (their character), {title} the
 * field that names the record, {field} its fields, {ref.field} a field of the record a ref points at, and
 * {kind.field} (the record's own kind) its own field, so a field called name is {project.name}.
 */
export function fill(db: DB, worldId: string, m: Installed, template: string, rec: Rec, names: (accountId: string | null) => string, ctx: { actor?: string | null; note?: string } = {}): string {
  // {name} is the record's player; on a shared record (a party pool) it is whoever ran the action.
  const who = rec.player ?? ctx.actor ?? null;
  const own = (f: string) => rec[f] === undefined || rec[f] === null ? '' : String(rec[f]);
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9-]*)(?:\.([a-zA-Z][a-zA-Z0-9-]*))?\}/g, (whole, a: string, b?: string) => {
    if (b && a === rec.kind && typeof rec[a] !== 'string') return own(b);
    if (!b) {
      if (a === 'name' || a === 'player') return names(who);
      if (a === 'note' && !(m.mod.system.records.find((k) => k.id === rec.kind)?.fields.note)) return ctx.note ?? '';
      if (a === 'title') { const t = m.mod.system.records.find((k) => k.id === rec.kind)?.title; return t ? own(t) : ''; }
      return own(a);
    }
    const ref = rec[a];
    if (typeof ref !== 'string') return '';
    try { const r = getRecord(db, worldId, m, ref); return r[b] === undefined || r[b] === null ? '' : String(r[b]); } catch { return ''; }
  }).slice(0, 500);
}

function speak(db: DB, worldId: string, m: Installed, effect: RecordAction['effect'], rec: Rec, names: (a: string | null) => string, said: Said, ctx: { actor?: string | null; note?: string } = {}) {
  const tidy = (t: string) => t.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
  if (effect?.chat) said.chat.push(tidy(fill(db, worldId, m, effect.chat, rec, names, ctx)));
  if (effect?.dmnote) said.dmnote.push(tidy(fill(db, worldId, m, effect.dmnote, rec, names, ctx)));
}

const goalOf = (t: Timer, rec: Rec, opts: Record<string, unknown>): number | null => {
  const fromField = typeof t.goal === 'string' && !t.goal.startsWith('$');
  const g = fromField ? rec[t.goal] : val(t.goal, opts);
  if (!Number.isFinite(Number(g)) || g === null || g === undefined) return null;
  // A goal read from the record that is 0 means "no goal" (an injury only magic heals): the timer never finishes it.
  return fromField && Number(g) <= 0 ? null : Number(g);
};

function finishIfDone(db: DB, worldId: string, m: Installed, rec: Rec, timers: Timer[], names: (a: string | null) => string, said: Said) {
  for (const t of timers) {
    if (!matches(rec, t.where, m.options)) continue;
    const goal = goalOf(t, rec, m.options);
    if (goal === null || Number(rec[t.field] ?? 0) < goal || !Object.keys(t.done.set).length) continue;
    const before = dataOf(rec);
    const after = { ...before, ...Object.fromEntries(Object.entries(t.done.set).map(([f, v]) => [f, val(v as any, m.options)])) };
    save(db, worldId, m, rec, after);
    log(db, worldId, m, rec, `timer:${t.id}:done`, null, before, after, '');
    if (t.done.chat) said.chat.push(fill(db, worldId, m, t.done.chat, { ...rec, ...after }, names));
    Object.assign(rec, after);
  }
}

/**
 * Move timers: every enabled record that fits, on a rest or a session start/end, or only the records a player
 * picked in a prompt (`only`). Returns what to post and the players whose records changed.
 */
export function runTimers(db: DB, worldId: string, m: Installed, on: string, names: (a: string | null) => string, only?: string[]): { said: Said; players: string[] } {
  const said: Said = { chat: [], dmnote: [] };
  const players = new Set<string>();
  for (const t of m.mod.system.timers.filter((x) => x.on === on)) {
    const recs = only ? only.map((rid) => { try { return getRecord(db, worldId, m, rid); } catch { return null; } }).filter((r): r is Rec => !!r && r.kind === t.record && !r.removed) : listRecords(db, worldId, m, t.record);
    for (const rec of recs) {
      if (!matches(rec, t.where, m.options)) continue;
      const before = dataOf(rec);
      const after = { ...before, [t.field]: Number(before[t.field] ?? 0) + Number(val(t.add, m.options)) };
      save(db, worldId, m, rec, after);
      log(db, worldId, m, rec, `timer:${t.id}`, null, before, after, on);
      if (rec.player) players.add(rec.player);
      finishIfDone(db, worldId, m, { ...rec, ...after }, [t], names, said);
    }
  }
  return { said, players: [...players] };
}

// ---- prompts: the DM asks every player to choose (a downtime day) --------------------------------------------------------

export interface PromptRound { id: string; modId: string; prompt: string; openedAt: string; closedAt: string | null; answers: Record<string, { choice: number; recordId?: string; at: string }> }
const toRound = (r: any): PromptRound => ({ id: r.id, modId: r.mod_id, prompt: r.prompt, openedAt: r.opened_at, closedAt: r.closed_at, answers: parseJson(r.answers, {}) });

export function openRounds(db: DB, worldId: string, modId?: string): PromptRound[] {
  return all<any>(db, `SELECT * FROM mod_prompts WHERE world_id = ? AND closed_at IS NULL${modId ? ' AND mod_id = ?' : ''} ORDER BY opened_at`, worldId, ...(modId ? [modId] : [])).map(toRound);
}

export function openPrompt(db: DB, worldId: string, m: Installed, promptId: string, by: string): PromptRound {
  if (!m.enabled) throw new HttpError(409, `${m.mod.name} is off in this world`);
  if (!m.mod.system.prompts.find((p) => p.id === promptId)) throw new HttpError(404, `${m.mod.name} has no prompt ${String(promptId).slice(0, 40)}`);
  if (openRounds(db, worldId, m.mod.id).some((r) => r.prompt === promptId)) throw new HttpError(409, 'That is already open: close it first');
  const rid = id('mpr_');
  run(db, 'INSERT INTO mod_prompts (id, world_id, mod_id, prompt, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)', rid, worldId, m.mod.id, promptId, by, now());
  return toRound(one<any>(db, 'SELECT * FROM mod_prompts WHERE id = ?', rid));
}

export function closePrompt(db: DB, worldId: string, roundId: string): PromptRound {
  const r = one<any>(db, 'SELECT * FROM mod_prompts WHERE world_id = ? AND id = ?', worldId, roundId);
  if (!r) throw new HttpError(404, 'No such prompt');
  if (!r.closed_at) run(db, 'UPDATE mod_prompts SET closed_at = ? WHERE id = ?', now(), roundId);
  return toRound(one<any>(db, 'SELECT * FROM mod_prompts WHERE id = ?', roundId));
}

/** A player's answer: a choice (its record action runs as them) or skip. Then the prompt's timers move the record they picked. */
export function answerPrompt(db: DB, worldId: string, m: Installed, roundId: string, actor: Actor, choice: number, input: RecordActInput, names: (a: string | null) => string): { round: PromptRound; result: RecordActResult | null; said: Said } {
  const row = one<any>(db, 'SELECT * FROM mod_prompts WHERE world_id = ? AND id = ? AND mod_id = ?', worldId, roundId, m.mod.id);
  if (!row) throw new HttpError(404, 'No such prompt');
  const round = toRound(row);
  if (round.closedAt) throw new HttpError(409, 'The DM has closed this one');
  if (actor.role !== 'player') throw new HttpError(403, 'Players answer prompts');
  if (round.answers[actor.accountId]) throw new HttpError(409, 'You already answered');
  const p = m.mod.system.prompts.find((x) => x.id === round.prompt)!;
  const c = p.choices[choice];
  if (!c) throw new HttpError(400, 'Pick one of the choices');
  let result: RecordActResult | null = null;
  const said: Said = { chat: [], dmnote: [] };
  if (!c.skip && c.action) {
    result = recordAct(db, worldId, m, c.action, actor, input, names);
    said.chat.push(...result.said.chat); said.dmnote.push(...result.said.dmnote);
    const moved = runTimers(db, worldId, m, `prompt:${p.id}`, names, [result.record.id]);
    said.chat.push(...moved.said.chat); said.dmnote.push(...moved.said.dmnote);
    result = { ...result, record: getRecord(db, worldId, m, result.record.id) };
  }
  const answers = { ...round.answers, [actor.accountId]: { choice, ...(result ? { recordId: result.record.id } : {}), at: now() } };
  run(db, 'UPDATE mod_prompts SET answers = ? WHERE id = ?', JSON.stringify(answers), roundId);
  return { round: { ...round, answers }, result, said };
}

export interface RecordLogLine { id: string; modId: string; kind: string; recordId: string; player: string | null; action: string; by: string | null; before: unknown; after: unknown; note: string; at: string }
export function readRecordLog(db: DB, worldId: string, opts: { modId?: string; recordId?: string; player?: string; limit?: number }): RecordLogLine[] {
  const where = ['world_id = ?'];
  const args: unknown[] = [worldId];
  if (opts.modId) { where.push('mod_id = ?'); args.push(opts.modId); }
  if (opts.recordId) { where.push('record_id = ?'); args.push(opts.recordId); }
  if (opts.player) { where.push('account_id = ?'); args.push(opts.player); }
  return all<any>(db, `SELECT * FROM mod_record_log WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`, ...args, Math.min(500, Math.max(1, opts.limit ?? 100)))
    .map((l) => ({ id: l.id, modId: l.mod_id, kind: l.kind, recordId: l.record_id, player: l.account_id, action: l.action, by: l.by, before: parseJson(l.before, null), after: parseJson(l.after, null), note: l.note, at: l.at }));
}
