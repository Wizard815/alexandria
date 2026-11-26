// Foldables opened up (fold.css): the Galaxy Z Fold's inner screen upright (700x850) and
// sideways (850x700), and a wide 4:3 foldable like a folding iPhone (960x720). For the
// player: the tab bar is a rail on the left, More opens as a drawer beside it, pop-ups
// stay phone-width and the dock sits in the corner. For the DM: the area rail stays on
// the left, touch-sized, and the Table page offers the phone assistant. On every page
// tried: no sideways scrolling, no touch target under 40px, no console errors. A desktop
// window of the same size (mouse) keeps the desktop layout, and a phone keeps its bottom bar.
// Run from web/: npm run build && node e2e/fold.mjs
//   FOLD_PORT, FOLD_SHOTS=<dir> (screenshots)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.FOLD_PORT || 8861);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.FOLD_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const note = (m) => console.log('  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('fold'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tokDM = await login('dm', 'dungeon master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tokDM } })).json())[0].id;
const dm = async (method, p, body) => (await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokDM }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));
await dm('POST', '/live/combatants', { name: 'Goblin boss', initiative: 14, hp: 21, maxHp: 21 });
await dm('PUT', '/live/combat', { active: true, round: 1, turn: 0 });

const FOLDS = [
  { name: 'fold-upright', viewport: { width: 700, height: 850 } },
  { name: 'fold-sideways', viewport: { width: 850, height: 700 } },
  { name: 'wide-4x3', viewport: { width: 960, height: 720 } },
];
const PLAYER = ['', 'live', 'sheet', 'inventory', 'me', 'assistant', 'library', 'people', 'calendar', 'map'];
const DM = ['', 'combat', 'party', 'inbox', 'library', 'settings', 'phone'];

const browser = await chromium.launch();
async function open(viewport, touch, user, pass, landing) {
  const ctx = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2.5 : 1 });
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
const player = (vp, touch = true) => open(vp, touch, 'jess', 'player pass 123', /\/w\/saltreach/);
const dmOpen = (vp, touch = true) => open(vp, touch, 'dm', 'dungeon master 123', /\/w\/saltreach\/dm/);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {}); };
const box = (page, sel) => page.locator(sel).first().boundingBox();

// Sideways scrolling and touch targets under 40px (inline links in a sentence are fine).
const AUDIT = () => {
  const vw = window.innerWidth;
  const shown = (e) => { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const small = [];
  for (const e of document.querySelectorAll('button, a[href], [role=button], [role=tab], summary, select, input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color])')) {
    if (!shown(e) || e.closest('.sr-only, [aria-hidden=true]')) continue;
    if (e.tagName === 'A' && getComputedStyle(e).display === 'inline') continue;
    const r = e.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) small.push(`${e.tagName.toLowerCase()} "${(e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return { scrollW: document.scrollingElement.scrollWidth, vw, small: [...new Set(small)] };
};
const closeQuick = async (page) => { const c = page.locator('.modal[role=dialog]').getByRole('button', { name: 'Close' }); if (await c.count()) await c.first().click().catch(() => {}); };

for (const f of FOLDS) {
  const { width: W, height: H } = f.viewport;
  console.log(`${f.name}  ${W}x${H}`);

  // ---- player ----
  {
    const { ctx, page, errors } = await player(f.viewport);
    await page.waitForSelector('[data-testid=tabbar]');
    await sleep(600);
    await closeQuick(page);
    const rail = await box(page, '[data-testid=tabbar]');
    check(rail && rail.x <= 1 && rail.width <= 110 && rail.height >= H - 2, `${f.name} player: tab bar is not a rail on the left (${JSON.stringify(rail)})`);
    for (const t of await page.locator('[data-testid=tabbar] > *').all()) { const b = await t.boundingBox(); check(b && b.height >= 56 && b.width >= 56, `${f.name} player: rail item is small (${JSON.stringify(b)})`); }
    const more = await box(page, '[data-testid=more-btn]');
    check(more && more.y + more.height >= H - 24, `${f.name} player: More is not at the foot of the rail`);
    check(!(await page.locator('.topnav.desktop').isVisible()), `${f.name} player: the desktop nav shows too`);
    const main = await box(page, 'main');
    check(main && main.x >= rail.x + rail.width - 1, `${f.name} player: the page sits under the rail`);
    const dock = await box(page, '.dock');
    if (dock) check(dock.y + dock.height >= H - 24, `${f.name} player: the dock floats above an empty bottom (${Math.round(dock.y + dock.height)})`);
    for (const r of PLAYER) {
      errors.length = 0;
      await page.goto(`${base}/w/saltreach/${r}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=tabbar]');
      await sleep(800);
      await closeQuick(page);
      const a = await page.evaluate(AUDIT);
      const bad = [];
      if (a.scrollW > a.vw) bad.push(`sideways scroll (${a.scrollW} > ${a.vw})`);
      if (a.small.length) bad.push(`target < 40px: ${a.small.slice(0, 4).join(' | ')}`);
      if (errors.length) bad.push(errors.join(' | ').slice(0, 200));
      for (const b of bad) problems.push(`${f.name} player /${r}: ${b}`);
      note(`${bad.length ? 'FAIL' : 'ok  '} player /${r || '(home)'}${bad.length ? '  ' + bad.join('; ') : ''}`);
      await shot(page, `${f.name}-player-${r || 'home'}`);
    }
    // More opens as a drawer beside the rail.
    await page.goto(`${base}/w/saltreach/`);
    await page.getByTestId('more-btn').click();
    await page.getByTestId('more-sheet').waitFor();
    await sleep(200);
    const sheet = await box(page, '[data-testid=more-sheet]');
    check(sheet && Math.abs(sheet.x - rail.width) <= 2 && sheet.y <= 1 && sheet.height >= H - 2 && sheet.width <= 400, `${f.name} player: More is not a drawer beside the rail (${JSON.stringify(sheet)})`);
    await shot(page, `${f.name}-player-more`);
    await page.keyboard.press('Escape');
    note('player: rail, More drawer');
    await ctx.close();
  }

  // ---- a quick event pop-up stays phone-width ----
  {
    const { ctx, page } = await player(f.viewport);
    await page.waitForSelector('[data-testid=tabbar]');
    await closeQuick(page);
    await dm('POST', '/quick-events', { kind: 'notice', title: 'A sound in the reeds', prompt: 'Something moves out there.', skill: 'Perception', dc: 12 });
    const modal = page.locator('.modal[role=dialog]');
    if (check(await modal.waitFor({ timeout: 8000 }).then(() => true, () => false), `${f.name}: quick event did not appear`)) {
      const b = await modal.boundingBox();
      check(b.width <= 641 && b.y >= 0 && b.y + b.height >= H - 2, `${f.name}: quick event is not a phone-width sheet (${JSON.stringify(b)})`);
      await shot(page, `${f.name}-player-quick-event`);
      await page.getByRole('button', { name: 'Roll for me' }).click();
      await closeQuick(page);
      note('quick event: phone-width sheet');
    }
    await ctx.close();
  }

  // ---- DM ----
  {
    const { ctx, page, errors } = await dmOpen(f.viewport);
    await page.waitForSelector('.dmx-rail');
    const rail = await box(page, '.dmx-rail');
    check(rail && rail.x <= 1 && rail.height > rail.width && rail.width <= 110, `${f.name} DM: the area rail is not on the left (${JSON.stringify(rail)})`);
    for (const a of await page.locator('.dmx-area').all()) { const b = await a.boundingBox(); check(b && b.height >= 56, `${f.name} DM: rail area is small (${JSON.stringify(b)})`); }
    for (const t of (await page.locator('.dmx-tab').all()).slice(0, 4)) { const b = await t.boundingBox(); check(b && b.height >= 44, `${f.name} DM: page tab is small (${JSON.stringify(b)})`); }
    const banner = page.getByTestId('phone-banner');
    if (check(await banner.isVisible(), `${f.name} DM: no phone assistant banner on the Table`)) {
      const b = await banner.boundingBox();
      check(b.height <= 90, `${f.name} DM: the phone banner is a tall tile (${Math.round(b.height)}px)`);
    }
    for (const r of DM) {
      errors.length = 0;
      await page.goto(`${base}/w/saltreach/dm/${r}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(r === 'phone' ? '[data-testid=dmphone]' : '.dmx-rail');
      await sleep(800);
      const a = await page.evaluate(AUDIT);
      const bad = [];
      if (a.scrollW > a.vw) bad.push(`sideways scroll (${a.scrollW} > ${a.vw})`);
      if (errors.length) bad.push(errors.join(' | ').slice(0, 200));
      if (r === 'phone') check((await page.getByTestId('dmphone').getAttribute('data-layout')) === 'two-pane', `${f.name} DM: the phone assistant is not two panes`);
      for (const b of bad) problems.push(`${f.name} DM /${r}: ${b}`);
      note(`${bad.length ? 'FAIL' : 'ok  '} dm /${r || '(table)'}${bad.length ? '  ' + bad.join('; ') : ''}`);
      await shot(page, `${f.name}-dm-${r || 'table'}`);
    }
    await ctx.close();
  }
}

// ---- the same size with a mouse keeps the desktop layout; a phone keeps its bottom bar ----
{
  const { ctx, page } = await player({ width: 900, height: 700 }, false);
  await page.waitForSelector('.topnav.desktop');
  check(await page.locator('.topnav.desktop').isVisible(), 'desktop 900x700: the desktop nav is gone');
  check(!(await page.getByTestId('tabbar').isVisible()), 'desktop 900x700: the rail shows with a mouse');
  await ctx.close();
  const d = await dmOpen({ width: 900, height: 700 }, false);
  const t = await box(d.page, '.dmx-top');
  check(t && t.height <= 49, `desktop 900x700 DM: the top bar grew (${t && t.height})`);
  await d.ctx.close();
  note('desktop 900x700: unchanged');
}
{
  const { ctx, page } = await player({ width: 390, height: 844 });
  await page.waitForSelector('[data-testid=tabbar]');
  const b = await box(page, '[data-testid=tabbar]');
  check(b && b.width >= 389 && b.y + b.height >= 843, `phone 390x844: the tab bar is not at the bottom (${JSON.stringify(b)})`);
  await ctx.close();
  note('phone 390x844: bottom bar');
}

await browser.close();
srv.kill();
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(' - ' + p);
  console.log('\nFAIL');
  process.exit(1);
}
console.log('\nPASS');
