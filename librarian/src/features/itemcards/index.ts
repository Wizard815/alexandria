// Item cards: an item can point at a library page (any source), and the card
// shows the item next to a live excerpt of that page. Nothing from the page is
// copied into the item; it is read at request time through the library, so
// players only ever get the player copy (player_blocks / player_properties).
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { ctx, isDM, me, names, settings } from '../../routes/_shared.ts';
import { blocksToMarkdown, type Block, type PropertyGroup } from '../../intake/model.ts';
import { checkPageId } from './link.ts';
import { splitFrontmatter } from '../../core/frontmatter.ts';
import { safePagePath } from '../../core/library.ts';

const EXCERPT_CHARS = 800;

/** Drop anything GM-only, whatever the copy says (defence in depth). */
function scrub(blocks: Block[]): Block[] {
  return blocks
    .filter((b) => b.kind !== 'secret' && !(b.kind === 'callout' && /secret|dm/i.test(String((b as any).variant ?? ''))))
    .map((b: any) => (b.children ? { ...b, children: scrub(b.children) } : b.groups ? { ...b, groups: b.groups.filter((g: PropertyGroup) => !g.dm) } : b));
}

const textLen = (bs: Block[]) => blocksToMarkdown(bs).length;

/** The lead (blocks before the first heading), or else the first heading's section; capped to ~800 characters. */
export function excerpt(blocks: Block[]): { blocks: Block[]; truncated: boolean } {
  const body = blocks.filter((b) => b.kind !== 'infobox' && b.kind !== 'collection' && b.kind !== 'unsupported');
  const firstH = body.findIndex((b) => b.kind === 'heading');
  let pick: Block[];
  if (firstH === -1) pick = body;
  else if (firstH > 0 && textLen(body.slice(0, firstH)) > 0) pick = body.slice(0, firstH);
  else {
    const level = (body[firstH] as any).level ?? 1;
    let end = body.length;
    for (let i = firstH + 1; i < body.length; i++) if (body[i].kind === 'heading' && ((body[i] as any).level ?? 1) <= level) { end = i; break; }
    pick = body.slice(firstH, end);
  }
  const out: Block[] = [];
  let used = 0;
  let truncated = pick.length < body.length;
  for (const b of pick) {
    const n = textLen([b]);
    if (out.length && used + n > EXCERPT_CHARS) break;
    out.push(b);
    used += n;
  }
  if (out.length < pick.length) truncated = true;
  return { blocks: out, truncated };
}

const feature: Feature = {
  id: 'itemcards',
  migrate(db) {
    const cols = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('page_id')) db.exec('ALTER TABLE items ADD COLUMN page_id TEXT REFERENCES pages(id) ON DELETE SET NULL');
  },
  worldMount: 'itemcards',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const { db } = d;

    // Pages the item form may link to. Players: only pages they can open.
    r.get('/pages', (req, res) => {
      const c = ctx(res);
      const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
      const rows = (d.library.list(c.world.id, c.viewer) as any[])
        .filter((p) => !q || p.title.toLowerCase().includes(q) || String(p.path).toLowerCase().includes(q))
        .sort((a, b) => (q ? Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)) : 0) || a.title.localeCompare(b.title))
        .slice(0, 30)
        .map((p) => ({ id: p.id, title: p.title, kind: p.kind, source: p.source, ...(isDM(res) ? { visibility: p.visibility } : {}) }));
      res.json(rows);
    });

    const find = (res: any, raw: string) => {
      const c = ctx(res);
      const it = one<any>(db, `SELECT * FROM items WHERE id = ? AND world_id = ? AND status IN ('approved', 'pending')`, raw, c.world.id);
      // Players see their own things and the party stash; anything else does not exist for them.
      if (!it || (!isDM(res) && it.owner !== me(res) && it.owner !== 'party')) throw new HttpError(404, 'Item not found');
      return it;
    };

    r.get('/:itemId', (req, res) => {
      const c = ctx(res);
      const dm = isDM(res);
      const it = find(res, String(req.params.itemId));
      const out: any = {
        item: {
          id: it.id, name: it.name, image: it.image ?? null, qty: it.qty, owner: it.owner,
          ownerName: it.owner === 'party' ? 'The party' : names(db, c.world.id)[it.owner] ?? null, note: it.note, pageId: it.page_id ?? null,
          ...(dm || settings(res).trackWeight ? { weight: it.weight } : {}),
          ...(dm ? { dmNote: it.dm_note } : {}),
        },
        page: null,
      };
      if (it.page_id) {
        try {
          // The library gives players the player copy of shared pages only, and 404s otherwise.
          const pg: any = d.library.get(c.world.id, it.page_id, c.viewer);
          const blocks: Block[] = dm ? pg.blocks : scrub(pg.blocks);
          const facts: PropertyGroup[] = (pg.properties as PropertyGroup[]).filter((g) => dm || !g.dm);
          // The card already shows the title: drop a leading heading that repeats it.
          const first: any = blocks[0];
          const lead = first?.kind === 'heading' ? blocksToMarkdown([first]).replace(/^#+\s*/, '').trim().toLowerCase() : null;
          const ex = excerpt(lead !== null && lead === String(pg.title).trim().toLowerCase() ? blocks.slice(1) : blocks);
          out.page = {
            id: pg.id, title: pg.title, kind: pg.kind, icon: pg.icon, facts, excerpt: ex.blocks, truncated: ex.truncated, links: pg.links, updated_at: pg.updated_at,
            openPath: `/w/${c.world.id}/${dm ? 'dm/' : ''}library?page=${encodeURIComponent(pg.id)}`,
            ...(dm ? { visibility: pg.visibility } : {}),
          };
        } catch { /* hidden or deleted: players get the item alone */ }
      }
      res.json(out);
    });

    // Link or unlink (pageId null). Only the GM or the item's holder.
    r.put('/:itemId/page', (req, res) => {
      const c = ctx(res);
      if (c.viewer.role !== 'dm' && c.viewer.role !== 'player') throw new HttpError(403, 'Only players and the GM can link items');
      const it = find(res, String(req.params.itemId));
      const b = req.body ?? {};
      let pageId: string | null | undefined;
      // The GM (or the assistant, on approval) may write the item's page and link it in one go.
      if (b.newPage && typeof b.newPage === 'object') {
        if (c.viewer.role !== 'dm') throw new HttpError(403, 'Only the GM can write a new page here');
        const np = b.newPage;
        const title = typeof np.title === 'string' && np.title.trim() ? np.title.trim().slice(0, 120) : it.name;
        const path = safePagePath(typeof np.path === 'string' && np.path.trim() ? np.path : `items/${title}`);
        if (c.viewer.audience === 'ai' && d.library.hasClassified(c.world.id, path)) throw new HttpError(409, 'That page holds classified content that no AI can see. Edit it in the app.');
        const { fm, body } = splitFrontmatter(typeof np.markdown === 'string' ? np.markdown : `# ${title}\n`);
        const saved: any = d.library.save(c.world.id, { path, title, body, frontmatter: fm, visibility: np.visibility === 'party' ? 'party' : 'dm' }, me(res));
        d.hub.emit(c.world.id, 'page', { id: saved.id, path: saved.path, title: saved.title }, (v) => v.role === 'dm' || saved.visibility === 'party');
        pageId = String(saved.id);
      } else pageId = checkPageId(d, res, b.pageId);
      if (pageId === undefined) throw new HttpError(400, 'pageId is required (a page id, or null to unlink)');
      run(db, 'UPDATE items SET page_id = ?, updated_at = ? WHERE id = ?', pageId, now(), it.id);
      // (not app.ts's audit(): features must not import app.ts, which loads them)
      run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', c.world.id, me(res), 'item.link', `${it.name} -> ${pageId ?? 'none'}`.slice(0, 500), now());
      d.hub.emitPer(c.world.id, 'item', (v) => (it.owner !== 'party' && v.role !== 'dm' && v.accountId !== it.owner ? null : { id: it.id, pageId }));
      res.json({ id: it.id, pageId });
    });
    return r;
  },
  mcpTools: [
    {
      name: 'get_item_card',
      description: "An item's card: the item (name, quantity, owner, notes) with the title, facts and opening section of the library page it is linked to. Players only get what the player copy of the page shows.",
      props: { itemId: { type: 'string', description: 'The item id' } },
      required: ['itemId'],
      call: (a) => ({ method: 'GET', path: `/itemcards/${encodeURIComponent(String(a.itemId))}` }),
    },
    {
      name: 'link_item_page',
      description: 'Link an inventory item to a library page (any source), or unlink it with pageId null. To write a new page for the item and link it in one step, give newPage instead of pageId. The card then shows that page live.',
      write: true,
      props: {
        itemId: { type: 'string' },
        pageId: { type: ['string', 'null'], description: 'Library page id, or null to unlink' },
        newPage: { type: 'object', description: 'Write this page and link it (GM): {title, markdown, visibility: dm|party}', properties: { title: { type: 'string' }, markdown: { type: 'string' }, visibility: { type: 'string', enum: ['dm', 'party'] } } },
      },
      required: ['itemId'],
      call: (a) => ({ method: 'PUT', path: `/itemcards/${encodeURIComponent(String(a.itemId))}/page`, body: a.newPage ? { newPage: a.newPage } : { pageId: a.pageId ?? null } }),
    },
  ],
};
export default feature;
