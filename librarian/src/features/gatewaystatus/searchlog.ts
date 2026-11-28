// What people search for. Every library search, the global search box, the admin's search and the agent's search tool leave one row:
// the world, who (a role, never a name), the query in plain lower case, how many results, and how they split across sources.
// Never a result title or page text. Rows are kept 30 days.
//
// The words people typed can be a GM's own question about a secret, so the admin pages show them only to an admin who is that world's
// GM. Any other admin sees counts.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { adminViewer } from '../gateway/worlds.ts';

export const SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS gwstatus_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  origin TEXT NOT NULL,
  q TEXT NOT NULL,
  results INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS gwstatus_searches_at ON gwstatus_searches (world_id, at);
-- Missing queries a GM has already had a draft page made for.
CREATE TABLE IF NOT EXISTS gwstatus_search_drafts (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  q TEXT NOT NULL,
  page_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, q)
);
`;

export type SearchRole = 'gm' | 'player' | 'guest' | 'ai' | 'admin';
export type SearchOrigin = 'library' | 'global' | 'admin' | 'agent';
export const RETENTION_DAYS = 30;

/** The query as it is kept: lower case, plain letters and digits, one space between words. */
export function normalizeQuery(q: unknown): string {
  return String(q ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}'\- ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

const recent = new Map<string, number>();
let lastPrune = 0;
/** Tests: count the same search twice in a row as two. */
export const forgetRecentSearches = () => recent.clear();

/** Who searched, as a role: a model is `ai`, an admin reading across worlds `admin`. */
export const roleOf = (v: { role?: string; audience?: string } | undefined, model = false): SearchRole =>
  model || v?.audience === 'ai' ? 'ai' : v?.role === 'gm' ? 'gm' : v?.role === 'guest' ? 'guest' : 'player';

/**
 * Record one search. Never throws and never slows a search much: a table that is not there, or a bad row, is ignored. The same query from the
 * same role in the same world within 4 seconds is one search (a box that searches as you type).
 */
export function logSearch(db: DB, s: { worldId: string; role: SearchRole; origin: SearchOrigin; q: string; hitIds: string[] }) {
  try {
    const q = normalizeQuery(s.q);
    if (q.length < 2) return;
    const t = Date.now();
    const key = `${s.worldId}|${s.role}|${s.origin}|${q}`;
    if ((recent.get(key) ?? 0) > t - 4000) return;
    recent.set(key, t);
    if (recent.size > 2000) for (const [k, v] of recent) if (v < t - 4000) recent.delete(k);
    const mix: Record<string, number> = {};
    const ids = [...new Set(s.hitIds)].slice(0, 200);
    if (ids.length) {
      for (const r of all<{ name: string | null; n: number }>(db, `SELECT s.name AS name, COUNT(*) AS n FROM pages p LEFT JOIN sources s ON s.id = p.source_id
        WHERE p.world_id = ? AND p.id IN (${ids.map(() => '?').join(',')}) GROUP BY s.name`, s.worldId, ...ids)) mix[r.name ?? 'Written here'] = r.n;
    }
    run(db, 'INSERT INTO gwstatus_searches (world_id, at, role, origin, q, results, sources) VALUES (?, ?, ?, ?, ?, ?, ?)', s.worldId, now(), s.role, s.origin, q, s.hitIds.length, JSON.stringify(mix));
    if (t - lastPrune > 3600_000) { lastPrune = t; prune(db); }
  } catch { /* a search is never held up by its log */ }
}

export function prune(db: DB, days = RETENTION_DAYS) {
  const cut = new Date(Date.now() - days * 864e5).toISOString();
  run(db, 'DELETE FROM gwstatus_searches WHERE at < ?', cut);
  run(db, 'DELETE FROM gwstatus_search_drafts WHERE at < ?', cut);
}

interface Row { world_id: string; at: string; role: string; origin: string; q: string; results: number; sources: string }

/** The log for the last `days` days as one admin may read it. */
export function searchStats(d: Deps, accountId: string, days = 7) {
  prune(d.db);
  const span = Math.max(1, Math.min(RETENTION_DAYS, Math.round(days) || 7));
  const since = new Date(Date.now() - span * 864e5).toISOString();
  const worlds = all<{ id: string; name: string }>(d.db, 'SELECT id, name FROM worlds ORDER BY name');
  const rows = all<Row>(d.db, 'SELECT world_id, at, role, origin, q, results, sources FROM gwstatus_searches WHERE at >= ? ORDER BY at DESC LIMIT 60000', since);
  const drafted = new Set(all<{ world_id: string; q: string }>(d.db, 'SELECT world_id, q FROM gwstatus_search_drafts').map((r) => `${r.world_id}\n${r.q}`));
  const isGm = new Map(worlds.map((w) => [w.id, adminViewer(d.db, w.id, accountId).role === 'gm']));
  const bySource = new Map<string, number>();
  const byOrigin = new Map<string, number>();
  const byDay = new Map<string, { searches: number; nothing: number }>();
  const perWorld = new Map<string, { searches: number; nothing: number }>(worlds.map((w) => [w.id, { searches: 0, nothing: 0 }]));
  const popular = new Map<string, { world: string; q: string; count: number; lastAt: string; results: number }>();
  const nothing = new Map<string, { world: string; q: string; count: number; lastAt: string }>();
  let hiddenQueries = 0;
  for (const r of rows) {
    const w = perWorld.get(r.world_id);
    if (!w) continue;
    w.searches++;
    const day = byDay.get(r.at.slice(0, 10)) ?? { searches: 0, nothing: 0 };
    day.searches++;
    if (r.results === 0) { w.nothing++; day.nothing++; }
    byDay.set(r.at.slice(0, 10), day);
    byOrigin.set(r.origin, (byOrigin.get(r.origin) ?? 0) + 1);
    // Source names are the admin's own configuration, and the split is counts: shown for every world.
    try { for (const [name, n] of Object.entries(JSON.parse(r.sources || '{}') as Record<string, number>)) bySource.set(name, (bySource.get(name) ?? 0) + Number(n)); } catch { /* bad row */ }
    if (!isGm.get(r.world_id)) { hiddenQueries++; continue; }
    const k = `${r.world_id}\n${r.q}`;
    const p = popular.get(k) ?? { world: r.world_id, q: r.q, count: 0, lastAt: r.at, results: 0 };
    p.count++; p.results += r.results; if (r.at > p.lastAt) p.lastAt = r.at;
    popular.set(k, p);
    if (r.results === 0) {
      const n = nothing.get(k) ?? { world: r.world_id, q: r.q, count: 0, lastAt: r.at };
      n.count++; if (r.at > n.lastAt) n.lastAt = r.at;
      nothing.set(k, n);
    }
  }
  const nameOf = new Map(worlds.map((w) => [w.id, w.name]));
  // A query that found something often enough is not "found nothing": only those whose latest search found nothing stay.
  const latest = new Map<string, number>();
  for (const r of rows) { const k = `${r.world_id}\n${r.q}`; if (!latest.has(k)) latest.set(k, r.results); }
  return {
    days: span, since, retentionDays: RETENTION_DAYS,
    totals: { searches: rows.length, nothing: rows.filter((r) => r.results === 0).length, hiddenQueries },
    worlds: worlds.map((w) => ({ id: w.id, name: w.name, view: isGm.get(w.id) ? 'gm' : 'counts', ...perWorld.get(w.id)! })),
    popular: [...popular.values()].sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, 30)
      .map((p) => ({ world: { id: p.world, name: nameOf.get(p.world) }, q: p.q, count: p.count, lastAt: p.lastAt, avgResults: Math.round((p.results / p.count) * 10) / 10 })),
    nothing: [...nothing.values()].filter((n) => latest.get(`${n.world}\n${n.q}`) === 0).sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, 30)
      .map((n) => ({ world: { id: n.world, name: nameOf.get(n.world) }, q: n.q, count: n.count, lastAt: n.lastAt, drafted: drafted.has(`${n.world}\n${n.q}`) })),
    bySource: [...bySource].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    byOrigin: [...byOrigin].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count),
    byDay: [...byDay].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

const slug = (q: string) => q.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
const titleOf = (q: string) => (q.charAt(0).toUpperCase() + q.slice(1)).slice(0, 80);

/**
 * GM-only draft pages for queries that found nothing. Only the GM of the world may do this, and only for queries the log shows found
 * nothing in the last 7 days, so it cannot be used to write arbitrary pages. A page that already exists at the path is left alone.
 */
export function draftMissing(d: Deps, accountId: string, worldId: string, queries: unknown) {
  if (!one(d.db, 'SELECT 1 FROM worlds WHERE id = ?', worldId)) throw new HttpError(404, 'World not found');
  if (adminViewer(d.db, worldId, accountId).role !== 'gm') throw new HttpError(403, 'Only the world\'s GM can make draft pages from its searches');
  const wanted = Array.isArray(queries) ? queries.map(normalizeQuery).filter(Boolean).slice(0, 30) : null;
  const missing = searchStats(d, accountId, 7).nothing.filter((n) => n.world.id === worldId && !n.drafted);
  const list = wanted ? missing.filter((m) => wanted.includes(m.q)) : missing.slice(0, 20);
  const created: { q: string; pageId: string; path: string }[] = [];
  const skipped: string[] = [];
  for (const m of list) {
    const p = `drafts/${slug(m.q)}.md`;
    if (one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', worldId, p)) { skipped.push(m.q); continue; }
    const saved = d.library.save(worldId, {
      path: p, title: titleOf(m.q), visibility: 'gm', frontmatter: { draft: true, tags: ['draft'] },
      body: `# ${titleOf(m.q)}\n\n*Draft. ${m.count} ${m.count === 1 ? 'search' : 'searches'} for this found nothing in the last week. Write what people should find here, then share it.*\n`,
    }, accountId);
    run(d.db, 'INSERT OR REPLACE INTO gwstatus_search_drafts (world_id, q, page_id, at) VALUES (?, ?, ?, ?)', worldId, m.q, saved.id, now());
    created.push({ q: m.q, pageId: saved.id, path: saved.path });
  }
  if (created.length) run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, 'search.draft', `${created.length} draft pages from missing searches`, now());
  return { created, skipped };
}

