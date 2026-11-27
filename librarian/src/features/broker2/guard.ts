// The final output check. Whatever built a player-facing broker answer, this
// runs once more over the finished text before it is delivered: it must not
// contain a line only the GM can read, nor a name that appears only in GM-only
// text. It fails closed: a hit means the answer is held for the GM.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import type { Library } from '../../core/library.ts';
import type { Viewer } from '../../core/policy.ts';
import { key, lines, propLines, words } from '../../core/brokerClassify.ts';

const GM: Viewer = { accountId: '', role: 'gm' };
const PLAYER: Viewer = { accountId: '', role: 'player' };
const BROKER: Viewer = { accountId: '', role: 'gm', audience: 'broker' };
const MID_CAP = /(?<=[a-z,;:]\s)[A-Z][\p{L}]{3,}/gu;

export interface GmSide { lines: string[]; names: Set<string> }

/** What only the GM can read in this world, and what players can read (to tell the two apart). */
export function gmSide(db: DB, library: Library, worldId: string, extraPlayerText = '', allowBroker = false): GmSide {
  const gmLines: string[] = [];
  const gmNames = new Set<string>();
  const playerWords = new Set<string>(words(extraPlayerText));
  for (const n of all<any>(db, 'SELECT topic, text FROM broker_notes WHERE world_id = ?', worldId)) for (const w of words(`${n.topic} ${n.text}`)) playerWords.add(w);
  for (const p of library.list(worldId, GM) as any[]) {
    let gm: any;
    try { gm = library.get(worldId, p.id, GM); } catch { continue; }
    const seen = new Set<string>();
    try {
      const pp: any = library.get(worldId, p.id, PLAYER);
      for (const t of [...lines(pp.body), ...propLines(pp.properties ?? [])]) { seen.add(key(t)); for (const w of words(t)) playerWords.add(w); }
      for (const w of words(String(pp.title))) playerWords.add(w);
    } catch { /* not shared */ }
    // A broker answer may use broker-level lines; gm and classified lines stay blocked (so does every line, in any other answer).
    if (allowBroker) {
      try {
        const bp: any = library.get(worldId, p.id, BROKER);
        for (const t of [...lines(bp.body), ...propLines(bp.properties ?? [])]) { seen.add(key(t)); for (const w of words(t)) playerWords.add(w); }
        for (const w of words(String(bp.title))) playerWords.add(w);
      } catch { /* no broker copy */ }
    }
    for (const t of [...lines(gm.body), ...propLines(gm.properties ?? [])]) {
      if (seen.has(key(t))) continue;
      gmLines.push(t);
      for (const m of t.match(MID_CAP) ?? []) gmNames.add(m.toLowerCase());
    }
  }
  for (const w of playerWords) gmNames.delete(w);
  return { lines: gmLines, names: gmNames };
}

/** The first GM-only thing found in a player-facing text, or null when it is clean. */
export function leaks(db: DB, library: Library, worldId: string, text: string, question = '', allowBroker = false): string | null {
  const t = String(text ?? '');
  if (!t.trim()) return null;
  const side = gmSide(db, library, worldId, question, allowBroker);
  const k = key(t);
  for (const l of side.lines) if (k.includes(key(l))) return 'a GM-only line';
  const ws = new Set(words(t));
  for (const n of side.names) if (ws.has(n)) return `the GM-only name “${n}”`;
  return null;
}
