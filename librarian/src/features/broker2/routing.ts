// How a broker question is routed (PLAN §1.5). The audit model, when one is
// set, labels the question with scope, intent, type and confidence. Its input
// is only the question, the real-world topics the DM allows and the titles of
// pages players can read: never DM text. With no audit model (or if it fails),
// plain keyword rules give the same labels. Keyword rules for spoilers and
// meta-gaming also back the model up: they can only send a question to the DM,
// never let one through.
import type { Deps } from '../../app.ts';
import { chatJson } from '../../core/ai.ts';
import { all } from '../../core/db.ts';
import { namedEntities, questionType, spoilerTagHit, stem, words, type QuestionType } from '../../core/brokerClassify.ts';
import { searchRules } from '../modules/search.ts';

export type Scope = 'world' | 'real-world-allowed' | 'rules' | 'item' | 'off-topic';
export type Intent = 'fact' | 'spoiler-seeking' | 'meta-gaming';
export interface Labels {
  scope: Scope;
  intent: Intent;
  type: QuestionType;
  confidence: number;
  /** Where the labels came from. */
  source: 'audit' | 'audit+rules' | 'rules';
  /** One line for the DM. */
  why: string;
}

export const LOW_CONFIDENCE = 0.6;
const SCOPES: Scope[] = ['world', 'real-world-allowed', 'rules', 'item', 'off-topic'];
const INTENTS: Intent[] = ['fact', 'spoiler-seeking', 'meta-gaming'];
const TYPES = ['who', 'where', 'when', 'why', 'how', 'price', 'what', 'other'];

export const SPOILER_WORDS = /\b(villains?|bbeg|big bad|antagonist|mastermind|twists?|secrets?|secretly|true (identity|name|purpose|form)|real (identity|name|purpose)|who is really|behind (the|that|this) (door|curtain|mask|wall)|what'?s behind|final boss|traitor|spoilers?)\b/i;
export const META_WORDS = /\b(hp|hit points?|armou?r class|ac|dc|stat ?blocks?|stats|challenge rating|cr|attack bonus)\b/i;
const OFF_TOPIC = /\b(homework|essay|poem|haiku|limerick|python|javascript|typescript|c\+\+|sql|regex|recipe|weather|forecast|stocks?|bitcoin|crypto|election|president|prime minister|news|football|soccer|nba|nfl|netflix|youtube|tiktok|minecraft|fortnite|pokemon|skyrim|zelda|marvel|star wars|harry potter|taylor swift|iphone|android|linux|math problem|solve for|translate|capital of|who won the|write (me )?(a|an) (story|script|program|code|email|letter))\b/i;
const RULES_STRONG = /\b(grappl\w+|opportunity attacks?|saving throws?|spell slots?|bonus actions?|death saves?|advantage on|disadvantage|concentration check|short rest|long rest|ability checks?|rules? (for|of|on|about)|what (are|is) the rules?)\b/i;
const RULES_WEAK = /\b(how (does|do|is) .{0,40}\b(work|works|resolved|calculated)|rules?)\b/i;

const norm = (t: string) => ` ${t.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** "Feudal Japan: history, folklore, customs": the head, then optional sub-topics. */
function topicHit(question: string, topic: string): boolean {
  const [head, rest = ''] = topic.split(':');
  const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));
  const qs = words(question).map(stem);
  const has = (w: string) => qs.some((x) => near(x, stem(w)));
  const hw = words(head);
  if (!hw.length) return false;
  if (hw.every(has)) return true;
  const sub = words(rest.replace(/,/g, ' '));
  return hw.some(has) && sub.some(has);
}
export const allowedTopicHit = (question: string, topics: string[]) => topics.find((t) => topicHit(question, t)) ?? null;

/** Titles of pages players may read: all the audit model is told about the world. */
export function sharedPageNames(d: Deps, worldId: string): string[] {
  return all<{ title: string }>(d.db, `SELECT title FROM pages WHERE world_id = ? AND visibility = 'party' AND player_body IS NOT NULL ORDER BY title LIMIT 300`, worldId).map((p) => p.title);
}

export function keywordLabels(d: Deps, worldId: string, question: string, topics: string[], itemNames: string[]): Labels {
  const type = questionType(question);
  const s = norm(question);
  const named = namedEntities(d.db, worldId, question).length > 0;
  const topic = allowedTopicHit(question, topics);
  const item = itemNames.find((n) => n.length >= 3 && s.includes(norm(n)));
  let intent: Intent = 'fact';
  let why = 'Looks like a plain question about the world.';
  if (SPOILER_WORDS.test(question)) { intent = 'spoiler-seeking'; why = 'Asks for something hidden (a villain, a twist, a secret).'; }
  else if (META_WORDS.test(question)) { intent = 'meta-gaming'; why = 'Asks for game numbers (HP, AC, DC, stats).'; }
  else if (spoilerTagHit(d.db, worldId, question)) { intent = 'spoiler-seeking'; why = 'Names something you tagged as a spoiler.'; }
  const make = (scope: Scope, confidence: number, w = why): Labels => ({ scope, intent, type, confidence, source: 'rules', why: w });
  if (OFF_TOPIC.test(question) && !named && !topic) return make('off-topic', 0.9, 'Not about the world or an allowed topic.');
  if (intent !== 'fact') return make(topic ? 'real-world-allowed' : item ? 'item' : 'world', 0.9);
  if (item) return make('item', 0.8, `Names an item the asker can see (${item}).`);
  if (RULES_STRONG.test(question) && !named) return make('rules', 0.85, 'A game rules question.');
  if (RULES_WEAK.test(question) && !named && searchRules(d.db, worldId, question, 1).length) return make('rules', 0.7, 'A game rules question.');
  if (topic) return make('real-world-allowed', 0.8, `About an allowed topic (${topic}).`);
  return make('world', named ? 0.9 : 0.7);
}

const SYSTEM = `You label questions put to an in-world information broker in a tabletop role-playing game.
You see only the question, the real-world topics the broker may discuss, and the titles of pages the players can read.
Reply with JSON only: {"scope": ..., "intent": ..., "type": ..., "confidence": ...}
scope: "world" (the game world's places, people, history, factions, items, events), "real-world-allowed" (one of the allowed topics), "rules" (game rules or mechanics), "item" (an item the asker carries), "off-topic" (anything else).
intent: "fact" (an ordinary question), "spoiler-seeking" (asks for hidden truths: the villain, the twist, secrets, what is behind a door), "meta-gaming" (asks for game numbers: hit points, armor class, DCs, stat blocks).
type: one of who, where, when, why, how, price, what, other.
confidence: a number from 0 to 1.`;

/** Label a question. Never throws; falls back to keyword rules. */
export async function routeQuestion(d: Deps, worldId: string, question: string, topics: string[], itemNames: string[]): Promise<Labels> {
  const kw = keywordLabels(d, worldId, question, topics, itemNames);
  const j: any = await chatJson(d, 'audit', [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ question, allowedTopics: topics, sharedPages: sharedPageNames(d, worldId) }) },
  ]).catch(() => null);
  if (!j || !SCOPES.includes(j.scope) || !INTENTS.includes(j.intent)) return kw;
  let confidence = Number(j.confidence);
  confidence = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
  let intent: Intent = j.intent;
  let source: Labels['source'] = 'audit';
  // The keyword rules can only add caution.
  if (intent === 'fact' && kw.intent !== 'fact') { intent = kw.intent; source = 'audit+rules'; }
  const tag = spoilerTagHit(d.db, worldId, question);
  if (tag) { intent = 'spoiler-seeking'; source = 'audit+rules'; }
  return { scope: j.scope, intent, type: (TYPES.includes(j.type) ? j.type : kw.type) as QuestionType, confidence, source, why: source === 'audit' ? 'Labelled by the audit model.' : `Labelled by the audit model; the keyword rules flagged it (${kw.why}).` };
}
