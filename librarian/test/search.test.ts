// Library search: ranking, prefix, typos, phrases, exclusions, snippets, the
// player copy only, migration of old indexes and speed at 5,000 pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.ts';
import { run, one, all } from '../src/core/db.ts';
import { ensureSearchIndex, makeSnippet, parseQuery, ftsExpr, editDistance } from '../src/core/pagesearch.ts';

function makeWorld() {
  const { app, deps } = createApp({ env: { ALX_ADMIN_TABLE_LOGIN: '1' }, noScheduler: true });
  const wid = 'w_search';
  run(deps.db, `INSERT INTO accounts (id, username, display_name, pass_hash, is_admin, created_at) VALUES ('a_dm', 'dm', 'DM', 'x', 0, '2025-01-01')`);
  run(deps.db, `INSERT INTO accounts (id, username, display_name, pass_hash, is_admin, created_at) VALUES ('a_p', 'pl', 'Player', 'x', 0, '2025-01-01')`);
  run(deps.db, `INSERT INTO worlds (id, slug, name, created_at) VALUES (?, 'search', 'Search', '2025-01-01')`, wid);
  return { app, deps, wid, dm: { accountId: 'a_dm', role: 'dm' as const }, pl: { accountId: 'a_p', role: 'player' as const } };
}

const ids = (hits: any[]) => hits.map((h) => h.title);

test('TestSearch_ParseQuery', () => {
  const p = parseQuery('red "old mill" -smugglers salt');
  assert.deepEqual(p.pos.map((t) => t.words), [['red'], ['old', 'mill'], ['salt']]);
  assert.deepEqual(p.not.map((t) => t.words), [['smugglers']]);
  assert.equal(p.pos[2].prefix, true);
  assert.equal(parseQuery('salt ').pos[0].prefix, false);
  assert.equal(ftsExpr(parseQuery('red -blue'), 'and'), '("red") NOT ("blue")');
  assert.equal(ftsExpr(parseQuery('-blue'), 'and'), null);
  assert.equal(ftsExpr(parseQuery('red bl'), 'and'), '("red" "bl"*)');
  assert.equal(editDistance('saltmrsh', 'saltmarsh', 2), 1);
  assert.equal(editDistance('abcd', 'wxyz', 1), 2);
});

test('TestSearch_TitleBeatsBodyAndExactTitleFirst', () => {
  const { deps, wid, dm } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 'a/Tavern gossip', title: 'Tavern gossip', body: 'People talk about Saltmarsh and the harbor all night. Saltmarsh Saltmarsh Saltmarsh.', visibility: 'party' }, null);
  L.save(wid, { path: 'a/Harbor', title: 'Harbor', body: 'Ships dock here. Near Saltmarsh.', visibility: 'party' }, null);
  L.save(wid, { path: 'a/Saltmarsh Guide', title: 'Saltmarsh Guide', body: 'A guide.', visibility: 'party' }, null);
  L.save(wid, { path: 'a/Saltmarsh', title: 'Saltmarsh', body: 'A port town.', visibility: 'party' }, null);
  const hits = L.search(wid, 'saltmarsh', dm);
  assert.equal(hits[0].title, 'Saltmarsh', 'exact title first');
  assert.equal(hits[1].title, 'Saltmarsh Guide', 'title match before body-only matches');
  assert.ok(ids(hits).indexOf('Tavern gossip') > 1 && ids(hits).indexOf('Harbor') > 1);
  for (const k of ['id', 'path', 'title', 'snippet']) assert.ok(k in hits[0], k);
  assert.ok(typeof hits[0].score === 'number');
});

test('TestSearch_AliasBeatsBodyAndExactAliasBeatsTitlePrefix', () => {
  const { deps, wid, dm, pl } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 'Mira', title: 'Mira Vale', body: 'A cartographer.', frontmatter: { aliases: ['The Mapmaker'] }, visibility: 'party' }, null);
  L.save(wid, { path: 'Notes', title: 'Notes', body: 'Someone mentioned the mapmaker twice. The mapmaker is odd.', visibility: 'party' }, null);
  assert.equal(L.search(wid, 'mapmaker', dm)[0].title, 'Mira Vale');
  assert.equal(L.search(wid, 'the mapmaker', pl)[0].title, 'Mira Vale');
  assert.equal(L.search(wid, 'the mapmaker', pl)[0].matchedOn, 'alias');
});

test('TestSearch_RecencyBreaksTies', () => {
  const { deps, wid, dm } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 'one', title: 'Old lantern', body: 'lantern', visibility: 'party' }, null);
  L.save(wid, { path: 'two', title: 'New lantern', body: 'lantern', visibility: 'party' }, null);
  run(deps.db, `UPDATE pages SET updated_at = '2020-01-01T00:00:00.000Z' WHERE path = 'one.md'`);
  const hits = L.search(wid, 'lantern', dm);
  assert.equal(hits[0].title, 'New lantern');
});

test('TestSearch_PrefixAndDiacritics', () => {
  const { deps, wid, dm } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 'c', title: 'Café Étoile', body: 'A cozy place near the gardens.', visibility: 'party' }, null);
  L.save(wid, { path: 'g', title: 'Gardens', body: 'Green.', visibility: 'party' }, null);
  assert.equal(L.search(wid, 'cafe etoile', dm)[0].title, 'Café Étoile');
  assert.equal(L.search(wid, 'ÉTOILE', dm)[0].title, 'Café Étoile');
  assert.equal(L.search(wid, 'cafe', dm).length, 1);
  assert.ok(L.search(wid, 'gard', dm).length >= 2, 'prefix on the last word');
  assert.equal(L.search(wid, 'gard ', dm).length, 0, 'a finished word is not a prefix');
  assert.equal(L.search(wid, 'near gard', dm)[0].title, 'Café Étoile');
  // snippet marks the accent-folded match without breaking the original letters
  assert.match(L.search(wid, 'cafe', dm)[0].titleHtml, /<mark>Café<\/mark>/);
});

test('TestSearch_TypoToleranceOnTitlesAndAliases', () => {
  const { deps, wid, dm, pl } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 's', title: 'Saltmarsh', body: 'A town.', visibility: 'party' }, null);
  L.save(wid, { path: 'm', title: 'Mira', body: 'A person.', frontmatter: { aliases: ['Brightwater'] }, visibility: 'party' }, null);
  L.save(wid, { path: 'x', title: 'Hidden Keep', body: 'DM only.', visibility: 'dm' }, null);
  assert.equal(L.search(wid, 'Saltmrsh', dm)[0].title, 'Saltmarsh');
  assert.equal(L.search(wid, 'saltmarhs', pl)[0].title, 'Saltmarsh', 'transposition');
  assert.equal(L.search(wid, 'Brigthwater', pl)[0].title, 'Mira');
  assert.equal(L.search(wid, 'Saltmrsh', dm)[0].matchedOn, 'fuzzy');
  assert.equal(L.search(wid, 'Saltmrsh', dm)[0].titleHtml, '<mark>Saltmarsh</mark>', 'the corrected word is marked');
  assert.deepEqual(L.search(wid, 'Hiden Keep', pl), [], 'typos never reveal a DM page to a player');
  assert.equal(L.search(wid, 'Hiden Keep', dm)[0].title, 'Hidden Keep');
});

test('TestSearch_PhrasesAndExclusions', () => {
  const { deps, wid, dm } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 'a', title: 'Old mill', body: 'The old mill burned. Smugglers hid there.', visibility: 'party' }, null);
  L.save(wid, { path: 'b', title: 'Mill road', body: 'A mill that is old stands on the road.', visibility: 'party' }, null);
  L.save(wid, { path: 'c', title: 'Granary', body: 'The old granary and the mill.', visibility: 'party' }, null);
  assert.deepEqual(ids(L.search(wid, '"old mill"', dm)), ['Old mill']);
  assert.equal(L.search(wid, 'old mill', dm).length, 3);
  assert.deepEqual(ids(L.search(wid, 'mill -smugglers', dm)).sort(), ['Granary', 'Mill road']);
  assert.deepEqual(ids(L.search(wid, 'mill -"old granary"', dm)).sort(), ['Mill road', 'Old mill']);
  assert.deepEqual(L.search(wid, '-mill', dm), []);
  // odd input never throws
  for (const q of ['"', '""', '-', '"unclosed phrase', 'a AND OR NOT', 'NEAR(', '(', '*', 'col:thing', '\\', "o'brien"]) L.search(wid, q, dm);
});

test('TestSearch_SnippetIsAroundTheMatchEscapedAndMarked', () => {
  const body = 'x '.repeat(300) + 'The <script>alert(1)</script> lighthouse keeper & his "dog" live here. ' + 'y '.repeat(300);
  const s = makeSnippet(body, parseQuery('lighthouse keeper'));
  assert.ok(s.html.includes('<mark>lighthouse</mark> <mark>keeper</mark>'));
  assert.ok(!s.html.includes('<script>') && s.html.includes('&lt;script&gt;'));
  assert.ok(s.html.includes('&amp;') && s.html.includes('&quot;dog&quot;'));
  assert.ok(s.html.startsWith('…') && s.html.endsWith('…'));
  assert.ok(s.text.length < 260);
  const { deps, wid, dm } = makeWorld();
  deps.library.save(wid, { path: 'l', title: 'Lighthouse', body: '# Lighthouse\n\n' + body, visibility: 'party' }, null);
  const hit = deps.library.search(wid, 'keeper', dm)[0];
  assert.ok(hit.snippetHtml.includes('<mark>keeper</mark>'));
  assert.ok(!hit.snippetHtml.includes('<script>') && !hit.snippet.includes('<mark>'));
  // a title that looks like HTML is escaped too
  deps.library.save(wid, { path: 'h', title: '<img src=x onerror=1> Keeper', body: 'k', visibility: 'party' }, null);
  const h = deps.library.search(wid, 'keeper', dm).find((x: any) => x.title.startsWith('<img'))!;
  assert.ok(!h.titleHtml.includes('<img') && h.titleHtml.includes('&lt;img'));
});

test('TestSearch_PlayersOnlySeePlayerCopies', () => {
  const { deps, wid, dm, pl } = makeWorld();
  const L = deps.library;
  // DM-only page
  L.save(wid, { path: 'Plot', title: 'The Plot', body: 'The vizier Zaxxar poisons the king.', visibility: 'dm' }, null);
  L.save(wid, { path: 'Cult', title: 'Hidden Cult', body: 'Moon worshippers.', visibility: 'dm' }, null);
  // Shared Markdown page: callout secret, secret heading, DM comment, secret frontmatter alias.
  L.save(wid, {
    path: 'Port', title: 'Port Vale', visibility: 'party',
    frontmatter: { aliases: ['Fishtown', 'Hidden Cult'], secret: { aliases: ['Smugglerscove'] }, dm_aliases: ['Blackharbor'] },
    body: 'Fish and nets.\n\n> [!secret]\n> Cultists meet in the Kraken cellar.\n\n## Secrets\nThe mayor is Zaxxar.\n\n## Docks\nBoats arrive.\n\n%% Moonstone is buried here %%\n',
  }, null);
  // Imported structured page: secret block, DM fact group, DM-only alias title
  run(deps.db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s1', ?, 'api', 'Wiki', '{}', 'party')`, wid);
  L.saveEntry(wid, 's1', null, {
    externalId: 'e1', title: 'Imported Inn', visibility: 'party', aliases: ['The Prancing Pig', 'Hidden Cult'],
    blocks: [{ kind: 'paragraph', content: [{ text: 'A warm inn.' }] }, { kind: 'secret', children: [{ kind: 'paragraph', content: [{ text: 'Buried truth: Quillfeather.' }] }] }],
    properties: [{ title: 'Public', rows: [{ key: 'Owner', value: [{ text: 'Brenna' }] }] }, { title: 'DM facts', dm: true, rows: [{ key: 'Real owner', value: [{ text: 'Vexmoor' }] }] }],
  }, null);
  L.rebuildPlayerCopies(wid);

  const dmFinds = (q: string) => L.search(wid, q, dm).length > 0;
  const plFinds = (q: string) => L.search(wid, q, pl).length > 0;
  // The DM finds all of it ...
  for (const q of ['Zaxxar', 'Kraken', 'Moonstone', 'Smugglerscove', 'Blackharbor', 'Quillfeather', 'Vexmoor']) assert.ok(dmFinds(q), `DM should find ${q}`);
  // ... players none of it, by prefix, phrase or typo either.
  for (const q of ['Zaxxar', 'Zaxx', 'Kraken cellar', '"Kraken cellar"', 'Moonstone', 'Smugglerscove', 'Smugglersco', 'Smuglerscove', 'Blackharbor', 'Quillfeather', 'Vexmoor', 'DM facts', 'Plot', 'vizier', 'cultists', 'Secrets', 'Hidden Cult', 'Moon worshippers']) {
    assert.deepEqual(L.search(wid, q, pl), [], `player must not find "${q}"`);
  }
  // A loose query may match the public "Owner" fact, but never shows the DM fact's value.
  for (const h of L.search(wid, 'Real owner', pl)) assert.ok(!h.snippet.includes('Vexmoor') && !h.snippet.includes('Real'));
  // Their own copy is searchable, including a public alias and a public fact.
  assert.equal(L.search(wid, 'Fishtown', pl)[0].title, 'Port Vale');
  assert.equal(L.search(wid, 'Prancing', pl)[0].title, 'Imported Inn');
  assert.equal(L.search(wid, 'Brenna', pl)[0].title, 'Imported Inn');
  assert.ok(plFinds('boats'));
  // Snippets for players never carry DM text, even for pages that contain it.
  for (const h of [...L.search(wid, 'fish', pl), ...L.search(wid, 'docks', pl), ...L.search(wid, 'inn', pl)]) {
    for (const bad of ['Zaxxar', 'Kraken', 'Moonstone', 'Quillfeather', 'Vexmoor', 'Cultists']) {
      assert.ok(!h.snippet.includes(bad) && !h.snippetHtml.includes(bad) && !h.title.includes(bad), `${bad} leaked in ${h.title}`);
    }
  }
  // Excluding a DM-only word cannot be used to probe either: no difference in the player's results.
  assert.deepEqual(ids(L.search(wid, 'fish -zaxxar', pl)), ids(L.search(wid, 'fish', pl)));
  // Hiding a page afterwards removes it from the player index.
  L.save(wid, { path: 'Port', title: 'Port Vale', visibility: 'dm', body: 'Fish and nets.' }, null);
  assert.deepEqual(L.search(wid, 'fishtown', pl), []);
  assert.deepEqual(L.search(wid, 'nets', pl), []);
  // Removing a page removes it from both indexes.
  const pid = one<any>(deps.db, `SELECT id FROM pages WHERE path = 'Plot.md'`)!.id;
  L.remove(wid, pid);
  assert.deepEqual(L.search(wid, 'Zaxxar', dm).filter((h: any) => h.title === 'The Plot'), []);
});

test('TestSearch_WorldsAreSeparate', () => {
  const { deps, wid, dm } = makeWorld();
  run(deps.db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w2', 'other', 'Other', '2025-01-01')`);
  deps.library.save('w2', { path: 'a', title: 'Elsewhere', body: 'zebra', visibility: 'party' }, null);
  assert.deepEqual(deps.library.search(wid, 'zebra', dm), []);
  assert.deepEqual(deps.library.search(wid, 'elswhere', dm), []);
});

test('TestSearch_MigratesAnOldIndexAndKeepsPlayerCopies', () => {
  const { deps, wid, dm, pl } = makeWorld();
  const L = deps.library;
  L.save(wid, { path: 'a', title: 'Shared page', body: 'Open words.\n\n> [!secret]\n> Hidden words.', visibility: 'party' }, null);
  L.save(wid, { path: 'b', title: 'DM page', body: 'Private words.', visibility: 'dm' }, null);
  // Put the database back the way an older version left it.
  deps.db.exec('DROP TABLE fts_dm; DROP TABLE fts_party; DROP TABLE page_names; DROP TABLE search_meta;');
  deps.db.exec('CREATE VIRTUAL TABLE fts_dm USING fts5(page_id UNINDEXED, world_id UNINDEXED, title, body);');
  deps.db.exec('CREATE VIRTUAL TABLE fts_party USING fts5(page_id UNINDEXED, world_id UNINDEXED, title, body);');
  deps.db.exec(`INSERT INTO fts_party SELECT id, world_id, title, body FROM pages`); // an old index that leaks
  ensureSearchIndex(deps.db);
  assert.ok(String(one<any>(deps.db, `SELECT sql FROM sqlite_master WHERE name = 'fts_dm'`)!.sql).includes('headings'));
  assert.equal(L.search(wid, 'private', dm)[0].title, 'DM page');
  assert.equal(L.search(wid, 'open', pl)[0].title, 'Shared page');
  assert.deepEqual(L.search(wid, 'private', pl), []);
  assert.deepEqual(L.search(wid, 'hidden', pl), [], 'rebuilt from the player copy, not the old index');
  // A second start with the right version does not rebuild.
  deps.db.exec(`DELETE FROM fts_dm`);
  ensureSearchIndex(deps.db);
  assert.deepEqual(L.search(wid, 'private', dm), []);
});

test('TestSearch_FastAt5000Pages', () => {
  const { deps, wid, dm, pl } = makeWorld();
  const L = deps.library;
  const words = 'harbor tavern guild merchant dragon river forest temple bridge castle market noble smith farmer sailor wizard priest bandit coast mountain village'.split(' ');
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = () => words[Math.floor(rnd() * words.length)];
  for (let i = 0; i < 5000; i++) {
    const body = Array.from({ length: 150 }, pick).join(' ') + ` unique${i}`;
    L.save(wid, { path: `gen/p${i}`, title: `${pick()} ${pick()} ${i}`, body: `# ${pick()}\n\n${body}`, visibility: i % 3 === 0 ? 'dm' : 'party', frontmatter: { aliases: [`alias${i}`] } }, null, { batch: true });
  }
  L.rebuildPlayerCopies(wid);
  const time = (q: string, v: any) => {
    const t0 = performance.now();
    const r = L.search(wid, q, v, 20);
    return { ms: performance.now() - t0, n: r.length };
  };
  for (const v of [dm, pl]) {
    for (const q of ['dragon', 'dragon river', 'drag', 'harbor tavern guild', '"river forest"', 'dragon -river', 'alias4321', 'unique77', 'dragn rivr', 'zzzzqx']) {
      time(q, v); // warm
      const best = Math.min(...[1, 2, 3].map(() => time(q, v).ms));
      assert.ok(best < 30, `"${q}" took ${best.toFixed(1)} ms`);
    }
  }
  assert.equal(L.search(wid, 'alias4321', pl).length, 1);
  assert.equal(L.search(wid, 'alias4320', pl).length, 0, 'a DM page (4320 is divisible by 3) is invisible to players');
  assert.equal(L.search(wid, 'alias4320', dm).length, 1);
  assert.equal(all(deps.db, 'SELECT 1 FROM fts_party').length, all(deps.db, `SELECT 1 FROM pages WHERE visibility = 'party'`).length);
});
