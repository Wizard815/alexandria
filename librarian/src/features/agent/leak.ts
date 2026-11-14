// The player harness's output check (PLAN §6.3): a reply that shares an
// 8-word run with DM-only text is blocked. DM-only text is every DM page and
// DM-only part of a page (secret blocks, DM fact groups) and every DM-only
// transcript line, minus whatever the players may also see.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { parseJson } from '../../core/util.ts';

export const LEAK_WORDS = 8;
export const BLOCKED_REPLY = "I can't answer that from what you know.";

export const words = (s: string): string[] => s.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];

/** Every run of n words, as a space-joined string. */
export function grams(text: string, n = LEAK_WORDS): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}

/** All the text in a block or property tree, in order. */
export function treeText(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { for (const x of v) treeText(x, out); return out; }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') out.push(o.text);
    if (typeof o.key === 'string' && 'value' in o) out.push(o.key);
    if (typeof o.title === 'string') out.push(o.title);
    for (const [k, x] of Object.entries(o)) if (k !== 'text' && x && typeof x === 'object') treeText(x, out);
  }
  return out;
}

interface PageRow { visibility: string; body: string; blocks: string | null; properties: string | null; player_body: string | null; player_blocks: string | null; player_properties: string | null }

/** The 8-word runs of DM-only text in a world. */
export function dmOnlyGrams(db: DB, worldId: string): Set<string> {
  const dm = new Set<string>();
  const players = new Set<string>();
  const add = (into: Set<string>, text: string) => { for (const g of grams(text)) into.add(g); };
  for (const p of all<PageRow>(db, 'SELECT visibility, body, blocks, properties, player_body, player_blocks, player_properties FROM pages WHERE world_id = ?', worldId)) {
    add(dm, [p.body, treeText(parseJson(p.blocks, [])).join(' '), treeText(parseJson(p.properties, [])).join(' ')].join('\n'));
    if (p.visibility === 'party') add(players, [p.player_body ?? '', treeText(parseJson(p.player_blocks, [])).join(' '), treeText(parseJson(p.player_properties, [])).join(' ')].join('\n'));
  }
  let lines: { text: string; audience: string }[] = [];
  try { lines = all(db, 'SELECT text, audience FROM audio_lines WHERE world_id = ?', worldId); } catch { /* no audio tables */ }
  for (const l of lines) add(l.audience === 'players' ? players : dm, l.text);
  for (const g of players) dm.delete(g);
  return dm;
}

export interface LeakVerdict { blocked: boolean; match?: string }

/** A checker over one snapshot of the world's DM-only text, for checking many pieces of one reply cheaply. `allowed` is text the player wrote themselves. */
export function leakChecker(db: DB, worldId: string, allowed: string[] = []): (text: string) => LeakVerdict {
  const dm = dmOnlyGrams(db, worldId);
  for (const a of allowed) for (const g of grams(a)) dm.delete(g);
  return (text) => {
    for (const g of grams(text)) if (dm.has(g)) return { blocked: true, match: g };
    return { blocked: false };
  };
}

/** Does the reply share a run of 8 words with DM-only text? `allowed` is text the player wrote themselves. */
export function leakCheck(db: DB, worldId: string, reply: string, allowed: string[] = []): LeakVerdict {
  if (!grams(reply).size) return { blocked: false };
  return leakChecker(db, worldId, allowed)(reply);
}

/**
 * Lets a streamed reply through one sentence at a time, never sending a sentence
 * that shares a run of LEAK_WORDS words with DM-only text. A sentence is held
 * until the next one is complete too, so a run that crosses the sentence
 * boundary is caught before the first half goes out.
 */
export class SentenceGate {
  /** True once a sentence was refused; nothing more is sent. */
  blocked = false;
  match = '';
  /** Everything that was let through. */
  sent = '';
  /** Time spent checking, for the timings. */
  ms = 0;
  private buf = '';
  private ready: string[] = [];
  private tail: string[] = [];
  private check: (text: string) => LeakVerdict;
  private emit: (text: string) => void;
  constructor(check: (text: string) => LeakVerdict, emit: (text: string) => void) { this.check = check; this.emit = emit; }

  push(text: string) {
    if (this.blocked) return;
    this.buf += text;
    // A sentence ends at . ! ? (and closing quotes or brackets) followed by space, or at a line break.
    const re = /[\s\S]*?(?:[.!?]+["')\]*_]*(?=\s)|\n)\s*/y;
    let m: RegExpExecArray | null;
    let used = 0;
    re.lastIndex = 0;
    while ((m = re.exec(this.buf)) && m[0].length) { this.ready.push(m[0]); used = re.lastIndex; }
    this.buf = this.buf.slice(used);
    while (this.ready.length >= 2 && !this.blocked) this.release();
  }

  /** The reply is over: let the rest through, checked. Returns false if something was refused. */
  end(): boolean {
    if (this.blocked) return false;
    if (this.buf) { this.ready.push(this.buf); this.buf = ''; }
    while (this.ready.length && !this.blocked) this.release();
    return !this.blocked;
  }

  private release() {
    const t0 = performance.now();
    const s = this.ready[0];
    const next = this.ready[1] ?? '';
    const v = this.check(`${this.tail.join(' ')} ${s} ${next}`);
    this.ms += performance.now() - t0;
    if (v.blocked) { this.blocked = true; this.match = v.match ?? ''; this.ready = []; return; }
    this.ready.shift();
    this.tail = words(`${this.tail.join(' ')} ${s}`).slice(-(LEAK_WORDS - 1));
    this.sent += s;
    this.emit(s);
  }
}
