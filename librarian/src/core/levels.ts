// Four secrecy levels for world content. Every rule about them lives here.
//
//   level        players  broker (may sell it)  any AI / model context  the DM in the app
//   party        yes      yes                   yes                     yes
//   broker       no       yes                   yes                     yes
//   dm           no       no                    yes                     yes
//   classified   no       no                    NO, never               yes (clearly marked)
//
// A page has a level (pages.visibility) and blocks, property groups and
// frontmatter keys inside it can carry a higher one. The most secret level
// wins. Copies of a page are computed when it is written (core/library.ts):
//   player copy   party content only                (player_* columns)
//   broker copy   party + broker content            (broker_* columns)
//   AI copy       everything except classified      (ai_* columns)
//   DM copy       everything                        (the plain columns)
// Anything unknown or unparseable is `dm`: it fails closed.
//
// This file is also the contract other features build on: `Level`,
// `pageLevel`, `copyFor` and the small helpers below.
import type { FM } from './frontmatter.ts';
import type { Block, Inline, PropertyGroup } from '../intake/model.ts';

export type Level = 'party' | 'broker' | 'dm' | 'classified';
export type Audience = 'player' | 'broker' | 'ai' | 'dm';

export const LEVELS: readonly Level[] = ['party', 'broker', 'dm', 'classified'];
export const AUDIENCES: readonly Audience[] = ['player', 'broker', 'ai', 'dm'];
export const RANK: Record<Level, number> = { party: 0, broker: 1, dm: 2, classified: 3 };
/** The highest level rank each audience may read. */
export const AUDIENCE_MAX: Record<Audience, number> = { player: 0, broker: 1, ai: 2, dm: 3 };

/** The request header every model-facing caller sends; the library serves the AI copy when it is there. */
export const CALLER_HEADER = 'x-alexandria-caller';
export const CALLER_MODEL = 'model';

export const maxLevel = (...ls: (Level | null | undefined)[]): Level => ls.reduce<Level>((a, b) => (b && RANK[b] > RANK[a] ? b : a), 'party');
export const canSeeLevel = (level: Level, audience: Audience): boolean => RANK[level] <= AUDIENCE_MAX[audience];
/** True when the level may be shown to the audience (unknown levels never are, except to the DM). */
export const levelOk = (level: unknown, audience: Audience): boolean => (isLevel(level) ? canSeeLevel(level, audience) : audience === 'dm');
export const isLevel = (v: unknown): v is Level => v === 'party' || v === 'broker' || v === 'dm' || v === 'classified';

/** A level from a stored or typed value. Anything unknown is `dm`. */
export function normLevel(v: unknown): Level {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'party' || s === 'players' || s === 'public' || s === 'shared') return 'party';
  if (s === 'broker') return 'broker';
  if (s === 'classified') return 'classified';
  return 'dm';
}

const tagName = (t: unknown) => String(t ?? '').trim().replace(/^#/, '').trim().toLowerCase();

/** The level named by tags: `classified` beats `broker`. */
export function tagLevel(tags: unknown): Level {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : [];
  let out: Level = 'party';
  for (const t of list) {
    const n = tagName(t);
    if (n === 'classified') return 'classified';
    if (n === 'broker') out = 'broker';
  }
  return out;
}

export interface PageLevelInput {
  /** The page's own visibility (party, broker, dm, classified; anything else is dm). Missing means dm. */
  visibility?: unknown;
  tags?: unknown;
  frontmatter?: FM | Record<string, unknown> | null;
  /** A level a source worked out for the page (for example from a private tag). */
  level?: Level | null;
}

/** The level of a page: its visibility, raised by tags (`broker`, `classified`) and frontmatter tags. The most secret wins. */
export function pageLevel(p: PageLevelInput): Level {
  const fm = (p.frontmatter ?? {}) as Record<string, unknown>;
  return maxLevel(normLevel(p.visibility), tagLevel(p.tags), tagLevel(fm.tags ?? fm.tag), p.level ?? null);
}

// ---- words that name a level ---------------------------------------------------

const WORD = /^(broker|classified)\b/i;
/** "Broker:", "CLASSIFIED -" or a title that starts with the level word. */
export function levelOfWord(text: string): Level | null {
  const m = WORD.exec(String(text ?? '').trim());
  return m ? (m[1].toLowerCase() as Level) : null;
}

const NAMED_HEADING = /^(broker|classified)( notes?| only| info(rmation)?)?$|\((broker|classified)( only)?\)|\[(broker|classified)\]|\b(broker|classified) only\b|^(broker|classified)\s*[—–:-]/i;
const NAMED_HEADING_WORD = /(broker|classified)/i;
/** The level a heading names ("Broker", "Classified notes", "(classified)"), or null. */
export function headingNamedLevel(text: string): Level | null {
  const t = String(text ?? '').trim();
  if (!NAMED_HEADING.test(t)) return null;
  const m = NAMED_HEADING_WORD.exec(t);
  return m ? (m[1].toLowerCase() as Level) : null;
}

const DM_CALLOUTS = new Set(['secret', 'dm', 'gm', 'gm-only', 'dm-only', 'private']);
export function calloutVariantLevel(variant: string): Level {
  const v = String(variant ?? '').trim().toLowerCase();
  if (/^classified([-_ ]only)?$/.test(v)) return 'classified';
  if (/^broker([-_ ]only)?$/.test(v)) return 'broker';
  if (DM_CALLOUTS.has(v)) return 'dm';
  return 'party';
}

const inlineText = (c: Inline[] | undefined) => (c ?? []).map((x) => x.text ?? x.mention?.text ?? x.mention?.name ?? '').join('');

/** A group's level: an explicit one, `dm: true`, or a title like "Broker" or "Classified". */
export function groupLevel(g: PropertyGroup): Level {
  const t = g.title?.trim() ?? '';
  const named = levelOfWord(t);
  const dmTitle = /^(secret|secrets|dm|dm[ _-].*|gm|gm[ _-].*|private|hidden)$/i.test(t);
  return maxLevel(g.level && isLevel(g.level) ? g.level : null, g.dm ? 'dm' : null, dmTitle ? 'dm' : null, named);
}

/** A property row or frontmatter key's level: `broker_price` is broker, `classified_x` classified, `dm_notes` dm. */
export function keyLevel(key: string): Level {
  const k = String(key ?? '').trim();
  if (/^classified([ _-].*)?$/i.test(k)) return 'classified';
  if (/^broker([ _-].*)?$/i.test(k)) return 'broker';
  if (/^(secret|secrets|dm|dm[ _-].*|gm|gm[ _-].*|private|hidden)$/i.test(k)) return 'dm';
  return 'party';
}

/** The level a block carries on its own (not counting a heading section it sits in or its children). */
export function blockLevel(b: Block): Level {
  switch (b.kind) {
    case 'secret': return isLevel((b as any).level) ? (b as any).level : 'dm';
    case 'unsupported': return 'dm';
    case 'callout': return maxLevel(calloutVariantLevel(b.variant), levelOfWord(inlineText(b.title)));
    case 'toggle': return levelOfWord(inlineText(b.title)) ?? 'party';
    default: return 'party';
  }
}

/** The level a heading starts a section at: Broker / Classified, or the older DM headings. */
export function headingLevel(b: Block, dmHeading: RegExp): Level {
  if (b.kind !== 'heading') return 'party';
  const t = inlineText(b.content).trim();
  return maxLevel(headingNamedLevel(t), dmHeading.test(t) ? 'dm' : null);
}

// ---- reading a stored copy -----------------------------------------------------

/** A page as stored (the `pages` columns). Any subset works; missing columns are treated as "no copy". */
export interface PageRow {
  visibility?: string | null;
  origin?: string | null;
  frontmatter?: string | null;
  body?: string | null;
  blocks?: string | null;
  properties?: string | null;
  player_frontmatter?: string | null;
  player_body?: string | null;
  player_blocks?: string | null;
  player_properties?: string | null;
  broker_frontmatter?: string | null;
  broker_body?: string | null;
  broker_blocks?: string | null;
  broker_properties?: string | null;
  ai_frontmatter?: string | null;
  ai_body?: string | null;
  ai_blocks?: string | null;
  ai_properties?: string | null;
}

export interface PageCopy {
  audience: Audience;
  blocks: Block[];
  markdown: string;
  properties: PropertyGroup[];
  frontmatter: FM;
}

const parse = <T,>(s: string | null | undefined, fallback: T): T => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** The column prefix of each audience's copy ('' is the DM copy). */
const PREFIX: Record<Audience, string> = { player: 'player_', broker: 'broker_', ai: 'ai_', dm: '' };

/**
 * The stored copy of a page for one audience: blocks, markdown, sidebar
 * properties and frontmatter. Null when the audience has no copy (a page
 * above its level has none). The DM copy is always there. Never computes
 * anything: copies are built when a page is saved.
 */
export function copyFor(page: PageRow, audience: Audience): PageCopy | null {
  const p = PREFIX[audience];
  const row = page as Record<string, string | null | undefined>;
  const body = row[`${p}body`];
  if (audience !== 'dm' && (body === null || body === undefined)) return null;
  return {
    audience,
    blocks: parse<Block[]>(row[`${p}blocks`], []),
    markdown: body ?? '',
    properties: parse<PropertyGroup[]>(row[`${p}properties`], []),
    frontmatter: parse<FM>(row[`${p}frontmatter`], {}),
  };
}

// ---- text checks ---------------------------------------------------------------

/** The page text (blocks, properties, frontmatter, body) a stored row has for the DM but not in its AI copy: what no model may see. */
export function classifiedOnly(page: PageRow): boolean {
  return normLevel(page.visibility) === 'classified';
}

/**
 * A last check for text about to go to a model: true when no run of eight
 * words in it appears in `classifiedGrams` (see classifiedGrams in
 * core/library.ts). Fails closed on a missing set.
 */
export function isModelSafe(text: string, classifiedGrams: Set<string> | null | undefined, n = 8): boolean {
  if (!classifiedGrams) return false;
  if (!classifiedGrams.size) return true;
  const w = String(text ?? '').toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
  for (let i = 0; i + n <= w.length; i++) if (classifiedGrams.has(w.slice(i, i + n).join(' '))) return false;
  return true;
}

export const levelWords = (text: string, n = 8): Set<string> => {
  const w = String(text ?? '').toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};
