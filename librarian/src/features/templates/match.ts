// Which guides a GM request calls for. A guide is used when the GM names it ("use guide Towns", "follow the Towns
// guide"), or when one of its trigger words is in a request to make something ("make a village by the river").
// Pure, so it is unit tested without a world.
import { GUIDE_KINDS, type Kind } from './spec.ts';

export interface Matchable { id: string; name: string; kind: Kind; triggers: string[]; enabled: boolean; spec: any }
export interface GuideMatch<T extends Matchable = Matchable> { t: T; why: 'named' | 'trigger'; hits: string[] }

/** A request to make or change something: a trigger word alone ("how big is the town?") is not one. */
export const CREATE = /\b(make|makes|making|create|creating|write|writing|draft|drafting|generate|build|design|prep|prepare|flesh(?:ing)? out|invent|come up with|new|add|stock|plan|roll up|need an?)\b/i;
/** "no guide", "without the guide": the GM turns guides off for this message. */
export const NO_GUIDE = /\b(no guides?|without (?:a|the|any|my) guides?|skip the guides?)\b/i;
/** Talking about guides and templates themselves ("make a guide for towns") is not a request a guide should steer. */
const ABOUT_GUIDES = /\b(guides?|templates?)\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The trigger as a whole word or phrase, plural forms included (town/towns, city/cities, inn/inns). */
export function triggerRe(trigger: string): RegExp {
  const t = trigger.trim().toLowerCase();
  const base = esc(t).replace(/\s+/g, '\\s+');
  const plural = /y$/.test(t) && !/[aeiou]y$/.test(t) ? `|${esc(t.slice(0, -1))}ies` : '';
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${base}(?:s|es)?${plural})(?![\\p{L}\\p{N}])`, 'iu');
}

/** The guide the GM named in the message, as they wrote it ("Towns" from "use guide Towns: ..."), or null. */
export function namedGuide(text: string): string | null {
  const pats = [
    /\b(?:use|using|follow|following|apply|with)\s+(?:the\s+|my\s+)?guide\s*[:=]?\s*["“']?([^"”'.,;:!?\n]{1,80})/i,
    /\b(?:use|using|follow|following|apply|with)\s+(?:the\s+|my\s+)?["“']?([^"”'.,;:!?\n]{1,60}?)["”']?\s+guide\b/i,
  ];
  for (const re of pats) { const m = re.exec(text); if (m?.[1]?.trim()) return m[1].trim(); }
  return null;
}

/** The template a named guide means: the longest name the words start with (or that contains them). */
export function findNamed<T extends Matchable>(said: string, list: T[]): T | null {
  const w = said.toLowerCase().replace(/\s+/g, ' ').trim();
  const usable = list.filter((t) => t.enabled && GUIDE_KINDS.includes(t.kind));
  const exact = usable.find((t) => t.name.toLowerCase() === w);
  if (exact) return exact;
  const starts = usable.filter((t) => w.startsWith(t.name.toLowerCase()) && /^(?:\s|$)/.test(w.slice(t.name.length))).sort((a, b) => b.name.length - a.name.length);
  if (starts[0]) return starts[0];
  return usable.find((t) => w.length >= 3 && t.name.toLowerCase().includes(w)) ?? null;
}

/**
 * The guides for this request, best first (at most `max`). Named guides always come first. Trigger words only count
 * in a request to make something (or for a guide marked `always`), and not when the message is about guides themselves.
 */
export function matchGuides<T extends Matchable>(text: string, list: T[], max = 2): GuideMatch<T>[] {
  if (!text.trim() || NO_GUIDE.test(text)) return [];
  const out: GuideMatch<T>[] = [];
  const said = namedGuide(text);
  const named = said ? findNamed(said, list) : null;
  if (named) out.push({ t: named, why: 'named', hits: [named.name] });
  const aboutGuides = !said && ABOUT_GUIDES.test(text);
  const creating = CREATE.test(text);
  const scored: GuideMatch<T>[] = [];
  for (const t of list) {
    if (!t.enabled || !GUIDE_KINDS.includes(t.kind) || out.some((o) => o.t.id === t.id)) continue;
    if (aboutGuides || (!creating && t.spec?.always !== true)) continue;
    const hits = t.triggers.filter((tr) => tr.trim() && triggerRe(tr).test(text));
    if (hits.length) scored.push({ t, why: 'trigger', hits });
  }
  scored.sort((a, b) => b.hits.length - a.hits.length || a.t.name.localeCompare(b.t.name));
  return [...out, ...scored].slice(0, max);
}

/** A real-world reference the request names: "based on Tomonoura", "inspired by the real Kotohira". */
export function referenceIn(text: string): string {
  const m = /\b(?:based on|inspired by|modell?ed (?:on|after)|after the real|like the real|reference:?|irl:?|real[- ]world:?)\s+(?:the\s+)?(?:real\s+|irl\s+)?["“']?([\p{L}\p{N}][\p{L}\p{N}' -]{1,60}?)["”']?(?=\s*(?:[,.;:!?)]|\band\b|\bnear\b|\bbut\b|\bwith\b|\bin\b|\bfor\b|$))/iu.exec(text);
  return m?.[1]?.trim() ?? '';
}

/** The name the new thing is given: "called Kirihama", "named 'Kirihama'", or a quoted name. */
export function nameIn(text: string): string {
  const m = /\b(?:called|named)\s+["“']?([\p{L}\p{N}][\p{L}\p{N}' -]{0,40}?)["”']?(?=\s*(?:[,.;:!?)]|\band\b|\bnear\b|\bbased\b|\binspired\b|\bon\b|\bin\b|\bby\b|$))/iu.exec(text) ?? /["“]([^"”]{2,40})["”]/.exec(text);
  return m?.[1]?.trim() ?? '';
}

/** A place the request puts it near: "near Saltmarsh", "between X and Y", "around X", "in the X region". */
export function nearIn(text: string): string[] {
  const out: string[] = [];
  const cap = '([\\p{Lu}][\\p{L}\\p{N}\']*(?:\\s+(?:of\\s+(?:the\\s+)?)?[\\p{Lu}][\\p{L}\\p{N}\']*){0,3})';
  for (const re of [new RegExp(`\\b(?:near|by|beside|next to|around|outside|close to|north of|south of|east of|west of|upriver from|downriver from|down the coast from|in the)\\s+(?:the\\s+)?${cap}`, 'gu'), new RegExp(`\\bbetween\\s+(?:the\\s+)?${cap}\\s+and\\s+(?:the\\s+)?${cap}`, 'gu')]) {
    for (const m of text.matchAll(re)) for (const g of m.slice(1)) if (g && !out.includes(g)) out.push(g.trim());
  }
  return out.slice(0, 4);
}

/** A step's web query with its placeholders filled in; '' when it needs a reference the request does not give. */
export function fillQuery(template: string, text: string): string {
  const ref = referenceIn(text);
  const name = nameIn(text);
  if (/\{reference\}/.test(template) && !ref) return '';
  return template.replace(/\{reference\}/g, ref).replace(/\{name\}/g, name || ref).replace(/\{request\}/g, text.slice(0, 120)).replace(/\s+/g, ' ').trim();
}
