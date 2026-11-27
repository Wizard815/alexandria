// Live lookups in a world's source through a person's key (the agent's
// `source_lookup` tool). Which keys: only the asker's own (or assigned to
// them) with the `agent` use, never anyone else's, and never a GM's key for a
// player. The source is asked live, but what comes back is only WHICH pages the
// key can see: what a player is shown is the stored player copy of each page,
// and only for a per-user key, and only for a page the player may open (a shared
// page, or one their own key lifts). Anything else (a blanket or unsure key's
// results, a page the library does not have yet, a page above the player's level)
// is escalated: the GM gets it, the player gets "The broker will look into it".
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { normLevel } from '../../core/levels.ts';
import type { Viewer } from '../../core/policy.ts';
import { HttpError } from '../../core/util.ts';
import { escalate, excerpt, LOOKING, type HiddenItem } from './escalation.ts';
import { searchLive, type SourceRow } from './live.ts';
import { auditUse, isPerUser, keysFor } from './store.ts';

export interface LookupResult {
  results: { id: string; title: string; path: string; snippet: string }[];
  /** True when part of the answer needs the GM. Nothing of the hidden part is in this reply. */
  escalated: boolean;
  message: string;
}

const lastCalls = new Map<string, number[]>();
/** At most 60 lookups a minute for one person: each asks the source. */
function throttle(accountId: string) {
  const t = Date.now();
  const mine = (lastCalls.get(accountId) ?? []).filter((x) => t - x < 60_000);
  if (mine.length >= 60) throw new HttpError(429, 'Too many lookups. Wait a minute.');
  mine.push(t);
  lastCalls.set(accountId, mine);
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function lookup(d: Deps, a: { worldId: string; accountId: string; role: 'dm' | 'player' | 'guest'; q: string; question?: string; /** The caller is a model (the agent, MCP): a classified page is not even named to it. */ ai?: boolean }): Promise<LookupResult> {
  const q = a.q.trim().slice(0, 200);
  if (!q) throw new HttpError(400, 'q is required');
  if (a.role === 'guest') throw new HttpError(403, 'Not available to guests');
  throttle(a.accountId);
  const dm = a.role === 'dm';
  const keys = keysFor(d.db, a.worldId, a.accountId, 'agent').slice(0, 4);
  const out: LookupResult = { results: [], escalated: false, message: '' };
  if (!keys.length) { out.message = 'No source key of yours can be used for a live lookup here.'; return out; }
  // The model's own words for the question, kept short; the escalation says what the player was after.
  const question = (a.question?.trim() || q).slice(0, 500);
  const hidden: HiddenItem[] = [];
  let needsDm = false;
  let via = '';
  const seen = new Set<string>();
  for (const k of keys) {
    const src = one<SourceRow>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', k.source_id, a.worldId);
    if (!src) continue;
    auditUse(d.db, k, a.accountId, 'agent', `lookup in ${src.name}`);
    let hits;
    try { hits = await searchLive(d, src, k.secret, q); } catch { out.message ||= 'A source did not answer.'; continue; }
    // The key may have been revoked while the source was asked: nothing from it counts then.
    const now = one<any>(d.db, 'SELECT revoked, trust FROM sourcekeys_keys WHERE id = ?', k.id);
    if (!now || now.revoked) continue;
    const perUser = isPerUser({ trust: now.trust });
    for (const h of hits) {
      const pg = one<any>(d.db, 'SELECT id, path, title, visibility FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', a.worldId, src.id, h.externalId);
      if (dm) {
        if (a.ai && pg && normLevel(pg.visibility) === 'classified') continue;
        // The GM's agent reads the AI copy (never classified); a page it cannot read by id is only named.
        let snippet = '';
        if (pg) { try { snippet = clip((d.library.get(a.worldId, pg.id, { accountId: a.accountId, role: 'dm', audience: 'ai' } as Viewer) as any).body, 600); } catch { /* classified: title only */ } }
        if (!seen.has(`${src.id}|${h.externalId}`)) { seen.add(`${src.id}|${h.externalId}`); out.results.push({ id: pg?.id ?? '', title: pg?.title ?? h.title, path: pg?.path ?? '', snippet }); }
        continue;
      }
      let shown = false;
      if (perUser && pg) {
        try {
          const page = d.library.get(a.worldId, pg.id, { accountId: a.accountId, role: 'player' }) as any;
          if (!seen.has(pg.id)) { seen.add(pg.id); out.results.push({ id: pg.id, title: page.title, path: page.path, snippet: clip(page.body, 600) }); }
          shown = true;
        } catch { /* a page above this player's level */ }
      }
      if (!shown) { needsDm = true; via ||= `${src.name}, key "${k.label || k.id}" (${perUser ? 'per-user' : 'treated as blanket'})`; hidden.push(excerpt(d, a.worldId, src, h.externalId, h.title)); }
    }
  }
  if (needsDm) {
    escalate(d, { worldId: a.worldId, accountId: a.accountId, question, origin: 'agent', hidden: { reason: 'A live lookup through the asker\'s own key found pages their view does not include.', via, items: hidden.slice(0, 12) } });
    out.escalated = true;
    out.message = LOOKING;
  } else if (!out.results.length) out.message ||= 'Nothing found.';
  return out;
}
