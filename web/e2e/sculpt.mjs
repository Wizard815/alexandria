// Browser check for Sculpting: the template library, and combat -> Encounter ->
// Run it -> initiative, at desktop (1280) and phone (390) width.
// Run from web/: npm run build && SCULPT_E2E_PORT=8600 node e2e/sculpt.mjs
// Uses the seeded demo world on fake models. Needs Playwright with Chromium.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = Number(process.env.SCULPT_E2E_PORT || 8198);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-sculpt-e2e-'));
const problems = [];

const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'librarian/scripts/demo.ts', '--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
for (let i = 0; i < 150 && !out.includes('Alexandria demo is running'); i++) await new Promise((r) => setTimeout(r, 200));
if (!out.includes('Alexandria demo is running')) { srv.kill(); console.log('demo did not start'); process.exit(1); }

const browser = await chromium.launch();
try {
  for (const [label, vp] of [['1280', { width: 1280, height: 900 }], ['390', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
    await page.goto(base + '/login');
    await page.getByLabel(/username/i).fill('dm');
    await page.getByLabel(/password/i).fill('dungeon master 123');
    await page.getByRole('button', { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/w\//, { timeout: 15000 });

    await page.goto(`${W}/dm/sculpt`);
    await page.getByRole('tab', { name: 'Combat' }).click();
    await page.getByText('Encounter', { exact: true }).first().waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problems.push(`${label}: the library scrolls sideways`);
    await page.getByRole('tab', { name: 'All' }).click();
    await page.getByLabel('Search templates').fill('trap');
    if ((await page.locator('.sculpt-card').count()) < 1) problems.push(`${label}: search found nothing`);

    await page.goto(`${W}/dm/combat`);
    const rows = () => page.locator('[aria-label="Initiative order"] .card').count();
    await page.waitForTimeout(500);
    const before = await rows();
    await page.getByRole('button', { name: 'Encounter', exact: true }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('Monsters').first().waitFor({ timeout: 10000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problems.push(`${label}: the sheet scrolls sideways`);
    await dlg.getByRole('button', { name: 'Run it' }).click();
    await dlg.getByText(/in initiative/).waitFor({ timeout: 10000 });
    await dlg.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(600);
    if (!((await rows()) > before)) problems.push(`${label}: Run it added nobody to initiative`);
    await ctx.close();
  }
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'sculpt e2e: all ok');
process.exit(problems.length ? 1 : 0);
