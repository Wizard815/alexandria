// Rank and decide: the small player-helper model helps with downtime.
//
// rank:   the activities a character could start are put in order for what
//         they want ("I want to get richer", "something for my wizard"):
//         first the rerank model (when the world has one), else a word match;
//         then the helper model picks the best three and says why in a line.
// decide: for a new activity a player or the GM describes, the helper model
//         picks its tier (common to legendary), how many days and how many
//         hours a day it takes. Without a model a word rule decides.
// Both work with no model at all; the answer says which way it was made.
import type { Deps } from '../../app.ts';
import { ALL_JOBS, ModelUnavailable, chatJson, rerankItems, type TextJob } from '../../core/ai.ts';
import { DEFAULT_TIER_DAYS, TIERS, TIER_LABEL, tierOf, type Activity, type Tier } from './catalog.ts';

/** The players' small model: the quick helper's job when this server has it, else the player job (then the chat model). */
export const helperJob = (): TextJob => ((ALL_JOBS as string[]).includes('helper') ? 'helper' : 'player') as TextJob;

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
const STOP = new Set(['the', 'and', 'for', 'with', 'want', 'like', 'some', 'something', 'would', 'could', 'that', 'this', 'from', 'into', 'have', 'get', 'more', 'about', 'what', 'need']);

function wordScore(q: string, a: Activity): number {
  const want = [...words(q)].filter((w) => !STOP.has(w));
  if (!want.length) return 0;
  const hay = `${a.name} ${a.summary} ${a.tags.join(' ')}`.toLowerCase();
  return want.reduce((n, w) => n + (hay.includes(w) ? 2 : hay.includes(w.slice(0, 4)) ? 1 : 0), 0);
}

export interface Ranked { id: string; name: string; tier: Tier; tierLabel: string; days: number; hoursPerDay: number; why: string }
export interface RankResult { picks: Ranked[]; by: 'model' | 'rerank' | 'words'; job?: string }

/**
 * Order `options` for what the character wants and pick the best `n`. `who` is a short plain description of the
 * character (name, class and level, what they did lately) built from rows the caller may see.
 */
export async function rankActivities(d: Deps, options: (Activity & { daysNeeded: number })[], want: string, who: string, n = 3): Promise<RankResult> {
  const q = `${want} ${who}`.trim();
  let list = [...options].map((a, i) => ({ a, i, s: wordScore(want || who, a) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.a);
  let by: RankResult['by'] = 'words';
  const reranked = await rerankItems(d, q, list, (a) => `${a.name}. ${TIER_LABEL[a.tier]}. ${a.summary} ${a.tags.join(', ')}`, { top: 24, budgetMs: 1500 });
  if (reranked !== list) { list = reranked; by = 'rerank'; }
  const head = list.slice(0, 10);
  const out = (a: Activity & { daysNeeded: number }, why: string): Ranked => ({ id: a.id, name: a.name, tier: a.tier, tierLabel: TIER_LABEL[a.tier], days: a.daysNeeded, hoursPerDay: a.hoursPerDay, why });
  try {
    const menu = head.map((a, i) => `${i + 1}. ${a.name} [${TIER_LABEL[a.tier]}, ${a.daysNeeded} day${a.daysNeeded === 1 ? '' : 's'}${a.hoursPerDay < 8 ? `, ${a.hoursPerDay}h a day` : ''}]: ${a.summary.slice(0, 140)}`).join('\n');
    const j = await chatJson<any>(d, helperJob(), [
      { role: 'system', content: 'You help a tabletop RPG player choose downtime activities. Pick from the numbered list only. Reply with JSON only: {"picks":[{"n":<number>,"why":"<one short sentence to the player>"}]}. Pick at most ' + n + ', best first. Do not invent activities, names, places or rules.' },
      { role: 'user', content: `Character: ${who || 'unknown'}\nWhat they want: ${want || 'anything useful'}\n\nActivities:\n${menu}` },
    ], undefined, { maxTokens: 400 });
    const picks: Ranked[] = [];
    for (const p of Array.isArray(j?.picks) ? j.picks : []) {
      const a = head[Number(p?.n) - 1];
      if (!a || picks.some((x) => x.id === a.id)) continue;
      picks.push(out(a, typeof p.why === 'string' ? p.why.replace(/\s+/g, ' ').trim().slice(0, 200) : ''));
      if (picks.length >= n) break;
    }
    if (picks.length) return { picks, by: 'model', job: helperJob() };
  } catch (e) { if (!(e instanceof ModelUnavailable)) { /* a bad answer: fall back below */ } }
  return { picks: head.slice(0, n).map((a) => out(a, by === 'words' && wordScore(want, a) ? 'Matches what you asked for.' : '')), by };
}

const LEGENDARY = /\b(artifact|legendary|stronghold|castle|keep|fortress|kingdom|epic|godly|divine|master(ing)?|lich|dragon|archmage|wish|empire|years?)\b/i;
const VERY_RARE = /\b(very rare|rare magic|enchant\w*|guild|temple|army|language|fluent|proficien\w*|months?|ship)\b/i;
const RARE = /\b(rare|magic item|tournament|apprentic\w*|weeks?|business|shop|potion of)\b/i;
const UNCOMMON = /\b(craft\w*|research\w*|scroll|train\w*|potion|forge|study|studying|build|days)\b/i;

/** A word rule for when no model answers: the biggest word wins. */
export function tierByWords(text: string): Tier {
  return LEGENDARY.test(text) ? 'legendary' : VERY_RARE.test(text) ? 'very-rare' : RARE.test(text) ? 'rare' : UNCOMMON.test(text) ? 'uncommon' : 'common';
}

export interface Decision { tier: Tier; tierLabel: string; days: number; hoursPerDay: number; why: string; by: 'model' | 'words' }

/** Tier, days and hours a day for a new activity. `tierDays` are the world's defaults per tier. */
export async function decideTier(d: Deps, name: string, summary: string, tierDays: Record<Tier, number> = DEFAULT_TIER_DAYS, dayHours = 8): Promise<Decision> {
  const ladder = TIERS.map((t) => `${t} (usually ${tierDays[t]} day${tierDays[t] === 1 ? '' : 's'})`).join(', ');
  try {
    const j = await chatJson<any>(d, helperJob(), [
      { role: 'system', content: `You rate tabletop RPG downtime activities by how big and rare they are. Tiers, smallest to biggest: ${ladder}. Common: chores, odd jobs, a night out. Uncommon: research, mundane crafting, scribing a low scroll. Rare: magic items, tournaments, a business. Very rare: rare magic, a new language or skill, a guild or temple. Legendary: artifacts, anything with dragon, divine or epic materials, a stronghold, mastery under a legend. A downtime day is ${dayHours} hours. A "daily" task done an hour or two a day over a long time has hoursPerDay below ${dayHours}. Reply with JSON only: {"tier":"common|uncommon|rare|very-rare|legendary","days":<whole number>,"hoursPerDay":<1-${dayHours}>,"why":"<one short sentence>"}` },
      { role: 'user', content: `Activity: ${name}\n${summary}`.slice(0, 1200) },
    ], undefined, { maxTokens: 300 });
    const tier = tierOf(j?.tier);
    if (tier) {
      const days = Number.isInteger(j.days) && j.days >= 1 && j.days <= 3650 ? j.days : tierDays[tier];
      const hpd = Number.isInteger(j.hoursPerDay) && j.hoursPerDay >= 1 && j.hoursPerDay <= dayHours ? j.hoursPerDay : dayHours;
      return { tier, tierLabel: TIER_LABEL[tier], days, hoursPerDay: hpd, why: typeof j.why === 'string' ? j.why.replace(/\s+/g, ' ').trim().slice(0, 200) : '', by: 'model' };
    }
  } catch { /* no model or a bad answer */ }
  const tier = tierByWords(`${name} ${summary}`);
  const daily = /\b(daily|every day|each day|an hour a day|each morning|every morning|every night)\b/i.test(`${name} ${summary}`);
  return { tier, tierLabel: TIER_LABEL[tier], days: tierDays[tier], hoursPerDay: daily ? 1 : dayHours, why: '', by: 'words' };
}
