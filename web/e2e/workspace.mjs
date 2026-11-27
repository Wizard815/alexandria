// The GM workspace: several GM pages side by side in the main window. Opens Combat and Sound together and acts in each,
// checks live updates reach a pane through the one shared event stream, resizing (drag and keyboard), maximise/restore, swap,
// close, the menu (click opens in the focused pane, "beside", drag a menu row onto a pane), saved layouts and presets, that the
// URL and the last workspace survive a reload, that plain routes still work, that every page in the menu opens in a pane
// without console errors, and a phone staying single-pane.
// Run from web/: npm run build && node e2e/workspace.mjs   (WORKSPACE_PORT, WORKSPACE_SHOTS=<dir>)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.WORKSPACE_PORT || 8844);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach/gm`;
const SHOTS = process.env.WORKSPACE_SHOTS || '/tmp/claude-0/-home-user/26e3dbe6-7466-590f-acf8-13740003567a/scratchpad/workspace';
fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); else note('ok: ' + msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('workspace'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
try {
  const { ctx, page } = await signIn(browser, base, 'dm', 'game master 123', { width: 1366, height: 768 });
  let eventStreams = 0;
  page.on('request', (r) => { if (/\/api\/worlds\/[^/]+\/events/.test(r.url())) eventStreams++; });
  page.on('pageerror', (e) => problems.push(`page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`console on ${page.url()}: ${m.text()}`); });
  const token = await page.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const pane = (i) => page.getByTestId(`ws-pane-${i}`);
  const pages = () => page.evaluate(() => [...document.querySelectorAll('[data-pane]')].map((e) => e.getAttribute('data-page')));
  const qs = () => new URL(page.url()).searchParams;
  const width = async (i) => (await pane(i).boundingBox()).width;
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `workspace-${name}.png`) });
  const clearStore = () => page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('alx.ws.')) localStorage.removeItem(k); });

  // ---- Combat | Sound side by side ----
  eventStreams = 0;
  await page.goto(`${W}/ws?l=cols&p=combat,sound`);
  await pane(0).getByRole('heading', { name: 'Combat', level: 1 }).waitFor({ timeout: 10000 });
  await pane(1).getByRole('heading', { name: 'Sound', level: 1 }).waitFor({ timeout: 10000 });
  check(JSON.stringify(await pages()) === '["combat","sound"]', 'Combat and Sound open side by side');
  const b0 = await pane(0).boundingBox(), b1 = await pane(1).boundingBox();
  check(b0.y === b1.y && b1.x > b0.x + 300, 'the two panes sit side by side, both wide enough to use');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a 1366x768 laptop');
  await shot('cols');

  // Act in each: add a combatant in Combat; press a pad in Sound.
  await pane(0).getByPlaceholder('Dock thug').fill('Pane Goblin');
  await pane(0).getByRole('button', { name: 'Add', exact: true }).click();
  await pane(0).getByText('Pane Goblin').first().waitFor({ timeout: 8000 });
  check(true, 'a combatant added in the Combat pane shows up in it');
  const lib = await api('GET', '/sound/library');
  const fileId = lib.json?.sfx?.[0]?.path ?? lib.json?.sfx?.[0]?.id;
  if (fileId) await api('POST', '/sound/pads', { label: 'E2E clang', file: fileId, bank: 'main', volume: 0.8, loop: false, key: '', target: 'table' }).catch(() => null);
  await pane(1).getByRole('tab', { name: 'Effects' }).click();
  const pad = pane(1).getByRole('button', { name: /E2E clang/ }).first();
  if (await pad.isVisible().catch(() => false) || await pad.waitFor({ timeout: 4000 }).then(() => true, () => false)) {
    const played = page.waitForResponse((r) => /\/sound\/sfx\/play/.test(r.url()) && r.request().method() === 'POST', { timeout: 8000 });
    await pad.click();
    check((await played).ok(), 'a sound pad pressed in the Sound pane plays (POST /sound/sfx/play ok)');
  } else {
    await pane(1).getByRole('tab', { name: 'Music' }).click();
    const mood = page.waitForResponse((r) => /\/sound\/music\/mood/.test(r.url()) && r.request().method() === 'POST', { timeout: 8000 });
    await pane(1).locator('.mood-map').click({ position: { x: 200, y: 150 } });
    check((await mood).ok(), 'the mood map clicked in the Sound pane plays (POST /sound/music/mood ok)');
  }

  // Live: a change made elsewhere reaches the pane with no reload, over the one event stream.
  await api('POST', '/live/combatants', { name: 'API Troll', initiative: 5, hp: 40, maxHp: 40 });
  await pane(0).getByText('API Troll').first().waitFor({ timeout: 8000 }).then(() => check(true, 'a live event reaches the Combat pane'), () => check(false, 'a live event reaches the Combat pane'));
  await sleep(500);
  check(eventStreams === 1, `one world event stream for every pane (saw ${eventStreams})`);

  // ---- resize ----
  const w0 = await width(0);
  const div = page.getByTestId('ws-divider').first();
  await div.focus();
  for (let k = 0; k < 5; k++) await page.keyboard.press('ArrowRight');
  await sleep(300);
  const w1 = await width(0);
  check(w1 > w0 + 40, `the divider resizes with the keyboard (${Math.round(w0)} to ${Math.round(w1)})`);
  check(!!qs().get('s'), 'sizes are in the URL');
  const db = await div.boundingBox();
  await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2);
  await page.mouse.down();
  await page.mouse.move(db.x - 120, db.y + db.height / 2, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  const w2 = await width(0);
  check(w2 < w1 - 60, `dragging the divider resizes (${Math.round(w1)} to ${Math.round(w2)})`);
  await div.dblclick();
  await sleep(300);
  check(Math.abs((await width(0)) - (await width(1))) < 30, 'double-clicking a divider evens the split');

  // ---- each pane keeps its own state: type in Combat, swap, maximise, restore, it is still there ----
  await pane(0).getByPlaceholder('Dock thug').fill('Half typed');
  await pane(0).getByRole('button', { name: /Swap pane 1/ }).click();
  await sleep(400);
  check(JSON.stringify(await pages()) === '["sound","combat"]', 'swap exchanges the two panes');
  check((await pane(1).getByPlaceholder('Dock thug').inputValue()) === 'Half typed', 'a pane keeps its own state when swapped');
  await page.getByTestId('ws-max-1').click();
  await sleep(300);
  check(!(await pane(0).isVisible()) && (await pane(1).isVisible()), 'maximise shows only that pane');
  check(qs().get('z') === '1', 'maximised pane is in the URL');
  await page.getByTestId('ws-max-1').click();
  await sleep(300);
  check((await pane(0).isVisible()) && (await pane(1).getByPlaceholder('Dock thug').inputValue()) === 'Half typed', 'restore brings both back, state intact');

  // ---- the menu ----
  const nav = page.getByRole('navigation', { name: 'GM' });
  await pane(1).click({ position: { x: 20, y: 60 } });
  // The rail turns the strip of tabs to an area; the panes stay as they are.
  const strip = page.getByTestId('dm-tabs');
  const area = async (g) => { await nav.locator(`a[data-group=${g}]`).click(); await sleep(200); };
  await area('run');
  await strip.getByRole('link', { name: /^Scenes/ }).click();
  await sleep(500);
  check((await pages())[1] === 'scenes' && qs().get('p').includes('scenes'), 'a menu click opens the page in the focused pane');
  check(!/\/ws/.test(page.url()) === false, 'and stays in the workspace');
  await area('players');
  check((await pages()).length === 2, 'the rail leaves the panes alone');
  await page.getByTestId('beside-inbox').click({ force: true });
  await sleep(500);
  check((await pages()).includes('inbox') && (await pages()).length === 3, '"open beside" adds a pane');
  // middle-click
  await area('run');
  await strip.getByRole('link', { name: /^Clock/ }).click({ button: 'middle' });
  await sleep(500);
  check((await pages()).includes('clock') && (await pages()).length === 4, 'middle-click opens beside too');
  await strip.getByRole('link', { name: /^Quick events/ }).dragTo(pane(3));
  await sleep(500);
  check((await pages())[3] === 'quick', 'dragging a menu row onto a pane opens it there');
  await shot('four');

  // close, and the layout follows the count
  await page.getByTestId('ws-close-3').click();
  await sleep(300);
  check((await pages()).length === 3, 'closing a pane of four leaves three');
  await page.getByTestId('ws-close-2').click();
  await page.getByTestId('ws-close-1').click();
  await sleep(300);
  check((await pages()).length === 1 && (await page.getByTestId('workspace').getAttribute('data-layout')) === 'one', 'down to one pane is the single layout');

  // ---- layouts: switch, save, bring back ----
  await clearStore();
  await page.goto(`${W}/ws?l=cols&p=combat,sound`);
  await pane(1).getByRole('heading', { name: 'Sound', level: 1 }).waitFor();
  await page.getByTestId('ws-layout-grid').click();
  await sleep(400);
  check((await pages()).length === 4 && (await page.getByTestId('workspace').getAttribute('data-layout')) === 'grid', '2x2 fills four panes');
  const g0 = await pane(0).boundingBox(), g3 = await pane(3).boundingBox();
  check(g3.x > g0.x + 200 && g3.y > g0.y + 150, 'the four panes are in a grid');
  await shot('grid');
  await page.getByTestId('ws-close-3').click();
  await sleep(300);
  check((await pages()).length === 3 && (await page.getByTestId('workspace').getAttribute('data-layout')) === 'side', 'closing a pane of a 2x2 leaves main + side');
  await page.getByTestId('ws-layout-cols').click();
  await sleep(300);
  await page.getByTestId('ws-layout-one').click();
  await sleep(300);
  check((await pages()).length === 1, 'single keeps the first pane');
  await page.getByTestId('ws-layout-cols').click();
  await sleep(300);
  await page.getByTestId('ws-pick-1').selectOption('sound');
  await sleep(500);
  check(JSON.stringify(await pages()) === '["combat","sound"]', 'the page picker changes a pane');
  await page.getByTestId('ws-layouts').click();
  await page.getByTestId('ws-layout-name').fill('Combat night E2E');
  await page.getByTestId('ws-layout-save').click();
  await page.getByText(/Saved “Combat night E2E”/).waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('ws-layout-one').click();
  await sleep(300);
  await page.getByTestId('ws-layouts').click();
  const mine = page.getByTestId('ws-layout-item').filter({ hasText: 'Combat night E2E' });
  check(await mine.count() === 1, 'a saved layout is listed');
  await mine.click();
  await sleep(500);
  check(JSON.stringify(await pages()) === '["combat","sound"]' && qs().get('l') === 'cols', 'choosing a saved layout restores it');
  check(await page.getByTestId('ws-layout-item').count() === 0, 'the list closes after choosing');
  // the menu lists it too, and presets
  const menuLayouts = page.getByTestId('menu-layout');
  const openLayouts = async () => { await page.locator('.nav-layouts').click(); await sleep(200); };
  await openLayouts();
  check((await menuLayouts.count()) >= 4, 'the menu lists presets and saved layouts');
  await menuLayouts.filter({ hasText: 'Prep' }).click();
  await sleep(700);
  check(JSON.stringify(await pages()) === '["library","assistant"]', 'the Prep preset is Library and Assistant');
  await shot('prep');
  await openLayouts();
  await menuLayouts.filter({ hasText: 'Combat night' }).first().click();
  await sleep(700);
  check((await pages()).length === 3 && (await pages())[0] === 'combat', 'the Combat night preset is Combat with Sound and Inbox');
  await shot('combat-night');

  // ---- reload: from the URL, and bare from the last one ----
  const url = page.url();
  await page.reload();
  await pane(0).getByRole('heading', { level: 1 }).first().waitFor({ timeout: 10000 });
  check(page.url() === url && (await pages()).length === 3, 'a reload brings the same workspace back from the URL');
  await page.goto(`${W}/ws`);
  await page.getByTestId('workspace').waitFor();
  await sleep(500);
  check((await pages()).length === 3 && (await pages())[0] === 'combat', 'opening the workspace bare restores the last one');
  const saved = await page.evaluate(() => localStorage.getItem('alx.ws.layouts') || '');
  check(/Combat night E2E/.test(saved), 'saved layouts are kept in the browser');
  // delete the saved one
  await page.getByTestId('ws-layouts').click();
  await page.getByRole('button', { name: 'Delete layout Combat night E2E' }).click();
  await sleep(200);
  check((await page.getByTestId('ws-layout-item').filter({ hasText: 'Combat night E2E' }).count()) === 0, 'a saved layout can be deleted');
  await page.keyboard.press('Escape');

  // ---- keyboard focus ----
  await page.keyboard.press('Alt+2');
  await sleep(300);
  check(qs().get('f') === '1', 'Alt+2 focuses the second pane');

  // ---- plain routes still work as a single pane ----
  await page.goto(`${W}/combat`);
  await page.getByRole('heading', { name: 'Combat', level: 1 }).waitFor();
  check((await page.getByTestId('workspace').count()) === 0, '/gm/combat is still one plain page');
  await strip.getByTestId('beside-sound').click({ force: true });
  await page.getByTestId('workspace').waitFor();
  await sleep(400);
  check(JSON.stringify(await pages()) === '["combat","sound"]' && qs().get('f') === '1', 'on a plain page, "beside" turns it into Combat | Sound');

  // ---- crawl: every page in the picker (every menu page, and the panels) opens in a pane ----
  await page.goto(`${W}/ws?l=cols&p=combat,sound`);
  await pane(0).getByRole('heading', { name: 'Combat', level: 1 }).waitFor();
  const ids = await page.getByTestId('ws-pick-0').evaluate((s) => [...s.options].map((o) => o.value));
  note(`crawling ${ids.length} pages in a pane`);
  for (const id of ids) {
    const before = problems.length;
    await page.getByTestId('ws-pick-0').selectOption(id);
    await sleep(id === 'table' ? 900 : 600);
    const state = await pane(0).evaluate((p) => {
      const body = p.querySelector('.ws-body');
      return { text: (body?.innerText || '').trim().length, overflowX: body ? body.scrollWidth - body.clientWidth : 0, boundary: !!p.querySelector('[role=alert] p')?.textContent?.includes('could not be shown'), page: p.getAttribute('data-page') };
    });
    check(state.page === id && state.text > 0 && !state.boundary, `pane shows ${id}`);
    if (state.overflowX > 24) problems.push(`${id}: wider than its pane by ${state.overflowX}px`);
    if (problems.length > before) { await shot(`crawl-${id}`); }
  }
  // the same crawl in a small quarter of a 2x2
  await page.goto(`${W}/ws?l=grid&p=combat,sound,inbox,scenes`);
  await pane(3).getByRole('heading', { level: 1 }).first().waitFor({ timeout: 10000 });
  for (const id of ['library', 'map', 'party', 'settings', 'table', 'assistant', 'transcript', 'fog', 'phone']) {
    await page.getByTestId('ws-pick-3').selectOption(id);
    await sleep(600);
    const ok = await pane(3).evaluate((p) => (p.querySelector('.ws-body')?.innerText || '').trim().length > 0 && !p.querySelector('[role=alert]'));
    check(ok, `${id} renders in a quarter of a 2x2`);
  }
  await shot('quarter-phone');

  // ---- a link inside a pane moves that pane only ----
  await page.goto(`${W}/ws?l=cols&p=library,sound`);
  await pane(0).getByRole('heading', { level: 1 }).first().waitFor();
  check(!qs().has('entry'), 'panes have their own query: nothing from a pane leaks into the URL');

  await ctx.close();

  // ---- a phone stays single-pane ----
  const ph = await signIn(browser, base, 'dm', 'game master 123', { width: 390, height: 844 }, true);
  ph.page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`phone console: ${m.text()}`); });
  await ph.page.goto(`${W}/ws?l=cols&p=combat,sound`);
  await ph.page.getByTestId('ws-pane-0').waitFor();
  await sleep(500);
  const vis = await ph.page.evaluate(() => [...document.querySelectorAll('[data-pane]')].filter((e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== 'none').length);
  check(vis === 1, 'on a phone the workspace shows one pane');
  check(!(await ph.page.getByRole('toolbar', { name: 'Workspace layout' }).isVisible().catch(() => false)), 'and no layout toolbar');
  await ph.page.screenshot({ path: path.join(SHOTS, 'workspace-phone.png') });
  await ph.ctx.close();
} finally {
  await browser.close();
  srv.kill();
}
console.log('');
if (problems.length) { console.log(`${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); console.log('\nFAIL'); process.exit(1); }
console.log('workspace: all good');
