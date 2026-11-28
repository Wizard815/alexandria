// "Other": questions about the game rather than the world. They are free and
// answered at once, and they are never a price tier.
//   rules: from the world's game module (features/modules searchRules), with
//          citations; never from memory.
//   item:  from the item's own card (the player-visible note and the player
//          copy of its linked library page), only for items the asker can see
//          (their own and the party stash).
import { ruleMatches } from '../mods/assist.ts';
import { enabledMods, type Installed } from '../mods/store.ts';
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { lines } from '../../core/brokerClassify.ts';
import type { Viewer } from '../../core/policy.ts';
import { searchRules } from '../modules/search.ts';

export interface OtherAnswer { answer: string; sources: { id: string | null; title: string }[] }
export interface VisibleItem { id: string; name: string; qty: number; note: string; page_id: string | null }

const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`);
const norm = (t: string) => ` ${t.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** Items this account can see: its own and the party stash, approved only. */
export function visibleItems(d: Deps, worldId: string, accountId: string): VisibleItem[] {
  return all<VisibleItem>(d.db, `SELECT id, name, qty, COALESCE(note, '') AS note, page_id FROM items WHERE world_id = ? AND status = 'approved' AND (owner = ? OR owner = 'party') ORDER BY length(name) DESC`, worldId, accountId);
}

export function findItem(items: VisibleItem[], question: string): VisibleItem | null {
  const s = norm(question);
  return items.find((i) => i.name.trim().length >= 3 && s.includes(norm(i.name))) ?? null;
}

export function rulesAnswer(d: Deps, worldId: string, question: string): OtherAnswer {
  // The table's homebrew rules that the question is about come first: they change the rules book at this table.
  const home = homebrewFor(d, worldId, question);
  const hits = searchRules(d.db, worldId, question, 1).filter((h: any) => !home.some((m) => m.rules.some((r) => r.term === h.term)));
  if (!hits.length && !home.length) return { answer: 'I have no rules book that covers that, and I won’t guess. Ask your DM.', sources: [] };
  const homeLines = home.map((m) => `${m.name} (house rule at this table): ${clip((m.assistant?.player || m.rules.map((r) => r.text).join(' ')).replace(/\*\*/g, ''), 600)}`);
  return {
    answer: [...homeLines, ...hits.map((h: any) => `${h.term}${home.length ? ' (the rules book)' : ''}: ${clip(String(h.passage || h.summary), 600)}`)].join('\n\n'),
    sources: [...home.map((m) => ({ id: null, title: `House rule: ${m.name}` })), ...hits.map((h: any) => ({ id: null, title: String(h.citation) }))],
  };
}

/** Homebrew rules that are on and that the question names (their words, name or the 5e phrases they change). */
function homebrewFor(d: Deps, worldId: string, question: string) {
  let on: Installed[] = [];
  try { on = enabledMods(d.db, worldId); } catch { return []; }
  return on.filter((m) => (m.mod.homebrew || m.mod.assistant?.always) && ruleMatches(m, question)).slice(0, 3).map((m) => m.mod);
}

export function itemAnswer(d: Deps, worldId: string, accountId: string, question: string): OtherAnswer {
  const it = findItem(visibleItems(d, worldId, accountId), question);
  if (!it) return { answer: 'I don’t see anything like that among the things you carry.', sources: [] };
  const parts = [`${it.name}${it.qty > 1 ? ` (×${it.qty})` : ''}.`];
  if (it.note.trim()) parts.push(it.note.trim());
  const sources: OtherAnswer['sources'] = [];
  if (it.page_id) {
    try {
      // Always the player copy, whoever is asking.
      const viewer: Viewer = { accountId, role: 'player' };
      const pg: any = d.library.get(worldId, it.page_id, viewer);
      const text = lines(pg.body).slice(0, 3).join(' ');
      if (text) parts.push(clip(text, 700));
      sources.push({ id: pg.id, title: pg.title });
    } catch { /* page hidden or gone: the item alone */ }
  }
  if (parts.length === 1) parts.push('Nothing more is written down about it.');
  return { answer: parts.join(' '), sources };
}
