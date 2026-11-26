// End-to-end test of the Owlbear Rodeo extension: the real extension pages (web/owlbear, served by the librarian at
// /owlbear/) run inside a stand-in Owlbear Rodeo room. The room is a page served at https://www.owlbear.rodeo (Playwright
// answers for that address) that speaks the Owlbear SDK's message protocol: it frames the extension, keeps the scene's
// items and room metadata, and draws the map and fog on a canvas so the screenshots show what a table would see.
//
// Checked: the DM makes a link key on DM → Setup → Owlbear Rodeo; the GM pastes it in the popover; the table screen's map
// picture lands in the scene with Alexandria's fog on it; a reveal in Alexandria reaches Owlbear; with "Owlbear leads",
// fog drawn with Owlbear's tools comes back to Alexandria (and hides a party pin from players); a player's popover links
// to the world and never gets the key.
// Run from web/: npm run build && node e2e/owlbear.mjs   (OBR_PORT, OBR_SHOTS=folder for screenshots)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.OBR_PORT || 8230);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const OBR = 'https://www.owlbear.rodeo';
const SHOTS = process.env.OBR_SHOTS || '';
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };
const until = async (fn, ms = 10000, step = 200) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await new Promise((r) => setTimeout(r, step)); } };

// ---- the stand-in Owlbear Rodeo room -------------------------------------------------------------------------------
const ROOM_HTML = (ext) => `<!doctype html><html><head><meta charset="utf-8"><title>Owlbear Rodeo (stand-in)</title>
<style>body{margin:0;background:#1e2231;color:#fff;font:14px system-ui;display:grid;grid-template-columns:1fr 380px;height:100vh}
#scene{width:100%;height:100%;display:block} aside{display:flex;flex-direction:column;gap:8px;padding:8px;background:#222639;overflow:auto}
iframe{border:0;width:360px;background:#222639;border-radius:12px} h3{margin:4px 0 0;font-weight:500;color:#bbb}</style></head>
<body><canvas id="scene"></canvas><aside>
<h3>GM: Alexandria</h3><iframe id="gm" style="height:560px"></iframe>
<h3>Player: Alexandria</h3><iframe id="pl" style="height:200px"></iframe>
<iframe id="bg" style="display:none"></iframe></aside>
<script>
const EXT = ${JSON.stringify(ext)};
const ref = btoa(location.origin + ' room-1');
const obr = window.obr = { items: [], roomMeta: {}, filled: false, roles: {}, subs: {}, log: [] };
const frames = { gm: ['GM', 'u-gm', 'Wizard'], pl: ['PLAYER', 'u-pl', 'Jess'], bg: ['GM', 'u-gm', 'Wizard'] };
const byRef = {};
const now = () => new Date().toISOString();
const emit = (kind, id, data) => { for (const [r, s] of Object.entries(obr.subs)) if (s.has(kind)) byRef[r].win.postMessage({ id, data }, '*'); };
const changed = window.obrChanged = () => { emit('items', 'OBR_SCENE_ITEMS_EVENT_CHANGE', { items: obr.items }); draw(); };
const attachments = (ids) => { const out = []; let level = obr.items.filter((i) => ids.includes(i.id)); while (level.length) { const next = obr.items.filter((i) => level.some((p) => p.id === i.attachedTo)); out.push(...level); level = next.filter((n) => !out.includes(n)); } return out; };
window.addEventListener('message', (e) => {
  const m = e.data; if (!m || typeof m.id !== 'string' || !m.ref || !byRef[m.ref]) return;
  const f = byRef[m.ref];
  const reply = (data) => f.win.postMessage({ id: m.id + '_RESPONSE' + (m.nonce || ''), data }, '*');
  obr.log.push(m.id);
  const d = m.data || {};
  switch (m.id) {
    case 'OBR_PLAYER_GET_ROLE': return reply({ role: f.role });
    case 'OBR_PLAYER_GET_NAME': return reply({ name: f.name });
    case 'OBR_PLAYER_GET_ID': return reply({ id: f.user });
    case 'OBR_SCENE_IS_READY': return reply({ ready: true });
    case 'OBR_SCENE_GRID_GET_DPI': return reply({ dpi: 150 });
    case 'OBR_SCENE_FOG_GET_FILLED': return reply({ filled: obr.filled });
    case 'OBR_ROOM_GET_METADATA': return reply({ metadata: obr.roomMeta });
    case 'OBR_ROOM_SET_METADATA': obr.roomMeta = { ...obr.roomMeta, ...d.update }; reply({}); return emit('room', 'OBR_ROOM_METADATA_EVENT_CHANGE', { metadata: obr.roomMeta });
    case 'OBR_THEME_GET_THEME': return reply({ theme: { mode: 'DARK', primary: { light: '#d6c2ff', main: '#bb99ff', dark: '#8a6bcc', contrastText: '#222' }, secondary: { light: '#fff', main: '#ee99ff', dark: '#aa66bb', contrastText: '#222' }, background: { default: '#1e2231', paper: '#222639' }, text: { primary: '#fff', secondary: 'rgba(255,255,255,.7)', disabled: 'rgba(255,255,255,.5)' } } });
    case 'OBR_NOTIFICATION_SHOW': obr.log.push('note:' + d.message); return reply({ id: 'n1' });
    case 'OBR_SCENE_ITEMS_GET_ALL_ITEMS': return reply({ items: obr.items });
    case 'OBR_SCENE_ITEMS_GET_ITEMS': return reply({ items: obr.items.filter((i) => d.ids.includes(i.id)) });
    case 'OBR_SCENE_ITEMS_GET_ITEM_ATTACHMENTS': return reply({ items: attachments(d.ids) });
    case 'OBR_SCENE_ITEMS_ADD_ITEMS': obr.items.push(...d.items.map((i) => ({ ...i, lastModified: now() }))); reply({}); return changed();
    case 'OBR_SCENE_ITEMS_UPDATE_ITEMS': for (const u of d.updates) { const i = obr.items.find((x) => x.id === u.id); if (i) Object.assign(i, u, { lastModified: now() }); } reply({}); return changed();
    case 'OBR_SCENE_ITEMS_DELETE_ITEMS': obr.items = obr.items.filter((i) => !d.ids.includes(i.id)); reply({}); return changed();
    default:
      if (/_SUBSCRIBE$/.test(m.id)) { const kind = /ITEMS/.test(m.id) ? 'items' : /ROOM_METADATA/.test(m.id) ? 'room' : m.id; (obr.subs[m.ref] ||= new Set()).add(kind); return; }
      if (/_UNSUBSCRIBE$/.test(m.id)) return;
      obr.log.push('unknown:' + m.id);
      return reply({});
  }
});
for (const [id, [role, user, name]] of Object.entries(frames)) {
  const el = document.getElementById(id);
  const r = 'ref-' + id;
  byRef[r] = { win: el.contentWindow, role, user, name };
  el.addEventListener('load', () => { byRef[r].win = el.contentWindow; el.contentWindow.postMessage({ id: 'OBR_READY', data: { ref: r, userId: user } }, '*'); });
  el.src = EXT + (id === 'bg' ? '/owlbear/background.html' : '/owlbear/popover.html') + '?obrref=' + encodeURIComponent(ref);
}
// The scene as the GM sees it: the map, then fog at 70% (players would see it solid).
const pics = {};
function pathOf(it) {
  const p = new Path2D();
  if (it.type === 'PATH') for (const c of it.commands) { if (c[0] === 0) p.moveTo(c[1], c[2]); else if (c[0] === 1) p.lineTo(c[1], c[2]); else if (c[0] === 5) p.closePath(); }
  else if (it.type === 'SHAPE') p.rect(0, 0, it.width, it.height);
  return p;
}
function draw() {
  const c = document.getElementById('scene'); c.width = c.clientWidth; c.height = c.clientHeight;
  const g = c.getContext('2d'); g.fillStyle = '#1e2231'; g.fillRect(0, 0, c.width, c.height);
  const map = obr.items.find((i) => i.type === 'IMAGE');
  const fit = map ? Math.min((c.width - 40) / (map.image.width * 150 / map.grid.dpi), (c.height - 40) / (map.image.height * 150 / map.grid.dpi)) : 1;
  const T = (it) => { g.setTransform(fit, 0, 0, fit, 20, 20); g.translate(it.position.x, it.position.y); g.rotate(it.rotation * Math.PI / 180); g.scale(it.scale.x, it.scale.y); };
  for (const it of obr.items.filter((i) => i.type === 'IMAGE')) {
    const im = pics[it.image.url] ||= Object.assign(new Image(), { src: it.image.url, onload: draw });
    if (im.complete && im.naturalWidth) { T(it); const k = 150 / it.grid.dpi; g.drawImage(im, -it.grid.offset.x * k, -it.grid.offset.y * k, it.image.width * k, it.image.height * k); }
  }
  for (const it of obr.items.filter((i) => i.layer === 'FOG' && i.visible !== false)) { T(it); g.globalAlpha = 0.7; g.fillStyle = '#222'; g.fill(pathOf(it), it.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'); g.globalAlpha = 1; }
  g.setTransform(1, 0, 0, 1, 0, 0);
}
</script></body></html>`;

// Is the scene point (in the picture's own 0..1) under the extension's or the GM's fog? Rectangles and simple shapes only.
const foggedAt = (page, u, v) => page.evaluate(({ u, v }) => {
  const o = window.obr; const map = o.items.find((i) => i.type === 'IMAGE');
  if (!map) return null;
  const k = 150 / map.grid.dpi;
  const x = map.position.x + u * map.image.width * k * map.scale.x, y = map.position.y + v * map.image.height * k * map.scale.y;
  const c = document.createElement('canvas').getContext('2d');
  return o.items.filter((i) => i.layer === 'FOG' && i.visible !== false).some((it) => {
    const p = new Path2D();
    if (it.type === 'PATH') for (const cmd of it.commands) { if (cmd[0] === 0) p.moveTo(cmd[1], cmd[2]); else if (cmd[0] === 1) p.lineTo(cmd[1], cmd[2]); else if (cmd[0] === 5) p.closePath(); }
    else p.rect(0, 0, it.width, it.height);
    c.setTransform(1, 0, 0, 1, 0, 0); c.translate(it.position.x, it.position.y); c.rotate(it.rotation * Math.PI / 180); c.scale(it.scale.x, it.scale.y);
    return c.isPointInPath(p, x, y, it.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
  });
}, { u, v });

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('owlbear'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
// Chrome blocks a public site (Owlbear) from framing or fetching a local address unless the user allows it; this test allows it.
const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] });
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !(who === 'owlbear' && /status of 401/.test(m.text()))) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
};

try {
  // ---- 1. Alexandria: a party map on the table screen, fog on with a room revealed ------------------------------------
  const { page } = await signIn(browser, base, 'dm', 'dungeon master 123', { width: 1400, height: 900 }, false, /\/w\/saltreach/);
  watch(page, 'dm');
  const token = await page.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body, raw) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, body: raw ? raw : body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 500;
    const g = c.getContext('2d');
    g.fillStyle = '#5b7d4a'; g.fillRect(0, 0, 800, 500);
    g.fillStyle = '#c9a86a'; g.fillRect(60, 220, 680, 60); g.fillRect(370, 40, 60, 420);
    g.fillStyle = '#7a4b2a'; for (const [x, y] of [[120, 120], [560, 110], [150, 330], [600, 340]]) g.fillRect(x, y, 90, 70);
    g.fillStyle = '#3b6ea5'; g.beginPath(); g.arc(400, 250, 50, 0, 7); g.fill();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const b of buf) s += String.fromCharCode(b); return btoa(s);
  });
  const up = await api('POST', `/files?${new URLSearchParams({ name: 'crossroads.png', folder: 'Maps', title: 'Crossroads', level: 'party', kind: 'map' })}`, undefined, Buffer.from(png, 'base64'));
  check(up.status === 201, `map upload: ${up.status} ${JSON.stringify(up.json)}`);
  const PIC = `lib:${up.json.id}`;
  await api('PUT', '/fog/table', { mapId: 'world', pic: PIC });
  await api('PUT', '/fog/map/world/enabled', { pic: PIC, enabled: true });
  await api('POST', '/fog/map/world/ops', { pic: PIC, op: { k: 'c', x: 0.5, y: 0.5, r: 0.12, v: 1 } });

  // ---- 2. DM → Setup → Owlbear Rodeo: the address and a link key ----------------------------------------------------------
  await page.goto(`${W}/dm/owlbear`);
  await page.getByTestId('owlbear-page').waitFor({ timeout: 8000 });
  const manifest = await page.getByTestId('owlbear-manifest').innerText();
  check(manifest === `${base}/owlbear/manifest.json`, `manifest address: ${manifest}`);
  check((await page.getByTestId('owlbear-online').innerText()).includes('Not set up'), 'dm page: not set up before a key');
  await page.getByRole('button', { name: 'Make a link key' }).click();
  const key = await (await page.getByTestId('owlbear-key').elementHandle()).innerText();
  check(/^alx_obr_/.test(key), `a link key is shown: ${key}`);
  const mf = await (await fetch(`${base}/owlbear/manifest.json`)).json();
  check(mf.action?.popover === '/owlbear/popover.html' && mf.background_url === '/owlbear/background.html', 'manifest points at the two pages');

  // ---- 3. The Owlbear room: the GM pastes the key ------------------------------------------------------------------------
  const room = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  watch(room, 'owlbear');
  await room.route(`${OBR}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: ROOM_HTML(base) }));
  await room.goto(`${OBR}/room/room-1`);
  const gm = room.frameLocator('#gm');
  const pl = room.frameLocator('#pl');
  await gm.getByTestId('obr-key').waitFor({ timeout: 10000 });
  check(await pl.getByText('not linked to an Alexandria world yet').isVisible().catch(() => false), 'player popover: not linked yet');
  await gm.getByTestId('obr-key').fill('alx_obr_wrong');
  await gm.getByRole('button', { name: 'Link' }).click();
  check(await gm.getByRole('alert').waitFor({ timeout: 5000 }).then(() => true, () => false), 'a wrong key is refused in the popover');
  await gm.getByTestId('obr-key').fill(key);
  await gm.getByRole('button', { name: 'Link' }).click();
  await gm.getByTestId('obr-world').waitFor({ timeout: 8000 });
  note(`linked to ${await gm.getByTestId('obr-world').innerText()}`);

  // The map picture arrives, then Alexandria's fog on it, attached and locked.
  const scene = () => room.evaluate(() => window.obr.items.map((i) => ({ id: i.id, type: i.type, layer: i.layer, url: i.image?.url, w: i.image?.width, attachedTo: i.attachedTo, locked: i.locked, meta: Object.keys(i.metadata || {}) })));
  const items = await until(async () => { const s = await scene(); return s.some((i) => i.type === 'IMAGE') && s.some((i) => i.layer === 'FOG') ? s : null; }, 15000);
  check(!!items, `the scene got a map and fog: ${JSON.stringify(await scene())}`);
  const img = (items || []).find((i) => i.type === 'IMAGE');
  const fog = (items || []).find((i) => i.layer === 'FOG');
  check(img && img.layer === 'MAP' && img.w === 800 && img.url.startsWith(`${base}/api/owlbear/pic/`), `the map picture item: ${JSON.stringify(img)}`);
  check(fog && fog.attachedTo === img?.id && fog.locked === true, `the fog is attached to the map and locked: ${JSON.stringify(fog)}`);
  check((await foggedAt(room, 0.05, 0.05)) === true && (await foggedAt(room, 0.5, 0.5)) === false, 'Owlbear: corner fogged, revealed room clear');
  check(await until(() => pl.getByText('This table plays in').isVisible().catch(() => false), 8000), 'player popover: shows the linked world');
  const openHref = await pl.getByRole('link', { name: 'Open Alexandria' }).getAttribute('href').catch(() => null);
  check(openHref === `${base}/w/saltreach`, `player popover links to the world: ${openHref}`);
  const meta = await room.evaluate(() => JSON.stringify(window.obr.roomMeta));
  check(!meta.includes('alx_obr_'), 'the key is never put in the room, where players could read it');
  await room.waitForTimeout(600);
  await shot(room, '1-owlbear-alexandria-leads.png');

  // ---- 4. A reveal in Alexandria reaches Owlbear --------------------------------------------------------------------------
  await api('POST', '/fog/map/world/ops', { pic: PIC, op: { k: 'r', x: 0.05, y: 0.05, w: 0.25, h: 0.3, v: 1 } });
  check(await until(async () => (await foggedAt(room, 0.15, 0.15)) === false, 8000), 'Owlbear follows a reveal made in Alexandria');
  check((await room.evaluate(() => window.obr.items.filter((i) => i.layer === 'FOG').length)) === 1, 'still one fog shape, updated in place');
  const dmPage = await until(async () => { await page.reload(); return (await page.getByTestId('owlbear-online').innerText()).includes('Connected') ? true : null; }, 8000, 800);
  check(!!dmPage, 'dm page: the extension shows as connected');
  await shot(page, '2-dm-owlbear-page.png');

  // ---- 5. Owlbear leads: the GM's own fog comes back to Alexandria ----------------------------------------------------------
  await api('POST', '/map/world/marks', { kind: 'pin', x: 85, y: 50, label: 'ZZ-OBR-HIDDEN', visibility: 'party' });
  await gm.getByTestId('obr-lead-owlbear').click();
  // The extension hands its fog over as a plain Owlbear fog shape, unlocked, so the GM can cut it with Owlbear's tools.
  check(await until(async () => (await scene()).some((i) => i.layer === 'FOG' && !i.meta.length && !i.locked), 8000), `handed over: ${JSON.stringify(await scene())}`);
  const before = (await api('GET', `/fog/map/world?pic=${encodeURIComponent(PIC)}`)).json.version;
  // The GM replaces it with Owlbear fog over the right half only (as drawing with the fog tool would).
  await room.evaluate(() => {
    const o = window.obr; const map = o.items.find((i) => i.type === 'IMAGE'); const k = 150 / map.grid.dpi;
    o.items = o.items.filter((i) => i.layer !== 'FOG');
    o.items.push({ id: 'gm-fog-1', type: 'SHAPE', shapeType: 'RECTANGLE', layer: 'FOG', name: 'Fog', visible: true, locked: false, position: { x: map.position.x + map.image.width * k / 2, y: map.position.y }, rotation: 0, scale: { x: 1, y: 1 }, width: map.image.width * k / 2, height: map.image.height * k, metadata: {}, style: {} });
    window.obrChanged();
  });
  const after = await until(async () => { const f = (await api('GET', `/fog/map/world?pic=${encodeURIComponent(PIC)}`)).json; return f.version > before ? f : null; }, 10000);
  check(!!after, 'Owlbear fog reached Alexandria');
  const cells = await (await fetch(`${base}/api/owlbear/fog?cols=40&rows=25`, { headers: { Authorization: `Bearer ${key}` } })).json();
  const inRect = (u, v) => cells.rects.some(([x, y, w, h]) => u * 40 >= x && u * 40 < x + w && v * 25 >= y && v * 25 < y + h);
  check(!inRect(0.25, 0.5) && inRect(0.75, 0.5), "Alexandria's fog is now Owlbear's: left clear, right fogged");
  const jess = await signIn(browser, base, 'jess', 'player pass 123', { width: 1200, height: 800 }, false, /\/w\/saltreach/);
  const jt = await jess.page.evaluate(() => localStorage.getItem('alx.token'));
  const marks = await (await fetch(`${base}/api/worlds/saltreach/map/world/marks`, { headers: { Authorization: `Bearer ${jt}` } })).json();
  check(!JSON.stringify(marks).includes('ZZ-OBR-HIDDEN'), 'a party pin under Owlbear fog is not sent to a player');
  await room.waitForTimeout(400);
  await shot(room, '3-owlbear-leads.png');

  // ---- 6. Back to Alexandria leads, and the extension's pages stay framable only by Owlbear --------------------------------
  await gm.getByTestId('obr-lead-alexandria').click();
  await gm.getByRole('button', { name: "Clear Owlbear's fog" }).click();
  check(await until(async () => { const s = await scene(); return s.filter((i) => i.layer === 'FOG').every((i) => i.meta.length) ? true : null; }, 8000), "clearing Owlbear's fog leaves only Alexandria's");
  const hdr = await fetch(`${base}/owlbear/popover.html`);
  check(hdr.status === 200 && /frame-ancestors https:\/\/www\.owlbear\.rodeo/.test(hdr.headers.get('content-security-policy') || '') && !hdr.headers.get('x-frame-options'), 'popover page may be framed by Owlbear only');
  const unknown = await room.evaluate(() => window.obr.log.filter((l) => l.startsWith('unknown:')));
  check(!unknown.length, `the extension only used calls the stand-in knows: ${unknown.join(', ')}`);
} catch (e) {
  problems.push(`crashed: ${e.stack || e}`);
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.error(`owlbear e2e: ${problems.length} problem(s)`); for (const p of problems) console.error(' - ' + p); process.exit(1); }
console.log('owlbear e2e: ok');
