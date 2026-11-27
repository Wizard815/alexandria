// End-to-end test of DownTime: the GM turns the house rule on, gives Tomas a
// legendary task with a surprise reward, presses Downtime for 3 days; Jess
// gets the popup on her phone, asks the helper for suggestions, picks research
// and a daily vigil, and sends; the GM sees her answer, picks for Anselm,
// adds a day to Tomas, closes the round, finishes and rewards a task, and
// reads the log; Jess sees her tasks on her sheet and joins the party's group
// stronghold from her Downtime page. Screenshots go to SHOTS.
// Run from web/: npm run build && node e2e/downtime.mjs   (DOWNTIME_PORT, default 19822)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.DOWNTIME_PORT || 19822);
const SHOTS = process.env.SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('downtime'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const gmLogin = await login('gm', 'game master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + gmLogin.token } })).json())[0].id;
const api = async (token, method, p, body) => {
  const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const browser = await chromium.launch();
const pages = [];
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/409/.test(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}
async function signIn(user, pass, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  watch(page, user);
  pages.push(page);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}

try {
  // 1. The GM turns DownTime on (House rules) and gives Tomas a legendary stronghold with a surprise reward.
  await api(gmLogin.token, 'PUT', '/mods/downtime/enabled', { on: true });
  await api(gmLogin.token, 'POST', '/downtime/tasks', { player: 'Tomas', activityId: 'pre-stronghold', reward: { text: 'A keep on the cliffs and a lordship', hidden: true }, gmNote: 'The cliffs hide a smugglers cave' });
  const { page: gm } = await signIn('gm', 'game master 123', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await gm.goto(`${W}/gm/house-rules`);
  await gm.getByRole('tab', { name: 'DownTime activities' }).click();
  await gm.getByText('Legendary vigil').waitFor({ timeout: 8000 });
  await shot(gm, '1-house-rules-activities');
  note('gm: DownTime on, its activities tab on the House rules page');

  // 2. The GM presses Downtime for 3 days on the Downtime page.
  await gm.goto(`${W}/gm/downtime`);
  await gm.getByLabel('Days of downtime').fill('3');
  await gm.getByLabel('Note').fill('Resting in Saltmarsh');
  await gm.getByTestId('downtime-start').click();
  await gm.getByText('Downtime: 3 days · Resting in Saltmarsh').waitFor({ timeout: 8000 });
  note('gm: pressed Downtime for 3 days');

  // 3. Jess gets the popup on her phone, asks for suggestions and picks.
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 3 : 1, isMobile: true, hasTouch: true });
  await pl.getByTestId('downtime-popup').waitFor({ timeout: 10000 });
  await pl.waitForTimeout(400); // the sheet slides up
  await shot(pl, '2-player-popup-phone');
  await pl.getByLabel('What you want from your downtime').fill('learn secrets about the lighthouse');
  await pl.getByRole('button', { name: /Suggest/ }).click();
  await pl.getByRole('button', { name: /Research lore/ }).first().waitFor({ timeout: 10000 });
  await pl.getByRole('button', { name: /Research lore/ }).first().click();
  await pl.getByLabel('Search activities').fill('vigil');
  await pl.getByRole('button', { name: /Legendary vigil/ }).click();
  await pl.getByRole('button', { name: 'One day less on Research lore' }).click();
  await pl.getByRole('button', { name: 'One day more on Legendary vigil' }).click();
  await pl.getByRole('button', { name: 'One day more on Legendary vigil' }).click();
  await shot(pl, '3-player-picked');
  await pl.getByTestId('downtime-send').click();
  await pl.getByTestId('downtime-popup').waitFor({ state: 'hidden', timeout: 8000 });
  const mine = await api((await login('jess', 'player pass 123')).token, 'GET', '/downtime/tasks');
  check(mine.tasks.find((t) => t.name === 'Research lore')?.doneMin === 2 * 8 * 60, `research got its days: ${JSON.stringify(mine.tasks.map((t) => [t.name, t.doneMin]))}`);
  check(mine.tasks.find((t) => t.name === 'Legendary vigil')?.doneMin === 3 * 60, 'the vigil got 3 days of 1 hour');
  check(!JSON.stringify(mine).includes('smugglers') && !JSON.stringify(mine).includes('lordship'), 'Jess sees nothing of the GM\'s');
  note('player: popup, suggestions, picked research and the daily vigil');

  // 4. The GM sees Jess's answer, picks for Anselm, adds a day to Tomas, closes the round.
  await gm.getByText(/Research lore \(\d+d\)/).waitFor({ timeout: 8000 });
  await shot(gm, '4-gm-round-answers');
  const anselm = gm.locator('[data-testid=downtime-button] .row.between', { hasText: 'Anselm' });
  await anselm.getByRole('button', { name: 'Pick for them' }).click();
  await gm.getByTestId('downtime-popup').waitFor({ timeout: 8000 });
  await gm.getByLabel('Search activities').fill('Work a job');
  await gm.getByRole('button', { name: /Work a job/ }).click();
  await gm.getByTestId('downtime-send').click();
  await gm.getByTestId('downtime-popup').waitFor({ state: 'hidden', timeout: 8000 });
  const tom = gm.getByTestId('downtime-task').filter({ hasText: 'Build a stronghold' });
  await tom.getByRole('button', { name: '＋ day' }).click();
  await tom.getByText('1 day of 90 days').waitFor({ timeout: 8000 });
  await gm.getByRole('button', { name: 'Close', exact: true }).click();
  await gm.getByTestId('downtime-start').waitFor({ timeout: 8000 });
  note('gm: picked for Anselm, added a day to the stronghold, closed the round');

  // 5. Anselm's job is done (1 day, repeatable): Give reward; the log has it all.
  const ans = gm.getByTestId('downtime-task').filter({ hasText: 'Work a job' });
  await ans.getByRole('button', { name: 'Give reward' }).click();
  await ans.waitFor({ state: 'detached', timeout: 8000 }); // given: it leaves the open list
  await shot(gm, '5-gm-party-tasks');
  await gm.getByRole('tab', { name: 'Log' }).click();
  await gm.getByText(/Reward given Work a job/).waitFor({ timeout: 8000 });
  await shot(gm, '6-gm-log');
  note('gm: reward given, log shows when and how long');

  // 6. Jess adds Downtime to her sheet.
  await pl.goto(`${W}/sheet`);
  await pl.getByRole('button', { name: /Arrange/ }).click();
  await pl.getByTestId('sheet-add').click();
  await pl.getByTestId('add-downtime').click();
  await pl.getByRole('button', { name: /Done/ }).first().click().catch(() => {});
  await pl.getByText('Legendary vigil').first().waitFor({ timeout: 8000 });
  await pl.getByText('Legendary vigil').first().scrollIntoViewIfNeeded();
  await pl.waitForTimeout(200);
  await shot(pl, '7-player-sheet-module');
  note('player: Downtime module on her sheet');

  // 7. Group and personal are apart: Jess's Downtime page has her own tasks and the party's group tasks; she joins the stronghold.
  await pl.goto(`${W}/downtime`);
  const grp = pl.getByTestId('downtime-group');
  await grp.getByText('Build a stronghold').waitFor({ timeout: 8000 });
  check(!(await pl.getByTestId('downtime-personal').getByText('Build a stronghold').count()), 'the stronghold is not on her personal list');
  await grp.getByRole('button', { name: 'Join' }).click();
  await grp.getByRole('button', { name: 'Leave' }).waitFor({ timeout: 8000 });
  const jt = await api((await login('jess', 'player pass 123')).token, 'GET', '/downtime/tasks?scope=group');
  check(jt.tasks.some((t) => t.name === 'Build a stronghold' && t.members.length === 2), `Jess joined Tomas on the stronghold: ${JSON.stringify(jt.tasks.map((t) => [t.name, t.members.length]))}`);
  check(!JSON.stringify(jt).includes('smugglers') && !JSON.stringify(jt).includes('lordship'), 'the group task still hides the GM\'s note and surprise reward');
  await grp.scrollIntoViewIfNeeded();
  await shot(pl, '8-player-group-tasks');
  note('player: personal and group tasks apart, joined the party stronghold');
} catch (e) {
  problems.push(`stopped: ${e.message.split('\n').slice(0, 3).join(' ')}`);
  if (process.env.FAIL_SHOTS) for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(process.env.FAIL_SHOTS, `fail-${i}.png`) }).catch(() => {});
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) { console.error(`downtime e2e: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log('downtime e2e: ok');
