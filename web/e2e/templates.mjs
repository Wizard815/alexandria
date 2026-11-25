// End-to-end test of Templates & guides on the demo world (fake models; the fake models server also answers as a
// SearXNG instance, so web research is stubbed and nothing leaves the machine). The DM turns web research on, makes a
// "Towns" guide with the assistant (describe it, the assistant drafts it and asks a few questions, save), then asks
// the assistant for a town: the chat shows "Using guide: Towns" and each step (library lore, neighbouring places, the
// web search waiting as a card with its words, example pages). Approving the search brings the sources into the chat
// and the assistant carries on with them. A DM-only name in a search is refused before anything is sent. The page
// works at phone width with no sideways scrolling, and players cannot open it.
// Run from web/: npm run build && node e2e/templates.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.TEMPLATES_E2E_PORT || 19611);
const MODELS_PORT = PORT + 1;
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--models-port', String(MODELS_PORT), '--data', path.join(tmpDir('templates'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tok = await login('dm', 'dungeon master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tok } })).json())[0].id;
const api = async (m, p, b, t = tok) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console: ${m.text()}`); });
};

try {
  await api('PATCH', '/settings', { agentAuto: false });
  const { page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1400, height: 900 });
  watch(page, 'desktop');

  // ---- the page is in the DM menu ----
  await page.goto(`${W}/dm`);
  // The menu shows one area at a time: the guide lives under Prep.
  await page.locator('[data-group=prep]').first().click().catch(() => problems.push('no Prep area in the DM menu'));
  const link = page.locator('a[href$="/dm/templates"]').first();
  await link.waitFor({ timeout: 15000 }).catch(() => problems.push('no Templates & guides entry in the DM menu'));
  check(/Templates & guides/.test(await link.innerText().catch(() => '')), 'the menu entry should read "Templates & guides"');
  await page.goto(`${W}/dm/templates`);
  await page.getByRole('heading', { name: 'Templates & guides' }).waitFor({ timeout: 10000 });

  // ---- web research: off by default, turned on with the stubbed SearXNG ----
  await page.getByRole('tab', { name: 'Web research' }).click();
  const on = page.getByTestId('tpl-web-on');
  await on.waitFor({ timeout: 8000 });
  check(!(await on.isChecked()), 'web research should be off by default');
  await on.check();
  await page.getByTestId('tpl-web-provider').selectOption('searxng');
  await page.getByTestId('tpl-web-searx').fill(`http://127.0.0.1:${MODELS_PORT}`);
  await page.getByTestId('tpl-web-save').click();
  await page.getByText('Saved.').waitFor({ timeout: 5000 }).catch(() => problems.push('web research settings did not save'));
  check((await api('GET', '/templates/web')).body.config?.enabled === true, 'web research is not on on the server');

  // ---- New with the assistant: describe, draft, questions, save ----
  await page.getByRole('tab', { name: 'New with the assistant' }).click();
  await page.getByTestId('tpl-describe').fill('Towns: for my world always research the IRL Japanese town as well as my own world lore and the towns around it. Always do that.');
  await page.getByTestId('tpl-draft').click();
  await page.getByTestId('tpl-editor').waitFor({ timeout: 15000 });
  check((await page.getByTestId('tpl-name').inputValue()) === 'Towns', 'the draft should be called Towns');
  check(/town/.test(await page.getByTestId('tpl-triggers').inputValue()), 'the draft should trigger on "town"');
  const steps = await page.getByTestId('tpl-steps').locator('li').count();
  check(steps >= 4, `the draft should have its steps (got ${steps})`);
  check(await page.getByTestId('tpl-questions').isVisible().catch(() => false), 'the assistant should ask a few questions');
  await page.getByTestId('tpl-save').click();
  await page.locator('[data-testid=tpl-item][data-name="Towns"]').waitFor({ timeout: 8000 }).catch(() => problems.push('the saved guide is not in the list'));
  const towns = (await api('GET', '/templates')).body.templates?.find((t) => t.name === 'Towns');
  check(towns && towns.kind === 'guide' && towns.version === 1, 'the guide was not saved as version 1');
  note(`saved guide Towns: ${towns?.spec?.steps?.map((s) => s.kind).join(', ')}`);

  // ---- ask for a town: "Using guide: Towns" and the steps ----
  await page.keyboard.press('Control+k');
  const box = page.locator('[data-ag-input]');
  await box.waitFor({ timeout: 8000 });
  await box.fill('Make a town called Kirihama based on Tomonoura, near Saltmarsh');
  await page.keyboard.press('Enter');
  const guideBox = page.getByTestId('ag-guide').first();
  await guideBox.waitFor({ timeout: 15000 }).catch(() => problems.push('no "Using guide" box in the chat'));
  check(/Using guide: Towns/.test(await guideBox.innerText().catch(() => '')), 'the chat should say "Using guide: Towns"');
  const step = (kind) => guideBox.locator(`li[data-kind=${kind}]`).first();
  check((await step('library').getAttribute('data-status').catch(() => '')) === 'done', 'the library step should be done');
  check(/Greywater Ferry/.test(await step('neighbours').innerText().catch(() => '')), 'the neighbours step should find Greywater Ferry next to Saltmarsh');
  check((await step('web').getAttribute('data-status').catch(() => '')) === 'waiting', 'the web step should wait for approval (Ask first)');
  const card = page.locator('[data-testid=action-card][data-status=pending]').filter({ hasText: 'Search the web for' }).first();
  await card.waitFor({ timeout: 10000 }).catch(() => problems.push('no approval card for the web search'));
  check(/"Tomonoura Japan town/.test(await card.innerText().catch(() => '')), 'the card should show the exact search words');
  note('the guide ran: library, neighbours and examples done; the web search waits on a card with its words');

  // ---- approve: sources in the chat, the assistant carries on with the guide ----
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.locator('.ag-msg').filter({ hasText: 'Web research results' }).first().waitFor({ timeout: 15000 }).catch(() => problems.push('the search results did not reach the chat'));
  check(/example\.org/.test(await page.locator('.ag-msg').filter({ hasText: 'Web research results' }).first().innerHTML().catch(() => '')), 'the results should link their sources');
  // The assistant carries on by itself: a second reply with the guide, whose web step is now done.
  await page.waitForFunction(() => { const g = [...document.querySelectorAll('[data-testid=ag-guide]')]; return g.length >= 2 && g.at(-1).querySelector('li[data-kind=web]')?.getAttribute('data-status') === 'done'; }, null, { timeout: 20000 }).catch(() => problems.push('the assistant did not carry on with the guide after the search'));
  note('approved: sources in the chat, and the assistant carried on with the guide');

  // ---- a DM-only name never goes out ----
  const searchesBefore = (await (await fetch(`http://127.0.0.1:${MODELS_PORT}/v1/models`)).ok);
  check(searchesBefore, 'the fake models server answers');
  const blocked = await api('POST', '/templates/web/search', { queries: ['Velmira smuggler queen'] });
  check(blocked.status === 422 && /DM-only/.test(blocked.body.error ?? ''), `a DM-only name in a search should be refused (got ${blocked.status})`);
  await box.fill('Make a town based on Velmira near Saltmarsh');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=ag-guide] li[data-kind=web]')].some((l) => l.getAttribute('data-status') === 'blocked'), null, { timeout: 15000 }).catch(() => problems.push('a search for a DM-only name should show as blocked'));

  // ---- players cannot open it ----
  const ptok = await login('jess', 'player pass 123');
  check((await api('GET', '/templates', undefined, ptok)).status === 403, 'a player must not read templates');

  // ---- phone width ----
  const ph = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 390, height: 844 }, true);
  watch(ph.page, 'phone');
  await ph.page.goto(`${W}/dm/templates`);
  await ph.page.getByRole('heading', { name: 'Templates & guides' }).waitFor({ timeout: 10000 });
  await ph.page.locator('[data-testid=tpl-item][data-name="Towns"]').waitFor({ timeout: 8000 }).catch(() => problems.push('phone: the guide is not listed'));
  const over = await ph.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `phone: the page scrolls sideways by ${over}px`);
  await ph.page.locator('[data-testid=tpl-item][data-name="Towns"]').getByRole('button', { name: 'Edit' }).click();
  await ph.page.getByTestId('tpl-editor').waitFor({ timeout: 5000 });
  const over2 = await ph.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over2 <= 1, `phone: the editor scrolls sideways by ${over2}px`);
  note(`phone width: no sideways scroll (list ${over}px, editor ${over2}px)`);
} catch (e) {
  problems.push(`crashed: ${e.stack ?? e}`);
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) {
  console.log(`\ntemplates e2e: ${problems.length} problem(s)\n${problems.map((p) => ' - ' + p).join('\n')}`);
  process.exit(1);
}
console.log('templates e2e: ok');
