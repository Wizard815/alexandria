// End-to-end test of the DM app: the seeded demo world (fake models), the
// built app and Chromium. Opens every DM screen at desktop and phone size,
// checks the floating overlays do not collide, then runs the key DM flows.
// Run from web/: npm run build && node e2e/dm.mjs
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = Number(process.env.DM_E2E_PORT || 8197);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-dm-e2e-'));
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

// The demo seeds a world with every feature on fake models, then keeps serving it.
const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'librarian/scripts/demo.ts', '--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], {
  cwd: root,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => process.stderr.write('[demo] ' + d));
for (let i = 0; i < 150 && !out.includes('Alexandria demo is running'); i++) await new Promise((r) => setTimeout(r, 200));
if (!out.includes('Alexandria demo is running')) { console.log(out); srv.kill(); console.log('demo did not start'); process.exit(1); }
for (const line of out.split('\n')) if (line.includes('✗')) problems.push('demo seed step failed: ' + line.trim());

const browser = await chromium.launch();
const quiet = (t) => /Failed to load resource.*(40[1349]|5\d\d)|fonts\.g|net::ERR_|ResizeObserver/.test(t);
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}
const PASS = { dm: 'dungeon master 123', jess: 'player pass 123' };
async function signIn(user, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  watch(page, `${user}${mobile ? ' (phone)' : ''}`);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(PASS[user]);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(user === 'dm' ? '**/dm' : '**/w/saltreach', { timeout: 15000 });
  return { ctx, page };
}
const go = async (page, p) => { await page.goto(`${W}/dm/${p}`); await page.locator('main').waitFor(); await page.waitForTimeout(500); };

// 'approvals' and 'requests' are old paths that redirect to 'inbox'; the rest are in the menu.
const REDIRECTS = { approvals: 'inbox?tab=approvals', requests: 'inbox?tab=requests' };
const ROUTES = ['', 'inbox', 'scenes', 'screen-players', 'active', 'macros', 'lights', 'phone', 'combat', 'quick', 'party', 'approvals', 'broker', 'clock', 'sessionlog', 'bible', 'sound', 'audio', 'stage', 'screens', 'chat', 'library', 'people', 'relations', 'map', 'requests', 'messages', 'calendar', 'whiteboard', 'rules', 'sculpt', 'generators', 'worldlore', 'minerva', 'settings', 'connect'];

/** The dock buttons must not overlap each other or the page's main controls, and each must be the top element where it is. */
async function dockCheck(page, label) {
  // On a phone the dock is folded behind one button; open it to look at the buttons.
  const toggle = page.locator('#alx-dock .dock-toggle');
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await page.waitForTimeout(150);
  }
  const r = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#alx-dock button')].filter((b) => b.offsetParent);
    const boxes = btns.map((b) => { const r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label'), x: r.x, y: r.y, w: r.width, h: r.height, top: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b || b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; });
    const clash = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) clash.push(`${a.name} / ${b.name}`);
    }
    const off = boxes.filter((b) => b.x < 0 || b.y < 0 || b.x + b.w > innerWidth + 1 || b.y + b.h > innerHeight + 1).map((b) => b.name);
    const open = document.querySelector('#alx-dock');
    return { n: boxes.length, clash, covered: boxes.filter((b) => !b.top).map((b) => b.name), off };
  });
  check(r.n >= 3, `${label}: the dock should hold the overlay buttons (found ${r.n})`);
  check(!r.clash.length, `${label}: dock buttons overlap: ${r.clash.join(', ')}`);
  check(!r.covered.length, `${label}: something covers dock buttons: ${r.covered.join(', ')}`);
  check(!r.off.length, `${label}: dock buttons off screen: ${r.off.join(', ')}`);
}

try {
  // ---- 1. every DM screen, desktop and phone ---------------------------------
  for (const [label, vp, mobile] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const { ctx, page } = await signIn('dm', vp, mobile);
    for (const r of ROUTES) {
      await go(page, r);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(over <= 2, `${label}: /dm/${r} scrolls sideways by ${over}px`);
      const text = (await page.locator('main').innerText()).trim();
      check(text.length > 20, `${label}: /dm/${r} is empty`);
      check(!/something went wrong|cannot read prop|undefined is not/i.test(text), `${label}: /dm/${r} shows a crash message`);
      if (['', 'stage', 'sculpt', 'broker'].includes(r)) await dockCheck(page, `${label} /dm/${r}`);
    }
    // The menu: every route is reachable from it, once per group, in a few clear groups.
    const openMenu = async () => { if (mobile && !(await page.locator('nav[aria-label="DM"]').isVisible())) await page.getByRole('button', { name: 'Menu' }).click(); };
    await go(page, '');
    await openMenu();
    const nav = page.locator('nav[aria-label="DM"]');
    const groupNames = await nav.locator('.nav-group:not(.pinned) .nav-label').evaluateAll((e) => e.map((x) => x.textContent));
    check(JSON.stringify(groupNames) === JSON.stringify(['Run the session', 'Players', 'World', 'Prep & tools', 'Setup']), `${label} menu: groups are ${groupNames.join(', ')}`);
    check((await nav.locator('.nav-group[data-group=run] .nav-head').getAttribute('aria-expanded')) === 'true', `${label} menu: Run the session should start open`);
    // Fold everything away, then open each group in turn: the badge shows while it is folded.
    for (const g of ['run', 'players', 'world', 'prep', 'setup']) {
      const head = nav.locator(`.nav-group[data-group=${g}] .nav-head`);
      if ((await head.getAttribute('aria-expanded')) === 'true') await head.click();
    }
    check((await nav.locator('.nav-group a.nav-link').count()) === 0, `${label} menu: folded groups still list pages`);
    const badge = nav.getByTestId('group-badge-players');
    check(await badge.isVisible() && Number(await badge.innerText()) >= 1, `${label} menu: a folded Players group should show the inbox badge`);
    check(/waiting/.test((await nav.locator('.nav-group[data-group=players] .nav-head').getAttribute('aria-label')) ?? ''), `${label} menu: the folded group header does not say something is waiting`);
    for (const g of ['run', 'players', 'world', 'prep', 'setup']) await nav.locator(`.nav-group[data-group=${g}] .nav-head`).click();
    check(!(await badge.count()), `${label} menu: the badge should move to the page once the group is open`);
    const links = await nav.locator('.nav-group:not(.pinned) a.nav-link').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const dmLinks = links.filter((h) => h?.includes('/dm')).map((h) => h.replace(/\/$/, ''));
    check(new Set(dmLinks).size === dmLinks.length, `${label} menu: a link appears twice: ` + dmLinks.filter((h, i) => dmLinks.indexOf(h) !== i).join(', '));
    for (const r of ROUTES.filter((x) => !(x in REDIRECTS))) check(dmLinks.includes(`/w/saltreach/dm${r ? '/' + r : ''}`), `${label} menu: no link to /dm/${r}`);
    note(`${label}: ${ROUTES.length} screens, ${dmLinks.length} menu links`);
    // Old paths still work.
    for (const [old, now] of Object.entries(REDIRECTS)) {
      await go(page, old);
      check(page.url().endsWith(`/dm/${now}`), `${label}: /dm/${old} should redirect to /dm/${now}, is ${page.url()}`);
    }
    // The filter finds a page by what it does, not just by its name.
    await go(page, 'combat');
    await openMenu();
    const find = page.getByTestId('menu-find');
    await find.fill('rsvp');
    const hit = page.getByTestId('menu-results').locator('a.nav-link');
    check((await hit.count()) === 1 && (await hit.first().getAttribute('href'))?.endsWith('/dm/calendar'), `${label}: filtering "rsvp" should find only Game nights (by its description)`);
    await find.fill('price tiers');
    check((await hit.first().getAttribute('href').catch(() => ''))?.endsWith('/dm/broker'), `${label}: filtering "price tiers" should find the Broker`);
    await find.fill('zzzzqq');
    check((await hit.count()) === 0 && (await page.getByTestId('menu-results').innerText()).includes('No page matches'), `${label}: a filter with no match should say so`);
    await find.fill('micro');
    await find.press('Enter');
    await page.waitForURL(/\/dm\/audio$/, { timeout: 5000 }).catch(() => problems.push(`${label}: Enter in the filter did not open the first match`));
    // "/" focuses the filter unless typing; Ctrl+K is left to the assistant.
    await page.locator('main').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('/');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'menu-find'), `${label}: "/" should focus the page filter`);
    // Pinning: starred pages show at the top and are still there after a reload.
    await go(page, '');
    await openMenu();
    await nav.getByRole('button', { name: 'Pin Combat' }).click();
    await nav.getByRole('button', { name: 'Pin Map' }).click();
    check((await nav.locator('.nav-group.pinned a.nav-link').allInnerTexts()).map((t) => t.trim().split('\n')[0]).join(',') === 'Combat,Map', `${label} menu: the Pinned group should list Combat and Map`);
    await page.reload(); await page.locator('main').waitFor(); await openMenu();
    check((await nav.locator('.nav-group.pinned a.nav-link').count()) === 2, `${label} menu: pinned pages did not survive a reload`);
    await nav.getByRole('button', { name: 'Unpin Map' }).first().click();
    check((await nav.locator('.nav-group.pinned a.nav-link').count()) === 1, `${label} menu: Unpin did not remove the page`);
    // At most eight.
    for (const n of ['Quick events', 'Scenes', 'Stage', 'Sound', 'Clock', 'Active mode', 'Players', 'Broker']) await nav.getByRole('button', { name: `Pin ${n}` }).first().click({ timeout: 2000 }).catch(() => {});
    check((await nav.locator('.nav-group.pinned a.nav-link').count()) === 8, `${label} menu: pins should stop at 8 (${await nav.locator('.nav-group.pinned a.nav-link').count()})`);
    // The menu fits the screen: on a laptop it scrolls inside itself, never sideways.
    check(await nav.evaluate((n) => n.scrollWidth <= n.clientWidth + 1), `${label} menu: scrolls sideways`);
    await ctx.close();
  }

  // ---- 2. the DM flows (desktop) ---------------------------------------------
  const { ctx: dmCtx, page: dm } = await signIn('dm', { width: 1280, height: 800 });
  const dmToken = await dm.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body, token = dmToken) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // Advance time.
  await go(dm, 'clock');
  const dateBefore = (await dm.locator('main h2').first().innerText()).trim();
  await dm.getByRole('button', { name: 'Next day' }).click();
  await dm.waitForFunction((b) => document.querySelector('main h2')?.textContent?.trim() !== b, dateBefore, { timeout: 8000 }).catch(() => problems.push('clock: the date did not change after Next day'));
  const clk = await api('GET', '/clock');
  check(clk.status === 200 && clk.json.minutes > 0, 'clock: cannot read the clock');
  note('time advanced: ' + dateBefore + ' -> ' + (await dm.locator('main h2').first().innerText()).trim());

  // Sculpt an NPC and save it to People.
  await go(dm, 'sculpt');
  await dm.getByText('NPC for quick RP').first().click();
  await dm.getByLabel('Name', { exact: false }).first().fill('Mira Vossle');
  await dm.getByRole('button', { name: 'Sculpt', exact: true }).click();
  await dm.waitForFunction(() => /Mira Vossle/.test(document.querySelector('main')?.innerText ?? '') && !document.querySelector('main')?.innerText.includes('Nothing yet'), null, { timeout: 15000 }).catch(() => problems.push('sculpt: no preview after Sculpt'));
  // Outputs are checkboxes now: tick "Save as a page" (the NPC template saves to People) and press Do selected.
  const saveBox = dm.locator('label.sculpt-out', { hasText: 'Save as a page' }).locator('input[type=checkbox]');
  if (!(await saveBox.isChecked())) await saveBox.check();
  await dm.getByRole('button', { name: /^Do selected/ }).click();
  await dm.waitForTimeout(1200);
  const people = await api('GET', '/people');
  check(JSON.stringify(people.json).includes('Mira Vossle'), 'sculpt: the saved NPC is not in People');
  note('NPC sculpted and saved');

  // Generators hub: an NPC, then a dungeon map, each saved
  await go(dm, 'generators');
  await dm.getByRole('button', { name: /^Villain/ }).click();
  await dm.getByTestId('gen-title').waitFor({ timeout: 15000 });
  check((await dm.locator('main').innerText()).includes('DM only'), 'generators: the NPC secret is not marked DM only');
  await dm.getByRole('button', { name: 'Save', exact: true }).click();
  await dm.getByText(/Saved .*Generated\/NPCs/).waitFor({ timeout: 15000 });
  await go(dm, 'generators');
  await dm.getByRole('tab', { name: 'Maps' }).click();
  await dm.getByRole('button', { name: /^Dungeon/ }).click();
  await dm.locator('.gen-map img').waitFor({ timeout: 15000 });
  await dm.getByRole('button', { name: 'Save', exact: true }).click();
  await dm.getByText(/Saved .*Generated\/Maps/).waitFor({ timeout: 15000 });
  const mapsList = (await api('GET', '/files/maps')).json ?? [];
  check(mapsList.some((m) => /\(DM\)\.png$/.test(m.name)), 'generators: the saved dungeon map is not on the Map page list');
  note('generators: NPC and dungeon map generated and saved');

  // Stage: show a staged card, and a player sees it.
  await go(dm, 'stage');
  const card = dm.locator('main').getByText('A note under the door').first();
  await card.waitFor({ timeout: 8000 });
  await dm.locator('section.stg-card', { hasText: 'A note under the door' }).getByRole('button', { name: 'Show to all' }).click();
  await dm.waitForTimeout(800);
  const { ctx: plCtx, page: pl } = await signIn('jess', { width: 390, height: 844 }, true);
  await pl.goto(`${W}/stage`);
  await pl.waitForTimeout(1200);
  check((await pl.locator('main').innerText()).includes('Come to the Salty Dog'), 'stage: the player does not see the card the DM showed');
  check(!(await pl.locator('main').innerText()).includes('Council secrets'), 'stage: DM-only text on the player stage');
  const plOver = await pl.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(plOver <= 2, `stage: the player's stage scrolls sideways by ${plOver}px`);
  await plCtx.close();
  note('stage card shown and seen by a player');

  // Quick gen: give gold to the party.
  await go(dm, '');
  const purseBefore = (await api('GET', '/live')).json.purse.cp;
  await dm.keyboard.press('Alt+g');
  const dlg = dm.getByRole('dialog', { name: 'Quick generators' });
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByRole('tab', { name: 'Gold' }).click();
  await dlg.getByText(/cp in all/).waitFor({ timeout: 5000 });
  await dlg.getByRole('button', { name: 'Give', exact: true }).click();
  await dlg.getByText(/^Gave /).waitFor({ timeout: 5000 }).catch(() => problems.push('quickgen: no "Gave ..." confirmation'));
  const purseAfter = (await api('GET', '/live')).json.purse.cp;
  check(purseAfter > purseBefore, `quickgen: the party purse did not grow (${purseBefore} -> ${purseAfter})`);
  await dm.keyboard.press('Escape');
  note('quick gen gave coin');

  // The assistant: ask, then approve a proposed change.
  await dm.keyboard.press('Control+k');
  const box = dm.locator('[data-ag-input]');
  await box.waitFor({ timeout: 5000 });
  await dockCheck(dm, 'with the assistant open');
  await box.fill('What is in Saltmarsh?');
  await dm.keyboard.press('Enter');
  await dm.getByText(/You said: "What is in Saltmarsh\?"/).waitFor({ timeout: 15000 }).catch(() => problems.push('agent: no answer streamed'));
  await box.fill('Next turn: call next_turn');
  await dm.keyboard.press('Enter');
  const approve = dm.getByRole('button', { name: 'Approve', exact: true });
  await approve.waitFor({ timeout: 15000 }).catch(() => problems.push('agent: no approval was proposed'));
  if (await approve.count()) {
    await approve.click();
    await dm.waitForFunction(() => !document.querySelector('aside[aria-label="Assistant"]')?.innerText.includes('Approve\nReject'), null, { timeout: 8000 }).catch(() => problems.push('agent: the approval card did not settle'));
    check(await dm.locator('aside[aria-label="Assistant"]').count() === 1, 'agent: panel vanished');
  }
  await dm.keyboard.press('Escape');
  await dm.getByRole('button', { name: 'Collapse the assistant' }).click().catch(() => {});
  note('assistant answered and an approval was decided');

  // Publish the draft session log.
  await go(dm, 'sessionlog');
  await dm.getByText('Session 22 (draft)').first().click();
  const publish = dm.getByRole('button', { name: /^Publish/ }).first();
  await publish.waitFor({ timeout: 8000 });
  await publish.click();
  await dm.waitForTimeout(1500);
  const confirm = dm.getByRole('button', { name: /^(Publish|Yes|Confirm)/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => {});
  await dm.waitForTimeout(1500);
  const logs = await api('GET', '/sessionlog');
  check(JSON.stringify(logs.json).includes('Session 22'), 'sessionlog: the draft was not published');
  note('session log published');

  // Minerva: open her page, see the status doc, approve a draft from the review queue.
  await go(dm, 'minerva');
  check(/Campaign status/i.test(await dm.locator('main').innerText()), 'minerva: the status doc is not on her page');
  await dm.getByRole('tab', { name: /^Review/ }).click();
  const mnApprove = dm.getByRole('button', { name: 'Approve', exact: true }).first();
  await mnApprove.waitFor({ timeout: 8000 }).catch(() => problems.push('minerva: no draft waits in the review queue'));
  const waiting = (await api('GET', '/minerva/review')).json?.drafts?.length ?? 0;
  if (waiting) {
    await mnApprove.click();
    await dm.waitForTimeout(800);
    const after = (await api('GET', '/minerva/review')).json?.drafts?.length ?? 0;
    check(after < waiting, 'minerva: approving a draft did not take it off the list');
  }
  note('minerva review approved');

  await dmCtx.close();

  // ---- 3. admin pages ---------------------------------------------------------
  const actx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ap = await actx.newPage();
  watch(ap, 'Admin');
  await ap.goto(base + '/admin/login');
  await ap.getByLabel(/username/i).fill('admin');
  await ap.getByLabel(/password/i).fill('library admin 123');
  await ap.getByRole('button', { name: /sign in|log in/i }).click();
  await ap.waitForURL('**/admin', { timeout: 10000 }).catch(() => {});
  for (const r of ['', 'accounts', 'worlds', 'sources', 'models', 'security', 'keys', 'audit']) {
    await ap.goto(`${base}/admin/${r}`);
    await ap.waitForTimeout(500);
    check((await ap.locator('main').innerText()).trim().length > 20, `admin: /admin/${r} is empty`);
  }
  note('admin pages open');
  await actx.close();
} catch (e) {
  problems.push('flow failed: ' + e.message.split('\n')[0]);
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('dm e2e ok');
