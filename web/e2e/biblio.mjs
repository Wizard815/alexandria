// End-to-end test of Biblio, the world library Alexandria hosts itself: the GM
// opens /biblio, writes a character with a GM-only field and a secret callout
// inside a town, links it, edits it and brings an old version back from the
// history; Jess reads the character on her phone (no GM-only field, no secret),
// sees the timeline and suggests an edit, which the GM adds to the article.
// Screenshots go to SHOTS.
// Run from web/: npm run build && node e2e/biblio.mjs   (BIBLIO_PORT, default 19824)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.BIBLIO_PORT || 19824);
const SHOTS = process.env.SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('biblio'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
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
const pages = [];
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/409/.test(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}
async function signIn(user, pass, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  watch(page, user);
  pages.push(page);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}

try {
  // 1. A town to put things in, and an event for the timeline.
  const town = await api(gmLogin.token, 'POST', '/biblio/articles', { title: 'Saltreach', template: 'location', level: 'party', fields: { founded: '212 BR', population: '2400' }, body: 'A harbour town. The [[Harbourmaster Odda]] keeps order.' });
  await api(gmLogin.token, 'POST', '/biblio/articles', { title: 'The Drowning War', template: 'event', level: 'party', fields: { date: '1040 AR' } });

  // 2. The GM opens /Biblio and writes a character inside the town.
  const { page: gm } = await signIn('dm', 'dungeon master 123', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  await gm.goto(`${base}/Biblio`);
  await gm.waitForURL(/\/dm\/biblio/, { timeout: 8000 });
  await gm.locator('.bib-tree').getByRole('button', { name: 'Saltreach' }).click();
  await gm.getByText('Not written yet').waitFor({ timeout: 8000 });
  await gm.getByRole('button', { name: 'Harbourmaster Odda' }).click(); // the red link starts the article
  await gm.getByLabel('Title').waitFor();
  check(await gm.getByLabel('Title').inputValue() === 'Harbourmaster Odda', 'the red link fills the title');
  await gm.getByLabel('Template').selectOption('character');
  await gm.getByLabel('Who can read it').selectOption('party');
  await gm.getByLabel('Inside').selectOption({ label: 'Saltreach' });
  await gm.getByLabel('Occupation').fill('Harbourmaster');
  await gm.getByLabel('Born').fill('1012 AR');
  await gm.getByLabel('Secret (GM only)').fill('GMSECRET_FIELD she takes the Hand’s coin');
  await gm.getByLabel('Article text').fill('Loud and fair.\n\n> [!secret]\n> GMSECRET_CALLOUT a second ledger.');
  await shot(gm, '1-gm-editor');
  await gm.getByRole('button', { name: 'Save article' }).click();
  await gm.getByRole('heading', { name: 'Harbourmaster Odda' }).waitFor({ timeout: 8000 });
  check(await gm.getByText('GMSECRET_FIELD').count() > 0, 'the GM sees the GM-only field');
  note('gm: wrote a character from a red link');

  // 3. Edit, then bring version 1 back from the history.
  await gm.getByRole('button', { name: 'Edit', exact: true }).click();
  await gm.getByLabel('Occupation').fill('Retired harbourmaster');
  await gm.getByRole('button', { name: 'Save article' }).click();
  await gm.getByText('Retired harbourmaster').waitFor({ timeout: 8000 });
  await gm.getByRole('button', { name: 'History' }).click();
  await gm.getByRole('button', { name: 'Version 1' }).click();
  await gm.getByText('What changed from version 1').waitFor({ timeout: 8000 });
  await shot(gm, '2-gm-history');
  await gm.getByRole('button', { name: 'Bring back version 1' }).click();
  await gm.getByText('version 3').waitFor({ timeout: 8000 });
  check(await gm.getByText('Retired harbourmaster').count() === 0, 'version 1 is back');
  note('gm: edited and restored a version');

  // 4. Jess reads it on her phone: no GM-only field, no secret.
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const odda = (await api(gmLogin.token, 'GET', '/biblio')).articles.find((a) => a.title === 'Harbourmaster Odda');
  await pl.goto(`${W}/biblio?a=${odda.id}`);
  await pl.getByRole('heading', { name: 'Harbourmaster Odda' }).waitFor({ timeout: 8000 });
  const text = await pl.textContent('body');
  check(!text.includes('GMSECRET'), 'no GM-only field or secret callout on the player page');
  check(text.includes('Loud and fair'), 'the player reads the article');
  check(await pl.evaluate(() => document.documentElement.scrollWidth) <= 390, 'no sideways scroll on the phone');
  await shot(pl, '3-player-phone');
  await pl.getByRole('button', { name: 'Suggest an edit' }).click();
  await pl.getByLabel('What should change or be added').fill('She hums sea shanties at dawn.');
  await pl.getByRole('button', { name: 'Send' }).click();
  await pl.getByText('Sent to your GM').waitFor({ timeout: 8000 });
  await pl.goto(`${W}/biblio?tab=timeline`);
  await pl.getByText('1012 AR').waitFor({ timeout: 8000 });
  const order = await pl.locator('.bib-when').allTextContents();
  check(order.join('|') === '212 BR|1012 AR|1040 AR', `the timeline is in world order: ${order.join('|')}`);
  note('player: read without secrets, suggested an edit, saw the timeline');

  // 5. The GM adds the suggestion to the article.
  await gm.goto(`${W}/dm/biblio?tab=suggestions`);
  await gm.getByRole('button', { name: 'Add it to the article' }).click();
  await gm.getByText('Decided (1)').waitFor({ timeout: 8000 });
  const after = await api(gmLogin.token, 'GET', `/biblio/articles/${odda.id}`);
  check(after.article.body.includes('She hums sea shanties at dawn.'), 'the suggestion is in the article');
  void town;
  note('gm: accepted the suggestion');
} catch (e) {
  problems.push(`stopped: ${e.message.split('\n').slice(0, 3).join(' ')}`);
  if (process.env.FAIL_SHOTS) for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(process.env.FAIL_SHOTS, `fail-${i}.png`) }).catch(() => {});
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) { console.error(`biblio e2e: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log('biblio e2e: ok');
