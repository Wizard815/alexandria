// End-to-end smoke test: real librarian + built app + Chromium.
// Run from web/: npm run build && node e2e/smoke.mjs
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = 8199;
const base = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-e2e-'));
const problems = [];
const note = (m) => console.log('  ' + m);

const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/index.ts'], {
  cwd: path.join(root, 'librarian'),
  env: { ...process.env, ALX_DATA_DIR: tmp, LIBRARIAN_PORT: String(PORT), ALX_WEB_DIR: path.join(root, 'web/dist') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.stderr.write('[librarian] ' + d));
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(base + '/health')).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}
const api = async (method, p, token, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(40[34]|409)/.test(m.text()) && !m.text().includes('fonts.g')) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}

try {
  // 1. First run: setup through the UI.
  const dmCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const dm = await dmCtx.newPage();
  watch(dm, 'DM');
  await dm.goto(base + '/');
  await dm.waitForURL('**/setup');
  await dm.getByLabel('Username', { exact: true }).fill('wizard');
  await dm.getByLabel('Password', { exact: true }).fill('correct horse battery');
  await dm.getByRole('button', { name: 'Create the admin account' }).click();
  await dm.waitForURL('**/admin/worlds');
  note('setup ok');

  // 2. Make a world in Library admin, the admin is its DM.
  await dm.getByRole('button', { name: 'New world' }).click();
  await dm.getByLabel('Name', { exact: true }).fill('BloodEarth');
  await dm.getByRole('button', { name: 'Create world' }).click();
  await dm.getByRole('link', { name: 'Open' }).click();
  await dm.waitForURL('**/w/bloodearth/dm');
  note('world made, DM table open');
  const dmToken = await dm.evaluate(() => localStorage.getItem('alx.token'));

  // Some content via the API.
  await api('PUT', '/api/worlds/bloodearth/library/pages', dmToken, { path: 'Old Kesh', visibility: 'party', markdown: '# Old Kesh\nA port.\n\n> [!secret]\n> Smugglers own it.\n' });
  await api('PUT', '/api/worlds/bloodearth/library/pages', dmToken, { path: 'Plot', markdown: 'The twist.' });
  const { code } = await api('POST', '/api/worlds/bloodearth/invites', dmToken, { role: 'player' });

  // 3. A player joins with the code and gets their AI connection.
  const plCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pl = await plCtx.newPage();
  watch(pl, 'Player');
  await pl.goto(`${base}/join?code=${encodeURIComponent(code)}`);
  await pl.getByLabel('Pick a username').fill('jess');
  await pl.getByLabel('Pick a password').fill('player pass 123');
  await pl.getByLabel('Character name').fill('Mira');
  await pl.getByRole('button', { name: 'Join' }).click();
  await pl.getByText('Your AI connection').waitFor();
  const cfg = await pl.locator('pre').first().innerText();
  if (!cfg.includes('alx_scr_') || !cfg.includes('/mcp')) problems.push('join: MCP settings missing');
  note('player joined, read-only AI connection shown');
  await pl.getByRole('button', { name: 'Open the world' }).click();
  await pl.waitForURL('**/w/bloodearth');
  const plToken = await pl.evaluate(() => localStorage.getItem('alx.token'));

  // 4. Lore shows the shared page without the secret.
  await pl.goto(base + '/w/bloodearth/library');
  await pl.waitForTimeout(800);
  const lore = await pl.locator('main').innerText();
  if (!lore.includes('Old Kesh')) problems.push('player library misses a shared page');
  if (lore.includes('Plot')) problems.push('player lore lists a DM-only page');
  if (lore.includes('Smugglers')) problems.push('player lore shows secret text');

  // 5. Quick event reaches the player.
  await pl.goto(base + '/w/bloodearth/live');
  await pl.waitForTimeout(500);
  const me = await api('GET', '/api/me', plToken);
  await api('POST', '/api/worlds/bloodearth/quick-events', dmToken, { kind: 'vote', title: 'Where tonight?', prompt: 'Sleep where?', options: ['The Gull', 'Camp'], audience: [me.account.id], timerS: 120 });
  try {
    await pl.getByRole('dialog').waitFor({ timeout: 6000 });
    note('quick event prompt appeared');
  } catch { problems.push('quick event prompt did not appear for the player'); }

  // 6. Every screen, both roles, no errors; phones have no sideways scroll.
  const dmRoutes = ['', 'combat', 'quick', 'party', 'approvals', 'broker', 'library', 'people', 'relations', 'map', 'requests', 'messages', 'calendar', 'whiteboard', 'settings', 'connect'];
  const plRoutes = ['', 'live', 'library', 'broker', 'people', 'me', 'inventory', 'map', 'messages', 'calendar', 'ask', 'whiteboard', 'connect'];
  for (const r of dmRoutes) { await dm.goto(`${base}/w/bloodearth/dm/${r}`); await dm.waitForTimeout(400); }
  await pl.keyboard.press('Escape');
  for (const r of plRoutes) {
    await pl.goto(`${base}/w/bloodearth/${r}`);
    await pl.waitForTimeout(400);
    const over = await pl.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 2) problems.push(`phone: /${r} scrolls sideways by ${over}px`);
  }
  for (const r of ['', 'accounts', 'worlds', 'sources', 'keys', 'audit']) { await dm.goto(`${base}/admin/${r}`); await dm.waitForTimeout(300); }
  note('visited every screen');
  await dm.goto(base + '/w/bloodearth/dm');
  await dm.screenshot({ path: path.join(tmp, 'dm-table.png'), fullPage: true });
  await pl.goto(base + '/w/bloodearth');
  await pl.screenshot({ path: path.join(tmp, 'player-home.png'), fullPage: true });
  console.log('screenshots in ' + tmp);
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
console.log('e2e ok');
