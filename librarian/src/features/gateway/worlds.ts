// What the gateway admin's Worlds page shows beside each world, and the two things an admin may set there:
// which pages in two sources are the same thing, and which source wins when they disagree.
//
// Being an admin does not open a world. Page titles shown here are the ones this admin may read: party-level pages,
// or every page of a world whose DM they are. Pairs that involve other pages are only counted.
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { normName } from '../../core/pagesearch.ts';
import { names } from '../../routes/_shared.ts';

export const SCHEMA = `
-- Which pages of one world, from two sources, are the same thing (an admin's decision). a_id < b_id.
CREATE TABLE IF NOT EXISTS gateway_page_links (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('linked', 'different')),
  decided_by TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (world_id, a_id, b_id)
);
-- How a world settles two sources that disagree. first: a source id, or 'newest'. show_both: show the DM both versions.
CREATE TABLE IF NOT EXISTS gateway_world_prefs (
  world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  first TEXT NOT NULL DEFAULT 'newest',
  show_both INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);
`;

const rows = <T>(db: DB, sql: string, ...args: unknown[]): T[] => { try { return all<T>(db, sql, ...args); } catch { return []; } };

/** The viewer an admin reads a world as: the DM's copy only where they are that world's DM, otherwise the party copy. */
export function adminViewer(db: DB, worldId: string, accountId: string): Viewer {
  const m = one<{ role: string }>(db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', worldId, accountId);
  if (m?.role === 'dm') return { accountId, role: 'dm' };
  return { accountId, role: m?.role === 'player' ? 'player' : 'guest' };
}

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

interface PageRow { id: string; title: string; visibility: string; source_id: string; source_name: string }

/** Pages with the same normalized title in two different sources. */
function suggestions(d: Deps, worldId: string, accountId: string) {
  const { db } = d;
  const isDm = adminViewer(db, worldId, accountId).role === 'dm';
  const pages = rows<PageRow>(db, `SELECT p.id, p.title, p.visibility, p.source_id, s.name AS source_name FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE p.world_id = ? AND p.source_id IS NOT NULL`, worldId);
  const byName = new Map<string, PageRow[]>();
  for (const p of pages) {
    const k = normName(p.title);
    if (k.length < 3) continue;
    byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const decided = new Map(rows<{ a_id: string; b_id: string; status: string }>(db, 'SELECT a_id, b_id, status FROM gateway_page_links WHERE world_id = ?', worldId).map((r) => [`${r.a_id}|${r.b_id}`, r.status]));
  const shown: any[] = [];
  let hidden = 0;
  for (const group of byName.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const [x, y] = [group[i], group[j]];
      if (x.source_id === y.source_id) continue;
      const [a, b] = pair(x.id, y.id);
      const status = decided.get(`${a}|${b}`) ?? 'suggested';
      if (!isDm && (x.visibility !== 'party' || y.visibility !== 'party')) { hidden++; continue; }
      const [ax, bx] = a === x.id ? [x, y] : [y, x];
      shown.push({ a: { id: ax.id, title: ax.title, source: ax.source_name }, b: { id: bx.id, title: bx.title, source: bx.source_name }, status });
    }
  }
  shown.sort((p, q) => (p.status === 'suggested' ? 0 : 1) - (q.status === 'suggested' ? 0 : 1) || p.a.title.localeCompare(q.a.title));
  return { pairs: shown.slice(0, 50), total: shown.length, hidden, open: shown.filter((p) => p.status === 'suggested').length };
}

export function worldCards(d: Deps, worldId: string, accountId: string) {
  const { db } = d;
  const nm = names(db, worldId);
  const keys = rows<{ trust: string }>(db, 'SELECT trust FROM sourcekeys_keys WHERE world_id = ? AND revoked = 0', worldId);
  const settings = parseJson<Record<string, unknown>>(one<{ settings: string }>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {});
  const viewer = adminViewer(db, worldId, accountId);
  const shares = rows<{ page_id: string; from_id: string; to_id: string; kind: string; title: string | null; visibility: string | null }>(db,
    `SELECT s.page_id, s.from_id, s.to_id, s.kind, p.title, p.visibility FROM sourcekeys_shares s LEFT JOIN pages p ON p.id = s.page_id WHERE s.world_id = ? ORDER BY s.created_at DESC`, worldId);
  const sources = rows<{ id: string; name: string }>(db, 'SELECT id, name FROM sources WHERE world_id = ? ORDER BY name', worldId);
  const prefs = one<{ first: string; show_both: number }>(db, 'SELECT first, show_both FROM gateway_world_prefs WHERE world_id = ?', worldId);
  return {
    keys: {
      total: keys.length, perUser: keys.filter((k) => k.trust === 'per-user').length, blanket: keys.filter((k) => k.trust === 'blanket').length, unsure: keys.filter((k) => k.trust === 'unsure').length,
      playersMayAdd: settings.sourceKeysPlayers !== false,
    },
    shares: {
      total: shares.length,
      withParty: shares.filter((s) => s.to_id === '*').length,
      withChosen: shares.filter((s) => s.to_id !== '*').length,
      recent: shares.slice(0, 5).map((s) => ({
        from: s.kind === 'dm' ? 'DM' : nm[s.from_id] ?? 'Someone', to: s.to_id === '*' ? 'the party' : nm[s.to_id] ?? 'Someone',
        // A title is shown only where this admin could read the page anyway.
        page: s.title && (s.visibility === 'party' || viewer.role === 'dm') ? s.title : null,
      })),
    },
    sameThing: suggestions(d, worldId, accountId),
    disagree: { first: prefs?.first ?? 'newest', showBoth: prefs ? !!prefs.show_both : true, sources, stored: !!prefs },
  };
}

export function setLink(d: Deps, worldId: string, accountId: string, aId: unknown, bId: unknown, status: unknown) {
  if (typeof aId !== 'string' || typeof bId !== 'string' || aId === bId) throw new HttpError(400, 'Name two different pages');
  if (status !== 'linked' && status !== 'different' && status !== 'clear') throw new HttpError(400, 'status must be linked, different or clear');
  const viewer = adminViewer(d.db, worldId, accountId);
  for (const id of [aId, bId]) {
    const p = one<{ visibility: string; source_id: string | null }>(d.db, 'SELECT visibility, source_id FROM pages WHERE world_id = ? AND id = ?', worldId, id);
    // A page this admin may not read is the same as a page that is not there.
    if (!p || !p.source_id || (viewer.role !== 'dm' && p.visibility !== 'party')) throw new HttpError(404, 'Page not found');
  }
  const [a, b] = pair(aId, bId);
  if (status === 'clear') run(d.db, 'DELETE FROM gateway_page_links WHERE world_id = ? AND a_id = ? AND b_id = ?', worldId, a, b);
  else run(d.db, `INSERT INTO gateway_page_links (world_id, a_id, b_id, status, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(world_id, a_id, b_id) DO UPDATE SET status = excluded.status, decided_by = excluded.decided_by, decided_at = excluded.decided_at`, worldId, a, b, status, accountId, now());
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, 'gateway.link', status, now());
}

export function setPrefs(d: Deps, worldId: string, accountId: string, body: any) {
  const cur = one<{ first: string; show_both: number }>(d.db, 'SELECT first, show_both FROM gateway_world_prefs WHERE world_id = ?', worldId);
  let first = cur?.first ?? 'newest';
  if (body?.first !== undefined) {
    if (typeof body.first !== 'string') throw new HttpError(400, 'first must be a source id or "newest"');
    if (body.first !== 'newest' && !one(d.db, 'SELECT 1 FROM sources WHERE id = ? AND world_id = ?', body.first, worldId)) throw new HttpError(400, 'That source is not in this world');
    first = body.first;
  }
  let showBoth = cur ? !!cur.show_both : true;
  if (body?.showBoth !== undefined) {
    if (typeof body.showBoth !== 'boolean') throw new HttpError(400, 'showBoth must be true or false');
    showBoth = body.showBoth;
  }
  run(d.db, `INSERT INTO gateway_world_prefs (world_id, first, show_both, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(world_id) DO UPDATE SET first = excluded.first, show_both = excluded.show_both, updated_at = excluded.updated_at`, worldId, first, showBoth ? 1 : 0, now());
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, 'gateway.prefs', '', now());
}
