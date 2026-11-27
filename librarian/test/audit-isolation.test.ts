// Audit: world isolation. Every route of world A is called, as A's GM, as an A player and with an A GM write key,
// with every kind of id that belongs to world B (path parameters and body fields). World B must not change and
// nothing of B's may come back. (docs/SECURITY.md: "a person in one world gets nothing from another".)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recordMounts, listRoutes } from './security-kit.ts';
import { all } from '../src/core/db.ts';

recordMounts();
const { boot } = await import('./audit-kit.ts');
const k = await boot();
after(() => k.close());

const MARK = 'ZZBMARK' + Math.random().toString(36).slice(2, 8);

async function seedB() {
  const dm = (m: string, u: string, b?: unknown) => k.call(m, k.w2(u), k.T.dm2, b);
  await dm('PUT', '/library/pages', { path: 'secret/B Page.md', visibility: 'dm', body: `# B ${MARK}\nThe B page ${MARK}` });
  await dm('PUT', '/library/pages', { path: 'pub/B Public.md', visibility: 'party', body: `# BP ${MARK}\nThe B public ${MARK}` });
  await dm('POST', '/inventory', { owner: k.ID.wendy, name: `B item ${MARK}`, qty: 2, dmNote: MARK, note: MARK, reason: 'because' });
  await dm('POST', '/inventory', { owner: 'party', name: `B stash ${MARK}`, qty: 3, reason: 'x' });
  await dm('POST', '/live/ledger', { owner: 'party', amountCp: 5000, note: MARK });
  await dm('POST', '/live/ledger', { owner: k.ID.wendy, amountCp: 5000, note: MARK });
  await dm('POST', '/live/combatants', { name: `B orc ${MARK}`, initiative: 12, hp: 20, maxHp: 20, hidden: true });
  await dm('POST', '/people', { name: `B person ${MARK}`, note: MARK, visibility: 'dm' });
  await dm('POST', '/broker/notes', { topic: MARK, text: MARK, note: MARK });
  await dm('POST', '/calendar', { title: `B session ${MARK}`, startsAt: '2030-01-01T18:00:00Z', endsAt: '2030-01-01T20:00:00Z' });
  await dm('POST', '/messages', { members: [k.ID.wendy], title: MARK, text: MARK, body: MARK });
  await dm('POST', '/stage/cards', { kind: 'text', title: MARK, text: MARK });
  await dm('POST', '/quick-events', { kind: 'save', prompt: MARK, title: MARK, dc: 12, success: MARK, fail: MARK });
  await dm('POST', '/clock/events', { title: MARK, start: 100 });
  await dm('POST', '/actions/macros', { name: MARK, steps: [{ action: 'combat.start' }] });
  await dm('POST', '/sessionlog/drafts', { title: MARK });
  await dm('POST', '/whiteboard/wipe', { confirm: true });
  await dm('POST', '/sound/scenes', { name: MARK });
  await k.call('POST', k.w2('/requests'), k.T.wendy, { text: MARK });
  await k.call('POST', k.w2('/inventory'), k.T.wendy, { name: `wendy pending ${MARK}`, qty: 1 });
}

function bIds(): { ids: string[]; tables: string[] } {
  const ids = new Set<string>();
  const tables: string[] = [];
  for (const t of all<{ name: string }>(k.deps.db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'")) {
    let cols: string[];
    try { cols = all<{ name: string }>(k.deps.db, `PRAGMA table_info(${t.name})`).map((c) => c.name); } catch { continue; }
    if (!cols.includes('world_id')) continue;
    tables.push(t.name);
    for (const r of all<any>(k.deps.db, `SELECT * FROM ${t.name} WHERE world_id = ?`, k.W2)) {
      for (const c of ['id', 'path', 'item_id', 'thread_id', 'page_id', 'session_id']) if (typeof r[c] === 'string' && r[c]) ids.add(r[c]);
    }
  }
  ids.add(k.W2);
  ids.add(k.ID.wendy);
  ids.add(k.ID.dm2);
  return { ids: [...ids], tables };
}

function snapshotB(tables: string[]) {
  const out: Record<string, string> = {};
  for (const t of tables) {
    if (['audit', 'presence'].includes(t)) continue;
    const rows = all<any>(k.deps.db, `SELECT * FROM ${t} WHERE world_id = ?`, k.W2);
    out[t] = createHash('sha1').update(JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))).digest('hex');
  }
  return out;
}

const SKIP = [/\/events$/, /\/audio\/sessions\/:sid\/chunks$/, /\/sound\/upload$/, /\/sound\/spotify/, /\/modules\/import/, /\/inventory\/images$/, /\/stage\/images$/, /\/search\/reindex$/, /\/lights\/drivers\/:id\/(pair|test)$/, /\/crawl|\/sync$/];

test('Audit_Isolation: ids from world B do nothing and show nothing in world A routes', async () => {
  await seedB();
  const { ids, tables } = bIds();
  assert.ok(ids.length > 20, `B has ${ids.length} ids`);
  const before = snapshotB(tables);
  const routes = listRoutes(k.app).filter((r) => r.path.startsWith('/api/worlds/:world/') && !SKIP.some((x) => x.test(r.path)));
  const dmWrite = (await k.ok('POST', '/api/keys', k.T.dm, { scope: 'scribe', worldId: k.W, label: 'w', access: 'write' })).key as string;
  const body: Record<string, unknown> = {};
  const leaks: string[] = [];
  const mutated: string[] = [];
  const odd: string[] = [];
  const pick = ids.filter((_, i) => i % 3 === 0 || i < 40);
  for (const tokenName of ['dm', 'jess', 'key']) {
    const token = tokenName === 'key' ? dmWrite : k.T[tokenName];
    for (const r of routes) {
      const params = r.path.match(/:[A-Za-z]+/g) ?? [];
      const rest = params.filter((p) => p !== ':world');
      const tries = rest.length ? pick : [''];
      for (const idv of tries) {
        let url = r.path.replace(':world', k.W);
        for (const p of rest) url = url.replace(p, encodeURIComponent(idv));
        for (const key of ['id', 'pageId', 'itemId', 'item', 'page', 'to', 'from', 'owner', 'accountId', 'offerId', 'sourceId', 'threadId', 'mapId', 'sessionId', 'cardId', 'eventId']) body[key] = idv || k.ID.wendy;
        const res = await k.call(r.method, url, token, r.method === 'GET' ? undefined : body);
        if (res.status >= 500 && res.status !== 503) odd.push(`${tokenName} ${r.method} ${url} -> ${res.status} ${res.text.slice(0, 100)}`);
        if (res.text.includes(MARK)) leaks.push(`${tokenName} ${r.method} ${url} -> ${res.status} ${res.text.slice(0, 160)}`);
      }
      const after = snapshotB(tables);
      for (const t of Object.keys(after)) if (after[t] !== before[t]) { mutated.push(`${tokenName} ${r.method} ${r.path}: ${t}`); before[t] = after[t]; }
    }
  }
  console.log('5xx', odd.length, odd.slice(0, 20).join('\n'));
  assert.deepEqual(leaks.slice(0, 20), [], 'world B content came back in world A');
  assert.deepEqual(mutated.slice(0, 20), [], 'world B changed');
});
