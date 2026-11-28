// Screen size per person and per device (lib/uiZoom.tsx + features/uiprefs). A phone (touch) zooms through the
// viewport scale, so the layout gets wider in CSS pixels; a desktop window zooms with CSS zoom and full-height
// layouts still fill the window. The value is saved to the account per device: the same device id signing in
// again (fresh storage) gets it back, a different device starts at 100%.
// Run from web/: npm run build && node e2e/zoom.mjs   (ZOOM_PORT, ZOOM_SHOTS=<dir>)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.ZOOM_PORT || 8863);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.ZOOM_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const note = (m) => console.log('  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('zoom'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();

async function open(viewport, touch, user, pass, landing, device) {
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2.5 : 1 });
  if (device) await ctx.addInitScript((d) => { try { if (!localStorage.getItem('alx.deviceId')) localStorage.setItem('alx.deviceId', d); } catch { /* */ } }, device);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(landing, { timeout: 15000 });
  return { ctx, page, errors };
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {}); };
const value = async (page) => Number((await page.getByTestId('zoom-value').first().innerText()).replace('%', ''));
const press = async (page, id, n) => { for (let i = 0; i < n; i++) { await page.getByTestId(id).first().click(); await sleep(60); } await sleep(700); };

// 1. Player phone: More > Edit tabs, two steps smaller -> 80%, layout is wider in CSS px.
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, true, 'jess', 'player pass 123', /\/w\/saltreach/, 'dev_phonetest01');
  const w0 = await page.evaluate(() => window.innerWidth);
  await page.getByRole('button', { name: /^more$/i }).first().click();
  await page.getByText(/edit tabs/i).first().click().catch(() => {});
  await page.getByTestId('ui-zoom').first().scrollIntoViewIfNeeded();
  await press(page, 'zoom-out', 2);
  check(await value(page) === 80, `phone: picker shows ${await value(page)}, wanted 80`);
  await page.keyboard.press('Escape');
  await sleep(300);
  const w1 = await page.evaluate(() => window.innerWidth);
  note(`phone layout width ${w0} -> ${w1} css px at 80%`);
  check(w1 > w0 + 50, `phone: layout did not get wider (${w0} -> ${w1})`);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(scroll <= 1, `phone at 80%: sideways scroll ${scroll}px`);
  const nav = await page.locator('.bottomnav').first().boundingBox();
  check(nav && Math.abs(nav.y + nav.height - (await page.evaluate(() => window.innerHeight))) < 3, `phone at 80%: tab bar not at the bottom (${JSON.stringify(nav)})`);
  await shot(page, 'phone-80');
  check(!errors.length, `phone: ${errors.join('; ')}`);
  await ctx.close();
}
// 2. Same phone (same device id), fresh storage otherwise: the account gives 80% back. Another device: 100%.
{
  const { ctx, page } = await open({ width: 390, height: 844 }, true, 'jess', 'player pass 123', /\/w\/saltreach/, 'dev_phonetest01');
  await sleep(1200);
  const meta = await page.evaluate(() => document.querySelector('meta[name=viewport]')?.content || '');
  check(/initial-scale=0\.8/.test(meta), `same device: zoom not restored from the account (${meta})`);
  await ctx.close();
  const o = await open({ width: 390, height: 844 }, true, 'jess', 'player pass 123', /\/w\/saltreach/, 'dev_othertest02');
  await sleep(1200);
  const m2 = await o.page.evaluate(() => document.querySelector('meta[name=viewport]')?.content || '');
  check(!/initial-scale=0\.8/.test(m2), `other device picked up the phone's zoom (${m2})`);
  await o.ctx.close();
}
// 3. DM on a desktop window: world menu, 90%; CSS zoom on html, rail still fills the height, no sideways scroll.
{
  const { ctx, page, errors } = await open({ width: 1280, height: 800 }, false, 'dm', 'dungeon master 123', /\/w\/saltreach\/dm/, 'dev_desktop03');
  await page.getByRole('button', { name: /worlds and account/ }).click();
  await page.getByTestId('ui-zoom').first().waitFor({ timeout: 5000 }).catch(() => {});
  if (await page.getByTestId('ui-zoom').count()) {
    await press(page, 'zoom-out', 1);
    check(await value(page) === 90, `desktop: picker shows ${await value(page)}`);
    await page.keyboard.press('Escape');
  } else check(false, 'desktop: zoom picker not found in the world menu');
  await sleep(300);
  const st = await page.evaluate(() => {
    const z = getComputedStyle(document.documentElement).zoom;
    const rail = document.querySelector('.dmx-rail')?.getBoundingClientRect();
    return { z, railBottom: rail ? rail.bottom : null, h: window.innerHeight, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  note(`desktop zoom ${st.z}, rail bottom ${st.railBottom} of ${st.h}`);
  check(st.z === '0.9', `desktop: html zoom is ${st.z}`);
  check(st.railBottom == null || Math.abs(st.railBottom - st.h) < 4, `desktop: rail does not fill the window (${st.railBottom} of ${st.h})`);
  check(st.scroll <= 1, `desktop: sideways scroll ${st.scroll}`);
  await shot(page, 'desktop-dm-90');
  check(!errors.length, `desktop: ${errors.join('; ')}`);
  await ctx.close();
}
// 4. DM phone assistant (Remote > This phone) has the picker too.
{
  const { ctx, page } = await open({ width: 390, height: 844 }, true, 'dm', 'dungeon master 123', /\/w\/saltreach\/dm/, 'dev_dmphone04');
  await page.goto(page.url().replace(/\/dm.*$/, '/dm/phone'));
  await page.getByRole('tab', { name: /remote/i }).first().click().catch(() => {});
  if (check(await page.getByTestId('ui-zoom').count() > 0, 'dm phone: no zoom picker on Remote')) {
    await page.getByTestId('ui-zoom').first().scrollIntoViewIfNeeded();
    await press(page, 'zoom-out', 2);
    await page.getByRole('tab', { name: /table|now|live/i }).first().click().catch(() => {});
    await sleep(400);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(scroll <= 1, `dm phone at 80%: sideways scroll ${scroll}px`);
    await shot(page, 'dm-phone-80');
  }
  await ctx.close();
}

await browser.close();
srv.kill();
if (problems.length) { console.log(`zoom: ${problems.length} problem(s)`); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('zoom: ok');
