// The library tree the web app draws (web/src/pages/library/treeModel.ts is plain TypeScript, so it runs here). Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, type Node, type PageRow } from '../../web/src/pages/library/treeModel.ts';

const row = (id: string, title: string, o: Partial<PageRow> = {}): PageRow => ({ id, path: `${title}.md`, title, kind: 'page', tags: [], folder: [], icon: null, parentId: null, source: 'Atlas', updated_at: '2026-01-01', ...o });
const walk = (ns: Node[]): Node[] => ns.flatMap((n) => [n, ...walk(n.children)]);

test('WebTree_AFolderAndAPageWithTheSameNameAreOneNodeThatOpensAndExpands', () => {
  // A resource that has children and a page of its own: the page, and the folder its children's paths name.
  const rows = [
    row('a', 'The Marches'),
    row('b', 'Harrow Keep', { folder: ['The Marches'] }),
    row('c', 'Mill Road', { folder: ['The Marches'] }),
    row('d', 'Elsewhere'),
  ];
  const tree = buildTree(rows);
  const all = walk(tree);
  assert.equal(all.filter((n) => n.label === 'The Marches').length, 1, 'shown once');
  const merged = all.find((n) => n.label === 'The Marches')!;
  assert.equal(merged.page?.id, 'a', 'it opens the page');
  assert.deepEqual(merged.children.map((n) => n.label).sort(), ['Harrow Keep', 'Mill Road'], 'and expands to its children');
  assert.equal(merged.count, 3);
});

test('WebTree_TheSameNameInDifferentPlacesStaysSeparate_AndSourcesNeverMerge', () => {
  const rows = [
    row('a', 'Ports'),
    row('b', 'Ports', { folder: ['North'] }),
    row('c', 'Dock', { folder: ['Ports', 'Deep'] }),
    row('d', 'Atlas', { source: 'Other' }),
  ];
  const all = walk(buildTree(rows));
  assert.equal(all.filter((n) => n.label === 'Ports' && n.page).length, 2, 'two pages with one name in different folders are two pages');
  assert.ok(all.some((n) => n.label === 'Atlas' && !n.page), 'a source named like a page is still a source');
  assert.ok(!all.some((n) => n.label === 'Ports' && !n.page), 'the folder named like its sibling page merged into it');
  assert.ok(all.some((n) => n.label === 'North' && !n.page), 'a folder with no page of its own stays a folder');
  const ports = all.find((n) => n.label === 'Ports' && n.page?.id === 'a')!;
  assert.deepEqual(ports.children.map((n) => n.label), ['Deep'], 'the merged page keeps what the folder held');
});

test('WebTree_ChildrenNestedUnderTheirParentPageAreNotDuplicatedByTheFolderPath', () => {
  const rows = [
    row('a', 'Guild'),
    row('b', 'Hall', { parentId: 'a', folder: ['Guild'] }),
    row('c', 'Vault', { folder: ['Guild'] }),
  ];
  const all = walk(buildTree(rows));
  assert.equal(all.filter((n) => n.label === 'Guild').length, 1);
  const g = all.find((n) => n.label === 'Guild')!;
  assert.deepEqual(g.children.map((n) => n.label).sort(), ['Hall', 'Vault']);
});

test('WebTree_TwoSourcesWithOneNameStayTwoRowsAndEachSharesItself', () => {
  const rows = [
    row('a', 'Harbor', { source: 'Wiki', sourceId: 'src_one', sourceKind: 'kanka' }),
    row('b', 'Market', { source: 'Wiki', sourceId: 'src_one', sourceKind: 'kanka', folder: ['Town'] }),
    row('c', 'Tower', { source: 'Wiki', sourceId: 'src_two', sourceKind: 'obsidian' }),
    row('d', 'Notes', { source: 'Atlas', sourceId: 'src_three', sourceKind: 'obsidian' }),
  ];
  const tree = buildTree(rows);
  const wikis = tree.filter((n) => n.label === 'Wiki');
  assert.equal(wikis.length, 2, 'not merged by name');
  assert.deepEqual(wikis.map((n) => n.folder!.sourceId).sort(), ['src_one', 'src_two'], 'a whole-source share targets the right source');
  assert.deepEqual(wikis.map((n) => n.hint).sort(), ['Kanka', 'Obsidian'], 'the connector type tells them apart');
  const one = wikis.find((n) => n.folder!.sourceId === 'src_one')!;
  assert.equal(one.count, 2);
  assert.equal(walk(one.children).find((n) => n.label === 'Town')!.folder!.sourceId, 'src_one', 'folders inside keep their source');
  assert.equal(tree.find((n) => n.label === 'Atlas')!.hint, undefined, 'a unique name needs no hint');
  // Same name and same connector type: numbered.
  const twins = buildTree([row('x', 'A', { source: 'Wiki', sourceId: 's1', sourceKind: 'kanka' }), row('y', 'B', { source: 'Wiki', sourceId: 's2', sourceKind: 'kanka' })]);
  assert.deepEqual(twins.map((n) => n.hint).sort(), ['Kanka 1', 'Kanka 2']);
});
