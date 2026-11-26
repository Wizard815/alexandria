// End-to-end test of the DM's Table, on the demo world: every zone renders, quiet blocks shrink to a line, the world clock
// moves and undoes, a fight shows in initiative order and Next turn moves it, a shop opens from its block, the table map
// picker follows the table screen's choice, Arrange hides, brings back and moves blocks, the time can be set with AM/PM, effects show
// on combatants, a quick event goes out from the Table, and a phone has no sideways scroll.
// Run from web/: npm run build && node e2e/table.mjs   (TABLE_PORT; TABLE_SHOTS=<folder> saves screenshots)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.TABLE_PORT || 8215);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shows = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('table'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
let token = '';
const api = async (method, p, body) => {
  const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

try {
  token = await login('dm', 'dungeon master 123');
  const { page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1440, height: 900 });
  page.on('pageerror', (e) => problems.push(`page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`console on ${page.url()}: ${m.text()}`); });
  await page.goto(`${W}/dm`);
  await shows(page.getByTestId('dm-table'));

  // 1. The zones and the world clock.
  for (const id of ['table-now', 'table-main', 'table-side', 'tb-clock', 'tb-session', 'tb-here', 'tb-needs', 'tb-library']) check(await shows(page.getByTestId(id)), `table: ${id} is missing`);
  check((await page.getByTestId('tb-combat').getAttribute('data-quiet')) === 'true', 'combat block is not quiet without a fight');
  const before = await page.getByTestId('tb-world-date').innerText();
  const hour = async () => page.locator('.tb-hour').innerText();
  const h0 = await hour();
  await page.getByTestId('tb-clock').getByRole('button', { name: '+1 hour' }).click();
  await page.waitForFunction((h) => document.querySelector('.tb-hour')?.textContent !== h, h0, { timeout: 6000 }).catch(() => problems.push('clock: +1 hour did not move the time'));
  await page.getByTestId('tb-clock').getByRole('button', { name: 'Undo' }).click();
  await page.waitForFunction((h) => document.querySelector('.tb-hour')?.textContent === h, h0, { timeout: 6000 }).catch(() => problems.push('clock: Undo did not put the time back'));
  check((await page.getByTestId('tb-world-date').innerText()) === before, 'clock: the date changed after undo');
  note('zones render; the clock moves and undoes');

  // 2. A fight: initiative order, then Next turn.
  await api('POST', '/live/combatants', { name: 'Sea hag', initiative: 15, hp: 38, maxHp: 52 });
  await api('POST', '/live/combatants', { name: 'Drowned sailor', initiative: 9, hp: 4, maxHp: 13 });
  await api('PUT', '/live/combat', { active: true, round: 1, turn: 0 });
  const combat = page.getByTestId('tb-combat');
  check(await shows(combat.locator('.tb-init li.now')), 'combat: no current turn shown');
  check((await combat.locator('.tb-init li.now').innerText()).includes('Sea hag'), 'combat: the first turn is not the highest initiative');
  await page.getByTestId('tb-next-turn').click();
  await page.waitForFunction(() => document.querySelector('.tb-init li.now')?.textContent?.includes('Drowned sailor'), null, { timeout: 6000 }).catch(() => problems.push('combat: Next turn did not move the turn'));
  note('fight shows and Next turn moves it');

  // 3. A shop opens from its block.
  await api('POST', '/shop/generate', { kind: 'general', size: 'town', level: 3, seed: 'gull', name: 'Harbour Provisioner', save: true, status: 'closed' });
  const shop = page.getByTestId('tb-shops').getByTestId('tb-shop').filter({ hasText: 'Harbour Provisioner' });
  if (check(await shows(shop), 'shops: the new shop is not on the Table')) {
    await shop.getByRole('button', { name: 'Closed' }).click();
    check(await shows(shop.getByRole('button', { name: 'Open' })), 'shops: pressing Closed did not open the shop');
    const s = (await api('GET', '/shop/shops')).shops.find((x) => x.name === 'Harbour Provisioner');
    check(s?.status === 'open', `shops: server says ${s?.status}`);
  }
  note('a shop opens from the Table');

  // 4. The map on the table follows the table display.
  const maps = await api('GET', '/files/maps');
  if (maps.length) {
    await api('PUT', '/fog/table', { mapId: 'world', pic: `lib:${maps[0].id}` });
    await page.waitForFunction((v) => document.querySelector('[data-testid=tb-map-pick]')?.value === v, `lib:${maps[0].id}`, { timeout: 6000 }).catch(() => problems.push('map: the picker does not follow the table display'));
    note('the map block follows the table display');
  } else note('demo has no map pictures: map picker step skipped');

  // 5. Arrange: hide a block, it stays hidden after a reload; bring it back; move one to another zone.
  await page.getByTestId('table-arrange').click();
  await page.getByTestId('tb-hide-library').click();
  check(!(await page.getByTestId('tb-library').count()), 'hide: Library still shows');
  await page.getByTestId('table-arrange').click();
  await page.reload();
  await shows(page.getByTestId('dm-table'));
  await page.waitForTimeout(800);
  check(!(await page.getByTestId('tb-library').count()), 'hide: Library came back after a reload');
  await page.getByTestId('table-arrange').click();
  await page.getByTestId('tb-show-library').click();
  check(await shows(page.getByTestId('tb-library')), 'show: Library did not come back from the hidden list');
  await page.getByLabel('Where Dice goes').selectOption('side');
  check(await shows(page.getByTestId('table-side').getByTestId('tb-dice')), 'arrange: Dice did not move to the side column');
  await page.getByTestId('table-arrange').click();
  note('arrange: hide, bring back and move a block');

  // 6. Set the time with AM/PM; quick event from the Table; effects on a combatant.
  await page.getByTestId('tb-set-time').click();
  await page.getByLabel('Hour', { exact: true }).fill('9');
  await page.getByLabel('Minute', { exact: true }).fill('30');
  await page.getByRole('radio', { name: 'PM' }).click();
  await page.getByTestId('tb-set-time-go').click();
  await page.waitForFunction(() => /9:30 PM|21:30/.test(document.querySelector('[data-testid=tb-hour]')?.textContent ?? ''), null, { timeout: 6000 }).catch(() => problems.push('clock: Set time did not set 9:30 PM'));
  await page.getByTestId('tb-hour').click();
  check((await page.getByTestId('tb-hour').innerText()).includes('21:30'), 'clock: the 24-hour switch did not show 21:30');
  const hag = (await api('GET', '/live')).combat.combatants.find((c) => c.name === 'Sea hag');
  await api('PATCH', `/live/combatants/${hag.id}`, { effects: [{ name: 'Poisoned', rounds: 3 }] });
  check(await shows(page.getByTestId('tb-combat').getByText('Poisoned · 3 rd')), 'combat: the effect chip is missing');
  await page.getByTestId('tb-quick').getByLabel('Title').fill('ZZ table quick');
  await page.getByTestId('tb-quick-send').click();
  check(await shows(page.getByTestId('tb-quick-open').getByText('ZZ table quick')), 'quick: the event sent from the Table is not listed');
  note('set time, AM/PM, effect chips and a quick event');

  // 6b. Coming up: an event three months out, and one with no date yet that is then given a date.
  const coming = page.getByTestId('tb-coming');
  await coming.getByRole('radio', { name: '1y' }).click();
  await coming.getByLabel('New world event').fill('ZZ tax collector');
  await coming.getByLabel('How many').fill('3');
  await coming.getByLabel('When').selectOption('months');
  await coming.getByRole('button', { name: 'Add', exact: true }).click();
  check(await shows(coming.getByText('ZZ tax collector')), 'coming up: an event 3 months out is not listed');
  check(await shows(coming.getByText(/in 3 months/)), 'coming up: the 3-month event does not say "in 3 months"');
  await coming.getByLabel('New world event').fill('ZZ dragon wakes');
  await coming.getByLabel('When').selectOption('someday');
  await coming.getByRole('button', { name: 'Keep for later' }).click();
  check(await shows(page.getByTestId('tb-someday').getByText('ZZ dragon wakes')), 'coming up: the undated event is not kept');
  await coming.getByRole('button', { name: 'Give ZZ dragon wakes a date' }).click();
  await coming.getByLabel('When').selectOption('days');
  await coming.getByLabel('How many').fill('10');
  await coming.getByRole('button', { name: 'Put on the calendar' }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=tb-someday]'), null, { timeout: 6000 }).catch(() => problems.push('coming up: the dated event stayed in the no-date list'));
  check(await shows(coming.getByText('ZZ dragon wakes')), 'coming up: the dated event is not on the calendar');
  note('coming up: months ahead, no date yet, then dated');

  if (process.env.TABLE_SHOTS) { fs.mkdirSync(process.env.TABLE_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.TABLE_SHOTS, 'table.png'), fullPage: true }); }

  // 7. A phone: no sideways scroll.
  const { page: ph } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 390, height: 844 }, true);
  await ph.goto(`${W}/dm`);
  await shows(ph.getByTestId('dm-table'));
  await ph.waitForTimeout(800);
  const over = await ph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 2, `phone: the Table scrolls sideways by ${over}px`);
  note('phone fits');
} catch (e) {
  problems.push('flow failed: ' + e.message);
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('table e2e ok');
