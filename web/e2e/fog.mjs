// End-to-end test of fog of war and the table display, on the demo world: the GM turns fog on from the Map page and shows the
// map on the table; from the side screen's fog panel the GM reveals a room, and the table screen (and a player's own Map page)
// update live. A party pin inside fog is never in the table screen, whatever the page does; the picture never shows before its
// fog is drawn.
// Run from web/: npm run build && node e2e/fog.mjs   (FOG_PORT)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.FOG_PORT || 8210);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('fog'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
};
const shows = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
const settle = (page, ms = 600) => page.waitForTimeout(ms);

const SECRET = 'ZZ-FOGGED-PARTY-PIN';
/** Alpha (0..255) of the fog canvas at a point given as fractions of the map, or null when there is no fog canvas. */
const alphaAt = (page, scope, x, y) => page.evaluate(({ scope, x, y }) => {
  const c = document.querySelector(`${scope} [data-testid=fog-canvas]`);
  if (!c) return null;
  return c.getContext('2d').getImageData(Math.min(c.width - 1, Math.floor(x * c.width)), Math.min(c.height - 1, Math.floor(y * c.height)), 1, 1).data[3];
}, { scope, x, y });
const waitAlpha = async (page, scope, x, y, want, ms = 8000) => {
  const t0 = Date.now();
  let a = null;
  while (Date.now() - t0 < ms) {
    a = await alphaAt(page, scope, x, y);
    if (want === 'clear' ? a === 0 : a === 255) return true;
    await page.waitForTimeout(150);
  }
  problems.push(`${scope} at ${x},${y}: fog alpha is ${a}, wanted ${want}`);
  return false;
};
/** Drag across a box (fractions of it) with the mouse. */
const drag = async (page, loc, [x0, y0], [x1, y1]) => {
  const b = await loc.boundingBox();
  await page.mouse.move(b.x + b.width * x0, b.y + b.height * y0);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * ((x0 + x1) / 2), b.y + b.height * ((y0 + y1) / 2), { steps: 4 });
  await page.mouse.move(b.x + b.width * x1, b.y + b.height * y1, { steps: 4 });
  await page.mouse.up();
};

try {
  const { ctx, page } = await signIn(browser, base, 'dm', 'game master 123', { width: 1400, height: 900 }, false, /\/w\/saltreach/);
  watch(page, 'dm');
  const token = await page.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body, raw) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, body: raw ? raw : body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  // A map picture of our own (a PNG drawn in the page), shared with the party, and two party pins: one in the open, one to be hidden by fog.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 250;
    const g = c.getContext('2d');
    g.fillStyle = '#2d6a4f'; g.fillRect(0, 0, 400, 250);
    g.fillStyle = '#d4a373'; g.fillRect(260, 20, 120, 80);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });
  const up = await api('POST', `/files?${new URLSearchParams({ name: 'fogcave.png', folder: 'Maps', title: 'Fog cave', level: 'party', kind: 'map' })}`, undefined, Buffer.from(png, 'base64'));
  check(up.status === 201, `map upload: ${up.status} ${JSON.stringify(up.json)}`);
  const PIC = `lib:${up.json.id}`;
  await api('POST', '/map/world/marks', { kind: 'pin', x: 15, y: 70, label: 'Open Pin', visibility: 'party' });
  await api('POST', '/map/world/marks', { kind: 'pin', x: 80, y: 20, label: SECRET, visibility: 'party' });
  // Make the cave the GM's own pick on the Map page too, so the GM page and the table agree.
  await page.evaluate(({ id, pic }) => { localStorage.setItem(`alx.mapbg.${id}`, JSON.stringify({ world: pic })); }, { id: (await api('GET', '')).json.id, pic: PIC });

  // ---- 1. the GM's Map page: fog is off until turned on, then everything is fogged ---------------------------------------
  await page.goto(`${W}/dm/map`);
  await page.getByTestId('map-fog').waitFor({ timeout: 8000 });
  check(await shows(page.getByText(SECRET).first(), 3000) || (await page.locator('[data-mark]').count()) >= 2, 'dm map: the GM sees both pins with fog off');
  check((await page.getByTestId('fog-canvas').count()) === 0, 'dm map: no fog canvas while fog is off');
  await page.getByTestId('fog-toggle').click();
  await page.getByTestId('fog-canvas').waitFor({ timeout: 8000 });
  const tinted = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=fog-canvas]')).opacity);
  check(Number(tinted) < 1, `dm map: the GM sees fog as a tint (opacity ${tinted})`);
  check((await alphaAt(page, '', 0.5, 0.5)) === 255, 'dm map: turning fog on starts fully fogged');
  await page.getByTestId('show-on-table').click();
  await settle(page, 500);
  const disp = (await api('GET', '/fog/table')).json;
  check(disp.pic === PIC && disp.mapId === 'world', `the table display is ${JSON.stringify(disp)}`);

  // ---- 2. the table screen: fogged and without the pin ----------------------------------------------------------------
  const table = await ctx.newPage();
  watch(table, 'table');
  await table.setViewportSize({ width: 1600, height: 900 });
  // No flash: from the first frame, the picture is never there without its fog over the fogged spot.
  await table.addInitScript(() => {
    window.__flash = [];
    const tick = () => {
      if (window.__stop) return;
      const m = document.querySelector('[data-testid=table-map]');
      if (m && /url\(/.test(m.style.background || m.style.backgroundImage || '')) {
        const c = m.querySelector('[data-testid=fog-canvas]');
        const a = c ? c.getContext('2d').getImageData(Math.floor(c.width * 0.5), Math.floor(c.height * 0.5), 1, 1).data[3] : -1;
        if (a !== 255) window.__flash.push(a);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await table.goto(`${W}/screen/table`);
  await table.getByTestId('table-map').waitFor({ timeout: 8000 });
  await table.locator('[data-testid=table-map] [data-testid=fog-canvas]').waitFor({ timeout: 8000 });
  await settle(table, 800);
  await waitAlpha(table, '[data-testid=table-map]', 0.8, 0.2, 'fogged');
  const picShown = await table.evaluate(() => /url\(/.test(document.querySelector('[data-testid=table-map]').style.background));
  check(picShown, 'table: the GM\'s picture is on the table');
  await settle(table, 800);
  await table.evaluate(() => { window.__stop = true; });
  const tableHtml = async () => table.evaluate(() => document.documentElement.outerHTML + document.body.innerText);
  check(!(await tableHtml()).includes(SECRET), 'table: the fogged pin is not on the page');
  check((await table.locator('[data-testid=table-map] [data-mark]').count()) === 0, 'table: with everything fogged no pin shows at all');
  const tOpacity = await table.evaluate(() => getComputedStyle(document.querySelector('[data-testid=fog-canvas]')).opacity);
  check(Number(tOpacity) === 1, `table: fog is solid for players (opacity ${tOpacity})`);

  // ---- 3. a player's own Map page has the same fog -----------------------------------------------------------------------
  const jess = await signIn(browser, base, 'jess', 'player pass 123', { width: 1280, height: 800 }, false, /\/w\/saltreach/);
  watch(jess.page, 'jess');
  await jess.page.goto(`${W}/map`);
  await jess.page.evaluate(({ pic }) => { const id = Object.keys(localStorage).find((k) => k.startsWith('alx.maps.'))?.slice('alx.maps.'.length); if (id) localStorage.setItem(`alx.mapbg.${id}`, JSON.stringify({ world: pic })); }, { pic: PIC });
  await jess.page.reload();
  await jess.page.locator('[role=application] [data-testid=fog-canvas]').waitFor({ timeout: 8000 });
  await waitAlpha(jess.page, '[role=application]', 0.8, 0.2, 'fogged');
  check(!(await jess.page.evaluate(() => document.documentElement.outerHTML)).includes(SECRET), 'player: the fogged pin is not on her map page');
  check(await jess.page.getByTestId('fog-toggle').count() === 0, 'player: no fog controls');

  // ---- 4. the side screen: reveal a room from the fog panel, the table follows live ------------------------------------------
  const side = await ctx.newPage();
  watch(side, 'side');
  await side.setViewportSize({ width: 1080, height: 1920 });
  await side.goto(`${W}/screen/side`);
  await side.getByTestId('side-screen').waitFor({ timeout: 8000 });
  await side.getByTestId('side-choose').click();
  if (!(await side.getByTestId('side-panel-fog').count())) await side.getByTestId('side-toggle-fog').click();
  const panel = side.getByTestId('side-panel-fog');
  await panel.getByTestId('fog-map').waitFor({ timeout: 8000 });
  await panel.locator('[data-testid=fog-canvas]').waitFor({ timeout: 8000 });
  await waitAlpha(side, '[data-testid=side-panel-fog]', 0.8, 0.2, 'fogged');
  check(Number(await side.evaluate(() => getComputedStyle(document.querySelector('[data-testid=side-panel-fog] [data-testid=fog-canvas]')).opacity)) < 1, 'side: fog is a tint for the GM');
  check(await panel.getByText('Fog on').isVisible(), 'side: the panel shows the same map with fog on');
  // Circle brush at the pin's spot.
  await panel.getByTestId('fog-size').fill('0.1');
  await drag(side, panel.getByTestId('fog-draw'), [0.8, 0.2], [0.82, 0.22]);
  await waitAlpha(table, '[data-testid=table-map]', 0.8, 0.2, 'clear');
  await waitAlpha(side, '[data-testid=side-panel-fog]', 0.8, 0.2, 'clear');
  check(await shows(table.getByText(SECRET).first(), 6000) || (await table.locator('[data-testid=table-map] [data-mark]').count()) >= 2, 'table: the pin appears once its room is uncovered');
  await waitAlpha(table, '[data-testid=table-map]', 0.1, 0.9, 'fogged');
  // Undo takes the whole stroke back, and the pin goes with it.
  await panel.getByTestId('fog-undo').click();
  await waitAlpha(table, '[data-testid=table-map]', 0.8, 0.2, 'fogged');
  await settle(table, 500);
  check(!(await tableHtml()).includes(SECRET), 'table: after undo the fogged pin is gone from the page again');
  // Rectangle tool, then reveal all and hide all.
  await panel.getByTestId('fog-tool-rect').click();
  await drag(side, panel.getByTestId('fog-draw'), [0.05, 0.6], [0.3, 0.95]);
  await waitAlpha(table, '[data-testid=table-map]', 0.15, 0.8, 'clear');
  await waitAlpha(table, '[data-testid=table-map]', 0.8, 0.2, 'fogged');
  check(await shows(table.getByText('Open Pin').first(), 6000) || (await table.locator('[data-testid=table-map] [data-mark]').count()) === 1, 'table: the pin in the uncovered corner shows, the other stays away');
  check(!(await tableHtml()).includes(SECRET), 'table: the pin outside the uncovered corner is still not on the page');
  await panel.getByTestId('fog-reveal-all').click();
  await waitAlpha(table, '[data-testid=table-map]', 0.5, 0.5, 'clear');
  await panel.getByTestId('fog-hide-all').click();
  await waitAlpha(table, '[data-testid=table-map]', 0.5, 0.5, 'fogged');
  check(!(await tableHtml()).includes(SECRET), 'table: still no fogged pin after hide all');
  note('reveal and hide from the side panel follow live on the table screen');

  // The player's map follows too (her marks come back when the room opens).
  await panel.getByTestId('fog-reveal-all').click();
  await waitAlpha(jess.page, '[role=application]', 0.8, 0.2, 'clear');
  await panel.getByTestId('fog-hide-all').click();
  await waitAlpha(jess.page, '[role=application]', 0.8, 0.2, 'fogged');

  // Changing the picture from the panel changes the table screen: blank map has no picture and no fog of its own.
  await panel.getByTestId('fog-pic-select').selectOption('none');
  await table.waitForFunction(() => !/url\(/.test(document.querySelector('[data-testid=table-map]').style.background), null, { timeout: 8000 }).catch(() => problems.push('table: choosing "Blank map" in the panel did not change the table'));
  await panel.getByTestId('fog-pic-select').selectOption(PIC);
  await waitAlpha(table, '[data-testid=table-map]', 0.5, 0.5, 'fogged');

  // Nothing flashed unfogged at any frame; every table read asked for the players' copy.
  const flashes = await table.evaluate(() => window.__flash);
  check(flashes.length === 0, `table: the picture showed without its fog on ${flashes.length} frames (${flashes.slice(0, 5)})`);
  // The server's own answer for the table's read agrees.
  const asTable = (await api('GET', '/map/world/marks?view=players')).json;
  check(!JSON.stringify(asTable).includes(SECRET), 'server: ?view=players has no fogged pin');
  note('table screen, player map and side panel agree on the fog; nothing flashed');
  await ctx.close();
  await jess.ctx.close();
} catch (e) {
  problems.push('flow failed: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('fog e2e ok');
