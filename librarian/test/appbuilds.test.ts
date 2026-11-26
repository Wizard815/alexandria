// App builds hosted by the server (features/appbuilds): the public info, the signed-in list,
// download tickets, fetching the latest GitHub release, and version order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { compareVersions, platformOf, versionIn } from '../src/features/appbuilds/index.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
let apps = '';
const fakeFetch: { release: any; files: Record<string, string>; calls: string[] } = { release: null, files: {}, calls: [] };

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try { json = JSON.parse(buf.toString()); } catch { json = null; }
  return { status: r.status, body: json, buf, headers: r.headers };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.buf.toString().slice(0, 200)}`);
  return r.body;
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-appbuilds-'));
  apps = path.join(tmp, 'data', 'apps');
  const realFetch = fetch;
  const fake = (async (url: any, init?: any) => {
    const u = String(url);
    if (!u.startsWith('https://')) return realFetch(url, init);
    fakeFetch.calls.push(u);
    if (u.endsWith('/releases/latest')) return new Response(JSON.stringify(fakeFetch.release), { status: fakeFetch.release ? 200 : 404 });
    const name = u.split('/').pop()!;
    if (name in fakeFetch.files) return new Response(fakeFetch.files[name], { status: 200 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fake, env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  await ok('POST', '/api/admin/accounts', T.admin, { username: 'pat', password: 'player pass 123' });
  T.pat = (await ok('POST', '/api/auth/login', undefined, { username: 'pat', password: 'player pass 123' })).token;
});
after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AppBuilds_versions: names, platforms and semver order', () => {
  assert.equal(versionIn('Alexandria-AlphaV1-0.2.0-alpha.3-android.apk'), '0.2.0-alpha.3');
  assert.equal(versionIn('Alexandria-1.4.2-windows-x64-setup.exe'), '1.4.2');
  assert.equal(versionIn('Alexandria-AlphaV1-android.apk'), null);
  assert.deepEqual(platformOf('Alexandria-AlphaV1-macos-universal.dmg'), { platform: 'macos', arch: 'universal' });
  assert.equal(platformOf('Alexandria-AlphaV1-linux-x86_64.tar.gz')?.platform, 'linux');
  assert.equal(platformOf('notes.txt'), null);
  const sorted = ['1.0.0', '0.1.0-alpha.1', '0.1.0', '0.1.0-alpha.10', '0.1.0-alpha.2', '0.1.0-beta'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0', '1.0.0']);
  assert.equal(compareVersions(null, '0.0.1'), -1);
});

test('AppBuilds_public: GitHub link when nothing is hosted, overridable', async () => {
  const a = await ok('GET', '/api/apps');
  assert.match(a.downloads, /^https:\/\/github\.com\/.+\/releases\/latest$/);
  assert.equal(a.hosted, false);
  assert.ok(a.version && a.release);
  deps.env.ALX_APP_DOWNLOADS = 'https://files.example.com/alexandria/';
  assert.equal((await ok('GET', '/api/apps')).downloads, 'https://files.example.com/alexandria/');
  deps.env.ALX_APP_DOWNLOADS = 'javascript:alert(1)';
  assert.match((await ok('GET', '/api/apps')).downloads, /^https:\/\/github\.com/);
  delete deps.env.ALX_APP_DOWNLOADS;
});

test('AppBuilds_download: signed in only, through a ticket for that one file', async () => {
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(path.join(apps, 'Alexandria-AlphaV1-0.1.0-android.apk'), 'old apk');
  fs.writeFileSync(path.join(apps, 'Alexandria-AlphaV1-0.2.0-android.apk'), 'new apk');
  fs.writeFileSync(path.join(apps, 'Alexandria-AlphaV1-0.2.0-windows-x64-setup.exe'), 'setup');
  fs.writeFileSync(path.join(apps, 'secrets.txt'), 'not a build');

  assert.equal((await call('GET', '/api/apps/builds')).status, 401);
  const list = await ok('GET', '/api/apps/builds', T.pat);
  assert.deepEqual(list.builds.map((b: any) => b.file), ['Alexandria-AlphaV1-0.2.0-android.apk', 'Alexandria-AlphaV1-0.1.0-android.apk', 'Alexandria-AlphaV1-0.2.0-windows-x64-setup.exe']);
  assert.equal(list.latest.android.version, '0.2.0');
  assert.equal(list.latest.android.sha256, sha('new apk'));
  assert.equal((await ok('GET', '/api/apps')).hosted, true);

  assert.equal((await call('POST', '/api/apps/builds/secrets.txt/ticket', T.pat)).status, 404);
  assert.equal((await call('POST', '/api/apps/builds/..%2Fsecrets.txt/ticket', T.pat)).status, 404);
  const t = await ok('POST', '/api/apps/builds/Alexandria-AlphaV1-0.2.0-android.apk/ticket', T.pat);
  assert.equal(t.sha256, sha('new apk'));
  const got = await call('GET', t.url);
  assert.equal(got.status, 200);
  assert.equal(got.buf.toString(), 'new apk');
  assert.equal(got.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(got.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal((await call('GET', '/api/apps/file/Alexandria-AlphaV1-0.2.0-windows-x64-setup.exe?t=' + t.ticket)).status, 401, 'a ticket opens only its own file');
  assert.equal((await call('GET', '/api/apps/file/Alexandria-AlphaV1-0.2.0-android.apk')).status, 401, 'no ticket, no file');
  assert.equal((await call('GET', '/api/apps/file/Alexandria-AlphaV1-0.2.0-android.apk?t=nope')).status, 401);

  const key = await ok('POST', '/api/keys', T.admin, { scope: 'admin', label: 'k' });
  assert.equal((await call('POST', '/api/apps/builds/Alexandria-AlphaV1-0.2.0-android.apk/ticket', key.key)).status, 403, 'keys make no download links');
});

test('AppBuilds_fetch: the latest GitHub release replaces older builds', async () => {
  fakeFetch.release = {
    tag_name: 'v0.3.0-alpha.1', name: 'Alexandria BetaV2',
    assets: [
      { name: 'Alexandria-BetaV2-android.apk', size: 9, browser_download_url: 'https://github.com/x/releases/download/v0.3.0-alpha.1/Alexandria-BetaV2-android.apk' },
      { name: 'Alexandria-BetaV2-linux-x86_64.tar.gz', size: 7, browser_download_url: 'https://github.com/x/releases/download/v0.3.0-alpha.1/Alexandria-BetaV2-linux-x86_64.tar.gz' },
      { name: 'checksums.txt', size: 1, browser_download_url: 'https://github.com/x/checksums.txt' },
    ],
  };
  fakeFetch.files = { 'Alexandria-BetaV2-android.apk': 'apk v0.3', 'Alexandria-BetaV2-linux-x86_64.tar.gz': 'tarball' };
  assert.equal((await call('POST', '/api/admin/apps/fetch', T.pat)).status, 403);
  const started = await call('POST', '/api/admin/apps/fetch', T.admin);
  assert.equal(started.status, 202);
  let st: any;
  for (let i = 0; i < 50; i++) { st = await ok('GET', '/api/admin/apps', T.admin); if (!st.fetch.running) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(st.fetch.error, null);
  assert.deepEqual(st.fetch.files.sort(), ['Alexandria-BetaV2-android.apk', 'Alexandria-BetaV2-linux-x86_64.tar.gz']);
  assert.ok(!fakeFetch.calls.some((u) => u.endsWith('checksums.txt')), 'only app files are copied');
  const list = await ok('GET', '/api/apps/builds', T.pat);
  assert.deepEqual(list.builds.filter((b: any) => b.platform === 'android').map((b: any) => b.file), ['Alexandria-BetaV2-android.apk'], 'older APKs are replaced');
  assert.equal(list.latest.android.version, '0.3.0-alpha.1', 'the version comes from the release tag');
  assert.equal(list.latest.android.release, 'BetaV2');
  assert.equal(list.latest.windows.file, 'Alexandria-AlphaV1-0.2.0-windows-x64-setup.exe', 'a platform the release lacks keeps its build');

  assert.equal((await call('DELETE', '/api/admin/apps/Alexandria-BetaV2-linux-x86_64.tar.gz', T.admin)).status, 200);
  assert.ok(!fs.existsSync(path.join(apps, 'Alexandria-BetaV2-linux-x86_64.tar.gz')));

  fakeFetch.release = null;
  await ok('POST', '/api/admin/apps/fetch', T.admin);
  for (let i = 0; i < 50; i++) { st = await ok('GET', '/api/admin/apps', T.admin); if (!st.fetch.running) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.match(st.fetch.error, /GitHub answered 404/);
});
