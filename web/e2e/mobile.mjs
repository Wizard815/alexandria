// Phone audit for the player app: signs in as a player on a small Android, an iPhone and a
// bigger Android, visits every player page and reports sideways scrolling, elements wider than
// the screen, touch targets under 40x40, inputs under 16px (iOS zooms them), text under 12px and
// console errors. Also checks the tab bar, pinning (survives a reload, reset), the grouped More
// menu (every page is in some group) and that a world with the broker off hides Broker.
// Run from web/: npm run build && node e2e/mobile.mjs
//   MOBILE_PORT, MOBILE_SHOTS=<dir> (screenshots), MOBILE_VERBOSE=1 (list every finding), MOBILE_ONLY=<route>
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet, PLAYER_ROUTES } from './lib.mjs';

const PORT = Number(process.env.MOBILE_PORT || 8841);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.MOBILE_SHOTS || '/tmp/claude-0/-home-user/26e3dbe6-7466-590f-acf8-13740003567a/scratchpad/mobile';
const VERBOSE = !!process.env.MOBILE_VERBOSE;
fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const note = (m) => console.log('  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('mobile'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tokDM = await login('dm', 'dungeon master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tokDM } })).json())[0].id;
const dm = async (method, p, body) => (await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokDM }, body: body ? JSON.stringify(body) : undefined })).json().catch(() => ({}));

// Something to look at: a fight with a turn, a quick event, a chat line.
await dm('POST', '/live/combatants', { name: 'Sera Vane', initiative: 18, hp: 30, maxHp: 30 });
await dm('POST', '/live/combatants', { name: 'Goblin boss', initiative: 14, hp: 21, maxHp: 21 });
await dm('PUT', '/live/combat', { active: true, round: 1, turn: 0 });

const PROFILES = [
  { name: 'android-360', viewport: { width: 360, height: 800 }, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36', dpr: 3 },
  { name: 'iphone-390', viewport: { width: 390, height: 844 }, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', dpr: 3 },
  { name: 'android-412', viewport: { width: 412, height: 915 }, ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36', dpr: 2.625 },
];

const browser = await chromium.launch();

async function open(profile, user = 'jess', pass = 'player pass 123') {
  const ctx = await browser.newContext({ viewport: profile.viewport, userAgent: profile.ua, isMobile: true, hasTouch: true, deviceScaleFactor: profile.dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  await page.waitForSelector('[data-testid=tabbar]');
  return { ctx, page, errors };
}

// Runs inside the page. Returns what is wrong on the current screen.
const AUDIT = () => {
  const vw = window.innerWidth;
  const out = { scrollW: document.scrollingElement.scrollWidth, vw, wide: [], small: [], inputs: [], text: [] };
  const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('href') || '').trim().replace(/\s+/g, ' ').slice(0, 28)}"`;
  const shown = (e) => { const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const inScroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.getBoundingClientRect().width <= vw + 1) return true; if (s.position === 'fixed') return false; } return false; };
  const sr = (e) => !!e.closest('.sr-only, [aria-hidden=true]:not(button):not(a)');
  const all = [...document.querySelectorAll('body *')].filter((e) => !/^(SCRIPT|STYLE|HEAD|META|LINK|TITLE|NOSCRIPT|PATH|G|CIRCLE|RECT|LINE|POLYLINE|DEFS|USE)$/i.test(e.tagName) && !(e instanceof SVGElement && e.tagName !== 'svg'));
  for (const e of all) {
    if (!shown(e) || sr(e)) continue;
    const r = e.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !inScroller(e) && getComputedStyle(e).position !== 'fixed' && !e.closest('.bottomnav.kb-open')) out.wide.push(`${desc(e)} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  const SEL = 'button, a[href], [role=button], [role=tab], [role=switch], [role=menuitem], summary, select, input:not([type=hidden])';
  for (const e of document.querySelectorAll(SEL)) {
    if (!shown(e) || sr(e)) continue;
    const s = getComputedStyle(e);
    const isInput = /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName);
    if (e.tagName === 'A' && s.display === 'inline') continue; // an inline link in a sentence
    if (e.matches('input[type=file]') || e.closest('.sr-only')) continue;
    let r = e.getBoundingClientRect();
    if (e.matches('input[type=checkbox], input[type=radio]')) { const l = e.closest('label'); if (l) r = l.getBoundingClientRect(); }
    if (r.width < 40 || r.height < 40) out.small.push(`${desc(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (isInput && !e.matches('input[type=checkbox], input[type=radio], input[type=range], input[type=file], input[type=color]') && parseFloat(s.fontSize) < 16) out.inputs.push(`${desc(e)} ${s.fontSize}`);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim()) continue;
    const e = n.parentElement;
    if (!e || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(e.tagName) || !shown(e) || sr(e) || e.closest('.fa-solid, i')) continue;
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if (fs < 12) out.text.push(`${desc(e)} ${fs}px "${n.nodeValue.trim().slice(0, 24)}"`);
  }
  return out;
};

const shot = async (page, profile, name) => { try { await page.screenshot({ path: path.join(SHOTS, `${profile.name}-${name || 'home'}.png`) }); } catch { /* page closed */ } };
const uniq = (a) => [...new Set(a)];

// ---- 1. every player page on every phone ------------------------------------------------------
const first = await open(PROFILES[0]);
await first.page.getByTestId('more-btn').click();
const navRoutes = await first.page.$$eval('[data-more]', (els) => els.map((e) => e.getAttribute('href')));
const tabRoutes = await first.page.$$eval('[data-tab]', (els) => els.map((e) => e.getAttribute('href')));
await first.ctx.close();
const toRoute = (h) => h.replace(/^\/w\/saltreach\/?/, '').replace(/#.*/, '');
const ROUTES = uniq([...PLAYER_ROUTES, ...navRoutes.map(toRoute), ...tabRoutes.map(toRoute)]).filter((r) => !process.env.MOBILE_ONLY || r === process.env.MOBILE_ONLY);

const totals = {};
for (const profile of PROFILES) {
  const { ctx, page, errors } = await open(profile);
  console.log(`${profile.name}  ${profile.viewport.width}x${profile.viewport.height}`);
  for (const r of ROUTES) {
    errors.length = 0;
    await page.goto(`${base}/w/saltreach/${r}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=tabbar]');
    await sleep(900);
    const a = await page.evaluate(AUDIT);
    const label = `${profile.name} /${r}`;
    const bad = [];
    if (a.scrollW > a.vw) bad.push(`sideways scroll (${a.scrollW} > ${a.vw})`);
    for (const [k, v] of [['wider than screen', a.wide], ['target < 40px', a.small], ['input < 16px', a.inputs], ['text < 12px', a.text]]) {
      if (v.length) bad.push(`${k}: ${uniq(v).length}${VERBOSE ? ' [' + uniq(v).slice(0, 8).join(' | ') + ']' : ''}`);
    }
    if (errors.length) bad.push(`console: ${uniq(errors).join(' | ').slice(0, 200)}`);
    for (const b of bad) { problems.push(`${label}: ${b}`); totals[b.split(':')[0].replace(/\(.*/, '').trim()] = (totals[b.split(':')[0].replace(/\(.*/, '').trim()] || 0) + 1; }
    note(`${bad.length ? 'FAIL' : 'ok  '} /${r || '(home)'}${bad.length ? '  ' + bad.join('; ') : ''}`);
    if (profile.name !== 'android-412' || bad.length) await shot(page, profile, r.replace(/\//g, '_') || 'home');
  }
  // Pop-ups: the More sheet and the quick-event prompt.
  await page.goto(`${base}/w/saltreach/`);
  await page.waitForSelector('[data-testid=tabbar]');
  await page.getByTestId('more-btn').click();
  await page.getByTestId('more-sheet').waitFor();
  await sleep(200);
  const sheet = await page.evaluate(AUDIT);
  for (const [k, v] of [['more: target < 40px', sheet.small], ['more: input < 16px', sheet.inputs], ['more: text < 12px', sheet.text], ['more: wider than screen', sheet.wide]]) if (v.length) problems.push(`${profile.name} ${k}: ${uniq(v).slice(0, 6).join(' | ')}`);
  check(sheet.scrollW <= sheet.vw, `${profile.name} more sheet scrolls sideways`);
  const box = await page.getByTestId('more-sheet').boundingBox();
  check(box && box.y + box.height <= profile.viewport.height + 1 && box.y >= 0, `${profile.name} more sheet does not fit the screen`);
  await shot(page, profile, '_more');
  await page.keyboard.press('Escape');
  await ctx.close();
}

// ---- 2. quick event prompt is a bottom sheet -----------------------------------------------------
{
  const p = PROFILES[1];
  const { ctx, page } = await open(p);
  await dm('POST', '/quick-events', { kind: 'notice', title: 'A sound in the reeds', prompt: 'Something moves out there.', skill: 'Perception', dc: 12 });
  const modal = page.locator('.modal[role=dialog]');
  const ok = await modal.waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (check(ok, 'quick event prompt did not appear')) {
    const b = await modal.boundingBox();
    check(b.y + b.height >= p.viewport.height - 2 && b.width >= p.viewport.width - 2, `quick event is not a bottom sheet (${JSON.stringify(b)})`);
    check(b.y >= 0, 'quick event sheet is taller than the screen');
    const a = await page.evaluate(AUDIT);
    for (const [k, v] of [['quick event: target < 40px', a.small], ['quick event: input < 16px', a.inputs], ['quick event: wider', a.wide]]) if (v.length) problems.push(`${k}: ${uniq(v).join(' | ')}`);
    await shot(page, p, '_quick-event');
    note('quick event shows as a bottom sheet');
    await page.getByRole('button', { name: 'Roll for me' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    check(await modal.count() === 0, 'quick event sheet did not close');
  }
  await ctx.close();
}

// ---- 3. tab bar, pinning, grouped More ---------------------------------------------------------
{
  const p = PROFILES[1];
  const { ctx, page } = await open(p);
  const tabs = async () => (await page.$$eval('[data-tab]', (els) => els.map((e) => e.getAttribute('data-tab'))));
  const def = await tabs();
  check(JSON.stringify(def) === JSON.stringify(['', 'live', 'assistant', 'inventory']), `default tabs are ${JSON.stringify(def)}`);
  check((await page.$$('.bottomnav > *')).length === 5, 'tab bar is not 4 tabs + More');
  const more = async () => { await page.getByTestId('more-btn').click(); await page.getByTestId('more-sheet').waitFor(); };
  await more();
  // every page of the desktop nav is in some group
  const groupsOf = await page.$$eval('[data-group]', (gs) => gs.map((g) => ({ g: g.getAttribute('data-group'), items: [...g.querySelectorAll('[data-more]')].map((a) => a.getAttribute('data-more')) })));
  const inGroups = groupsOf.flatMap((x) => x.items);
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dpage = await desk.newPage();
  await dpage.goto(base + '/login');
  await dpage.getByLabel(/username/i).fill('jess');
  await dpage.getByLabel(/password/i).fill('player pass 123');
  await dpage.getByRole('button', { name: /sign in|log in/i }).click();
  await dpage.waitForURL(/\/w\/saltreach/);
  await dpage.waitForSelector('.topnav');
  const topLinks = (await dpage.$$eval('.topnav a', (els) => els.map((e) => e.getAttribute('href')))).map(toRoute);
  const dTabs = await dpage.$$eval('.bottomnav', (e) => getComputedStyle(e[0]).display);
  check(dTabs === 'none', 'bottom bar shows on desktop');
  for (const l of topLinks) check(inGroups.includes(l), `nav item "/${l}" is not in any More group`);
  check(groupsOf.length >= 4, `More has ${groupsOf.length} groups`);
  note(`More groups: ${groupsOf.map((x) => `${x.g} (${x.items.length})`).join(', ')}`);
  // desktop is unchanged: the top nav lists the same pages
  check(topLinks.length >= 18, `desktop top nav has only ${topLinks.length} links`);
  await dpage.screenshot({ path: path.join(SHOTS, 'desktop-home.png') });
  await desk.close();
  // search
  await page.getByLabel('Find a page').fill('mic');
  check((await page.$$('[data-more]')).length === 1, 'More search did not narrow to one page');
  await page.getByLabel('Find a page').fill('');
  // pin: the bar is full, so one comes off first
  await page.getByRole('button', { name: 'Pin Map to the tab bar' }).click();
  check(await page.getByText(/holds 4/).isVisible(), 'no message when the tab bar is full');
  await page.getByRole('button', { name: 'Unpin Inventory from the tab bar' }).click();
  await page.getByRole('button', { name: 'Pin Map to the tab bar' }).click();
  check(JSON.stringify(await tabs()) === JSON.stringify(['', 'live', 'assistant', 'map']), `after pinning Map the tabs are ${JSON.stringify(await tabs())}`);
  await page.getByRole('button', { name: 'Edit tabs' }).click();
  await page.getByRole('button', { name: 'Move Map earlier' }).click();
  check(JSON.stringify(await tabs()) === JSON.stringify(['', 'live', 'map', 'assistant']), `after moving Map the tabs are ${JSON.stringify(await tabs())}`);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('[data-testid=tabbar]');
  check(JSON.stringify(await tabs()) === JSON.stringify(['', 'live', 'map', 'assistant']), `pins did not survive a reload: ${JSON.stringify(await tabs())}`);
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('alx.tabs.')));
  check(stored.length === 1 && stored[0] === 'alx.tabs.saltreach', `pins are kept under ${JSON.stringify(stored)}`);
  await page.getByTestId('tabbar').getByRole('link', { name: 'Map' }).click();
  await page.waitForURL(/\/map$/);
  check(await page.locator('.bottomnav a.active', { hasText: 'Map' }).count() === 1, 'pinned tab is not marked active');
  await shot(page, p, '_pinned-map');
  await more();
  await page.getByRole('button', { name: 'Edit tabs' }).click();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await page.keyboard.press('Escape');
  check(JSON.stringify(await tabs()) === JSON.stringify(def), `reset did not restore the default: ${JSON.stringify(await tabs())}`);
  await page.reload();
  await page.waitForSelector('[data-testid=tabbar]');
  check(JSON.stringify(await tabs()) === JSON.stringify(def), 'reset did not survive a reload');
  await ctx.close();
}

// ---- 4. the world turned the broker off -------------------------------------------------------------
{
  await dm('PATCH', '/settings', { brokerEnabled: false, calendar: 'off' });
  const { ctx, page } = await open(PROFILES[0]);
  const tabs = await page.$$eval('[data-tab]', (els) => els.map((e) => e.getAttribute('data-tab')));
  check(!tabs.includes('broker'), 'broker is in the tab bar with the broker off');
  check(tabs.length === 4, `tab bar has ${tabs.length} tabs with the broker off`);
  await page.getByTestId('more-btn').click();
  await page.getByTestId('more-sheet').waitFor();
  check((await page.$$('[data-more=broker]')).length === 0, 'Broker is in More with the broker off');
  check((await page.$$('[data-more=calendar]')).length === 0, 'Calendar is in More with the calendar off');
  check((await page.$$('[data-more=assistant]')).length === 1, 'Ask went away with only the broker off');
  await page.keyboard.press('Escape');
  await page.goto(`${base}/w/saltreach/assistant`);
  await page.waitForSelector('[data-testid=tabbar]');
  check(await page.getByTestId('ask-broker').count() === 0, 'Ask still offers the broker when it is off');
  await ctx.close();
  await dm('PATCH', '/settings', { brokerEnabled: true, calendar: 'builtin' });
}

await browser.close();
srv.kill();
console.log('');
if (Object.keys(totals).length) console.log('findings by kind:', JSON.stringify(totals));
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(' - ' + p);
  console.log('\nFAIL (screenshots in ' + SHOTS + ')');
  process.exit(1);
}
console.log('mobile: all good (screenshots in ' + SHOTS + ')');
