// Button crawler. Signs in to the seeded demo world and, for every DM page and
// every player page, at desktop and phone width:
//   - clicks every visible button, link, tab and switch (skipping destructive ones),
//   - fills and submits every form with sample values,
//   - records console errors, page errors, failed requests (4xx/5xx except the
//     expected 403/404) and dead controls (no request, no DOM change, no navigation).
// Then it presses the destructive controls on throwaway items.
// Run from web/: npm run build && node e2e/buttons.mjs   (BTN_PORT, BTN_SHOTS=<dir>, BTN_ONLY=dm|player)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, DM_ROUTES, PLAYER_ROUTES, quiet, INIT, DESTRUCTIVE } from './lib.mjs';

const PORT = Number(process.env.BTN_PORT || 8198);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const PASS = { dm: 'dungeon master 123', jess: 'player pass 123' };
const t0 = Date.now();

const { srv, out } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('btn'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const stats = {};
for (const line of out.split('\n')) if (line.includes('✗')) problems.push('demo seed step failed: ' + line.trim());

// Controls that look dead but are right (state lives elsewhere, or the click only copies / plays).
const ALLOW_DEAD = [
  /^shell\|(Allow sound|Mute|Unmute)/, // audio unlock gives no DOM change in a headless browser
];

async function crawlRole({ user, label, viewport, mobile, routes, prefix }) {
  const tag = `${label} ${user}`;
  const st = (stats[tag] = { pages: 0, clicks: 0, forms: 0, dead: 0, skipped: 0 });
  const { ctx, page } = await signIn(browser, base, user, PASS[user], viewport, mobile);
  await ctx.addInitScript(INIT);
  let reqs = 0, dialogs = 0, downloads = 0;
  let here = '';
  const bad = (m) => problems.push(`${tag} ${here}: ${m}`);
  page.on('pageerror', (e) => bad(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) bad(`console: ${m.text().slice(0, 200)}`); });
  page.on('request', (r) => { if (['fetch', 'xhr', 'document'].includes(r.resourceType()) && !r.url().includes('/events')) reqs++; });
  page.on('response', (r) => { const s = r.status(); if (s >= 400 && s !== 403 && s !== 404 && !r.url().includes('fonts.g')) bad(`${s} ${r.request().method()} ${r.url().replace(base, '')}`); });
  page.on('requestfailed', (r) => { const f = r.failure()?.errorText ?? ''; if (!/ABORTED/.test(f) && !r.url().includes('fonts.g') && !r.url().includes('/events')) bad(`request failed (${f}) ${r.url().replace(base, '')}`); });
  page.on('dialog', (d) => { dialogs++; void d.dismiss().catch(() => {}); });
  page.on('download', () => { downloads++; });

  const open = async (url) => { await page.goto(url); await page.locator('main, .page, #root > *').first().waitFor({ timeout: 10000 }).catch(() => {}); await page.waitForTimeout(250); };
  const snap = () => page.evaluate(() => window.__crawl.snap());
  const dead = (what) => {
    if (ALLOW_DEAD.some((re) => re.test(what))) return;
    st.dead++; problems.push(`${tag} ${here}: DEAD control, no request/DOM change/navigation: ${what}`);
  };

  /** Click one control and judge what happened. Returns 'changed' | 'dead' | 'gone' | 'skipped'. */
  async function press(c, shot) {
    const el = await page.evaluateHandle(([k, n]) => window.__crawl.find(k, n), [c.key, c.nth]);
    if (!(await el.evaluate((e) => !!e).catch(() => false))) return 'gone';
    const before = await snap();
    const r0 = reqs, d0 = dialogs, dl0 = downloads;
    try { await el.asElement().scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {}); await el.asElement().click({ timeout: 3000 }); }
    catch (e) {
      const why = String(e.message);
      if (/intercepts pointer events/.test(why)) bad(`control is covered by something else: ${c.key} (${why.split('\n').find((l) => /intercepts/.test(l))?.trim().slice(0, 140)})`);
      return 'skipped';
    }
    st.clicks++;
    await page.waitForTimeout(150);
    let after = await snap();
    if (after === before && reqs === r0) { await page.waitForTimeout(350); after = await snap(); }
    if (shot) await page.screenshot({ path: shot }).catch(() => {});
    if (after === before && reqs === r0 && dialogs === d0 && downloads === dl0 && c.nth > 0) return 'changed';
    if (after === before && reqs === r0 && dialogs === d0 && downloads === dl0) { dead(`${c.key}  ${(await el.evaluate((e) => e.outerHTML.slice(0, 140)).catch(() => ''))}`); return 'dead'; }
    return 'changed';
  }

  const clickable = (c, seen) => {
    if (seen.has(c.key + '#' + c.nth)) return false;
    seen.add(c.key + '#' + c.nth);
    if (c.nth > 2) return false; // lists of the same control (Reply on each message): the first few stand for all
    if (c.selected) return false; // already the chosen radio, tab or link: pressing it again rightly does nothing
    if (c.submit) return false; // forms are handled with sample values
    if (DESTRUCTIVE.test(c.label) || DESTRUCTIVE.test(c.title)) { st.skipped++; return false; }
    if (c.href && !(c.href.startsWith('/') || c.href.startsWith(base) || c.href.startsWith('#'))) return false;
    if (c.target === '_blank' || c.download) return false;
    return true;
  };

  let shellDone = false;
  for (const r of routes) {
    const url = `${W}/${prefix}${r}`.replace(/\/$/, '');
    here = `/${prefix}${r}`;
    await open(url);
    st.pages++;
    const seen = new Set();
    const first = await page.evaluate(() => window.__crawl.list());
    // Shell controls (menu, dock, top bar) are the same on every page: press them on the first page only.
    const todo = first.filter((c) => (shellDone ? c.region === 'main' : true)).filter((c) => clickable(c, seen)).sort((a, b) => (a.region === 'main' ? 0 : 1) - (b.region === 'main' ? 0 : 1));
    for (const c of first) if (!todo.includes(c)) seen.add(c.key + '#' + c.nth);
    for (const c of todo.slice(0, 40)) {
      const urlBefore = page.url();
      const res = await press(c);
      if (res === 'gone' || res === 'skipped') continue;
      // New controls (a panel or dialog opened): press those too, one level down.
      const now = await page.evaluate(() => window.__crawl.list()).catch(() => []);
      const fresh = now.filter((n) => !seen.has(n.key + '#' + n.nth) && n.region !== 'main' && (c.region === 'shell' || n.region !== 'shell')).slice(0, 14);
      for (const n of fresh) if (clickable(n, seen)) { await press(n); }
      const stuck = await page.evaluate(() => !!document.querySelector('.modal-back, .sx-back, [role=dialog], [aria-modal=true]')).catch(() => false);
      if (page.url() !== urlBefore || fresh.length || stuck) await open(url);
      else { await page.keyboard.press('Escape').catch(() => {}); }
    }
    if (!shellDone) { await page.evaluate(() => { try { localStorage.setItem('alx-agent-open', '0'); } catch { /* blocked */ } }); await open(url); }
    shellDone = true;

    // Forms: sample values, then submit.
    const nForms = await page.locator('main form').count();
    for (let i = 0; i < Math.min(nForms, 12); i++) {
      const form = page.locator('main form').nth(i);
      if (!(await form.isVisible().catch(() => false))) continue;
      const subs = form.locator('button[type=submit], button:not([type])');
      const sub = subs.first();
      if (!(await sub.count())) continue;
      const sl = ((await sub.innerText().catch(() => '')) + ' ' + ((await sub.getAttribute('aria-label')) ?? '')).trim();
      if (DESTRUCTIVE.test(sl) || (await form.locator('input[type=password], input[type=file]').count())) { st.skipped++; continue; }
      const fields = form.locator('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range]):not([type=color]), textarea, select');
      const nf = await fields.count();
      for (let j = 0; j < nf; j++) {
        const f = fields.nth(j);
        if (!(await f.isVisible().catch(() => false)) || !(await f.isEditable().catch(() => false))) continue;
        const tag2 = await f.evaluate((e) => e.tagName);
        const type = (await f.getAttribute('type')) ?? 'text';
        try {
          if (tag2 === 'SELECT') { const n = await f.locator('option').count(); if (n > 1 && !(await f.inputValue())) await f.selectOption({ index: 1 }, { timeout: 1000 }); continue; }
          if ((await f.inputValue()) !== '') continue;
          const v = type === 'number' ? '3' : type === 'email' ? 'crawler@example.com' : type === 'date' ? '2026-01-01' : type === 'time' ? '10:00' : type === 'url' ? 'https://example.com' : type === 'search' ? 'harbour' : 'Crawler sample';
          await f.fill(v, { timeout: 1000 });
        } catch { /* a field that will not take the value: the submit result decides */ }
      }
      if (await sub.isDisabled().catch(() => false)) { continue; }
      const before = await snap();
      const r0 = reqs, d0 = dialogs;
      try { await sub.click({ timeout: 3000 }); } catch { continue; }
      st.forms++;
      await page.waitForTimeout(400);
      const invalid = await form.evaluate((f) => !f.checkValidity()).catch(() => false);
      if (invalid) continue; // the browser's own validation answered
      let after = await snap();
      if (after === before && reqs === r0) { await page.waitForTimeout(500); after = await snap(); }
      if (after === before && reqs === r0 && dialogs === d0) dead(`form "${sl.slice(0, 40)}"`);
      if (page.url() !== url) await open(url);
    }

    // Horizontal overflow on phones is a layout bug.
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 2) bad(`scrolls sideways by ${over}px`);
    if (process.env.BTN_SHOTS) await page.screenshot({ path: path.join(process.env.BTN_SHOTS, `${tag.replace(/\W+/g, '-')}${here.replace(/\W+/g, '_')}.png`), fullPage: true }).catch(() => {});
  }
  await ctx.close();
}

/** The destructive controls, pressed on throwaway items the crawler makes itself. */
async function throwaways() {
  const { ctx, page } = await signIn(browser, base, 'dm', PASS.dm, { width: 1280, height: 900 }, false);
  const bad = (m) => problems.push(`throwaways: ${m}`);
  page.on('pageerror', (e) => bad(`page error: ${e.message}`));
  page.on('dialog', (d) => { void d.accept().catch(() => {}); });
  page.on('response', (r) => { const s = r.status(); if (s >= 400 && s !== 403 && s !== 404) bad(`${s} ${r.request().method()} ${r.url().replace(base, '')}`); });
  await page.goto(`${W}/dm/combat`);
  await page.locator('main').waitFor();
  // Add a throwaway fighter, remove it, then add two and clear the tracker.
  const add = async (name) => {
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText(name, { exact: true }).first().waitFor({ timeout: 5000 }).catch(() => bad(`combat: ${name} did not appear after Add`));
  };
  await add('Throwaway Rat');
  await page.getByRole('button', { name: 'Remove Throwaway Rat' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Throwaway Rat'), null, { timeout: 5000 }).catch(() => bad('combat: Remove did not remove the fighter'));
  await add('Throwaway Bat');
  await page.getByRole('button', { name: 'Clear the tracker' }).click();
  await page.waitForFunction(() => document.body.innerText.includes('No one in the fight yet'), null, { timeout: 8000 }).catch(() => bad('combat: Clear the tracker did not empty the tracker'));
  // A throwaway stage card: add it, then Delete it.
  await page.goto(`${W}/dm/stage`);
  await page.locator('main').waitFor();
  await page.locator('main select').first().selectOption({ label: 'Text handout' }).catch(() => {});
  await page.getByLabel(/heading/i).first().fill('Throwaway card').catch(() => {});
  await page.getByLabel(/^text \(markdown/i).first().fill('Throwaway text').catch(() => {});
  await page.getByRole('button', { name: 'Add card' }).click().catch(() => {});
  await page.getByText('Throwaway card').first().waitFor({ timeout: 5000 }).then(async () => {
    const card = page.locator('article, .card').filter({ hasText: 'Throwaway card' }).filter({ has: page.getByRole('button', { name: 'Delete' }) }).last();
    await card.getByRole('button', { name: 'Delete' }).click();
    await page.waitForFunction(() => !document.body.innerText.includes('Throwaway card'), null, { timeout: 5000 }).catch(() => bad('stage: Delete did not remove the card'));
  }).catch(() => bad('stage: a throwaway card could not be added'));
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await throwaways();
  const jobs = [];
  const ONLY = process.env.BTN_ONLY;
  for (const [label, viewport, mobile] of [['1280', { width: 1280, height: 800 }, false], ['390', { width: 390, height: 844 }, true]]) {
    if (ONLY !== 'player' && ONLY !== 'none') jobs.push(crawlRole({ user: 'dm', label, viewport, mobile, routes: DM_ROUTES, prefix: 'dm/' }));
    if (ONLY !== 'dm' && ONLY !== 'none') jobs.push(crawlRole({ user: 'jess', label, viewport, mobile, routes: PLAYER_ROUTES, prefix: '' }));
  }
  await Promise.all(jobs);
} catch (e) {
  problems.push('crawler crashed: ' + (e.stack || e));
} finally {
  await browser.close();
  srv.kill();
}

for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v.pages} pages, ${v.clicks} clicks, ${v.forms} forms, ${v.dead} dead, ${v.skipped} destructive skipped`);
const uniq = [...new Set(problems)];
console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (uniq.length) { console.log(`\n${uniq.length} problems:`); for (const p of uniq) console.log(' - ' + p); process.exit(1); }
console.log('buttons ok');
