// The universal intake: page model, Markdown parsing, connectors, sync jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { markdownToBlocks, blocksToMarkdown } from '../src/intake/model.ts';
import { playerBlocks, playerProperties } from '../src/intake/player.ts';
import { frontmatterGroups, markdownEntry } from '../src/intake/connectors/markdown.ts';
import { genericApi, pick } from '../src/intake/connectors/api.ts';

test('TestIntake_MarkdownToBlocks', () => {
  const b = markdownToBlocks('# Title\n\nHello **bold** [[Odda|her]] and [link](https://x.y).\n\n> [!note] Heads up\n> Mind the gap\n\n> [!secret] DM\n> The twist\n\n- [x] done\n- open\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
  assert.deepEqual(b.map((x) => x.kind), ['heading', 'paragraph', 'callout', 'secret', 'bulletList', 'table']);
  const p = b[1] as any;
  assert.ok(p.content.some((x: any) => x.bold && x.text === 'bold'));
  assert.ok(p.content.some((x: any) => x.mention?.name === 'Odda' && x.mention.text === 'her'));
  assert.ok(p.content.some((x: any) => x.link === 'https://x.y'));
  assert.equal((b[2] as any).variant, 'note');
  const pl = playerBlocks(b, () => false);
  assert.ok(!JSON.stringify(pl).includes('twist'), 'secret callout removed');
  assert.ok(JSON.stringify(pl).includes('Mind the gap'), 'normal callouts stay');
  assert.ok(blocksToMarkdown(b).includes('| 1 | 2 |'));
});

test('TestIntake_PlayerBlocksFailClosed', () => {
  const pl = playerBlocks([
    { kind: 'heading', level: 2, content: [{ text: 'DM — plans' }] },
    { kind: 'paragraph', content: [{ text: 'hidden under DM heading' }] },
    { kind: 'heading', level: 2, content: [{ text: 'Open' }] },
    { kind: 'callout', variant: 'gm', children: [{ kind: 'paragraph', content: [{ text: 'gm only' }] }] },
    { kind: 'unsupported', sourceKind: 'widget' },
    { kind: 'paragraph', content: [{ mention: { ref: 'x', name: 'Secret Cult' } }, { text: ' and ' }, { mention: { ref: 'y', name: 'Okiku', text: 'the mother' } }] },
  ] as any, (m) => m.ref === 'x' || m.ref === 'y');
  const s = JSON.stringify(pl);
  for (const leak of ['hidden under', 'gm only', 'widget', 'Secret Cult', 'Okiku']) assert.ok(!s.includes(leak), leak);
  assert.ok(s.includes('(hidden)') && s.includes('the mother'), 'a link keeps its own words, never the hidden title');
  assert.deepEqual(playerProperties([{ title: 'Facts', rows: [{ key: 'Age', value: [{ text: '40' }] }, { key: 'dm notes', value: [{ text: 'x' }] }] }, { title: 'Secret', rows: [{ key: 'a', value: [{ text: 'b' }] }] }], () => false),
    [{ title: 'Facts', rows: [{ key: 'Age', value: [{ text: '40' }] }] }]);
});

test('TestIntake_FrontmatterBecomesFacts', () => {
  const g = frontmatterGroups({ age: 40, home: '[[Nanyo]]', tags: ['x'], secret: { lover: 'Tamsin' } } as any);
  assert.equal(g[0].title, 'Facts');
  assert.deepEqual(g[0].rows.map((r) => r.key), ['age', 'home']);
  assert.ok(g[1].dm, 'secret: map is a DM-only group');
  const e = markdownEntry('people/Han.md', '---\nvisibility: party\nknowledge: deep\naliases: [Mikey]\n---\n# Han\nA druid. #pc', 'dm');
  assert.equal(e.visibility, 'party');
  assert.equal(e.knowledge, 'deep');
  assert.deepEqual(e.aliases, ['Mikey']);
  assert.ok(e.tags!.includes('pc'));
  assert.equal(markdownEntry('a.md', 'no frontmatter', 'dm').visibility, 'dm');
});

test('TestIntake_GenericApiConnectorMapsAndFailsClosed', async () => {
  assert.equal(pick({ a: { b: [{ c: 5 }] } }, 'a.b.0.c'), 5);
  const pagesServed: string[] = [];
  const fakeFetch = (async (url: string) => {
    pagesServed.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const items = page === 1 ? [{ id: 1, name: 'Shared', html: '<p>Hi <b>there</b></p>', private: false, tags: ['t'] }, { id: 2, name: 'Private', html: 'no', private: true }, { id: 3, name: 'No flag', html: 'x' }] : [];
    return new Response(JSON.stringify({ data: items }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const cfg = { transport: 'http', url: 'https://api.example.com/items', paging: 'page', itemsPath: 'data', idField: 'id', titleField: 'name', bodyField: 'html', bodyFormat: 'html', tagsField: 'tags', visibilityField: 'private', sharedValues: 'false' };
  genericApi.validate(cfg, { vaultsDir: null, env: {} });
  const ctx: any = { fetch: fakeFetch, env: {}, signal: new AbortController().signal, log: () => {}, shareVisible: true, mcp: () => { throw new Error('no'); } };
  const got = [];
  for await (const e of genericApi.sync(cfg, ctx)) got.push(e);
  assert.equal(pagesServed.length, 2, 'stops at the empty page');
  assert.deepEqual(got.map((e) => [e.title, e.visibility]), [['Shared', 'party'], ['Private', 'dm'], ['No flag', 'dm']]);
  assert.ok(got[0].blocks.some((b: any) => b.kind === 'paragraph'));
  assert.deepEqual(got[0].tags, ['t']);
});

test('TestIntake_AdminConnectorsTestAndBackgroundSync', async () => {
  const { app } = createApp({ env: {}, noScheduler: true, fetch: (async () => new Response(JSON.stringify([{ id: 'a', title: 'Alpha', body: '# Alpha\nText', vis: 'public' }]), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    const a = (await call('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).body;
    const list = (await call('GET', '/api/admin/connectors', a.token)).body;
    assert.ok(['legendkeeper-mcp', 'legendkeeper-api', 'kanka-api', 'kanka-mcp', 'markdown-folder', 'git', 'mcp-files', 'api'].every((k) => list.some((c: any) => c.id === k)));
    const cfg = { transport: 'http', url: 'https://api.example.com/x', idField: 'id', titleField: 'title', bodyField: 'body', visibilityField: 'vis', sharedValues: 'public' };
    const t = (await call('POST', '/api/admin/sources/test', a.token, { kind: 'api', config: cfg })).body;
    assert.equal(t.ok, true, t.message);
    assert.equal((await call('POST', '/api/admin/sources/test', a.token, { kind: 'api', config: { url: 'ftp://nope' } })).status, 400);
    const w = (await call('POST', '/api/admin/worlds', a.token, { name: 'W', dmAccountId: a.account.id })).body;
    const src = (await call('POST', `/api/admin/worlds/${w.id}/sources`, a.token, { kind: 'api', name: 'Wiki', config: { ...cfg, token: 'secret-token-123' }, defaultVisibility: 'party' })).body;
    assert.equal(src.config.token, '••••');
    const started = await call('POST', `/api/admin/sources/${src.id}/sync`, a.token);
    assert.equal(started.status, 202);
    let runs: any[] = [];
    for (let i = 0; i < 50; i++) {
      runs = (await call('GET', `/api/admin/sources/${src.id}/runs`, a.token)).body;
      if (runs[0]?.status && runs[0].status !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(runs[0].status, 'ok');
    assert.equal(runs[0].stats.pages, 1);
    const log = (await call('GET', `/api/admin/runs/${runs[0].id}`, a.token)).body.log;
    assert.ok(log.includes('Saved 1 pages'));
    const pages = (await call('GET', `/api/worlds/${w.id}/library/pages`, a.token)).body;
    assert.equal(pages[0].title, 'Alpha');
    assert.equal(pages[0].source, 'Wiki');
    // Secrets are kept when the panel sends the masked value back.
    const upd = (await call('PATCH', `/api/admin/sources/${src.id}`, a.token, { config: { ...cfg, token: '••••' }, scheduleMinutes: 60 })).body;
    assert.equal(upd.schedule_minutes, 60);
  } finally {
    server.close();
  }
});
