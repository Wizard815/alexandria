// The final output check. Whatever built a player-facing broker answer, this
// runs once more over the finished text before it is delivered: it must not
// contain a line only the DM can read, nor a name that appears only in DM-only
// text. It fails closed: a hit means the answer is held for the DM.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import type { Library } from '../../core/library.ts';
import type { Viewer } from '../../core/policy.ts';
import { key, lines, propLines, words } from '../../core/brokerClassify.ts';

const DM: Viewer = { accountId: '', role: 'dm' };
const PLAYER: Viewer = { accountId: '', role: 'player' };
const MID_CAP = /(?<=[a-z,;:]\s)[A-Z][\p{L}]{3,}/gu;

export interface DmSide { lines: string[]; names: Set<string> }

/** What only the DM can read in this world, and what players can read (to tell the two apart). */
export function dmSide(db: DB, library: Library, worldId: string, extraPlayerText = ''): DmSide {
  const dmLines: string[] = [];
  const dmNames = new Set<string>();
  const playerWords = new Set<string>(words(extraPlayerText));
  for (const n of all<any>(db, 'SELECT topic, text FROM broker_notes WHERE world_id = ?', worldId)) for (const w of words(`${n.topic} ${n.text}`)) playerWords.add(w);
  for (const p of library.list(worldId, DM) as any[]) {
    let dm: any;
    try { dm = library.get(worldId, p.id, DM); } catch { continue; }
    const seen = new Set<string>();
    try {
      const pp: any = library.get(worldId, p.id, PLAYER);
      for (const t of [...lines(pp.body), ...propLines(pp.properties ?? [])]) { seen.add(key(t)); for (const w of words(t)) playerWords.add(w); }
      for (const w of words(String(pp.title))) playerWords.add(w);
    } catch { /* not shared */ }
    for (const t of [...lines(dm.body), ...propLines(dm.properties ?? [])]) {
      if (seen.has(key(t))) continue;
      dmLines.push(t);
      for (const m of t.match(MID_CAP) ?? []) dmNames.add(m.toLowerCase());
    }
  }
  for (const w of playerWords) dmNames.delete(w);
  return { lines: dmLines, names: dmNames };
}

/** The first DM-only thing found in a player-facing text, or null when it is clean. */
export function leaks(db: DB, library: Library, worldId: string, text: string, question = ''): string | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  const side = dmSide(db, library, worldId, question);
  const k = key(t);
  for (const l of side.lines) if (k.includes(key(l))) return 'a DM-only line';
  const ws = new Set(words(t));
  for (const n of side.names) if (ws.has(n)) return `the DM-only name “${n}”`;
  return null;
}
