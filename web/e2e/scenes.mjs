// End-to-end test of scenes on the demo world: the GM saves a scene (a stage card for the players' TV, a map for the
// table screen, and a lights preset that does not exist), taps it in the side-screen panel, and the players' screen and
// the table screen change live while the report says the lights part failed and the rest worked. Undo puts both back.
// The phone's Remote tab lists the same scene. Run from web/: npm run build && node e2e/scenes.mjs   (SCENES_PORT)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.SCENES_PORT || 8220);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('scenes'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
};
const shows = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const gone = (loc, ms = 8000) => loc.waitFor({ state: 'detached', timeout: ms }).then(() => true, () => false);

const CARD = 'Scene Test Lighthouse Card';

try {
  const { ctx, page } = await signIn(browser, base, 'dm', 'game master 123', { width: 1080, height: 1900 }, false, /\/w\/saltreach/);
  watch(page, 'dm');
  const token = await page.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body, raw) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, body: raw ? raw : body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // What the scene points at: a map picture of our own and a stage card nobody has seen yet.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#264653'; g.fillRect(0, 0, 300, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });
  const up = await api('POST', `/files?${new URLSearchParams({ name: 'scenecove.png', folder: 'Maps', title: 'Scene cove', level: 'party', kind: 'map' })}`, undefined, Buffer.from(png, 'base64'));
  check(up.status === 201, `map upload: ${up.status} ${JSON.stringify(up.json)}`);
  const PIC = `lib:${up.json.id}`;
  const card = await api('POST', '/stage/cards', { kind: 'text', title: CARD, text: 'The lamp turns toward the sea.', show: false });
  check(card.status < 300, `card: ${card.status}`);
  const before = (await api('GET', '/fog/table')).json;

  const made = await api('POST', '/scenes', { name: 'Lighthouse', color: '#e9c46a', parts: { tv: { mode: 'card', cardId: card.json.id }, table: { mapId: 'world', pic: PIC, fog: 'keep' }, lights: { scene: 'no-such-lights-preset' } } });
  check(made.status === 201, `scene create: ${made.status} ${JSON.stringify(made.json)}`);

  // The players' TV and the table screen, open before anything happens.
  const tv = await ctx.newPage();
  watch(tv, 'tv');
  await tv.setViewportSize({ width: 1600, height: 900 });
  await tv.goto(`${W}/screen/players`);
  await tv.locator('.ps').waitFor({ timeout: 10000 });
  check(!(await tv.evaluate((t) => document.body.innerText.includes(t), CARD)), 'tv: the card shows before the scene');
  const table = await ctx.newPage();
  watch(table, 'table');
  await table.setViewportSize({ width: 1600, height: 900 });
  await table.goto(`${W}/screen/table`);
  await table.getByTestId('table-screen').waitFor({ timeout: 10000 });

  // The scene buttons on the portrait side screen's panel.
  await page.goto(`${W}/panel/scenes`);
  const btn = page.locator('[data-testid=scene-btn][data-scene="Lighthouse"]');
  check(await shows(btn), 'panel: the scene button is there');
  await btn.click();
  check(await shows(page.getByTestId('scene-report')), 'panel: a report after activating');
  const report = await page.getByTestId('scene-report').innerText().catch(() => '');
  check(/failed/i.test(await page.getByTestId('scene-part-lights').innerText().catch(() => '')), `report: the lights part failed (${report.slice(0, 200)})`);
  check(!/failed/i.test(await page.getByTestId('scene-part-tv').innerText().catch(() => 'failed')), `report: the TV part worked (${report.slice(0, 200)})`);
  check(!/failed/i.test(await page.getByTestId('scene-part-table').innerText().catch(() => 'failed')), `report: the table part worked (${report.slice(0, 200)})`);
  note('activated from the side panel: TV and table worked, lights reported failed');

  check(await shows(tv.getByText(CARD).first()), 'tv: the scene\'s card never showed on the players\' screen');
  const disp = (await api('GET', '/fog/table')).json;
  check(disp.pic === PIC, `table display after the scene: ${JSON.stringify(disp)}`);
  // The picture is served through a signed ticket (/api/media/libfile/<base64 payload>.<sig>); the file id is in the payload.
  const onTable = await table.waitForFunction((id) => {
    const m = /\/api\/media\/libfile\/([^."]+)/.exec(document.querySelector('[data-testid=table-map]')?.getAttribute('style') ?? '');
    if (!m) return false;
    try { return atob(m[1].replace(/-/g, '+').replace(/_/g, '/')).includes(id); } catch { return false; }
  }, up.json.id, { timeout: 8000 }).then(() => true, () => false);
  check(onTable, 'table: the scene\'s map never reached the table screen');
  note('players\' screen and table screen followed live');

  // Undo: the card is hidden again and the table goes back.
  await page.getByTestId('scene-undo').click();
  check(await gone(tv.getByText(CARD).first()), 'tv: undo did not take the card away');
  const back = (await api('GET', '/fog/table')).json;
  check(back.pic === before.pic, `undo: table display ${JSON.stringify(back)}, was ${JSON.stringify(before)}`);
  note('undo put the TV and the table back');

  // A player can neither list nor run scenes.
  const pt = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'jess', password: 'player pass 123' }) })).json()).token;
  for (const [m, p] of [['GET', '/scenes'], ['POST', `/scenes/${made.json.id}/activate`]]) {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method: m, headers: { Authorization: `Bearer ${pt}`, 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    check(r.status === 403, `player ${m} ${p}: ${r.status}, wanted 403`);
  }

  // The GM phone's Remote tab has the same button.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.addInitScript((t) => localStorage.setItem('alx.token', t), token);
  const pp = await phone.newPage();
  watch(pp, 'phone');
  await pp.goto(`${W}/dm/phone`);
  await pp.getByRole('tab', { name: /remote/i }).click().catch(() => pp.getByText(/^Remote$/).first().click());
  check(await shows(pp.getByTestId('phone-scene').filter({ hasText: 'Lighthouse' })), 'phone: the scene button is not on the Remote tab');
  note('phone Remote tab lists the scene');
  await phone.close();

  // The Scenes page opens and lists it.
  await page.goto(`${W}/dm/scenes`);
  check(await shows(page.getByText('Lighthouse').first()), 'scenes page: the scene is not listed');
  await ctx.close();
} catch (e) {
  problems.push(`crashed: ${e.stack || e.message}`);
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) { console.log('scenes e2e FAILED:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('scenes e2e ok');
