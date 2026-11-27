// End-to-end test of trade alerts outside the chat: Tom offers Jess a trade,
// Jess (on a phone) gets a pop-up on whatever page she is on, a badge on the
// Inventory tab, the offer on her sheet's Inventory box and a Trades card in
// Inventory with Accept / Decline. She accepts and both items move. Tom gets a
// pop-up that she accepted, and the trade shows under recent trades.
// Run from web/: npm run build && node e2e/trades.mjs   (TRADES_PORT, default 19814)
// TRADES_SHOTS=<dir> also saves screenshots there.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.TRADES_PORT || 19814);
const SHOTS = process.env.TRADES_SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('trades'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const dmLogin = await login('dm', 'game master 123');
const jessLogin = await login('jess', 'player pass 123');
const tomLogin = await login('tom', 'player pass 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + dmLogin.token } })).json())[0].id;
const api = async (token, method, p, body) => {
  const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const jessId = jessLogin.account.id;
const tomId = tomLogin.account.id;
await api(dmLogin.token, 'PATCH', '/settings', { playerTransfers: true });
const rope = await api(dmLogin.token, 'POST', '/inventory', { owner: tomId, name: 'Silk rope', qty: 1, reason: 'Found in the caves' });
// The demo world already has one offer from Tom; withdraw it so the counts start at zero.
for (const t of await api(tomLogin.token, 'GET', '/sessionchat/trades')) if (t.status === 'open') await api(tomLogin.token, 'POST', `/sessionchat/trades/${t.id}/cancel`, {});
await api(dmLogin.token, 'POST', '/inventory', { owner: jessId, name: 'Lantern', qty: 1, reason: 'Found in the caves' });

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
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
  const { page: jess } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const { page: tom } = await signIn('tom', 'player pass 123', { viewport: { width: 1280, height: 860 } });
  await jess.goto(`${W}/sheet`);
  await closeQuick(jess);
  await jess.getByTestId('sheet').waitFor({ timeout: 10000 });
  await tom.goto(`${W}/inventory`);
  await tom.getByRole('heading', { name: /Inventory and coin/ }).waitFor({ timeout: 10000 });
  check(await tom.getByTestId('trade-outgoing').count() === 0, 'no open trades before the offer');

  // 1. Tom offers his rope for Jess's lantern (as the dialog would send it).
  await api(tomLogin.token, 'POST', '/sessionchat/trades', { to: jessId, offerItemId: rope.id, offerQty: 1, wantItem: 'Lantern', wantQty: 1, note: 'For the caves' });

  // 2. Jess, on her sheet, gets a pop-up, a badge on Inventory, and the offer in her Inventory box.
  const alert = jess.getByTestId('trade-alert');
  if (check(await alert.waitFor({ timeout: 8000 }).then(() => true, () => false), 'trade pop-up for Jess')) {
    check(/Tomas offers you a trade/.test(await alert.innerText()), `pop-up text: ${await alert.innerText()}`);
    note('Jess got the pop-up');
  }
  check(await jess.getByTestId('tabbar').getByTestId('nav-badge-inventory').waitFor({ timeout: 5000 }).then(() => true, () => false), 'Inventory tab badge');
  check((await jess.getByTestId('tabbar').getByTestId('nav-badge-inventory').innerText()).trim() === '1', 'badge says 1');
  const sheetOffer = jess.getByTestId('mod-inventory').getByTestId('trade-incoming');
  check(await sheetOffer.waitFor({ timeout: 5000 }).then(() => true, () => false), 'offer on the sheet Inventory box');
  await shot(jess, '1-sheet-offer-and-alert');

  // 3. Tom sees his own offer waiting in Inventory, with Cancel.
  const tomOut = tom.getByTestId('trade-outgoing');
  check(await tomOut.waitFor({ timeout: 5000 }).then(() => true, () => false), 'Tom sees his offer in Inventory');
  check(await tomOut.getByRole('button', { name: 'Cancel offer' }).count() === 1, 'Tom can cancel');
  check(await tom.getByTestId('trade-alert').count() === 0, 'no pop-up for the one who offered');
  await shot(tom, '2-tom-waiting');

  // 4. Jess follows the pop-up link to Inventory and accepts there.
  await jess.goto(`${W}/inventory`);
  const card = jess.locator('.sc-trades-card');
  await card.waitFor({ timeout: 8000 });
  check(/1 waiting for you/.test(await card.innerText()), 'card says 1 waiting');
  await shot(jess, '3-inventory-trades');
  await card.getByTestId('trade-incoming').getByRole('button', { name: 'Accept' }).click();
  await card.getByTestId('trade-incoming').waitFor({ state: 'detached', timeout: 8000 });
  check(await jess.getByText('Silk rope').first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'Jess now has the rope');
  check(/You accepted/.test(await card.innerText()), 'recent trade line for Jess');
  check(await jess.getByTestId('tabbar').getByTestId('nav-badge-inventory').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false), 'badge gone after accepting');

  // 5. Tom hears about it and sees the lantern.
  const tAlert = tom.getByTestId('trade-alert');
  if (check(await tAlert.waitFor({ timeout: 8000 }).then(() => true, () => false), 'pop-up for Tom')) check(/Jessamine accepted your trade/.test(await tAlert.innerText()), `Tom pop-up text: ${await tAlert.innerText()}`);
  check(await tom.getByText('Lantern').first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'Tom now has the lantern');
  check(await tom.locator('.sc-trade-done li').filter({ hasText: 'accepted your offer' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'recent trade line for Tom');
  await shot(tom, '4-tom-accepted');

  // 6. A declined offer: Tom offers coin-free again, Jess declines from the sheet.
  const lantern = (await api(tomLogin.token, 'GET', '/inventory?owner=me')).items.find((i) => i.name === 'Lantern');
  await api(tomLogin.token, 'POST', '/sessionchat/trades', { to: jessId, offerItemId: lantern.id, offerQty: 1, wantItem: 'Silk rope', wantQty: 1 });
  await jess.goto(`${W}/sheet`);
  await closeQuick(jess);
  const again = jess.getByTestId('mod-inventory').getByTestId('trade-incoming');
  await again.waitFor({ timeout: 8000 });
  await again.getByRole('button', { name: 'Decline' }).click();
  await again.waitFor({ state: 'detached', timeout: 8000 });
  check(await tom.getByTestId('trade-alert').filter({ hasText: 'declined' }).waitFor({ timeout: 8000 }).then(() => true, () => false), 'Tom told about the decline');
  note('accept and decline both reach the other side');
} catch (e) {
  problems.push(`crashed: ${e.stack || e}`);
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) { console.error('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('trades e2e: ok');
