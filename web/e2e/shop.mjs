// The Shop end to end: the GM generates a shop in the browser and opens it to players; a player on a phone
// sees it (and never a hidden shop), buys with their own coin, and their coin and Inventory update live in
// another tab with no reload; a GM price change and closing the shop reach the phone live too.
// Run from web/: npm run build && node e2e/shop.mjs   (SHOP_PORT, default 8851)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.SHOP_PORT || 8851);
const base = `http://127.0.0.1:${PORT}`;
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const note = (m) => console.log('  ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('shop'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tokDM = await login('dm', 'game master 123');
const tokJess = await login('jess', 'player pass 123');
const world = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tokDM } })).json())[0];
const api = async (tok, method, p, body) => {
  const r = await fetch(`${base}/api/worlds/${world.id}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const W = `${base}/w/${world.slug}`;
const jessId = (await (await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + tokJess } })).json()).account.id;

// A hidden shop the players must never see, and some coin for Jess.
const hidden = await api(tokDM, 'POST', '/shop/generate', { kind: 'fence', size: 'city', level: 5, seed: 'den', name: 'Secret Den of Knives', save: true, status: 'hidden' });
await api(tokDM, 'POST', '/live/ledger', { owner: jessId, amountCp: 50_000, note: 'Shopping money' });

const browser = await chromium.launch();
const errs = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errs.push(`${who}: page error ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/40[349]|402/.test(m.text())) errs.push(`${who}: console ${m.text().slice(0, 200)}`); });
};
async function signIn(user, pass, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  watch(page, user);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(new RegExp(`/w/${world.slug}`), { timeout: 15000 });
  return { ctx, page };
}

try {
  // 1. The GM generates a blacksmith in the browser and saves it open.
  const { page: dm } = await signIn('dm', 'game master 123', { width: 1366, height: 900 });
  await dm.goto(`${W}/gm/shops?tab=generate`);
  await dm.getByTestId('gen-kind').selectOption('blacksmith');
  await dm.getByTestId('gen-size').selectOption('city');
  await dm.getByTestId('gen-go').click();
  await dm.getByTestId('gen-draft').waitFor({ timeout: 15000 });
  const draftName = (await dm.getByTestId('gen-draft').locator('h2').innerText()).trim();
  check((await dm.getByTestId('gen-draft').locator('tbody tr').count()) >= 5, 'the draft has stock');
  note(`draft: ${draftName}`);
  await dm.getByLabel('Open it to players when saved').check();
  await dm.getByTestId('gen-save').click();
  await dm.getByTestId('shop-status-open').waitFor({ timeout: 10000 });
  check(await dm.getByTestId('shop-status-open').getAttribute('aria-pressed') === 'true', 'the saved shop is open');
  check((await dm.getByTestId('dm-stock-line').count()) >= 5, 'the GM sees the stock lines');
  note('GM generated and opened a shop');

  // 2. A player on a phone: the open shop is there, the hidden one is not.
  const { ctx: pctx, page: pl } = await signIn('jess', 'player pass 123', { width: 390, height: 844 }, true);
  await pl.goto(`${W}/shop`);
  await pl.getByTestId('shop-card').first().waitFor({ timeout: 10000 });
  const cards = await pl.getByTestId('shop-card').allInnerTexts();
  check(cards.some((t) => t.includes(draftName)), `the player sees ${draftName}: ${cards.join(' | ')}`);
  check(!(await pl.content()).includes('Secret Den'), 'the hidden shop is not in the page');
  check(!cards.some((t) => t.includes(hidden.shop.name)), 'the hidden shop is not listed');
  const hiddenRes = await fetch(`${base}/api/worlds/${world.id}/shop/shops/${hidden.shop.id}`, { headers: { Authorization: 'Bearer ' + tokJess } });
  check(hiddenRes.status === 404, `the hidden shop is a 404 for the player (got ${hiddenRes.status})`);
  await pl.getByTestId('shop-card').filter({ hasText: draftName }).click();
  await pl.getByTestId('shop-line').first().waitFor();
  // No sideways scrolling on the phone.
  const wide = await pl.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 1, `the shop page scrolls sideways by ${wide}px on a phone`);

  // A second tab on Inventory, to see the purchase arrive live.
  const inv = await pctx.newPage();
  watch(inv, 'jess-inventory');
  await inv.goto(`${W}/inventory`);
  await inv.waitForLoadState('networkidle').catch(() => {});
  await sleep(800);
  const coinBefore = await api(tokJess, 'GET', '/inventory/summary');

  // 3. Buy the cheapest line that has a price.
  const lines = pl.getByTestId('shop-line');
  const n = await lines.count();
  let pickIdx = 0;
  for (let i = 0; i < n; i++) if (!(await lines.nth(i).getByTestId('buy-btn').isDisabled())) { pickIdx = i; break; }
  const line = lines.nth(pickIdx);
  const itemName = (await line.locator('summary strong').first().innerText()).trim();
  const qtyBefore = (await line.getByTestId('shop-qty').innerText()).trim();
  await line.getByTestId('buy-btn').click();
  await pl.getByTestId('buy-confirm').click();
  await pl.getByText(`Bought ${itemName}`).waitFor({ timeout: 10000 });
  note(`bought ${itemName} (${qtyBefore})`);
  // Inventory tab: the item and the coin, without a reload.
  const arrived = await inv.getByText(itemName, { exact: false }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(arrived, `${itemName} appeared in the open Inventory tab without a reload`);
  const coinAfter = await api(tokJess, 'GET', '/inventory/summary');
  check(coinAfter.mine.cp < coinBefore.mine.cp, `coin went down (${coinBefore.mine.cp} -> ${coinAfter.mine.cp})`);
  const shown = await inv.evaluate(() => document.body.innerText);
  const fmt = (cp) => { const gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10; return [gp && `${gp.toLocaleString()} gp`, sp && `${sp} sp`, c && `${c} cp`].filter(Boolean).join(' ') || '0 cp'; };
  check(shown.includes(fmt(coinAfter.mine.cp)), `the Inventory tab shows the new coin ${fmt(coinAfter.mine.cp)} live`);
  const qtyAfter = (await lines.nth(pickIdx).getByTestId('shop-qty').innerText()).trim();
  check(qtyAfter !== qtyBefore || qtyBefore === 'plenty', `the stock went down on the phone (${qtyBefore} -> ${qtyAfter})`);

  // 4. The GM changes a price: the phone shows it live.
  const dmShop = (await api(tokDM, 'GET', '/shop/shops')).shops.find((s) => s.name === draftName);
  const full = await api(tokDM, 'GET', `/shop/shops/${dmShop.id}`);
  const target = full.stock.find((l) => l.name === itemName);
  await api(tokDM, 'PATCH', `/shop/shops/${dmShop.id}/stock/${target.id}`, { priceCp: 1234 });
  const live = await pl.getByTestId('shop-price').filter({ hasText: '12 gp 3 sp 4 cp' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(live, 'the new price reached the phone live');

  // 5. The GM hides the shop in the browser: it vanishes from the phone.
  await dm.getByTestId('shop-status-hidden').click();
  const gone = await pl.waitForFunction((name) => !document.body.innerText.includes(name), draftName, { timeout: 8000 }).then(() => true, () => false);
  check(gone, 'hiding the shop took it off the phone live');
  note('price change and hiding reached the phone live');

  // 6. A town, then the GM sends the (hidden) shop to Jess: it opens, pops up on her phone, and she haggles.
  const town = await api(tokDM, 'POST', '/shop/towns', { name: 'Harrowgate', pricePct: 25, description: 'A city under siege.' });
  await api(tokDM, 'PATCH', `/shop/shops/${dmShop.id}`, { townId: town.id, barterPct: 20 });
  await pl.goto(`${W}/shop`);
  await pl.waitForLoadState('networkidle').catch(() => {});
  await dm.reload();
  await dm.getByTestId('shop-send').waitFor({ timeout: 10000 });
  await dm.getByLabel('Jess', { exact: false }).first().check().catch(() => {});
  await dm.getByTestId('shop-send').click();
  const popped = await pl.getByTestId('shop-present').waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(popped, 'the shop popped up on the phone');
  if (popped) {
    await pl.getByTestId('shop-present').getByRole('button', { name: 'Browse' }).click();
    await pl.waitForURL(new RegExp(`shop=${dmShop.id}`), { timeout: 8000 });
    await pl.getByTestId('shop-town').waitFor({ timeout: 8000 });
    check((await pl.getByTestId('shop-town').innerText()).includes('Harrowgate'), 'the town shows on the shop');
    const first = pl.getByTestId('shop-line').filter({ has: pl.getByTestId('haggle-btn') }).first();
    const haggled = (await first.locator('summary strong').first().innerText()).trim();
    const hl = pl.getByTestId('shop-line').filter({ hasText: haggled }).first();
    await hl.getByTestId('haggle-btn').click();
    await pl.getByLabel('Percent off to ask for').fill('3');
    await pl.getByTestId('haggle-go').click();
    const agreed = await pl.getByText(/nods: 3% off/).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    check(agreed, 'a small haggle is agreed');
    const struck = await hl.locator('s').first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    check(struck, 'the usual price is struck through after the deal');
    const wide2 = await pl.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(wide2 <= 1, `the shop page scrolls sideways by ${wide2}px on a phone after haggling`);
  }
  note('town, send to player, pop-up and haggle');
} catch (e) {
  problems.push('crashed: ' + (e.stack || e));
} finally {
  await browser.close();
  srv.kill();
}

for (const e of errs) problems.push(e);
if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('shop ok: generated, opened, bought on a phone, live coin, inventory, price and hiding; hidden shop never shown; town, send to player and haggle');
