// The leak guard for structured pages. Same rules as policy.ts uses for
// Markdown, applied to blocks, and fail closed: a block kind it does not know
// is removed from the player copy, so a new source format can never leak.
import type { Block, Inline, Mention, PropertyGroup } from './model.ts';

const DM_HEADING = /\((dm|gm)( only)?\)|\[(dm|gm)\]|\b(dm|gm) only\b|^(secrets?|dm notes?|gm notes?|dm|gm)$|^(dm|gm)\s*[—–-]/i;
const DM_CALLOUTS = new Set(['secret', 'dm', 'gm', 'gm-only', 'dm-only', 'private']);
const DM_KEY = /^(secret|secrets|dm|dm[ _-].*|gm|gm[ _-].*|private|hidden)$/i;

/** True when a mention points at something players may not see. */
export type IsHidden = (m: Mention) => boolean;

function inlinePlayer(c: Inline[] | undefined, hidden: IsHidden): Inline[] {
  return (c ?? []).map((x) => {
    if (!x.mention) return x;
    if (!hidden(x.mention)) return x;
    // Keep the link's own words only when they differ from the hidden title.
    const label = x.mention.text && x.mention.text !== x.mention.name ? x.mention.text : null;
    return { text: label ?? '(hidden)' };
  });
}

const headingText = (b: Block) => (b.kind === 'heading' ? b.content.map((x) => x.text ?? x.mention?.text ?? x.mention?.name ?? '').join('').trim() : '');

export function playerBlocks(blocks: Block[], hidden: IsHidden): Block[] {
  const out: Block[] = [];
  let skip = 0; // heading level of a DM section being skipped
  for (const b of blocks) {
    if (skip) {
      if (b.kind === 'heading' && b.level <= skip) skip = 0;
      else continue;
    }
    if (b.kind === 'heading' && DM_HEADING.test(headingText(b))) { skip = b.level; continue; }
    const p = playerBlock(b, hidden);
    if (p) out.push(p);
  }
  return out;
}

function playerBlock(b: Block, hidden: IsHidden): Block | null {
  switch (b.kind) {
    case 'secret':
    case 'unsupported':
      return null;
    case 'callout':
      if (DM_CALLOUTS.has(b.variant.toLowerCase())) return null;
      return { ...b, title: b.title ? inlinePlayer(b.title, hidden) : undefined, children: playerBlocks(b.children, hidden) };
    case 'toggle':
      return { ...b, title: inlinePlayer(b.title, hidden), children: playerBlocks(b.children, hidden) };
    case 'heading':
    case 'paragraph':
      return { ...b, content: inlinePlayer(b.content, hidden) } as Block;
    case 'image':
      return { ...b, caption: b.caption ? inlinePlayer(b.caption, hidden) : undefined };
    case 'infobox': {
      const groups = playerProperties(b.groups, hidden);
      return groups.length ? { ...b, groups } : null;
    }
    case 'bulletList':
    case 'orderedList':
    case 'listItem':
    case 'table':
    case 'tableRow':
    case 'tableCell':
    case 'blockquote':
      return { ...b, children: playerBlocks(b.children, hidden) } as Block;
    case 'map': {
      // A pin shows only when the source shows it and the page it points at is shared.
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

export function playerProperties(groups: PropertyGroup[] = [], hidden: IsHidden): PropertyGroup[] {
  return groups
    .filter((g) => !g.dm && !DM_KEY.test(g.title.trim()))
    .map((g) => ({ title: g.title, rows: g.rows.filter((r) => !DM_KEY.test(r.key.trim())).map((r) => ({ key: r.key, value: inlinePlayer(r.value, hidden) })) }))
    .filter((g) => g.rows.length);
}
