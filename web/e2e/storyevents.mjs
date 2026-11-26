// End-to-end test of story events and the new template kinds on the demo world (fake models). The DM picks a place
// and a player on Encounters → Story events and sends a random event; the player gets "Something happens" and
// answers; the DM sees the choice and the DM-only note, which never reaches the player. On Templates & guides the DM
// copies in a quick event starter and a spell starter, drafts a story event and a spell from them and saves both,
// and the template has its own chat. The pages work at phone width with no sideways scrolling.
// Run from web/: npm run build && node e2e/storyevents.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.STORY_E2E_PORT || 19631);
const MODELS_PORT = PORT + 1;
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--models-port', String(MODELS_PORT), '--data', path.join(tmpDir('story'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tok = await login('dm', 'dungeon master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tok } })).json())[0].id;
const api = async (m, p, b, t = tok) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console: ${m.text()}`); });
};
const noSideways = async (page, what) => check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${what} scrolls sideways at phone width`);

try {
  const { page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1400, height: 900 });
  watch(page, 'dm');
  const player = await signIn(browser, base, 'jess', 'player pass 123', { width: 420, height: 860 }, true);
  watch(player.page, 'player');

  // ---- send a random dungeon event to Jessamine ----
  await page.goto(`${W}/dm/encounters?tab=events`);
  await page.getByTestId('story-place-dungeon').click();
  await page.getByRole('group', { name: 'Players' }).getByRole('button', { name: 'Jessamine' }).click();
  const events = await page.getByTestId('story-event').count();
  check(events >= 2, `dungeon shows ${events} events`);
  await page.getByTestId('story-random').click();
  // Nothing goes out before the preview's Send.
  await page.getByTestId('story-preview').waitFor();
  check((await api('GET', '/encounters')).body.filter((e) => e.status === 'open').length === 0, 'the random event went out before Send');
  await page.getByTestId('story-another').click();
  await page.getByTestId('story-preview').waitFor();
  await page.getByTestId('story-send').click();
  await page.getByTestId('story-preview').waitFor({ state: 'detached' });
  await page.locator('[data-testid=enc-watch]').first().waitFor({ timeout: 10_000 });
  note('sent a random dungeon event');

  // ---- the player gets it and answers ----
  await player.page.goto(`${W}`);
  const pop = player.page.getByTestId('encounter');
  await pop.waitFor({ timeout: 15_000 });
  check(await pop.getByText('Something happens').isVisible(), 'the player popup does not say "Something happens"');
  const first = pop.locator('button').filter({ hasNotText: /Later|✕/ }).first();
  await first.click();
  note('the player answered');

  // ---- the pickpocket: a timed step, then a roll the player types in ----
  const jess = (await api('GET', '/encounters')).body.find((e) => e.player === 'Jessamine');
  check(!!jess, 'the DM sees the event');
  await api('POST', '/encounters', { accountIds: [jess.accountId], templateId: 'builtin:ev-pickpocket' });
  await player.page.getByText('A quick-fingered urchin').first().waitFor({ timeout: 15_000 });
  await player.page.getByTestId('enc-countdown').waitFor();
  check(/s to answer/.test(await player.page.getByTestId('enc-countdown').innerText()), 'no countdown on the timed step');
  await player.page.screenshot({ path: path.join(tmpDir('story'), 'timer.png') }).catch(() => {});
  await player.page.getByTestId('encounter').getByRole('button', { name: 'Give chase' }).click();
  await player.page.getByTestId('enc-roll').waitFor();
  check(await player.page.getByText('Roll a d20 for Athletics', { exact: false }).isVisible(), 'the roll prompt does not name the skill');
  check(!(await player.page.getByRole('button', { name: 'Roll for me' }).count()), 'a story event check offers Roll for me');
  check(await player.page.getByRole('button', { name: 'Natural 20' }).isVisible(), 'no Natural 20 toggle');
  await player.page.getByRole('button', { name: 'Natural 1' }).click();
  await player.page.getByRole('button', { name: 'Natural 1' }).click(); // and off again
  await player.page.getByLabel('Your total').fill('30');
  await player.page.getByRole('button', { name: 'Send roll' }).click();
  await player.page.getByText('You rolled 30 for Athletics', { exact: false }).first().waitFor();
  check(!(await player.page.getByText('picked from', { exact: false }).count()), 'the player saw the DC');
  await player.page.getByTestId('encounter').getByRole('button', { name: 'Hand the extra purse to the watch' }).click();

  // ---- a sure DM note: the pickpocket, let go ----
  await api('POST', '/encounters', { accountIds: [jess.accountId], templateId: 'builtin:ev-pickpocket' });
  await player.page.getByText('A tug at your belt').first().waitFor({ timeout: 15_000 });
  await player.page.getByTestId('encounter').getByRole('button', { name: 'Let it go' }).click();
  await player.page.getByText('You lose', { exact: false }).first().waitFor();
  check(!(await player.page.getByText('Let a pickpocket get away').count()), 'the DM note reached the player');
  await page.goto(`${W}/dm/encounters?tab=events`);
  await page.getByText('Let a pickpocket get away', { exact: false }).first().waitFor({ timeout: 10_000 });
  check((await page.getByText('picked from 10–14', { exact: false }).count()) > 0, 'the DM does not see the picked DC');
  note('the DM sees the DM-only note; the player does not');

  // ---- favourites, generate new, tweak ----
  await page.getByTestId('story-place-market').click();
  await page.getByRole('group', { name: 'Players' }).getByRole('button', { name: 'Jessamine' }).click();
  const gem = page.locator('[data-testid=story-event][data-name="Undervalued gem"]');
  await gem.getByTestId('story-star').click();
  await page.getByTestId('story-from-fav').click();
  check(await page.getByTestId('story-event').count() === 1, 'favourites shows more than the starred event');
  await page.getByTestId('story-random').click();
  await page.getByTestId('story-preview').waitFor();
  check(await page.getByRole('heading', { name: 'Undervalued gem' }).isVisible(), 'random from favourites did not pick the starred one');
  // The preview is step cards; the gem's first step has answers as blocks.
  check(await page.getByTestId('flow-step').count() >= 3, 'the preview does not show the steps as cards');
  await page.getByTestId('story-tweak-btn').click();
  await page.getByTestId('story-tweak').waitFor();
  // Build with blocks: a new answer that makes a new step, a check with its two outcome steps, a timer.
  const steps0 = await page.getByTestId('blk-step').count();
  const top = page.getByTestId('blk-step').first();
  await top.getByRole('button', { name: '+ Answer' }).click();
  const ans = top.getByTestId('blk-answer').last();
  await ans.getByLabel('Answer', { exact: true }).fill('Haggle for it');
  await ans.getByLabel('Goes to').selectOption('__new__');
  check(await page.getByTestId('blk-step').count() === steps0 + 1, 'a new step from the answer picker was not made');
  const last = page.locator('[data-testid=blk-step][data-step=step]');
  await last.getByLabel('What happens').fill('The stallholder squints at you.');
  await last.getByRole('button', { name: '+ Check' }).click();
  check(await page.getByTestId('blk-step').count() === steps0 + 3, 'a check did not bring its pass and fail steps');
  await last.getByLabel('Skill').fill('Persuasion');
  await last.getByRole('button', { name: '+ Timer' }).click();
  await last.getByTestId('blk-timer').waitFor();
  await page.screenshot({ path: path.join(tmpDir('story'), 'blocks.png') }).catch(() => {});
  await page.getByTestId('story-tweak').getByRole('button', { name: 'Back to the preview' }).click();
  await page.getByTestId('story-preview').getByRole('button', { name: 'Close' }).click();
  await page.getByTestId('story-from-any').click();
  await page.getByTestId('story-generate').click();
  await page.getByTestId('story-gen-prompt').fill('A stray dog follows them through the market.');
  await page.getByTestId('story-gen-go').click();
  await page.getByTestId('story-preview').waitFor({ timeout: 20_000 });
  check(await page.getByText('New draft, not saved').isVisible(), 'a generated event does not say it is unsaved');
  await page.screenshot({ path: path.join(tmpDir('story'), 'preview.png') }).catch(() => {});
  await page.getByTestId('story-send').click();
  await page.getByTestId('story-preview').waitFor({ state: 'detached' });
  await player.page.getByTestId('encounter').waitFor({ timeout: 15_000 });
  note('favourites, a generated event sent from its preview');

  // ---- templates: starters, a story event and a spell from them, a template chat ----
  await page.goto(`${W}/dm/templates`);
  await page.getByRole('tab', { name: 'Starters' }).click();
  await page.getByTestId('tpl-pack-events').locator('li', { hasText: 'Town & city temptations' }).getByRole('button', { name: 'Add' }).click();
  await page.getByText('Added Town & city temptations', { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  await page.locator('[data-testid=tpl-item][data-name="Town & city temptations"]').getByRole('button', { name: 'Edit' }).click();
  await page.getByTestId('tpl-editor').waitFor();
  check(await page.getByTestId('tpl-chat').isVisible(), 'no template chat on a saved template');
  await page.getByRole('button', { name: 'Cancel' }).click();
  const item = page.locator('[data-testid=tpl-item][data-name="Town & city temptations"]');
  await item.getByRole('button', { name: 'Make a story event' }).click();
  await page.getByTestId('tpl-event-prompt').fill('A street kid steals a purse in the market.');
  await page.getByTestId('tpl-event-go').click();
  await page.getByTestId('tpl-event-draft').waitFor({ timeout: 20_000 });
  await page.getByTestId('tpl-event-save').click();
  await page.getByText('Saved. Send it from').waitFor();
  await page.getByText('Close', { exact: true }).click();
  const saved = (await api('GET', '/encounters/templates/all?kind=event')).body.templates;
  check(saved.length >= 1 && saved[0].places.includes('market'), 'the story event was not saved with its places');
  note('a story event from the quick event template');

  await page.getByRole('tab', { name: 'Starters' }).click();
  await page.getByTestId('tpl-pack-spells').locator('li', { hasText: 'Balanced homebrew spell' }).getByRole('button', { name: 'Add' }).click();
  await page.getByText('Added Balanced homebrew spell', { exact: false }).waitFor();
  await page.getByRole('tab', { name: 'Templates', exact: true }).click();
  await page.locator('[data-testid=tpl-item][data-name="Balanced homebrew spell"]').getByRole('button', { name: 'Make a spell' }).click();
  await page.getByTestId('tpl-spell-prompt').fill('Frost Pin: pins one foe’s feet to the ground');
  await page.getByTestId('tpl-spell-go').click();
  await page.getByTestId('tpl-spell-draft').waitFor({ timeout: 20_000 });
  await page.getByTestId('tpl-spell-save').click();
  await page.getByText('Saved to the Codex').waitFor();
  const spells = (await api('GET', '/spells/list?q=Frost%20Pin')).body;
  check(JSON.stringify(spells).includes('Frost Pin'), 'the spell is not in the Codex');
  note('a spell from the spell template, saved to the Codex');

  // ---- phone width ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${W}/dm/encounters?tab=events`);
  await page.getByText('Make something happen').waitFor();
  await noSideways(page, 'Story events');
  await page.goto(`${W}/dm/templates`);
  await page.getByRole('tab', { name: 'Template chats' }).click();
  await page.getByTestId('tpl-chats').waitFor();
  await noSideways(page, 'Template chats');
  // Players never get the story event list or templates.
  const jt = await login('jess', 'player pass 123');
  check((await api('GET', '/encounters/templates/all', undefined, jt)).status === 403, 'a player read the story event list');
  check((await api('GET', '/templates', undefined, jt)).status === 403, 'a player read the templates');
} catch (e) {
  problems.push(`crashed: ${e.stack ?? e}`);
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) { console.error('STORY EVENTS E2E FAILED:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('story events e2e: ok');
