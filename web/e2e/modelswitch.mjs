// End-to-end test of the DM's model switcher on the demo world: the DM opens Setup → Models from the Table, adds a
// provider, puts Minerva on a server that is down with the demo's model as the backup, asks Minerva something, and the
// assistant still answers while a notice on every DM page says it is on its backup. "Switch model" goes back to the
// switcher; picking a working model clears the notice. The Historian asks before a new embeddings model.
//
// With MODELSWITCH_REAL=1 the backup is tencent/hy4-flash on OpenRouter instead (a cloud backup the DM allows), so the
// failover is checked against a real model. Needs NODE_USE_ENV_PROXY=1 behind a proxy; a few short calls, well under a cent.
// Run from web/: npm run build && node e2e/modelswitch.mjs
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.MODELSWITCH_E2E_PORT || 8231);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const REAL = process.env.MODELSWITCH_REAL === '1';
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const out = tmpDir('modelswitch');

async function api(method, p, token, body) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
  return j;
}

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(out, 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
try {
  const dmT = (await api('POST', '/api/auth/login', '', { username: 'dm', password: 'dungeon master 123' })).token;
  const world = (await api('GET', '/api/worlds', dmT)).find((x) => x.slug === 'saltreach');
  const WA = `/api/worlds/${world.id}`;

  const { page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1280, height: 900 });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  // The Historian's re-index question is a 409 by design (the browser logs it).
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/409 \(Conflict\)/.test(m.text())) problems.push(`console: ${m.text()}`); });

  // ---- from the Table to the switcher
  await page.goto(`${W}/dm`);
  await page.getByTestId('switch-models').first().click({ timeout: 15000 }).catch(() => problems.push('no "Switch models" link on the Table'));
  await page.waitForURL(/\/dm\/models/, { timeout: 10000 }).catch(() => problems.push('"Switch models" did not open the switcher'));
  const minerva = page.locator('[data-role="dm"]');
  await minerva.waitFor({ timeout: 15000 }).catch(() => problems.push('Minerva has no card on the switcher'));
  await page.screenshot({ path: path.join(out, '1-dm-models.png'), fullPage: true });
  note('the switcher lists the roles');

  // ---- add a provider that is down, from the page
  await page.getByRole('button', { name: 'Add a provider' }).click();
  const add = page.getByRole('region', { name: 'Add a provider' });
  await add.getByLabel('Name').fill('Spare box');
  await add.getByLabel('Provider address').fill('http://127.0.0.1:1/v1');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('option')].some((o) => o.textContent?.startsWith('Spare box')), null, { timeout: 10000 }).catch(() => {});
  let view = await api('GET', `${WA}/models/switch`, dmT);
  const spare = view.providers.find((p) => p.name === 'Spare box');
  check(!!spare, 'the DM could not add a provider');
  let backup = view.providers.find((p) => p.name === 'Fake Argos');
  let backupModel = 'fake-chat';
  if (REAL) {
    backup = (await api('POST', `${WA}/models/switch/providers`, dmT, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-proxy', location: 'cloud' })).provider;
    backupModel = 'tencent/hy4-flash';
    await page.reload(); // the provider was added by the API: the page lists it after a reload
    await minerva.waitFor({ timeout: 15000 });
  }

  // ---- Minerva on the dead box, with a backup
  await minerva.getByRole('button', { name: 'Change' }).click();
  await minerva.getByLabel('Main provider').selectOption(spare.id);
  await minerva.getByText('did not list its models').waitFor({ timeout: 15000 }).catch(() => {});
  await minerva.getByLabel('Main model').fill('fake-chat');
  await minerva.getByLabel('Backup provider').selectOption(backup.id);
  const bm = minerva.getByLabel('Backup model');
  // The provider's list loads after the pick: a dropdown when it lists models, a text box when it does not.
  await minerva.locator('select[aria-label="Backup model"]').waitFor({ timeout: 15000 }).catch(() => {});
  if (await bm.evaluate((e) => e.tagName === 'SELECT')) await bm.selectOption(backupModel); else await bm.fill(backupModel);
  if (REAL) await minerva.getByLabel(/Let world text go to this cloud provider/).check();
  await page.screenshot({ path: path.join(out, '2-change-minerva.png'), fullPage: true });
  await minerva.getByRole('button', { name: 'Save', exact: true }).click();
  await minerva.getByTestId('role-now').filter({ hasText: 'Spare box' }).waitFor({ timeout: 10000 }).catch(() => problems.push('Minerva did not move to the spare box'));
  view = await api('GET', `${WA}/models/switch`, dmT);
  const dmRole = view.roles.find((r) => r.job === 'dm');
  check(dmRole.fallback?.model === backupModel, `the backup should be ${backupModel}, is ${dmRole.fallback?.model}`);
  check(!dmRole.fallbackBlocked, 'the backup is blocked');
  note(`Minerva: spare box (down), backup ${backupModel}`);

  // ---- ask Minerva: the backup answers and the DM is told
  const chat = await api('POST', `${WA}/agent/chats`, dmT, { title: 'Model check' });
  await api('POST', `${WA}/agent/chats/${chat.id}/messages`, dmT, { text: 'In one short sentence: what is the harbour town called?' });
  let answer = '';
  for (let i = 0; i < 90 && !answer; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await api('GET', `${WA}/agent/chats/${chat.id}`, dmT);
    const last = (c.messages ?? []).filter((m) => m.role === 'assistant').at(-1);
    if (last && last.status !== 'working') answer = last.status === 'done' ? last.text || '(empty)' : `(status ${last.status}: ${last.text})`;
  }
  check(answer && !/^\(status|^\(empty/.test(answer), `Minerva did not answer on the backup: ${answer || 'nothing'}`);
  note(`Minerva answered: ${answer.slice(0, 120)}`);
  const band = page.getByTestId('model-health-band');
  await band.waitFor({ timeout: 15000 }).catch(() => problems.push('no notice band after the failover'));
  check((await band.innerText().catch(() => '')).includes(backupModel), 'the notice should name the backup');
  await page.goto(`${W}/dm`);
  await band.waitFor({ timeout: 15000 }).catch(() => problems.push('the notice is not on the Table'));
  await page.screenshot({ path: path.join(out, '3-notice-on-table.png') });
  note('the notice shows on the Table');

  // ---- one tap to switch, then pick a working main model: the notice goes
  await band.getByRole('link', { name: 'Switch model' }).click();
  await page.waitForURL(/\/dm\/models/, { timeout: 10000 });
  await minerva.locator('[data-health="fallback"]').waitFor({ timeout: 10000 }).catch(() => problems.push('Minerva\'s card does not say it is on its backup'));
  await page.screenshot({ path: path.join(out, '4-minerva-on-backup.png'), fullPage: true });
  await minerva.getByRole('button', { name: 'Change' }).click();
  const fake = view.providers.find((p) => p.name === 'Fake Argos');
  await minerva.getByLabel('Main provider').selectOption(fake.id);
  await minerva.locator('select[aria-label="Main model"]').waitFor({ timeout: 15000 });
  await minerva.getByLabel('Main model').selectOption('fake-chat');
  await minerva.getByLabel('Backup provider').selectOption('');
  await minerva.getByRole('button', { name: 'Save', exact: true }).click();
  await band.waitFor({ state: 'detached', timeout: 10000 }).catch(() => problems.push('the notice did not go away after the switch'));
  check((await api('GET', `${WA}/models/health`, dmT)).jobs.length === 0, 'health still lists a role');
  note('switching back cleared the notice');

  // ---- the Historian asks first
  const hist = page.locator('[data-role="extra"]');
  await hist.getByRole('button', { name: 'Change' }).click();
  await hist.getByLabel('Main provider').selectOption(fake.id);
  await hist.locator('select[aria-label="Main model"]').waitFor({ timeout: 15000 });
  await hist.getByLabel('Main model').selectOption('fake-chat');
  await hist.getByRole('button', { name: 'Save', exact: true }).click();
  await hist.getByRole('alert').filter({ hasText: 're-embedded' }).waitFor({ timeout: 10000 }).catch(() => problems.push('no re-index warning for a new embeddings model'));
  await page.screenshot({ path: path.join(out, '5-historian-warning.png'), fullPage: true });
  await hist.getByRole('button', { name: 'Keep the current model' }).click();
  check((await api('GET', `${WA}/models/switch`, dmT)).roles.find((r) => r.job === 'extra').effective?.model === 'fake-embed', 'the Historian changed without a yes');
  note('the Historian asked before a new embeddings model');

  // ---- a phone
  const phone = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 390, height: 844 }, true);
  await phone.page.goto(`${W}/dm/models`);
  await phone.page.locator('[data-role="dm"]').waitFor({ timeout: 15000 });
  const wide = await phone.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!wide, 'the switcher scrolls sideways on a phone');
  await phone.page.screenshot({ path: path.join(out, '6-phone.png'), fullPage: true });
} catch (e) {
  problems.push(`crashed: ${e.message}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(`Screenshots: ${out}`);
if (problems.length) { console.log('Problems:'); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('Model switcher: all good');
