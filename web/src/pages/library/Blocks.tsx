// Renders the Alexandria page model (librarian/src/intake/model.ts) the way
// LegendKeeper lays a page out: infobox sidebars floated right, callouts,
// secrets, tables, toggles, mentions as links. The server already removed
// everything a player may not see; DM-only styling here is only a label.
import type { ReactNode } from 'react';

export interface Mention { ref?: string; name?: string; text?: string }
export interface Inline { text?: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; underline?: boolean; link?: string; mention?: Mention }
export interface PropertyGroup { title: string; rows: { key: string; value: Inline[] }[]; dm?: boolean }
export type Block = { kind: string; [k: string]: any };

export interface RenderCtx {
  links: Record<string, string>;
  open: (pageId: string) => void;
  isDM: boolean;
  children: { id: string; title: string; icon?: { glyph?: string; color?: string } | null }[];
}

export const mentionKey = (m: Mention) => (m.ref ? `ref:${m.ref}` : `name:${String(m.name ?? '').toLowerCase()}`);

export function Icon({ icon, size = 18 }: { icon?: { glyph?: string; color?: string } | null; size?: number }) {
  if (!icon?.glyph) return null;
  const g = String(icon.glyph).replace(/^fa[srb]?\s+fa-/, '').replace(/^fa-/, '').replace(/[^a-z0-9-]/gi, '');
  return <i className={`fa-solid fa-${g}`} aria-hidden="true" style={{ color: icon.color || 'var(--accent)', fontSize: size, width: size * 1.25, textAlign: 'center' }} />;
}

export function Inlines({ c, ctx }: { c?: Inline[]; ctx: RenderCtx }) {
  return (
    <>
      {(c ?? []).map((x, i) => {
        if (x.mention) {
          const label = x.mention.text ?? x.mention.name ?? '';
          const target = ctx.links[mentionKey(x.mention)];
          if (!target) return <span key={i}>{label}</span>; // unresolved: plain text, never a link
          return <a key={i} className="lib-mention" href={`?page=${target}`} onClick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); ctx.open(target); } }}>{label}</a>;
        }
        const t = x.text ?? '';
        if (t === '(hidden)') return <span key={i} className="lib-hidden">(hidden)</span>;
        let n: ReactNode = t.includes('(hidden)') ? t.split('(hidden)').flatMap((part, j, arr) => (j < arr.length - 1 ? [part, <span key={j} className="lib-hidden">(hidden)</span>] : [part])) : t;
        if (x.code) n = <code>{n}</code>;
        if (x.bold) n = <strong>{n}</strong>;
        if (x.italic) n = <em>{n}</em>;
        if (x.strike) n = <s>{n}</s>;
        if (x.underline) n = <u>{n}</u>;
        if (x.link && /^(https?:|mailto:)/i.test(x.link)) n = <a href={x.link} target="_blank" rel="noopener noreferrer">{n}</a>;
        return <span key={i}>{n}</span>;
      })}
    </>
  );
}

const CALLOUT: Record<string, [string, string]> = {
  note: ['circle-info', 'var(--teal)'], info: ['circle-info', 'var(--teal)'], abstract: ['clipboard-list', 'var(--teal)'], summary: ['clipboard-list', 'var(--teal)'],
  tip: ['lightbulb', 'var(--ok-text)'], hint: ['lightbulb', 'var(--ok-text)'], success: ['check', 'var(--ok-text)'], check: ['check', 'var(--ok-text)'], done: ['check', 'var(--ok-text)'],
  question: ['circle-question', 'var(--accent)'], help: ['circle-question', 'var(--accent)'], faq: ['circle-question', 'var(--accent)'],
  warning: ['triangle-exclamation', 'var(--accent)'], caution: ['triangle-exclamation', 'var(--accent)'], attention: ['triangle-exclamation', 'var(--accent)'],
  danger: ['bolt', 'var(--danger-text)'], error: ['bolt', 'var(--danger-text)'], failure: ['xmark', 'var(--danger-text)'], bug: ['bug', 'var(--danger-text)'],
  example: ['list', 'var(--muted)'], quote: ['quote-left', 'var(--muted)'], cite: ['quote-left', 'var(--muted)'],
};

export function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: RenderCtx }) {
  return <>{blocks.map((b, i) => <BlockView key={b.id ?? i} b={b} ctx={ctx} />)}</>;
}

export function Facts({ groups, ctx }: { groups: PropertyGroup[]; ctx: RenderCtx }) {
  return (
    <>
      {groups.map((g, i) => (
        <section key={i} className={`lib-facts${g.dm ? ' lib-dm' : ''}`} aria-label={g.title}>
          <h3>{g.title}{g.dm && <span className="lib-dm-tag">DM only</span>}</h3>
          <dl>{g.rows.map((r, j) => <div key={j} className="lib-fact"><dt>{r.key}</dt><dd><Inlines c={r.value} ctx={ctx} /></dd></div>)}</dl>
        </section>
      ))}
    </>
  );
}

function BlockView({ b, ctx }: { b: Block; ctx: RenderCtx }) {
  const kids = (bs: Block[] = b.children ?? []) => <Blocks blocks={bs} ctx={ctx} />;
  switch (b.kind) {
    case 'heading': {
      const L = Math.min(Math.max(Number(b.level) || 2, 1), 6);
      const Tag = (`h${Math.min(L + 1, 6)}`) as 'h2'; // the page title is the h1
      return <Tag className={`lib-h lib-h${L}`}><Inlines c={b.content} ctx={ctx} /></Tag>;
    }
    case 'paragraph':
      return <p><Inlines c={b.content} ctx={ctx} /></p>;
    case 'bulletList':
      return <ul className={(b.children ?? []).some((li: Block) => typeof li.checked === 'boolean') ? 'lib-tasks' : undefined}>{(b.children ?? []).map((li: Block, i: number) => <ListItem key={i} li={li} ctx={ctx} />)}</ul>;
    case 'orderedList':
      return <ol start={b.start}>{(b.children ?? []).map((li: Block, i: number) => <ListItem key={i} li={li} ctx={ctx} />)}</ol>;
    case 'listItem':
      return <>{kids()}</>;
    case 'table':
      return (
        <div className="lib-table-wrap"><table className="lib-table"><tbody>
          {(b.children ?? []).map((row: Block, i: number) => (
            <tr key={i}>{(row.children ?? []).map((cell: Block, j: number) => (cell.header ? <th key={j}>{kids(cell.children)}</th> : <td key={j}>{kids(cell.children)}</td>))}</tr>
          ))}
        </tbody></table></div>
      );
    case 'secret':
      // Only the DM ever receives these.
      return <aside className="lib-secret" aria-label="Secret, DM only"><span className="lib-secret-tag"><i className="fa-solid fa-eye-slash" aria-hidden="true" /> Secret · DM only</span>{kids()}</aside>;
    case 'callout': {
      const v = String(b.variant ?? 'note').toLowerCase();
      const [icon, color] = CALLOUT[v] ?? ['circle-info', 'var(--teal)'];
      return (
        <aside className="lib-callout" style={{ borderLeftColor: color }}>
          <div className="lib-callout-title" style={{ color }}><i className={`fa-solid fa-${icon}`} aria-hidden="true" /> {b.title?.length ? <Inlines c={b.title} ctx={ctx} /> : v[0].toUpperCase() + v.slice(1)}</div>
          {kids()}
        </aside>
      );
    }
    case 'toggle':
      return <details className="lib-toggle"><summary><Inlines c={b.title} ctx={ctx} /></summary><div>{kids()}</div></details>;
    case 'blockquote':
      return <blockquote className="lib-quote">{kids()}</blockquote>;
    case 'codeBlock':
      return <pre className="lib-code"><code>{b.text}</code></pre>;
    case 'divider':
      return <hr />;
    case 'image':
      return /^https?:/i.test(b.url) ? (
        <figure className="lib-figure"><img src={b.url} alt={b.alt ?? ''} loading="lazy" style={b.width ? { maxWidth: Math.min(b.width, 1600) } : undefined} />{b.caption?.length ? <figcaption><Inlines c={b.caption} ctx={ctx} /></figcaption> : null}</figure>
      ) : null;
    case 'infobox': {
      const width = Math.min(Math.max(Number(b.width) || 40, 20), 60);
      const float = b.layout === 'wrapLeft' ? 'left' : b.layout === 'full' || b.layout === 'block' ? 'none' : 'right';
      return <aside className="lib-infobox" style={{ ['--lib-w' as any]: `${width}%`, float } as any}><Facts groups={b.groups ?? []} ctx={ctx} /></aside>;
    }
    case 'collection':
      return ctx.children.length ? (
        <nav className="lib-collection" aria-label={b.title ?? 'Pages inside'}>
          {b.title && <h3>{b.title}</h3>}
          <ul>{ctx.children.map((c) => <li key={c.id}><a href={`?page=${c.id}`} onClick={(e) => { e.preventDefault(); ctx.open(c.id); }}><Icon icon={c.icon} size={14} /> {c.title}</a></li>)}</ul>
        </nav>
      ) : null;
    case 'unsupported':
      return ctx.isDM ? <p className="lib-unsupported">Not shown to players: {b.sourceKind} block</p> : null;
    default:
      return ctx.isDM ? <p className="lib-unsupported">Not shown to players: {String(b.kind)} block</p> : null;
  }
}

function ListItem({ li, ctx }: { li: Block; ctx: RenderCtx }) {
  const body = li.kind === 'listItem' ? li.children ?? [] : [li];
  // A list item whose first child is a paragraph renders inline, like Markdown.
  const [first, ...rest] = body;
  return (
    <li className={typeof li.checked === 'boolean' ? 'lib-task' : undefined}>
      {typeof li.checked === 'boolean' && <input type="checkbox" checked={li.checked} readOnly aria-label={li.checked ? 'Done' : 'Not done'} />}
      {first?.kind === 'paragraph' ? <Inlines c={first.content} ctx={ctx} /> : first ? <Blocks blocks={[first]} ctx={ctx} /> : null}
      {rest.length > 0 && <Blocks blocks={rest} ctx={ctx} />}
    </li>
  );
}

export const LIB_CSS = `
.lib-page { font-family: var(--font-read); font-size: 17px; line-height: 1.6; overflow-wrap: anywhere; }
.lib-page::after { content: ''; display: block; clear: both; }
.lib-page p { margin: 0 0 10px; }
.lib-page ul, .lib-page ol { margin: 0 0 10px; padding-left: 24px; }
.lib-page li { margin: 2px 0; }
.lib-page li > ul, .lib-page li > ol { margin: 2px 0; }
.lib-tasks { list-style: none; padding-left: 4px !important; }
.lib-task input { margin-right: 8px; accent-color: var(--accent); }
.lib-h { margin: 18px 0 6px; font-family: var(--font-head); color: var(--accent-strong); line-height: 1.25; }
.lib-h1 { font-size: 24px; } .lib-h2 { font-size: 21px; } .lib-h3 { font-size: 18px; } .lib-h4, .lib-h5, .lib-h6 { font-size: 16px; }
.lib-mention { color: var(--accent-strong); text-decoration: underline dotted; text-underline-offset: 3px; }
.lib-hidden { color: var(--faint); font-style: italic; }
.lib-page code { font-family: var(--font-mono); font-size: 0.86em; background: var(--panel-2); padding: 0 4px; border-radius: 4px; }
.lib-code { font-family: var(--font-mono); font-size: 13px; background: var(--input); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
.lib-code code { background: none; padding: 0; }
.lib-table-wrap { overflow-x: auto; margin: 0 0 12px; }
.lib-table { border-collapse: collapse; min-width: 50%; font-size: 15px; font-family: var(--font); }
.lib-table th, .lib-table td { border: 1px solid var(--line); padding: 6px 10px; vertical-align: top; text-align: left; }
.lib-table th { background: var(--panel-2); color: var(--accent-strong); font-weight: 600; }
.lib-table p { margin: 0; }
.lib-callout { margin: 10px 0; padding: 10px 14px; border-left: 4px solid var(--teal); background: var(--panel-2); border-radius: 0 8px 8px 0; }
.lib-callout-title { font-family: var(--font); font-weight: 700; font-size: 15px; margin-bottom: 4px; display: flex; gap: 8px; align-items: center; }
.lib-secret { margin: 12px 0; padding: 12px 14px; border: 1px dashed var(--danger); border-radius: 8px; background: var(--danger-bg); }
.lib-secret-tag { display: inline-flex; gap: 6px; align-items: center; font-family: var(--font); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--danger-text); margin-bottom: 6px; }
.lib-toggle { margin: 8px 0; border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; }
.lib-toggle summary { cursor: pointer; font-weight: 600; font-family: var(--font); }
.lib-quote { margin: 10px 0; padding: 4px 14px; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }
.lib-figure { margin: 12px 0; } .lib-figure img { max-width: 100%; border-radius: 8px; } .lib-figure figcaption { font-size: 13px; color: var(--muted); }
.lib-infobox { width: var(--lib-w, 40%); margin: 0 0 12px 18px; }
.lib-infobox[style*="float: left"] { margin: 0 18px 12px 0; }
.lib-facts { background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; font-family: var(--font); font-size: 14px; }
.lib-facts h3 { font-family: var(--font-head); font-size: 15px; color: var(--accent-strong); margin: 0 0 8px; display: flex; gap: 8px; align-items: center; }
.lib-facts dl { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.lib-fact { display: grid; grid-template-columns: minmax(70px, 38%) 1fr; gap: 8px; }
.lib-fact dt { color: var(--faint); } .lib-fact dd { margin: 0; overflow-wrap: anywhere; }
.lib-dm { border-color: var(--danger); background: var(--danger-bg); }
.lib-dm-tag { font-family: var(--font); font-size: 11px; color: var(--danger-text); border: 1px solid var(--danger); border-radius: 999px; padding: 0 8px; }
.lib-collection { margin: 12px 0; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; font-family: var(--font); }
.lib-collection ul { list-style: none; padding: 0; margin: 0; columns: 2 220px; }
.lib-collection li { margin: 3px 0; break-inside: avoid; }
.lib-collection a { color: var(--text); text-decoration: none; display: inline-flex; gap: 6px; align-items: center; }
.lib-collection a:hover { color: var(--accent-strong); }
.lib-unsupported { font-family: var(--font); font-size: 12px; color: var(--faint); border: 1px dashed var(--line); border-radius: 6px; padding: 4px 8px; }
@media (max-width: 760px) { .lib-infobox { float: none !important; width: 100% !important; margin: 0 0 12px !important; } }
`;
