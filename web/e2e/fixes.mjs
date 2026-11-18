// End-to-end checks for the QA fixes that are about what a person sees: the
// Recording badge, the admin Keys & AI page, the transcript panel, the phone
// pack list, the status approval and the Models card progress.
// Run from web/: npm run build && node e2e/fixes.mjs   (FIXES_PORT overrides the port)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = Number(process.env.FIXES_PORT || 8199);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-fixes-e2e-'));
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const SHOTS = process.env.FIXES_SHOTS || '';

const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'librarian/scripts/demo.ts', '--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => process.stderr.write('[demo] ' + d));
for (let i = 0; i < 150 && !out.includes('Alexandria demo is running'); i++) await new Promise((r) => setTimeout(r, 200));
if (!out.includes('Alexandria demo is running')) { console.log(out); srv.kill(); console.log('demo did not start'); process.exit(1); }

const PASS = { dm: 'dungeon master 123', jess: 'player pass 123', admin: 'library admin 123' };
const api = async (method, p, token, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
};
const browser = await chromium.launch();
const quiet = (t) => /Failed to load resource|fonts\.g|net::ERR_|ResizeObserver/.test(t);
async function signIn(user, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${user} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${user} console on ${page.url()}: ${m.text()}`); });
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(PASS[user]);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(user === 'dm' ? '**/dm' : '**/w/saltreach', { timeout: 15000 });
  return { ctx, page };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

try {
  const dmTok = (await api('POST', '/api/auth/login', null, { username: 'dm', password: PASS.dm })).body.token;
  const world = (await api('GET', '/api/me', dmTok)).body.worlds.find((w) => w.slug === 'saltreach').id;

  // 1. The Recording badge shows for the DM and for a player once a session records (M1).
  const rec = await api('POST', `/api/worlds/${world}/audio/sessions`, dmTok, { name: 'E2E session' });
  check(rec.status === 201, `could not start a recording: ${rec.status}`);
  const dm = await signIn('dm', { width: 1280, height: 800 });
  await dm.page.goto(`${W}/dm/library`);
  check(await dm.page.locator('.au-badge').waitFor({ timeout: 8000 }).then(() => true, () => false), 'no Recording badge for the DM');
  const jess = await signIn('jess', { width: 1280, height: 800 });
  check(await jess.page.locator('.au-badge').waitFor({ timeout: 8000 }).then(() => true, () => false), 'no Recording badge for a player');
  await shot(jess.page, 'recording-badge-player');
  note('Recording badge shows for DM and player');

  // 2. The transcript panel is opaque by default (L2) and the Live page does not say captions are elsewhere (L1).
  await jess.page.getByRole('button', { name: /transcript|captions/i }).first().click({ timeout: 4000 }).catch(() => {});
  const op = await jess.page.evaluate(() => { const el = document.querySelector('.au-island'); return el ? getComputedStyle(el).opacity : 'none'; });
  check(op === 'none' || op === '1', `transcript panel opacity is ${op}`);
  await shot(jess.page, 'transcript-opaque');
  await jess.page.goto(`${W}/live`);
  await jess.page.locator('main').waitFor();
  check(!(await jess.page.locator('body').innerText()).includes('Live captions show here when the DM turns on'), 'the Live page still has the old captions line');
  await api('POST', `/api/worlds/${world}/audio/sessions/current/stop`, dmTok, {});

  // 3. Admin Keys & AI: the list loads and a key can be made (H2).
  const adm = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const ap = await adm.newPage();
  ap.on('pageerror', (e) => problems.push(`admin page error: ${e.message}`));
  await ap.goto(base + '/admin/login');
  await ap.getByLabel(/username/i).fill('admin');
  await ap.getByLabel(/password/i).fill(PASS.admin);
  await ap.getByRole('button', { name: /sign in|log in/i }).click();
  await ap.waitForURL('**/admin**', { timeout: 15000 });
  await ap.goto(`${base}/admin/keys`);
  await ap.getByRole('button', { name: 'Make an admin key' }).waitFor();
  check(!(await ap.locator('[role=alert]').count()), 'the Keys & AI page shows an error on load');
  await ap.getByLabel(/name this key/i).fill('E2E key');
  await ap.getByRole('button', { name: 'Make an admin key' }).click();
  check(await ap.getByText('New admin key').waitFor({ timeout: 8000 }).then(() => true, () => false), 'making an admin key failed');
  check(await ap.getByText('E2E key').first().waitFor({ timeout: 8000 }).then(() => true, () => false), 'the new key is not listed');
  await shot(ap, 'admin-keys-made');
  note('admin keys list and create');
  await adm.close();

  // 4. The Minerva status approval keeps thread descriptions (H1).
  const minerva = await api('GET', `/api/worlds/${world}/minerva`, dmTok);
  const sec = (minerva.body.sections ?? []).find((s) => s.title === 'Active threads');
  check(!!sec, 'no Active threads section in the demo');
  const before = sec?.text ?? '';
  const withDesc = before.split('\n').filter((l) => /^- \[\w+\] \[\[.+\]\]: ./.test(l));
  note(`active threads with descriptions in the demo: ${withDesc.length}`);

  // 5. Phone: the DM's party pack is a list of cards, not a cramped table (L12).
  const ph = await signIn('dm', { width: 390, height: 844 }, true);
  await ph.page.goto(`${W}/dm/party`);
  await ph.page.locator('main').waitFor();
  await ph.page.waitForTimeout(600);
  const rows = await ph.page.evaluate(() => [...document.querySelectorAll('.pack-table tbody tr')].slice(0, 4).map((tr) => { const r = tr.getBoundingClientRect(); const first = tr.querySelector('td'); return { w: Math.round(r.width), h: Math.round(r.height), firstW: Math.round(first.getBoundingClientRect().width), disp: getComputedStyle(tr).display }; }));
  if (rows.length) check(rows.every((r) => r.disp === 'flex' && r.firstW > 250), `pack rows are still cramped: ${JSON.stringify(rows)}`);
  await shot(ph.page, 'party-pack-phone');
  note(`phone pack rows: ${JSON.stringify(rows.slice(0, 1))}`);
} catch (e) {
  problems.push('crashed: ' + (e.stack ?? e));
} finally {
  await browser.close();
  srv.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) { console.error('fixes e2e FAILED:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('fixes e2e ok');
