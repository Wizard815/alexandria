// End-to-end test of the player sheet and the DM's status bar: a player on a
// phone sets their HP, takes damage, adds a condition and an enemy, spends
// mana and adds a counter module; their private note never reaches the DM.
// The DM's status bar shows the player's health, conditions and mana live,
// and opens the player's sheet and the change log.
// Run from web/: npm run build && node e2e/sheet.mjs   (SHEET_PORT, default 19812)
// SHEET_SHOTS=<dir> also saves screenshots there.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.SHEET_PORT || 19812);
const SHOTS = process.env.SHEET_SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('sheet'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const dmLogin = await login('dm', 'dungeon master 123');
const jessLogin = await login('jess', 'player pass 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + dmLogin.token } })).json())[0].id;
const api = async (token, method, p, body) => {
  const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const jessId = jessLogin.account.id;
await api(dmLogin.token, 'PATCH', '/settings', { spellMana: true });
await api(jessLogin.token, 'PUT', '/spells/characters/me', { class: 'Wizard', level: 3, abilities: { int: 12 }, castingAbility: 'int' });

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}
async function signIn(user, pass, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  watch(page, user);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}
const closeQuick = async (page) => { const c = page.locator('.modal[role=dialog]').getByRole('button', { name: 'Close' }); if (await c.waitFor({ timeout: 1200 }).then(() => true, () => false)) await c.click(); };

try {
  // 1. The player opens their sheet on a phone: the default modules are there.
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pl.goto(`${W}/sheet`);
  await closeQuick(pl);
  await pl.getByTestId('sheet').waitFor({ timeout: 10000 });
  for (const t of ['vitals', 'mana', 'inventory', 'contacts', 'notes', 'recent']) check(await pl.getByTestId(`mod-${t}`).count() === 1, `default module ${t}`);

  // 2. Health: set HP 24, take 5, add Poisoned.
  await pl.getByRole('button', { name: 'Set your HP' }).click();
  const vit = pl.getByTestId('mod-vitals');
  await vit.getByRole('textbox', { name: 'Max' }).fill('24');
  await vit.getByRole('textbox', { name: 'HP', exact: true }).fill('24');
  await vit.getByRole('button', { name: 'Save' }).click();
  await vit.getByTestId('hp').getByText('24').first().waitFor({ timeout: 8000 });
  await vit.getByLabel('Amount').fill('5');
  await vit.getByRole('button', { name: 'Damage', exact: true }).click();
  await vit.getByTestId('hp').filter({ hasText: /^19/ }).waitFor({ timeout: 8000 });
  await vit.getByLabel('Add a condition').fill('Poisoned');
  await vit.locator('.chip', { hasText: 'Poisoned' }).waitFor({ timeout: 8000 });
  note('player: HP 24 -> 19, Poisoned');

  // 3. Mana: spend 3 for a reason.
  const mana = pl.getByTestId('mod-mana');
  const before = Number((await mana.getByTestId('mana-now').innerText()).split('/')[0].trim());
  await mana.getByLabel('Mana amount').fill('3');
  await mana.getByLabel('Why').fill('Overloaded a wand');
  await mana.getByRole('button', { name: 'Spend' }).click();
  await mana.getByTestId('mana-now').filter({ hasText: new RegExp(`^${before - 3}`) }).waitFor({ timeout: 8000 });
  note(`player: mana ${before} -> ${before - 3}`);

  // 4. An enemy, a private note, a counter module.
  const people = pl.getByTestId('mod-contacts');
  await people.getByTestId('person-add').click();
  const dlg = pl.locator('.modal[role=dialog]');
  await dlg.getByLabel('Name', { exact: true }).fill('Captain Vex');
  await dlg.getByRole('radio', { name: /Enemy/ }).click();
  await dlg.getByLabel('Search pages to link').fill('Saltmarsh');
  const hit = dlg.locator('ul button').first();
  const linked = await hit.waitFor({ timeout: 4000 }).then(() => true, () => false);
  if (linked) await hit.click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  await people.getByText('Captain Vex').waitFor();
  if (linked) check(await people.getByRole('link', { name: /Captain Vex/ }).count() === 1, 'the person links to their library page');
  // Ask the broker about them: the question can be rewritten, and lands in the broker's box.
  await people.getByRole('button', { name: 'Ask the broker about Captain Vex' }).click();
  await dlg.getByLabel('Your question').fill('Who pays Captain Vex?');
  await dlg.getByTestId('ask-go').click();
  await pl.waitForURL(/\/broker\?ask=/, { timeout: 8000 });
  const box = pl.getByLabel('What do you want to know?');
  await box.waitFor({ timeout: 8000 });
  check((await box.inputValue()) === 'Who pays Captain Vex?', `the broker box has the question: ${await box.inputValue()}`);
  await pl.goto(`${W}/sheet`);
  await closeQuick(pl);
  await pl.getByTestId('sheet').waitFor();
  await pl.getByTestId('mod-notes').getByRole('textbox').fill('ZQX-PRIVATE-PLAN steal the crown');
  await pl.getByTestId('sheet-edit').click();
  await pl.getByTestId('mod-notes').getByRole('button', { name: 'Private' }).click();
  await pl.getByTestId('sheet-add').click();
  await pl.getByTestId('add-counters').click();
  await pl.getByTestId('sheet-edit').click();
  const ctr = pl.getByTestId('mod-counters');
  await ctr.getByLabel('New counter').fill('Inspiration');
  await ctr.getByRole('button', { name: 'Add' }).click();
  await ctr.getByRole('button', { name: 'Inspiration plus one' }).click();
  await pl.waitForTimeout(1200); // the sheet saves a moment after the last edit
  const saved = await api(jessLogin.token, 'GET', '/sheet/me');
  check(saved.modules.some((m) => m.type === 'counters' && m.data.entries[0]?.value === 1), 'the counter module saved');
  check(saved.modules.find((m) => m.type === 'notes')?.private === true, 'the note is private');
  check(saved.hp === 19 && saved.maxHp === 24 && saved.conditions.includes('Poisoned'), 'the server agrees on HP and conditions');
  await shot(pl, 'player-sheet');
  note('player: enemy, private note, counter');

  // 5. The DM's status bar shows it; the sheet opens from it; the log has every change.
  const { page: dm } = await signIn('dm', 'dungeon master 123', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
  await dm.goto(`${W}/dm`);
  const bar = dm.getByTestId('party-status');
  await bar.waitFor({ timeout: 10000 });
  const chip = bar.getByRole('button', { name: /Jessamine/ });
  await chip.getByText('19/24').waitFor({ timeout: 8000 });
  check((await chip.getAttribute('title'))?.includes('Poisoned'), 'the status bar names the condition');
  await shot(dm, 'dm-status-bar');
  // Live: the player heals and the DM's bar follows without a reload.
  await vit.getByLabel('Amount').fill('3');
  await vit.getByRole('button', { name: 'Heal', exact: true }).click();
  await chip.getByText('22/24').waitFor({ timeout: 8000 });
  note('DM: status bar follows the player live (22/24)');
  // The DM deals damage from the status bar's quick panel; the player's sheet follows.
  await chip.click();
  const quick = dm.getByTestId('quick-sheet');
  await quick.getByLabel('Amount', { exact: true }).fill('2');
  await quick.getByRole('button', { name: 'Damage', exact: true }).click();
  await chip.getByText('20/24').waitFor({ timeout: 8000 });
  await vit.getByTestId('hp').getByText('20').waitFor({ timeout: 8000 });
  note('DM: damage from the status bar reaches the player (20/24)');
  // House rule: re-rolls. The DM turns it on, gives one for role play; the player spends it; the DM is told.
  await api(dmLogin.token, 'PATCH', '/settings', { sheetRerolls: true });
  await quick.getByTestId('rerolls').waitFor({ timeout: 8000 });
  await quick.getByLabel('Reason').fill('Great speech');
  await quick.getByRole('button', { name: 'Give a DM re-roll' }).click();
  const prr = pl.getByTestId('mod-rerolls');
  await prr.waitFor({ timeout: 8000 });
  await prr.getByRole('button', { name: 'Use a DM re-roll' }).click();
  await dm.getByText('Jessamine used a dm re-roll').waitFor({ timeout: 8000 });
  note('re-rolls: DM gives one, the player spends it, the DM is told');
  await quick.getByRole('link', { name: 'Open the whole sheet' }).click();
  await dm.getByTestId('sheet').waitFor({ timeout: 8000 });
  check(!(await dm.content()).includes('ZQX-PRIVATE-PLAN'), 'the private note never reaches the DM');
  await dm.getByText('Captain Vex').waitFor();
  // A secret goal for this player only.
  await dm.getByLabel('Text for the player').fill('Find out who lights the lamp');
  await dm.getByTestId('dm-note-add').click();
  await pl.getByTestId('from-dm').getByText('Find out who lights the lamp').waitFor({ timeout: 8000 });
  note('player: sees the DM goal live');
  await dm.getByRole('button', { name: 'Log' }).click();
  const log = dm.getByTestId('sheet-log');
  await log.getByText('Overloaded a wand').waitFor({ timeout: 8000 });
  check(await log.getByText('24 → 19').count() > 0, 'the log shows the damage');
  await shot(dm, 'dm-player-sheet');
  note('DM: sheet and log');
} catch (e) {
  problems.push('crashed: ' + (e.stack || e));
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('sheet ok');
