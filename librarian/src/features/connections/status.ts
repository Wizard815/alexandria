// What the DM should know about a world's sources right now, in plain words: why players may see nothing, a key the site refuses for
// page content, and a wait for the site. Counts and names only; DM routes and the admin overview use it, players never get it.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { effectiveConfig, normAudience } from '../../intake/connections.ts';
import { limitKeyOf, limiterState } from '../../intake/ratelimit.ts';
import { refusalOf } from '../../intake/detail.ts';
import { ensureTierSchema, queueLength, tieredOf } from '../../intake/tiers.ts';

export interface DmOnlyReason { sourceId: string; source: string; kind: 'audience' | 'unread' | 'hidden' | 'default' | 'refused'; count: number; text: string }
export interface WorldStatus {
  pages: number;
  levels: { party: number; broker: number; dm: number; classified: number };
  /** Set when pages exist and players can see none of them. */
  dmOnly: null | { pages: number; reasons: DmOnlyReason[]; actions: string[] };
  /** Sources whose key is refused for page content (lists work, content does not). */
  refused: { sourceId: string; source: string; message: string }[];
  /** The site is holding calls back: seconds to wait, and why. */
  waiting: null | { seconds: number; reason: 'asked' | 'limit'; source: string };
}

const plural = (n: number, one_: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one_ : many}`;

export function worldStatus(d: { db: DB }, worldId: string): WorldStatus {
  ensureTierSchema(d.db);
  const levels = { party: 0, broker: 0, dm: 0, classified: 0 };
  for (const r of all<any>(d.db, 'SELECT visibility, COUNT(*) AS n FROM pages WHERE world_id = ? GROUP BY visibility', worldId)) {
    if (r.visibility in levels) (levels as any)[r.visibility] = r.n; else levels.dm += r.n;
  }
  const pages = levels.party + levels.broker + levels.dm + levels.classified;
  const sources = all<any>(d.db, 'SELECT * FROM sources WHERE world_id = ? ORDER BY name', worldId);
  const reasons: DmOnlyReason[] = [];
  const refused: WorldStatus['refused'] = [];
  let waiting: WorldStatus['waiting'] = null;
  const actions: string[] = [];
  for (const s of sources) {
    const cfg = effectiveConfig(d.db, s);
    const tiered = !!tieredOf(s.kind, cfg);
    const msg = tiered ? refusalOf(s.id) : null;
    if (msg) refused.push({ sourceId: s.id, source: s.name, message: msg });
    const th = limiterState(limitKeyOf(s, d.db));
    if (th && th.reason !== 'pace' && th.waitMs >= 1000 && (!waiting || th.waitMs > waiting.seconds * 1000)) waiting = { seconds: Math.ceil(th.waitMs / 1000), reason: th.reason, source: s.name };
    const n = (sql: string) => Number(all<any>(d.db, sql, s.id)[0]?.n ?? 0);
    const total = n('SELECT COUNT(*) AS n FROM pages WHERE source_id = ?');
    if (!total) continue;
    const seen = n(`SELECT COUNT(*) AS n FROM pages WHERE source_id = ? AND visibility = 'party'`);
    if (seen === total) continue;
    const audience = normAudience(s.audience);
    if (audience === 'dm') { reasons.push({ sourceId: s.id, source: s.name, kind: 'audience', count: total, text: `${s.name}: its audience is "DM only", so all ${plural(total, 'page', 'pages')} stay with you.` }); continue; }
    const unread = n(`SELECT COUNT(*) AS n FROM pages WHERE source_id = ? AND depth = 'index'`);
    if (unread) reasons.push({ sourceId: s.id, source: s.name, kind: 'unread', count: unread, text: `${s.name}: ${plural(unread, 'page is', 'pages are')} only listed so far. The source has not said who may read them until their details are read.` });
    const hidden = n(`SELECT COUNT(*) AS n FROM pages WHERE source_id = ? AND depth <> 'index' AND source_shared = 0`);
    if (hidden) reasons.push({ sourceId: s.id, source: s.name, kind: 'hidden', count: hidden, text: `${s.name}: ${plural(hidden, 'page is', 'pages are')} hidden at the source, so they stay DM-only.` });
    if (s.default_visibility !== 'party' && audience === 'auto') {
      const shared = n(`SELECT COUNT(*) AS n FROM pages WHERE source_id = ? AND depth <> 'index' AND source_shared = 1 AND visibility <> 'party'`);
      if (shared) reasons.push({ sourceId: s.id, source: s.name, kind: 'default', count: shared, text: `${s.name}: ${plural(shared, 'page is', 'pages are')} shared at the source, but its default visibility is "DM only".` });
    }
    if (msg) reasons.push({ sourceId: s.id, source: s.name, kind: 'refused', count: 0, text: `${s.name}: ${msg}` });
  }
  let dmOnly: WorldStatus['dmOnly'] = null;
  if (pages > 0 && levels.party === 0 && sources.length > 0) {
    if (reasons.some((r) => r.kind === 'audience' || r.kind === 'default')) actions.push('Set the source\'s audience (or its default visibility) to share with players: it applies at once, including to pages already read.');
    if (reasons.some((r) => r.kind === 'unread')) {
      const waitingPages = sources.reduce((a, s) => a + (tieredOf(s.kind, effectiveConfig(d.db, s)) ? queueLength(d.db, s.id, true) : 0), 0);
      actions.push(`Wait for the details to be read${waitingPages ? ` (${waitingPages.toLocaleString()} still waiting)` : ''}, or open a page yourself to read it now.`);
    }
    if (refused.length) actions.push('Check the key\'s role: this key lists pages but is refused their content.');
    if (!reasons.length) actions.push('Nothing marks these pages as shared yet. Pages are shared only when their source says so.');
    dmOnly = { pages, reasons, actions };
  }
  return { pages, levels, dmOnly, refused, waiting };
}
