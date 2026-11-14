// The Library tree as data: sources, then folders, then pages nested under their parent page.
// Pages keep the order their source gives them (`position`); A–Z and Recent are separate flat lists.
export interface PageRow {
  id: string; path: string; title: string; kind: string; tags: string[]; folder: string[];
  icon: { glyph?: string; color?: string } | null; parentId: string | null; source: string | null; updated_at: string; visibility?: string;
  /** Place in the source's own order (lower first). Null: the source gave none. */
  position?: number | null;
}

export interface Node { key: string; label: string; page?: PageRow; children: Node[]; count: number; pos: number | null }

const byLabel = (a: Node, b: Node) => a.label.localeCompare(b.label, undefined, { numeric: true });

export function buildTree(rows: PageRow[]): Node[] {
  const roots: Node[] = [];
  const byPage = new Map<string, Node>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) byPage.set(r.id, { key: `p:${r.id}`, label: r.title, page: r, children: [], count: 0, pos: r.position ?? null });
  const folderNode = (parent: Node[], key: string, label: string) => {
    let n = parent.find((x) => !x.page && x.key === key);
    if (!n) { n = { key, label, children: [], count: 0, pos: null }; parent.push(n); }
    return n;
  };
  for (const r of rows) {
    const node = byPage.get(r.id)!;
    if (r.parentId && ids.has(r.parentId) && r.parentId !== r.id) { byPage.get(r.parentId)!.children.push(node); continue; }
    const src = r.source ?? 'Written in Alexandria';
    let level = folderNode(roots, `s:${src}`, src).children;
    let key = `s:${src}`;
    for (const f of r.folder ?? []) {
      key += `/${f}`;
      level = folderNode(level, `f:${key}`, f).children;
    }
    level.push(node);
  }
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
