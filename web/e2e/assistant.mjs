// End-to-end test of the GM's assistant chat on the demo world (fake models): a proposed change shows as an approval
// card while it streams and after a reload, approving flips the card to Done at once (well under a second) and applies
// it, two cards approved back to back each take well under a second, the Auto switch persists and applies to the very
// next change (a card that always asks still waits), the pop-out window and the GM phone's Ask tab show the same cards
// and the same mode, and a decision made on one screen reaches the other.
// Run from web/: npm run build && node e2e/assistant.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.ASSISTANT_E2E_PORT || 8211);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST_MS = 1000;

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('assistant'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tok = await login('dm', 'game master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tok } })).json())[0].id;
const api = async (m, p, b) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };
const combatant = async (name) => ((await api('GET', '/live/combat')).combatants ?? []).find((c) => c.name === name);
const pendingActions = async () => (await api('GET', '/agent/actions')).actions ?? [];
const say = (names) => names.map((n, i) => `FAKE_CALL add_combatant {"name":"${n}","hp":7,"initiative":${5 + i}}`).join('\n');

const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console: ${m.text()}`); });
};
const card = (page, status) => page.locator(`[data-testid=action-card]${status ? `[data-status=${status}]` : ''}`);
/** Click Approve on the first waiting card and time how long until that card shows Done. */
async function approveTimed(page, label) {
  const done = await card(page, 'done').count();
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  await page.waitForFunction((c) => document.querySelectorAll('[data-testid=action-card][data-status=done]').length > c, done, { timeout: 5000 }).catch(() => problems.push(`${label}: the card never showed Done`));
  const ms = Date.now() - t0;
  check(ms < FAST_MS, `${label}: approving took ${ms} ms (limit ${FAST_MS})`);
  return ms;
}

try {
  await api('PATCH', '/settings', { agentAuto: false });
  const { ctx, page } = await signIn(browser, base, 'dm', 'game master 123', { width: 1400, height: 900 });
  watch(page, 'desktop');
  await page.goto(`${W}/dm`);
  await page.getByTestId('dock-agent').waitFor({ timeout: 15000 });
  await page.keyboard.press('Control+k');
  const box = page.locator('[data-ag-input]');
  await box.waitFor({ timeout: 8000 });

  // ---- the mode is shown, and starts as Ask first ----
  const sw = page.getByTestId('ag-auto');
  await sw.waitFor({ timeout: 5000 });
  check((await sw.getAttribute('aria-checked')) === 'false' && /Ask first/.test(await sw.innerText()), 'the header should say "Ask first" to start with');

  // ---- a proposal appears as a card while the reply is still being written ----
  const sent = Date.now();
  await box.fill(`Add a goblin\n${say(['Gob One'])}`);
  await page.keyboard.press('Enter');
  await card(page, 'pending').first().waitFor({ timeout: 15000 }).catch(() => problems.push('no approval card appeared'));
  note(`card appeared ${Date.now() - sent} ms after sending`);
  check(/Gob One/.test(await card(page, 'pending').first().innerText().catch(() => '')), 'the card should say what will change');
  // It is also there after a reload (read from the server, not kept in the page).
  await page.reload();
  await card(page, 'pending').first().waitFor({ timeout: 10000 }).catch(() => problems.push('the card did not survive a reload'));
  await page.waitForTimeout(800);
  if (!(await page.locator('[data-ag-input]').count())) { await page.keyboard.press('Control+k'); await page.locator('[data-ag-input]').waitFor({ timeout: 5000 }); }

  // ---- approve: instant, applied, shows Done ----
  const ms1 = await approveTimed(page, 'approve one');
  note(`approve -> Done in ${ms1} ms`);
  check(!!(await combatant('Gob One')), 'approving did not add the combatant');
  check((await pendingActions()).length === 0, 'an approved action is still pending');

  // ---- two cards, approved back to back ----
  await box.fill(`Two more\n${say(['Gob Two', 'Gob Three'])}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=action-card][data-status=pending]').length === 2, null, { timeout: 15000 }).catch(() => problems.push('two cards did not appear'));
  const a = await approveTimed(page, 'approve two (first)');
  const b = await approveTimed(page, 'approve two (second)');
  note(`two approvals back to back: ${a} ms, ${b} ms`);
  check(!!(await combatant('Gob Two')) && !!(await combatant('Gob Three')), 'the two approvals did not both apply');
  // The reply that is still being written is not blanked by a decision, and the box stays usable.
  check(!(await box.isDisabled()), 'the input locked');

  // ---- Auto mode ----
  await sw.click();
  await page.waitForFunction(() => document.querySelector('[data-testid=ag-auto]')?.getAttribute('aria-checked') === 'true', null, { timeout: 3000 }).catch(() => problems.push('the switch did not turn on'));
  check(/Auto/.test(await sw.innerText()), 'the header should say "Auto"');
  await sleep(300);
  check((await api('GET', '/settings')).agentAuto === true, 'Auto mode was not saved on the server');
  await box.fill(`Another\n${say(['Gob Four'])}`);
  await page.keyboard.press('Enter');
  await card(page, 'done').filter({ hasText: 'Applied automatically' }).first().waitFor({ timeout: 15000 }).catch(() => problems.push('Auto: no "Applied automatically" card'));
  check(!!(await combatant('Gob Four')), 'Auto: the change was not applied');
  check((await pendingActions()).length === 0, 'Auto: something still waits for approval');
  // A tool that always asks still waits, and says so.
  await box.fill('Remove that mark\nFAKE_CALL delete_map_mark {"markId":"nope"}');
  await page.keyboard.press('Enter');
  const always = card(page, 'pending').filter({ hasText: 'Always asks first' });
  await always.first().waitFor({ timeout: 15000 }).catch(() => problems.push('Auto: an always-ask tool should wait with a card that says so'));
  note('Auto applied the next change at once; the always-ask tool waited');

  // The mode survives a reload, and the pop-out window shows the same mode and the same cards.
  await page.reload();
  await page.getByTestId('ag-auto').waitFor({ timeout: 8000 }).catch(async () => { await page.keyboard.press('Control+k'); await page.getByTestId('ag-auto').waitFor({ timeout: 5000 }); });
  check((await page.getByTestId('ag-auto').getAttribute('aria-checked')) === 'true', 'Auto did not survive a reload');
  const pop = await ctx.newPage();
  watch(pop, 'pop-out');
  await pop.goto(`${W}/assistant-window`);
  await pop.getByTestId('ag-auto').waitFor({ timeout: 8000 });
  check((await pop.getByTestId('ag-auto').getAttribute('aria-checked')) === 'true', 'the pop-out window should be in Auto too');
  await card(pop, 'pending').filter({ hasText: 'Always asks first' }).first().waitFor({ timeout: 8000 }).catch(() => problems.push('the pop-out window does not show the waiting card'));

  // ---- the GM phone: the same card and the same mode ----
  const ph = await signIn(browser, base, 'dm', 'game master 123', { width: 390, height: 844 }, true, /\/w\/saltreach/);
  watch(ph.page, 'phone');
  await ph.page.goto(`${W}/dm/phone`);
  await ph.page.getByTestId('dmphone').waitFor({ timeout: 10000 });
  await ph.page.getByRole('tab', { name: /^Ask/ }).first().click();
  const pc = ph.page.getByRole('group', { name: 'Waiting for your approval' }).first();
  await pc.waitFor({ timeout: 10000 }).catch(() => problems.push('the phone Ask tab does not show the waiting card'));
  check((await ph.page.getByTestId('ag-auto').getAttribute('aria-checked')) === 'true', 'the phone should be in Auto too');
  // Turn Auto off on the phone: the desktop and pop-out follow at once, and the next change waits for a card.
  await ph.page.getByTestId('ag-auto').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=ag-auto]')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 }).catch(() => problems.push('switching Auto off on the phone did not reach the desktop'));
  await pop.waitForFunction(() => document.querySelector('[data-testid=ag-auto]')?.getAttribute('aria-checked') === 'false', null, { timeout: 5000 }).catch(() => problems.push('switching Auto off on the phone did not reach the pop-out'));
  await ph.page.getByPlaceholder(/^Ask/).fill(`Last one\n${say(['Gob Five'])}`);
  await ph.page.getByRole('button', { name: 'Send', exact: true }).click();
  await ph.page.waitForFunction(() => document.querySelectorAll('[aria-label="Waiting for your approval"]').length === 2, null, { timeout: 15000 }).catch(() => problems.push('Ask first again: the next change should wait as a card on the phone'));
  // Approve the new one from the phone; the desktop card for it flips to Done without a reload.
  const before = await card(page, 'done').count();
  await ph.page.getByRole('group', { name: 'Waiting for your approval' }).filter({ hasText: 'Gob Five' }).getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=action-card][data-status=done]').length > n, before, { timeout: 5000 }).catch(() => problems.push('approving on the phone did not update the desktop card'));
  check(!!(await combatant('Gob Five')), 'approving on the phone did not apply the change');
  // And the other way: reject the always-ask card on the desktop; the phone and pop-out show it rejected.
  await page.getByRole('button', { name: 'Reject', exact: true }).first().click();
  await pop.locator('[data-testid=action-card][data-status=rejected]').first().waitFor({ timeout: 5000 }).catch(() => problems.push('rejecting on the desktop did not reach the pop-out window'));
  await ph.page.locator('[data-testid=action-card][data-status=rejected]').first().waitFor({ timeout: 5000 }).catch(() => problems.push('rejecting on the desktop did not reach the phone'));
  check((await pendingActions()).length === 0, 'something is still pending at the end');
  note('pop-out and phone showed the same cards and mode, and decisions crossed over');
  await ph.ctx.close();
  await ctx.close();
} catch (e) {
  problems.push('flow failed: ' + String(e.stack).split('\n').slice(0, 6).join(' | '));
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('assistant e2e ok');
