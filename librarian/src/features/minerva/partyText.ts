// Vault pages the whole party may read (level party, not inside one player's
// own root, except their shared page) are stored GM-only in the library, so
// their text must be told apart from real GM-only text: the leak checks
// (the broker's reply gate, the session log's publish check) would otherwise
// refuse to let anyone repeat what every player may know.
import type { DB } from '../../core/db.ts';
import { libraryOf } from '../../core/library.ts';
import { parseJson } from '../../core/util.ts';
import { ROOT, vaultLevel } from './vault.ts';

const cache = new Map<string, string | null>();

/** Is this vault page readable by every player (secret blocks aside)? */
export function sharedWithParty(path: string, fmJson: string | null): boolean {
  if (!path.startsWith(`${ROOT}/`) || path.startsWith(`${ROOT}/dm/`)) return false;
  const own = /^Minerva\/players\/[^/]+\/(.+)$/.exec(path);
  if (own && own[1] !== 'shared.md') return false;
  return vaultLevel(parseJson(fmJson, {})) === 'party';
}

/** The text of such a page as the players may read it (the library's own player copy), or null when the page is not one. */
export function partyBody(db: DB, worldId: string, p: { id: string; path: string; frontmatter: string | null; updated_at: string }): string | null {
  if (!sharedWithParty(p.path, p.frontmatter)) return null;
  const k = `${p.id}|${p.updated_at}`;
  if (cache.has(k)) return cache.get(k) ?? null;
  let out: string | null = null;
  try { out = libraryOf(db)?.liftedCopy(worldId, p.id)?.body ?? null; } catch { out = null; }
  if (cache.size > 2000) cache.clear();
  cache.set(k, out);
  return out;
}
