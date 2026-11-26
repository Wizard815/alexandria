// Keeping Minerva's codex linked to the library after a sync. A codex page
// links its entity two ways: `entity` in its front matter (the library page
// id) and a `Library: [[Title]]` line. A sync can rename a page (the line
// then names a title that no longer exists) or remove it and add it again
// (a new id). This pass mends both, links codex pages that have a library
// page by the same name, and lists what it could not mend. It never copies
// library text into the vault and never links a classified page.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import { libraryByName } from './codex.ts';
import { refreshCalendar, refreshHome } from './seed.ts';
import { stateOf } from './store.ts';
import { listOf, listPages, writePage, type VaultPage } from './vault.ts';

const codexPagesOf = (d: Deps, worldId: string) => listPages(d, worldId, 'codex/');

export interface RelinkResult {
  /** Minerva is not on for this world: nothing was looked at. */
  off?: boolean;
  pages: number;
  /** Codex pages that point at a library page. */
  linked: number;
  /** `Library:` lines changed to a page's new title. */
  renamed: number;
  /** Pages whose library page was gone and was found again by name. */
  relinked: number;
  /** Pages with no link that got one (a library page with the same name). */
  added: number;
  /** Titles of codex pages whose library page is gone and could not be found again. */
  broken: string[];
}

const LIB_LINE = /^Library: \[\[[^\]\n]*\]\]\s*$/m;

/** The body with its `Library: [[...]]` line naming `title` (added under the first heading when there is none). */
export function withLibraryLine(body: string, title: string): string {
  const line = `Library: [[${title.replace(/[[\]\n]/g, ' ').trim()}]]`;
  if (LIB_LINE.test(body)) return body.replace(LIB_LINE, line);
  const h = /^#\s+.+$/m.exec(body);
  if (!h) return `${line}\n\n${body}`;
  const at = h.index + h[0].length;
  return `${body.slice(0, at)}\n\n${line}${body.slice(at).replace(/^\n*/, '\n\n')}`;
}

interface Lib { id: string; title: string }
const libraryPage = (d: Deps, worldId: string, id: string): Lib | null =>
  one<Lib>(d.db, `SELECT id, title FROM pages WHERE world_id = ? AND id = ? AND path NOT LIKE 'Minerva/%' AND visibility <> 'classified'`, worldId, id) ?? null;

/** The one library page this codex page names (title or alias), or null when none or several do. */
function byNames(d: Deps, worldId: string, p: VaultPage): Lib | null {
  const hits = new Map<string, Lib>();
  for (const n of [p.title, ...listOf(p.fm.aliases)]) for (const r of libraryByName(d, worldId, String(n), false)) hits.set(r.id, { id: r.id, title: r.title });
  return hits.size === 1 ? [...hits.values()][0] : null;
}

/** Mend every codex page's link to the library, then refresh the home page and calendar index. */
export function relinkCodex(d: Deps, worldId: string, by: string | null = null): RelinkResult {
  const out: RelinkResult = { pages: 0, linked: 0, renamed: 0, relinked: 0, added: 0, broken: [] };
  if (!stateOf(d.db, worldId).enabled) return { ...out, off: true };
  const pages = codexPagesOf(d, worldId);
  out.pages = pages.length;
  // Another codex page already holding a library page: a second one is not linked to it by name.
  const taken = new Set(pages.map((p) => String(p.fm.entity ?? '')).filter(Boolean));
  const changed: string[] = [];
  for (const p of pages) {
    const ent = String(p.fm.entity ?? '');
    let lib = ent ? libraryPage(d, worldId, ent) : null;
    let fm: { entity: string } | undefined;
    if (ent && !lib) {
      const found = byNames(d, worldId, p);
      if (found && !taken.has(found.id)) { lib = found; fm = { entity: found.id }; taken.add(found.id); out.relinked++; } else { out.broken.push(p.title); continue; }
    } else if (!ent) {
      // A player character's page is about the player, not a library page.
      if (p.fm.kind === 'pc') continue;
      const found = byNames(d, worldId, p);
      if (!found || taken.has(found.id)) continue;
      lib = found; fm = { entity: found.id }; taken.add(found.id); out.added++;
    }
    if (!lib) continue;
    out.linked++;
    const m = /^Library: \[\[([^\]\n]*)\]\]\s*$/m.exec(p.body);
    const titleOk = !!m && m[1] === lib.title;
    if (m && !titleOk && !fm) out.renamed++;
    if (fm || !titleOk) {
      writePage(d, worldId, p.rel, { fm, body: withLibraryLine(p.body, lib.title), by, batch: true });
      changed.push(p.id);
    }
  }
  if (changed.length) d.library.rebuildPlayerCopies(worldId, changed);
  try { refreshHome(d, worldId, by); } catch { /* no clock or arcs yet */ }
  try { refreshCalendar(d, worldId, by); } catch { /* no calendar tables */ }
  return out;
}

/** What the Knowledge page shows about the codex's links, without changing anything. */
export function codexLinkStatus(d: Deps, worldId: string): { on: boolean; pages: number; linked: number; broken: number } {
  if (!stateOf(d.db, worldId).enabled) return { on: false, pages: 0, linked: 0, broken: 0 };
  const pages = codexPagesOf(d, worldId);
  const ids = new Set(all<{ id: string }>(d.db, `SELECT id FROM pages WHERE world_id = ? AND path NOT LIKE 'Minerva/%' AND visibility <> 'classified'`, worldId).map((r) => r.id));
  let linked = 0;
  let broken = 0;
  for (const p of pages) {
    const ent = String(p.fm.entity ?? '');
    if (!ent) continue;
    if (ids.has(ent)) linked++; else broken++;
  }
  return { on: true, pages: pages.length, linked, broken };
}
