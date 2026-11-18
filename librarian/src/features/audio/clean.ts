// Cleaning what a speech model sent back, before any of it becomes a transcript
// line. Pure functions: no database, no clock.
//
//   - segments Whisper made up on silence or noise ("Thank you.", "Bye.",
//     "see you in the next video", one word repeated for a minute) are dropped
//     from the numbers the model reports (compression ratio, log probability,
//     no-speech probability) and from a list of phrases it is known to invent
//   - text that only repeats the vocabulary prompt we sent is dropped
//   - runs of the same word or phrase are collapsed
//   - dice and sums are written the way a table writes them (d6, nat 20)
import { token } from './merge.ts';

export interface RawSegment { start: number; end: number; text: string; avgLogprob?: number; noSpeechProb?: number; compressionRatio?: number }
export type Pw = [string, number, number, number];

export const LIMITS = { compression: 2.4, logprob: -1.0, noSpeech: 0.6, noSpeechHard: 0.8 } as const;

/** Phrases Whisper writes on silence or music. Always junk when confidence is unknown only for the video-outro ones. */
const OUTRO = /\b(thanks? for (watching|listening)|see you (in the )?(next|another) (video|time|one|episode)|we'?ll see you (in the )?next|please (like and )?subscribe|subtitles? (by|from)|translated by|amara\.org|www\.|\.com\b|like and subscribe)\b/i;
const SHORT_JUNK = new Set(['thank you', 'thanks', 'thank you very much', 'bye', 'bye bye', 'goodbye', 'you', 'yeah', 'okay', 'ok', 'so', 'oh', 'uh', 'um', 'hmm', 'mm', 'mhm', 'the end', 'music', 'applause', 'laughter', 'silence', 'blank audio', 'inaudible']);

export const phraseOf = (text: string) => text.toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Why a segment is not speech, or null to keep it. */
export function junkReason(s: RawSegment): string | null {
  const text = s.text.trim();
  if (!text) return 'empty';
  const lp = s.avgLogprob;
  const ns = s.noSpeechProb ?? 0;
  if (s.compressionRatio !== undefined && s.compressionRatio > LIMITS.compression) return 'compression';
  if (lp !== undefined && lp < LIMITS.logprob) return 'logprob';
  if (ns > LIMITS.noSpeechHard) return 'no-speech';
  // Real speech with a decent score is kept even when the silence detector was unsure.
  if (ns > LIMITS.noSpeech && (lp === undefined || lp < -0.5)) return 'no-speech';
  if (OUTRO.test(text)) return 'outro';
  const p = phraseOf(text);
  if (SHORT_JUNK.has(p) && (lp === undefined ? false : lp < -0.45 || ns > 0.3)) return 'junk-phrase';
  if (/^\[.*\]$|^\(.*\)$|^\*.*\*$|^♪/.test(text)) return 'sound-note';
  return null;
}

/** Collapse a word or short phrase said again and again (a loop). A run of 8 or more is a hallucination and goes. */
export function collapseRuns(words: Pw[]): Pw[] {
  const t = words.map((w) => token(w[0]));
  const keep = new Array(words.length).fill(true);
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= words.length;) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && t.slice(i, i + n).every((x, k) => x && x === t[i + reps * n + k])) reps++;
      const needed = n === 1 ? 4 : 3;
      if (reps >= needed) {
        const dropAll = reps >= 8 || (n > 1 && reps >= 5);
        const from = i + (dropAll ? 0 : 2 * n);
        for (let k = from; k < i + reps * n; k++) keep[k] = false;
        i += reps * n;
      } else i++;
    }
  }
  return words.filter((_, i) => keep[i]);
}

/** Does this segment just repeat the prompt we sent? Three or more words in the prompt's order, or two prompt names. */
export function echoesPrompt(text: string, prompt: string): boolean {
  if (!prompt) return false;
  const seg = text.split(/\s+/).map(token).filter(Boolean);
  const hint = prompt.split(/\s+/).map(token).filter(Boolean);
  if (seg.length < 3 || seg.length > hint.length + 2) return false;
  const joined = ` ${hint.join(' ')} `;
  if (joined.includes(` ${seg.join(' ')} `)) return true;
  // Most of the segment is a run of the prompt.
  let best = 0;
  for (let i = 0; i < seg.length; i++) {
    for (let j = 0; j < hint.length; j++) {
      let k = 0;
      while (i + k < seg.length && j + k < hint.length && seg[i + k] === hint[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best >= 3 && best >= seg.length * 0.8;
}

const DICE = new Set([2, 3, 4, 6, 8, 10, 12, 20, 100]);
const ONES: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };

const num = (w: string): number | null => {
  const t = token(w);
  if (/^\d{1,3}$/.test(t)) return Number(t);
  return t in ONES ? ONES[t] : null;
};
const bare = (w: string) => w.replace(/[.,!?;:]+$/, '');
const trail = (w: string) => /[.,!?;:]+$/.exec(w)?.[0] ?? '';

/** "D -6", "d-6", "T20" -> d6, d20; "nat twenty" -> nat 20; "16 plus 521" -> "16 plus 5 is 21". */
export function normaliseDice(words: Pw[]): Pw[] {
  const out: Pw[] = [];
  for (let i = 0; i < words.length; i++) {
    const [w, s, e, c] = words[i];
    const b = bare(w);
    const nx = words[i + 1];
    let m: RegExpExecArray | null;
    // d20 spoken "d" then a number, or written d-20 / D 20
    if (/^[dD]$/.test(b) && nx) {
      const n = /^[-–]?\s*(\d{1,3})$/.exec(bare(nx[0]).trim());
      if (n && DICE.has(Number(n[1]))) { out.push([`d${n[1]}${trail(nx[0])}`, s, nx[2], Math.min(c, nx[3])]); i++; continue; }
    }
    if ((m = /^[dD][-–]?(\d{1,3})$/.exec(b)) && DICE.has(Number(m[1]))) { out.push([`d${m[1]}${trail(w)}`, s, e, c]); continue; }
    if ((m = /^[tT](\d{1,3})$/.exec(b)) && DICE.has(Number(m[1])) && Number(m[1]) > 4) { out.push([`d${m[1]}${trail(w)}`, s, e, c]); continue; }
    // nat twenty / natural 20 / nat-20
    if (/^nat(ural)?$/i.test(b) && nx) {
      const n = num(bare(nx[0]));
      if (n !== null && n >= 1 && n <= 20) { out.push([`nat ${n}${trail(nx[0])}`, s, nx[2], Math.min(c, nx[3])]); i++; continue; }
    }
    if ((m = /^nat[-–]?(\d{1,2})$/i.exec(b))) { out.push([`nat ${m[1]}${trail(w)}`, s, e, c]); continue; }
    // "16 plus 521": the second number swallowed the sum ("5" then "21")
    if (/^plus$/i.test(b) && nx && out.length) {
      const prev = out[out.length - 1];
      const a = /^\d{1,3}$/.exec(bare(prev[0]));
      const sum = /^(\d{3,5})([.,!?;:]*)$/.exec(nx[0]);
      if (a) {
        let fixed = false;
        for (let k = 1; sum && k < sum[1].length; k++) {
          const x = Number(sum![1].slice(0, k));
          const y = Number(sum![1].slice(k));
          if (!sum![1].slice(k).startsWith('0') && Number(a[0]) + x === y) {
            const mid = nx[1] + (nx[2] - nx[1]) / 2;
            out.push([w, s, e, c], [String(x), nx[1], Math.max(nx[1] + 50, mid), nx[3]], ['is', mid, mid + 50, nx[3]], [`${y}${sum![2]}`, mid + 50, Math.max(nx[2], mid + 100), nx[3]]);
            i++; fixed = true; break;
          }
        }
        if (fixed) continue;
      }
    }
    out.push(words[i]);
  }
  return out;
}

/** Words that say something are kept; the rest of a segment's housekeeping happens here. */
export function cleanWords(words: Pw[]): Pw[] {
  return normaliseDice(collapseRuns(words));
}

/** A quiet chunk gets no vocabulary prompt (a prompt on near silence is what Whisper repeats back). */
export const QUIET_LEVEL = 0.06;
