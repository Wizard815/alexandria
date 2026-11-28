// Active mode: storage. Settings (per world), a per-recording override, the
// command log (every action Minerva takes or proposes, in both modes) and the
// "that was wrong" rules that stop a cue from firing again.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { id, now, parseJson } from '../../core/util.ts';
import { gmOnly } from '../../core/events.ts';
import { CATEGORIES, type Category } from './cues.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS active_state (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'assistant', wake_word TEXT NOT NULL DEFAULT 'Minerva',
  cats TEXT NOT NULL DEFAULT '{}', presets TEXT NOT NULL DEFAULT '{}', prev TEXT,
  listen TEXT NOT NULL DEFAULT '{}', ask_ttl_min INTEGER NOT NULL DEFAULT 10, scan INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS active_session (session_id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, mode TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS active_log (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, session_id TEXT, at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'active', trigger TEXT NOT NULL DEFAULT 'line', line_id TEXT, speaker TEXT NOT NULL DEFAULT '', cue TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL DEFAULT '', args TEXT NOT NULL DEFAULT '{}', calls TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'rules', confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'done', result TEXT NOT NULL DEFAULT '',
  undo TEXT, reversible INTEGER NOT NULL DEFAULT 0, visible TEXT NOT NULL DEFAULT 'gm', rule_key TEXT NOT NULL DEFAULT '', wrong INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT, expires_at TEXT, latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS active_log_world ON active_log(world_id, at);
CREATE TABLE IF NOT EXISTS active_rules (world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, rule_key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (world_id, rule_key));
`;

export type Setting = 'auto' | 'ask' | 'off' | 'draft';
export type Cats = Record<Category, Setting>;
export const DEFAULT_CATS: Cats = { music: 'auto', sfx: 'auto', stage: 'ask', events: 'ask', combat: 'auto', combatAdd: 'ask', items: 'ask', clock: 'ask', notes: 'draft' };
const allAuto = (): Cats => ({ ...DEFAULT_CATS, music: 'auto', sfx: 'auto', stage: 'auto', events: 'auto', combat: 'auto', combatAdd: 'auto', items: 'auto', clock: 'auto', notes: 'draft' });
export interface Preset { name: string; cats: Cats }
export const DEFAULT_PRESETS: Record<string, Preset> = {
  '1': { name: 'Mood only', cats: { ...DEFAULT_CATS, music: 'auto', sfx: 'auto', stage: 'ask', events: 'ask', combat: 'ask', combatAdd: 'ask', items: 'ask', clock: 'ask', notes: 'draft' } },
  '2': { name: 'Combat helper', cats: { ...DEFAULT_CATS, music: 'auto', sfx: 'ask', stage: 'ask', events: 'ask', combat: 'auto', combatAdd: 'auto', items: 'ask', clock: 'ask', notes: 'draft' } },
  '3': { name: 'Full takeover', cats: allAuto() },
};

export interface Listen { gm: boolean; players: boolean; room: boolean }
export interface State { mode: 'assistant' | 'active'; wakeWord: string; cats: Cats; presets: Record<string, Preset>; prev: Cats | null; listen: Listen; askTtlMin: number; scan: boolean }

const cleanCats = (v: unknown, base: Cats = DEFAULT_CATS): Cats => {
  const out = { ...base };
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  for (const c of CATEGORIES) {
    const x = o[c];
    if (x === 'auto' || x === 'ask' || x === 'off') out[c] = c === 'notes' && x === 'auto' ? 'draft' : x;
    else if (x === 'draft' && c === 'notes') out[c] = 'draft';
  }
  return out;
};
export { cleanCats };

export function getState(d: Deps, worldId: string): State {
  const r = one<any>(d.db, 'SELECT * FROM active_state WHERE world_id = ?', worldId);
  const presets: Record<string, Preset> = { ...DEFAULT_PRESETS };
  for (const [k, p] of Object.entries(parseJson<Record<string, any>>(r?.presets, {}))) if (/^\d{1,2}$/.test(k) && p && typeof p.name === 'string') presets[k] = { name: p.name.slice(0, 40), cats: cleanCats(p.cats) };
  const listen = parseJson<Partial<Listen>>(r?.listen, {});
  return {
    mode: r?.mode === 'active' ? 'active' : 'assistant', wakeWord: r?.wake_word || 'Minerva', cats: cleanCats(parseJson(r?.cats, {})), presets,
    prev: r?.prev ? cleanCats(parseJson(r.prev, {})) : null, listen: { gm: listen.gm !== false, players: listen.players !== false, room: listen.room === true },
    askTtlMin: Number.isInteger(r?.ask_ttl_min) ? r.ask_ttl_min : 10, scan: r ? !!r.scan : true,
  };
}
export function saveState(d: Deps, worldId: string, s: Partial<State>): State {
  const cur = getState(d, worldId);
  const n: State = { ...cur, ...s };
  const customPresets = Object.fromEntries(Object.entries(n.presets).filter(([k, p]) => JSON.stringify(p) !== JSON.stringify(DEFAULT_PRESETS[k])));
  run(d.db, `INSERT INTO active_state (world_id, mode, wake_word, cats, presets, prev, listen, ask_ttl_min, scan, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (world_id) DO UPDATE SET mode = excluded.mode, wake_word = excluded.wake_word, cats = excluded.cats, presets = excluded.presets, prev = excluded.prev, listen = excluded.listen, ask_ttl_min = excluded.ask_ttl_min, scan = excluded.scan, updated_at = excluded.updated_at`,
    worldId, n.mode, n.wakeWord, JSON.stringify(n.cats), JSON.stringify(customPresets), n.prev ? JSON.stringify(n.prev) : null, JSON.stringify(n.listen), n.askTtlMin, n.scan ? 1 : 0, now());
  return getState(d, worldId);
}

/** The mode in force for a recording: its own override, else the world's. */
export function effectiveMode(d: Deps, worldId: string, sessionId?: string | null): 'assistant' | 'active' {
  if (sessionId) { const o = one<any>(d.db, 'SELECT mode FROM active_session WHERE session_id = ? AND world_id = ?', sessionId, worldId); if (o) return o.mode === 'active' ? 'active' : 'assistant'; }
  return getState(d, worldId).mode;
}
export const setSessionMode = (d: Deps, worldId: string, sessionId: string, mode: 'assistant' | 'active' | null) => {
  if (mode === null) run(d.db, 'DELETE FROM active_session WHERE session_id = ?', sessionId);
  else run(d.db, 'INSERT INTO active_session (session_id, world_id, mode) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET mode = excluded.mode', sessionId, worldId, mode);
};
export const sessionOverride = (d: Deps, worldId: string, sessionId: string): 'assistant' | 'active' | null => { const o = one<any>(d.db, 'SELECT mode FROM active_session WHERE session_id = ? AND world_id = ?', sessionId, worldId); return o ? (o.mode === 'active' ? 'active' : 'assistant') : null; };

// ---- the log -------------------------------------------------------------------------

export type Status = 'done' | 'failed' | 'undone' | 'pending' | 'rejected' | 'dismissed' | 'expired' | 'blocked';
export interface LogRow {
  id: string; worldId: string; sessionId: string | null; at: string; mode: 'assistant' | 'active'; trigger: string; lineId: string | null; speaker: string; cue: string; category: string;
  tool: string; args: unknown; calls: { tool: string; args: any }[]; summary: string; source: string; confidence: number; status: Status; result: string; reversible: boolean; visible: 'gm' | 'table' | 'players';
  wrong: boolean; decidedAt: string | null; expiresAt: string | null; latencyMs: number | null; ruleKey: string;
}
const view = (r: any): LogRow => ({
  id: r.id, worldId: r.world_id, sessionId: r.session_id, at: r.at, mode: r.mode, trigger: r.trigger, lineId: r.line_id, speaker: r.speaker, cue: r.cue, category: r.category, tool: r.tool,
  args: parseJson(r.args, {}), calls: parseJson(r.calls, []), summary: r.summary, source: r.source, confidence: r.confidence, status: r.status, result: r.result, reversible: !!r.reversible && !!r.undo && r.status === 'done', visible: r.visible,
  wrong: !!r.wrong, decidedAt: r.decided_at, expiresAt: r.expires_at, latencyMs: r.latency_ms, ruleKey: r.rule_key,
});

export interface NewLog {
  sessionId?: string | null; mode?: 'assistant' | 'active'; trigger: string; lineId?: string | null; speaker?: string; cue?: string; category: string; tool: string; args?: unknown; calls?: unknown[]; summary: string;
  source?: string; confidence?: number; status: Status; result?: string; undo?: unknown; visible?: 'gm' | 'table' | 'players'; ruleKey?: string; expiresAt?: string | null; latencyMs?: number | null;
}
export function addLog(d: Deps, worldId: string, n: NewLog): LogRow {
  const lid = id('alog_');
  run(d.db, `INSERT INTO active_log (id, world_id, session_id, at, mode, trigger, line_id, speaker, cue, category, tool, args, calls, summary, source, confidence, status, result, undo, reversible, visible, rule_key, expires_at, latency_ms, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    lid, worldId, n.sessionId ?? null, now(), n.mode ?? 'active', n.trigger, n.lineId ?? null, (n.speaker ?? '').slice(0, 80), (n.cue ?? '').slice(0, 300), n.category, n.tool, JSON.stringify(n.args ?? {}).slice(0, 4000), JSON.stringify(n.calls ?? []).slice(0, 8000),
    n.summary.slice(0, 400), n.source ?? 'rules', n.confidence ?? 0, n.status, (n.result ?? '').slice(0, 1500), n.undo ? JSON.stringify(n.undo) : null, n.undo ? 1 : 0, n.visible ?? 'gm', n.ruleKey ?? '', n.expiresAt ?? null, n.latencyMs ?? null, n.status === 'pending' ? null : now());
  const row = getLog(d, worldId, lid)!;
  d.hub.emit(worldId, 'active', { kind: row.status === 'pending' ? 'card' : 'log', id: lid }, gmOnly);
  return row;
}
export const getLog = (d: Deps, worldId: string, logId: string): LogRow | null => { const r = one<any>(d.db, 'SELECT * FROM active_log WHERE id = ? AND world_id = ?', logId, worldId); return r ? view(r) : null; };
export const undoOf = (d: Deps, logId: string): { calls: { tool: string; args: any }[] } | null => { const r = one<any>(d.db, 'SELECT undo FROM active_log WHERE id = ?', logId); return r?.undo ? parseJson(r.undo, null) : null; };
export function setLog(d: Deps, worldId: string, logId: string, p: { status?: Status; result?: string; undo?: unknown | null; wrong?: boolean; decided?: boolean }) {
  const sets: string[] = []; const vals: any[] = [];
  if (p.status) { sets.push('status = ?'); vals.push(p.status); }
  if (p.result !== undefined) { sets.push('result = ?'); vals.push(p.result.slice(0, 1500)); }
  if (p.undo !== undefined) { sets.push('undo = ?', 'reversible = ?'); vals.push(p.undo ? JSON.stringify(p.undo) : null, p.undo ? 1 : 0); }
  if (p.wrong !== undefined) { sets.push('wrong = ?'); vals.push(p.wrong ? 1 : 0); }
  if (p.decided) { sets.push('decided_at = ?'); vals.push(now()); }
  if (sets.length) run(d.db, `UPDATE active_log SET ${sets.join(', ')} WHERE id = ? AND world_id = ?`, ...vals, logId, worldId);
  d.hub.emit(worldId, 'active', { kind: 'log', id: logId }, gmOnly);
}
export function listLog(d: Deps, worldId: string, o: { status?: string; limit?: number; sessionId?: string } = {}): LogRow[] {
  expireCards(d, worldId);
  const where = ['world_id = ?']; const vals: any[] = [worldId];
  if (o.status) { where.push('status = ?'); vals.push(o.status); }
  if (o.sessionId) { where.push('session_id = ?'); vals.push(o.sessionId); }
  return all<any>(d.db, `SELECT * FROM active_log WHERE ${where.join(' AND ')} ORDER BY at DESC, rowid DESC LIMIT ?`, ...vals, Math.min(o.limit ?? 100, 500)).map(view);
}
/** Cards nobody answered in time go away. */
export function expireCards(d: Deps, worldId: string) {
  const rows = all<any>(d.db, `SELECT id FROM active_log WHERE world_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`, worldId, now());
  for (const r of rows) setLog(d, worldId, r.id, { status: 'expired', decided: true });
}

// ---- "don't do that again" ---------------------------------------------------------------
export const addRule = (d: Deps, worldId: string, key: string) => { if (key) run(d.db, 'INSERT OR IGNORE INTO active_rules (world_id, rule_key, created_at) VALUES (?, ?, ?)', worldId, key, now()); };
export const hasRule = (d: Deps, worldId: string, key: string): boolean => !!key && !!one(d.db, 'SELECT 1 FROM active_rules WHERE world_id = ? AND rule_key = ?', worldId, key);
export const listRules = (d: Deps, worldId: string) => all<any>(d.db, 'SELECT rule_key AS key, created_at AS createdAt FROM active_rules WHERE world_id = ? ORDER BY created_at DESC', worldId);
export const dropRule = (d: Deps, worldId: string, key: string) => run(d.db, 'DELETE FROM active_rules WHERE world_id = ? AND rule_key = ?', worldId, key);
