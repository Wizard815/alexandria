// The leak guard for structured pages. Same rules as policy.ts uses for
// Markdown, applied to blocks, and fail closed: a block kind it does not know
// is removed from every copy but the DM's, so a new source format can never
// leak.
//
// One filter serves every copy (see core/levels.ts): `blocksFor(blocks,
// audience, hidden)` keeps the blocks whose secrecy level the audience may
// read. The player copy is the party level only; the broker copy adds broker
// content; the AI copy adds everything except classified; the DM copy is
// everything. `playerBlocks` / `playerProperties` are the player copy.
import type { Block, Inline, Mention, PropertyGroup } from './model.ts';
import { type Audience, AUDIENCE_MAX, RANK, type Level, blockLevel, groupLevel, headingLevel, keyLevel, maxLevel } from '../core/levels.ts';

const DM_HEADING = /\((dm|gm)( only)?\)|\[(dm|gm)\]|\b(dm|gm) only\b|^(secrets?|dm notes?|gm notes?|dm|gm)$|^(dm|gm)\s*[—–-]/i;

/** True when a mention points at something the audience may not see. */
export type IsHidden = (m: Mention) => boolean;

function inlineFor(c: Inline[] | undefined, hidden: IsHidden): Inline[] {
  return (c ?? []).map((x) => {
    if (!x.mention) return x;
    if (!hidden(x.mention)) return x;
    // Keep the link's own words only when they differ from the hidden title.
    const label = x.mention.text && x.mention.text !== x.mention.name ? x.mention.text : null;
    return { text: label ?? '(hidden)' };
  });
}

/** Blocks the audience may read. The DM audience gets everything unchanged. */
export function blocksFor(blocks: Block[], audience: Audience, hidden: IsHidden): Block[] {
  if (audience === 'dm') return blocks;
  return filterList(blocks, audience, hidden);
}

function filterList(blocks: Block[], aud: Audience, hidden: IsHidden): Block[] {
  const max = AUDIENCE_MAX[aud];
  const out: Block[] = [];
  // Open heading sections (Broker, Classified, DM notes ...): everything under one is at least its level.
  const sections: { depth: number; level: Level }[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading') {
      while (sections.length && sections[sections.length - 1].depth >= b.level) sections.pop();
      const hl = headingLevel(b, DM_HEADING);
      if (hl !== 'party') sections.push({ depth: b.level, level: hl });
    }
    const eff = maxLevel(blockLevel(b), ...sections.map((s) => s.level));
    if (RANK[eff] > max) continue;
    const p = filterBlock(b, aud, hidden);
    if (p) out.push(p);
  }
  return out;
}

function filterBlock(b: Block, aud: Audience, hidden: IsHidden): Block | null {
  switch (b.kind) {
    case 'unsupported':
      return null;
    case 'secret':
      // Kept only for audiences that may read this block's level (checked by the caller); its words stay hidden-link safe.
      return { ...b, children: filterList(b.children, aud, hidden) };
    case 'callout':
      return { ...b, title: b.title ? inlineFor(b.title, hidden) : undefined, children: filterList(b.children, aud, hidden) };
    case 'toggle':
      return { ...b, title: inlineFor(b.title, hidden), children: filterList(b.children, aud, hidden) };
    case 'heading':
    case 'paragraph':
      return { ...b, content: inlineFor(b.content, hidden) } as Block;
    case 'image':
      return { ...b, caption: b.caption ? inlineFor(b.caption, hidden) : undefined };
    case 'infobox': {
      const groups = propertiesFor(b.groups, aud, hidden);
      return groups.length ? { ...b, groups } : null;
    }
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'table':
    case 'tableRow':
    case 'tableCell':
    case 'blockquote':
      return { ...b, children: filterList(b.children, aud, hidden) } as Block;
    case 'map': {
      // A pin shows only when the source shows it and the page it points at may be seen.
      const pins = (Array.isArray(b.pins) ? b.pins : []).filter((p) => p && p.dm !== true && typeof p.name === 'string' && !(p.ref && hidden({ ref: p.ref, name: p.name })));
      const image = typeof b.image === 'string' && /^https?:/i.test(b.image) ? b.image : undefined;
      return { kind: 'map', ...(b.title ? { title: b.title } : {}), ...(image ? { image } : {}), ...(b.width ? { width: b.width } : {}), ...(b.height ? { height: b.height } : {}), pins: pins.map((p) => ({ name: p.name, lat: p.lat, lng: p.lng, ...(p.type ? { type: p.type } : {}), ...(p.ref ? { ref: p.ref } : {}) })) };
    }
    case 'codeBlock':
    case 'divider':
    case 'collection':
      return b;
    default:
      return null; // unknown kind: fail closed
  }
}

/** Property groups and rows the audience may read. */
export function propertiesFor(groups: PropertyGroup[] = [], audience: Audience, hidden: IsHidden): PropertyGroup[] {
  if (audience === 'dm') return groups;
  const max = AUDIENCE_MAX[audience];
  return groups
    .filter((g) => RANK[groupLevel(g)] <= max)
    .map((g) => {
      const rows = g.rows.filter((r) => RANK[keyLevel(r.key)] <= max).map((r) => ({ key: r.key, value: inlineFor(r.value, hidden) }));
      return { title: g.title, ...(g.level ? { level: g.level } : {}), ...(g.dm ? { dm: g.dm } : {}), rows };
    })
    .filter((g) => g.rows.length);
}

// The player copy: the party level only.
export const playerBlocks = (blocks: Block[], hidden: IsHidden): Block[] => blocksFor(blocks, 'player', hidden);
export function playerProperties(groups: PropertyGroup[] = [], hidden: IsHidden): PropertyGroup[] {
  return propertiesFor(groups, 'player', hidden).map((g) => ({ title: g.title, rows: g.rows }));
}
