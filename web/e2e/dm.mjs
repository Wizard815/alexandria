// End-to-end test of the GM app: the seeded demo world (fake models), the
// built app and Chromium. Opens every GM screen at desktop and phone size,
// checks the floating overlays do not collide, then runs the key GM flows.
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
const PASS = { dm: 'game master 123', jess: 'player pass 123' };
async function signIn(user, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  watch(page, `${user}${mobile ? ' (phone)' : ''}`);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(PASS[user]);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(user === 'dm' ? '**/gm' : '**/w/saltreach', { timeout: 15000 });
  return { ctx, page };
}
const go = async (page, p) => { await page.goto(`${W}/gm/${p}`); await page.locator('main').waitFor(); await page.waitForTimeout(500); };

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
  // ---- 1. every GM screen, desktop and phone ---------------------------------
  for (const [label, vp, mobile] of [['desktop', { width: 1280, height: 800 }, false], ['phone', { width: 390, height: 844 }, true]]) {
    const { ctx, page } = await signIn('dm', vp, mobile);
    for (const r of ROUTES) {
      await go(page, r);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(over <= 2, `${label}: /gm/${r} scrolls sideways by ${over}px`);
      const text = (await page.locator('main').innerText()).trim();
      check(text.length > 20, `${label}: /gm/${r} is empty`);
      check(!/something went wrong|cannot read prop|undefined is not/i.test(text), `${label}: /gm/${r} shows a crash message`);
      if (['', 'stage', 'sculpt', 'broker'].includes(r)) await dockCheck(page, `${label} /gm/${r}`);
    }
    // The rail has five areas, and every page of an area is on its strip: nothing is folded away.
    await go(page, '');
    const rail = page.locator('nav[aria-label="GM"]');
    const strip = page.getByTestId('dm-tabs');
    check(JSON.stringify(await rail.locator('a span:not(.nav-badge)').allInnerTexts()) === JSON.stringify(['Play', 'Players', 'World', 'Prep', 'Setup']), `${label} rail: areas are ${(await rail.locator('a').allInnerTexts()).join(', ')}`);
    check(Number(await rail.getByTestId('group-badge-players').innerText()) >= 1, `${label} rail: Players should show what is waiting`);
    const dmLinks = [];
    for (const g of ['run', 'players', 'world', 'prep', 'setup']) {
      await rail.locator(`a[data-group=${g}]`).click();
      await page.waitForTimeout(250);
      dmLinks.push(...(await strip.locator('.dmx-tabwrap a.dmx-tab').evaluateAll((as) => as.map((x) => x.getAttribute('href').replace(/\/$/, '')))));
    }
    check(new Set(dmLinks).size === dmLinks.length, `${label} tabs: a page is listed twice: ` + dmLinks.filter((h, i) => dmLinks.indexOf(h) !== i).join(', '));
    for (const r of ROUTES.filter((x) => !(x in REDIRECTS))) check(dmLinks.includes(`/w/saltreach/gm${r ? '/' + r : ''}`), `${label} tabs: no link to /gm/${r}`);
    note(`${label}: ${ROUTES.length} screens, ${dmLinks.length} tabs`);
    // An area reopens on the page last used in it.
    await go(page, 'map'); await go(page, 'combat');
    await rail.locator('a[data-group=world]').click();
    await page.waitForURL(/\/gm\/map$/, { timeout: 4000 }).catch(() => problems.push(`${label}: World did not reopen on Map`));
    for (const [old, now] of Object.entries(REDIRECTS)) {
      await go(page, old);
      check(page.url().endsWith(`/gm/${now}`), `${label}: /gm/${old} should redirect to /gm/${now}, is ${page.url()}`);
    }
    // The search box lists the app's pages, by what they do as well as by name; "/" opens it.
    await go(page, 'combat');
    await page.getByTestId('menu-find').click();
    const box = page.getByRole('dialog', { name: 'Search the world' });
    const navHits = box.getByRole('group', { name: 'Go to' }).getByRole('option');
    check((await navHits.count()) >= ROUTES.length - 2, `${label}: an empty search should list every page (${await navHits.count()})`);
    await box.getByRole('searchbox').fill('rsvp');
    check((await navHits.count()) === 1 && /Game nights/.test(await navHits.first().innerText()), `${label}: searching "rsvp" should find Game nights`);
    await box.getByRole('searchbox').fill('micro');
    await box.getByRole('searchbox').press('Enter');
    await page.waitForURL(/\/gm\/audio$/, { timeout: 5000 }).catch(() => problems.push(`${label}: Enter in the search did not open Microphones`));
    await page.keyboard.press('/');
    check(await box.isVisible(), `${label}: "/" should open the search`);
    await page.keyboard.press('Escape');
    // Starred pages stay on the strip in every area, and after a reload.
    await go(page, 'combat');
    await page.getByRole('button', { name: 'Pin Combat' }).click();
    await go(page, 'library');
    check((await page.getByTestId('dm-pins').innerText().catch(() => '')).includes('Combat'), `${label}: a pinned page is not on the strip of another area`);
    await go(page, 'combat');
    await page.getByRole('button', { name: 'Unpin Combat' }).click();
    await go(page, 'library');
    check(!(await page.getByTestId('dm-pins').count()), `${label}: Unpin did not remove the page`);
    // A session starts and ends from any page. (The demo may have one open.)
    const sb = page.getByTestId('session-btn');
    const end = async () => { await sb.click(); await page.getByRole('button', { name: 'End session' }).click(); await sb.filter({ hasText: 'Start session' }).waitFor({ timeout: 6000 }); };
    const wasOpen = /In session|Recording/.test(await sb.innerText());
    if (!wasOpen) {
      await sb.click(); await page.getByRole('switch', { name: 'Record and transcribe' }).isChecked().catch(() => {});
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await sb.filter({ hasText: 'In session' }).waitFor({ timeout: 6000 }).catch(() => problems.push(`${label}: the session did not start`));
      await end().catch(() => problems.push(`${label}: the session did not end`));
    }
    check(await page.locator('.dmx-top').evaluate((n) => n.getBoundingClientRect().height <= 64), `${label}: the top bar takes more than one line`);
    await ctx.close();
  }

  // ---- 2. the GM flows (desktop) ---------------------------------------------
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
  check((await dm.locator('main').innerText()).includes('GM only'), 'generators: the NPC secret is not marked GM only');
  await dm.getByRole('button', { name: 'Save', exact: true }).click();
  await dm.getByText(/Saved .*Generated\/NPCs/).waitFor({ timeout: 15000 });
  await go(dm, 'generators');
  await dm.getByRole('tab', { name: 'Maps' }).click();
  await dm.getByRole('button', { name: /^Dungeon/ }).click();
  await dm.locator('.gen-map img').waitFor({ timeout: 15000 });
  await dm.getByRole('button', { name: 'Save', exact: true }).click();
  await dm.getByText(/Saved .*Generated\/Maps/).waitFor({ timeout: 15000 });
  const mapsList = (await api('GET', '/files/maps')).json ?? [];
  check(mapsList.some((m) => /\(GM\)\.png$/.test(m.name)), 'generators: the saved dungeon map is not on the Map page list');
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
  check((await pl.locator('main').innerText()).includes('Come to the Salty Dog'), 'stage: the player does not see the card the GM showed');
  check(!(await pl.locator('main').innerText()).includes('Council secrets'), 'stage: GM-only text on the player stage');
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
