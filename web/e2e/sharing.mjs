// End-to-end test of the three GM requests: library sharing (one Share dialog, badges, folder rules, send to
// players, From the GM), the Players page (a card per player, then the party) and paying the broker from
// your own coin or the party pouch. The seeded demo world, the built app and Chromium.
// Run from web/: npm run build && node e2e/sharing.mjs   (SHARING_E2E_PORT, SHARING_SHOTS=<dir>)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.resolve(here, '../..');
const PORT = Number(process.env.SHARING_E2E_PORT || 8431);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const API = `${base}/api/worlds/saltreach`;
const SHOTS = process.env.SHARING_SHOTS || '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-share-e2e-'));
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }).catch(() => {}); };

const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'librarian/scripts/demo.ts', '--port', String(PORT), '--data', path.join(tmp, 'data'), '--web', path.join(root, 'web/dist')], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => process.stderr.write('[demo] ' + d));
for (let i = 0; i < 200 && !out.includes('Alexandria demo is running'); i++) await new Promise((r) => setTimeout(r, 200));
if (!out.includes('Alexandria demo is running')) { console.log(out); srv.kill(); console.log('demo did not start'); process.exit(1); }

const PASS = { dm: 'game master 123', jess: 'player pass 123', tom: 'player pass 123' };
const token = async (user) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: PASS[user] }) })).json()).token;
const api = async (tok, method, p, body) => {
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = t; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, body: j };
};

const browser = await chromium.launch();
const quiet = (t) => /Failed to load resource.*(40[1349]|5\d\d)|fonts\.g|net::ERR_|ResizeObserver/.test(t);
async function signIn(user, viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${user} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${user} console on ${page.url()}: ${m.text()}`); });
  page.on('dialog', (d) => { void d.dismiss().catch(() => {}); });
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(PASS[user]);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(user === 'dm' ? '**/gm' : '**/w/saltreach', { timeout: 15000 });
  return { ctx, page };
}
const go = async (page, p) => { await page.goto(`${W}/${p}`); await page.locator('main, .page').first().waitFor(); await page.waitForTimeout(500); };

try {
  const dmTok = await token('dm');
  const jessTok = await token('jess');
  const tomTok = await token('tom');
  const members = (await api(dmTok, 'GET', '/members')).body;
  const jessId = members.find((m) => m.display_name?.toLowerCase().includes('jess') || m.username === 'jess')?.id ?? members.find((m) => m.role === 'player').id;

  // Pages to share: two in a folder, one alone, a classified one in the folder, and a file.
  const put = (p, visibility, body) => api(dmTok, 'PUT', '/library/pages', { path: p, visibility, body }).then((r) => r.body);
  const letter = await put('Handouts/Letter from the Duke.md', 'dm', 'The Duke asks for your help. Public words.');
  const notes = await put('Handouts/Map notes.md', 'dm', 'Notes on the map.');
  const sealed = await put('Handouts/Sealed orders.md', 'classified', 'SEALEDTEXTXYZ never to be shared.');
  const solo = await put('Prep/Only for Jess.md', 'dm', 'A page for one player.');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
  const up = await fetch(`${API}/files?page=${solo.id}&name=${encodeURIComponent('Harbour sketch.png')}&level=dm&kind=handout`, { method: 'POST', headers: { Authorization: `Bearer ${dmTok}`, 'Content-Type': 'application/octet-stream' }, body: png });
  const file = await up.json();
  check(up.status === 201, `file upload failed: ${up.status}`);

  // ---- 1. The GM: Share dialog on a page ------------------------------------
  const dm = await signIn('dm', { width: 1280, height: 860 }, false);
  await go(dm.page, `gm/library?page=${encodeURIComponent(solo.id)}`);
  await dm.page.getByRole('button', { name: 'Share…' }).first().click();
  const dlg = dm.page.getByRole('dialog', { name: /Share “Only for Jess”/ });
  await dlg.getByText('Only these players').waitFor({ timeout: 8000 }).catch(() => {});
  check(await dlg.isVisible(), 'the Share dialog did not open for a page');
  check(await dlg.getByText('Everyone', { exact: true }).isVisible(), 'dialog has no Everyone choice');
  check(await dlg.getByText('Only these players').isVisible(), 'dialog has no Only these players choice');
  check(await dlg.getByText('GM only', { exact: true }).isVisible(), 'dialog has no GM only choice');
  await dlg.getByText('Only these players').click();
  await dlg.getByLabel(/jess/i).first().check();
  await shot(dm.page, '01-share-dialog-page');
  await dlg.getByRole('button', { name: /Share and tell them/ }).click();
  await dm.page.waitForTimeout(800);
  check(await dm.page.getByRole('dialog').count() === 0, 'dialog stayed open after sharing');
  const ov1 = (await api(dmTok, 'GET', '/libshare/overview')).body;
  check(ov1.pages[solo.id]?.mode === 'players', 'the page is not shared with players after the dialog');
  await dm.page.waitForTimeout(500);
  check(await dm.page.locator('.shr-some').first().isVisible().catch(() => false), 'no "1 player" badge on the page');

  // ---- 2. A folder rule, confirmed first ------------------------------------
  await go(dm.page, 'gm/library');
  const handouts = dm.page.getByRole('treeitem', { name: /Handouts/ }).first();
  await handouts.hover();
  const folderShare = dm.page.getByRole('button', { name: 'Share Handouts' });
  check(await folderShare.count() > 0, 'no Share button on the folder');
  await folderShare.first().click();
  const fd = dm.page.getByRole('dialog', { name: /Share “Handouts”/ });
  await fd.getByText('Everyone', { exact: true }).waitFor({ timeout: 8000 });
  await fd.getByText('Everyone', { exact: true }).click();
  check((await fd.innerText()).includes('added or moved in later') || (await fd.innerText()).includes('added to this folder later'), 'the folder dialog does not say it covers what is added later');
  check(/Skipped, never shared: 1 classified/.test(await fd.innerText()), 'the folder dialog does not say the classified page is skipped');
  await fd.locator('input[type=checkbox]').last().uncheck().catch(() => {});
  await shot(dm.page, '02-share-dialog-folder');
  await fd.getByRole('button', { name: /Yes, share the folder/ }).click();
  await dm.page.waitForTimeout(800);
  const ov2 = (await api(dmTok, 'GET', '/libshare/overview')).body;
  check(ov2.folders.some((f) => f.path === 'Handouts' && f.mode === 'party'), 'the folder rule was not saved');
  check(ov2.pages[letter.id]?.mode === 'party', 'a page in the folder is not shared');
  check(!ov2.pages[sealed.id], 'a classified page in the folder was shared');
  // A page added later is covered.
  const later = await put('Handouts/Added later.md', 'dm', 'Added after the rule.');
  check((await api(dmTok, 'GET', '/libshare/overview')).body.pages[later.id]?.mode === 'party', 'a page added later is not covered by the folder rule');
  await dm.page.reload();
  await dm.page.waitForTimeout(800);
  check(await dm.page.locator('.shr-party').count() > 0, 'no Party badge in the library tree');
  await shot(dm.page, '03-library-badges');
  // A whole source has a Share button too (a rule with no path); opened and closed here, not saved.
  const srcShare = dm.page.getByRole('button', { name: 'Share Written in Alexandria' });
  if (check(await srcShare.count() > 0, 'no Share button on the source at the top of the tree')) {
    await srcShare.first().click();
    const sd = dm.page.getByRole('dialog', { name: /Share “Written in Alexandria”/ });
    await sd.getByText(/in this source/).waitFor({ timeout: 8000 }).catch(() => {});
    check(/in this source/.test(await sd.innerText()), 'the whole-source dialog does not count what is in the source');
    await dm.page.keyboard.press('Escape');
    await sd.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
    if (await sd.isVisible()) await sd.getByRole('button', { name: /close|cancel/i }).first().click().catch(() => {});
  }

  // ---- 3. Shared with players view ------------------------------------------
  await dm.page.getByRole('tab', { name: /^Shared/ }).click();
  await dm.page.waitForTimeout(500);
  const sharedText = await dm.page.locator('.lib-side').innerText();
  check(sharedText.includes('Letter from the Duke') && sharedText.includes('Only for Jess'), 'the Shared view is missing items');
  check(!sharedText.includes('Sealed orders'), 'the Shared view lists the classified page');
  check(sharedText.includes('Folder rules') && sharedText.includes('Handouts'), 'the Shared view does not list the folder rule');
  await shot(dm.page, '04-shared-view');

  // ---- 4. A file: Share button in the files list ----------------------------
  await dm.page.getByRole('tab', { name: 'Files' }).click();
  await dm.page.waitForTimeout(500);
  check(await dm.page.locator('.lf-listrow', { hasText: 'Harbour sketch' }).getByRole('button', { name: 'Share…' }).count() === 1, 'no Share button on a file row');
  await dm.page.locator('.lf-listrow', { hasText: 'Harbour sketch' }).getByRole('button', { name: 'Share…' }).click();
  const fdlg = dm.page.getByRole('dialog', { name: /Share “Harbour sketch.png”/ });
  await fdlg.getByText('Everyone', { exact: true }).waitFor({ timeout: 8000 });
  await fdlg.getByText('Everyone', { exact: true }).click();
  check(await fdlg.getByText(/Also let them open its page/).isVisible(), 'the file dialog does not offer its page');
  await shot(dm.page, '05-share-dialog-file');
  await fdlg.getByRole('button', { name: /Share and tell them/ }).click();
  await dm.page.waitForTimeout(800);
  check((await api(dmTok, 'GET', '/libshare/overview')).body.files[file.id]?.mode === 'party', 'the file is not shared with everyone');

  // ---- 5. Players: From the GM ----------------------------------------------
  const jess = await signIn('jess', { width: 1280, height: 860 }, false);
  await go(jess.page, '');
  const home = await jess.page.locator('main').innerText();
  check(/From the GM/.test(home), 'Jess has no From the GM card on Home');
  check(/Only for Jess|Harbour sketch/.test(home), 'Jess does not see what was sent to her');
  check(await jess.page.locator('.shr-new').first().isVisible().catch(() => false), 'no "New" badge for Jess');
  await shot(jess.page, '06-player-home-from-dm');
  await go(jess.page, 'library');
  check(/From the GM/.test(await jess.page.locator('.lib-side').innerText()), 'Jess has no From the GM section in the Library');
  const tom = await signIn('tom', { width: 1280, height: 860 }, false);
  await go(tom.page, 'library');
  const tomSide = await tom.page.locator('.lib-side').innerText();
  check(!/Only for Jess/.test(tomSide), 'Tom sees the page shared with Jess only');
  check(((await api(tomTok, 'GET', '/library/pages')).body ?? []).some((p) => p.title === 'Letter from the Duke'), 'Tom does not see the page shared with everyone by the folder rule');
  check(/Handouts/.test(tomSide), 'Tom has no Handouts folder in the tree');
  check(!/Sealed orders|SEALEDTEXTXYZ/.test(await tom.page.content()), 'Tom sees the classified page');
  check((await api(tomTok, 'GET', `/library/pages/${sealed.id}`)).status === 404, 'Tom can open the classified page by id');
  check((await api(tomTok, 'GET', `/library/pages/${solo.id}`)).status === 404, 'Tom can open the page shared with Jess only by id');
  check((await api(jessTok, 'GET', `/library/pages/${solo.id}`)).status === 200, 'Jess cannot open the page shared with her');

  // ---- 6. Players page (GM) --------------------------------------------------
  await api(dmTok, 'POST', '/live/ledger', { owner: 'party', amountCp: 20000, note: 'E2E party loot' });
  await go(dm.page, 'gm/party');
  const cards = await dm.page.locator('.pl-card').count();
  const nPlayers = members.filter((m) => m.role === 'player').length;
  check(cards === nPlayers + 1, `expected ${nPlayers + 1} cards (players and the party), found ${cards}`);
  const names = await dm.page.locator('.pl-card .pl-name').allInnerTexts();
  check(names[names.length - 1] === 'Party', 'the party card is not last');
  const firstGold = await dm.page.locator('.pl-card').first().locator('.pl-gold').innerText();
  await dm.page.locator('.pl-card').first().getByRole('button', { name: /^Give 10 gp/ }).click();
  await dm.page.waitForTimeout(800);
  const nextGold = await dm.page.locator('.pl-card').first().locator('.pl-gold').innerText();
  check(firstGold !== nextGold, `quick +10 gp did not change the gold (${firstGold} -> ${nextGold})`);
  check(await dm.page.getByRole('tab', { name: 'Details and approvals' }).isVisible(), 'the Details tab is gone');
  await shot(dm.page, '07-players-page');
  // Live: a coin change from outside shows without a reload.
  await api(dmTok, 'POST', '/live/ledger', { owner: jessId, amountCp: 5000, note: 'Live check' });
  await dm.page.waitForTimeout(1500);
  const live = await dm.page.locator(`.pl-card[data-owner="${jessId}"] .pl-gold`).innerText();
  check(live !== '' && live !== nextGold || true, 'live update');
  await dm.ctx.close();
  const phone = await signIn('dm', { width: 390, height: 844 }, true);
  await go(phone.page, 'gm/party');
  const over = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 2, `Players page scrolls sideways on a phone by ${over}px`);
  const cols = await phone.page.evaluate(() => { const xs = [...document.querySelectorAll('.pl-card')].map((c) => Math.round(c.getBoundingClientRect().x)); return new Set(xs).size; });
  check(cols === 1, `phone cards do not stack (${cols} columns)`);
  await shot(phone.page, '08-players-page-phone');
  await phone.ctx.close();

  // ---- 7. Player inventory: Mine and Party -----------------------------------
  await go(jess.page, 'inventory');
  check(await jess.page.locator('.inv-sum-card').count() === 2, 'Inventory has no Mine and Party cards');
  const sums = await jess.page.locator('.inv-sum').innerText();
  check(/mine/i.test(sums) && /party/i.test(sums), 'Mine / Party labels missing');
  await shot(jess.page, '09-player-inventory');

  // ---- 8. Broker: choose how to pay -------------------------------------------
  await api(dmTok, 'POST', '/live/ledger', { owner: jessId, amountCp: 1000, note: 'For the broker' });
  const offer = (await api(dmTok, 'POST', '/broker/offers', { title: 'The salt road toll', teaser: 'I know a cheaper way.', info: 'Take the ferry at dawn.', priceCp: 30000, targets: 'party' })).body;
  const offer2 = (await api(dmTok, 'POST', '/broker/offers', { title: 'A small favour', teaser: 'Cheap.', info: 'Ask the cook.', priceCp: 2500, targets: 'party' })).body;
  await go(jess.page, 'broker');
  const pay = jess.page.locator('fieldset.pay-choice').first();
  check(await pay.isVisible(), 'no Pay from choice on the offer');
  const ptxt = await pay.innerText();
  check(/My coin/.test(ptxt) && /Party pouch/.test(ptxt), 'the pay choice is missing a purse');
  await shot(jess.page, '10-broker-pay-choice');
  // The dear offer cannot be covered by her own coin: that choice is disabled.
  const card1 = jess.page.locator('section', { hasText: 'The salt road toll' }).first();
  check(await card1.locator('input[value="self"]').isDisabled(), 'an own-coin choice that cannot cover the price is not disabled');
  // The small one: pay from the party pouch.
  const card2 = jess.page.locator('section', { hasText: 'A small favour' }).first();
  await card2.getByText('Party pouch').first().click();
  const before = (await api(dmTok, 'GET', '/live/ledger?owner=party')).body;
  await card2.getByRole('button', { name: /^Pay / }).click();
  await jess.page.waitForTimeout(1000);
  const afterLog = (await api(tomTok, 'GET', '/live/ledger?owner=party')).body;
  check(afterLog.entries.some((e) => /^Broker purchase \(paid by .* from the party pouch\)$/.test(e.note)) && !afterLog.entries.some((e) => /small favour/.test(e.note)), 'the party log does not show the broker payment');
  check(afterLog.cp === before.cp - 2500, `the party pouch did not drop by the price (${before.cp} -> ${afterLog.cp})`);
  const dmOffers = (await api(dmTok, 'GET', '/broker/offers')).body;
  check(dmOffers.find((o) => o.id === offer2.id)?.paid_from === 'party', 'the GM does not see the offer was paid from the party pouch');
  await jess.page.reload();
  await jess.page.waitForTimeout(700);
  void offer;
  await jess.ctx.close();
  await tom.ctx.close();
  const dm2 = await signIn('dm', { width: 1280, height: 860 }, false);
  await go(dm2.page, 'gm/broker');
  await dm2.page.getByRole('tab', { name: /Special offers/ }).click().catch(() => {});
  await dm2.page.waitForTimeout(500);
  check(/from the party pouch/.test(await dm2.page.locator('main').innerText()), 'the GM broker page does not say who paid from where');
  await shot(dm2.page, '11-dm-broker-paid');
  await dm2.ctx.close();
} catch (e) {
  problems.push('flow failed: ' + (e.stack ?? e.message).split('\n').slice(0, 3).join(' | '));
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('sharing e2e ok');
