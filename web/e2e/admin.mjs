// End-to-end test of the library admin: the seeded demo (fake models, answering like Argos), the built app and Chromium.
// Opens every admin page at desktop and phone width (no console errors, no sideways scroll), checks the old addresses
// redirect to their tab, the menu's find-a-page filter, and the Models → Game night flow: start, models held, end,
// unload. Run from web/: npm run build && node e2e/admin.mjs   (ADMIN_E2E_PORT picks the port, default 8187)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = Number(process.env.ADMIN_E2E_PORT || 8187);
const base = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-admin-e2e-'));
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); else note('ok: ' + msg); return ok; };

const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'librarian/scripts/demo.ts', '--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], {
  cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write('[demo] ' + d); });
for (let i = 0; i < 150 && !out.includes('Alexandria demo is running'); i++) await new Promise((r) => setTimeout(r, 200));
if (!out.includes('Alexandria demo is running')) { console.log(out); srv.kill(); console.log('demo did not start'); process.exit(1); }

const ROUTES = ['', 'worlds', 'accounts', 'library', 'sources', 'models', 'keys', 'access', 'audit', 'search', 'integrations',
  'sources?tab=worlds', 'sources?tab=keys', 'sources?tab=files', 'access?tab=permissions', 'access?tab=security', 'search?tab=mirror',
  'models?tab=session', 'models?tab=memory', 'models?tab=embeddings'];
const REDIRECTS = { connections: 'sources?tab=connections', 'source-keys': 'sources?tab=keys', 'source-files': 'sources?tab=files', permissions: 'access?tab=permissions', security: 'access?tab=security', mirror: 'search?tab=mirror' };

const browser = await chromium.launch();
const quiet = (t) => /Failed to load resource.*(40[1349]|5\d\d)|fonts\.g|net::ERR_|ResizeObserver/.test(t);
async function signIn(viewport, mobile, who) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
  await page.goto(base + '/admin/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('library admin 123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.startsWith('/admin/login'), { timeout: 15000 });
  return { ctx, page };
}
const api = async (page, method, p, body) => page.evaluate(async ([m, url, b]) => {
  const tok = (() => { try { return JSON.parse(localStorage.getItem('alx.admin.token') ?? 'null'); } catch { return localStorage.getItem('alx.admin.token'); } })();
  const r = await fetch(url, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  return r.json();
}, [method, p, body]);

try {
  for (const [label, viewport, mobile] of [['desktop', { width: 1280, height: 900 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const { ctx, page } = await signIn(viewport, mobile, `admin (${label})`);
    for (const r of ROUTES) {
      await page.goto(`${base}/admin/${r}`);
      await page.locator('main').waitFor();
      await page.waitForTimeout(600);
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      if (wide > 1) problems.push(`${label}: /admin/${r} scrolls sideways by ${wide}px`);
      const h1 = await page.locator('main h1').first().textContent().catch(() => '');
      if (!h1?.trim()) problems.push(`${label}: /admin/${r} has no page heading`);
    }
    note(`${label}: opened ${ROUTES.length} admin pages`);
    if (label === 'desktop') {
      for (const [from, to] of Object.entries(REDIRECTS)) {
        await page.goto(`${base}/admin/${from}`);
        await page.waitForTimeout(300);
        const u = new URL(page.url());
        check(`${u.pathname.slice('/admin/'.length)}${u.search}` === to, `/admin/${from} redirects to /admin/${to}`);
      }
      // The menu's find-a-page filter.
      await page.goto(`${base}/admin/`);
      await page.getByTestId('menu-find').fill('models');
      await page.getByTestId('menu-find').press('Enter');
      await page.waitForURL('**/admin/models', { timeout: 5000 });
      check(true, 'find-a-page: "models" + Enter opens Models');
    }
    await ctx.close();
  }

  // ---- Models → Game night ----
  // The seeded demo leaves last night's session chat open: the DM ends it, so no session is live.
  const j = async (method, p, tok, body) => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
  const dmTok = (await j('POST', '/api/auth/login', undefined, { username: 'dm', password: 'dungeon master 123' })).token;
  if ((await j('GET', '/api/worlds/saltreach/sessionchat/current', dmTok)).session) await j('POST', '/api/worlds/saltreach/sessionchat/sessions/end', dmTok, {});
  const rec = await j('GET', '/api/worlds/saltreach/audio/status', dmTok);
  check(!rec.recording, 'no recording is running');
  const { ctx, page } = await signIn({ width: 390, height: 844 }, true, 'admin (game night)');
  await page.goto(`${base}/admin/models?tab=session`);
  const gn = page.getByTestId('game-night');
  await gn.waitFor();
  await page.getByTestId('gn-phase').waitFor();
  check((await page.getByTestId('gn-phase').getAttribute('data-live')) === '0', 'no session is live (the demo models wait out their grace period)');
  check(await page.locator('[data-gn-job=chat][data-policy=hold]').count() === 1, 'chat is kept loaded during a session');
  check(await page.locator('[data-gn-job=voice][data-policy=ondemand]').count() === 1, 'voice loads when needed');
  check(/Argos/.test(await page.locator('[data-gn-job=chat]').textContent()), 'chat shows its server type (Argos)');
  check(/Session start/.test(await page.locator('[data-gn-job=chat]').textContent()), 'each job says what happens at session start and end');
  await page.getByTestId('gn-start').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=gn-phase]')?.getAttribute('data-live') === '1', null, { timeout: 10000 });
  check(true, 'Start game night: the session is live');
  await page.locator('[data-gn-job=chat] [data-hold=ready]').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=gn-phase]')?.getAttribute('data-phase') === 'ready', null, { timeout: 20000 });
  check(true, 'every kept-loaded model is held');
  // Change a policy: voice to Keep loaded, then back.
  await page.getByLabel('Voice during a session').selectOption('hold');
  await page.locator('[data-gn-job=voice][data-policy=hold]').waitFor();
  await page.getByLabel('Voice during a session').selectOption('ondemand');
  await page.locator('[data-gn-job=voice][data-policy=ondemand]').waitFor();
  check(true, 'a job policy can be changed from the Game night tab');
  await page.getByTestId('gn-end').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=gn-phase]')?.getAttribute('data-phase') === 'releasing', null, { timeout: 10000 });
  check(true, 'End game night: models wait for the grace period');
  await page.getByTestId('gn-release').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=gn-phase]')?.getAttribute('data-phase') === 'off', null, { timeout: 15000 });
  await page.getByTestId('last-release').waitFor({ timeout: 5000 });
  check(/unloaded/.test(await page.getByTestId('last-release').textContent()), 'after the session the held models are unloaded');
  const life = await api(page, 'GET', '/api/admin/models/lifecycle');
  check(life.phase === 'off' && life.holds.length === 0, 'nothing is held after the session');
  // The server panel names what each server can do.
  await page.getByText('Model servers', { exact: true }).click();
  check(/Argos/.test(await page.locator('.gn-server').first().textContent()), 'the model server shows as Argos');
  const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
  check(wide <= 1, 'Game night fits a phone screen');
  await ctx.close();
} catch (e) {
  problems.push('crashed: ' + (e?.stack ?? e));
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log(`\nadmin e2e: ${problems.length} problem(s)`); for (const p of problems) console.log('  ✗ ' + p); process.exit(1); }
console.log('\nadmin e2e: all good');
process.exit(0);
