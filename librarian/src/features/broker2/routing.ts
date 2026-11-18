// How a broker question is routed (PLAN §1.5). The audit model, when one is
// set, labels the question with scope, intent, type and confidence. Its input
// is only the question, the real-world topics the DM allows and the titles of
// pages players can read: never DM text. With no audit model (or if it fails),
// plain keyword rules give the same labels. Keyword rules for spoilers and
// meta-gaming also back the model up: they can only send a question to the DM,
// never let one through.
import type { Deps } from '../../app.ts';
import { chat, chatJson, hasJob } from '../../core/ai.ts';
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

// ---- does the matched player text answer the question? ------------------------

const WHY_CUE = /\b(because|since|due to|owing to|caused?|causes|reason|thanks to|as a result|result of|after|so that|in order to|blames?|blamed)\b/i;
const NEEDS_ANSWER = /\b(why|how come|what (is|was|'s|s) (really )?(behind|causing|the reason|the cause)|what (caused|causes|lies behind|happened to)|the reason (for|behind)|how (did|does|do|is|was)\b)/i;
const KEY_STOP = new Set('did does do is was were are the a an to of in on at for and or why how what come behind go went gone get got happen happened happens cause caused reason really actually this that'.split(' '));

/** "Why" and "how" questions (and "what is behind ...") need a shared text that really says why or how; plain fact questions do not. */
export const needsAnswerCheck = (question: string, type: string): boolean => type === 'why' || type === 'how' || NEEDS_ANSWER.test(question);

/** The question's own content words: what the matched text has to be about. */
export const keyTerms = (question: string): string[] => words(question).filter((w) => !KEY_STOP.has(w)).map(stem);

/** The rules check: the text shares a key term with the question and, for "why", says why. */
export function ruleAnswers(question: string, snippet: string): boolean {
  const keys = keyTerms(question);
  const have = new Set(words(snippet).map(stem));
  if (keys.length && !keys.some((k) => have.has(k))) return false;
  if (/\b(why|how come|the reason|caused?|causes)\b/i.test(question) && !WHY_CUE.test(snippet)) return false;
  return true;
}

/**
 * Does the matched snippet (the player's copy, nothing else) answer the question?
 * The audit model says yes or no when there is one; without it the rules above decide.
 * "No" sends the question to the DM.
 */
export async function answersQuestion(d: Deps, question: string, snippet: string): Promise<boolean> {
  const j: any = await chatJson(d, 'audit', [
    { role: 'system', content: 'You check whether a short text answers a question. Reply with JSON only: {"answers": true or false}. "answers" is true only if the text itself states the answer (for a "why" question, the reason; for a "how" question, the way it happens). Mentioning the same subject, or saying that something is so without saying why, does not answer it.' },
    { role: 'user', content: JSON.stringify({ question, text: snippet.slice(0, 1500) }) },
  ]).catch(() => null);
  if (j && typeof j.answers === 'boolean') return j.answers;
  return ruleAnswers(question, snippet);
}

/**
 * An allowed real-world topic: the chat model answers in the broker's voice from general knowledge only.
 * It is given the question and the topic and nothing from the library, so it cannot repeat DM text.
 * Null when there is no chat model (the question then goes the usual way).
 */
export async function realWorldAnswer(d: Deps, persona: string, question: string, topic: string): Promise<string | null> {
  if (!hasJob(d, 'chat')) return null;
  try {
    const r = await chat(d, 'chat', {
      temperature: 0,
      maxTokens: 400,
      messages: [
        { role: 'system', content: `You are ${persona}, an information broker in a fantasy tabletop game. The player asked about a real-world topic the game master allows${topic ? ` ("${topic}")` : ''}. Start with "That's not my trade, but", then answer in two or three sentences from general knowledge only. You know nothing about the game's world, its people or its secrets, and you must not invent any. If you do not know, say so.` },
        { role: 'user', content: question },
      ],
    });
    const text = r.content.trim();
    return text || null;
  } catch { return null; }
}
