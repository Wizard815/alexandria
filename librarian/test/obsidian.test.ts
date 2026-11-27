// Obsidian sources beyond the vault folder: official Sync (a fake `ob`), the
// Local REST API plugin (a fake plugin) and Obsidian Publish (a fake site).
// Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/core/library.ts';
import { openDb, run } from '../src/core/db.ts';
import { runSync } from '../src/intake/sync.ts';
import { obsidianRest, obsidianRestWrite, obsidianSyncWrite, publishSiteInfo } from '../src/intake/connectors/obsidian.ts';
import { WriteRefused } from '../src/intake/connector.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-obsidian-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const player = { accountId: 'p', role: 'player' as const };
const gm = { accountId: 'a', role: 'gm' as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function world(kind: string, config: Record<string, unknown>) {
  const db = openDb(':memory:');
  run(db, `INSERT INTO worlds (id, slug, name, created_at) VALUES ('w', 'w', 'W', 'now')`);
  run(db, `INSERT INTO accounts (id, username, display_name, created_at) VALUES ('a', 'a', 'a', 'now')`);
  run(db, `INSERT INTO sources (id, world_id, kind, name, config, default_visibility) VALUES ('s', 'w', ?, 'S', ?, 'party')`, kind, JSON.stringify(config));
  return { db, lib: new Library(db, null) };
}

const TOWN = `---\nvisibility: party\ntags: [town]\n---\n# Port Town\n\nA busy harbour. [[Mira]] runs the inn.\n\n> [!secret]\n> SMUGGLERS use the old pier.\n\n%% GMNOTE remember the tide %%\n`;
const MIRA = `---\nvisibility: party\n---\nMira keeps the inn.\n`;
const PLOT = `# The plot\n\nPLOTTWIST the duke is a lich.\n`; // no visibility: stays the GM's

function leakCheck(lib: Library) {
  const titles = lib.list('w', player).map((p: any) => p.title).sort();
  assert.deepEqual(titles, ['Mira', 'Port Town'], 'only party pages reach players');
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const pl = JSON.stringify(lib.get('w', town.id, player));
  assert.ok(pl.includes('busy harbour'), 'players see the shared text');
  for (const w of ['SMUGGLERS', 'GMNOTE', 'PLOTTWIST']) assert.ok(!pl.includes(w), `a player never sees ${w}`);
  assert.ok(JSON.stringify(lib.get('w', town.id, gm)).includes('SMUGGLERS'), 'the GM sees the secret');
  assert.equal(lib.list('w', gm).length, 3);
}

// ---------- Local REST API plugin ----------

function fakeRest(files: Record<string, string>, key = 'k'.repeat(32)) {
  const calls: string[] = [];
  const f = (async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${decodeURIComponent(u.pathname)}`);
    if (init.headers?.Authorization !== `Bearer ${key}`) return json({ message: 'no' }, 401);
    if (u.pathname === '/') return json({ authenticated: true, versions: { obsidian: '1.9.0' } });
    const p = decodeURIComponent(u.pathname.replace(/^\/vault\/?/, ''));
    if (method === 'GET' && (p === '' || p.endsWith('/'))) {
      const pre = p;
      const names = new Set<string>();
      for (const k of Object.keys(files)) if (k.startsWith(pre)) { const rest = k.slice(pre.length); names.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest); }
      return names.size || pre === '' ? json({ files: [...names, '.obsidian/'] }) : json({ message: 'nf' }, 404);
    }
    if (method === 'GET') {
      if (!(p in files)) return json({ message: 'nf' }, 404);
      return json({ content: files[p], frontmatter: {}, path: p, stat: { mtime: Date.parse('2026-11-01T00:00:00Z'), ctime: 0, size: files[p].length }, tags: [] });
    }
    if (method === 'PUT') { files[p] = String(init.body); return new Response(null, { status: 204 }); }
    if (method === 'DELETE') { if (!(p in files)) return json({}, 404); delete files[p]; return new Response(null, { status: 204 }); }
    return json({}, 405);
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('TestObsidianRest_SyncsTheVaultAndKeepsSecretsFromPlayers', async () => {
  const files: Record<string, string> = { 'Places/Port Town.md': TOWN, 'People/Mira.md': MIRA, 'GM/The plot.md': PLOT, 'Places/map.png': 'x' };
  const { f, calls } = fakeRest(files);
  const { db, lib } = world('obsidian-rest', { url: 'http://127.0.0.1:27123', apiKey: 'k'.repeat(32), vaultName: 'Realm' });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: f, env: {}, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  assert.ok(!calls.some((c) => c.includes('.obsidian') || c.includes('map.png')), 'settings and non-notes are not read');
  leakCheck(lib);
  const town = lib.list('w', gm).find((p: any) => p.title === 'Port Town') as any;
  assert.ok(JSON.stringify(lib.get('w', town.id, gm)).includes('obsidian://'), 'the page opens in Obsidian');
});

test('TestObsidianRest_TestReportsABadKey', async () => {
  const { f } = fakeRest({});
  const ctx: any = { fetch: f, env: {}, signal: new AbortController().signal, log: () => {} };
  const bad = await obsidianRest.test({ url: 'http://127.0.0.1:27123', apiKey: 'wrong-key-123' }, ctx).catch((e) => ({ ok: false, message: e.message }));
  assert.equal(bad.ok, false);
  const good = await obsidianRest.test({ url: 'http://127.0.0.1:27123', apiKey: 'k'.repeat(32) }, ctx);
  assert.equal(good.ok, true, good.message);
});

test('TestObsidianRest_WorldLoreWritesStayInTheWorkspace', async () => {
  const files: Record<string, string> = { 'WorldLore/Old.md': '---\nvisibility: gm\n---\nOld text\n', 'Places/Port Town.md': TOWN };
  const { f } = fakeRest(files);
  const cfg = { url: 'http://127.0.0.1:27123', apiKey: 'k'.repeat(32) };
  const ctx: any = { fetch: f, env: {}, signal: new AbortController().signal, log: () => {} };
  const made = await obsidianRestWrite.createPage(cfg, ctx, { root: 'WorldLore', path: 'Factions/The Guild', title: 'The Guild', markdown: 'A guild.', level: 'party' } as any);
  assert.equal(made.externalId, 'WorldLore/Factions/The Guild.md');
  assert.match(files['WorldLore/Factions/The Guild.md'], /visibility: party[\s\S]*A guild\./);
  await obsidianRestWrite.updatePage(cfg, ctx, { root: 'WorldLore', id: 'WorldLore/Old.md', markdown: 'New text' } as any);
  assert.match(files['WorldLore/Old.md'], /visibility: gm[\s\S]*New text/, 'frontmatter kept on update');
  const moved = await obsidianRestWrite.movePage!(cfg, ctx, { root: 'WorldLore', id: 'WorldLore/Old.md', to: 'Archive/Old' } as any);
  assert.equal(moved.externalId, 'WorldLore/Archive/Old.md');
  assert.ok(!('WorldLore/Old.md' in files) && 'WorldLore/Archive/Old.md' in files);
  for (const bad of [
    () => obsidianRestWrite.updatePage(cfg, ctx, { root: 'WorldLore', id: 'Places/Port Town.md', markdown: 'x' } as any),
    () => obsidianRestWrite.deletePage!(cfg, ctx, { root: 'WorldLore', id: 'WorldLore/../Places/Port Town.md' } as any),
    () => obsidianRestWrite.createPage(cfg, ctx, { root: 'WorldLore', path: '../Places/Evil', title: 'x', markdown: 'x', level: 'gm' } as any),
    () => obsidianRestWrite.createPage(cfg, ctx, { root: 'WorldLore', path: '.obsidian/plugins', title: 'x', markdown: 'x', level: 'gm' } as any),
  ]) await assert.rejects(bad, WriteRefused);
  assert.equal(files['Places/Port Town.md'], TOWN, 'nothing outside the workspace changed');
});

// ---------- Obsidian Publish ----------

test('TestObsidianPublish_ReadsThePublishedNotes', async () => {
  const UID = 'abcdef0123456789abcdef0123456789';
  const notes: Record<string, string> = { 'Places/Port Town.md': TOWN, 'People/Mira.md': MIRA, 'The plot.md': PLOT };
  const seen: string[] = [];
  const f = (async (url: string) => {
    seen.push(url);
    if (url === 'https://publish.obsidian.md/realm') return new Response(`<html><script>window.siteInfo={"uid":"${UID}","host":"publish-01.obsidian.md","status":"active"};</script></html>`, { headers: { 'Content-Type': 'text/html' } });
    if (url === `https://publish-01.obsidian.md/cache/${UID}`) return json({ ...Object.fromEntries(Object.keys(notes).map((k) => [k, { hash: 'h' }])), 'img/a.png': {}, '../etc.md': {} });
    const m = new RegExp(`^https://publish-01\\.obsidian\\.md/access/${UID}/(.+)$`).exec(url);
    if (m) { const p = decodeURIComponent(m[1]); return p in notes ? new Response(notes[p]) : new Response('nf', { status: 404 }); }
    return new Response('nf', { status: 404 });
  }) as unknown as typeof fetch;
  const { db, lib } = world('obsidian-publish', { site: 'realm' });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: null, fetch: f, env: {}, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  assert.ok(!seen.some((u) => u.includes('etc.md') || u.includes('a.png')), 'bad paths and images are not read');
  // Published means public, so even the page without a visibility is shared; secret callouts and comments are still kept back.
  const titles = lib.list('w', player).map((p: any) => p.title).sort();
  assert.deepEqual(titles, ['Mira', 'Port Town', 'The plot']);
  const town = lib.list('w', player).find((p: any) => p.title === 'Port Town') as any;
  const pl = JSON.stringify(lib.get('w', town.id, player));
  assert.ok(!pl.includes('SMUGGLERS') && !pl.includes('GMNOTE'));
  assert.ok(JSON.stringify(lib.get('w', town.id, gm)).includes('https://publish.obsidian.md/realm/Places/Port%20Town'), 'opens on the site');
});

test('TestObsidianPublish_SiteInfoIsStrict', () => {
  assert.deepEqual(publishSiteInfo('siteInfo = {"uid":"0123456789abcdef","host":"publish-01.obsidian.md"};'), { uid: '0123456789abcdef', host: 'publish-01.obsidian.md' });
  assert.equal(publishSiteInfo('siteInfo = {"uid":"0123456789abcdef","host":"evil.example.com"};'), null, 'never another host');
  assert.equal(publishSiteInfo('<html>nothing</html>'), null);
});

// ---------- Obsidian Sync (headless client) ----------

/** A fake `ob`: logs its arguments, and `sync --path DIR` writes the "remote" vault into DIR. */
function fakeOb(remote: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(tmp, 'ob-'));
  const log = path.join(dir, 'calls.log');
  const src = path.join(dir, 'remote');
  for (const [k, v] of Object.entries(remote)) { fs.mkdirSync(path.dirname(path.join(src, k)), { recursive: true }); fs.writeFileSync(path.join(src, k), v); }
  const bin = path.join(dir, 'ob');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  sync-list-remote) echo "My Realm (id abc123)";;
  sync-status) [ -f "$3/.linked" ] || { echo "not configured" >&2; exit 1; };;
  sync-setup) touch "$5/.linked";;
  sync-config) ;;
  sync) if [ -f "$3/.pushme" ]; then cp -R "$3/WorldLore" "${src}/" 2>/dev/null; fi; cp -R "${src}/." "$3/";;
esac
`, { mode: 0o755 });
  return { bin, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n'), src };
}

test('TestObsidianSync_PullsTheVaultWithTheOfficialClient', async () => {
  const vaults = fs.mkdtempSync(path.join(tmp, 'vaults-'));
  const ob = fakeOb({ 'Places/Port Town.md': TOWN, 'People/Mira.md': MIRA, 'The plot.md': PLOT });
  const { db, lib } = world('obsidian-sync', { vault: 'My Realm', folder: 'realm', e2eePassword: 'hunter22' });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: vaults, fetch: fetch, env: { ALX_OBSIDIAN_BIN: ob.bin }, mcp: null as any }, 's', 'a');
  assert.equal(out.status, 'ok', out.error);
  const calls = ob.calls();
  const dir = path.join(vaults, 'realm');
  assert.ok(calls.includes(`sync-setup --vault My Realm --path ${dir} --device-name Alexandria --password hunter22`), calls.join('\n'));
  assert.ok(calls.includes(`sync-config --path ${dir} --mode pull-only`), 'pull-only unless two-way is on');
  assert.ok(!JSON.stringify(out).includes('hunter22'), 'the password is not in the sync result');
  leakCheck(lib);
  // The second run is already linked: no setup again.
  await runSync({ db, library: lib, dataDir: null, vaultsDir: vaults, fetch: fetch, env: { ALX_OBSIDIAN_BIN: ob.bin }, mcp: null as any }, 's', 'a');
  assert.equal(ob.calls().filter((c) => c.startsWith('sync-setup')).length, 1);
});

test('TestObsidianSync_WorldLoreWritesOnlyInTwoWayMode', async () => {
  const vaults = fs.mkdtempSync(path.join(tmp, 'vaults-'));
  fs.mkdirSync(path.join(vaults, 'realm', 'WorldLore'), { recursive: true });
  const ob = fakeOb({});
  const ctx: any = { env: { ALX_OBSIDIAN_BIN: ob.bin }, vaultsDir: vaults, signal: new AbortController().signal, log: () => {} };
  const a = { root: 'WorldLore', path: 'Guild', title: 'Guild', markdown: 'A guild.', level: 'gm' } as any;
  await assert.rejects(() => obsidianSyncWrite.createPage({ folder: 'realm' }, ctx, a), WriteRefused);
  const made = await obsidianSyncWrite.createPage({ folder: 'realm', twoWay: true }, ctx, a);
  assert.equal(made.externalId, 'WorldLore/Guild.md');
  assert.ok(fs.existsSync(path.join(vaults, 'realm', 'WorldLore', 'Guild.md')));
  assert.ok(ob.calls().some((c) => c === `sync --path ${path.join(vaults, 'realm')}`), 'ob sync sends the change');
});

test('TestObsidianSync_MissingClientSaysHowToInstall', async () => {
  const vaults = fs.mkdtempSync(path.join(tmp, 'vaults-'));
  const { db, lib } = world('obsidian-sync', { vault: 'My Realm', folder: 'realm' });
  const out = await runSync({ db, library: lib, dataDir: null, vaultsDir: vaults, fetch: fetch, env: { ALX_OBSIDIAN_BIN: path.join(tmp, 'no-such-ob') }, mcp: null as any }, 's', 'a');
  assert.notEqual(out.status, 'ok');
  assert.match(String(out.error), /obsidian-headless/);
});
