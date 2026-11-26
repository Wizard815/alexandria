// End-to-end test of house rules (mods): the DM turns on Inspiration as
// rerolls in World settings → House rules and switches the world to spell
// points (confirming the settings it changes), grants Jess a personal reroll
// with a reason on the House rules page; Jess sees it on her home page, rolls
// in session chat, presses Reroll under her roll and the server rerolls it;
// the DM sees the change log, every rule on the Rules tab, and adds a shared
// package under Make or add one. Screenshots go to SHOTS (default: none).
// Run from web/: npm run build && node e2e/houserules.mjs   (HOUSE_PORT, default 19812)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.HOUSE_PORT || 19812);
const SHOTS = process.env.SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('house'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
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

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/409/.test(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}
async function signIn(user, pass, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  watch(page, user);
  page.on('dialog', (d) => void d.accept());
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}

try {
  // 1. World settings → House rules: inspiration rerolls on, then spell points (the DM confirms the settings it sets).
  const { page: dm } = await signIn('dm', 'dungeon master 123', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await dm.goto(`${W}/dm/settings`);
  await dm.getByRole('tab', { name: 'House rules' }).click();
  await dm.getByRole('switch', { name: 'Inspiration as rerolls on' }).click();
  await dm.getByRole('switch', { name: 'Inspiration as rerolls on' }).and(dm.locator('[aria-checked=true]')).waitFor({ timeout: 5000 });
  await dm.getByRole('switch', { name: 'Spell points on' }).click();
  await dm.getByRole('switch', { name: 'Spell points on' }).and(dm.locator('[aria-checked=true]')).waitFor({ timeout: 5000 });
  const s = await api(dmLogin.token, 'GET', '/settings');
  check(s.spellMana === true && s.spellManaCosts[3] === 5, `spell points switched mana on with the standard costs (${s.spellMana}, ${s.spellManaCosts})`);
  await dm.getByRole('button', { name: 'Options and details' }).first().click();
  await shot(dm, '1-world-settings-house-rules');
  note('settings: inspiration rerolls and spell points on');

  // 2. The DM grants Jess a personal reroll with a reason.
  await dm.goto(`${W}/dm/house-rules`);
  await dm.getByLabel(/Reason/).fill('Stayed in character through the interrogation');
  await dm.getByRole('button', { name: 'Grant Personal reroll to Jessamine' }).click();
  await dm.getByText('Stayed in character through the interrogation', { exact: false }).last().waitFor({ timeout: 8000 });
  note('dm: granted a personal reroll');

  // 3. Jess sees it on her home page, rolls in chat and rerolls with the button.
  await api(dmLogin.token, 'POST', '/sessionchat/sessions/start', { title: 'Game night' }).catch(() => {}); // the demo may already run one
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 1280, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await pl.goto(`${W}`);
  await pl.getByRole('heading', { name: 'Rerolls' }).waitFor({ timeout: 8000 });
  check(await pl.getByLabel('Personal reroll: 1 of 1').count() > 0, 'Jess holds 1 personal reroll on her home page');
  await shot(pl, '2-player-home-rerolls');
  await pl.goto(`${W}/chat`);
  await pl.getByLabel('Message').fill('/roll 1d20+4 stealth');
  await pl.getByLabel('Message').press('Enter');
  await pl.getByRole('button', { name: /Reroll my roll/ }).first().waitFor({ timeout: 8000 });
  await shot(pl, '3-player-reroll-button');
  await pl.getByRole('button', { name: /Reroll my roll/ }).first().click();
  await pl.getByText(/reroll of Jessamine's \d+ \(Personal reroll\)/).first().waitFor({ timeout: 8000 });
  await shot(pl, '4-player-rerolled-in-chat');
  const c = await api(jessLogin.token, 'GET', '/mods/counters');
  check(c.players[0].mods['inspiration-rerolls'].find((x) => x.id === 'personal').value === 0, 'the token is spent');
  note('player: rolled and rerolled in chat');

  // 4. The DM's log shows both.
  await dm.goto(`${W}/dm/house-rules`);
  await dm.getByText(/Reroll my roll by Jessamine/).first().waitFor({ timeout: 8000 });
  await shot(dm, '5-dm-house-rules-page');
  note('dm: the change log has the grant and the reroll');

  // 5. The same page lists every rule (spell systems too) and adds a package someone shared.
  await dm.getByRole('tab', { name: /^Rules/ }).click();
  await dm.getByRole('switch', { name: 'Spell points on' }).waitFor({ timeout: 8000 });
  check(await dm.getByRole('switch', { name: 'MANA spell system on' }).count() === 1, 'the Rules tab lists the MANA system');
  await shot(dm, '6-dm-house-rules-all-rules');
  const shared = await api(dmLogin.token, 'GET', '/mods/export');
  check(shared.type === 'alexandria-house-rules' && shared.mods.some((m) => m.id === 'inspiration-rerolls'), 'export gives a package of the rules that are on');
  const hero = JSON.parse(fs.readFileSync(path.join(root, 'mods/examples/hero-points.alxmod.json'), 'utf8'));
  const pkg = { type: 'alexandria-house-rules', kit: 1, name: 'Table extras', author: 'Another DM', mods: [hero] };
  await dm.getByRole('tab', { name: 'Make or add one' }).click();
  await dm.getByRole('button', { name: 'Hero points' }).click();
  check((await dm.getByLabel('Describe your house rule').inputValue()).startsWith('Hero points'), 'a starter idea fills the description');
  await dm.getByLabel('House rule file').fill(JSON.stringify(pkg, null, 2));
  await dm.getByRole('button', { name: 'Check' }).click();
  await dm.getByText(/Looks good/).waitFor({ timeout: 8000 });
  await shot(dm, '7-dm-make-or-add-a-rule');
  await dm.getByRole('button', { name: 'Save to this world' }).click();
  await dm.getByRole('tab', { name: /^Rules/ }).click();
  await dm.getByRole('switch', { name: 'Hero points on' }).waitFor({ timeout: 8000 });
  note('dm: rules tab lists every rule; a shared package was added');
} catch (e) {
  problems.push('crashed: ' + (e.stack || e));
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('house rules ok');
