// End-to-end test of the Minerva's Assistant overhaul on the demo world (fake models): switching Active mode on opens
// the "Minerva's thoughts" window, which shows what the assistant is working on and what it proposed, with the waiting
// changes and their buttons; it can be dragged and closed to its dock button. In the chat, a card can be edited
// before it is approved, two or more waiting cards get Approve all, and "Always allow" lets a tool run without
// asking from then on. Screenshots go to the e2e temp folder (path printed).
// Run from web/: npm run build && node e2e/thoughts.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.THOUGHTS_E2E_PORT || 8213);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const out = tmpDir('thoughts');

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(out, 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tok = await login('dm', 'dungeon master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tok } })).json())[0].id;
const api = async (m, p, b) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); };
const combatant = async (name) => ((await api('GET', '/live/combat')).combatants ?? []).find((c) => c.name === name);
const say = (names) => names.map((n, i) => `FAKE_CALL add_combatant {"name":"${n}","hp":7,"initiative":${5 + i}}`).join('\n');

const browser = await chromium.launch();
try {
  await api('PATCH', '/settings', { agentAuto: false, agentAutoApprove: [] });
  await api('PUT', '/active', { mode: 'assistant' });
  const { page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1400, height: 900 });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(`${W}/dm`);
  await page.getByTestId('dock-thoughts').waitFor({ timeout: 15000 });
  check(!(await page.getByTestId('thoughts').count()), 'the thoughts window should start folded in Assistant mode');

  // ---- Active mode on: the window opens by itself ----
  await page.getByTestId('mode-badge').locator('button').click();
  await page.getByTestId('thoughts').waitFor({ timeout: 8000 }).catch(() => problems.push('switching Active mode on did not open the thoughts window'));
  check(/not listening|Listening/.test(await page.getByTestId('thoughts-status').innerText().catch(() => '')), 'the status line should say whether it is listening');
  note('Active mode opened the thoughts window');

  // ---- a request in the chat shows up as thoughts and as waiting changes ----
  await page.keyboard.press('Control+k');
  const box = page.locator('[data-ag-input]');
  await box.waitFor({ timeout: 8000 });
  await box.fill(`Two goblins\n${say(['Gob Edit', 'Gob Two'])}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=action-card][data-status=pending]').length === 2, null, { timeout: 15000 }).catch(() => problems.push('two cards did not appear'));
  await page.getByTestId('thoughts-feed').locator('li[data-kind=ask]').first().waitFor({ timeout: 8000 }).catch(() => problems.push('the proposal did not show in the thoughts feed'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=thoughts-action]').length === 2, null, { timeout: 8000 }).catch(() => problems.push('the window did not list the two waiting changes'));
  check(/Working on/.test(await page.getByTestId('thoughts-feed').innerText()), 'the feed should say what it is working on');
  await page.screenshot({ path: path.join(out, 'thoughts-window.png') });
  note('the feed shows the plan and the proposals; both wait in the window');

  // ---- drag the window by its header ----
  const head = page.locator('.th-head');
  const b0 = await page.getByTestId('thoughts').boundingBox();
  await head.hover({ position: { x: 60, y: 10 } });
  await page.mouse.down();
  await page.mouse.move(b0.x + 260, b0.y - 200, { steps: 8 });
  await page.mouse.up();
  const b1 = await page.getByTestId('thoughts').boundingBox();
  check(Math.abs(b1.x - b0.x - 200) < 80 && b1.y < b0.y - 100, `the window did not move (from ${Math.round(b0.x)},${Math.round(b0.y)} to ${Math.round(b1.x)},${Math.round(b1.y)})`);
  note('dragged the window');

  // ---- edit a card before approving it ----
  const first = page.locator('[data-testid=action-card][data-status=pending]').filter({ hasText: 'Gob Edit' });
  await first.getByTestId('action-edit-open').click();
  const ta = first.locator('[data-testid=action-edit] textarea');
  await ta.fill(JSON.stringify({ name: 'Gob Edited', hp: 9, initiative: 12 }));
  await first.getByRole('button', { name: 'Save changes' }).click();
  await page.locator('[data-testid=action-card][data-status=pending]').filter({ hasText: 'Gob Edited' }).waitFor({ timeout: 5000 }).catch(() => problems.push('the edited card did not show the change'));
  note('edited a card');

  // ---- Approve all ----
  await page.getByTestId('ag-approve-all').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=action-card][data-status=pending]'), null, { timeout: 8000 }).catch(() => problems.push('Approve all left cards waiting'));
  await new Promise((r) => setTimeout(r, 500));
  const edited = await combatant('Gob Edited');
  check(edited?.hp === 9, `the edited change should be the one applied (got ${JSON.stringify(edited)})`);
  check(!!(await combatant('Gob Two')), 'Approve all did not apply the second card');
  check(!(await combatant('Gob Edit')), 'the original arguments were applied');
  check(!(await page.locator('[data-testid=thoughts-action]').count()), 'the window still lists decided changes');
  note('Approve all applied both, the edited one as edited');

  // ---- Always allow ----
  await box.fill(`One more\n${say(['Gob Trust'])}`);
  await page.keyboard.press('Enter');
  await page.locator('[data-testid=action-card][data-status=pending]').first().waitFor({ timeout: 15000 });
  await page.getByTestId('action-trust').first().click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=action-card][data-status=pending]'), null, { timeout: 8000 }).catch(() => problems.push('Always allow did not approve the card'));
  check(((await api('GET', '/agent/status')).autoApprove ?? []).includes('add_combatant'), 'Always allow did not add the tool to the allowed list');
  await box.fill(`And another\n${say(['Gob Auto'])}`);
  await page.keyboard.press('Enter');
  await page.locator('[data-testid=action-card][data-status=done]').filter({ hasText: 'Gob Auto' }).waitFor({ timeout: 15000 }).catch(() => problems.push('an allowed tool still asked'));
  check(!!(await combatant('Gob Auto')), 'the allowed tool did not run');
  await page.getByTestId('ag-trusted').locator('summary').click();
  await page.getByRole('button', { name: 'Ask first for add combatant again' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=ag-trusted]'), null, { timeout: 5000 }).catch(() => problems.push('removing the allowed tool did not work'));
  note('Always allow, then ask first again');
  await page.screenshot({ path: path.join(out, 'thoughts-after.png') });

  // ---- close to the dock; it stays closed while Active mode stays on ----
  await page.getByRole('button', { name: "Close Minerva's thoughts" }).first().click();
  await page.reload();
  await page.getByTestId('dock-thoughts').waitFor({ timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1000));
  check(!(await page.getByTestId('thoughts').count()), 'the window came back after the DM closed it');
  note('closed to the dock and stayed closed');
  await api('PUT', '/active', { mode: 'assistant' });
} catch (e) {
  problems.push(`crashed: ${e?.stack ?? e}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(`  screenshots: ${out}`);
if (problems.length) { console.error('thoughts e2e FAILED:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('thoughts e2e ok');
