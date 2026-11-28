// End-to-end test of homebrew rules: the Game Master opens House rules → Homebrew, starts from the "Bonus action
// strike" example (a roll button at disadvantage) and saves it; Jess imports nothing, sees the rule on her House
// rules page with its Homebrew badge, and presses Roll under Homebrew rolls on her home page: the server rolls
// 2d20kl1 plus her bonus and posts it in table chat. The Game Master then edits the rule. Screenshots go to SHOTS.
// Run from web/: npm run build && node e2e/homebrew.mjs   (HOMEBREW_PORT, default 19813)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.HOMEBREW_PORT || 19813);
const SHOTS = process.env.SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('homebrew'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const gmLogin = await login('dm', 'dungeon master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + gmLogin.token } })).json())[0].id;
const api = async (token, method, p, body) => {
  const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const browser = await chromium.launch();
async function signIn(user, pass, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${user} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/409/.test(m.text())) problems.push(`${user} console on ${page.url()}: ${m.text()}`); });
  page.on('dialog', (d) => void d.accept());
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}

try {
  const scale = SHOTS ? 2 : 1;
  // 1. The Game Master adds the rule from the example.
  const { page: gm } = await signIn('dm', 'dungeon master 123', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: scale });
  await gm.goto(`${W}/dm/house-rules`);
  await gm.getByRole('tab', { name: 'Homebrew' }).click();
  await gm.getByRole('button', { name: 'Bonus action strike' }).click();
  check((await gm.getByLabel('Name').inputValue()) === 'Bonus action strike', 'the example fills the name');
  await shot(gm, '1-gm-homebrew-form');
  await gm.getByRole('button', { name: 'Save and turn on' }).click();
  await gm.getByRole('switch', { name: 'Bonus action strike on' }).and(gm.locator('[aria-checked=true]')).waitFor({ timeout: 8000 });
  await shot(gm, '2-gm-homebrew-saved');
  const rule = (await api(gmLogin.token, 'GET', '/mods')).mods.find((m) => m.id === 'hb-bonus-action-strike');
  check(rule?.enabled && rule.rolls?.[0]?.mode === 'disadvantage', 'the rule is on with its roll button');
  note('gm: homebrew rule saved and on');

  // 2. Jess sees it and rolls it.
  await api(gmLogin.token, 'POST', '/sessionchat/sessions/start', { title: 'Homebrew night' }).catch(() => {});
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, deviceScaleFactor: scale, isMobile: true, hasTouch: true });
  await pl.goto(`${W}/house-rules`);
  await pl.getByRole('heading', { name: /Bonus action strike/ }).waitFor({ timeout: 8000 });
  await pl.getByText('Homebrew', { exact: true }).first().waitFor({ timeout: 5000 });
  await shot(pl, '3-player-house-rules-page');
  await pl.goto(`${W}`);
  await pl.getByRole('heading', { name: 'Homebrew rolls' }).waitFor({ timeout: 8000 });
  await pl.getByLabel('Bonus for Bonus action strike').fill('5').catch(async () => { await pl.locator('input[aria-label^="Bonus for"]').first().fill('5'); });
  await pl.getByRole('button', { name: 'Roll' }).first().click();
  await pl.getByText(/Rolled 2d20kl1\+5: \d+/).waitFor({ timeout: 8000 });
  await shot(pl, '4-player-homebrew-roll');
  await pl.goto(`${W}/chat`);
  await pl.getByText(/Bonus action strike at disadvantage \(Bonus action strike\)|at disadvantage \(Bonus action strike\)/).first().waitFor({ timeout: 8000 });
  await shot(pl, '5-player-roll-in-chat');
  note('player: saw the rule and rolled it at disadvantage');

  // 3. The Game Master edits it.
  await gm.getByRole('button', { name: 'Edit' }).first().click();
  await gm.getByLabel('The rule, as players read it').fill('You can make one light weapon attack with your bonus action, at disadvantage.');
  await gm.getByRole('button', { name: 'Save changes' }).click();
  await gm.getByText('v1.0.1').waitFor({ timeout: 8000 });
  note('gm: edited the rule (v1.0.1)');
} catch (e) { problems.push('run failed: ' + e.message); } finally { await browser.close(); srv.kill(); }
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('homebrew ok');
