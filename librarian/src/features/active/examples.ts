// Labelled example lines for Active mode's narration scan. The scan asks the
// audit model what a GM's narration calls for; with the embeddings job set the
// examples nearest the lines in the batch ride along in the prompt (few-shot by
// similarity), so the model sees how a close case was labelled: which lines
// call for sound, an item, coins or the clock, and which only mention them.
// The bank is generic (no world content). Without an embeddings model, or if it
// fails, the scan runs as before. The model still only picks from what the
// engine knows how to do, and the rules and confirmation steps are unchanged.
import type { Deps } from '../../app.ts';
import { embed, hasJob, jobConfig } from '../../core/ai.ts';
import { embedCached } from '../../core/embedcache.ts';

export interface LineExample { line: string; actions: Record<string, unknown>[] }

const A = (line: string, ...actions: Record<string, unknown>[]): LineExample => ({ line, actions });

export const LINE_EXAMPLES: LineExample[] = [
  A('You leave the forest behind and step into a sunlit meadow, birdsong everywhere.', { cat: 'music', mood: 'calm' }),
  A('The corridor narrows and the torches gutter out one by one. Something is watching from the dark.', { cat: 'music', mood: 'tense' }),
  A('You edge along the ledge, careful not to make a sound, the guards just below.', { cat: 'music', mood: 'sneaky' }),
  A('Rain starts to hammer the roof of the barn.', { cat: 'ambience', layers: ['rain'] }),
  A('A cold wind howls across the moor as you crest the hill.', { cat: 'ambience', layers: ['wind'] }),
  A('The tavern is packed tonight, laughter and clinking mugs everywhere.', { cat: 'ambience', layers: ['tavern'] }),
  A('You warm yourselves by the roaring campfire.', { cat: 'ambience', layers: ['hearth'] }),
  A('Suddenly the great bell above the chapel begins to toll.', { cat: 'sfx', name: 'bell' }),
  A('With a deafening bang the barrel explodes.', { cat: 'sfx', name: 'explosion' }),
  A('A wolf howls somewhere in the hills.', { cat: 'sfx', name: 'howl' }),
  A('The old gate screeches open on rusty hinges.', { cat: 'sfx', name: 'creak' }),
  A('Behind the loose stone you find a golden locket.', { cat: 'item', name: 'golden locket', qty: 1 }),
  A('The grateful farmer presses a handful of coins into your hands, thirty gold in all.', { cat: 'coins', gp: 30 }),
  A('The merchant counts out twelve silver pieces as your reward.', { cat: 'coins', sp: 12 }),
  A('You make camp and sleep until dawn.', { cat: 'clock', preset: 'long-rest' }),
  A('Let us say you take a short rest here and an hour passes.', { cat: 'clock', preset: 'short-rest' }),
  A('Two days of hard riding later, the city walls rise ahead.', { cat: 'clock', minutes: 2880 }),
  A('Everyone roll a Dexterity save, DC 14, the floor is giving way!', { cat: 'event', skill: 'Dexterity', dc: 14 }),
  A('Give me a Wisdom check, DC 12, to see if you sense the lie.', { cat: 'event', skill: 'Wisdom', dc: 12 }),
  A('The orc raises his axe and roars at you.'),
  A('Thunder might roll in later if the storm holds, we will see.'),
  A('Last night a bell was rung in the old tower.'),
  A('Maybe the party finds a key in the cellar, I have not decided yet.'),
  A('You could buy the sword for fifty gold if you like.'),
  A('The innkeeper tells you the room costs five silver.'),
  A('Anselm asks what the place smells like.'),
  A('You go up the stairs and into the chamber.'),
  A('The old man tells you about the winter the river froze solid.'),
  A('In the fight the goblin screams and falls to the floor.'),
];

const unit = (v: number[]): Float32Array => {
  const f = Float32Array.from(v);
  let n = 0;
  for (const x of f) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
};
const bank = new WeakMap<object, { model: string; vecs: Float32Array[] }>();

async function bankVectors(d: Deps): Promise<Float32Array[] | null> {
  const model = jobConfig(d, 'extra')?.model;
  if (!model) return null;
  const hit = bank.get(d.env as object);
  if (hit && hit.model === model) return hit.vecs;
  const got = await embedCached(d, LINE_EXAMPLES.map((e) => e.line));
  if (got.length !== LINE_EXAMPLES.length || got.some((v) => !Array.isArray(v) || !v.length)) return null;
  const vecs = got.map(unit);
  bank.set(d.env as object, { model, vecs });
  return vecs;
}

/** ALX_ACTIVE_EXAMPLES=1 turns the examples on (the embeddings job must be set too). */
export const examplesOn = (d: Deps): boolean => String(d.env?.ALX_ACTIVE_EXAMPLES ?? '') === '1' && hasJob(d, 'extra');

/**
 * The examples nearest the lines (at most `max`, best first, each only once).
 * Null when there is no embeddings model or it fails: the caller adds nothing.
 */
export async function similarLineExamples(d: Deps, lines: string[], max = 6): Promise<LineExample[] | null> {
  if (!lines.length || !hasJob(d, 'extra')) return null;
  try {
    const vecs = await bankVectors(d);
    if (!vecs) return null;
    const got = await embed(d, lines.map((l) => l.slice(0, 400)));
    if (got.length !== lines.length) return null;
    const best = new Map<number, number>();
    for (const g of got) {
      const q = unit(g);
      if (q.length !== vecs[0].length) return null;
      const scored = vecs.map((v, i) => { let dot = 0; for (let j = 0; j < q.length; j++) dot += q[j] * v[j]; return { i, dot }; }).sort((a, b) => b.dot - a.dot).slice(0, 3);
      for (const s of scored) best.set(s.i, Math.max(best.get(s.i) ?? 0, s.dot));
    }
    return [...best].sort((a, b) => b[1] - a[1]).slice(0, max).map(([i]) => LINE_EXAMPLES[i]);
  } catch { return null; }
}
