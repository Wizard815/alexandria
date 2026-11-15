// World context for a sculpt, resolved once per request without a model:
// the clock's date and season, the party, the current location, page excerpts,
// and the DM-only word runs the leak check compares against.
import { createHash } from 'node:crypto';
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { getClock } from '../clock/api.ts';
import { dmOnlyGrams, grams } from '../agent/leak.ts';

export interface Overrides { location?: string; partyLevel?: number | string }

const PLAYER: Viewer = { accountId: 'sculpt-player-view', role: 'player' };
const AI: Viewer = { accountId: 'sculpt-dm-view', role: 'dm', audience: 'ai' };

export const bodyHash = (body: string) => createHash('sha256').update(body).digest('hex').slice(0, 32);
const excerpt = (s: string, n: number) => s.replace(/^#+\s.*$/gm, ' ').replace(/> \[!\w+\][^\n]*/g, ' ').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

/** The text of `> [!secret]` blocks in a page body: what stays DM-only on a page Sculpting saved. */
export function secretText(md: string): string {
  const out: string[] = [];
  let on = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^>\s*\[!secret\]/i.test(line)) { on = true; out.push(line.replace(/^>\s*\[!secret\][^\s]*\s?/i, '')); continue; }
    if (on && /^>/.test(line)) { out.push(line.replace(/^>\s?/, '')); continue; }
    on = false;
  }
  return out.join('\n');
}

export interface RenderCtx {
  d: Deps;
  worldId: string;
  player: boolean;
  overrides: Overrides;
  vars(): Record<string, string>;
  partyLevel(): number;
  season(): string;
  coinSetting(): string;
  page(ref: string): { title: string; excerpt: string; id: string } | null;
  /** Can a player open this page? */
  playerCanSee(ref: string): boolean;
  /** DM-only word runs. Pages Sculpting saved count only for their secret blocks. */
  dmGrams(): Set<string>;
}

export function makeCtx(d: Deps, worldId: string, player: boolean, overrides: Overrides = {}): RenderCtx {
  let vars: Record<string, string> | null = null;
  let level: number | null = null;
  let dm: Set<string> | null = null;
  const pages = new Map<string, { title: string; excerpt: string; id: string } | null>();

  const pageId = (ref: string): string | null => {
    const r = ref.trim();
    if (!r) return null;
    return one<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND (id = ? OR title = ? COLLATE NOCASE OR path = ? OR path = ?) ORDER BY (id = ?) DESC, (path = ? OR path = ?) DESC, (visibility = 'party') DESC LIMIT 1`, worldId, r, r, r, `${r}.md`, r, r, `${r}.md`)?.id ?? null;
  };

  const c: RenderCtx = {
    d, worldId, player, overrides,
    partyLevel() {
      if (level !== null) return level;
      const o = Number(overrides.partyLevel);
      if (Number.isFinite(o) && o >= 1 && o <= 20) return (level = Math.floor(o));
      const found: number[] = [];
      try {
        for (const r of all<any>(d.db, `SELECT title, body FROM profile_blocks WHERE world_id = ? AND lower(title) IN ('level', 'character level')`, worldId)) {
          const n = parseInt(String(r.body).match(/\d+/)?.[0] ?? '', 10);
          if (n >= 1 && n <= 20) found.push(n);
        }
      } catch { /* no profile table */ }
      found.sort((a, b) => a - b);
      return (level = found.length ? found[Math.floor(found.length / 2)] : 3);
    },
    season() { return c.vars()['world.season'] ?? ''; },
    coinSetting() {
      try { return String(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings?.match(/"coins":"(\w+)"/)?.[1] ?? 'gsc'); } catch { return 'gsc'; }
    },
    vars() {
      if (vars) return vars;
      const v: Record<string, string> = {};
      try {
        const clock = getClock(d.db, worldId);
        v['world.date'] = clock.label;
        v['world.time'] = clock.date.timeOfDay ?? '';
        v['world.season'] = clock.date.season ?? '';
        v['world.weekday'] = clock.date.weekday ?? '';
        v['world.year'] = String(clock.date.year);
      } catch { /* no clock yet */ }
      v['world.name'] = one<any>(d.db, 'SELECT name FROM worlds WHERE id = ?', worldId)?.name ?? '';
      let names: string[] = [];
      try {
        names = all<any>(d.db, `SELECT COALESCE(NULLIF(m.character_name, ''), a.display_name) AS n FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player' ORDER BY a.display_name`, worldId).map((r) => String(r.n));
      } catch { /* none */ }
      v['party.names'] = names.join(', ');
      v['party.size'] = names.length ? String(names.length) : '';
      let known = false;
      try { known = all<any>(d.db, `SELECT 1 FROM profile_blocks WHERE world_id = ? AND lower(title) IN ('level', 'character level') LIMIT 1`, worldId).length > 0; } catch { /* none */ }
      v['party.level'] = known || overrides.partyLevel ? String(c.partyLevel()) : '';
      let loc = (overrides.location ?? '').trim();
      if (!loc) {
        try {
          const row = one<any>(d.db, `SELECT p.title FROM stage_cards s JOIN pages p ON p.id = s.ref WHERE s.world_id = ? AND s.kind = 'place' AND s.shown_at IS NOT NULL ORDER BY s.shown_at DESC LIMIT 1`, worldId);
          loc = row?.title ?? '';
        } catch { /* no stage */ }
      }
      v.location = loc;
      return (vars = v);
    },
    page(ref) {
      const k = ref.trim().toLowerCase();
      if (pages.has(k)) return pages.get(k)!;
      let out: { title: string; excerpt: string; id: string } | null = null;
      const id = pageId(ref);
      if (id) {
        try {
          // Players get the player copy; a DM template the AI copy, which has no classified text.
          const pg: any = d.library.get(worldId, id, player ? PLAYER : AI);
          out = { id, title: String(pg.title), excerpt: excerpt(String(pg.body ?? ''), 600) };
        } catch { out = null; }
      }
      pages.set(k, out);
      return out;
    },
    playerCanSee(ref) {
      const r = ref.trim();
      const ids = all<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND (id = ? OR title = ? COLLATE NOCASE OR path = ? OR path = ?)', worldId, r, r, r, `${r}.md`).map((x) => x.id);
      if (!ids.length) return true; // not a page: just text
      return ids.some((id) => { try { d.library.get(worldId, id, PLAYER); return true; } catch { return false; } });
    },
    dmGrams() {
      if (dm) return dm;
      let saved = new Map<string, string>();
      try { saved = new Map(all<any>(d.db, 'SELECT page_id, body_hash FROM sculpt_player_pages WHERE world_id = ?', worldId).map((r) => [r.page_id, r.body_hash])); } catch { /* older database */ }
      const skipped: string[] = [];
      dm = dmOnlyGrams(d.db, worldId, (pid, body) => { if (saved.get(pid) === bodyHash(body)) { skipped.push(body); return true; } return false; });
      for (const b of skipped) for (const g of grams(secretText(b))) dm.add(g);
      return dm;
    },
  };
  return c;
}

/** The first run of DM-only words this text repeats, if any. */
export function firstLeak(rc: RenderCtx, text: string): string | null {
  const dm = rc.dmGrams();
  if (!dm.size) return null;
  for (const g of grams(text)) if (dm.has(g)) return g;
  return null;
}
