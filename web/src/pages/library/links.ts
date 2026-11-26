// Pure rules for links on a Library page (no React, so the librarian tests can run them).

/** An external link in page text: http, https or mailto only. javascript:, data:, vbscript: and anything else is not a link. */
export function safeHref(u: unknown): string | null {
  const t = String(u ?? '').trim();
  return /^(https?:\/\/|mailto:)\S+$/i.test(t) ? t : null;
}

/** An image, banner or map picture address: http or https, one of the librarian's own signed media addresses (a picture it downloaded for a page), or a picture an offline copy keeps. */
export function safeImageUrl(u: unknown): string | null {
  const t = String(u ?? '').trim();
  if (/^\/api\/media\/intake\/[\w.-]+$/.test(t)) return t;
  // A picture kept inside an offline copy of a page (lib/offline.ts): only the four picture types, never SVG.
  if (/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(t)) return t;
  return /^https?:\/\/\S+$/i.test(t) && !/["'()\\]/.test(t) ? t : null;
}

/** The "Open in ..." address and button words for a page, from what the librarian sent. Null: no button. */
export function sourceLink(pg: { url?: unknown; source_app?: unknown }): { href: string; label: string; custom: boolean } | null {
  const t = String(pg.url ?? '').trim();
  const web = /^https?:\/\/\S+$/i.test(t);
  const obsidian = /^obsidian:\/\/\S+$/i.test(t);
  if (!web && !obsidian) return null;
  const app = String(pg.source_app ?? '');
  const label = app === 'legendkeeper' ? 'Open in LegendKeeper' : app === 'kanka' ? 'Open in Kanka' : app === 'worldanvil' ? 'Open in World Anvil' : app === 'obsidian-publish' ? 'Open on the site' : app === 'notion' ? 'Open in Notion' : app === 'obsidian-portal' ? 'Open in Obsidian Portal' : app === 'markdown' ? 'Open file' : 'Open in source';
  return { href: t, label, custom: obsidian };
}

export interface MentionLike { ref?: string; name?: string; text?: string }
export const mentionKey = (m: MentionLike) => (m.ref ? `ref:${m.ref}` : `name:${String(m.name ?? '').toLowerCase()}`);

/**
 * What a mention shows and where it goes. A mention whose page was imported
 * and may be seen opens that page (its words, else its title); anything else
 * is plain text, never a link.
 */
export function mentionView(m: MentionLike, links: Record<string, string>, titles: Record<string, string> = {}): { text: string; target: string | null } {
  const key = mentionKey(m);
  const target = links[key] ?? null;
  const text = m.text || (target ? titles[key] : '') || m.name || '';
  return { text: text || (target ? 'Page' : '(page not imported)'), target };
}
