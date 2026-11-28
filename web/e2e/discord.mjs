// End-to-end test of the Discord bot on the demo world, against the stand-in Discord from the librarian tests
// (librarian/test/discord-fake.ts): the GM pastes a token and a server id on GM → Setup → Discord, the bot connects,
// the GM picks channels; Jess gets a link code on Settings & account → Discord, "types" /link in Discord, then /roll
// and /ask. Screenshots go to the e2e temp folder (path printed).
// Run from web/: npm run build && node --experimental-strip-types e2e/discord.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';
import { FakeDiscord, GOOD_TOKEN, GUILD, APP_ID } from '../../librarian/test/discord-fake.ts';

const PORT = Number(process.env.DISCORD_E2E_PORT || 8227);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const out = tmpDir('discord');
const fake = new FakeDiscord();
await fake.listen();
process.env.ALX_DISCORD_API = fake.base;
// A real small model for /ask (default Bonsai 2 9B on OpenRouter): DISCORD_HELPER_URL=https://openrouter.ai/api/v1 (+ _MODEL, _KEY).
if (process.env.DISCORD_HELPER_URL) {
  process.env.ALX_MODEL_HELPER_URL = process.env.DISCORD_HELPER_URL;
  process.env.ALX_MODEL_HELPER_MODEL = process.env.DISCORD_HELPER_MODEL || 'prism-ml/ternary-bonsai-2-9b';
  if (process.env.DISCORD_HELPER_KEY) process.env.ALX_MODEL_HELPER_KEY = process.env.DISCORD_HELPER_KEY;
  process.env.ALX_MODEL_HELPER_OPTIONS = '{"contextTokens":4096,"reasoningModel":false}';
}

const until = async (what, fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) { problems.push(`timed out: ${what}`); return null; } await new Promise((r) => setTimeout(r, 50)); } };
const replyTo = (i) => until(`the reply to /${i.data.name}`, () => {
  const cb = fake.calls.find((c) => c.path === `/interactions/${i.id}/${i.token}/callback`);
  if (!cb) return null;
  if (cb.body.type !== 5) return cb.body.data.content;
  return fake.calls.find((c) => c.method === 'PATCH' && c.path === `/webhooks/${APP_ID}/${i.token}/messages/@original`)?.body.content ?? null;
}, 60000);

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(out, 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
try {
  const { page } = await signIn(browser, base, 'gm', 'game master 123', { width: 1280, height: 900 });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto(`${W}/gm/discord`);
  await page.getByLabel('Bot token').fill(GOOD_TOKEN);
  await page.getByRole('button', { name: 'Save token' }).click();
  await page.getByLabel('Server id').fill(GUILD);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Connected as').waitFor({ timeout: 15000 }).catch(() => problems.push('the bot did not connect'));
  await page.getByLabel('Recaps channel').selectOption({ label: '#recaps' }).catch(() => problems.push('no channel list'));
  await page.getByLabel('Dice channel').selectOption({ label: '#rolls' }).catch(() => problems.push('no dice channel'));
  await page.getByRole('button', { name: 'Send a test' }).click();
  await page.getByText('Test message sent').waitFor({ timeout: 8000 }).catch(() => problems.push('the test post failed'));
  await page.screenshot({ path: path.join(out, '1-gm-discord-setup.png'), fullPage: true });
  note('GM connected the bot and picked channels');

  const pl = await signIn(browser, base, 'jess', 'player pass 123', { width: 390, height: 844 }, true);
  const pp = pl.page;
  pp.on('pageerror', (e) => problems.push(`player page error: ${e.message}`));
  await pp.goto(`${W}/discord`);
  await pp.getByRole('button', { name: 'Get a link code' }).click();
  const cmd = await pp.getByTestId('discord-command').innerText().catch(() => '');
  const code = (/code:(\S+)/.exec(cmd) ?? [])[1];
  if (!code) problems.push('no link code shown');
  await pp.screenshot({ path: path.join(out, '2-player-link-code.png') });
  const JESS = { id: '500000000000000001', username: 'jess_d' };
  note(`/link -> ${await replyTo(fake.interaction(JESS, 'link', { code }))}`);
  await pp.getByRole('button', { name: 'I typed it' }).click();
  await pp.getByText('Linked to').waitFor({ timeout: 8000 }).catch(() => problems.push('the player page did not show the link'));
  await pp.screenshot({ path: path.join(out, '3-player-linked.png') });

  note(`/roll -> ${await replyTo(fake.interaction(JESS, 'roll', { dice: '1d20+4 stealth' }))}`);
  note(`/ask sheet -> ${await replyTo(fake.interaction(JESS, 'ask', { task: 'sheet' }))}`);
  note(`/ask rules -> ${await replyTo(fake.interaction(JESS, 'ask', { task: 'rules', question: 'What does the Dodge action do?' }))}`);
  note(`/ask who -> ${await replyTo(fake.interaction(JESS, 'ask', { question: 'Who secretly runs the harbour?' }))}`);
  note(`/recap -> ${String(await replyTo(fake.interaction(JESS, 'recap'))).slice(0, 160)}`);

  await page.reload();
  await page.getByText('Brindle').or(page.getByText('jess_d')).first().waitFor({ timeout: 8000 }).catch(() => problems.push('the GM page does not list the linked player'));
  await page.screenshot({ path: path.join(out, '4-gm-linked-players.png'), fullPage: true });
} finally {
  await browser.close();
  srv.kill();
  fake.close();
}
console.log(`Screenshots: ${out}`);
if (problems.length) { console.log('PROBLEMS:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('Discord e2e passed');
