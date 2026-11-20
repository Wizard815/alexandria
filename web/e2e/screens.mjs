// End-to-end test of the DM's multi-monitor screens: every pop-out panel, the portrait side screen (choose, order, fold,
// resize, remembered), the table screen (rotate, and that nothing DM-only is ever in it, even on the DM's login) and the
// Screens page, on the demo world with fake models.
// Run from web/: npm run build && node e2e/screens.mjs   (SCREENS_PORT)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.SCREENS_PORT || 8201);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('screens'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
};
// isVisible() does not wait, so anything that may still be loading is waited for.
const shows = (loc, ms = 6000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const settle = async (page, ms = 700) => { await page.waitForTimeout(ms); };

const SECRET_PIN = 'ZZ-DM-ONLY-PIN';
const SECRET_FOE = 'ZZ-HIDDEN-AMBUSHER';
const HIDDEN_MARK = 'ZZ-HIDDEN-PARTY-PIN';

try {
  const { ctx, page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1280, height: 800 }, false, /\/w\/saltreach/);
  watch(page, 'dm');
  const token = await page.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // What the table must never show: a DM-only pin, a party pin the DM hid, a hidden foe, and a monster's AC and temp HP.
  const info = (await api('GET', '')).json;
  await api('POST', '/map/world/marks', { kind: 'pin', x: 40, y: 40, label: SECRET_PIN, visibility: 'dm' });
  await api('POST', '/map/world/marks', { kind: 'pin', x: 55, y: 55, label: 'Open Gate', visibility: 'party' });
  const hid = (await api('POST', '/map/world/marks', { kind: 'pin', x: 60, y: 30, label: HIDDEN_MARK, visibility: 'party' })).json;
  await api('PATCH', `/map/world/marks/${hid.id}`, { hidden: true });
  await api('POST', '/live/combatants', { name: 'Marsh Goblin', initiative: 11, hp: 5, maxHp: 10, ac: 13, tempHp: 4 });
  await api('POST', '/live/combatants', { name: SECRET_FOE, initiative: 17, hp: 30, maxHp: 30, ac: 19, hidden: true });
  await api('PUT', '/live/combat', { active: true, round: 2, turn: 0 });
  check(!!info?.id, 'world info is readable');

  // ---- 1. every pop-out panel is its own chrome-less window ------------------------------------------
  const PANEL_IDS = ['assistant', 'transcript', 'combat', 'approvals', 'sound', 'chat', 'clock', 'quick', 'party'];
  for (const id of PANEL_IDS) {
    await page.goto(`${W}/panel/${id}`);
    await page.getByTestId(`panel-${id}`).waitFor({ timeout: 8000 }).catch(() => problems.push(`panel ${id}: did not render`));
    await settle(page, 500);
    check(await page.locator('nav.side, nav[aria-label="DM"]').count() === 0, `panel ${id}: the DM menu is around it`);
    const text = (await page.locator('body').innerText()).trim();
    check(text.length > 10 && !/something went wrong|cannot read prop|undefined is not/i.test(text), `panel ${id}: empty or crashed`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 2, `panel ${id}: scrolls sideways by ${over}px`);
  }
  await page.goto(`${W}/panel/combat`);
  await page.getByTestId('panel-combat').waitFor();
  check(await shows(page.getByText('Marsh Goblin').first()), 'panel combat: the combat tracker should list the goblin');
  await page.goto(`${W}/panel/nonsense`);
  check(await shows(page.getByText(/no panel called/i)), 'an unknown panel should say so');
  note(`${PANEL_IDS.length} pop-out panels render without the DM menu`);

  // The old assistant window still works.
  await page.goto(`${W}/assistant-window`);
  check(await shows(page.getByText('Assistant').first()), 'the assistant-window route still renders');

  // The pop-out button on a DM page opens the named window.
  await page.goto(`${W}/dm/combat`);
  const pop = page.getByTestId('popout');
  check(await shows(pop), 'dm/combat: no pop-out button');
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), pop.click()]).catch(() => [null]);
  check(!!popup && /\/w\/saltreach\/panel\/combat$/.test(popup.url()), `the pop-out opened ${popup?.url()}`);
  await popup?.close();

  // Players cannot use panels.
  {
    const { ctx: pctx, page: pp } = await signIn(browser, base, 'jess', 'player pass 123', { width: 1280, height: 800 }, false, /\/w\/saltreach/);
    for (const r of ['panel/combat', 'screen/side', 'screen/table']) {
      await pp.goto(`${W}/${r}`);
      await settle(pp, 500);
      check(/for the DM|opened by the DM/i.test(await pp.locator('body').innerText()), `a player at /${r} should be told it is the DM's`);
    }
    await pctx.close();
  }

  // ---- 2. the portrait side screen ------------------------------------------------------------------
  const side = await ctx.newPage();
  watch(side, 'side');
  await side.setViewportSize({ width: 1080, height: 1920 });
  await side.goto(`${W}/screen/side`);
  await side.getByTestId('side-screen').waitFor({ timeout: 8000 });
  await settle(side, 800);
  const order = () => side.locator('[data-testid^=side-panel-]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('side-panel-', '')));
  check((await order()).join() === 'assistant,transcript,combat,approvals', `side: default stack is ${(await order()).join()}`);
  check(await side.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 2, 'side: scrolls sideways at 1080 wide');
  // Fold the transcript, move combat up, drop approvals, add the clock.
  await side.getByRole('button', { name: 'Fold Transcript' }).click();
  await side.getByRole('button', { name: 'Move Combat up' }).click();
  await side.getByRole('button', { name: 'Remove Approvals from this screen' }).click();
  await side.getByTestId('side-choose').click();
  await side.getByTestId('side-toggle-clock').click();
  check((await order()).join() === 'assistant,combat,transcript,clock', `side: after editing the stack is ${(await order()).join()}`);
  // Resize the combat panel with the keyboard.
  const body = side.getByTestId('side-panel-combat').locator('.sc-pbody');
  const h0 = (await body.boundingBox()).height;
  await side.getByRole('separator', { name: 'Resize Combat' }).focus();
  await side.keyboard.press('Shift+ArrowDown');
  await settle(side, 200);
  const h1 = (await body.boundingBox()).height;
  check(h1 > h0 + 100, `side: the grip should make the panel taller (${h0} -> ${h1})`);
  // Remembered across a reload.
  await side.reload();
  await side.getByTestId('side-screen').waitFor();
  await settle(side, 600);
  check((await order()).join() === 'assistant,combat,transcript,clock', `side: the stack was not remembered (${(await order()).join()})`);
  check(await shows(side.getByRole('button', { name: 'Unfold Transcript' })), 'side: the folded transcript was not remembered');
  const h2 = (await side.getByTestId('side-panel-combat').locator('.sc-pbody').boundingBox()).height;
  check(Math.abs(h2 - h1) < 3, `side: the panel height was not remembered (${h1} -> ${h2})`);
  note('side screen: choose, order, fold, resize and remember');
  await side.close();

  // ---- 3. the table screen: players' view only --------------------------------------------------------
  const requests = [];
  const table = await ctx.newPage();
  watch(table, 'table');
  table.on('request', (r) => { if (r.url().includes('/api/')) requests.push(r.url().replace(base, '')); });
  await table.setViewportSize({ width: 1920, height: 1080 });
  await table.goto(`${W}/screen/table`);
  await table.getByTestId('table-screen').waitFor({ timeout: 8000 });
  await table.getByTestId('table-order').waitFor({ timeout: 8000 });
  await settle(table, 1000);
  const dump = async () => table.evaluate(() => document.documentElement.outerHTML + '\n' + document.body.innerText);
  const looksSafe = async (where) => {
    const all = await dump();
    for (const s of [SECRET_PIN, SECRET_FOE, HIDDEN_MARK, 'ZZ-']) check(!all.includes(s), `table (${where}) shows DM-only text "${s}"`);
    const ord = await table.getByTestId('table-order').innerText().catch(() => '');
    check(/Marsh Goblin/.test(ord), `table (${where}): the order should list the goblin: ${ord.slice(0, 100)}`);
    check(!/\bAC\b|temp|19|13\b.*AC/i.test(ord.replace(/Round \d+/g, '')), `table (${where}): the order shows AC or temp HP: ${ord.slice(0, 160)}`);
    check(!/\b5\s*\/\s*10\b/.test(ord), `table (${where}): the goblin's exact HP is shown but the world shows words`);
  };
  await looksSafe('first load');
  check(await shows(table.getByText('Open Gate').first()) || (await table.locator('[data-testid=table-map] [data-mark]').count()) >= 1, 'table: the party pin should be on the map');
  check(/Round 2/.test(await table.getByTestId('table-round').innerText()), 'table: the round is not shown');
  // The reads it made all asked for the players' copy.
  const reads = requests.filter((u) => /\/live\/combat|\/map\/[^/]+\/marks|\/files\/maps|\/intake\/map-images/.test(u) && !/\/prefetch/.test(u));
  check(requests.some((u) => /\/live\/combat\?view=players/.test(u)), 'table: never asked for the players\' combat');
  check(requests.some((u) => /\/marks\?view=players/.test(u)), 'table: never asked for the players\' marks');
  note(`table: ${reads.filter((u) => u.includes('view=players')).length} player-view reads, DM-only text absent`);
  // Even after the DM changes things live, nothing new leaks in.
  await api('POST', '/map/world/marks', { kind: 'note', x: 20, y: 70, text: `${SECRET_PIN} note`, visibility: 'dm' });
  await api('POST', '/live/combatants', { name: `${SECRET_FOE} 2`, initiative: 3, hp: 9, maxHp: 9, hidden: true });
  await settle(table, 1200);
  await looksSafe('after live changes');
  // Rotation: four quarter turns, remembered, and the layout swaps its sides on 90 and 270.
  const rot = () => table.getByTestId('table-rot').innerText();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await table.getByTestId('table-rot-right').click();
    await settle(table, 150);
    seen.push(await rot());
    // The layout box (not its rotated outline): turned a quarter way it is as wide as the screen is tall.
    const [bw, bh] = await table.locator('.ts-stage').evaluate((e) => [e.offsetWidth, e.offsetHeight]);
    const sideways = /^(90|270)/.test(seen[i]);
    check(sideways ? bw === 1080 && bh === 1920 : bw === 1920 && bh === 1080, `table: at ${seen[i]} the stage is ${bw}x${bh}`);
    await looksSafe(`rotated ${seen[i]}`);
  }
  check(seen.join() === '90°,180°,270°,0°', `table: rotations are ${seen.join()}`);
  await table.getByTestId('table-rot-left').click();
  await table.reload();
  await table.getByTestId('table-screen').waitFor();
  check((await rot()) === '270°', `table: rotation was not remembered (${await rot()})`);
  const big = await table.getByTestId('table-rot-right').boundingBox();
  check(big.width >= 56 && big.height >= 56, `table: touch targets are small (${big.width}x${big.height})`);
  await table.getByRole('button', { name: 'Whiteboard' }).click();
  await settle(table, 300);
  await looksSafe('whiteboard');
  await table.close();

  // ---- 4. the Screens page ----------------------------------------------------------------------------
  await page.goto(`${W}/dm/screens`);
  await page.getByTestId('screens-page').waitFor({ timeout: 8000 });
  for (const id of ['side', 'players', 'table', 'panels']) check(await page.getByTestId(`screen-card-${id}`).isVisible(), `screens: no card for ${id}`);
  check(await page.getByText(/four-monitor/i).first().isVisible(), 'screens: the four-monitor setup is not explained');
  check(await shows(page.getByTestId('find-screens'), 1500) || await shows(page.getByTestId('no-winmgmt'), 1500), 'screens: neither a way to find screens nor the F11 note');
  for (const [id, re] of [['table', /\/screen\/table$/], ['side', /\/screen\/side$/]]) {
    const [pw] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), page.getByTestId(`open-${id}`).click()]).catch(() => [null]);
    check(!!pw && re.test(pw.url()), `screens: Open ${id} opened ${pw?.url()}`);
    await pw?.close();
  }
  const [pp] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), page.getByTestId('open-panel-clock').click()]).catch(() => [null]);
  check(!!pp && /\/panel\/clock$/.test(pp.url()), `screens: the clock pop-out opened ${pp?.url()}`);
  await pp?.close();

  // The main monitor can drop the docked assistant and the transcript island.
  await page.goto(`${W}/dm`);
  await page.locator('main').waitFor();
  await settle(page, 600);
  check(await shows(page.getByTestId('dock-agent')), 'main: the assistant dock button should show by default');
  await page.goto(`${W}/dm/screens`);
  await page.getByTestId('hide-assistant').check();
  await page.getByTestId('hide-transcript').check();
  await page.goto(`${W}/dm`);
  await page.locator('main').waitFor();
  await settle(page, 600);
  check(!(await page.getByTestId('dock-agent').isVisible().catch(() => false)), 'main: the assistant dock button should be gone when it lives on the side screen');
  check(!(await page.getByTestId('dock-transcript').isVisible().catch(() => false)), 'main: the transcript button should be gone when it lives on the side screen');
  note('screens page: cards, Open, and hiding the docked panels on the main monitor');
  await ctx.close();
} catch (e) {
  problems.push('flow failed: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('screens e2e ok');
