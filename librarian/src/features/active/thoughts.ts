// Minerva's thoughts: a short live feed of what the DM's assistant is doing and why, for the DM's
// "Minerva's thoughts" window. Active mode says what it heard, what it made of it and why it acted,
// asked or let it go; the assistant says what it is working on, what it looked up, what it proposed
// and how long it took. Held in memory only (the last THOUGHTS_KEPT per world, gone on a restart):
// the command log stays the record of what was done; this is the running commentary.
//
// DM only, always: the event goes to the DM's screens and the route sits behind requireDM. Text is
// clipped, and nothing classified is ever put here (Active mode skips classified lines before this).
import type { Deps } from '../../app.ts';
import { dmOnly } from '../../core/events.ts';
import { id } from '../../core/util.ts';

export const THOUGHTS_KEPT = 120;

export type ThoughtSource = 'active' | 'assistant' | 'task' | 'wake';
export type ThoughtKind =
  /** A line was heard (shown as the "listening" status, not in the feed). */
  | 'heard'
  /** What it makes of something: a plan, an idea, the model's own words before it calls tools. */
  | 'plan'
  /** A read tool it is calling, or a model check it is asking for. */
  | 'look'
  /** It ran a change itself. */
  | 'do'
  /** It made a card that waits for the DM. */
  | 'ask'
  /** It decided not to act, and why. */
  | 'skip'
  /** A run finished. */
  | 'done'
  /** Something went wrong. */
  | 'error';

export interface Thought {
  id: string;
  at: string;
  source: ThoughtSource;
  kind: ThoughtKind;
  text: string;
  /** Longer detail, shown folded. */
  detail?: string;
  /** Groups one assistant run, or one Active-mode batch. */
  runId?: string;
  /** The Active-mode log row it is about (a card can be decided from the window). */
  logId?: string;
  /** The Active-mode action it is about can be undone from the window. */
  undoable?: boolean;
  /** The assistant's pending action it is about. */
  actionId?: string;
  chatId?: string;
}

const books = new WeakMap<Deps, Map<string, Thought[]>>();
const book = (d: Deps, worldId: string): Thought[] => {
  let m = books.get(d);
  if (!m) { m = new Map(); books.set(d, m); }
  let list = m.get(worldId);
  if (!list) { list = []; m.set(worldId, list); }
  return list;
};

const heard = new WeakMap<Deps, Map<string, Thought>>();

const clip = (s: string | undefined, n: number) => (s === undefined ? undefined : s.replace(/\s+/g, ' ').trim().slice(0, n));

/** Note a thought and send it to the DM's screens. Never throws: commentary must not break the work it describes. */
export function think(d: Deps, worldId: string, t: Omit<Thought, 'id' | 'at'>): Thought | null {
  try {
    const th: Thought = { ...t, id: id('th_'), at: new Date().toISOString(), text: clip(t.text, 300) ?? '', detail: clip(t.detail, 1200) };
    // Every line heard would push the real thoughts out: only the latest is kept, as the "listening" line.
    if (th.kind === 'heard') {
      let m = heard.get(d);
      if (!m) { m = new Map(); heard.set(d, m); }
      m.set(worldId, th);
    } else {
      const list = book(d, worldId);
      list.push(th);
      if (list.length > THOUGHTS_KEPT) list.splice(0, list.length - THOUGHTS_KEPT);
    }
    d.hub.emit(worldId, 'thought', th, dmOnly);
    return th;
  } catch (e) {
    console.error('thoughts: could not note a thought', e);
    return null;
  }
}

/** The newest thoughts, oldest first. */
export const recentThoughts = (d: Deps, worldId: string, limit = THOUGHTS_KEPT): Thought[] => book(d, worldId).slice(-Math.max(1, Math.min(limit, THOUGHTS_KEPT)));

/** The last line Active mode heard, if any. */
export const lastHeard = (d: Deps, worldId: string): Thought | null => heard.get(d)?.get(worldId) ?? null;

/** Tests: forget them. */
export const clearThoughts = (d: Deps, worldId: string) => { books.get(d)?.delete(worldId); heard.get(d)?.delete(worldId); };

/** "1.2 s" or "340 ms". */
export const took = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
