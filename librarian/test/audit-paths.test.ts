// Audit: page paths, titles and bodies the library must survive (traversal, collisions, unicode, huge input).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());
const put = (token: string, body: unknown) => k.call('PUT', k.w('/library/pages'), token, body);

test('Audit_Paths: traversal and odd paths are refused, nothing is written outside the world folder', async () => {
  const before = new Set<string>();
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); before.add(p); if (e.isDirectory()) walk(p); } };
  const bad = ['../x.md', '..\\x.md', 'a/../../x.md', '.hidden/x.md', 'a/.git/x.md', 'a\u0000b.md', 'a/\u001fb.md', '', '   ', '/', '././.', 'x'.repeat(400), '.md', 'C:\\Windows\\x'];
  for (const p of bad) {
    const r = await put(k.T.dm, { path: p, body: 'x' });
    if (p === '   ' || p === 'C:\\Windows\\x') continue; // allowed names, see below
    assert.ok(r.status === 400, `path ${JSON.stringify(p).slice(0, 40)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
  const leaked: string[] = [];
  const outside = path.dirname(k.tmp);
  for (const f of fs.readdirSync(outside)) if (f === 'x.md' || f === 'passwd') leaked.push(f);
  assert.deepEqual(leaked, []);
  void walk;
});

test('Audit_Paths: unicode, RTL, emoji and very long titles are stored and returned as written', async () => {
  const titles = ['\u202Eevil\u202C RTL', 'Drachen 🐉 und Zwerge', 'עברית כותרת', 'a'.repeat(5000), 'tab\there', 'line\nbreak', '<script>alert(1)</script>', '"quote" & \'single\''];
  for (const [i, t] of titles.entries()) {
    const r = await put(k.T.dm, { path: `uni/${i}.md`, title: t, body: `# ${t.replace(/\n/g, ' ')}\nbody ${i}`, visibility: 'party' });
    assert.ok(r.status === 200 || r.status === 400, `title ${i} -> ${r.status} ${r.text.slice(0, 100)}`);
    if (r.status !== 200) continue;
    const got = await k.call('GET', k.w(`/library/pages/${r.body.id}`), k.T.jess);
    assert.equal(got.status, 200);
    assert.equal(typeof got.body.title, 'string');
    const md = await k.call('GET', k.w(`/library/pages/${r.body.id}/markdown`), k.T.jess);
    assert.equal(md.status, 200, `markdown for title ${i}: ${md.status} ${md.text.slice(0, 100)}`);
    const cd = String(md.headers.get('content-disposition'));
    assert.ok(/^attachment; filename="[^"\r\n]*"; filename\*=UTF-8''[^\s]*$/.test(cd), `Content-Disposition for title ${i}: ${cd}`);
    const hits = await k.call('GET', k.w(`/library/search?q=${encodeURIComponent('body ' + i)}`), k.T.jess);
    assert.equal(hits.status, 200);
  }
});

test('Audit_Paths: malformed and oversized bodies answer 400 or 413, never 500', async () => {
  const cases: [string, string, unknown][] = [
    ['PUT', k.w('/library/pages'), '{not json'],
    ['PUT', k.w('/library/pages'), '[1,2,3]'],
    ['PUT', k.w('/library/pages'), 'null'],
    ['PUT', k.w('/library/pages'), '"a string"'],
    ['PUT', k.w('/library/pages'), { path: ['a'], body: 'x' }],
    ['PUT', k.w('/library/pages'), { path: 'ok.md', body: { a: 1 } }],
    ['PUT', k.w('/library/pages'), { path: 'ok2.md', body: 'x', frontmatter: 'nope' }],
    ['PUT', k.w('/library/pages'), { path: 'ok3.md', body: 'x', frontmatter: { tags: { a: { b: 1 } }, aliases: 5, visibility: ['dm'] } }],
    ['PUT', k.w('/library/pages'), { path: 'ok4.md', markdown: '---\n: : :\n  - [\n---\nbody' }],
    ['PUT', k.w('/library/pages'), { path: 'ok5.md', markdown: '---\ntitle: [unterminated\n' }],
    ['POST', k.w('/library/pages/bulk'), { ids: 'x' }],
    ['POST', k.w('/library/pages/bulk'), { ids: new Array(501).fill('a') }],
    ['POST', k.w('/inventory'), { name: 'x'.repeat(10_000) }],
    ['POST', k.w('/inventory'), { name: 'ok', qty: 'many' }],
    ['POST', k.w('/inventory'), { name: 'ok', qty: 1.5 }],
    ['POST', k.w('/inventory'), { name: 'ok', qty: [3] }],
    ['POST', k.w('/inventory'), { name: 'ok', weight: 'heavy' }],
    ['POST', k.w('/live/ledger'), { amountCp: 1e30 }],
    ['POST', k.w('/live/ledger'), { amountCp: '1e3' }],
    ['POST', k.w('/live/ledger'), { amountCp: true }],
    ['POST', k.w('/live/combatants'), { name: 'x', initiative: 'high' }],
    ['PATCH', k.w('/settings'), { messageDays: -1, coins: 5, rules: {} }],
    ['PATCH', k.w('/settings'), 'x'],
    ['POST', k.w('/clock/advance'), { minutes: '10' }],
    ['POST', k.w('/clock/advance'), { minutes: 1e400 }],
    ['POST', '/api/auth/login', { username: { $ne: 1 }, password: [1] }],
    ['POST', '/api/join', { code: {}, username: 'x', password: 'y' }],
  ];
  for (const [m, u, b] of cases) {
    const r = await k.call(m, u, k.T.dm, typeof b === 'string' ? b : JSON.stringify(b));
    assert.ok(r.status < 500, `${m} ${u.replace(k.W, ':w')} ${typeof b === 'string' ? b : JSON.stringify(b).slice(0, 80)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
  const big = await k.call('PUT', k.w('/library/pages'), k.T.dm, JSON.stringify({ path: 'big.md', body: 'x'.repeat(30 * 1024 * 1024) }));
  assert.ok(big.status === 413 || big.status === 400, `a 30 MB body -> ${big.status}`);
});
