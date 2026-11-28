// After a module import, put its content where the game uses it, in the
// same step: spells into the Codex (so the spell list, study and the spell
// tree have them) and items into the shop's item database (so shops can
// stock them). Monsters and conditions need nothing: the encounter builder,
// initiative and rules cards read every enabled module directly.
import type { Deps } from '../../app.ts';
import { tx } from '../../core/db.ts';
import { readImport, saveImport } from '../spells/importers.ts';
import { ensureSeeded, importItems, moduleItems } from '../shop/items.ts';
import { enabledIds, moduleDoc } from './store.ts';

export interface Feed { spells?: boolean; items?: boolean; replace?: boolean }
export interface FeedResult {
  spells?: { added: number; replaced: number; skipped: number };
  items?: { added: number; updated: number; skipped: number };
  warnings: string[];
}

export function readFeed(v: unknown): Feed | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as any;
  const out: Feed = { spells: f.spells === true, items: f.items === true, replace: f.replace === true };
  return out.spells || out.items ? out : null;
}

export function feedModule(d: Deps, worldId: string, moduleId: string, feed: Feed, by: string): FeedResult {
  const m = moduleDoc(d.db, worldId, moduleId);
  const out: FeedResult = { warnings: [] };
  if (!m) return out;
  const has = (k: string) => m.doc.terms.some((t) => t.kind === k);
  if (feed.spells && has('spell')) {
    const read = readImport(d, worldId, { type: 'module', moduleId });
    const r = tx(d.db, () => saveImport(d, worldId, read, feed.replace === true));
    out.spells = { added: r.added.length, replaced: r.replaced.length, skipped: r.skipped.length };
    out.warnings.push(...read.warnings.slice(0, 10));
    d.hub.emit(worldId, 'spells', {}, () => true);
  }
  if (feed.items && has('item')) {
    // The world's SRD baseline goes in first (once), so a book's copy of a basic item does not shadow it.
    ensureSeeded(d.db, worldId, enabledIds(d.db, worldId));
    const r = importItems(d.db, worldId, moduleItems(d.db, worldId, moduleId), { onDuplicate: feed.replace ? 'update' : 'skip', by });
    out.items = { added: r.added, updated: r.updated, skipped: r.skipped };
    d.hub.emit(worldId, 'shop-items', {}, (v) => v.role === 'gm');
  }
  return out;
}
