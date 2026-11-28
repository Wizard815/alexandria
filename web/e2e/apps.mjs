// The apps around the web app, in a browser that pretends to be each of them:
// - iPhone (Safari, then installed to the home screen): the "You" card with HP, temp HP,
//   conditions and "Your turn"; This device shows the Add to Home Screen steps; installed,
//   a back button appears in the top bar after moving to another page.
// - The Android app (Tauri marker + Android user agent): This device links the home-screen
//   widget; the link carries a widget key in the #fragment only, and that key reads the
//   glance and nothing else.
// - /get-app opens with no sign-in; /app-link/... in a plain browser says to use the app.
// - Builds the server hosts: This device lists them for download (signed in, a short ticket);
//   inside the app (marker window.__ALEXANDRIA_APP__) a newer build shows a banner and an
//   "Update to" button whose app link carries the file, the ticket and the checksum.
// Run from web/: npm run build && node e2e/apps.mjs     (APPS_PORT, APPS_SHOTS=<dir>)
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.APPS_PORT || 8846);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.APPS_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); console.log(`  ${ok ? 'ok ' : 'BAD'} ${msg}`); return ok; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

const DATA = path.join(tmpDir('apps'), 'data');
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', DATA, '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
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

// Two app builds on the server (the demo wipes its data folder on start, so after it).
const APK = Buffer.from('fake apk ' + 'x'.repeat(5000));
const APK_SHA = crypto.createHash('sha256').update(APK).digest('hex');
fs.mkdirSync(path.join(DATA, 'apps'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'apps', 'Alexandria-9.1.0-android.apk'), APK);
fs.writeFileSync(path.join(DATA, 'apps', 'Alexandria-9.1.0-linux-x64.tar.gz'), Buffer.from('fake tarball'));

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
    check(await page.getByTestId('downloads').waitFor({ timeout: 8000 }).then(() => true, () => false), 'signed in, the builds on this server are listed for download');
    check(!(await page.getByTestId('update-card').count()), 'no Updates card outside the apps');
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
    // waitForURL resolves when the navigation commits, before the page has rendered: wait for the heading.
    check(await page.getByRole('heading', { name: 'Open this in the app' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'in a browser, /app-link/... says to use the app');
    const g = await api('GET', `/api/worlds/${W.slug}/glance`, key);
    check(g.status === 200 && g.body.combat.me.hp === 17, 'the widget key reads the glance');
    check((await api('GET', `/api/worlds/${W.slug}/library`, key)).status === 401, 'and nothing else');
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('Downloads and updates, in the Android app');
  {
    const { ctx, page, errors } = await open(ANDROID, () => { window.__TAURI_INTERNALS__ = {}; window.__ALEXANDRIA_APP__ = Object.freeze({ version: '9.0.0', platform: 'android', arch: 'aarch64' }); });
    check(await page.getByTestId('update-banner').waitFor({ timeout: 8000 }).then(() => true, () => false), 'a banner says this server has a newer version');
    await page.goto(`${base}/w/${W.slug}/app`);
    const card = page.getByTestId('update-card');
    await card.waitFor({ timeout: 8000 });
    await card.getByText('On this server').waitFor({ timeout: 8000 }).catch(() => {});
    const ct = (await card.textContent()) ?? '';
    check(/9\.0\.0/.test(ct) && /9\.1\.0/.test(ct), `the Updates card shows both versions (${ct.slice(0, 90)})`);
    const dl = page.getByTestId('downloads');
    check(await dl.isVisible() && /Alexandria-9\.1\.0-linux-x64\.tar\.gz/.test((await dl.textContent()) ?? ''), 'This device lists every build for download');
    check(await page.getByTestId('auto-update').isVisible(), 'and an automatic-update switch');
    check(await noSideways(page), 'no sideways scroll');
    await shot(page, 'android-update');
    const go = page.waitForURL(/\/app-link\/update/, { timeout: 8000 });
    await page.getByTestId('update-now').click();
    await go;
    const frag = new URLSearchParams(new URL(page.url()).hash.slice(1));
    check(frag.get('f') === 'Alexandria-9.1.0-android.apk', 'the update link names the APK');
    check(frag.get('s') === APK_SHA, "and carries the server's checksum");
    const t = frag.get('t') ?? '';
    const r = await fetch(`${base}/api/apps/file/${frag.get('f')}?t=${encodeURIComponent(t)}`);
    const got = Buffer.from(await r.arrayBuffer());
    check(r.status === 200 && got.equals(APK), 'its ticket downloads the APK with no sign-in header');
    check((await fetch(`${base}/api/apps/file/Alexandria-9.1.0-linux-x64.tar.gz?t=${encodeURIComponent(t)}`)).status >= 400, 'and only that file');
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('Notifications, in the Android app');
  {
    // The page counts as hidden (the app is in the background) once window.__hide is set.
    const { ctx, page, errors } = await open(ANDROID, () => {
      window.__TAURI_INTERNALS__ = {}; window.__ALEXANDRIA_APP__ = Object.freeze({ version: '9.1.0', platform: 'android', arch: 'aarch64' });
      Object.defineProperty(document, 'hidden', { get: () => window.__hide === true });
    });
    await page.goto(`${base}/w/${W.slug}/app`);
    const card = page.getByTestId('notifications');
    await card.waitFor({ timeout: 8000 });
    check(await card.getByTestId('notif-link').isVisible(), 'This device: notifications, with the background check');
    const turnBox = card.locator('input[data-kind=turn]');
    await turnBox.uncheck();
    await page.waitForTimeout(800);
    check((await api('GET', '/api/me/notifications', tokJess)).body.kinds.turn === false, 'unticking "Your turn" saves it for this person');
    await turnBox.check();
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__hide = true; });
    const go = page.waitForURL(/\/app-link\/notify/, { timeout: 15000 });
    await api('POST', `/api/worlds/${W.id}/quick-events`, tokDM, { kind: 'notice', title: 'Footsteps behind you', prompt: 'Roll Perception', audience: [jessId], timerS: 120 });
    const got = await go.then(() => true, () => false);
    check(got, 'in the background, a new quick event goes to the app as a notification');
    if (got) {
      const f = new URLSearchParams(new URL(page.url()).hash.slice(1));
      check(f.get('t') === 'Footsteps behind you' && (f.get('p') ?? '').startsWith(`/w/${W.slug}`), `with its title and page (${f.get('t')}, ${f.get('p')})`);
      const acts = JSON.parse(f.get('a') ?? '[]');
      check(acts.length === 1 && acts[0].id === 'roll' && acts[0].label === 'Roll for me', `and a "Roll for me" button (${f.get('a')})`);
    }
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('Share to Alexandria, from the Android app');
  {
    const { ctx, page, errors } = await open(ANDROID, () => { window.__TAURI_INTERNALS__ = {}; });
    await api('POST', `/api/worlds/${W.id}/sessionchat/sessions/start`, tokDM, {}).catch(() => {});
    await page.goto(`${base}/share`);
    await page.getByTestId('share-page').waitFor();
    // What MainActivity.shareIntoPage does once the page is ready.
    await page.waitForFunction(() => window.__alxShareReady === true);
    await page.evaluate(() => { window.__alxShare = { text: 'https://example.com/a-map-of-the-coast', subject: 'Look at this map' }; });
    const box = page.getByTestId('share-text');
    await box.waitFor();
    check((await box.inputValue()).includes('a-map-of-the-coast'), 'the shared text arrives in the page');
    await page.getByTestId('share-send').click();
    const done = await page.getByTestId('share-done').waitFor({ timeout: 8000 }).then(() => true, () => false);
    check(done, `sent to the table chat (${done ? '' : await page.locator('.error, [role=alert]').first().textContent().catch(() => '')})`);
    check(await noSideways(page), 'no sideways scroll');
    await shot(page, 'android-share');
    check(!errors.length, `no console errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  console.log('Invites: QR code and opening in the app');
  {
    const inv = await api('POST', `/api/worlds/${W.id}/invites`, tokDM, { role: 'player' });
    const ctx = await browser.newContext(ANDROID);
    const page = await ctx.newPage();
    await page.goto(`${base}/join?code=${inv.body.code}`);
    const btn = page.getByTestId('open-in-app').getByRole('link', { name: /Open in the Alexandria app/ });
    await btn.waitFor({ timeout: 8000 });
    const href = (await btn.getAttribute('href')) ?? '';
    const u = new URL(href);
    check(u.protocol === 'alexandria:' && u.searchParams.get('code') === inv.body.code && u.searchParams.get('server') === base, `the Join page offers the app (${href})`);
    await ctx.close();
    const app = await browser.newContext(ANDROID);
    await app.addInitScript(() => { window.__TAURI_INTERNALS__ = {}; });
    const p2 = await app.newPage();
    await p2.goto(`${base}/join?code=${inv.body.code}`);
    await p2.getByRole('heading', { name: 'Join a world' }).waitFor();
    check(!(await p2.getByTestId('open-in-app').count()), 'not inside the app itself');
    await app.close();
    // The DM makes an invite: a QR code of the link, for phones at the table.
    const dmCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const dp = await dmCtx.newPage();
    await dp.goto(base + '/login');
    await dp.getByLabel(/username/i).fill('dm');
    await dp.getByLabel(/password/i).fill('dungeon master 123');
    await dp.getByRole('button', { name: /sign in|log in/i }).click();
    await dp.waitForURL(/\/w\//, { timeout: 15000 });
    await dp.goto(`${base}/w/${W.slug}/dm/sharing?tab=invite`);
    await dp.getByRole('button', { name: 'Make an invite code' }).click();
    check(await dp.getByTestId('qr').waitFor({ timeout: 8000 }).then(() => true, () => false), 'a new invite shows a QR code of its link');
    await shot(dp, 'dm-invite-qr');
    await dmCtx.close();
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
