// One transcript from many mics (PLAN §3.3a). Pure functions: no database,
// no clock. The engine feeds in each mic's words and gets merged lines back.
//
//   1. utterances: a mic's words, split where it falls silent
//   2. groups: utterances from different mics that overlap in time and are
//      mostly the same words (token similarity >= 0.6)
//   3. merge: align every member to the best-scoring mic's words (a simple
//      dynamic-programming alignment) and, column by column, take the word
//      from the mic with the highest confidence x signal level
//   4. speaker: the mic with the strongest close signal (done by the engine)

export interface Word { w: string; s: number; e: number; c: number; l: number }
export interface MergedWord { w: string; s: number; e: number; c: number; mic: string }
export interface Utterance { mic: string; start: number; end: number; words: Word[] }
export interface Group { members: Utterance[]; start: number; end: number }
export interface MergedLine { start: number; end: number; words: MergedWord[]; text: string; mics: string[]; stats: Record<string, { level: number; conf: number }> }

export const token = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function lev1(a: string, b: string): boolean {
  // Edit distance <= 1.
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
export function sameToken(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || (a.length >= 4 && b.length >= 4 && lev1(a, b));
}

/** Dice coefficient over the longest common (fuzzy) subsequence of two token lists. */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = sameToken(a[i - 1], b[j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2 * dp[a.length][b.length]) / (a.length + b.length);
}

/** Split one mic's words into utterances at silences longer than gapMs. */
export function utterances(mic: string, words: Word[], gapMs = 700): Utterance[] {
  const out: Utterance[] = [];
  const sorted = [...words].filter((w) => token(w.w)).sort((x, y) => x.s - y.s);
  let cur: Utterance | null = null;
  for (const w of sorted) {
    if (cur && w.s - cur.end <= gapMs) {
      cur.words.push(w);
      cur.end = Math.max(cur.end, w.e);
    } else {
      cur = { mic, start: w.s, end: w.e, words: [w] };
      out.push(cur);
    }
  }
  return out;
}

const toks = (u: { words: { w: string }[] }) => u.words.map((w) => token(w.w)).filter(Boolean);

function quality(u: Utterance): number {
  let q = 0;
  for (const w of u.words) q += w.c * Math.max(w.l, 0.05);
  return q;
}

/** Group utterances from different mics that are the same speech. */
export function groupUtterances(all: Utterance[], opts: { slackMs?: number; threshold?: number } = {}): Group[] {
  const slack = opts.slackMs ?? 600;
  const threshold = opts.threshold ?? 0.6;
  const groups: Group[] = [];
  const sorted = [...all].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const u of sorted) {
    const ut = toks(u);
    let best: Group | null = null;
    let bestSim = 0;
    for (const g of groups) {
      if (g.end < u.start - slack || g.start > u.end + slack) continue;
      if (g.members.some((m) => m.mic === u.mic)) continue;
      const sim = Math.max(...g.members.map((m) => similarity(toks(m), ut)));
      if (sim >= threshold && sim > bestSim) { best = g; bestSim = sim; }
    }
    if (best) {
      best.members.push(u);
      best.start = Math.min(best.start, u.start);
      best.end = Math.max(best.end, u.end);
    } else groups.push({ members: [u], start: u.start, end: u.end });
  }
  return groups;
}

interface Op { i: number | null; j: number | null }
/** Needleman-Wunsch: match +2, mismatch -1, gap -1. Returns the aligned column pairs in order. */
export function align(ref: string[], other: string[]): Op[] {
  const n = ref.length;
  const m = other.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = -i;
  for (let j = 1; j <= m; j++) dp[0][j] = -j;
  const sc = (i: number, j: number) => (sameToken(ref[i], other[j]) ? 2 : -1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) dp[i][j] = Math.max(dp[i - 1][j - 1] + sc(i - 1, j - 1), dp[i - 1][j] - 1, dp[i][j - 1] - 1);
  }
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + sc(i - 1, j - 1)) { ops.push({ i: i - 1, j: j - 1 }); i--; j--; }
    else if (i > 0 && dp[i][j] === dp[i - 1][j] - 1) { ops.push({ i: i - 1, j: null }); i--; }
    else { ops.push({ i: null, j: j - 1 }); j--; }
  }
  return ops.reverse();
}

interface Cand { word: Word; mic: string }
interface Col { cands: Cand[]; token: string }

const score = (c: Cand) => c.word.c * Math.max(c.word.l, 0.05);

export function mergeGroup(g: Group): MergedLine {
  const ref = g.members.reduce((a, b) => (quality(b) > quality(a) ? b : a));
  const refWords = ref.words.filter((w) => token(w.w));
  const refToks = refWords.map((w) => token(w.w));
  const cols: Col[] = refWords.map((w, i) => ({ cands: [{ word: w, mic: ref.mic }], token: refToks[i] }));
  // Words other mics heard that the reference mic did not: slot k is "before ref word k".
  const slots: Col[][] = Array.from({ length: refWords.length + 1 }, () => []);
  for (const u of g.members) {
    if (u === ref) continue;
    const ow = u.words.filter((w) => token(w.w));
    const ot = ow.map((w) => token(w.w));
    let at = 0; // the next ref index
    const used = new Map<number, number>(); // slot -> position after the last column this mic used
    for (const op of align(refToks, ot)) {
      if (op.i !== null && op.j !== null) { cols[op.i].cands.push({ word: ow[op.j], mic: u.mic }); at = op.i + 1; }
      else if (op.i !== null) at = op.i + 1;
      else if (op.j !== null) {
        const slot = slots[at];
        const from = used.get(at) ?? 0;
        let k = -1;
        for (let x = from; x < slot.length; x++) if (sameToken(slot[x].token, ot[op.j])) { k = x; break; }
        if (k >= 0) slot[k].cands.push({ word: ow[op.j], mic: u.mic });
        else { k = from; slot.splice(k, 0, { cands: [{ word: ow[op.j], mic: u.mic }], token: ot[op.j] }); }
        used.set(at, k + 1);
      }
    }
  }
  const words: MergedWord[] = [];
  const pick = (col: Col, inserted: boolean) => {
    const best = col.cands.reduce((a, b) => (score(b) > score(a) ? b : a));
    if (inserted && best.word.c < 0.4) return;
    words.push({ w: best.word.w.trim(), s: best.word.s, e: best.word.e, c: best.word.c, mic: best.mic });
  };
  for (let k = 0; k <= cols.length; k++) {
    for (const col of slots[k]) pick(col, true);
    if (k < cols.length) pick(cols[k], false);
  }
  const stats: MergedLine['stats'] = {};
  for (const u of g.members) {
    stats[u.mic] = {
      level: u.words.reduce((a, w) => a + w.l, 0) / u.words.length,
      conf: u.words.reduce((a, w) => a + w.c, 0) / u.words.length,
    };
  }
  return {
    start: Math.min(...words.map((w) => w.s)),
    end: Math.max(...words.map((w) => w.e)),
    words,
    text: words.map((w) => w.w).join(' '),
    mics: g.members.map((m) => m.mic),
    stats,
  };
}
