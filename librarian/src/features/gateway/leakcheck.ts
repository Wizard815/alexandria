// The runtime leak check: reads each world's library as each player and guest and checks that no run of
// 8 words of GM-only text (GM pages, secret blocks, broker and classified parts, GM transcript lines)
// shows up. It reads through the same library calls the web app, the offline bulk fetch and the MCP read
// tools use (Library.list / get / search, and the global search), so a leak found here is one those would serve.
//
// A run stores when it ran, how many viewers, pages and reads it checked, and for each leak only the world,
// the viewer, the kind of read and the page id. Never the leaked words.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { now, parseJson } from '../../core/util.ts';
import { gmOnlyGrams, grams, treeText } from '../agent/leak.ts';
import { globalSearch } from '../search/global.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_leak_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  worlds INTEGER NOT NULL DEFAULT 0,
  viewers INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  reads INTEGER NOT NULL DEFAULT 0,
  leaks INTEGER NOT NULL DEFAULT 0,
  findings TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
`;

export type Surface = 'list' | 'page' | 'search' | 'global-search';
/** Where a leak was found. Ids and kinds only. */
export interface Finding { world: string; worldName: string; viewer: string; surface: Surface; pageId: string | null; kind: string }

const SEARCH_QUERIES = 40;
const MAX_FINDINGS = 200;
const tick = () => new Promise<void>((r) => setImmediate(r));

let running: Promise<unknown> | null = null;

/** Every string a player's screen or tool could carry for a page. */
function pageTexts(pg: any): string[] {
  const out: string[] = [pg.title ?? '', pg.path ?? '', pg.body ?? '', ...(pg.aliases ?? []), ...(pg.tags ?? [])];
  out.push(treeText(pg.blocks ?? []).join(' '), treeText(pg.properties ?? []).join(' '));
  if (pg.frontmatter) out.push(JSON.stringify(pg.frontmatter));
  for (const t of Object.values(pg.linkTitles ?? {})) out.push(String(t));
  return out;
}

/** Search words that would find GM-only text: titles of pages no player may open, and the first words of GM-only runs. */
function queriesFor(db: DB, worldId: string, gm: Set<string>): string[] {
  const q = new Set<string>();
  for (const p of all<{ title: string }>(db, `SELECT title FROM pages WHERE world_id = ? AND visibility <> 'party' LIMIT ?`, worldId, SEARCH_QUERIES)) q.add(p.title);
  for (const g of gm) { if (q.size >= SEARCH_QUERIES * 2) break; q.add(g.split(' ').slice(0, 3).join(' ')); }
  return [...q].filter((s) => s.trim().length > 1);
}

export interface Summary {
  id: number; startedAt: string; finishedAt: string | null; trigger: string; status: string;
  worlds: number; viewers: number; pages: number; reads: number; leaks: number; error: string | null; findings?: Finding[];
}
const shape = (r: any, withFindings = false): Summary => ({
  id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, trigger: r.trigger, status: r.status,
  worlds: r.worlds, viewers: r.viewers, pages: r.pages, reads: r.reads, leaks: r.leaks, error: r.error,
  ...(withFindings ? { findings: parseJson<Finding[]>(r.findings, []) } : {}),
});

/** The newest runs; the newest one carries its findings. */
export function listRuns(db: DB, limit = 20): Summary[] {
  return all<any>(db, 'SELECT * FROM gateway_leak_runs ORDER BY id DESC LIMIT ?', limit).map((r, i) => shape(r, i === 0));
}
/** The latest run that ended, with its findings. */
export function lastFinished(db: DB): Summary | null {
  const r = one<any>(db, `SELECT * FROM gateway_leak_runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1`);
  return r ? shape(r, true) : null;
}

/** A run left "running" by a restart can never finish. */
export function closeStale(db: DB) {
  if (running) return;
  run(db, `UPDATE gateway_leak_runs SET status = 'error', finished_at = ?, error = 'The server restarted during this run' WHERE status = 'running'`, now());
}

/** Start a run in the background and return its id at once. Only one runs at a time. */
export function startRun(d: Deps, trigger: 'manual' | 'nightly'): { id: number; started: boolean } {
  if (running) return { id: one<{ id: number }>(d.db, `SELECT id FROM gateway_leak_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`)?.id ?? 0, started: false };
  run(d.db, 'INSERT INTO gateway_leak_runs (started_at, trigger) VALUES (?, ?)', now(), trigger);
  const id = one<{ id: number }>(d.db, 'SELECT MAX(id) AS id FROM gateway_leak_runs')!.id;
  running = execute(d, id).catch((e: any) => {
    run(d.db, `UPDATE gateway_leak_runs SET status = 'error', finished_at = ?, error = ? WHERE id = ?`, now(), String(e?.message ?? e).slice(0, 200), id);
  }).finally(() => { running = null; });
  return { id, started: true };
}
/** For tests: wait for the run in progress. */
export const whenDone = async () => { await running; };

async function execute(d: Deps, runId: number): Promise<void> {
  const { db } = d;
  const L = d.library;
  const findings: Finding[] = [];
  let viewers = 0, pages = 0, reads = 0, leaks = 0, worldCount = 0;
  const found = (f: Finding) => { leaks++; if (findings.length < MAX_FINDINGS) findings.push(f); };
  const hit = (texts: string[], gm: Set<string>) => texts.some((t) => { for (const g of grams(t)) if (gm.has(g)) return true; return false; });

  for (const w of all<{ id: string; name: string }>(db, 'SELECT id, name FROM worlds ORDER BY name')) {
    worldCount++;
    const gm = gmOnlyGrams(db, w.id);
    const queries = gm.size ? queriesFor(db, w.id, gm) : [];
    const people = all<{ account_id: string; role: string }>(db, `SELECT account_id, role FROM members WHERE world_id = ? AND role IN ('player', 'guest')`, w.id);
    // Every player and guest, and one guest who has no account at all.
    const subjects: { v: Viewer; label: string }[] = [
      ...people.map((p) => ({ v: { accountId: p.account_id, role: p.role as 'player' | 'guest' }, label: p.account_id })),
      { v: { accountId: '', role: 'guest' as const }, label: 'guest-without-account' },
    ];
    for (const { v, label } of subjects) {
      viewers++;
      const at = (surface: Surface, pageId: string | null, kind: string): Finding => ({ world: w.id, worldName: w.name, viewer: label, surface, pageId, kind });
      // Pages this person's own key or a share lifts to them are judged by the copy they are meant to have: those words are theirs.
      const lifted = v.accountId ? L.liftedInfo(w.id, v.accountId) : new Map();
      const mine = new Set(gm);
      const list = L.list(w.id, v) as any[];
      reads++;
      for (const p of list) if (hit([p.title, p.path, ...(p.tags ?? [])], gm) && !lifted.has(p.id)) found(at('list', p.id, 'page-list'));
      const served: { id: string; texts: string[] }[] = [];
      for (const p of list) {
        let pg: any;
        try { pg = L.get(w.id, p.id, v); } catch { continue; }
        reads++; pages++;
        const texts = pageTexts(pg);
        if (lifted.has(p.id) && one<{ visibility: string }>(db, 'SELECT visibility FROM pages WHERE id = ?', p.id)?.visibility !== 'party') {
          for (const t of texts) for (const g of grams(t)) mine.delete(g);
        } else served.push({ id: p.id, texts });
        if ((pages & 63) === 0) await tick();
      }
      for (const s of served) if (hit(s.texts, mine)) found(at('page', s.id, 'page'));
      for (const q of queries) {
        reads += 2;
        for (const h of L.search(w.id, q, v, 20)) if (hit([h.title, h.snippet, h.path], mine)) found(at('search', h.id, 'page-search'));
        try {
          for (const h of await globalSearch(d, w.id, v, q, { semantic: false, limit: 20 })) {
            if (hit([h.title ?? '', h.snippet ?? ''], mine)) found(at('global-search', h.kind === 'page' ? h.id : null, h.kind));
          }
        } catch { /* a kind of search that is not installed */ }
        await tick();
      }
    }
  }
  run(db, `UPDATE gateway_leak_runs SET status = 'done', finished_at = ?, worlds = ?, viewers = ?, pages = ?, reads = ?, leaks = ?, findings = ? WHERE id = ?`,
    now(), worldCount, viewers, pages, reads, leaks, JSON.stringify(findings), runId);
  run(db, 'DELETE FROM gateway_leak_runs WHERE id NOT IN (SELECT id FROM gateway_leak_runs ORDER BY id DESC LIMIT 60)');
  if (leaks) run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (NULL, NULL, ?, ?, ?)', 'gateway.leak_found', `${leaks} leak${leaks === 1 ? '' : 's'} found by the leak check (run ${runId})`, now());
}
