// "Recently": the people and places named in the latest published session
// summaries, as the player may see them. A name counts when it is a person
// the party knows (People), or a library page the player can open that is a
// place or a character (by its kind, tags and folder), and the summary names
// it. Bold names under "People met" count too, even with no page yet. It is
// worked out on each read, so a new summary shows up as soon as it is
// published.
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { canSee, type Viewer } from '../../core/policy.ts';
import { tiesFrom } from '../generators/world.ts';

export interface Recent { name: string; personId?: string; pageId?: string; session: number; sessionTitle: string }

const PERSON_RE = /\b(npcs?|characters?|people|persons?|folk|creatures?)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (text: string, name: string) => name.trim().length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(name.trim())}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/** Bold names in the "People met" section ("- **Mira** the smith…"). */
function peopleMet(md: string): string[] {
  const m = md.match(/^##\s*People met\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im);
  if (!m) return [];
  return [...m[1].matchAll(/\*\*([^*\n]{2,60})\*\*/g)].map((x) => x[1].trim());
}

export function recentFor(d: Deps, worldId: string, viewer: Viewer, sessions = 3, cap = 12): { people: Recent[]; places: Recent[]; sessions: { number: number; title: string }[] } {
  let entries: any[] = [];
  try { entries = all<any>(d.db, 'SELECT number, title, summary FROM sessionlog_entries WHERE world_id = ? AND unpublished_at IS NULL ORDER BY number DESC LIMIT ?', worldId, sessions); } catch { /* no session log */ }
  if (!entries.length) return { people: [], places: [], sessions: [] };
  const known = all<any>(d.db, 'SELECT id, name, page_id, visibility FROM people WHERE world_id = ?', worldId).filter((p) => canSee(viewer, p.visibility, null));
  const pages = d.library.list(worldId, viewer) as { id: string; title: string; path: string; kind: string | null; tags: string[] }[];
  const { places } = tiesFrom(pages);
  const persons = pages.filter((p) => PERSON_RE.test(`${p.kind ?? ''} ${p.tags.join(' ')} ${p.path.split('/').slice(0, -1).join(' ')}`));
  const outPeople: Recent[] = [], outPlaces: Recent[] = [];
  const seenP = new Set<string>(), seenL = new Set<string>();
  const add = (list: Recent[], seen: Set<string>, r: Recent) => { const k = r.name.toLowerCase(); if (seen.has(k) || list.length >= cap) return; seen.add(k); list.push(r); };
  for (const e of entries) {
    const text = String(e.summary ?? '');
    const at = { session: e.number, sessionTitle: e.title };
    for (const p of known) if (named(text, p.name)) add(outPeople, seenP, { name: p.name, personId: p.id, ...(p.page_id ? { pageId: p.page_id } : {}), ...at });
    for (const pg of persons) if (named(text, pg.title)) add(outPeople, seenP, { name: pg.title, pageId: pg.id, ...at });
    for (const n of peopleMet(text)) {
      const p = known.find((x) => x.name.toLowerCase() === n.toLowerCase());
      add(outPeople, seenP, { name: p?.name ?? n, ...(p ? { personId: p.id } : {}), ...at });
    }
    for (const pl of places) if (named(text, pl.title)) add(outPlaces, seenL, { name: pl.title, pageId: pl.id, ...at });
  }
  return { people: outPeople, places: outPlaces, sessions: entries.map((e) => ({ number: e.number, title: e.title })) };
}
