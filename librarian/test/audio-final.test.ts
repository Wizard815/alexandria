// The final transcript's pure parts (features/audio/final.ts): clock offsets between devices, cross-mic dedupe and
// line tidy, plus the whole chain (utterances -> groups -> merge -> dedupe -> tidy) on several mics at once. No
// database and no speech model: every word is made up here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOffsets, dedupeLines, tidyLines, uploadOffsets, wordOffsets } from '../src/features/audio/final.ts';
import { groupUtterances, MAX_UTTERANCE_MS, mergeGroup, utterances, type MergedLine, type Word } from '../src/features/audio/merge.ts';

/** Words of `text`, one every `step` ms from `at`, each 80% of the step long. */
const say = (text: string, at: number, o: { step?: number; c?: number; l?: number } = {}): Word[] => {
  const step = o.step ?? 400;
  return text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, s: at + i * step, e: at + i * step + step * 0.8, c: o.c ?? 0.9, l: o.l ?? 0.5 }));
};
const shift = (ws: Word[], ms: number) => ws.map((w) => ({ ...w, s: w.s + ms, e: w.e + ms }));
/** A tiny seeded random, so the noisy cases are the same every run. */
const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const A = 'The ferryman wants twelve silver pieces before crossing toward Saltmarsh tonight';
const B = 'Nobody trusts that smuggler after what happened beneath the lighthouse yesterday';
const C = 'Roll initiative because goblins burst through the tavern kitchen doorway';
const D = 'Velmira whispers something about ancient bargains under the drowned chapel';

/** A merged line as the engine's merge makes it (only what dedupe and tidy look at). */
const line = (mic: string, text: string, at: number, o: { level?: number; conf?: number; step?: number } = {}): MergedLine => {
  const ws = say(text, at, { step: o.step, c: o.conf, l: o.level });
  return { start: ws[0].s, end: ws[ws.length - 1].e, words: ws.map((w) => ({ ...w, mic })), text, mics: [mic], stats: { [mic]: { level: o.level ?? 0.5, conf: o.conf ?? 0.9 } } };
};

// ---- clock offsets ------------------------------------------------------------------------------------------------

test('Final_offsets: a mic whose clock runs late is pulled back onto the reference mic', () => {
  const ref = [...say(A, 1000), ...say(B, 7000), ...say(C, 14000)];
  const late = shift([...say(A, 1000), ...say(B, 7000)], 1300); // heard less, and 1.3 s late
  const { ref: r, offsets } = wordOffsets(new Map([['table', ref], ['phone', late]]));
  assert.equal(r, 'table', 'the mic that heard the most is the reference');
  assert.deepEqual(offsets.get('table'), { ms: 0, method: 'reference', votes: 0 });
  const o = offsets.get('phone')!;
  assert.equal(o.method, 'words');
  assert.ok(Math.abs(o.ms - -1300) <= 20, `offset ${o.ms}`);
  assert.ok(o.votes >= 10, `votes ${o.votes}`);
});

test('Final_offsets: an early clock, words heard with jitter and a few misheard words still give the offset', () => {
  const r = rng(7);
  const ref = [...say(A, 0), ...say(B, 6000), ...say(D, 12000)];
  const early = [...say(A, 0), ...say(B, 6000), ...say(D, 12000)].map((w) => ({ ...w, s: w.s - 2200 + (r() - 0.5) * 120, e: w.e - 2200 + (r() - 0.5) * 120, w: r() < 0.15 ? 'mumble' : w.w }));
  const o = wordOffsets(new Map([['a', ref], ['b', early]])).offsets.get('b')!;
  assert.equal(o.method, 'words');
  assert.ok(Math.abs(o.ms - 2200) <= 80, `offset ${o.ms}`);
});

test('Final_offsets: too few shared words, or only stop words and short words, give no word offset', () => {
  const few = wordOffsets(new Map([['a', say(A, 0)], ['b', say('ferryman wants twelve', 500)]])).offsets.get('b')!;
  assert.equal(few.method, 'none');
  const stop = wordOffsets(new Map([['a', say('the and you that this with for are was but not have its the and you', 0)], ['b', say('the and you that this with for are was but not have its', 900)]])).offsets.get('b')!;
  assert.equal(stop.method, 'none');
  assert.equal(stop.votes, 0, 'stop words never vote');
});

test('Final_offsets: different conversations with chance matches do not invent an offset', () => {
  // The same handful of names comes up all evening at random times on both mics: no consistent difference.
  const names = ['Saltmarsh', 'Velmira', 'ferryman', 'smuggler', 'lighthouse', 'goblins'];
  const r = rng(3);
  const mk = () => Array.from({ length: 60 }, () => { const s = Math.round(r() * 600_000); return { w: names[Math.floor(r() * names.length)], s, e: s + 300, c: 0.9, l: 0.5 }; });
  const o = wordOffsets(new Map([['a', mk()], ['b', mk()]]), { reach: 4000 }).offsets.get('b')!;
  assert.equal(o.method, 'none', `found ${o.ms} ms from ${o.votes} votes`);
});

test('Final_offsets: words further apart than the reach do not vote', () => {
  const o = wordOffsets(new Map([['a', say(`${A} ${B}`, 0)], ['b', say(`${A} ${B}`, 9000)]]), { reach: 4000 }).offsets.get('b')!;
  assert.equal(o.method, 'none');
});

test('Final_offsets: upload clock samples are taken relative to the median mic, so network latency cancels', () => {
  // Every device's quickest upload took ~120 ms; phone2's clock is 900 ms behind, phone3's 400 ms ahead.
  const up = uploadOffsets(new Map([['table', [140, 125, 300]], ['phone2', [1030, 1020, 1400]], ['phone3', [-280, -275]], ['once', [5000]]]));
  assert.equal(up.has('once'), false, 'a mic with one sample is not trusted');
  assert.equal(up.get('table'), 0);
  assert.equal(up.get('phone2'), 1020 - 125);
  assert.equal(up.get('phone3'), -280 - 125);
  assert.equal(uploadOffsets(new Map([['solo', [10, 20, 30]]])).size, 0, 'one mic alone has nothing to compare with');
});

test('Final_offsets: chooseOffsets prefers words, falls back to upload samples re-based on the reference, else 0', () => {
  const streams = new Map<string, Word[]>([
    ['table', [...say(A, 0), ...say(B, 6000), ...say(C, 12000)]],
    ['phone', shift([...say(A, 0), ...say(B, 6000)], 700)],
    ['quiet', say('hmm yes', 3000)],
  ]);
  const skews = new Map<string, number[]>([['table', [200, 210]], ['phone', [5000, 5100]], ['quiet', [-300, -250]], ['silent', [600, 650]]]);
  const o = chooseOffsets(streams, skews);
  assert.equal(o.get('table')!.method, 'reference');
  assert.equal(o.get('phone')!.method, 'words', 'shared words beat a wild upload sample');
  assert.ok(Math.abs(o.get('phone')!.ms + 700) <= 20);
  // quiet: too few words; upload says it is 300 ms behind the reference's 200 (median is 200 here).
  assert.deepEqual(o.get('quiet'), { ms: -300 - 200, method: 'upload', votes: 0 });
  assert.equal(o.get('silent')!.method, 'upload', 'a mic with no words still gets its upload offset');
  assert.equal(o.get('silent')!.ms, 600 - 200);
  const none = chooseOffsets(new Map([['a', say(A, 0)], ['b', say('hello there', 0)]]), new Map());
  assert.deepEqual(none.get('b'), { ms: 0, method: 'none', votes: 0 });
});

// ---- dedupe -------------------------------------------------------------------------------------------------------

test('Final_dedupe: the same speech from two mics becomes one line, from the better mic, crediting both', () => {
  const near = line('jess', A, 1000, { level: 0.7 });
  const far = line('tom', A.replace('twelve', 'twelfth').replace('Saltmarsh', 'salt marsh'), 1250, { level: 0.2, conf: 0.6 });
  const out = dedupeLines([far, near]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, A, 'the clearer mic wins');
  assert.deepEqual(out[0].mics.sort(), ['jess', 'tom']);
  assert.ok(out[0].stats.jess && out[0].stats.tom, 'both mics stay in the stats (for the speaker choice)');
  assert.equal(out[0].start, 1000);
  assert.equal(out[0].end, Math.max(near.end, far.end));
});

test('Final_dedupe: a fragment one mic caught is folded into the full line another mic heard', () => {
  const full = line('table', A, 0, { level: 0.5 });
  const frag = line('phone', 'twelve silver pieces before crossing', 1200, { level: 0.3 });
  const out = dedupeLines([full, frag]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, A);
  assert.deepEqual(out[0].mics.sort(), ['phone', 'table']);
});

test('Final_dedupe: crosstalk (different words at the same time) is kept, so is anything from one mic', () => {
  const a = line('jess', A, 0);
  const b = line('tom', B, 300);
  assert.equal(dedupeLines([a, b]).length, 2, 'two people talking over each other');
  const again = line('jess', A, 200);
  assert.equal(dedupeLines([a, again]).length, 2, 'one mic cannot hear the same thing twice at once: never merged');
  const later = line('tom', A, 30_000);
  assert.equal(dedupeLines([a, later]).length, 2, 'the same words much later are a repeat, not a duplicate');
  const brush = line('tom', A, a.end - 300);
  assert.equal(dedupeLines([a, brush]).length, 2, 'lines that barely touch are not the same speech');
});

test('Final_dedupe: six mics hearing one sentence give one line; output is in time order', () => {
  const mics = ['dm', 'table', 'p1', 'p2', 'p3', 'p4'];
  const ls = mics.map((m, i) => line(m, i % 2 ? A.replace('pieces', 'piece') : A, 1000 + i * 60, { level: m === 'p2' ? 0.9 : 0.2 }));
  ls.push(line('p3', B, 12_000));
  const out = dedupeLines(ls.reverse());
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].mics.sort(), [...mics].sort());
  assert.ok(out[0].stats.p2.level === 0.9);
  assert.ok(out[0].start < out[1].start);
});

// ---- tidy ---------------------------------------------------------------------------------------------------------

test('Final_tidy: fragments of one voice a breath apart are joined; a sentence end, a cut, another voice or a long pause are not', () => {
  const a = line('jess', 'The ferryman wants twelve', 0);
  const b = line('jess', 'silver pieces before crossing.', a.end + 300);
  const joined = tidyLines([b, a], []);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].text, 'The ferryman wants twelve silver pieces before crossing.');
  const c = line('jess', 'Nobody trusts him', joined[0].end + 200);
  assert.equal(tidyLines([a, b, c], []).length, 2, 'not across a full stop');
  assert.equal(tidyLines([a, b], [a.end + 150]).length, 2, 'not across an aside edge');
  const other = line('tom', 'silver pieces before crossing.', a.end + 300, { level: 0.9 });
  assert.equal(tidyLines([a, other], []).length, 2, 'not across voices');
  const late = line('jess', 'silver pieces before crossing.', a.end + 2000);
  assert.equal(tidyLines([a, late], []).length, 2, 'not across a long pause');
});

test('Final_tidy: a joined line never runs past the longest line', () => {
  const a = line('jess', Array.from({ length: 45 }, (_, i) => `word${i}`).join(' '), 0, { step: 500 });
  const b = line('jess', 'and then more', a.end + 200);
  assert.ok(b.end - a.start > MAX_UTTERANCE_MS);
  assert.equal(tidyLines([a, b], []).length, 2);
});

// ---- the whole chain on many mics ----------------------------------------------------------------------------------

/** What the engine does for one window of the final pass, without the database. */
function finalPass(streams: Map<string, Word[]>, skews = new Map<string, number[]>(), cuts: number[] = []) {
  const offs = chooseOffsets(streams, skews);
  const utts = [...streams].flatMap(([m, ws]) => utterances(m, shift(ws, offs.get(m)?.ms ?? 0), 700, MAX_UTTERANCE_MS));
  return { offs, lines: tidyLines(dedupeLines(groupUtterances(utts).map(mergeGroup).filter((l) => l.words.length)), cuts) };
}

test('Final_chain: six devices with drifting clocks give each sentence once, in order, from the closest mic', () => {
  // Four sentences, each said near one phone; every device hears every sentence (quieter further away), with its own clock error.
  const talk = [{ who: 'p1', text: A, at: 2000 }, { who: 'p2', text: B, at: 9000 }, { who: 'p3', text: C, at: 16_000 }, { who: 'p4', text: D, at: 23_000 }];
  const clock: Record<string, number> = { table: 0, dm: 150, p1: -1800, p2: 2400, p3: 900, p4: -3100 };
  const r = rng(11);
  const streams = new Map<string, Word[]>();
  for (const m of Object.keys(clock)) {
    const ws: Word[] = [];
    for (const t of talk) {
      const close = t.who === m;
      for (const w of say(t.text, t.at, { step: 250, l: close ? 0.8 : m === 'table' ? 0.35 : 0.12, c: close ? 0.95 : 0.7 })) ws.push({ ...w, s: w.s + clock[m] + (r() - 0.5) * 60, e: w.e + clock[m] + (r() - 0.5) * 60 });
    }
    streams.set(m, ws);
  }
  // Without the sync a line is timed by its loudest mic's clock: the sentence near p2 lands 2.4 s late.
  const naive = dedupeLines(groupUtterances([...streams].flatMap(([m, ws]) => utterances(m, ws, 700, MAX_UTTERANCE_MS))).map(mergeGroup));
  const nb = naive.find((l) => l.text === B)!;
  assert.ok(nb.start > 9000 + 2000, `unsynced, B starts at ${nb.start}`);

  const { offs, lines } = finalPass(streams);
  assert.equal(lines.length, talk.length, lines.map((l) => l.text).join(' / '));
  for (const [i, t] of talk.entries()) {
    assert.equal(lines[i].text, t.text, 'each sentence once, word for word, in order');
    assert.equal(lines[i].mics.length, 6, 'every mic is credited');
    const loudest = Object.entries(lines[i].stats).sort((a, b) => b[1].level - a[1].level)[0][0];
    assert.equal(loudest, t.who, 'the closest mic is the loudest (the speaker)');
    assert.ok(Math.abs(lines[i].start - (t.at + clock.table)) < 400, `sentence ${i} at ${lines[i].start} (said at ${t.at})`);
  }
  for (const [m, c] of Object.entries(clock)) assert.ok(Math.abs(offs.get(m)!.ms + c - clock.table) <= 60, `${m}: ${offs.get(m)!.ms} vs clock ${c}`);
});

test('Final_chain: a mic that only heard silence or one word does not disturb the rest', () => {
  const streams = new Map<string, Word[]>([
    ['table', [...say('The ferryman wants twelve', 0), ...say('silver pieces before crossing.', 2000), ...say(B, 6000)]],
    ['phone', shift([...say('The ferryman wants twelve', 0), ...say('silver pieces before crossing.', 2000), ...say(B, 6000)], 600)],
    ['empty', []],
    ['cough', say('hmm', 4000)],
  ]);
  const { lines, offs } = finalPass(streams);
  assert.deepEqual(offs.get('empty'), { ms: 0, method: 'none', votes: 0 }, 'a mic with no words and no samples is left where it is');
  assert.deepEqual(lines.map((l) => l.text), ['The ferryman wants twelve silver pieces before crossing.', 'hmm', B]);
  assert.ok(Math.abs(offs.get('phone')!.ms + 600) <= 20);
  assert.deepEqual(lines[2].mics.sort(), ['phone', 'table']);
});
