// End-to-end test of the Foundry VTT connection, with the real module:
// - the GM opens GM → Foundry VTT, copies the manifest URL and makes a key;
// - a stand-in Foundry world (librarian/test/foundry-stub.js) runs the real
//   Alexandria Bridge module with that key, ticking like the GM's tab;
// - the GM brings a scene in as a map, the tokens show on the Map page, fog
//   set in Alexandria reaches Foundry, a player drags their own token on a
//   phone and it moves in Foundry (uncovering fog), and a map goes out to
//   Foundry as a new scene.
// Run from web/: npm run build && node e2e/foundry.mjs   (FOUNDRY_PORT, default 19823)
// FOUNDRY_SHOTS=<dir> also saves screenshots there.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';
import { foundryWorld } from './foundry-world.mjs';

const PORT = Number(process.env.FOUNDRY_PORT || 19823);
const SHOTS = process.env.FOUNDRY_SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) { problems.push(`timed out: ${what}`); return null; }
    await new Promise((r) => setTimeout(r, 250));
  }
};

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('foundry'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const dmLogin = await login('dm', 'game master 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + dmLogin.token } })).json())[0].id;
const api = async (method, p, body, raw) => {
  const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': raw ? 'image/png' : 'application/json', Authorization: 'Bearer ' + dmLogin.token }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}

/** A dungeon map picture, drawn in the browser (rooms, corridors, a grid). */
async function drawMap(page, w, h, seed) {
  return Buffer.from(await page.evaluate(({ w, h, seed }) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    let s = seed; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    g.fillStyle = '#1d1a16'; g.fillRect(0, 0, w, h);
    const rooms = [[0.06, 0.12, 0.26, 0.3], [0.42, 0.08, 0.22, 0.26], [0.72, 0.18, 0.22, 0.34], [0.12, 0.58, 0.3, 0.3], [0.52, 0.56, 0.36, 0.32]];
    g.strokeStyle = '#8a7a5c'; g.lineWidth = w * 0.03;
    g.beginPath(); g.moveTo(w * 0.19, h * 0.27); g.lineTo(w * 0.53, h * 0.21); g.lineTo(w * 0.83, h * 0.35); g.lineTo(w * 0.7, h * 0.72); g.lineTo(w * 0.27, h * 0.73); g.lineTo(w * 0.19, h * 0.27); g.stroke();
    for (const [x, y, rw, rh] of rooms) {
      g.fillStyle = '#c9b78f'; g.fillRect(x * w, y * h, rw * w, rh * h);
      for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(90,70,40,${0.08 + rnd() * 0.12})`; g.fillRect((x + rnd() * rw) * w, (y + rnd() * rh) * h, w * 0.02, h * 0.02); }
      g.strokeStyle = '#3a2f22'; g.lineWidth = 6; g.strokeRect(x * w, y * h, rw * w, rh * h);
    }
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1;
    const step = w / 40;
    for (let x = 0; x <= w; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    return [...atob(c.toDataURL('image/png').split(',')[1])].map((ch) => ch.charCodeAt(0));
  }, { w, h, seed }));
}

let fd = null;
try {
  // ---- the GM sets up ----
  const dmCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const dm = await dmCtx.newPage();
  watch(dm, 'dm');
  await dm.goto(base + '/login');
  await dm.getByLabel(/username/i).fill('dm');
  await dm.getByLabel(/password/i).fill('game master 123');
  await dm.getByRole('button', { name: /sign in|log in/i }).click();
  await dm.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  await dm.goto(`${base}/w/saltreach/dm/foundry`);
  await dm.getByText('Not set up').waitFor();
  const manifest = (await dm.getByTestId('foundry-manifest').textContent()).trim();
  check(manifest === `${base}/api/foundry/module.json`, `manifest URL shown: ${manifest}`);
  const man = await (await fetch(manifest)).json();
  check(man.id === 'alexandria-bridge' && man.download.endsWith('/api/foundry/module.zip'), 'Foundry can install from the manifest');
  await dm.getByRole('button', { name: 'Make a bridge key' }).click();
  const key = (await dm.getByTestId('foundry-key').textContent()).trim();
  check(/^alx_fvtt_/.test(key), `key shown once: ${key}`);
  await shot(dm, '1-dm-setup');
  note('manifest and key');

  // ---- Foundry connects ----
  const keepPng = await drawMap(dm, 1600, 1000, 7);
  fd = foundryWorld(base, key, keepPng);
  await fd.start();
  await until(async () => /Connected to Sunken Realm/.test(await dm.getByTestId('foundry-state').textContent()), 'GM page shows Connected to the Foundry world');
  await dm.getByText('Sunken Keep').first().waitFor();
  check(await dm.getByText('Goblin Warrens').count() > 0, 'every scene listed');
  check((await dm.getByLabel('Player for Jessamine').inputValue()) !== '', 'Jessamine linked to jess by name');
  note('module connected; actors linked by name');

  // ---- bring the scene in ----
  await dm.getByTestId('foundry-scene').filter({ hasText: 'Sunken Keep' }).getByRole('button', { name: 'Bring into Alexandria' }).click();
  await until(async () => (await dm.getByTestId('foundry-scene').filter({ hasText: 'Sunken Keep' }).textContent()).includes('On the map sunken-keep'), 'scene linked to the map sunken-keep');
  await until(async () => /3 tokens/.test(await dm.getByTestId('foundry-scene').filter({ hasText: 'Sunken Keep' }).textContent()), 'three tokens on the map');
  await shot(dm, '2-dm-connected-scene-linked');
  const st = await api('GET', '/foundry');
  const keep = st.scenes.find((s) => s.name === 'Sunken Keep');
  note(`scene brought in as ${keep.pic}`);

  // ---- fog on, the goblin hidden in Foundry's dark ----
  await api('PUT', '/fog/map/sunken-keep/enabled', { pic: keep.pic, enabled: true });
  await api('POST', '/fog/map/sunken-keep/ops', { pic: keep.pic, ops: [{ k: 'r', x: 0.04, y: 0.1, w: 0.3, h: 0.34 }, { k: 'c', x: 0.36, y: 0.27, r: 0.06 }] });
  await until(async () => fd.keep.getFlag('alexandria-bridge', 'fog')?.ops?.length === 2, 'fog reaches Foundry');
  note('fog drawn in Foundry');

  // ---- the GM's map ----
  await dm.goto(`${base}/w/saltreach/dm/map`);
  await dm.getByRole('button', { name: 'sunken-keep' }).click();
  await dm.locator('[data-token]').first().waitFor();
  check(await dm.locator('[data-token]').count() === 3, 'the GM sees all three tokens');
  await shot(dm, '3-dm-map-tokens-and-fog');

  // ---- a player drags their own token on a phone ----
  const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: SHOTS ? 3 : 1 });
  const p = await pCtx.newPage();
  watch(p, 'jess');
  await p.goto(base + '/login');
  await p.getByLabel(/username/i).fill('jess');
  await p.getByLabel(/password/i).fill('player pass 123');
  await p.getByRole('button', { name: /sign in|log in/i }).click();
  await p.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  await p.goto(`${base}/w/saltreach/map`);
  await p.getByRole('button', { name: 'sunken-keep' }).click();
  await p.locator('[data-token]').first().waitFor();
  const labels = await p.locator('[data-token]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  check(labels.length === 2 && !labels.some((l) => /Goblin/.test(l)), `jess sees the party, not the goblin under fog: ${labels}`);
  note(`jess's tokens: ${labels.join(' / ')}`);
  await shot(p, '4-player-map-phone');
  const tok = p.locator('[data-token]').filter({ has: p.locator('text=Jessamine') });
  await p.locator('[role="application"]').scrollIntoViewIfNeeded();
  const box = await tok.boundingBox();
  const area = await p.locator('[role="application"]').boundingBox();
  const fx = fd.jt.x;

  // Drag with the mouse (pointer events) to about 45% across, 35% down.
  await p.mouse.move(box.x + box.width / 2, box.y + 12);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(box.x + box.width / 2 + ((area.x + area.width * 0.45) - (box.x + box.width / 2)) * i / 8, box.y + 12 + ((area.y + area.height * 0.35) - (box.y + 12)) * i / 8);
  await p.mouse.up();
  await until(async () => fd.jt.x !== fx, 'the token moved in Foundry');
  const fog = await api('GET', `/fog/map/sunken-keep?pic=${encodeURIComponent(keep.pic)}`);
  check(fog.ops.length >= 3, `moving uncovered fog (${fog.ops.length} strokes)`);
  await until(async () => fd.keep.getFlag('alexandria-bridge', 'fog')?.ops?.length === fog.ops.length, 'the uncovered fog reaches Foundry');
  await p.waitForTimeout(800);
  await shot(p, '5-player-dragged-token');
  note(`jess dragged her token; Foundry x ${fx} → ${fd.jt.x}`);

  // ---- what players see in Foundry: the scene with Alexandria's fog over it ----
  if (SHOTS) {
    const f = fd.keep.getFlag('alexandria-bridge', 'fog');
    const W = 400, H = 250;
    const px = Array.from(fd.fogPixels(f, W, H, 1));
    const d = fd.keep.dimensions;
    const toks = [...fd.keep.tokens.values()].map((t) => ({ n: t.name, x: (t.x - d.sceneX + 20) / d.sceneWidth, y: (t.y - d.sceneY + 20) / d.sceneHeight, c: t.disposition > 0 ? '#5fb3a8' : '#d06050' }));
    const view = await dmCtx.newPage();
    await view.setViewportSize({ width: 1280, height: 860 });
    await view.setContent(`<!doctype html><body style="margin:0;background:#0b0b0b;font:13px system-ui;color:#ddd"><div style="padding:8px 12px;background:#222;border-bottom:1px solid #444">Stand-in Foundry scene “Sunken Keep”, as a player sees it: Alexandria’s fog drawn by the module</div><div id="b" style="position:relative;width:1280px;height:800px"><img src="data:image/png;base64,${keepPng.toString('base64')}" style="position:absolute;inset:0;width:100%;height:100%"><canvas id="f" width="${W}" height="${H}" style="position:absolute;inset:0;width:100%;height:100%"></canvas></div></body>`);
    await view.evaluate(({ px, W, H, toks }) => {
      const g = document.getElementById('f').getContext('2d');
      const b = document.getElementById('b');
      for (const t of toks) { const e = document.createElement('div'); e.textContent = t.n.split(' ').map((w) => w[0]).join(''); Object.assign(e.style, { position: 'absolute', left: `calc(${t.x * 100}% - 16px)`, top: `calc(${t.y * 100}% - 16px)`, width: '32px', height: '32px', borderRadius: '50%', border: `3px solid ${t.c}`, background: '#222', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }); b.insertBefore(e, b.lastElementChild); }
      g.putImageData(new ImageData(new Uint8ClampedArray(px), W, H), 0, 0);
    }, { px, W, H, toks });
    await shot(view, '6-foundry-player-view');
    await view.close();
  }

  // ---- a map goes out to Foundry as a new scene ----
  const harborPng = await drawMap(dm, 1200, 800, 99);
  const up = await api('POST', '/files?kind=map&level=party&name=harbor.png&title=Harbor%20map', undefined, harborPng);
  await dm.goto(`${base}/w/saltreach/dm/foundry`);
  await dm.getByLabel('Map picture to send').selectOption(`lib:${up.id}`);
  await dm.getByLabel('Scene name').fill('The Harbor');
  await dm.getByRole('button', { name: 'Make the scene' }).click();
  const made = await until(async () => fd.fv.api.game.scenes.find((s) => s.name === 'The Harbor'), 'the scene is made in Foundry');
  if (made) check(fd.fv.files[made.background.src]?.length === harborPng.length, 'with the picture saved in Foundry');
  await until(async () => (await dm.getByTestId('foundry-scene').filter({ hasText: 'The Harbor' }).textContent()).includes('On the map the-harbor'), 'the new scene is linked');
  await shot(dm, '7-dm-map-sent-to-foundry');
  note('map sent to Foundry as a scene');
} catch (e) {
  problems.push(`crashed: ${e.stack ?? e}`);
} finally {
  fd?.stop();
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log('\nFoundry e2e problems:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('\nFoundry e2e: all good');
