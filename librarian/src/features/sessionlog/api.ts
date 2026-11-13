// Session log: gather what happened, draft a summary (with a model, or an
// extractive skeleton without one), and the shapes drafts and entries take.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one } from '../../core/db.ts';
import { chat, chatJson, ModelUnavailable, type ChatMessage } from '../../core/ai.ts';
import { HttpError, parseJson } from '../../core/util.ts';
import { names } from '../../routes/_shared.ts';
import { getClock } from '../clock/api.ts';
import { listSessions, sessionLines } from '../audio/api.ts';
import { lineIsAside } from './leak.ts';

export const SECTIONS = ['Recap', 'Key moments', 'Loot & coin', 'People met', 'Open threads'] as const;
const MAX_MATERIAL = 24_000;
const MAX_MINUTES = 365 * 24 * 60;

export interface DateProposal {
  minutes: number;
  reason: string;
  travel?: { from: string; to: string; days: number; route: string };
  rests?: { kind: 'short' | 'long'; minutesIn?: number }[];
}

export interface Gathered {
  from: string;
  to: string;
  worldStartMinutes: number;
  playerLines: { at: number; speaker: string; text: string }[];
  /** DM-only and aside lines: only ever used for the DM notes. */
  dmLines: { speaker: string; text: string; aside: boolean }[];
  combat: string[];
  coin: string[];
  loot: string[];
  broker: string[];
  clock: string[];
  audioSessionIds: string[];
}

export function resolveRange(db: DB, worldId: string, b: { audioSessionId?: unknown; from?: unknown; to?: unknown }): { from: string; to: string; sessionIds: string[] } {
  const nowIso = new Date().toISOString();
  const iso = (v: unknown, f: string) => {
    if (v === undefined || v === null || v === '') return null;
    const t = Date.parse(String(v));
    if (Number.isNaN(t)) throw new HttpError(400, `${f} must be a date and time`);
    return new Date(t).toISOString();
  };
  if (typeof b.audioSessionId === 'string' && b.audioSessionId) {
    const s = listSessions(db, worldId).find((x) => x.id === b.audioSessionId);
    if (!s) throw new HttpError(404, 'Audio session not found');
    return { from: iso(b.from, 'from') ?? s.startedAt, to: iso(b.to, 'to') ?? s.stoppedAt ?? nowIso, sessionIds: [s.id] };
  }
  const last = one<any>(db, 'SELECT MAX(published_at) AS at FROM sessionlog_entries WHERE world_id = ?', worldId)?.at as string | null;
  const from = iso(b.from, 'from') ?? last ?? '1970-01-01T00:00:00.000Z';
  const to = iso(b.to, 'to') ?? nowIso;
  const sessionIds = listSessions(db, worldId).filter((s) => s.startedAt <= to && (s.stoppedAt ?? nowIso) >= from).map((s) => s.id);
  return { from, to, sessionIds };
}

const cp = (n: number) => { const a = Math.abs(n); const g = Math.floor(a / 100); const s = Math.floor((a % 100) / 10); const c = a % 10; return `${n < 0 ? '-' : '+'}${[g && `${g} gp`, s && `${s} sp`, c && `${c} cp`].filter(Boolean).join(' ') || '0 cp'}`; };

export function gather(db: DB, worldId: string, range: { from: string; to: string; sessionIds: string[] }): Gathered {
  const nm = names(db, worldId);
  const mics = new Map(all<any>(db, 'SELECT id, aside FROM audio_mics WHERE world_id = ?', worldId).map((m) => [m.id as string, m.aside === 1]));
  const holds = all<any>(db, "SELECT h.session_id, h.start_ms, h.end_ms FROM audio_holds h JOIN audio_sessions s ON s.id = h.session_id WHERE s.world_id = ? AND h.kind = 'aside'", worldId);
  const playerLines: Gathered['playerLines'] = [];
  const dmLines: Gathered['dmLines'] = [];
  for (const sid of range.sessionIds) {
    for (const l of sessionLines(db, worldId, sid)) playerLines.push({ at: l.start, speaker: l.speaker, text: l.text });
    const rows = all<any>(db, "SELECT session_id, start_ms, end_ms, speaker_label, text, sources FROM audio_lines WHERE world_id = ? AND session_id = ? AND audience = 'dm' ORDER BY start_ms", worldId, sid);
    for (const l of rows) dmLines.push({ speaker: l.speaker_label || 'DM', text: l.text, aside: lineIsAside(l, mics, holds) });
  }
  const inRange = (col: string) => `${col} >= ? AND ${col} <= ?`;
  const combat = all<any>(db, 'SELECT name FROM combatants WHERE world_id = ? AND is_pc = 0 AND hidden = 0 AND hp IS NOT NULL AND hp <= 0', worldId).map((c) => `${c.name} was defeated`);
  const coin = all<any>(db, `SELECT owner, amount_cp, note FROM ledger WHERE world_id = ? AND status = 'approved' AND ${inRange('at')} ORDER BY at`, worldId, range.from, range.to)
    .map((l) => `${l.owner === 'party' ? 'Party' : nm[l.owner] ?? 'Someone'}: ${cp(l.amount_cp)}${l.note ? ` (${l.note})` : ''}`);
  const loot = all<any>(db, `SELECT owner, name, qty FROM items WHERE world_id = ? AND ${inRange('updated_at')} ORDER BY updated_at`, worldId, range.from, range.to)
    .map((i) => `${i.qty > 1 ? `${i.qty} x ` : ''}${i.name} (${i.owner === 'party' ? 'party' : nm[i.owner] ?? 'someone'})`);
  const broker = all<any>(db, `SELECT account_id, question FROM broker_requests WHERE world_id = ? AND delivered_at IS NOT NULL AND ${inRange('delivered_at')} ORDER BY delivered_at`, worldId, range.from, range.to)
    .map((b) => `${nm[b.account_id] ?? 'Someone'} bought an answer to: ${String(b.question).slice(0, 200)}`);
  const clockRows = all<any>(db, `SELECT kind, reason, before_label, after_label, before_minutes FROM clock_log WHERE world_id = ? AND kind IN ('advance','set') AND undone = 0 AND ${inRange('at')} ORDER BY rowid`, worldId, range.from, range.to);
  const clock = clockRows.map((c) => `${c.before_label} to ${c.after_label}${c.reason ? `: ${c.reason}` : ''}`);
  const worldStartMinutes = clockRows.length ? (clockRows[0].before_minutes as number) : getClock(db, worldId).minutes;
  return { from: range.from, to: range.to, worldStartMinutes, playerLines, dmLines, combat, coin, loot, broker, clock, audioSessionIds: range.sessionIds };
}

const bullets = (xs: string[], none: string) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : none);

/** The player-safe material as plain text for a model. DM and aside lines are never in it. */
export function material(g: Gathered): string {
  let t = g.playerLines.map((l) => `${l.speaker}: ${l.text}`).join('\n');
  if (t.length > MAX_MATERIAL) {
    const keep = Math.floor(MAX_MATERIAL / 2);
    t = `${t.slice(0, keep)}\n[...middle of the transcript left out...]\n${t.slice(-keep)}`;
  }
  return [
    `TRANSCRIPT (players' view):\n${t || '(none)'}`,
    `COMBAT:\n${bullets(g.combat, '(none)')}`,
    `COIN:\n${bullets(g.coin, '(none)')}`,
    `ITEMS:\n${bullets(g.loot, '(none)')}`,
    `BOUGHT ANSWERS:\n${bullets(g.broker, '(none)')}`,
    `WORLD CLOCK CHANGES:\n${bullets(g.clock, '(none)')}`,
  ].join('\n\n');
}

/** A summary built from the data alone, with no model. */
export function skeleton(g: Gathered): string {
  const lines = g.playerLines.filter((l) => l.text.trim().split(/\s+/).length >= 4);
  const pick = (n: number) => {
    if (lines.length <= n) return lines;
    const ranked = [...lines].sort((a, b) => b.text.length - a.text.length).slice(0, n);
    return ranked.sort((a, b) => a.at - b.at);
  };
  const recap = pick(6).map((l) => `${l.speaker}: "${l.text.trim()}"`);
  const open = lines.filter((l) => l.text.includes('?')).slice(0, 5).map((l) => `${l.speaker} asked: ${l.text.trim()}`);
  const counts = new Map<string, number>();
  for (const l of g.playerLines) for (const m of l.text.matchAll(/(?<=[a-z,;]\s)([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const people = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n]) => n);
  const moments = [...g.combat, ...g.clock.map((c) => `Time passed: ${c}`), ...g.broker];
  return [
    '## Recap', bullets(recap, '_No transcript was recorded for this session._'),
    '## Key moments', bullets(moments, '_Nothing recorded._'),
    '## Loot & coin', bullets([...g.coin, ...g.loot], '_No loot or coin changes._'),
    '## People met', bullets(people, '_Nobody recorded._'),
    '## Open threads', bullets(open, '_None recorded._'),
  ].join('\n\n') + '\n';
}

/** Notes from the DM-only and aside lines. Never published. */
export function dmNotes(g: Gathered): string {
  const xs = g.dmLines.filter((l) => l.text.trim().split(/\s+/).length >= 3).slice(0, 25).map((l) => `${l.aside ? '(aside) ' : ''}${l.speaker}: ${l.text.trim()}`);
  return xs.length ? xs.map((x) => `- ${x}`).join('\n') : '';
}

const SYSTEM = `You write session summaries for a tabletop role-playing campaign, for the players to read. Use ONLY the material given. Write Markdown with exactly these sections, as "## " headings: ${SECTIONS.join(', ')}. Be brief and concrete. Do not invent events, names or secrets.`;

export interface Drafted { markdown: string; proposal: DateProposal | null; usedModel: boolean }

export function cleanProposal(p: any): DateProposal | null {
  if (!p || typeof p !== 'object') return null;
  const minutes = Number(p.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return null;
  const out: DateProposal = { minutes, reason: typeof p.reason === 'string' ? p.reason.slice(0, 200) : '' };
  const t = p.travel;
  if (t && typeof t === 'object') out.travel = { from: String(t.from ?? '').slice(0, 100), to: String(t.to ?? '').slice(0, 100), days: Math.max(0, Math.round(Number(t.days) || 0)), route: String(t.route ?? '').slice(0, 200) };
  if (Array.isArray(p.rests)) {
    const rests = p.rests.slice(0, 20).map((r: any) => {
      const kind: 'short' | 'long' = r?.kind === 'long' || r === 'long' ? 'long' : 'short';
      const m = Number(r?.minutesIn);
      return Number.isInteger(m) && m >= 0 && m <= minutes ? { kind, minutesIn: m } : { kind };
    });
    if (rests.length) out.rests = rests;
  }
  return out;
}

/** Ask the model for a summary and a date proposal; fall back to the skeleton. */
export async function draftSummary(d: Deps, g: Gathered): Promise<Drafted> {
  const mat = material(g);
  let markdown = '';
  let usedModel = false;
  try {
    const r = await chat(d, 'chat', { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: mat }], temperature: 0.3 });
    if (r.content.trim()) { markdown = r.content.trim() + '\n'; usedModel = true; }
  } catch (e) {
    if (!(e instanceof ModelUnavailable)) throw e;
  }
  if (!markdown) return { markdown: skeleton(g), proposal: null, usedModel: false };
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'From this session material, propose how much in-world time passed. Answer with JSON only: {"minutes": whole number of minutes, "reason": short text, "travel": {"from": place, "to": place, "days": number, "route": text} (only if the party travelled), "rests": [{"kind": "short" or "long", "minutesIn": minutes from the start}] (only if they rested)}. If you cannot tell, answer {"minutes": 0}.' },
    { role: 'user', content: mat },
  ];
  const proposal = cleanProposal(await chatJson(d, 'chat', msgs));
  return { markdown, proposal, usedModel };
}

export async function reviseSummary(d: Deps, markdown: string, instruction: string): Promise<string> {
  try {
    const r = await chat(d, 'chat', { messages: [
      { role: 'system', content: `${SYSTEM} You are given a draft and an instruction from the DM. Return the full revised summary only.` },
      { role: 'user', content: `DRAFT:\n${markdown}\n\nINSTRUCTION:\n${instruction}` },
    ], temperature: 0.3 });
    if (!r.content.trim()) throw new HttpError(502, 'The model sent an empty answer');
    return r.content.trim() + '\n';
  } catch (e) {
    if (e instanceof ModelUnavailable) throw new HttpError(503, e.message);
    throw e;
  }
}

// ---- shapes ----------------------------------------------------------------

export function draftOut(db: DB, r: any, withVersions = false) {
  const cur = one<any>(db, 'SELECT * FROM sessionlog_versions WHERE draft_id = ? AND n = ?', r.id, r.current_version);
  const base = {
    id: r.id, title: r.title, audioSessionId: r.audio_session_id, from: r.from_at, to: r.to_at,
    version: r.current_version, markdown: cur?.markdown ?? '', dmNotes: r.dm_notes, usedModel: r.used_model === 1,
    proposal: parseJson<DateProposal | null>(r.proposal, null), dateStatus: r.date_status as string,
    dateApplied: parseJson<any>(r.date_applied, null), entryId: r.entry_id as string | null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (!withVersions) return base;
  const versions = all<any>(db, 'SELECT n, note, created_at, created_by, LENGTH(markdown) AS size FROM sessionlog_versions WHERE draft_id = ? ORDER BY n DESC', r.id)
    .map((v) => ({ n: v.n, note: v.note, createdAt: v.created_at, size: v.size }));
  return { ...base, versions };
}

export function entryOut(r: any) {
  return {
    id: r.id, number: r.number, title: r.title, summary: r.summary, sessionAt: r.session_at,
    worldFrom: r.world_from_label, worldTo: r.world_to_label, worldFromMinutes: r.world_from_minutes, worldToMinutes: r.world_to_minutes,
    publishedAt: r.published_at, published: r.unpublished_at === null,
  };
}
