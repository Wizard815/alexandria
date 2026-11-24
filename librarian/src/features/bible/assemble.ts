// The story bible for one caller: facts of the pages that caller may open now,
// in the caller's own scope (scopes.ts), grouped by subject.
//
//   DM / model   the 'dm' facts (AI copy)
//   broker       the 'broker' facts
//   player       the 'party' facts plus the 'lifted' facts of pages they may open now
//
// Every fact cites its page; a fact whose page the caller can no longer open is
// never returned (checked against the pages table on every read).
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { embed, hasJob, jobConfig } from '../../core/ai.ts';
import type { Viewer } from '../../core/policy.ts';
import { wordsOf } from '../../core/pagesearch.ts';
import { pendingCopies } from '../search/copies.ts';
import { scopeAndPageCoverage } from '../search/embeddings.ts';
import { progress } from '../search/pace.ts';
import { type VecScope, VEC_SCOPES, openable, reachOf, reachScopes } from '../search/scopes.ts';
import { fromBlob, normalize } from '../search/vectorstore.ts';
import { KINDS, normSubject } from './extract.ts';

export interface BibleFact { text: string; kind: string; pages: { id: string; title: string; path: string }[] }
export interface BibleSubject { subject: string; key: string; kind: string; facts: BibleFact[] }
export interface Bible {
  scope: 'dm' | 'broker' | 'party';
  total: number;
  kinds: Record<string, number>;
  subjects: BibleSubject[];
  /** False when no facts have been extracted for this reader yet (no chat model, or still working). */
  ready: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export async function assembleBible(d: Deps, worldId: string, viewer: Viewer, f: { subject?: string; kind?: string; q?: string; limit?: number } = {}): Promise<Bible> {
  const reach = reachOf(d, worldId, viewer);
  const scopes = reachScopes(reach);
  let rows = all<any>(d.db, `SELECT f.id, f.page_id, f.scope, f.subject, f.subject_norm, f.kind, f.fact, f.vec FROM bible_facts f
    WHERE f.world_id = ? AND f.scope IN (${scopes.map(() => '?').join(',')}) ORDER BY f.page_id, f.idx`, worldId, ...scopes)
    .filter((r) => r.scope !== 'lifted' || reach.lifted.has(r.page_id));
  // Belt and braces: the page must still exist and still have the copy this reader gets.
  const ok = openable(d.db, worldId, reach, rows.map((r) => r.page_id));
  rows = rows.filter((r) => ok.has(r.page_id));
  const ready = rows.length > 0;
  if (f.kind && (KINDS as readonly string[]).includes(f.kind)) rows = rows.filter((r) => r.kind === f.kind);
  if (f.subject) {
    const k = normSubject(f.subject);
    if (k) rows = rows.filter((r) => r.subject_norm === k || r.subject_norm.includes(k));
  }
  // ?q= : words in the subject or fact, or near it by meaning (when the embeddings model has read the facts).
  const score = new Map<number, number>();
  if (f.q && f.q.trim()) {
    const w = wordsOf(f.q);
    let qv: Float32Array | null = null;
    if (hasJob(d, 'extra') && rows.some((r) => r.vec)) {
      try { const got = await embed(d, [f.q.slice(0, 300)]); if (got[0]?.length) qv = normalize(got[0]); } catch { /* keywords only */ }
    }
    const min = Number(d.env.ALX_SEARCH_MIN_SIM ?? 0.2);
    for (const r of rows) {
      const hay = `${r.subject} ${r.fact}`.toLowerCase();
      let s = w.length && w.every((x) => hay.includes(x)) ? 1 + (r.subject.toLowerCase().includes(w[0]) ? 0.5 : 0) : 0;
      if (qv && r.vec) {
        const v = fromBlob(r.vec);
        if (v.length === qv.length) { let dot = 0; for (let i = 0; i < qv.length; i++) dot += qv[i] * v[i]; if (dot >= min) s = Math.max(s, dot); }
      }
      if (s > 0) score.set(r.id, s);
    }
    rows = rows.filter((r) => score.has(r.id));
  }
  const pages = new Map(rows.length ? all<any>(d.db, `SELECT id, title, path FROM pages WHERE id IN (${[...new Set(rows.map((r) => r.page_id))].map(() => '?').join(',')})`, ...new Set(rows.map((r) => r.page_id))).map((p) => [p.id, p]) : []);
  // Group by normalized subject; identical facts from several pages are one fact with several citations.
  const groups = new Map<string, { names: Map<string, number>; kinds: Map<string, number>; facts: Map<string, BibleFact>; best: number }>();
  const kinds: Record<string, number> = {};
  for (const r of rows) {
    const pg = pages.get(r.page_id);
    if (!pg) continue;
    let g = groups.get(r.subject_norm);
    if (!g) { g = { names: new Map(), kinds: new Map(), facts: new Map(), best: 0 }; groups.set(r.subject_norm, g); }
    g.names.set(r.subject, (g.names.get(r.subject) ?? 0) + 1);
    g.kinds.set(r.kind, (g.kinds.get(r.kind) ?? 0) + 1);
    g.best = Math.max(g.best, score.get(r.id) ?? 0);
    const fk = norm(r.fact);
    let fact = g.facts.get(fk);
    if (!fact) { fact = { text: r.fact, kind: r.kind, pages: [] }; g.facts.set(fk, fact); kinds[r.kind] = (kinds[r.kind] ?? 0) + 1; }
    if (!fact.pages.some((p) => p.id === pg.id)) fact.pages.push({ id: pg.id, title: pg.title, path: pg.path });
  }
  const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  let subjects: BibleSubject[] = [...groups].map(([key, g]) => ({ subject: top(g.names), key, kind: top(g.kinds), facts: [...g.facts.values()] }));
  if (score.size) { const best = new Map([...groups].map(([k, g]) => [k, g.best])); subjects.sort((a, b) => best.get(b.key)! - best.get(a.key)! || a.subject.localeCompare(b.subject)); }
  else subjects.sort((a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' }));
  const limit = Math.max(1, Math.min(f.limit ?? 300, 1000));
  subjects = subjects.slice(0, limit);
  return { scope: reach.base, total: subjects.reduce((n, s) => n + s.facts.length, 0), kinds, subjects, ready };
}

/** Per scope: pages with a copy, pages not yet read, facts stored. For the Models page. */
export function bibleCoverage(d: Deps, worldId: string) {
  const cfg = jobConfig(d, 'bible');
  const model = cfg ? `${cfg.model}|bible1` : null;
  const facts = new Map(all<any>(d.db, 'SELECT scope, count(*) AS n FROM bible_facts WHERE world_id = ? GROUP BY scope', worldId).map((r) => [r.scope, Number(r.n)]));
  const scopes = {} as Record<VecScope, { eligible: number; pending: number; indexed: number; facts: number }>;
  const cov = scopeAndPageCoverage(d, worldId, 'bible_state', model);
  for (const s of VEC_SCOPES) scopes[s] = { eligible: cov.scopes[s].eligible, pending: cov.scopes[s].pending, indexed: cov.scopes[s].indexed, facts: facts.get(s) ?? 0 };
  return { configured: !!cfg, model: cfg?.model ?? null, scopes, pages: cov.pages, progress: progress('bible', worldId, cov.pages.eligible, cov.pages.indexed) };
}
