// End-to-end test of the players' quick helper on the demo world: the Quick help card sits above the table helper on
// a player's Ask page, "Sum up my sheet" answers from the small model, and a who/why question hands off to the broker
// with the question in its box. The helper job is the demo's fake model unless QUICK_HELPER_URL (and _MODEL, _KEY)
// point at a real one. Screenshots go to the e2e temp folder (path printed).
// Run from web/: npm run build && node e2e/quickhelp.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.QUICK_E2E_PORT || 8223);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const out = tmpDir('quickhelp');
if (process.env.QUICK_HELPER_URL) {
  process.env.ALX_MODEL_HELPER_URL = process.env.QUICK_HELPER_URL;
  process.env.ALX_MODEL_HELPER_MODEL = process.env.QUICK_HELPER_MODEL || 'helper';
  if (process.env.QUICK_HELPER_KEY) process.env.ALX_MODEL_HELPER_KEY = process.env.QUICK_HELPER_KEY;
  process.env.ALX_MODEL_HELPER_OPTIONS = '{"contextTokens":4096,"reasoningModel":false}';
}

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(out, 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
try {
  const { page } = await signIn(browser, base, 'jess', 'player pass 123', { width: 1280, height: 900 });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(`${W}/assistant`);
  await page.getByTestId('ask-helper').click().catch(() => {});
  const card = page.getByTestId('quick-help');
  await card.waitFor({ timeout: 15000 }).catch(() => problems.push('the Quick help card did not show on the table helper'));

  await page.getByTestId('quick-sheet').click();
  await page.getByTestId('quick-answer').waitFor({ timeout: 90000 }).catch(() => problems.push('"Sum up my sheet" gave no answer'));
  check((await page.getByTestId('quick-answer').innerText().catch(() => '')).trim().length > 10, 'the sheet summary is empty');
  await page.screenshot({ path: path.join(out, '1-quick-help-sheet.png') });
  note('Sum up my sheet answered');

  await card.getByLabel('Quick question').fill('Who secretly runs the harbour?');
  await card.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByTestId('quick-handoff').waitFor({ timeout: 30000 }).catch(() => problems.push('a who question did not hand off'));
  await page.screenshot({ path: path.join(out, '2-quick-help-handoff.png') });
  await page.getByTestId('quick-handoff').getByRole('button', { name: 'Talk to the broker instead' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => t.value.includes('Who secretly runs the harbour?')), null, { timeout: 8000 })
    .catch(() => problems.push("the broker's box did not get the question"));
  check(await page.getByTestId('ask-broker').getAttribute('aria-selected') === 'true', 'the hand-off should switch to the broker');
  await page.screenshot({ path: path.join(out, '3-handed-to-broker.png') });
  note('a who question went to the broker, with the question in its box');

  // ---- the same kind of question, sent to the broker in the background ----
  await page.getByTestId('ask-helper').click();
  await page.getByTestId('quick-help').getByLabel('Quick question').fill('Who rules the lighthouse?');
  await page.getByTestId('quick-help').getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByTestId('quick-broker').waitFor({ timeout: 30000 }).catch(() => problems.push('no background broker offer'));
  await page.getByTestId('quick-broker').getByRole('button', { name: 'Ask the broker' }).click({ timeout: 10000 });
  await page.getByTestId('quick-broker-pay').or(page.getByTestId('quick-broker-done')).first().waitFor({ timeout: 30000 }).catch(() => problems.push('the broker gave no price'));
  await page.screenshot({ path: path.join(out, '5-broker-price.png') });
  if (await page.getByTestId('quick-broker-pay').count()) await page.getByTestId('quick-broker-pay').click();
  await page.getByTestId('quick-broker-done').waitFor({ timeout: 30000 }).catch(() => problems.push('the background question was not sent'));
  await page.screenshot({ path: path.join(out, '6-broker-sent.png') });
  note('a question went to the broker in the background');

  // ---- the story so far ----
  await page.getByTestId('quick-recap').click();
  await page.getByTestId('quick-answer').waitFor({ timeout: 90000 }).catch(() => problems.push('"Story so far" gave no answer'));
  await page.screenshot({ path: path.join(out, '7-story-so-far.png') });
  note('Story so far answered');

  const phone = await signIn(browser, base, 'tom', 'player pass 123', { width: 390, height: 844 }, true);
  await phone.page.goto(`${W}/assistant`);
  await phone.page.getByTestId('ask-helper').click().catch(() => {});
  await phone.page.getByTestId('quick-help').waitFor({ timeout: 15000 }).catch(() => problems.push('no Quick help card on a phone'));
  await phone.page.getByTestId('quick-turn').click();
  await phone.page.getByTestId('quick-answer').or(phone.page.getByTestId('quick-handoff')).first().waitFor({ timeout: 90000 }).catch(() => problems.push('"My turn" gave nothing on a phone'));
  check(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the phone page scrolls sideways');
  await phone.page.screenshot({ path: path.join(out, '4-quick-help-phone.png') });
  note('the card works on a phone');
} finally {
  await browser.close();
  srv.kill();
}
console.log(`Screenshots: ${out}`);
if (problems.length) { console.log('PROBLEMS:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('quickhelp e2e: ok');
