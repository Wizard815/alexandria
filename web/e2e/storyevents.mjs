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
  await page.getByText('Happening now').waitFor();
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

  // ---- a sure DM note: the pickpocket, let go ----
  const jess = (await api('GET', '/encounters')).body.find((e) => e.player === 'Jessamine');
  check(!!jess, 'the DM sees the event');
  await api('POST', '/encounters', { accountIds: [jess.accountId], templateId: 'builtin:ev-pickpocket' });
  await player.page.getByText('A quick-fingered urchin').first().waitFor({ timeout: 15_000 });
  await player.page.getByTestId('encounter').getByRole('button', { name: 'Let it go' }).click();
  await player.page.getByText('You lose', { exact: false }).first().waitFor();
  check(!(await player.page.getByText('Let a pickpocket get away').count()), 'the DM note reached the player');
  await page.goto(`${W}/dm/encounters?tab=events`);
  await page.getByText('Let a pickpocket get away', { exact: false }).first().waitFor({ timeout: 10_000 });
  note('the DM sees the DM-only note; the player does not');

  // ---- templates: starters, a story event and a spell from them, a template chat ----
  await page.goto(`${W}/dm/templates`);
  await page.getByRole('tab', { name: 'Starters' }).click();
  await page.locator('[data-testid=tpl-starter][data-name="Town & city temptations"]').getByRole('button').click();
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
  await page.locator('[data-testid=tpl-starter][data-name="Balanced homebrew spell"]').getByRole('button').click();
  await page.getByTestId('tpl-editor').waitFor();
  await page.getByRole('button', { name: 'Cancel' }).click();
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
