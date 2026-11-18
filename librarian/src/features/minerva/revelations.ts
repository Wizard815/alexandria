// Revelations: every mystery has a conclusion, at least three clues, and for
// each clue who found it and when (docs/MINERVA.md §4.4). The structured data
// is in minerva_* tables for querying; the Markdown page under dm/revelations/
// shows the same as a clue table and is rewritten from the tables. Each
// player's knowledge.md is rebuilt from their marks, at party level for them.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, id, now } from '../../core/util.ts';
import { norm, players, readPage, slug, writePage, type PlayerRef } from './vault.ts';
import { openArc } from './store.ts';
import { whoIs } from './codex.ts';

export const MIN_CLUES = 3;

export interface Mystery { slug: string; title: string; conclusion: string; status: string; arc: string; clues: { n: number; text: string; found: { accountId: string; name: string; session: number | null; at: string }[] }[]; reached: string[]; theories: { accountId: string; text: string }[] }

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const nameOf = (ps: PlayerRef[], accountId: string) => { const p = ps.find((x) => x.accountId === accountId); return p ? p.character || p.name : 'Someone'; };

export function listMysteries(d: Deps, worldId: string): Mystery[] {
  const ps = players(d, worldId);
  const found = all<any>(d.db, 'SELECT * FROM minerva_found WHERE world_id = ? ORDER BY at', worldId);
  return all<any>(d.db, 'SELECT * FROM minerva_mysteries WHERE world_id = ? ORDER BY created_at', worldId).map((m) => ({
    slug: m.slug, title: m.title, conclusion: m.conclusion, status: m.status, arc: m.arc,
    clues: all<any>(d.db, 'SELECT n, text FROM minerva_clues WHERE world_id = ? AND slug = ? ORDER BY n', worldId, m.slug).map((c) => ({
      n: c.n, text: c.text,
      found: found.filter((f) => f.slug === m.slug && f.clue_n === c.n && f.kind === 'clue').map((f) => ({ accountId: f.account_id, name: nameOf(ps, f.account_id), session: f.session_n, at: f.at })),
    })),
    reached: found.filter((f) => f.slug === m.slug && f.kind === 'reached').map((f) => f.account_id),
    theories: found.filter((f) => f.slug === m.slug && f.kind === 'theory').map((f) => ({ accountId: f.account_id, text: f.text })),
  }));
}

export function findMystery(d: Deps, worldId: string, ref: string): Mystery {
  const q = norm(ref);
  const list = listMysteries(d, worldId);
  const m = list.find((x) => x.slug === ref || x.slug === slug(ref) || norm(x.title) === q) ?? list.find((x) => q.length >= 3 && norm(x.title).includes(q));
  if (!m) throw new HttpError(404, `No such mystery: ${clean(ref, 80)}`);
  return m;
}

/** The player's account id from an id, character, player name or mic. */
export function resolvePlayer(d: Deps, worldId: string, ref: string): PlayerRef {
  const ps = players(d, worldId);
  const byId = ps.find((p) => p.accountId === ref);
  if (byId) return byId;
  const hit = whoIs(d, worldId, ref, { partial: false }).find((m) => m.type === 'player');
  const p = hit && ps.find((x) => x.accountId === hit.accountId);
  if (!p) throw new HttpError(404, `No such player: ${clean(ref, 80)}`);
  return p;
}

function renderPage(d: Deps, worldId: string, m: Mystery): string {
  const rows = m.clues.map((c) => {
    const f = c.found.length ? c.found.map((x) => x.name).join(', ') : '_not found yet_';
    const when = c.found.length ? c.found.map((x) => `${x.session ? `session ${x.session}, ` : ''}${x.at.slice(0, 10)}`).join('; ') : '';
    return `| ${c.n} | ${c.text.replace(/\|/g, '/')} | ${f} | ${when} |`;
  });
  const ps = players(d, worldId);
  return `# ${m.title}\n\n## Conclusion\n${m.conclusion || '_Not written yet._'}\n\n## Clues\n| # | Clue | Found by | When |\n|---|---|---|---|\n${rows.join('\n')}\n\n## Who reached it\n${m.reached.length ? m.reached.map((a) => `- ${nameOf(ps, a)}`).join('\n') : '_Nobody yet._'}\n`;
}

function writeMysteryPage(d: Deps, worldId: string, m: Mystery, by: string | null) {
  writePage(d, worldId, `dm/revelations/${m.slug}.md`, { title: m.title, fm: { type: 'revelation', level: 'dm', ...(m.arc ? { arc: m.arc } : {}), tags: ['revelation'], sources: [] }, body: renderPage(d, worldId, m), by });
}

export function createMystery(d: Deps, worldId: string, a: { title: string; conclusion: string; clues: string[]; by?: string | null }): Mystery {
  const title = clean(a.title, 120);
  if (!title) throw new HttpError(400, 'title is required');
  const clues = (a.clues ?? []).map((c) => clean(c, 400)).filter(Boolean);
  if (clues.length < MIN_CLUES) throw new HttpError(400, `A mystery needs at least ${MIN_CLUES} clues so the players can find it more than one way`);
  const sl = slug(title);
  if (one(d.db, 'SELECT 1 FROM minerva_mysteries WHERE world_id = ? AND slug = ?', worldId, sl)) throw new HttpError(409, 'That mystery already exists; add clues to it');
  run(d.db, 'INSERT INTO minerva_mysteries (world_id, slug, title, conclusion, status, arc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', worldId, sl, title, clean(a.conclusion, 2000), 'open', openArc(d.db, worldId)?.slug ?? '', now());
  clues.forEach((c, i) => run(d.db, 'INSERT INTO minerva_clues (world_id, slug, n, text) VALUES (?, ?, ?, ?)', worldId, sl, i + 1, c));
  const m = findMystery(d, worldId, sl);
  writeMysteryPage(d, worldId, m, a.by ?? null);
  return m;
}

export interface MarkArgs { mystery: string; clue?: string | number; player: string; session?: number | null; kind?: 'clue' | 'theory' | 'reached'; text?: string; by?: string | null }

/** Record who found which clue (or guessed, or reached the conclusion) and rebuild the page and that player's knowledge. */
export function markRevelation(d: Deps, worldId: string, a: MarkArgs): { mystery: string; clue: number | null; player: string; accountId: string } {
  const m = findMystery(d, worldId, a.mystery);
  const p = resolvePlayer(d, worldId, a.player);
  const kind = a.kind === 'theory' || a.kind === 'reached' ? a.kind : 'clue';
  let n = 0;
  let text = '';
  if (kind === 'clue') {
    const ref = a.clue;
    const byNum = typeof ref === 'number' || /^\d+$/.test(String(ref ?? '')) ? m.clues.find((c) => c.n === Number(ref)) : undefined;
    const q = norm(String(ref ?? ''));
    const hit = byNum ?? (q ? m.clues.find((c) => norm(c.text) === q) ?? m.clues.find((c) => q.length >= 6 && (norm(c.text).includes(q) || q.includes(norm(c.text)))) : undefined);
    if (hit) n = hit.n;
    else {
      const t = clean(ref, 400);
      if (!t) throw new HttpError(400, 'Say which clue: its number or its text');
      n = (one<any>(d.db, 'SELECT MAX(n) AS n FROM minerva_clues WHERE world_id = ? AND slug = ?', worldId, m.slug)?.n ?? 0) + 1;
      run(d.db, 'INSERT INTO minerva_clues (world_id, slug, n, text) VALUES (?, ?, ?, ?)', worldId, m.slug, n, t);
    }
  } else if (kind === 'theory') {
    text = clean(a.text ?? a.clue, 400);
    if (!text) throw new HttpError(400, 'Say the theory');
  }
  run(d.db, 'INSERT OR IGNORE INTO minerva_found (id, world_id, slug, clue_n, account_id, kind, text, session_n, at, marked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('mf_'), worldId, m.slug, n, p.accountId, kind, text, a.session ?? null, now(), a.by ?? null);
  writeMysteryPage(d, worldId, findMystery(d, worldId, m.slug), a.by ?? null);
  rebuildKnowledge(d, worldId, p.accountId, a.by ?? null);
  return { mystery: m.title, clue: n || null, player: p.character || p.name, accountId: p.accountId };
}

/** knowledge.md of one player: only what their marks say, at party level for them. */
export function knowledgeBody(d: Deps, worldId: string, accountId: string): string {
  const me = players(d, worldId).find((p) => p.accountId === accountId);
  const clueLines: string[] = [];
  const reached: string[] = [];
  const theories: string[] = [];
  for (const m of listMysteries(d, worldId)) {
    const mine = m.clues.filter((c) => c.found.some((f) => f.accountId === accountId));
    if (mine.length) {
      clueLines.push(`### ${m.title}`);
      for (const c of mine) { const s = c.found.find((f) => f.accountId === accountId)?.session; clueLines.push(`- ${c.text}${s ? ` (session ${s})` : ''}`); }
      clueLines.push('');
    }
    if (m.reached.includes(accountId) && m.conclusion) reached.push(`- **${m.title}**: ${m.conclusion}`);
    for (const t of m.theories.filter((x) => x.accountId === accountId)) theories.push(`- ${t.text} _(${m.title}, not confirmed)_`);
  }
  return `# What ${me?.character || me?.name || 'you'} knows\n\n## Clues found\n${clueLines.length ? clueLines.join('\n') : '_Nothing yet._\n'}\n## Revelations reached\n${reached.length ? reached.join('\n') : '_None yet._'}\n\n## Theories\n${theories.length ? theories.join('\n') : '_None yet._'}\n`;
}

export function rebuildKnowledge(d: Deps, worldId: string, accountId: string, by: string | null = null) {
  writePage(d, worldId, `players/${accountId}/knowledge.md`, { title: 'Knowledge', fm: { type: 'knowledge', level: 'party', player: accountId, tags: [] }, body: knowledgeBody(d, worldId, accountId), by });
}

export const mysteryPage = (d: Deps, worldId: string, slugName: string) => readPage(d, worldId, `dm/revelations/${slugName}.md`);
