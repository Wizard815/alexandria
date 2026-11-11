// Offline test: a player opens the world, the app saves it on the device,
// the server stops, and a full reload still shows the world read-only.
// Run from web/: npm run build && node e2e/offline.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = 8198;
const base = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-offline-'));
const problems = [];
const note = (m) => console.log('  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start() {
  const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: path.join(root, 'librarian'),
    env: { ...process.env, ALX_DATA_DIR: tmp, LIBRARIAN_PORT: String(PORT), ALX_WEB_DIR: path.join(root, 'web/dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => process.stderr.write('[librarian] ' + d));
  return srv;
}
async function up() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('librarian did not start');
}
const api = async (method, p, token, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

let srv = start();
await up();
const browser = await chromium.launch();
try {
  // World with shared and DM-only content.
  const admin = await api('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' });
  const dmToken = admin.token;
  await api('POST', '/api/admin/worlds', dmToken, { name: 'BloodEarth', dmAccountId: admin.account.id });
  const W = '/api/worlds/bloodearth';
  await api('PUT', `${W}/library/pages`, dmToken, { path: 'Old Kesh', visibility: 'party', markdown: '# Old Kesh\nA port town on the red coast. See [[Ash Road]] and [[Plot]].\n\n> [!secret]\n> SECRET-SMUGGLERS own it.\n' });
  await api('PUT', `${W}/library/pages`, dmToken, { path: 'Ash Road', visibility: 'party', markdown: '# Ash Road\nThe old trade road.' });
  await api('PUT', `${W}/library/pages`, dmToken, { path: 'Plot', markdown: 'SECRET-TWIST: the king is dead.' });
  for (let i = 0; i < 120; i++) await api('PUT', `${W}/library/pages`, dmToken, { path: `Lore/Note ${i}`, visibility: 'party', markdown: `# Note ${i}\nShared note number ${i}.` });
  const { code } = await api('POST', `${W}/invites`, dmToken, { role: 'player' });
  const pl = await api('POST', '/api/join', null, { code, username: 'jess', password: 'player pass 123', characterName: 'Mira' });
  await api('POST', `${W}/inventory`, dmToken, { owner: 'party', name: 'Lantern of Ash', qty: 1, dmNote: 'SECRET-DMNOTE cursed', reason: 'Found in the crypt' });
  await api('POST', `${W}/inventory`, dmToken, { owner: pl.account.id, name: 'Rope (50 ft)', qty: 1, dmNote: 'SECRET-DMNOTE2', reason: 'Bought in town' });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

  // 1. Sign in (token in storage, as after /join) and open the world online.
  await page.goto(base + '/login');
  await page.evaluate((t) => localStorage.setItem('alx.token', t), pl.token);
  await page.goto(base + '/w/bloodearth');
  await page.waitForFunction(() => document.querySelector('main')?.textContent?.length > 0);
  await page.evaluate(async () => { await navigator.serviceWorker?.ready; });
  // Visit the screens once, the way a player would.
  for (const r of ['library', 'inventory', 'broker', 'people', 'calendar', 'messages']) { await page.goto(`${base}/w/bloodearth/${r}`); await sleep(400); }
  await page.goto(`${base}/w/bloodearth/library`);
  // 2. Background save: wait until every visible page is stored.
  const deadline = Date.now() + 30_000;
  let stored = 0;
  while (Date.now() < deadline) {
    stored = await page.evaluate(() => new Promise((res) => {
      const req = indexedDB.open('alexandria-offline');
      req.onsuccess = () => {
        const t = req.result.transaction('responses').objectStore('responses').getAllKeys();
        t.onsuccess = () => res(t.result.filter((k) => /\/library\/pages\/[^/?]+$/.test(String(k))).length);
      };
      req.onerror = () => res(0);
    }));
    if (stored >= 122) break;
    await sleep(500);
  }
  if (stored < 122) problems.push(`only ${stored}/122 shared pages saved for offline`);
  note(`saved for offline: ${stored} pages`);

  // 3. Stop the server; reload everything from scratch.
  srv.kill('SIGTERM');
  await new Promise((r) => srv.once('exit', r));
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.includes('Offline'), null, { timeout: 15_000 });
  let text = await page.locator('body').innerText();
  if (!text.includes('read-only')) problems.push('no read-only banner after reload');
  if (text.includes('could not be opened')) problems.push('world did not open offline');
  note('world opened offline after a full reload');

  // Library tree and a page.
  await page.getByText('Old Kesh').first().click();
  await page.getByText('A port town on the red coast').waitFor({ timeout: 10_000 });
  text = await page.locator('body').innerText();
  if (text.includes('SECRET-')) problems.push('a DM secret is on screen offline');
  note('library page renders offline');

  // Inventory.
  await page.goto(`${base}/w/bloodearth/inventory`);
  await page.getByText('Rope (50 ft)').first().waitFor({ timeout: 10_000 });
  note('inventory shows offline');
  const addBtns = page.locator('main button:not([disabled])', { hasText: /^(Add|Save|Send|Pay|Ask)/ });
  if (await addBtns.count()) problems.push(`${await addBtns.count()} write buttons are still enabled offline: ${(await addBtns.allInnerTexts()).join(', ')}`);
  const refused = await page.evaluate(async () => {
    const r = await fetch('/api/worlds/bloodearth/inventory', { method: 'POST' }).then(() => 'reached', () => 'unreachable');
    return r;
  });
  if (refused !== 'unreachable') problems.push('server still reachable?');
  note('write buttons disabled');

  // 4. No DM-only text anywhere in the player's offline data.
  const dump = await page.evaluate(() => new Promise((res) => {
    const req = indexedDB.open('alexandria-offline');
    req.onsuccess = () => {
      const db = req.result;
      const out = [];
      const t = db.transaction(['responses', 'pages']);
      t.objectStore('responses').getAll().onsuccess = (e) => out.push(JSON.stringify(e.target.result));
      t.objectStore('pages').getAll().onsuccess = (e) => out.push(JSON.stringify(e.target.result));
      t.oncomplete = () => res(out.join('\n'));
    };
  }));
  for (const s of ['SECRET-SMUGGLERS', 'SECRET-TWIST', 'SECRET-DMNOTE']) if (dump.includes(s)) problems.push(`offline data contains ${s}`);
  if (!dump.includes('Shared note number 119')) problems.push('offline data misses a shared page');
  note(`offline data checked (${Math.round(dump.length / 1024)} KB): no DM-only text`);

  // 5. Server back: the app reconnects by itself and writing works again.
  srv = start();
  await up();
  await page.waitForFunction(() => !document.body.innerText.includes('Offline — read-only'), null, { timeout: 20_000 });
  note('reconnected on its own');

  // 6. Signing out forgets this account's offline data.
  await page.evaluate(async () => {
    const before = await new Promise((res) => { const r = indexedDB.open('alexandria-offline'); r.onsuccess = () => { const q = r.result.transaction('responses').objectStore('responses').count(); q.onsuccess = () => res(q.result); }; });
    window.__before = before;
  });
  await page.getByRole('button', { name: 'Sign out' }).first().click({ force: true }).catch(async () => {
    // Phone layout: the button may be off-screen; call it through the topbar.
    await page.locator('button', { hasText: 'Sign out' }).first().evaluate((b) => b.click());
  });
  await sleep(800);
  const left = await page.evaluate((acct) => new Promise((res) => {
    const r = indexedDB.open('alexandria-offline');
    r.onsuccess = () => { const q = r.result.transaction('responses').objectStore('responses').index('byAccount').count(acct); q.onsuccess = () => res(q.result); };
  }), pl.account.id);
  if (left !== 0) problems.push(`${left} cached answers left after sign-out`);
  note('sign-out cleared the offline data');
} catch (e) {
  problems.push('crashed: ' + (e.stack ?? e));
} finally {
  await browser.close();
  srv.kill('SIGTERM');
}
if (problems.length) {
  console.error('offline e2e FAILED:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('offline e2e ok');
