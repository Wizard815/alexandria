// Server rules (mods with scope "server") end to end: the shipped mods/ folder plus one test server rule, the demo
// and Chromium. Admin → Mods lists it, its switch turns it on for the server (and /api/server-mods says so to a
// table account), and worlds never list it in their House rules. Run from web/: npm run build && node e2e/servermods.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir } from './lib.mjs';

const PORT = Number(process.env.SERVERMODS_E2E_PORT || 8219);
const base = `http://127.0.0.1:${PORT}`;
const tmp = tmpDir('servermods');
const modsDir = path.join(tmp, 'mods');
fs.cpSync(path.join(root, 'mods'), modsDir, { recursive: true });
fs.writeFileSync(path.join(modsDir, 'srv-e2e.alxmod.json'), JSON.stringify({ kit: 2, id: 'srv-e2e', name: 'Test source', version: '1.0.0', scope: 'server', summary: 'A server rule for the e2e.' }));
process.env.ALX_MODS_DIR = modsDir;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); else console.log('  ok: ' + msg); return ok; };
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
const browser = await chromium.launch();
try {
  const dm = (await j('POST', '/api/auth/login', null, { username: 'dm', password: 'dungeon master 123' })).x.token;
  check(!(await j('GET', '/api/server-mods', dm)).x.on?.includes('srv-e2e'), 'the rule starts off');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.goto(base + '/admin/login');
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('library admin 123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.startsWith('/admin/login'), { timeout: 15000 });
  await page.getByRole('link', { name: 'Mods' }).first().click().catch(async () => { await page.getByRole('button', { name: /Server/ }).click(); await page.getByRole('link', { name: 'Mods' }).first().click(); });
  await page.getByTestId('servermod-srv-e2e').waitFor({ timeout: 10000 });
  check(true, 'Admin → Mods lists the server rule');
  await page.getByRole('switch', { name: 'Test source on' }).click();
  await page.locator('.toast').waitFor({ timeout: 5000 });
  check((await page.getByRole('switch', { name: 'Test source on' }).getAttribute('aria-checked')) === 'true', 'its switch turns it on');
  check((await j('GET', '/api/server-mods', dm)).x.on?.includes('srv-e2e'), 'a table account sees it on');
  const WID = (await j('GET', '/api/worlds', dm)).x[0].id;
  const list = (await j('GET', `/api/worlds/${WID}/mods`, dm)).x;
  check(!JSON.stringify(list).includes('srv-e2e'), "a world's House rules never list it");
  await page.screenshot({ path: path.join(tmp, 'admin-mods.png') });
  console.log(`  screenshot: ${path.join(tmp, 'admin-mods.png')}`);
} catch (e) { problems.push('run failed: ' + e.message); } finally { await browser.close(); srv.kill(); }
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('servermods ok');
