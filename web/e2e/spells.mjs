// End-to-end test of the Codex: the DM turns on mana and spell crafting in
// World settings, makes Fire Bolt + Burning Hands -> Scorching Ray with an
// INT 13 minimum in the recipe editor; a player on a phone sees it locked
// (and why), raises INT to 13 on their spell sheet, sees it ready, asks to
// learn it; the DM approves; the player has the spell, sees the mana pool and
// casts it. Also: the DM's notes on the recipe never reach the player's page.
// Run from web/: npm run build && node e2e/spells.mjs   (SPELLS_PORT, default 19811)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.SPELLS_PORT || 19811);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('spells'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
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

// Jess starts as a level 3 wizard with INT 12 who knows Fire Bolt and Burning Hands.
await api(dmLogin.token, 'POST', `/spells/characters/${jessId}/known`, { spellId: 'srd:fire-bolt' });
await api(dmLogin.token, 'POST', `/spells/characters/${jessId}/known`, { spellId: 'srd:burning-hands' });
await api(jessLogin.token, 'PUT', '/spells/characters/me', { class: 'Wizard', level: 3, abilities: { int: 12 }, castingAbility: 'int' });

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/409/.test(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
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
  // 1. The DM turns on mana and spell crafting in World settings.
  const { page: dm } = await signIn('dm', 'dungeon master 123', { viewport: { width: 1366, height: 900 } });
  await dm.goto(`${W}/dm/settings`);
  await dm.getByRole('tab', { name: 'Spells & mana' }).click();
  await dm.getByRole('switch', { name: 'Use mana' }).click();
  await dm.getByRole('switch', { name: 'Learn spells by combining known ones' }).click();
  await dm.getByRole('switch', { name: 'Learn spells by combining known ones' }).and(dm.locator('[aria-checked=true]')).waitFor({ timeout: 5000 });
  const s = await api(dmLogin.token, 'GET', '/settings');
  check(s.spellMana === true && s.spellCrafting === true, `mana and crafting are on (${s.spellMana}, ${s.spellCrafting})`);
  note('settings: mana and crafting on');

  // 2. The DM makes the recipe in the editor.
  await dm.goto(`${W}/dm/codex`);
  await dm.getByRole('tab', { name: 'Recipes' }).click();
  await dm.getByRole('button', { name: 'New recipe' }).click();
  const ed = dm.getByRole('dialog', { name: 'New recipe' });
  await ed.getByLabel('Spell learned', { exact: true }).fill('Scorching Ray');
  await ed.getByLabel('Prerequisite 1', { exact: true }).fill('Fire Bolt');
  await ed.getByLabel('Prerequisite 2', { exact: true }).fill('Burning Hands');
  await ed.getByLabel('Minimum INT', { exact: true }).fill('13');
  await ed.getByLabel('DM notes (never shown to players)').fill('ZQX-E2E-RECIPENOTE the volcano teaches it');
  await ed.getByRole('button', { name: 'Save recipe' }).click();
  await ed.waitFor({ state: 'detached', timeout: 5000 });
  const card = dm.getByTestId('recipe-Scorching Ray');
  await card.waitFor({ timeout: 5000 });
  check(/Fire Bolt/.test(await card.innerText()) && /Burning Hands/.test(await card.innerText()) && /INT 13\+/.test(await card.innerText()), 'the recipe card shows its prerequisites and INT 13');
  check(await dm.getByRole('heading', { name: 'Tier 1' }).isVisible(), 'the recipe sits in tier 1');
  note('recipe: Fire Bolt + Burning Hands -> Scorching Ray, INT 13');

  // 3. The player on a phone: locked, and why.
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await closeQuick(pl);
  await pl.goto(`${W}/codex`);
  await pl.getByRole('tab', { name: /^Learn/ }).click();
  const rc = pl.getByTestId('recipe-Scorching Ray');
  await rc.waitFor({ timeout: 8000 });
  check(/Locked/.test(await rc.innerText()), 'the recipe is locked for the player');
  check(await pl.getByRole('list', { name: 'Still needed for Scorching Ray' }).getByText('Intelligence 13 (12)').isVisible(), 'it says INT 13 is missing (12 now)');
  check(!(await pl.content()).includes('ZQX-E2E-RECIPENOTE'), 'the DM note on the recipe is not on the player page');
  const wide = await pl.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 1, `no sideways scrolling on the phone (${wide}px)`);
  note('player (phone): locked, needs Intelligence 13');

  // 4. The player raises INT to 13 on the spell sheet: learnable now; asks the DM.
  await pl.getByRole('button', { name: 'My spell sheet' }).click();
  const sheet = pl.getByRole('dialog', { name: 'My spell sheet' });
  await sheet.getByLabel('INT', { exact: true }).fill('13');
  await sheet.getByRole('button', { name: 'Save sheet' }).click();
  await sheet.waitFor({ state: 'detached', timeout: 5000 });
  await pl.getByText('Ready to learn', { exact: true }).first().waitFor({ timeout: 8000 });
  check(/Ready to learn/.test(await rc.innerText()), 'the recipe is ready once INT is 13');
  check(await rc.evaluate((e) => e.classList.contains('ready')), 'the ready recipe is highlighted');
  await rc.getByRole('button', { name: 'Ask to learn Scorching Ray' }).click();
  await rc.getByText('Waiting for the DM.').waitFor({ timeout: 8000 });
  note('player: ready, asked to learn');

  // 5. The DM approves.
  await dm.getByRole('tab', { name: /^Requests/ }).click();
  const req = dm.getByRole('button', { name: 'Approve' }).first();
  await req.waitFor({ timeout: 8000 });
  await req.click();
  await dm.getByText(/approved/).first().waitFor({ timeout: 8000 });
  note('DM: approved');

  // 6. The player knows it (live), sees the mana pool and casts it.
  await pl.getByRole('tab', { name: /^My spells/ }).click();
  await pl.getByRole('button', { name: 'Cast Scorching Ray' }).waitFor({ timeout: 8000 });
  const mana = pl.getByTestId('mana').first();
  const before = await mana.innerText();
  check(/13 \/ 13/.test(before), `a full pool of 13 (level 3 × 4 + INT mod 1): ${before.replace(/\s+/g, ' ')}`);
  await pl.getByRole('button', { name: 'Cast Scorching Ray' }).click();
  await pl.getByTestId('mana').first().getByText('10 / 13').waitFor({ timeout: 8000 });
  note('player: cast Scorching Ray, mana 13 -> 10');
  const me = await api(jessLogin.token, 'GET', '/spells/characters/me');
  check(me.known.some((x) => x.name === 'Scorching Ray' && x.how === 'crafted') && me.mana.now === 10, 'the server agrees: known, crafted, 10 mana');
  const pc = await pl.content();
  check(!pc.includes('ZQX-E2E-RECIPENOTE'), 'still no DM note on the player page');

  // 7. The spell tree (spell rules on): every spell by school, studying from the panel.
  await api(dmLogin.token, 'PATCH', '/settings', { spellRulesOn: true, spellCraftApproval: 'auto' });
  await api(dmLogin.token, 'PUT', `/spells/characters/${jessId}/caster`, { casterLevels: { full: 3 } });
  await api(dmLogin.token, 'POST', '/spells/recipes', { result: 'Shatter', prereqs: ['Burning Hands', 'Magic Missile'] });
  await api(dmLogin.token, 'POST', `/spells/characters/${jessId}/known`, { spellId: 'srd:magic-missile' });
  await pl.getByRole('tab', { name: 'Spell tree' }).click();
  await pl.getByRole('group', { name: 'Evocation' }).waitFor({ timeout: 8000 });
  const nodes = await pl.locator('.stg-node').count();
  check(nodes > 300, `every SRD spell is on the tree (${nodes})`);
  check(await pl.getByRole('button', { name: 'Scorching Ray, Level 2, Known' }).count() === 1, 'Scorching Ray shows as known');
  check(await pl.getByRole('button', { name: 'Wish, Level 9, Unknown' }).count() === 1, 'Wish is dark');
  check(await pl.getByRole('button', { name: 'Shatter, Level 2, Can learn' }).count() === 1, 'Shatter can be learned');
  await pl.getByLabel('Search spells').fill('Shatter');
  await pl.getByLabel('Search spells').press('Enter');
  const panel = pl.getByRole('complementary', { name: 'Shatter details' });
  await panel.getByRole('button', { name: 'Start learning' }).click();
  await panel.getByLabel('Downtime days').fill('3');
  await panel.getByRole('button', { name: 'Log study days' }).click();
  await panel.getByLabel('d20 (empty: roll)').fill('18');
  await panel.getByRole('button', { name: 'Roll the final check' }).click();
  await panel.getByText(/Shatter is learned!/).waitFor({ timeout: 8000 });
  note('player: studied Shatter on the spell tree and learned it');
  await dm.getByRole('tab', { name: 'Spell tree' }).click();
  await dm.locator('.stack > label select').first().selectOption(jessId);
  await dm.getByRole('button', { name: 'Shatter, Level 2, Known' }).waitFor({ timeout: 8000 });
  note('DM: sees the same tree for Jess');
} catch (e) {
  problems.push('crashed: ' + (e.stack || e));
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('spells ok');
