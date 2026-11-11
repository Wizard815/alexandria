// What a broker question is, and whether answering it would give away DM
// secrets. The broker never makes anything up: it can only sell lines that
// already exist in the party's player copies, or notes the DM wrote to be
// sold. Everything else goes to the DM.
//
// The classifier reads both sides:
// - the player side: player copies of shared pages, plus DM-written notes
// - the DM side: full pages, but only the lines a player can't already read
//   (DM-only pages, secret blocks, DM headings, DM fact groups)
// If the question is really about DM-side material, or names a DM-only page,
// it is "secret": nothing is sold automatically and the DM decides. The DM
// side never leaves this module except in `dmEvidence`, which only the DM is
// shown.
import type { DB } from './db.ts';
import { all, one } from './db.ts';
import type { Library } from './library.ts';
import { inlineText, type PropertyGroup } from '../intake/model.ts';
import type { Viewer } from './policy.ts';

export type QuestionType = 'who' | 'where' | 'when' | 'why' | 'how' | 'price' | 'what' | 'other';
export type Verdict = 'shared' | 'secret' | 'unknown';
export type Knowledge = 'common' | 'local' | 'deep';

export interface Evidence { page: string | null; title: string; text: string; score: number; knowledge: string | null; note?: string }
export interface Classification {
  type: QuestionType;
  verdict: Verdict;
  /** One line for the DM: why it was judged this way. */
  reason: string;
  /** Pages and people the question names. DM only (titles of DM-only pages). */
  entities: { id: string; title: string; shared: boolean }[];
  knowledge: Knowledge;
  multiplier: number;
  /** Player-safe answer: only player-copy lines and DM notes. Null unless verdict is 'shared'. */
  player: { answer: string; sources: { id: string | null; title: string }[] } | null;
  /** DM-side lines that matched. Never sent to players. */
  dmEvidence: { page: string; title: string; text: string }[];
}

const STOP = new Set('the a an and or of to in on at is are was were what who whom whose where when why how does do did about tell me with from for that this there their they his her its it be been can could would should into than then any some much many more most have has had our your you we i know want need find out anything everything thing things happened happen going around really truly actually'.split(' '));
export const words = (t: string) => String(t).toLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !STOP.has(w));
const SECRET_CUE = /\b(secret|secretly|really|truly|truth|true (name|identity|purpose|reason)|real (name|identity|purpose|reason)|hidden|behind|actually|plot|plan(s|ning)?|betray\w*|traitor|spy|cult)\b/i;
const RANK: Record<string, number> = { common: 0, local: 1, deep: 2 };

export function questionType(q: string): QuestionType {
  const s = q.toLowerCase();
  if (/\b(how much|cost|price|worth|pay)\b/.test(s)) return 'price';
  if (/^\s*(who|whom|whose)\b|\bwho\b/.test(s)) return 'who';
  if (/^\s*where\b|\bwhere\b|\blocation of\b|\bfind\b/.test(s)) return 'where';
  if (/^\s*when\b|\bwhat year\b|\bhow long ago\b|\bwhen\b/.test(s)) return 'when';
  if (/^\s*why\b|\bwhy\b/.test(s)) return 'why';
  if (/^\s*how\b/.test(s)) return 'how';
  if (/^\s*(what|which)\b|\bwhat\b/.test(s)) return 'what';
  return 'other';
}

const clean = (raw: string) => raw.replace(/^[#>\-*\s|]+/, '').replace(/\[!\w+\]\s*/g, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
const key = (t: string) => clean(t).toLowerCase();
const lines = (body: string) => String(body ?? '').split(/\n+/).map(clean).filter((t) => t.length >= 20);
const propLines = (groups: PropertyGroup[]) => groups.flatMap((g) => g.rows.map((r) => `${r.key}: ${inlineText(r.value)}`.trim())).filter((t) => t.length >= 8);

/** Crude English stem so "rules" meets "ruled" and "charges" meets "charge". */
export const stem = (w: string) => (w.length > 4 ? w.replace(/(ings?|ed|es|er|s)$/, '') : w);
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

function score(q: string[], text: string, titleWords: string[], entityBonus: number) {
  const w = words(text).map(stem);
  const tw = titleWords.map(stem);
  const hit = q.map(stem).filter((x) => w.some((y) => near(x, y)) || tw.includes(x));
  return hit.length ? hit.length + Math.min(text.length, 200) / 400 + entityBonus : 0;
}

export interface PageRule { page_id: string; knowledge: string | null; multiplier: number; never_sell: number }
export const pageRules = (db: DB, worldId: string) => new Map(all<PageRule>(db, 'SELECT page_id, knowledge, multiplier, never_sell FROM broker_page_rules WHERE world_id = ?', worldId).map((r) => [r.page_id, r]));

/** Pages (and people) the question names, by title or alias. DM side: includes DM-only pages. */
function namedEntities(db: DB, worldId: string, question: string) {
  const s = ` ${question.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const out = new Map<string, { id: string; title: string; shared: boolean; len: number }>();
  const consider = (id: string, name: string, title: string, shared: boolean) => {
    const n = String(name).toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (n.length < 3 || STOP.has(n)) return;
    if (!s.includes(` ${n} `)) return;
    const prev = out.get(id);
    if (!prev || prev.len < n.length) out.set(id, { id, title, shared, len: n.length });
  };
  for (const p of all<any>(db, 'SELECT id, title, aliases, visibility, player_body FROM pages WHERE world_id = ?', worldId)) {
    const shared = p.visibility === 'party' && p.player_body !== null;
    for (const n of [p.title, ...JSON.parse(p.aliases || '[]')]) consider(p.id, n, p.title, shared);
  }
  for (const p of all<any>(db, 'SELECT id, name, visibility FROM people WHERE world_id = ?', worldId)) consider(`person:${p.id}`, p.name, p.name, p.visibility === 'party');
  // A shorter name inside a longer one ("Kesh" in "Old Kesh") is the same thing.
  const list = [...out.values()].sort((a, b) => b.len - a.len);
  return list.filter((e, i) => !list.slice(0, i).some((x) => x.title.toLowerCase().includes(e.title.toLowerCase()) && x.id !== e.id && x.len > e.len)).slice(0, 6).map(({ id, title, shared }) => ({ id, title, shared }));
}

export function classify(db: DB, library: Library, worldId: string, question: string, length: string, asPlayer: Viewer): Classification {
  const type = questionType(question);
  const q = [...new Set(words(question))];
  const entities = namedEntities(db, worldId, question);
  const rules = pageRules(db, worldId);
  const cue = SECRET_CUE.test(question);
  const base = { type, entities, dmEvidence: [] as Classification['dmEvidence'] };
  if (!q.length) return { ...base, verdict: 'unknown', reason: 'No words to look up.', knowledge: 'local', multiplier: 1, player: null };
  const entityIds = new Set(entities.map((e) => e.id));
  const bonus = (pageId: string | null) => (pageId && entityIds.has(pageId) ? 1 : 0);
  // Most of what was asked has to be there, not just a place name.
  const threshold = Math.max(1, Math.ceil(q.length * 0.6));

  // Candidate pages: full-text search on each side, plus the pages the question names.
  const dmViewer: Viewer = { accountId: asPlayer.accountId, role: 'dm' };
  const collect = (v: Viewer) => {
    const ids = new Set<string>((library.search(worldId, q.join(' '), v, 8) as any[]).map((h) => h.id));
    if (ids.size < 4) for (const t of q) for (const h of library.search(worldId, t, v, 4) as any[]) ids.add(h.id);
    for (const e of entities) if (!e.id.startsWith('person:')) ids.add(e.id);
    return [...ids].slice(0, 16);
  };

  // Player side: player copies only (library.get as a player), plus DM notes.
  const playerUnits: Evidence[] = [];
  const playerLineKeys = new Map<string, Set<string>>();
  for (const pid of collect(asPlayer)) {
    let pg: any;
    try { pg = library.get(worldId, pid, asPlayer); } catch { continue; }
    const tw = words(pg.title);
    const keys = new Set<string>();
    for (const text of [...lines(pg.body), ...propLines(pg.properties ?? [])]) {
      keys.add(key(text));
      const sc = score(q, text, tw, bonus(pg.id));
      if (sc) playerUnits.push({ page: pg.id, title: pg.title, text, score: sc, knowledge: null });
    }
    playerLineKeys.set(pg.id, keys);
  }
  for (const n of all<any>(db, 'SELECT * FROM broker_notes WHERE world_id = ? AND active = 1', worldId)) {
    const sc = score(q, `${n.topic} ${n.text}`, words(n.topic), bonus(n.page_id) + 0.5);
    if (!sc) continue;
    const pg = n.page_id ? one<any>(db, 'SELECT title, visibility, player_body FROM pages WHERE id = ?', n.page_id) : null;
    // Cite the page only when players may know it exists.
    const shared = pg && pg.visibility === 'party' && pg.player_body !== null;
    playerUnits.push({ page: shared ? n.page_id : null, title: shared ? pg.title : 'The broker’s own sources', text: n.text, score: sc, knowledge: n.knowledge, note: n.id });
  }

  // DM side: lines players can't read.
  const dmUnits: Evidence[] = [];
  for (const pid of collect(dmViewer)) {
    let pg: any;
    try { pg = library.get(worldId, pid, dmViewer); } catch { continue; }
    if (!playerLineKeys.has(pg.id)) {
      // Find what the player copy holds, if this page is shared at all.
      try {
        const pp: any = library.get(worldId, pid, asPlayer);
        playerLineKeys.set(pg.id, new Set([...lines(pp.body), ...propLines(pp.properties ?? [])].map(key)));
      } catch { playerLineKeys.set(pg.id, new Set()); }
    }
    const seen = playerLineKeys.get(pg.id)!;
    const tw = words(pg.title);
    for (const text of [...lines(pg.body), ...propLines(pg.properties ?? [])]) {
      if (seen.has(key(text))) continue;
      const sc = score(q, text, tw, bonus(pg.id));
      if (sc) dmUnits.push({ page: pg.id, title: pg.title, text, score: sc, knowledge: null });
    }
  }
  playerUnits.sort((a, b) => b.score - a.score);
  dmUnits.sort((a, b) => b.score - a.score);
  const dmEvidence = dmUnits.slice(0, 4).map((u) => ({ page: u.page!, title: u.title, text: u.text }));

  // Never-sell pages can't be sold, but still count as "the broker knows of it".
  const sellable = playerUnits.filter((u) => !(u.page && rules.get(u.page)?.never_sell));
  const pBest = sellable[0]?.score ?? 0;
  const dBest = dmUnits[0]?.score ?? 0;
  const blockedBest = playerUnits[0] && playerUnits[0] !== sellable[0] ? playerUnits[0].score : 0;

  const hiddenEntity = entities.find((e) => !e.shared);
  let verdict: Verdict;
  let reason: string;
  if (hiddenEntity) { verdict = 'secret'; reason = `Names “${hiddenEntity.title}”, which players can't see.`; }
  else if (blockedBest >= threshold && blockedBest >= pBest) { verdict = 'secret'; reason = `The best match is on “${playerUnits[0].title}”, which is set to never sell.`; }
  else if (dBest >= threshold && (pBest < threshold || dBest > pBest + 0.5 || (cue && dBest >= pBest - 0.5))) {
    verdict = 'secret';
    reason = pBest >= threshold ? `DM-only text on “${dmUnits[0].title}” fits the question better than what players can read${cue ? ' (and it asks for the truth behind something)' : ''}.` : `Only DM-only text on “${dmUnits[0].title}” answers it.`;
  } else if (pBest >= threshold) { verdict = 'shared'; reason = `Answered from what players can read (“${sellable[0].title}”).`; }
  else { verdict = 'unknown'; reason = 'Nothing in the library or the broker’s notes matches.'; }

  if (verdict !== 'shared') return { ...base, verdict, reason, knowledge: 'deep', multiplier: 1, player: null, dmEvidence };

  const take = sellable.slice(0, length === 'full' ? 5 : 2);
  const sources = [...new Map(take.map((u) => [u.page ?? `note:${u.title}`, { id: u.page, title: u.title }])).values()];
  let level = 'common';
  let multiplier = 1;
  for (const u of take) {
    const rule = u.page ? rules.get(u.page) : undefined;
    const k = u.knowledge ?? rule?.knowledge ?? (u.page ? one<any>(db, 'SELECT knowledge FROM pages WHERE id = ?', u.page)?.knowledge : null) ?? 'local';
    if ((RANK[k] ?? 1) > (RANK[level] ?? 0)) level = k;
    if (rule) multiplier = Math.max(multiplier, rule.multiplier);
  }
  return { ...base, verdict, reason, knowledge: (RANK[level] !== undefined ? level : 'local') as Knowledge, multiplier, player: { answer: take.map((u) => u.text).join('\n\n'), sources }, dmEvidence };
}
