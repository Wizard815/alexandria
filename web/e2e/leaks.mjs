// UI leak crawler. Serves the security world (one unique marker at every DM-only,
// broker and classified spot, see librarian/test/security-world.ts), signs in as
// each player and the guest, visits every page, opens every panel and overlay,
// searches, and scans the rendered DOM text and HTML, localStorage,
// sessionStorage, IndexedDB (the offline cache) and Cache Storage for any marker
// that person must not see. Any hit fails.
// Run from web/: npm run build && node e2e/leaks.mjs   (LEAK_PORT, LEAK_VERBOSE=1)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, PLAYER_ROUTES, INIT, DESTRUCTIVE, quiet } from './lib.mjs';

const PORT = Number(process.env.LEAK_PORT || 8199);
const base = `http://127.0.0.1:${PORT}`;
const t0 = Date.now();
const { srv, out } = await startScript('web/e2e/leakworld.mjs', [String(PORT), tmpDir('leak'), path.join(root, 'web/dist')], 'LEAKWORLD ', 'leakworld');
const world = JSON.parse(out.slice(out.indexOf('LEAKWORLD ') + 10).split('\n')[0]);
const W = `${base}/w/${world.slug}`;
// Numbers (monster HP) are matched as whole words, everything else as a substring.
const markers = world.markers.map((m) => ({ ...m, re: /^\d+$/.test(m.token) ? new RegExp(`(?<![0-9A-Za-z])${m.token}(?![0-9A-Za-z])`) : null }));
const PEOPLE = [
  ['jess', 'player pass 123', 1280], ['tom', 'player pass 123', 1280], ['guest', 'guest pass 1234', 1280], ['jess', 'player pass 123', 390],
].map(([u, p, w]) => ({ who: u, user: u === 'guest' ? 'visitor' : u, pass: p, width: w }));

// The table screen is seen by the players, so it may show what both players may see and nothing else, even on the DM's login.
for (const m of markers) if (m.seen.includes('jess') && m.seen.includes('tom')) m.seen.push('table');

const hits = new Map();
const allowedSeen = {};
// LEAK_SELFTEST=1: nothing is allowed for anyone, so the crawl must report hits (proves the scan can see).
if (process.env.LEAK_SELFTEST) for (const m of markers) m.seen = [];
const scanned = {};
function check(who, where, text) {
  const hay = text.toLowerCase();
  const plain = hay.replace(/<[^>]*>/g, '');
  for (const m of markers) {
    const found = m.re ? m.re.test(hay) || m.re.test(plain) : hay.includes(m.token.toLowerCase());
    if (found && m.seen.includes(who)) (allowedSeen[who] ??= new Set()).add(m.id);
    if (m.seen.includes(who)) continue;
    if (found) hits.set(`${who} ${where} <- ${m.id} (${m.where})`, true);
  }
}

async function scanDom(page, who, where) {
  scanned[who] = (scanned[who] ?? 0) + 1;
  const d = await page.evaluate(() => ({ text: document.body.innerText, html: document.documentElement.outerHTML })).catch(() => null);
  if (!d) return;
  check(who, `${where} [text]`, d.text);
  check(who, `${where} [html]`, d.html);
}

/** Everything: DOM plus the browser's stores (localStorage, sessionStorage, IndexedDB, Cache Storage). */
async function scan(page, who, where) {
  scanned[who] = (scanned[who] ?? 0) + 1;
  const d = await page.evaluate(async () => {
    const dump = (s) => { try { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return JSON.stringify(o); } catch { return ''; } };
    let idb = '';
    try {
      const dbs = (await indexedDB.databases?.()) ?? [];
      for (const info of dbs) {
        const db = await new Promise((ok, no) => { const r = indexedDB.open(info.name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        for (const name of [...db.objectStoreNames]) {
          idb += await new Promise((ok) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => ok(JSON.stringify(r.result)); r.onerror = () => ok(''); });
        }
        db.close();
      }
    } catch { /* no IndexedDB */ }
    let cache = '';
    try {
      for (const k of await caches.keys()) { const c = await caches.open(k); for (const req of await c.keys()) { const res = await c.match(req); const t = await res.clone().text().catch(() => ''); cache += req.url + t.slice(0, 200000); } }
    } catch { /* no Cache Storage */ }
    return { text: document.body.innerText, html: document.documentElement.outerHTML, ls: dump(localStorage), ss: dump(sessionStorage), idb, cache };
  }).catch(() => null);
  if (!d) return;
  check(who, `${where} [text]`, d.text);
  check(who, `${where} [html]`, d.html);
  check(who, `${where} [localStorage]`, d.ls.replace(/"alx\.token":"[^"]*"/, ''));
  check(who, `${where} [sessionStorage]`, d.ss);
  check(who, `${where} [IndexedDB]`, d.idb);
  check(who, `${where} [CacheStorage]`, d.cache);
}

async function crawl(browser, p) {
  const { who } = p;
  const { ctx, page } = await signIn(browser, base, p.user, p.pass, { width: p.width, height: 844 }, p.width < 700, new RegExp(`/w/${world.slug}`));
  await ctx.addInitScript(INIT);
  const tag = `${who}@${p.width}`;
  const deadline = Date.now() + Number(process.env.LEAK_BUDGET_MS || 45000);
  let here = '';
  page.on('pageerror', (e) => hits.set(`${tag} ${here}: page error ${e.message}`, true));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) hits.set(`${tag} ${here}: console ${m.text().slice(0, 160)}`, true); });
  page.on('dialog', (d) => { void d.dismiss().catch(() => {}); });
  // Every API response a player's page receives is scanned too: what the browser held, even if never drawn.
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return;
    const t = await r.text().catch(() => '');
    if (t) check(who, `${here} [API ${r.request().method()} ${r.url().replace(base, '').slice(0, 80)}]`, t);
  });
  const open = async (url) => { await page.goto(url); await page.locator('main, .page, #root > *').first().waitFor({ timeout: 10000 }).catch(() => {}); await page.waitForTimeout(500); };

  // The library-sharing seeds first, so they are always reached inside the time budget.
  const links = new Set(Object.entries(world.pages).filter(([k]) => k.startsWith('share_')).map(([, pg]) => `${W}/library?page=${encodeURIComponent(pg.id)}`));
  for (const r of PLAYER_ROUTES) links.add(`${W}/${r}`.replace(/\/$/, ''));
  // The players' screen is a route of its own (no layout, no links to it): visit it as every player and the guest too.
  links.add(`${W}/screen/players`);
  await open(W);
  for (const h of await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))) if (h?.startsWith(`/w/${world.slug}`) && !h.includes('/dm')) links.add(base + h.split('#')[0]);
  for (const pg of Object.values(world.pages)) links.add(`${W}/library?page=${encodeURIComponent(pg.id)}`);

  for (const url of links) {
    if (Date.now() > deadline + 20000) break;
    here = url.replace(base, '');
    await open(url);
    await scan(page, who, here);
    // Press the controls: panels, overlays, cards, tabs.
    const list = await page.evaluate(() => window.__crawl.list());
    const seen = new Set();
    for (const c of list) {
      const k = `${c.key}#${c.nth}`;
      if (seen.has(k) || c.nth > 1 || c.submit || DESTRUCTIVE.test(c.label) || DESTRUCTIVE.test(c.title) || c.target === '_blank' || c.download) continue;
      if (c.href && !c.href.startsWith('/')) continue;
      if (seen.size >= 20 || Date.now() > deadline) break;
      seen.add(k);
      const el = await page.evaluateHandle(([key, n]) => window.__crawl.find(key, n), [c.key, c.nth]);
      const e = el.asElement();
      if (!e) continue;
      const u0 = page.url();
      try { await e.click({ timeout: 2500 }); } catch { continue; }
      await page.waitForTimeout(250);
      await scanDom(page, who, `${here} after "${c.key}"`);
      // Panels opened by the dock hold more controls: scan one level down.
      const more = await page.evaluate(() => window.__crawl.list()).catch(() => []);
      for (const n of more.filter((n) => n.region !== 'main' && n.region !== 'shell' && !seen.has(`${n.key}#${n.nth}`)).slice(0, 8)) {
        seen.add(`${n.key}#${n.nth}`);
        if (n.submit || DESTRUCTIVE.test(n.label) || (n.href && !n.href.startsWith('/'))) continue;
        const h2 = (await page.evaluateHandle(([key, nn]) => window.__crawl.find(key, nn), [n.key, n.nth])).asElement();
        if (!h2) continue;
        try { await h2.click({ timeout: 2000 }); } catch { continue; }
        await page.waitForTimeout(200);
        await scanDom(page, who, `${here} after "${c.key}" > "${n.key}"`);
      }
      const stuck = await page.evaluate(() => !!document.querySelector('.modal-back, .sx-back, [role=dialog], [aria-modal=true], .ag-panel')).catch(() => false);
      if (page.url() !== u0 || stuck) await open(url);
    }
  }

  // Search: the words that appear in the secrets.
  await open(W);
  const search = page.getByRole('button', { name: /^search/i }).first();
  if (await search.isVisible().catch(() => false)) {
    for (const q of ['smuggler', 'queen', 'ZQX', 'vault', 'harbour', 'secret', 'broker', 'classified', 'dm', 'lighthouse']) {
      here = `search "${q}"`;
      if (!(await page.locator('input[type=search], [role=dialog] input, .search input').first().isVisible({ timeout: 500 }).catch(() => false))) await search.click({ timeout: 2000 }).catch(() => {});
      const box = page.locator('input[type=search], [role=dialog] input, .search input, input[placeholder*="earch"]').first();
      await box.fill(q, { timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(500);
      await scanDom(page, who, here);
    }
  } else hits.set(`${tag}: no Search button found`, true);

  // The offline cache fills while browsing: scan once more at the end, on a fresh load.
  await open(`${W}/library`);
  await page.waitForTimeout(800);
  await scan(page, who, 'end (after browsing)');
  await ctx.close();
}

/** The players' screen, opened with the DM's own token: it must show no more than a guest may read (the player view), and no app chrome. */
async function crawlScreen(browser) {
  const tag = 'dm@screen';
  const { ctx, page } = await signIn(browser, base, 'dungeon', 'dm password 123', { width: 1920, height: 1080 }, false, new RegExp(`/w/${world.slug}`));
  page.on('pageerror', (e) => hits.set(`${tag}: page error ${e.message}`, true));
  // Only what this route itself fetched: the DM's own offline cache legitimately holds DM data.
  page.on('response', async (r) => {
    if (!/\/screen\/players|\/api\/media\/screen/.test(r.url())) return;
    const t = await r.text().catch(() => '');
    if (t) check('guest', `${tag} [API ${r.url().replace(base, '').slice(0, 80)}]`, t);
  });
  await page.goto(`${W}/screen/players`);
  await page.locator('.ps').waitFor({ timeout: 10000 }).catch(() => hits.set(`${tag}: the screen did not render`, true));
  await page.waitForTimeout(1500);
  await scanDom(page, 'guest', `${tag} /screen/players`);
  const info = await page.evaluate(() => ({ chrome: !!document.querySelector('nav, .topbar, .side, #alx-dock, .dm-phonebar'), text: document.body.innerText, url: location.pathname }));
  if (info.chrome) hits.set(`${tag}: the players' screen shows app navigation`, true);
  if (!info.url.endsWith('/screen/players')) hits.set(`${tag}: left the screen route (${info.url})`, true);
  if (!/Board for everyone/.test(info.text) || !/Combat/.test(info.text)) hits.set(`${tag}: the screen is not showing the shown card and the combat card, so the crawl is not reaching the content`, true);
  await ctx.close();
}

/** The table screen, opened from the DM's login: its DOM is scanned as if a player were reading it (a screen lying face up). */
async function crawlTable(browser) {
  const who = 'table';
  const { ctx, page } = await signIn(browser, base, 'dungeon', 'dm password 123', { width: 1920, height: 1080 }, false, new RegExp(`/w/${world.slug}`));
  let here = '';
  page.on('pageerror', (e) => hits.set(`table ${here}: page error ${e.message}`, true));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) hits.set(`table ${here}: console ${m.text().slice(0, 160)}`, true); });
  page.on('dialog', (d) => { void d.dismiss().catch(() => {}); });
  here = '/screen/table';
  await page.goto(`${W}/screen/table`);
  await page.getByTestId('table-screen').waitFor({ timeout: 10000 });
  await page.getByTestId('table-order').waitFor({ timeout: 10000 }).catch(() => hits.set('table: the initiative order never showed (combat is active in this world)', true));
  await page.waitForTimeout(800);
  await scanDom(page, who, here);
  const order = await page.getByTestId('table-order').innerText().catch(() => '');
  if (!/Goblin/.test(order) || !/Jessamine/.test(order)) hits.set(`table: the order should list the goblin and Jessamine, got "${order.slice(0, 120)}"`, true);
  if (/Ambusher|\bAC\b|temp(orary)? HP/.test(order)) hits.set(`table: the order shows a hidden foe or DM-only stat: "${order.slice(0, 160)}"`, true);
  // Every mark on the map, then the whiteboard, then each quarter turn.
  for (const m of await page.locator('[data-testid=table-map] [data-mark]').all()) { await m.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(150); await scanDom(page, who, `${here} after a mark`); }
  await page.getByRole('button', { name: 'Whiteboard' }).click();
  await page.waitForTimeout(300);
  await scanDom(page, who, `${here} whiteboard`);
  for (let i = 0; i < 4; i++) { await page.getByTestId('table-rot-right').click(); await page.waitForTimeout(150); await scanDom(page, who, `${here} rotated ${(i + 1) * 90}`); }
  await ctx.close();
}

/** "Download all": each player's zip of each session they were recorded in, byte for byte (stored, so its text is plain). */
async function crawlZips() {
  const login = async (u, p) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
  for (const [who, user, pass] of [['jess', 'jess', 'player pass 123'], ['tom', 'tom', 'player pass 123'], ['guest', 'visitor', 'guest pass 1234']]) {
    const tok = await login(user, pass);
    const r = await fetch(`${base}/api/worlds/${world.slug}/audio/recordings/mine`, { headers: { Authorization: `Bearer ${tok}` } });
    if (who === 'guest') { if (r.status !== 403) hits.set(`guest: /audio/recordings/mine answered ${r.status}, not 403`, true); continue; }
    const sessions = (await r.json()).sessions ?? [];
    const withZip = sessions.filter((s) => s.zipUrl);
    if (!withZip.length) hits.set(`${who}: no session offers Download all, so the zip is not checked`, true);
    for (const s of withZip) {
      const z = await fetch(base + s.zipUrl);
      const buf = Buffer.from(await z.arrayBuffer());
      scanned[who] = (scanned[who] ?? 0) + 1;
      check(who, `Download all ${s.name} [zip]`, buf.toString('latin1'));
      if (!buf.toString('latin1').includes(world.markers.find((m) => m.id === `zip_${who}`)?.token ?? '\0')) hits.set(`${who}: their own track is not in their Download all zip`, true);
    }
  }
}

const browser = await chromium.launch();
try { await Promise.all([...PEOPLE.map((p) => crawl(browser, p)), crawlScreen(browser), crawlTable(browser), crawlZips()]); }
catch (e) { hits.set('crawler crashed: ' + (e.stack || e), true); }
finally { await browser.close(); srv.kill(); }

console.log(`  scans: ${Object.entries(scanned).map(([k, v]) => `${k} ${v}`).join(', ')} against ${markers.length} markers; ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const p of PEOPLE) if (!process.env.LEAK_SELFTEST && (allowedSeen[p.who]?.size ?? 0) < 5) hits.set(`${p.who}: only ${allowedSeen[p.who]?.size ?? 0} allowed markers were ever seen, so the crawl is not reaching the content`, true);
// The library-sharing seeds must reach the players they were shared with, or the crawl proves nothing about them.
if (!process.env.LEAK_SELFTEST) for (const m of markers.filter((x) => x.id.startsWith('share_'))) for (const who of ['jess', 'tom']) if (m.seen.includes(who) && !allowedSeen[who]?.has(m.id)) hits.set(`${who}: the shared marker ${m.id} (${m.where}) was never seen, so sharing is not reaching them`, true);
// The spell seeds (security-world.ts: a homebrew spell only jess knows, her spell sheet, her request to learn) must reach her Codex,
// so the crawl proves the DM's notes, hidden recipes and unknown spells on the same page did not.
if (!process.env.LEAK_SELFTEST) for (const id of ['spell_known_jess', 'spell_sheet_jess']) if (markers.some((m) => m.id === id) && !allowedSeen.jess?.has(id)) hits.set(`jess: the spell marker ${id} was never seen, so the Codex crawl is not reaching it`, true);
console.log('  allowed markers seen: ' +Object.entries(allowedSeen).map(([k, v]) => `${k} ${v.size}`).join(', '));
if (hits.size) { console.log(`\n${hits.size} LEAKS / problems:`); for (const k of hits.keys()) console.log(' - ' + k); process.exit(1); }
console.log('leaks ok: no DM, broker or classified marker reached a player or guest in the DOM, storage or cache');
