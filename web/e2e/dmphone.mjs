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

// A fake microphone, so hold-to-talk records something the demo's fake speech model turns into text.
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const quiet = (t) => /Failed to load resource.*(40[1349]|5\d\d)|fonts\.g|net::ERR_|ResizeObserver/.test(t);
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console: ${m.text()}`); });
};
async function signIn(viewport, mobile, who) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile, permissions: ['microphone'] });
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

// ---- the Ask tab: the real chat in its phone layout ----------------------------------------------
const box = (page) => page.getByPlaceholder(/^Ask/);
const sendText = async (page, text) => { await box(page).fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click(); };
const replied = (page, re, what) => page.waitForFunction((src) => [...document.querySelectorAll('[data-testid=ask-log] .msg:not(.me)')].some((m) => new RegExp(src).test(m.textContent)), re.source, { timeout: 30000 }).then(() => true).catch(() => { problems.push(`${what}: no reply matching ${re}`); return false; });
const queueCount = (page) => page.evaluate(() => { const t = [...document.querySelectorAll('.dmp-tab')].find((x) => /^Queue/.test(x.getAttribute('aria-label') || '')); return Number(/(\d+) waiting/.exec(t?.getAttribute('aria-label') || '')?.[1] ?? 0); });
const approvalCard = (page) => page.getByRole('group', { name: 'Waiting for your approval' }).first();

async function askTour(page, label, wide) {
  await tab(page, 'Ask').click();
  await box(page).waitFor({ timeout: 8000 });

  // Start from a chat of our own, so its title (the first message) is known below.
  const empty = () => page.waitForFunction(() => document.querySelectorAll('[data-testid=ask-log] .msg').length === 0, null, { timeout: 8000 }).catch(() => problems.push(`${label}: a new chat should be empty`));
  if (await page.getByRole('button', { name: 'New chat', exact: true }).count()) { await page.getByRole('button', { name: 'New chat', exact: true }).click(); await empty(); }
  // A typed message and its streamed reply.
  await sendText(page, 'Summarise the Lantern Hall in one line');
  await replied(page, /You said: "Summarise the Lantern Hall/, `${label} typed message`);
  // One tap on a quick prompt sends it.
  await page.getByRole('button', { name: 'Who is concentrating?' }).click();
  await replied(page, /You said: "Who is concentrating/, `${label} quick prompt`);
  // The input is big and pinned just above the tab bar (a side rail on the Fold).
  const inp = await box(page).boundingBox();
  check(inp.height >= 52, `${label}: the message box is only ${inp.height}px tall`);
  if (!wide) check(inp.y + inp.height <= (await page.locator('.dmp-tabs').boundingBox()).y + 1, `${label}: the message box is not above the tab bar`);
  note(`${label}: Ask answered a typed message and a quick prompt`);

  // Past chats: start one, name it, go back, come again, delete it.
  const sel = page.getByTestId('ag-chat-select');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await empty();
  await page.getByRole('button', { name: 'Rename this chat' }).click();
  await page.getByLabel('Chat name').fill('Table talk');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=ag-chat-select] option')].some((o) => /^Table talk/.test(o.textContent)), null, { timeout: 8000 }).catch(() => problems.push(`${label}: the rename did not show`));
  const old = await page.evaluate(() => [...document.querySelectorAll('[data-testid=ag-chat-select] option')].find((o) => /^Summarise/.test(o.textContent))?.value);
  check(!!old, `${label}: the first chat is not in the switcher`);
  if (old) {
    await sel.selectOption(old);
    await replied(page, /You said: "Summarise the Lantern Hall/, `${label} back in the first chat`);
    const talk = await page.evaluate(() => [...document.querySelectorAll('[data-testid=ag-chat-select] option')].find((o) => /^Table talk/.test(o.textContent))?.value);
    await sel.selectOption(talk);
    await page.getByRole('button', { name: 'Delete this chat' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=ag-chat-select] option')].some((o) => /^Table talk/.test(o.textContent)), null, { timeout: 8000 }).catch(() => problems.push(`${label}: the chat was not deleted`));
  }
  note(`${label}: chat switcher: new, rename, switch, delete`);

  // An approval card in the chat: big buttons, counted in the Queue badge, and approving clears both.
  const before = await queueCount(page);
  await sendText(page, 'Next turn: call next_turn');
  const card = approvalCard(page);
  await card.waitFor({ timeout: 20000 }).catch(() => problems.push(`${label}: no approval card appeared`));
  const ab = await card.getByRole('button', { name: 'Approve' }).boundingBox();
  check(ab && ab.height >= 60 && ab.width >= 100, `${label}: the Approve button is small (${ab?.width}x${ab?.height})`);
  await page.waitForFunction((n) => { const t = [...document.querySelectorAll('.dmp-tab')].find((x) => /^Queue/.test(x.getAttribute('aria-label') || '')); return Number(/(\d+) waiting/.exec(t?.getAttribute('aria-label') || '')?.[1] ?? 0) === n; }, before + 1, { timeout: 8000 }).catch(() => problems.push(`${label}: the Queue badge did not count the proposal`));
  await card.getByRole('button', { name: 'Approve' }).click();
  await card.waitFor({ state: 'detached', timeout: 10000 }).catch(() => problems.push(`${label}: the card stayed after approving`));
  check(((await dm('GET', '/agent/actions')).actions ?? []).length === 0, `${label}: approving in the chat left a pending action`);
  await page.waitForFunction((n) => { const t = [...document.querySelectorAll('.dmp-tab')].find((x) => /^Queue/.test(x.getAttribute('aria-label') || '')); return Number(/(\d+) waiting/.exec(t?.getAttribute('aria-label') || '')?.[1] ?? 0) === n; }, before, { timeout: 8000 }).catch(() => problems.push(`${label}: the badge did not drop after approving in the chat`));
  await replied(page, /Done: /, `${label} approval result`);
  note(`${label}: approval card approved in the chat, badge followed`);

  // The other way round: approve in the Queue and the chat card goes (live, with both on screen on the Fold).
  await sendText(page, 'Next turn: call next_turn');
  await card.waitFor({ timeout: 20000 }).catch(() => problems.push(`${label}: no second approval card`));
  await tab(page, 'Queue').click();
  await page.locator('[aria-label="The assistant wants to"] [role=group]').first().getByRole('button', { name: 'Approve' }).click();
  await tab(page, 'Ask').click();
  await card.waitFor({ state: 'detached', timeout: 10000 }).catch(() => problems.push(`${label}: the chat card stayed after approving in the Queue`));
  check(((await dm('GET', '/agent/actions')).actions ?? []).length === 0, `${label}: approving in the Queue left a pending action`);
  note(`${label}: approval from the Queue cleared the chat card`);

  // The combatant picked on Now goes along with the question.
  await tab(page, 'Now').click();
  await page.locator('.dmp .who').first().click();
  await page.getByRole('button', { name: /Ask the assistant about this/ }).click();
  const chip = page.getByRole('button', { name: /^Do not send / });
  await chip.waitFor({ timeout: 5000 }).catch(() => problems.push(`${label}: the combatant was not attached in Ask`));
  await tab(page, 'Ask').click();
  await sendText(page, 'How hurt is this one?');
  await replied(page, /You said: "How hurt is this one/, `${label} with a combatant attached`);
  check((await chip.count()) === 1, `${label}: the attached combatant should stay until dropped`);
  await chip.click();
  check((await page.getByRole('button', { name: /^Attach / }).count()) === 1, `${label}: after dropping, the current turn should be offered`);
  note(`${label}: a combatant attached from Now and dropped`);

  // The session so far, folded away until asked for.
  const st = await dm('GET', '/audio/status');
  const sid = st.session?.id ?? st.lastSession?.id;
  if (sid) await dm('POST', `/audio/sessions/${sid}/summary/refresh`, {});
  const sofar = page.getByTestId('sofar');
  await sofar.waitFor({ timeout: 8000 }).catch(() => problems.push(`${label}: no session summary card`));
  const head = sofar.getByRole('button').first();
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  check((await head.getAttribute('aria-expanded')) === 'true', `${label}: the summary card did not open`);
  check((await page.locator('#sofar-body').innerText()).trim().length > 5, `${label}: the summary card is empty`);
  await head.click();
  check((await page.locator('#sofar-body').count()) === 0, `${label}: the summary card did not fold`);
  note(`${label}: session-so-far card opens and folds`);

  // Hold to talk: the fake microphone and the demo's fake speech model put text in the box.
  const mic = page.getByTestId('ag-mic');
  if (await mic.count()) {
    const m = await mic.boundingBox();
    await box(page).fill('');
    await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForFunction(() => (document.querySelector('[data-ag-input]')?.value ?? '').trim().length > 0, null, { timeout: 15000 }).catch(() => problems.push(`${label}: hold-to-talk put nothing in the box`));
    await box(page).fill('');
    note(`${label}: hold-to-talk dictated into the box`);
  } else problems.push(`${label}: no mic button`);

  // Quick prompts are the DM's own: add one, and it is still there after a reload.
  await page.getByTestId('quick-edit').click();
  const dlg = page.getByRole('dialog', { name: 'Quick prompts' });
  await dlg.getByRole('button', { name: 'Add a prompt' }).click();
  await dlg.getByLabel('Button').last().fill('Zap check');
  await dlg.getByLabel('What it asks').last().fill('Zap check please');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Zap check', exact: true }).waitFor({ timeout: 5000 }).catch(() => problems.push(`${label}: the new quick prompt did not appear`));
  await page.reload();
  await page.getByTestId('dmphone').waitFor({ timeout: 10000 });
  await tab(page, 'Ask').click();
  await page.getByRole('button', { name: 'Zap check', exact: true }).click();
  await replied(page, /You said: "Zap check please/, `${label} edited quick prompt`);
  note(`${label}: quick prompt added, remembered and sent`);

  const small = await page.evaluate(() => [...document.querySelectorAll('.dmp button, .dmp a.b, .dmp input, .dmp textarea, .dmp select')].filter((e) => e.offsetParent && !e.closest('[hidden]') && e.closest('[role=tabpanel]')?.getAttribute('aria-label') === 'Ask').map((e) => { const r = e.getBoundingClientRect(); return { n: (e.getAttribute('aria-label') || e.textContent || e.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height), pill: e.classList.contains('pill') }; }).filter((b) => !b.pill && (b.h < 47 || b.w < 47)));
  check(!small.length, `${label}: Ask has small touch targets: ${small.map((b) => `${b.n} ${b.w}x${b.h}`).join(', ')}`);
  check((await sideways(page)) <= 1, `${label}: Ask scrolls sideways`);
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
  check((await page.getByTestId('phone-banner').boundingBox()).height < 140, 'banner is one row, not a full screen');
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

  await askTour(page, 'phone 390x844', false);

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
  await askTour(f.page, 'fold 700x850', true);
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
