// The apps around the web app, in a browser that pretends to be each of them:
// - iPhone (Safari, then installed to the home screen): the "You" card with HP, temp HP,
//   conditions and "Your turn"; This device shows the Add to Home Screen steps; installed,
//   a back button appears in the top bar after moving to another page.
// - The Android app (Tauri marker + Android user agent): This device links the home-screen
//   widget; the link carries a widget key in the #fragment only, and that key reads the
//   glance and nothing else.
// - /get-app opens with no sign-in; /app-link/... in a plain browser says to use the app.
// Run from web/: npm run build && node e2e/apps.mjs     (APPS_PORT, APPS_SHOTS=<dir>)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.APPS_PORT || 8846);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.APPS_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); console.log(`  ${ok ? 'ok ' : 'BAD'} ${msg}`); return ok; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('apps'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const api = async (method, p, tok, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).body.token;
const tokDM = await login('dm', 'dungeon master 123');
const tokJess = await login('jess', 'player pass 123');
const W = (await api('GET', '/api/worlds', tokDM)).body[0];
const jessId = (await api('GET', '/api/me', tokJess)).body.account.id;

// Jess is in a fight and it is her turn.
await api('POST', `/api/worlds/${W.id}/live/combatants`, tokDM, { name: 'Jessamine', accountId: jessId, initiative: 20, hp: 17, maxHp: 31, tempHp: 4 });
await api('POST', `/api/worlds/${W.id}/live/combatants`, tokDM, { name: 'Goblin boss', initiative: 10, hp: 21, maxHp: 21 });
await api('PUT', `/api/worlds/${W.id}/live/combat`, tokDM, { active: true, round: 3, turn: 0 });

const IPHONE = { viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const ANDROID = { viewport: { width: 412, height: 915 }, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-F946B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36', deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const browser = await chromium.launch();
async function open(profile, init) {
  const ctx = await browser.newContext(profile);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) errors.push(m.text()); });
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill('jess');
  await page.getByLabel(/password/i).fill('player pass 123');
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  // A quick event from the demo may be open: close it.
  const c = page.locator('.modal[role=dialog]').getByRole('button', { name: 'Close' });
  if (await c.waitFor({ timeout: 1500 }).then(() => true, () => false)) await c.click();
  return { ctx, page, errors };
}
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

try {
  console.log('iPhone, Safari');
  {
    const { ctx, page, errors } = await open(IPHONE);
    const you = page.getByTestId('you-card');
    await you.waitFor({ timeout: 8000 }).catch(() => {});
    check(await you.isVisible(), 'the You card shows on Home during a fight');
    const text = (await you.textContent()) ?? '';
    check(/17/.test(text) && /31/.test(text), `it shows HP 17 / 31 (got "${text.slice(0, 80)}")`);
    check(/\+4 temporary HP/.test(text), 'and the temporary HP');
    check(/Your turn/.test(text), 'and that it is her turn');
    check(!/Goblin boss/.test(text), "and nobody else's numbers");
    check(await noSideways(page), 'Home has no sideways scroll');
    await shot(page, 'iphone-home');
    await page.goto(`${base}/w/${W.slug}/app`);
    await page.getByRole('heading', { name: 'This device' }).waitFor();
    check(await page.getByText('Add to Home Screen').first().isVisible(), 'This device shows the Add to Home Screen steps');
    check(!(await page.getByTestId('link-widget').count()), 'no widget link outside the Android app');
    check(!(await page.getByTestId('ios-back').count()), 'no extra back button in Safari, which has its own');
    check(await noSideways(page), 'This device has no sideways scroll');
    await shot(page, 'iphone-app');
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('iPhone, installed to the home screen');
  {
    const { ctx, page, errors } = await open(IPHONE, () => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
    await page.getByTestId('you-card').waitFor({ timeout: 8000 });
    check(!(await page.getByTestId('ios-back').count()), 'no back button on the first page');
    await page.getByTestId('tabbar').getByRole('link', { name: /Live/ }).click();
    await page.waitForURL(/\/live$/);
    const back = page.getByTestId('ios-back');
    check(await back.waitFor({ timeout: 4000 }).then(() => true, () => false), 'a back button after moving to Live');
    await shot(page, 'iphone-installed-live');
    await back.click();
    await page.waitForURL(new RegExp(`/w/${W.slug}/?$`));
    check(true, 'back returns to Home');
    await page.goto(`${base}/w/${W.slug}/app`);
    await page.getByRole('heading', { name: 'This device' }).waitFor();
    check(await page.getByRole('button', { name: 'Reload' }).isVisible(), 'installed: a Reload button (no browser bar)');
    check(!(await page.getByText('Add to Home Screen').count()), 'installed: no install steps');
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('The Android app');
  {
    const { ctx, page, errors } = await open(ANDROID, () => { window.__TAURI_INTERNALS__ = {}; });
    await page.goto(`${base}/w/${W.slug}/app`);
    await page.getByRole('heading', { name: 'Home-screen widget' }).waitFor();
    await shot(page, 'android-app');
    const linkReq = page.waitForURL(/\/app-link\/widget/, { timeout: 8000 });
    // A real app cancels this navigation; this browser follows it to the "use the app" page.
    const apiCalls = [];
    page.on('request', (r) => { if (r.url().includes('/app-link/')) apiCalls.push(r.url()); });
    await page.getByTestId('link-widget').click();
    await linkReq;
    const url = new URL(page.url());
    const frag = new URLSearchParams(url.hash.slice(1));
    const key = frag.get('k') ?? '';
    check(key.startsWith('alx_wdg_'), 'the link carries a widget key');
    check(frag.get('w') === W.slug, 'and the world');
    check(apiCalls.every((u) => !u.includes('alx_wdg_')), 'the key is only in the #fragment, never sent to the server');
    check(await page.getByRole('heading', { name: 'Open this in the app' }).isVisible(), 'in a browser, /app-link/... says to use the app');
    const g = await api('GET', `/api/worlds/${W.slug}/glance`, key);
    check(g.status === 200 && g.body.combat.me.hp === 17, 'the widget key reads the glance');
    check((await api('GET', `/api/worlds/${W.slug}/library`, key)).status === 401, 'and nothing else');
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('Get the app, signed out');
  {
    const ctx = await browser.newContext(IPHONE);
    const page = await ctx.newPage();
    await page.goto(`${base}/get-app`);
    await page.getByRole('heading', { name: 'Get Alexandria' }).waitFor();
    check(await page.getByRole('heading', { name: 'Android' }).isVisible(), '/get-app opens with no sign-in');
    const href = await page.getByRole('link', { name: 'downloads page' }).first().getAttribute('href');
    check(/^https:\/\//.test(href ?? ''), `with a downloads link (${href})`);
    check(await noSideways(page), 'no sideways scroll');
    await shot(page, 'get-app');
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log('\napps: all good');
