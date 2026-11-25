// The final pass after a recording stops: pure helpers (no database, no
// clock). The engine feeds in every mic's words for the whole session and
// gets back the clock offsets to apply and tidied lines.
//
//   1. offsets: devices' clocks differ. Each mic is shifted onto the
//      reference mic by voting on the time difference of identical words
//      (a word-level cross-correlation), falling back to the difference in
//      upload clock samples (relative to the other mics, so network latency
//      cancels).
//   2. dedupe: lines two mics both produced that grouping missed are folded
//      into the better one.
//   3. tidy: short fragments of one voice are joined, never across an aside.
import { MAX_UTTERANCE_MS, similarity, token, type MergedLine, type Word } from './merge.ts';

const STOP = new Set(['the', 'and', 'you', 'that', 'this', 'with', 'for', 'are', 'was', 'but', 'not', 'have', 'its', 'she', 'they', 'then', 'there', 'what', 'your']);
const mid = (w: { s: number; e: number }) => (w.s + w.e) / 2;

export interface OffsetEstimate { ms: number; method: 'reference' | 'words' | 'upload' | 'none'; votes: number }

/**
 * Shift (ms, to ADD to a mic's times) that lines each mic's words up with the reference mic (the one that heard the most).
 * A word counts when it is at least 4 letters, not a stop word, and the same word is within `reach` ms in the reference;
 * the offset is the strongest cluster of differences.
 */
export function wordOffsets(streams: Map<string, Word[]>, opts: { reach?: number; minVotes?: number } = {}): { ref: string | null; offsets: Map<string, OffsetEstimate> } {
  const reach = opts.reach ?? 4000;
  const minVotes = opts.minVotes ?? 5;
  const out = new Map<string, OffsetEstimate>();
  let ref: string | null = null;
  for (const [m, ws] of streams) if (!ref || ws.length > streams.get(ref)!.length) ref = m;
  if (!ref) return { ref, offsets: out };
  out.set(ref, { ms: 0, method: 'reference', votes: 0 });
  const useful = (w: Word) => { const t = token(w.w); return t.length >= 4 && !STOP.has(t) ? t : ''; };
  const byTok = new Map<string, Word[]>();
  for (const w of streams.get(ref)!) { const t = useful(w); if (t) { const l = byTok.get(t) ?? []; l.push(w); byTok.set(t, l); } }
  for (const [m, ws] of streams) {
    if (m === ref) continue;
    const deltas: number[] = [];
    for (const w of ws) {
      const t = useful(w);
      if (!t) continue;
      for (const r of byTok.get(t) ?? []) { const d = mid(r) - mid(w); if (Math.abs(d) <= reach) deltas.push(d); }
    }
    if (deltas.length < minVotes) { out.set(m, { ms: 0, method: 'none', votes: deltas.length }); continue; }
    // The densest 200 ms window of differences, then the median inside it.
    deltas.sort((a, b) => a - b);
    let best = 0; let bestAt = 0;
    for (let i = 0, j = 0; i < deltas.length; i++) {
      while (deltas[i] - deltas[j] > 200) j++;
      if (i - j + 1 > best) { best = i - j + 1; bestAt = j; }
    }
    // Chance matches spread over the whole range; a real offset piles up. Demand a clear peak.
    if (best < minVotes || best < 0.25 * deltas.length) { out.set(m, { ms: 0, method: 'none', votes: best }); continue; }
    const win = deltas.slice(bestAt, bestAt + best);
    out.set(m, { ms: Math.round(win[Math.floor(win.length / 2)]), method: 'words', votes: best });
  }
  return { ref, offsets: out };
}

/**
 * Offsets from the clock samples each upload carried (server session time minus the device's own time at sending; the
 * smallest of a mic's samples is its clock error plus its quickest upload). Relative to the median mic, so the part
 * every device shares (network latency) cancels. Needs two or more mics with samples.
 */
export function uploadOffsets(skews: Map<string, number[]>): Map<string, number> {
  const mins = new Map<string, number>();
  for (const [m, l] of skews) if (l.length >= 2) mins.set(m, Math.min(...l));
  const out = new Map<string, number>();
  if (mins.size < 2) return out;
  const sorted = [...mins.values()].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  for (const [m, v] of mins) out.set(m, Math.round(v - med));
  return out;
}

/** The offset to ADD to each mic's times: words when they are conclusive, else the upload samples (re-based on the reference), else 0. */
export function chooseOffsets(streams: Map<string, Word[]>, skews: Map<string, number[]>): Map<string, OffsetEstimate> {
  const { ref, offsets } = wordOffsets(streams);
  const up = uploadOffsets(skews);
  const base = ref ? up.get(ref) ?? 0 : 0;
  const out = new Map<string, OffsetEstimate>();
  for (const [m, est] of offsets) {
    if (est.method === 'words' || est.method === 'reference') { out.set(m, est); continue; }
    const u = up.get(m);
    out.set(m, u === undefined ? est : { ms: Math.round(u - base), method: 'upload', votes: est.votes });
  }
  // Mics with no words at all still get their upload offset.
  for (const [m, u] of up) if (!out.has(m)) out.set(m, { ms: Math.round(u - base), method: 'upload', votes: 0 });
  return out;
}

const toks = (l: { words: { w: string }[] }) => l.words.map((w) => token(w.w)).filter(Boolean);
const quality = (l: MergedLine) => l.words.reduce((a, w) => a + w.c, 0) * (1 + Math.max(0, ...Object.values(l.stats).map((s) => s.level)));

/**
 * Lines that are the same speech heard by different mics and were not grouped (their words differ more than the
 * grouping threshold, or two chunk edges disagree) are folded into the better one: it takes over the other's mics.
 */
export function dedupeLines(lines: MergedLine[]): MergedLine[] {
  const sorted = [...lines].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: MergedLine[] = [];
  for (const l of sorted) {
    let twin = -1;
    for (let i = out.length - 1; i >= 0 && i >= out.length - 12; i--) {
      const o = out[i];
      const ov = Math.min(o.end, l.end) - Math.max(o.start, l.start);
      if (ov <= 0) continue;
      if (ov < 0.5 * Math.min(o.end - o.start, l.end - l.start)) continue;
      // Different mics only (one mic cannot say the same thing twice at once).
      if (o.mics.some((m) => l.mics.includes(m))) continue;
      const a = toks(o); const b = toks(l);
      const sim = similarity(a, b);
      const shorter = Math.min(a.length, b.length);
      // A short line is a fragment of the longer one when most of its words are in it.
      if (sim >= 0.5 || (shorter >= 2 && similarity(a, b) * (a.length + b.length) / (2 * shorter) >= 0.8)) { twin = i; break; }
    }
    if (twin < 0) { out.push(l); continue; }
    const o = out[twin];
    const keep = quality(l) > quality(o) ? l : o;
    const lose = keep === l ? o : l;
    out[twin] = { ...keep, mics: [...new Set([...keep.mics, ...lose.mics])], stats: { ...lose.stats, ...keep.stats }, start: Math.min(o.start, l.start), end: Math.max(o.end, l.end) };
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The mic that speaks a line (highest level x confidence), for deciding which fragments are one voice. */
const voice = (l: MergedLine) => Object.entries(l.stats).sort((a, b) => b[1].level * (0.5 + b[1].conf) - a[1].level * (0.5 + a[1].conf))[0]?.[0] ?? '';

/**
 * Join a line to the one before when they are one voice, a breath apart (<= gapMs) and the first did not end a sentence,
 * as long as the result stays within one line's length and no aside edge (a cut) lies between them.
 */
export function tidyLines(lines: MergedLine[], cuts: number[], gapMs = 450): MergedLine[] {
  const out: MergedLine[] = [];
  for (const l of [...lines].sort((a, b) => a.start - b.start)) {
    const p = out[out.length - 1];
    const ended = p && /[.?!]["')]*$/.test(p.words[p.words.length - 1]?.w ?? '');
    if (p && !ended && l.start - p.end <= gapMs && l.start >= p.end - 50 && l.end - p.start <= MAX_UTTERANCE_MS && voice(p) === voice(l) && !cuts.some((c) => c > p.end - 50 && c < l.start + 50)) {
      const words = [...p.words, ...l.words];
      const stats: MergedLine['stats'] = { ...p.stats };
      for (const [m, s] of Object.entries(l.stats)) stats[m] = stats[m] ? { level: (stats[m].level + s.level) / 2, conf: (stats[m].conf + s.conf) / 2 } : s;
      out[out.length - 1] = { start: p.start, end: Math.max(p.end, l.end), words, text: words.map((w) => w.w).join(' '), mics: [...new Set([...p.mics, ...l.mics])], stats };
    } else out.push(l);
  }
  return out;
}
