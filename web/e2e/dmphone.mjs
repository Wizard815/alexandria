// End-to-end test of the DM phone assistant (/w/:world/dm/phone) on the seeded
// demo world (fake models), at a normal phone (390x844) and the Fold's
// near-square inner screen (700x850). Each tab loads, an HP change from the
// phone reaches the desktop combat page and the players' view (health as the
// setting allows), approving from the Queue works, the agent chat answers, and
// nothing logs a console error or scrolls sideways.
// Run from web/: npm run build && node e2e/dmphone.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = Number(process.env.DMPHONE_E2E_PORT || 8200);
const base = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-dmphone-e2e-'));
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'librarian/scripts/demo.ts', '--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => process.stderr.write('[demo] ' + d));
for (let i = 0; i < 150 && !out.includes('Alexandria demo is running'); i++) await new Promise((r) => setTimeout(r, 200));
if (!out.includes('Alexandria demo is running')) { console.log(out); srv.kill(); console.log('demo did not start'); process.exit(1); }

const PASS = { dm: 'dungeon master 123', jess: 'player pass 123' };
const login = async (u) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: PASS[u] }) })).json()).token;
const tokDM = await login('dm');
const tokJess = await login('jess');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tokDM } })).json())[0].id;
const api = async (tok, m, p, b) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };
const dm = (m, p, b) => api(tokDM, m, p, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fight, the setting, and something waiting in the queue.
await dm('PATCH', '/settings', { monsterHealth: 'exact', initiativeVisible: true });
await dm('POST', '/live/combatants', { name: 'Sera Vane', initiative: 18, hp: 30, maxHp: 30 });
const gob = (await dm('POST', '/live/combatants', { name: 'Goblin boss', initiative: 14, hp: 21, maxHp: 21 })).id;
await dm('POST', '/live/combatants', { name: 'Wolf', initiative: 12, hp: 11, maxHp: 11 });
await dm('POST', '/live/combatants', { name: 'Marsh rat', initiative: 3, hp: 4, maxHp: 4 });
await dm('PUT', '/live/combat', { active: true, round: 1, turn: 0 });
const led = await api(tokJess, 'POST', '/live/ledger', { owner: 'me', amountCp: 700, note: 'Sold a spare dagger' });
const pendingBefore = (await dm('GET', '/approvals')).counts.coin;

const browser = await chromium.launch();
const quiet = (t) => /Failed to load resource.*(40[1349]|5\d\d)|fonts\.g|net::ERR_|ResizeObserver/.test(t);
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console: ${m.text()}`); });
};
async function signIn(viewport, mobile, who) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  watch(page, who);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill('dm');
  await page.getByLabel(/password/i).fill(PASS.dm);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL('**/dm', { timeout: 15000 });
  return { ctx, page };
}
const tab = (page, name) => page.getByRole('tab', { name: new RegExp('^' + name) }).first();
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function tour(page, label, wide) {
  const R = `${base}/w/saltreach/dm/phone`;
  await page.goto(R);
  await page.getByTestId('dmphone').waitFor({ timeout: 10000 });
  check((await page.getByTestId('dmphone').getAttribute('data-layout')) === (wide ? 'two-pane' : 'one-pane'), `${label}: wrong layout`);
  const expect = { Now: /Next turn|Start combat/, Remote: /Stop all sound/, Queue: /coin requests|broker|player requests|nothing is waiting/i, Notes: /Transcript/ };
  for (const [name, re] of Object.entries(expect)) {
    await tab(page, name).click();
    await page.waitForTimeout(600);
    const txt = await page.locator('[role=tabpanel]:visible').allInnerTexts();
    check(re.test(txt.join('\n')), `${label}: ${name} tab did not load (${txt.join(' ').slice(0, 80)})`);
    check((await sideways(page)) <= 1, `${label}: ${name} scrolls sideways`);
  }
  // Touch targets: every visible control is at least 48px each way (icon-only included).
  await tab(page, 'Now').click();
  const small = await page.evaluate(() => [...document.querySelectorAll('.dmp button, .dmp a.b, .dmp input, .dmp textarea, .dmp select')].filter((e) => e.offsetParent && !e.closest('[hidden]')).map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height), pill: e.classList.contains('pill') }; }).filter((b) => !b.pill && (b.h < 47 || b.w < 47)));
  check(!small.length, `${label}: small touch targets: ${small.map((b) => `${b.n} ${b.w}x${b.h}`).join(', ')}`);
  if (wide) {
    const both = await page.evaluate(() => [...document.querySelectorAll('[role=tabpanel]')].filter((p) => p.offsetParent !== null).map((p) => p.getAttribute('aria-label')));
    check(both.includes('Now') && both.includes('Ask'), `${label}: two-pane shows ${both.join(', ')} not Now + Ask`);
  }
  note(`${label}: tabs load, no sideways scroll`);
}

try {
  // ---- phone ----------------------------------------------------------------
  const { ctx, page } = await signIn({ width: 390, height: 844 }, true, 'phone');
  const desk = await signIn({ width: 1280, height: 800 }, false, 'desktop');
  await desk.page.goto(`${base}/w/saltreach/dm/combat`);
  await desk.page.locator('main').waitFor();

  // The banner on the DM's table page, dismissible and remembered.
  await page.goto(`${base}/w/saltreach/dm`);
  await page.getByTestId('phone-banner').waitFor({ timeout: 10000 });
  check(/Open the phone assistant/.test(await page.getByTestId('phone-banner').innerText()), 'banner text');
  await page.getByTestId('phone-banner').getByRole('button', { name: 'Dismiss' }).click();
  await page.reload();
  await page.locator('main').waitFor();
  await page.waitForTimeout(500);
  check((await page.getByTestId('phone-banner').count()) === 0, 'banner came back after dismissing');
  note('banner shows, dismisses and is remembered');

  await tour(page, 'phone 390x844', false);

  // HP: -5 on the Goblin boss from the phone; the desktop and the players see it.
  await tab(page, 'Now').click();
  await page.getByRole('button', { name: /^Goblin boss/ }).click();
  await page.getByRole('button', { name: '−5' }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid=hp-now]')?.textContent?.startsWith('16'), null, { timeout: 8000 });
  const c1 = await dm('GET', '/live/combat');
  check(c1.combatants.find((x) => x.id === gob)?.hp === 16, 'the server did not get HP 16');
  const pv = await api(tokJess, 'GET', '/live/combat');
  check(pv.combatants?.find((x) => x.name === 'Goblin boss')?.health === '16/21', `players should see 16/21 (setting: exact), got ${JSON.stringify(pv.combatants?.find((x) => x.name === 'Goblin boss'))}`);
  check(!JSON.stringify(pv).includes('"hp"'), 'the players\' view must not carry raw hp fields');
  await desk.page.waitForFunction(() => /16\s*\/\s*21/.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 8000 }).catch(() => problems.push('the desktop combat page did not show 16 / 21'));
  note('HP -5 reached the server, the desktop combat page and the players (16/21)');
  // Undo toast
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(800);
  check((await dm('GET', '/live/combat')).combatants.find((x) => x.id === gob)?.hp === 21, 'Undo did not restore HP');
  // Next turn
  await page.getByRole('button', { name: /^Next turn/ }).click();
  await page.waitForTimeout(800);
  check((await dm('GET', '/live/combat')).turn === 1, 'Next turn did not advance');
  note('undo and next turn work');

  // Queue: approve the coin request.
  await tab(page, 'Queue').click();
  await page.getByRole('group', { name: /Sold a spare|Sera|Jess|party|gp|sp|cp/i }).first().waitFor({ timeout: 8000 }).catch(() => {});
  check(pendingBefore >= 1 && led.id, 'the demo gave no pending coin request to approve');
  const card = page.locator('[aria-label="Coin requests"] [role=group]').first();
  await card.getByRole('button', { name: 'Approve' }).click();
  await page.waitForTimeout(1000);
  check((await dm('GET', '/approvals')).counts.coin === pendingBefore - 1, 'approving from the queue did not clear the coin request');
  note('Queue: approved a coin request in one tap');

  // Ask: the agent answers.
  await tab(page, 'Ask').click();
  await page.getByPlaceholder('Ask…').fill('Summarise the Lantern Hall in one line');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=ask-log] .msg')].filter((m) => !m.classList.contains('me') && m.textContent.trim().length > 3 && !/Thinking/.test(m.textContent)).length >= 1, null, { timeout: 30000 }).catch(() => problems.push('the agent chat did not answer'));
  note('Ask: the agent replied');

  // Notes: quick gen and a DM-only prep note.
  await tab(page, 'Notes').click();
  await page.getByRole('tab', { name: 'Quick gen' }).click();
  await page.getByRole('button', { name: 'Names', exact: true }).click();
  await page.getByTestId('gen-out').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Add to note' }).click();
  await page.getByLabel('Title (optional)').fill('Phone e2e note');
  await page.getByRole('button', { name: 'Save as DM-only' }).click();
  await page.waitForTimeout(800);
  const dmPages = await dm('GET', '/library/pages');
  const saved = dmPages.find?.((p) => p.title === 'Phone e2e note');
  check(saved && saved.visibility === 'dm', `prep note should be saved DM-only (got ${saved?.visibility})`);
  const jessPages = await api(tokJess, 'GET', '/library/pages');
  check(!JSON.stringify(jessPages).includes('Phone e2e note'), 'a DM-only phone note is visible to a player');
  note('Notes: quick gen and a DM-only prep note');
  await ctx.close();
  await desk.ctx.close();

  // ---- Fold inner screen -----------------------------------------------------
  const f = await signIn({ width: 700, height: 850 }, true, 'fold');
  await tour(f.page, 'fold 700x850', true);
  // The Queue tab in the left pane, Ask stays on the right.
  await tab(f.page, 'Queue').click();
  await f.page.waitForTimeout(500);
  check((await f.page.locator('[role=tabpanel]:visible').count()) === 2, 'fold: should show two panes');
  await f.ctx.close();
} catch (e) {
  problems.push('flow failed: ' + e.message.split('\n')[0]);
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('dmphone e2e ok');
