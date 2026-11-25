// The Library tree as data: sources, then folders, then pages nested under their parent page.
// Pages keep the order their source gives them (`position`); A–Z and Recent are separate flat lists.
export interface PageRow {
  id: string; path: string; title: string; kind: string; tags: string[]; folder: string[];
  icon: { glyph?: string; color?: string } | null; parentId: string | null; source: string | null; updated_at: string; visibility?: string;
  /** Place in the source's own order (lower first). Null: the source gave none. */
  position?: number | null;
  /** A page opened through a share or a DM grant (not through a key of your own). */
  sharedWithMe?: boolean;
  /** DM only: the source's id ('' for pages written in Alexandria); folder rules are keyed by it. */
  sourceId?: string;
  /** Set by mergeCopies: every copy of this page the viewer can open, this one first. */
  copies?: { id: string; source: string | null; visibility?: string }[];
  /** Set by mergeCopies (DM): some copy of this page is open to the whole party. */
  playersSee?: boolean;
}

const plain = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The same page can reach a world more than once: from two sources that read the same site, and from an import. One row per page:
 * same title in the same folder, from different sources. The copy from the biggest source leads, the rest are listed on it.
 * Two pages of one source are never merged. Nothing is hidden: `repOf` says which row a page is shown under.
 */
export function mergeCopies(rows: PageRow[]): { rows: PageRow[]; repOf: Map<string, string> } {
  const size = new Map<string, number>();
  for (const r of rows) size.set(r.source ?? '', (size.get(r.source ?? '') ?? 0) + (r.source ? 1 : 0));
  const groups = new Map<string, PageRow[][]>();
  for (const r of rows) {
    const k = `${plain(r.title)}|${(r.folder ?? []).map(plain).join('/')}`;
    const g = groups.get(k) ?? [];
    const slot = g.find((x) => !x.some((y) => y.source === r.source));
    if (slot) slot.push(r); else g.push([r]);
    groups.set(k, g);
  }
  const repOf = new Map<string, string>();
  const lead = new Map<string, PageRow>();
  for (const g of groups.values()) for (const set of g) {
    const order = [...set].sort((a, b) => (size.get(b.source ?? '') ?? 0) - (size.get(a.source ?? '') ?? 0));
    for (const r of order) repOf.set(r.id, order[0].id);
    lead.set(order[0].id, { ...order[0], playersSee: order.some((r) => r.visibility === 'party'), sharedWithMe: order.some((r) => r.sharedWithMe) || undefined, copies: order.map((r) => ({ id: r.id, source: r.source, visibility: r.visibility })) });
  }
  // Keep the order the rows came in; a child of a merged page hangs under the row its parent is shown as.
  return { rows: rows.filter((r) => lead.has(r.id)).map((r) => { const m = lead.get(r.id)!; return m.parentId ? { ...m, parentId: repOf.get(m.parentId) ?? m.parentId } : m; }), repOf };
}

export interface Node { key: string; label: string; page?: PageRow; children: Node[]; count: number; pos: number | null; /** A folder: where a share rule for it is kept. */ folder?: { sourceId: string; path: string } }

const byLabel = (a: Node, b: Node) => a.label.localeCompare(b.label, undefined, { numeric: true });

export function buildTree(rows: PageRow[]): Node[] {
  const roots: Node[] = [];
  const byPage = new Map<string, Node>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) byPage.set(r.id, { key: `p:${r.id}`, label: r.title, page: r, children: [], count: 0, pos: r.position ?? null });
  const folderNode = (parent: Node[], key: string, label: string, folder?: Node['folder']) => {
    let n = parent.find((x) => !x.page && x.key === key);
    if (!n) { n = { key, label, children: [], count: 0, pos: null, ...(folder ? { folder } : {}) }; parent.push(n); }
    return n;
  };
  for (const r of rows) {
    const node = byPage.get(r.id)!;
    if (r.parentId && ids.has(r.parentId) && r.parentId !== r.id) { byPage.get(r.parentId)!.children.push(node); continue; }
    const src = r.source ?? 'Written in Alexandria';
    // A source at the top is a folder too: a rule with no path shares the whole source.
    let level = folderNode(roots, `s:${src}`, src, { sourceId: r.sourceId ?? '', path: '' }).children;
    let key = `s:${src}`;
    const names: string[] = [];
    for (const f of r.folder ?? []) {
      key += `/${f}`;
      names.push(f);
      level = folderNode(level, `f:${key}`, f, { sourceId: r.sourceId ?? '', path: names.join('/') }).children;
    }
    level.push(node);
  }
  // A resource that has children and a page of its own reaches the tree twice (its page, and the folder its children's paths name): one node, both
  // openable and expandable. Only siblings with the same name merge, and never a source at the top.
  const same = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const mergeTwins = (ns: Node[]) => {
    for (let i = ns.length - 1; i >= 0; i--) {
      const f = ns[i];
      if (f.page) continue;
      const twin = ns.find((x) => x.page && same(x.label) === same(f.label));
      if (twin) { twin.children.push(...f.children); ns.splice(i, 1); }
    }
    for (const n of ns) mergeTwins(n.children);
  };
  for (const r of roots) mergeTwins(r.children);
  // Children are sorted first so a folder knows where its first page sits. Sources are A–Z; below them
  // folders come before pages and each group follows the source's order, pages with no position last (A–Z).
  const sortCount = (ns: Node[], top: boolean): number => {
    let total = 0;
    for (const n of ns) {
      n.count = (n.page ? 1 : 0) + sortCount(n.children, false);
      total += n.count;
      if (!n.page) n.pos = n.children.reduce<number | null>((m, c) => (c.pos === null ? m : m === null ? c.pos : Math.min(m, c.pos)), null);
    }
    ns.sort((a, b) => {
      if (top) return byLabel(a, b);
      if (!!a.page !== !!b.page) return a.page ? 1 : -1;
      if (a.pos !== b.pos) return a.pos === null ? 1 : b.pos === null ? -1 : a.pos - b.pos;
      return byLabel(a, b);
    });
    return total;
  };
  sortCount(roots, true);
  return roots;
}

/** Every page id under a node, for "save this folder". */
export function pageIds(n: Node): string[] {
  return [...(n.page ? [n.page.id] : []), ...n.children.flatMap(pageIds)];
}

/** Titles in tree order, folders and nesting flattened depth first. */
export function treeTitles(ns: Node[]): string[] {
  return ns.flatMap((n) => [n.label, ...treeTitles(n.children)]);
}
