// The Alexandria page model. Every source (LegendKeeper, Kanka, Markdown
// vaults, Obsidian or any MCP, any REST API) is turned into these shapes, so
// the leak guard, search, the Library renderer and the AI tools work the same
// for all of them. Blocks follow LegendKeeper's document schema, which is the
// richest of the sources, so its pages keep their layout one to one.
import { marked, type Token, type Tokens } from 'marked';

export interface Mention {
  /** Source-scoped id of the linked entry, e.g. a LegendKeeper resource id or "kanka:123". */
  ref?: string;
  /** Title to resolve by when there is no ref (Markdown wiki links). */
  name?: string;
  /** Text shown for the link, if different from the target's title. */
  text?: string;
}

export interface Inline {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  underline?: boolean;
  /** External URL. */
  link?: string;
  mention?: Mention;
}

export interface MapPin { name: string; lat: number; lng: number; type?: string; /** Source id of the page this pin is for. */ ref?: string; dm?: boolean }
export interface PropertyRow { key: string; value: Inline[] }
export interface PropertyGroup { title: string; rows: PropertyRow[]; dm?: boolean }

export type Block =
  | { kind: 'heading'; level: number; content: Inline[] }
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'bulletList' | 'orderedList'; children: Block[]; start?: number }
  | { kind: 'listItem'; children: Block[]; checked?: boolean }
  | { kind: 'table'; children: Block[] }
  | { kind: 'tableRow'; children: Block[] }
  | { kind: 'tableCell'; header?: boolean; children: Block[] }
  | { kind: 'secret'; children: Block[] }
  | { kind: 'callout'; variant: string; title?: Inline[]; children: Block[] }
  | { kind: 'toggle'; title: Inline[]; children: Block[] }
  | { kind: 'blockquote'; children: Block[] }
  | { kind: 'codeBlock'; language?: string; text: string }
  | { kind: 'divider' }
  | { kind: 'image'; url: string; alt?: string; width?: number; caption?: Inline[] }
  | { kind: 'infobox'; layout?: string; width?: number; groups: PropertyGroup[] }
  | { kind: 'collection'; title?: string; filter?: unknown }
  /** A map with pins (LegendKeeper map documents). `dm` pins and pins that link to DM-only pages never reach players. */
  | { kind: 'map'; title?: string; image?: string; width?: number; height?: number; pins: MapPin[] }
  | { kind: 'unsupported'; sourceKind: string };

export interface Entry {
  /** Stable id within the source (never the title: titles repeat). */
  externalId: string;
  parentExternalId?: string | null;
  /** Folder path for the file browser, e.g. ["Japan", "People"]. */
  folder?: string[];
  title: string;
  aliases?: string[];
  tags?: string[];
  /** What it is: character, location, page, note... */
  type?: string;
  icon?: { glyph?: string; color?: string } | null;
  banner?: string | null;
  properties?: PropertyGroup[];
  blocks: Block[];
  /** dm or party. Adapters must fail closed: anything unsure is dm. */
  visibility: 'dm' | 'party';
  /** How hard this is to learn, for the information broker. */
  knowledge?: 'common' | 'local' | 'deep' | null;
  /** Link back to the page in its own app. */
  url?: string | null;
  updatedAt?: string | null;
  /** Markdown sources: the original body. The library runs the Markdown leak
   *  guard on it before parsing, and keeps it for the on-disk mirror. */
  markdown?: string;
  /** Markdown sources: frontmatter, for relations (parents:, spouse:, secret:...). */
  frontmatter?: Record<string, any>;
}

// ---- Inline helpers ----------------------------------------------------------

export const inlineText = (c: Inline[] = []) => c.map((x) => (x.mention ? x.mention.text ?? x.mention.name ?? '' : x.text ?? '')).join('');

function mdEscape(s: string) {
  return s.replace(/([\\`*_[\]])/g, '\\$1');
}

export function inlineToMarkdown(c: Inline[] = [], titleOf: (m: Mention) => string | null = (m) => m.name ?? null): string {
  return c.map((x) => {
    if (x.mention) {
      const t = titleOf(x.mention);
      const label = x.mention.text && x.mention.text !== t ? x.mention.text : null;
      if (!t) return label ?? '(hidden)';
      return label ? `[[${t}|${label}]]` : `[[${t}]]`;
    }
    let t = x.code ? '`' + (x.text ?? '').replace(/`/g, "'") + '`' : mdEscape(x.text ?? '');
    if (!t.trim()) return t;
    if (x.bold) t = `**${t}**`;
    if (x.italic) t = `*${t}*`;
    if (x.strike) t = `~~${t}~~`;
    if (x.link) t = `[${t}](${x.link})`;
    return t;
  }).join('');
}

/** Markdown for search, AI context, downloads and the on-disk mirror. */
export function blocksToMarkdown(blocks: Block[], titleOf?: (m: Mention) => string | null, depth = 0): string {
  const md = (bs: Block[]) => blocksToMarkdown(bs, titleOf, depth);
  const il = (c?: Inline[]) => inlineToMarkdown(c ?? [], titleOf);
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading': out.push(`${'#'.repeat(Math.min(Math.max(b.level, 1), 6))} ${il(b.content)}`); break;
      case 'paragraph': { const t = il(b.content); if (t.trim()) out.push(t); break; }
      case 'bulletList':
      case 'orderedList':
        out.push(b.children.map((li, i) => {
          const inner = li.kind === 'listItem' ? md(li.children) : md([li]);
          const mark = b.kind === 'orderedList' ? `${(b.start ?? 1) + i}.` : '-';
          const check = li.kind === 'listItem' && li.checked !== undefined ? (li.checked ? '[x] ' : '[ ] ') : '';
          return `${mark} ${check}${inner.replace(/\n/g, '\n   ')}`;
        }).join('\n'));
        break;
      case 'listItem': out.push(md(b.children)); break;
      case 'table': {
        const rows = b.children.map((r) => (r.kind === 'tableRow' ? r.children.map((c) => (c.kind === 'tableCell' ? md(c.children).replace(/\n+/g, ' ').replace(/\|/g, '\\|') : '')) : []));
        if (!rows.length) break;
        const w = Math.max(...rows.map((r) => r.length));
        const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ')} |`;
        out.push([line(rows[0]), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n'));
        break;
      }
      case 'secret': out.push(`> [!secret]\n${quote(md(b.children))}`); break;
      case 'callout': out.push(`> [!${b.variant}]${b.title?.length ? ' ' + il(b.title) : ''}\n${quote(md(b.children))}`); break;
      case 'toggle': out.push(`> [!expand] ${il(b.title)}\n${quote(md(b.children))}`); break;
      case 'blockquote': out.push(quote(md(b.children))); break;
      case 'codeBlock': out.push('```' + (b.language ?? '') + '\n' + b.text + '\n```'); break;
      case 'divider': out.push('---'); break;
      case 'image': out.push(`![${b.alt ?? ''}](${b.url})`); break;
      case 'infobox': out.push(b.groups.map((g) => `**${g.title}**\n` + g.rows.map((r) => `- **${r.key}:** ${il(r.value)}`).join('\n')).join('\n\n')); break;
      case 'map': {
        const pins = (b.pins ?? []).map((p) => `- ${p.ref ? il([{ mention: { ref: p.ref, name: p.name } }]) : mdEscape(p.name)}${p.type ? ` (${mdEscape(p.type)})` : ''}`);
        out.push([`**Map${b.title ? `: ${mdEscape(b.title)}` : ''}**`, ...pins].join('\n'));
        break;
      }
      case 'collection': break;
      case 'unsupported': break;
    }
  }
  return out.join('\n\n');
}

const quote = (s: string) => s.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// ---- Markdown -> blocks -------------------------------------------------------

const WIKI = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** Inline Markdown text (already split by marked) with [[wiki links]] as mentions. */
function inlineTokens(tokens: Token[] = [], marks: Partial<Inline> = {}): Inline[] {
  const out: Inline[] = [];
  const pushText = (raw: string) => {
    let last = 0;
    for (const m of raw.matchAll(WIKI)) {
      if (m.index! > last) out.push({ ...marks, text: raw.slice(last, m.index) });
      out.push({ mention: { name: m[1].trim(), ...(m[2] ? { text: m[2].trim() } : {}) } });
      last = m.index! + m[0].length;
    }
    if (last < raw.length) out.push({ ...marks, text: raw.slice(last) });
  };
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': out.push(...inlineTokens((t as Tokens.Strong).tokens, { ...marks, bold: true })); break;
      case 'em': out.push(...inlineTokens((t as Tokens.Em).tokens, { ...marks, italic: true })); break;
      case 'del': out.push(...inlineTokens((t as Tokens.Del).tokens, { ...marks, strike: true })); break;
      case 'codespan': out.push({ ...marks, code: true, text: unescapeHtml((t as Tokens.Codespan).text) }); break;
      case 'link': {
        const l = t as Tokens.Link;
        const inner = inlineTokens(l.tokens, marks);
        if (/^https?:|^mailto:/i.test(l.href)) inner.forEach((x) => { if (!x.mention) x.link = l.href; });
        out.push(...inner);
        break;
      }
      case 'br': out.push({ ...marks, text: '\n' }); break;
      case 'escape': out.push({ ...marks, text: (t as Tokens.Escape).text }); break;
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineTokens(tt.tokens, marks));
        else pushText(unescapeHtml(tt.text));
        break;
      }
      case 'html': break; // raw HTML in Markdown is dropped
      case 'image': break;
      default: if ('text' in t) pushText(unescapeHtml(String((t as any).text)));
    }
  }
  // merge adjacent plain runs with identical marks
  const merged: Inline[] = [];
  for (const x of out) {
    const p = merged[merged.length - 1];
    if (p && !p.mention && !x.mention && JSON.stringify({ ...p, text: '' }) === JSON.stringify({ ...x, text: '' })) p.text = (p.text ?? '') + (x.text ?? '');
    else merged.push(x);
  }
  return merged.filter((x) => x.mention || x.text);
}

function unescapeHtml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const SECRET_CALLOUT = /^\s*\[!(secret|dm|gm)\][^\n]*\n?/i;
const CALLOUT = /^\s*\[!([\w-]+)\]([+-]?)\s*([^\n]*)\n?/;

function tokensToBlocks(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': { const h = t as Tokens.Heading; out.push({ kind: 'heading', level: h.depth, content: inlineTokens(h.tokens) }); break; }
      case 'paragraph': {
        const p = t as Tokens.Paragraph;
        const imgs = p.tokens.filter((x) => x.type === 'image') as Tokens.Image[];
        const content = inlineTokens(p.tokens);
        if (content.length) out.push({ kind: 'paragraph', content });
        imgs.forEach((i) => { if (/^https?:/i.test(i.href)) out.push({ kind: 'image', url: i.href, alt: i.text }); });
        break;
      }
      case 'list': {
        const l = t as Tokens.List;
        out.push({ kind: l.ordered ? 'orderedList' : 'bulletList', ...(l.ordered && typeof l.start === 'number' ? { start: l.start } : {}), children: l.items.map((it) => ({ kind: 'listItem' as const, ...(it.task ? { checked: !!it.checked } : {}), children: tokensToBlocks(it.tokens.filter((x) => x.type !== 'checkbox')).flatMap((b) => (b.kind === 'paragraph' || b.kind !== 'listItem' ? [b] : [])) })) } as Block);
        break;
      }
      case 'blockquote': {
        const q = t as Tokens.Blockquote;
        const m = CALLOUT.exec(q.text);
        if (m) {
          const variant = m[1].toLowerCase();
          const rest = q.text.slice(m[0].length);
          const children = tokensToBlocks(marked.lexer(rest));
          if (variant === 'secret' || variant === 'dm' || variant === 'gm') out.push({ kind: 'secret', children: m[3] ? [{ kind: 'heading', level: 3, content: [{ text: m[3] }] }, ...children] : children });
          else if (variant === 'expand' || m[2]) out.push({ kind: 'toggle', title: [{ text: m[3] || variant }], children });
          else out.push({ kind: 'callout', variant, ...(m[3] ? { title: [{ text: m[3] }] } : {}), children });
        } else out.push({ kind: 'blockquote', children: tokensToBlocks(q.tokens) });
        break;
      }
      case 'code': { const c = t as Tokens.Code; out.push({ kind: 'codeBlock', language: c.lang || undefined, text: c.text }); break; }
      case 'hr': out.push({ kind: 'divider' }); break;
      case 'table': {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean): Block => ({ kind: 'tableCell', header, children: [{ kind: 'paragraph', content: inlineTokens(c.tokens) }] });
        out.push({ kind: 'table', children: [{ kind: 'tableRow', children: tb.header.map((c) => cell(c, true)) }, ...tb.rows.map((r) => ({ kind: 'tableRow' as const, children: r.map((c) => cell(c, false)) }))] });
        break;
      }
      case 'html': break; // HTML comments (<!-- dm -->) are handled by the leak guard before parsing
      case 'space': break;
      case 'text': { const tt = t as Tokens.Text; const content = inlineTokens(tt.tokens ?? [tt as Token]); if (content.length) out.push({ kind: 'paragraph', content }); break; }
      default: break;
    }
  }
  return out;
}

/** Markdown (no frontmatter) to blocks. > [!secret] callouts become secret blocks. */
export function markdownToBlocks(md: string): Block[] {
  return tokensToBlocks(marked.lexer(md.replace(/\r\n/g, '\n'), { gfm: true }));
}

/** All mentions in a block tree (for link resolution). */
export function mentionsIn(blocks: Block[], props: PropertyGroup[] = []): Mention[] {
  const out: Mention[] = [];
  const il = (c?: Inline[]) => c?.forEach((x) => x.mention && out.push(x.mention));
  const walk = (bs: Block[]) => bs.forEach((b) => {
    if ('content' in b) il(b.content);
    if (b.kind === 'callout' || b.kind === 'toggle') il(b.title);
    if (b.kind === 'image') il(b.caption);
    if (b.kind === 'map') (b.pins ?? []).forEach((p) => p.ref && out.push({ ref: p.ref, name: p.name }));
    if (b.kind === 'infobox') b.groups.forEach((g) => g.rows.forEach((r) => il(r.value)));
    if ('children' in b) walk(b.children);
  });
  walk(blocks);
  props.forEach((g) => g.rows.forEach((r) => il(r.value)));
  return out;
}

/** Plain text of blocks, for search snippets. */
export function blocksText(blocks: Block[]): string {
  return blocksToMarkdown(blocks, (m) => m.text ?? m.name ?? '').replace(/[*_`>#|[\]]/g, ' ').replace(/[ \t]+/g, ' ');
}
