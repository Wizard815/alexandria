// What a stage card shows a given viewer. Every card is built from player
// copies at the moment it is read; nothing the DM typed as a "preview" is
// trusted, and a page or person that stops being shared simply disappears
// from players' boards (fail closed). The DM sees the same player view of
// pages, shops and people (that is what the table sees), and the full
// combat tracker.
import type { Deps } from '../../app.ts';
import { one, all } from '../../core/db.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { DEFAULT_SETTINGS, type Viewer, type WorldSettings } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { blocksToMarkdown, type Block, type PropertyGroup } from '../../intake/model.ts';
import { excerpt } from '../itemcards/index.ts';
import { mintTicket } from '../sound/ticket.ts';

export const KINDS = ['image', 'combat', 'person', 'shop', 'place', 'event', 'text', 'drawing'] as const;
export type Kind = (typeof KINDS)[number];

export interface CardRow {
  id: string; world_id: string; kind: Kind; ref: string | null; label: string; text: string; caption: string;
  x: number; y: number; w: number; h: number; z: number;
  visibility: 'all' | 'players' | 'dm'; audience: string; options: string; shown_at: string | null; created_at: string; created_by: string;
}

/** A player as the pages and people see them: no DM, no account of its own. */
export const PLAYER: Viewer = { accountId: '', role: 'player' };

export const worldSettings = (db: Deps['db'], worldId: string): WorldSettings =>
  ({ ...DEFAULT_SETTINGS, ...parseJson(one<{ settings: string }>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {}) });

/** Drop anything DM-only, whatever the copy says (defence in depth). */
function scrub(blocks: Block[]): Block[] {
  return blocks
    .filter((b) => b.kind !== 'secret' && !(b.kind === 'callout' && /secret|dm|gm/i.test(String((b as any).variant ?? ''))))
    .map((b: any) => (b.children ? { ...b, children: scrub(b.children) } : b.groups ? { ...b, groups: b.groups.filter((g: PropertyGroup) => !g.dm) } : b));
}

export interface PageCopy {
  id: string; title: string; kind: string; icon: unknown; excerpt: Block[]; truncated: boolean; links: Record<string, string>;
  facts: PropertyGroup[]; fm: Record<string, unknown>; blocks: Block[];
}

/** A library page as a player sees it (the player copy only), or null if players cannot open it. */
export function pageView(d: Deps, worldId: string, pageId: string | null, bigger = false): PageCopy | null {
  if (!pageId) return null;
  try {
    const pg: any = d.library.get(worldId, pageId, PLAYER);
    const blocks = scrub(pg.blocks as Block[]);
    const first: any = blocks[0];
    const lead = first?.kind === 'heading' ? blocksToMarkdown([first]).replace(/^#+\s*/, '').trim().toLowerCase() : null;
    const body = lead !== null && lead === String(pg.title).trim().toLowerCase() ? blocks.slice(1) : blocks;
    const ex = bigger
      ? { blocks: body.filter((b) => b.kind !== 'infobox' && b.kind !== 'collection' && b.kind !== 'unsupported').slice(0, 40), truncated: false }
      : excerpt(body);
    return {
      id: pg.id, title: pg.title, kind: pg.kind, icon: pg.icon, excerpt: ex.blocks, truncated: ex.truncated, links: pg.links,
      facts: (pg.properties as PropertyGroup[]).filter((g) => !g.dm), fm: pg.frontmatter ?? {}, blocks,
    };
  } catch { return null; }
}

const UNIT: Record<string, number> = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
/** "2 gp 5 sp" or "15 gp" in copper; null if there is no price. */
export function priceCp(text: string): number | null {
  let total = 0, found = false;
  for (const m of String(text).matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(pp|gp|ep|sp|cp)\b/gi)) {
    total += Math.round(parseFloat(m[1].replace(/,/g, '')) * UNIT[m[2].toLowerCase()]);
    found = true;
  }
  return found && total > 0 ? total : null;
}

export interface StockItem { name: string; price: string; priceCp: number | null }

const textOf = (b: Block): string => blocksToMarkdown([b]).replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/[*_`]/g, '').trim();
function listItems(blocks: Block[], out: string[] = []): string[] {
  for (const b of blocks as any[]) {
    if (b.kind === 'listItem') out.push(textOf(b));
    else if (b.kind === 'tableRow') out.push((b.children ?? []).map((c: Block) => textOf(c)).filter(Boolean).join(' - '));
    else if (b.children) listItems(b.children, out);
  }
  return out;
}
function split(line: string): StockItem {
  const m = line.match(/^(.*?)\s*[—–:-]\s+(\d[\d.,]*\s*(?:pp|gp|ep|sp|cp)\b.*)$/i) ?? line.match(/^(.*?)\s*\(\s*(\d[\d.,]*\s*(?:pp|gp|ep|sp|cp)\b.*?)\)\s*$/i);
  const name = (m ? m[1] : line).trim().slice(0, 120);
  const price = (m ? m[2] : '').trim().slice(0, 60);
  return { name, price, priceCp: priceCp(price) };
}

/** The stock a shop page lists: frontmatter `items` (Sculpting saves it), else "Item - price" list lines. Player copy only. */
export function stockOf(pg: { fm: Record<string, unknown>; blocks: Block[] }): StockItem[] {
  const out: StockItem[] = [];
  const fmItems = pg.fm?.items;
  if (Array.isArray(fmItems)) {
    for (const it of fmItems as any[]) {
      if (typeof it === 'string') out.push(split(it));
      else if (it && typeof it === 'object' && typeof it.name === 'string') out.push({ name: it.name.slice(0, 120), price: String(it.price ?? ''), priceCp: priceCp(String(it.price ?? '')) });
    }
  }
  if (!out.length) for (const l of listItems(pg.blocks)) if (l) out.push(split(l));
  return out.filter((i) => i.name).slice(0, 80);
}

/** A picture's address for one account: an upload gets a signed ticket (an <img> cannot send the sign-in header), a link is used as is. */
export const imageUrl = (ref: string | null, worldId: string, accountId: string): string | null => {
  if (!ref) return null;
  if (ref.startsWith('stg_')) return `/api/media/stage/${mintTicket({ w: worldId, k: 'stage', f: ref, a: accountId })}`;
  return ref;
};

export const opts = (c: CardRow) => parseJson<Record<string, any>>(c.options, {});
export const audienceOf = (c: CardRow) => parseJson<string[]>(c.audience, []);

/** May this viewer have this card at all? (DM: always.) */
export function canHave(c: CardRow, v: Viewer): boolean {
  if (v.role === 'dm') return true;
  if (c.visibility === 'all') return true;
  return c.visibility === 'players' && v.role === 'player' && audienceOf(c).includes(v.accountId);
}

const pageOut = (pg: PageCopy, w: string) => ({
  id: pg.id, title: pg.title, kind: pg.kind, icon: pg.icon, facts: pg.facts, excerpt: pg.excerpt, truncated: pg.truncated, links: pg.links,
  openPath: `/w/${w}/library?page=${encodeURIComponent(pg.id)}`,
});

/** The card's data for a viewer, or null when there is nothing safe to show. */
export function dataFor(d: Deps, c: CardRow, v: Viewer, s: WorldSettings): Record<string, unknown> | null {
  const w = c.world_id;
  const o = opts(c);
  switch (c.kind) {
    case 'image': return { url: imageUrl(c.ref, w, v.accountId), caption: c.caption };
    case 'drawing': return {};
    case 'text': return { title: c.label, markdown: c.text };
    case 'event': return { title: c.label, text: c.text, url: imageUrl(c.ref, w, v.accountId), endsAt: c.shown_at && o.endsAt ? o.endsAt : null };
    case 'combat': return { view: combatViewFor(d.db, w, v, s) };
    case 'place': {
      const pg = pageView(d, w, c.ref);
      return pg ? { page: pageOut(pg, w) } : null;
    }
    case 'shop': {
      const pg = pageView(d, w, c.ref, true);
      if (!pg) return null;
      return { page: pageOut(pg, w), items: stockOf(pg), canBuy: o.buy !== false };
    }
    case 'person': {
      const p = one<any>(d.db, 'SELECT * FROM people WHERE id = ? AND world_id = ?', c.ref, w);
      // A person the party has not met (DM-only) is never put in front of players.
      if (!p || p.visibility !== 'party') return null;
      const quotes = all<any>(d.db, 'SELECT text, said FROM quotes WHERE person_id = ? AND visibility = ?', p.id, 'party').map((q) => ({ text: q.text, said: q.said }));
      const pg = pageView(d, w, p.page_id);
      return { person: { id: p.id, name: p.name, role: p.role, attitude: p.attitude, kind: p.kind, met: p.met, quotes }, page: pg ? pageOut(pg, w) : null };
    }
  }
}

/** The card as one viewer gets it, or null (a player never gets a card they may not have, or one with nothing safe in it). */
export function project(d: Deps, c: CardRow, v: Viewer, s: WorldSettings) {
  if (!canHave(c, v)) return null;
  const data = dataFor(d, c, v, s);
  const dm = v.role === 'dm';
  if (!data && !dm) return null;
  const out: any = { id: c.id, kind: c.kind, x: c.x, y: c.y, w: c.w, h: c.h, z: c.z, shownAt: c.shown_at, data: data ?? {}, unavailable: data === null ? true : undefined };
  if (dm) Object.assign(out, { label: c.label, visibility: c.visibility, audience: audienceOf(c), ref: c.ref, text: c.text, caption: c.caption, options: opts(c) });
  return out;
}
