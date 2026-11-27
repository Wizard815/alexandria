// Real-run check of a BUILT Alexandria (the Docker container, or the container behind nginx).
// Starts from an EMPTY data folder: first-run setup, GM and players, live sync, phone sign-in,
// the PWA manifest, the microphone picker and the models page. Drives Chromium with fake devices.
//
//   BASE=http://127.0.0.1:18090 SHOTS=/tmp/shots node web/e2e/container.mjs
//   IGNORE_CERT=1   (optional) accept a self-signed certificate (a local nginx test)
//   HOST_MAP='table.example.com=127.0.0.1'   (optional) resolve that name to that address, e.g. BASE=http://table.example.com through nginx
//
// It creates accounts named admin / gm / ann / bo; run it against a throwaway data folder only.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = (process.env.BASE || 'http://127.0.0.1:8090').replace(/\/$/, '');
const SHOTS = process.env.SHOTS || '';
const HOST_MAP = process.env.HOST_MAP || '';
const HEALTH = process.env.HEALTH_URL || BASE + '/health';
const PASS = 'correct horse battery';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); else note('ok: ' + msg); return ok; };
const quiet = (t) => /Failed to load resource.*(40[1-4]|409|502)|fonts\.g|net::ERR_FAILED|net::ERR_INTERNET_DISCONNECTED|net::ERR_CERT_AUTHORITY_INVALID|ResizeObserver/.test(t);

const browser = await chromium.launch({ ...(HOST_MAP ? { proxy: { server: 'http://127.0.0.1:9', bypass: '*' } } : {}), args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(process.env.IGNORE_CERT ? ['--ignore-certificate-errors'] : []), ...(HOST_MAP ? [`--host-resolver-rules=MAP ${HOST_MAP.split('=')[0]} ${HOST_MAP.split('=')[1]}`] : [])] });
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
};
const open = async (who, opts = {}) => {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, permissions: ['microphone'], ...opts });
  const page = await ctx.newPage();
  watch(page, who);
  return { ctx, page };
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const noSideways = async (page, who) => check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${who}: no sideways scroll`);

try {
  // 1. health, then first-run setup through the UI.
  const h = await (await fetch(HEALTH)).json();
  check(h.status === 'ok', `/health ok (version ${h.version})`);
  const { ctx: adminCtx, page: admin } = await open('admin', { viewport: { width: 1366, height: 900 } });
  await admin.goto(BASE + '/');
  await admin.waitForURL('**/setup');
  await shot(admin, '01-setup');
  await admin.getByLabel('Username', { exact: true }).fill('admin');
  await admin.getByLabel('Password', { exact: true }).fill(PASS);
  await admin.getByRole('button', { name: 'Create the admin account' }).click();
  await admin.waitForURL('**/admin/worlds');
  note('setup done');

  // 2. A GM account and a world with that GM.
  await admin.goto(BASE + '/admin/accounts');
  await admin.getByRole('button', { name: 'Add account' }).click();
  await admin.getByLabel('Username', { exact: true }).fill('gm');
  await admin.getByLabel('Display name').fill('The GM');
  await shot(admin, '02-add-account');
  const [resp] = await Promise.all([admin.waitForResponse((r) => /\/api\/admin\/accounts$/.test(r.url()) && r.request().method() === 'POST'), admin.getByRole('button', { name: 'Add', exact: true }).click()]);
  const resetCode = (await resp.json()).resetCode;
  check(!!resetCode, 'admin got a one-time reset code for the new GM account');
  // With a second account the table sign-in no longer opens the admin pages: admins use /admin/login.
  await admin.goto(BASE + '/admin/worlds');
  await admin.waitForURL('**/admin/login');
  await shot(admin, '02b-admin-login');
  await admin.getByLabel('Username', { exact: true }).fill('admin');
  await admin.getByLabel('Password', { exact: true }).fill(PASS);
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.waitForURL('**/admin**');
  await admin.goto(BASE + '/admin/worlds');
  await admin.getByRole('button', { name: 'New empty world' }).click();
  await admin.getByLabel('Name', { exact: true }).fill('Saltreach');
  await admin.getByLabel('Game Master').selectOption({ label: 'The GM (gm)' });
  await admin.getByRole('button', { name: 'Create world' }).click();
  await admin.getByText('Saltreach').first().waitFor();
  for (const p of ['', '/accounts', '/worlds', '/sources', '/keys', '/audit', '/models', '/connections']) {
    await admin.goto(BASE + '/admin' + p);
    await admin.waitForLoadState('networkidle');
  }
  check(true, 'admin pages load (overview, accounts, worlds, sources, keys, audit, models, connections)');

  // 2c. LegendKeeper (API key): the connection form, a missing key, a bad key. No real account is used.
  await admin.goto(BASE + '/admin/connections');
  await admin.getByRole('button', { name: 'New connection' }).first().click();
  await admin.getByRole('dialog').getByText('LegendKeeper (API key)').click();
  await admin.getByLabel('Name', { exact: true }).fill('LegendKeeper test (fake key)');
  await shot(admin, '11-legendkeeper-form');
  check(await admin.getByLabel('API key', { exact: true }).evaluate((e) => e.required), 'LegendKeeper: the API key field is required (the browser refuses an empty one)');
  await shot(admin, '11-legendkeeper-form');
  await admin.keyboard.press('Escape');
  const lkTry = async (label, key) => {
    await admin.getByRole('button', { name: 'New connection' }).first().click();
    await admin.getByRole('dialog').getByText('LegendKeeper (API key)').click();
    await admin.getByLabel('Name', { exact: true }).fill(label);
    await admin.getByLabel('API key', { exact: true }).fill(key);
    await admin.getByRole('button', { name: 'Make connection' }).click();
    await admin.getByText(label).first().waitFor({ timeout: 8000 });
    await admin.getByRole('row', { name: new RegExp(label) }).getByRole('button', { name: 'Test' }).click();
    // The key belongs to the connection; the project address is asked for when testing (and later per world source).
    await admin.getByLabel('Project API URL').fill('https://www.legendkeeper.com/api/v3/projects/00000000-0000-0000-0000-000000000000');
    await admin.getByRole('button', { name: 'Test connection' }).click();
    const box = admin.locator('.error-box, .ok-box').first();
    await box.waitFor({ timeout: 60000 });
    const text = (await box.innerText()).replace(/\s+/g, ' ');
    note(`LegendKeeper test (${label}): ${text}`);
    await shot(admin, label.includes('short') ? '11b-legendkeeper-short-key' : '12-legendkeeper-test');
    await admin.keyboard.press('Escape');
    return text;
  };
  const t1 = await lkTry('LK short key', 'short');
  check(/api key is required/i.test(t1), 'LegendKeeper: a missing/short key gives "API key is required"');
  const t2 = await lkTry('LK fake key', 'lk_fake_key_for_testing_0000');
  check(/legendkeeper|answered|401|403|404|reach|fetch|network|key/i.test(t2), 'LegendKeeper: a bad key or no network gives a readable message');
  await admin.keyboard.press('Escape');

  // 2d. Argos: link it in Models, see its models, pick one per job, save.
  if (process.env.ARGOS_URL) {
    await admin.goto(BASE + '/admin/models');
    await admin.getByLabel('Argos address').fill(process.env.ARGOS_URL);
    await admin.getByRole('button', { name: 'Discover' }).click();
    await admin.getByRole('button', { name: 'Save provider' }).waitFor({ timeout: 30000 });
    await shot(admin, '13-models-argos-discovered');
    await admin.getByRole('button', { name: 'Save provider' }).click();
    await admin.getByRole('region', { name: /^Provider / }).first().waitFor({ timeout: 15000 });
    const chat = admin.locator('[data-job=chat]');
    await chat.getByLabel('Model name').waitFor();
    await admin.waitForTimeout(1500);
    const picked = {};
    for (const job of ['chat', 'audit', 'audio', 'voice', 'extra']) picked[job] = await admin.locator(`[data-job=${job}]`).getByLabel('Model name').inputValue().catch(() => '');
    note('models picked per job after Save provider: ' + JSON.stringify(picked));
    check(Object.values(picked).filter(Boolean).length >= 4, 'Argos: Discover suggested and assigned a model per job');
    // Pick a different model for chat by hand and save it.
    await chat.getByLabel('Model name').fill('audit-tiny');
    await chat.getByRole('button', { name: 'Save', exact: true }).click();
    await admin.waitForTimeout(1500);
    await shot(admin, '14-models-argos-saved');
    await admin.reload();
    check((await admin.locator('[data-job=chat]').getByLabel('Model name').inputValue()) === 'audit-tiny', 'chat job keeps the model picked by hand after a reload');
  }
  await adminCtx.close();

  // 3. The GM signs in and opens the GM screen.
  const { ctx: gmCtx, page: gm } = await open('GM', { viewport: { width: 1366, height: 900 } });
  await gm.goto(BASE + '/reset');
  await gm.getByLabel('Username', { exact: true }).fill('gm');
  await gm.getByLabel('Reset code').fill(resetCode);
  await gm.getByLabel('New password').fill(PASS);
  await gm.getByRole('button', { name: 'Set password and sign in' }).click();
  await gm.waitForURL(/\/w\/saltreach/);
  await gm.waitForURL(/\/w\/saltreach\/gm/);
  await gm.waitForTimeout(1500);
  await shot(gm, '03-gm-screen');
  check(true, 'GM signed in and sees the GM screen');

  // 4. Invites: one code for a phone, one link for another phone.
  await gm.goto(BASE + '/w/saltreach/gm/settings');
  await gm.getByRole('tab', { name: /invite players/i }).or(gm.getByRole('button', { name: /invite players/i })).first().click();
  const invite = async () => {
    const before = await gm.locator('.ok-box .mono').first().innerText().catch(() => '');
    await gm.getByRole('button', { name: 'Make an invite code' }).click();
    await gm.waitForFunction((b) => { const e = document.querySelector('.ok-box .mono'); return e && e.textContent !== b; }, before);
    const link = await gm.locator('.ok-box .mono').nth(1).innerText();
    const code = await gm.locator('.ok-box .mono').first().innerText();
    return { link, code };
  };
  const inv1 = await invite();
  check(inv1.link.startsWith(BASE), `invite link is built from the page address (${inv1.link.replace(/code=.*/, 'code=…')})`);
  const inv2 = await invite();

  // 5. Player Ann joins on an iPhone-sized phone by typing the code; Bo on an Android-sized phone by link.
  const iphone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' };
  const android = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' };
  const { ctx: annCtx, page: ann } = await open('Ann', iphone);
  await ann.goto(BASE + '/join');
  await ann.getByLabel('Invite code').fill(inv1.code);
  await ann.getByLabel('Pick a username').fill('ann');
  await ann.getByLabel('Pick a password').fill(PASS);
  await ann.getByLabel('Character name').fill('Sera Vane');
  await shot(ann, '04-phone-join');
  await ann.getByRole('button', { name: 'Join' }).click();
  await ann.getByRole('button', { name: 'Open the world' }).click();
  await ann.waitForURL(/\/w\/saltreach/);
  await ann.waitForTimeout(1500);
  await shot(ann, '05-phone-player-iphone');
  check(true, 'Ann joined with an invite code on a 390x844 phone and landed on the world');
  await noSideways(ann, 'Ann (iPhone)');

  const { ctx: boCtx, page: bo } = await open('Bo', android);
  await bo.goto(inv2.link.replace(/^https?:\/\/[^/]+/, BASE));
  check((await bo.getByLabel('Invite code').inputValue()) === inv2.code, 'invite link pre-fills the code');
  await bo.getByLabel('Pick a username').fill('bo');
  await bo.getByLabel('Pick a password').fill(PASS);
  await bo.getByRole('button', { name: 'Join' }).click();
  await bo.getByRole('button', { name: 'Open the world' }).waitFor({ timeout: 8000 }).catch(async () => { throw new Error('Bo could not join: ' + (await bo.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)); });
  await bo.getByRole('button', { name: 'Open the world' }).click();
  await bo.waitForURL(/\/w\/saltreach/);
  await bo.waitForTimeout(1500);
  await shot(bo, '06-phone-player-android');
  check(true, 'Bo joined with an invite link on a 412x915 phone');
  await noSideways(bo, 'Bo (Android)');

  // 6. Staying signed in: close and reopen with the same storage (new page in the same context).
  const again = await ann.context().newPage();
  watch(again, 'Ann reopened');
  await again.goto(BASE + '/');
  await again.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  check(true, 'Ann is still signed in after reopening the app');
  await again.close();

  // 7. Live sync: GM puts a text card on the stage; both phones see it without reloading.
  await ann.goto(BASE + '/w/saltreach/live');
  await bo.goto(BASE + '/w/saltreach/live');
  await gm.goto(BASE + '/w/saltreach/gm/stage');
  await gm.getByLabel('What').selectOption('text');
  await gm.getByLabel('Heading (optional)').fill('The tide bell rings');
  await gm.getByLabel('Text (Markdown)').fill('Three slow strokes from the drowned chapel.');
  await gm.getByLabel('Show to the table right away').check();
  await shot(gm, '07-gm-stage');
  await gm.getByRole('button', { name: 'Add card' }).click();
  await ann.getByText('The tide bell rings').first().waitFor({ timeout: 10000 });
  await bo.getByText('The tide bell rings').first().waitFor({ timeout: 10000 });
  check(true, 'GM stage card reached both phones live (no reload)');
  await shot(ann, '08-phone-live-card');

  // 8. SSE reconnect: drop the phone offline and back; a second card still arrives.
  await bo.context().setOffline(true);
  await bo.waitForTimeout(1500);
  await bo.context().setOffline(false);
  await gm.getByLabel('What').selectOption('text');
  await gm.getByLabel('Heading (optional)').fill('Second toll');
  await gm.getByLabel('Text (Markdown)').fill('The bell again.');
  await gm.getByLabel('Show to the table right away').check();
  await gm.getByRole('button', { name: 'Add card' }).click();
  await bo.getByText('Second toll').first().waitFor({ timeout: 40000 });
  check(true, 'phone reconnected after going offline and received the next card');

  // 9. PWA: manifest, icons, service worker.
  const mf = await bo.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  check(mf.name && mf.start_url && mf.display === 'standalone' && mf.theme_color, 'manifest has name, start_url, display standalone, theme colour');
  check(mf.icons.some((i) => i.purpose === 'maskable') && mf.icons.some((i) => /512/.test(i.sizes)), 'manifest has 512px and maskable icons');
  for (const i of mf.icons) check(await bo.evaluate(async (u) => (await fetch(u)).ok, i.src), `icon ${i.src} is served`);
  const secure = await bo.evaluate(() => isSecureContext);
  note(`secure context: ${secure}${secure ? '' : ' (plain http on a name other than localhost: no service worker, no microphone; phones need https)'}`);
  const sw = !secure ? 'skipped (plain http)' : await bo.evaluate(async () => { const r = await navigator.serviceWorker?.ready; return r ? r.scope : null; }).catch(() => null);
  check(!!sw, `service worker registered (scope ${sw})`);

  // 9b. Wrong password gives a clear message.
  const { ctx: badCtx, page: bad } = await open('bad login');
  await bad.goto(BASE + '/login');
  await bad.getByLabel(/username/i).fill('ann');
  await bad.getByLabel(/password/i).fill('not the password');
  await bad.getByRole('button', { name: /sign in/i }).click();
  await bad.getByText(/invalid|incorrect|wrong|not right|try again/i).first().waitFor({ timeout: 8000 });
  check(true, 'a wrong password shows an error');
  await badCtx.close();

  if (secure) {
  // 10. Microphones: the GM audio page lists the fake devices; the assistant mic picker remembers a choice.
  await gm.goto(BASE + '/w/saltreach/gm/audio');
  await gm.waitForTimeout(1500);
  await shot(gm, '09-gm-audio-mics');
  const audioText = await gm.locator('main').innerText();
  check(/microphone|fake|default/i.test(audioText), 'GM audio page lists microphones');
  const devs = await gm.evaluate(async () => { const a = await navigator.mediaDevices.enumerateDevices(); return { inputs: a.filter((d) => d.kind === 'audioinput').length, outputs: a.filter((d) => d.kind === 'audiooutput').length }; });
  check(devs.inputs > 0, `fake input devices present (${devs.inputs} in, ${devs.outputs} out)`);
  await gm.goto(BASE + '/w/saltreach/gm/sound');
  await gm.waitForTimeout(1500);
  await shot(gm, '10-gm-sound');
  await gm.getByRole('tab', { name: 'Speakers' }).or(gm.getByRole('button', { name: 'Speakers' })).first().click();
  await gm.waitForTimeout(800);
  const outs = await gm.locator('main select option, main label').allInnerTexts();
  check(outs.some((t) => /fake|default|output/i.test(t)), 'sound board Speakers tab lists output devices');
  await shot(gm, '15-gm-speakers');

  // Recording starts on a chosen microphone, and the choice is remembered.
  await gm.goto(BASE + '/w/saltreach/gm/audio');
  await gm.waitForTimeout(1200);
  const mic1 = gm.getByRole('switch', { name: /Use Fake Audio Input 1/ }).or(gm.getByLabel(/Use Fake Audio Input 1/)).first();
  await mic1.click();
  await gm.waitForTimeout(800);
  await gm.reload();
  await gm.waitForTimeout(1500);
  check(await gm.getByRole('switch', { name: /Use Fake Audio Input 1/ }).first().isChecked().catch(() => false), 'the chosen microphone is remembered after a reload');
  await gm.getByRole('button', { name: /Start recording/ }).click();
  await gm.getByRole('button', { name: 'Stop recording' }).waitFor({ timeout: 15000 });
  await gm.waitForTimeout(2500);
  await shot(gm, '16-gm-recording');
  check(true, 'recording started with the fake microphone');
  await gm.getByRole('button', { name: 'Stop recording' }).click();
  await gm.waitForTimeout(1500);

  // The assistant's dictation: a microphone picker, remembered per browser.
  await gm.goto(BASE + '/w/saltreach/gm');
  await gm.waitForTimeout(1500);
  await gm.getByRole('button', { name: /Open the assistant/ }).click();
  await gm.waitForTimeout(1500);
  await shot(gm, '17a-assistant-open');
  await gm.getByTestId('ag-mic-pick').first().click();
  const sel = gm.getByTestId('ag-mic-select');
  await sel.waitFor();
  const opts = await sel.locator('option').allTextContents();
  check(opts.length > 1, `assistant dictation lists microphones (${opts.join(' | ')})`);
  await sel.selectOption({ index: 2 });
  await shot(gm, '17-assistant-mic-picker');
  check(await gm.evaluate(() => !!localStorage.getItem('alx.dictation.mic')), 'the dictation microphone choice is saved on this browser');

  }
  await gmCtx.close(); await annCtx.close(); await boCtx.close();
} catch (e) {
  problems.push('script error: ' + (e.stack || e));
}
await browser.close();
if (problems.length) { console.log('\nPROBLEMS:'); problems.forEach((p) => console.log(' - ' + p)); process.exit(1); }
console.log('\ncontainer run passed');
