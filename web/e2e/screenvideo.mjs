// End-to-end test of video on the players' screen: a tiny WebM is recorded in the browser (MediaRecorder on a canvas, nothing
// binary checked in), uploaded to the library, loaded as a mixed folder slideshow, and played on the screen: the slideshow
// moves on when the video ends, sound is on by default, the "Click to start" overlay shows when the browser blocks sound (and
// is gone when autoplay is allowed), GM-only files can be shown and shared from the GM page, and Range requests work.
// Run from web/: npm run build && node e2e/screenvideo.mjs   (SCREENVIDEO_PORT)
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.SCREENVIDEO_PORT || 8203);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('screenvideo'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
// Two browsers: one that allows autoplay with sound (like the desktop app) and one with the normal policy.
const open = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const normal = await chromium.launch({ args: ['--autoplay-policy=document-user-activation-required'] });
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/youtube|iframe_api|ERR_/i.test(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
};
const shows = (loc, ms = 8000) => loc.waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);

/** A short WebM made in the page: a canvas that changes colour, recorded for `ms`. Returned as base64. */
const recordWebm = (page, ms, hue) => page.evaluate(async ({ ms, hue }) => {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  const stream = c.captureStream(15);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start(100);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const draw = () => {
      const t = performance.now() - t0;
      g.fillStyle = `hsl(${(hue + t / 8) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 90);
      g.fillStyle = '#fff'; g.fillRect((t / 10) % 140, 30, 20, 30);
      if (t < ms) requestAnimationFrame(draw); else resolve();
    };
    draw();
  });
  rec.stop();
  await done;
  const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}, { ms, hue });

try {
  const { ctx, page } = await signIn(open, base, 'dm', 'game master 123', { width: 1280, height: 800 }, false, /\/w\/saltreach/);
  watch(page, 'dm');
  const token = await page.evaluate(() => localStorage.getItem('alx.token'));
  const api = async (method, p, body, raw) => {
    const r = await fetch(`${base}/api/worlds/saltreach${p}`, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, body: raw ? raw : body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const put = (name, folder, title, level, bytes) => api('POST', `/files?${new URLSearchParams({ name, folder, title, level })}`, undefined, bytes);

  const v1 = Buffer.from(await recordWebm(page, 1500, 0), 'base64');
  const v2 = Buffer.from(await recordWebm(page, 1500, 180), 'base64');
  check(v1.length > 500 && v1[0] === 0x1a && v1[1] === 0x45, 'the browser should produce a WebM');
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const up1 = await put('a-intro.webm', 'Clips', 'Clip A', 'party', v1);
  const up2 = await put('c-outro.webm', 'Clips', 'Clip C', 'party', v2);
  const upg = await put('b-spark.gif', 'Clips', 'Spark', 'party', GIF);
  const dmOnly = await put('secret.webm', 'Private', 'Secret clip', 'dm', v1);
  check([up1, up2, upg, dmOnly].every((u) => u.status === 201), `uploads: ${[up1, up2, upg, dmOnly].map((u) => u.status)} ${JSON.stringify(up1.json)}`);
  check(up1.json?.family === 'video' && up1.json?.mime === 'video/webm', 'a recorded WebM should be sniffed as video/webm');

  // Range request from the browser, the way a <video> seeks.
  const range = await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Range: 'bytes=0-9' } });
    return { status: r.status, cr: r.headers.get('content-range'), type: r.headers.get('content-type'), len: (await r.arrayBuffer()).byteLength };
  }, `${base}${up1.json.url}`);
  check(range.status === 206 && range.len === 10 && /^bytes 0-9\//.test(range.cr) && range.type === 'video/webm', `range response: ${JSON.stringify(range)}`);

  // A folder of mixed files loads in file-name order: video, GIF, video.
  const loaded = (await api('POST', '/screen/media/folder', { folder: 'Clips', intervalSec: 3 })).json;
  check(loaded?.items?.map((i) => `${i.kind}`).join() === 'video,image,video', `folder order: ${loaded?.items?.map((i) => i.kind + ':' + i.title)}`);
  const ids = loaded.items.map((i) => i.id);
  const current = async () => (await api('GET', '/screen/players')).json.media.current?.id;

  // ---- positive path: autoplay allowed (like the desktop app) ----
  const tv = await ctx.newPage();
  watch(tv, 'tv');
  await tv.goto(`${W}/screen/players`);
  const vid = tv.getByTestId('screen-video');
  check(await shows(vid), 'the first video should be on the screen');
  check(!(await tv.getByTestId('unlock-sound').isVisible().catch(() => false)), 'no click overlay when autoplay with sound is allowed');
  await tv.waitForFunction(() => { const v = document.querySelector('[data-testid=screen-video]'); return v && !v.paused && v.currentTime > 0; }, null, { timeout: 8000 }).catch(() => problems.push('the video should be playing'));
  const state = await tv.evaluate(() => { const v = document.querySelector('[data-testid=screen-video]'); return v ? { muted: v.muted, loop: v.loop, paused: v.paused } : null; });
  check(state && !state.muted && !state.loop, `sound should be on by default: ${JSON.stringify(state)}`);
  check(await current() === ids[0], 'the server says the first clip is current');
  // It ends, so the slideshow moves to the GIF (a plain <img>, animated by the browser), without waiting for the 3 s interval of a picture.
  const t0 = Date.now();
  await tv.waitForFunction(() => document.querySelector('.ps-media img'), null, { timeout: 9000 }).catch(() => problems.push('the slideshow should move on to the GIF when the first video ends'));
  check(Date.now() - t0 < 8000, 'the slideshow should advance when the video ends');
  check(await current() === ids[1], 'the server moved on to the GIF');
  const gif = await tv.locator('.ps-media img').getAttribute('src');
  const gifType = await tv.evaluate(async (u) => (await fetch(u)).headers.get('content-type'), gif);
  check(gifType === 'image/gif', `the GIF is served as is: ${gifType}`);
  // The GIF stays its interval (3 s), then the next video starts and plays to its end, then the slideshow loops to the first.
  await tv.getByTestId('screen-video').waitFor({ timeout: 10000 }).catch(() => problems.push('after the GIF the second video should play'));
  check(await current() === ids[2], 'the second video is current after the GIF interval');
  await tv.waitForFunction(() => document.querySelector('.ps-media img') === null && document.querySelector('[data-testid=screen-video]'), null, { timeout: 12000 }).catch(() => {});
  const loopedTo = await (async () => { for (let i = 0; i < 40; i++) { if (await current() === ids[0]) return true; await new Promise((r) => setTimeout(r, 300)); } return false; })();
  check(loopedTo, 'when the last video ends the slideshow loops to the first');
  note('mixed folder: video, GIF, video advance on end / interval and loop');

  // Muted video: the per-item sound setting.
  await api('PATCH', `/screen/media/items/${ids[0]}`, { sound: false });
  await tv.waitForFunction(() => { const v = document.querySelector('[data-testid=screen-video]'); return v && v.muted; }, null, { timeout: 8000 }).catch(() => problems.push('a video set to no sound should be muted'));
  await api('PATCH', `/screen/media/items/${ids[0]}`, { sound: true, loopVideo: true });
  await tv.waitForFunction(() => { const v = document.querySelector('[data-testid=screen-video]'); return v && v.loop; }, null, { timeout: 8000 }).catch(() => problems.push('a looping video should loop'));
  note('per-item sound and loop reach the screen');
  await tv.close();

  // ---- GM-only video: shown by the GM's choice, then shared from the GM page ----
  const sec = (await api('GET', '/screen/media/sources')).json.files.find((f) => f.name === 'secret.webm');
  check(sec && sec.shared === false && sec.blocked === false, 'the GM-only video is listed as not shared');
  await api('POST', '/screen/media/clear', {});
  const shown = await api('POST', '/screen/media/items', { kind: 'video', ref: sec.id, play: true, loopVideo: true });
  check(shown.status === 201, `a GM-only video can be queued: ${shown.status}`);
  await page.goto(`${W}/gm/screen-players`);
  check(await shows(page.getByRole('button', { name: /^Share secret.webm with the party$/ })), 'the GM page offers Share with party for a GM-only file');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: /^Share secret.webm with the party$/ }).click();
  await page.getByRole('button', { name: /^Share secret.webm with the party$/ }).waitFor({ state: 'detached', timeout: 8000 }).catch(() => problems.push('the Share button should go once the file is shared'));
  check((await api('GET', '/screen/media/sources')).json.files.find((f) => f.id === sec.id)?.shared === true, 'the file is shared after the button');
  check(await shows(page.locator('.psc video').first()), 'the GM page shows a video thumbnail');
  note('GM-only video shown, then shared from the GM page');
  await api('POST', '/screen/media/clear', {});

  // ---- the browser's normal policy: one click unlocks sound ----
  // A fresh browser context with the GM's token already stored: no click has happened on this page, as on a TV that was just switched on.
  const ctx2 = await normal.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx2.addInitScript((t) => { try { localStorage.setItem('alx.token', t); } catch { /* blocked */ } }, token);
  const tv2 = await ctx2.newPage();
  watch(tv2, 'tv2');
  await api('POST', '/screen/media/folder', { folder: 'Clips', intervalSec: 3 });
  await tv2.goto(`${W}/screen/players`);
  // Do not poll the page yet: Playwright's own evaluations count as a user gesture and would unlock the autoplay probe.
  await tv2.waitForTimeout(2500);
  const overlay = tv2.getByTestId('unlock-sound');  if (check(await shows(overlay), 'the "Click to start" overlay should show when the browser blocks sound')) {
    check(/Click to start the players/.test(await overlay.innerText()), 'the overlay says what to click');
    await overlay.click();
    check(!(await overlay.isVisible().catch(() => false)), 'the overlay goes after the click');
    await tv2.getByTestId('screen-video').waitFor({ timeout: 8000 }).catch(() => problems.push('the video shows after unlocking'));
    await tv2.waitForFunction(() => { const v = document.querySelector('[data-testid=screen-video]'); return v && !v.paused && !v.muted; }, null, { timeout: 8000 }).catch(() => problems.push('after the click the video should play with sound'));
    note('overlay shown under the normal autoplay policy; the click unlocks sound');
  }
  await ctx2.close();
  await ctx.close();
} catch (e) {
  problems.push('flow failed: ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | '));
} finally {
  await open.close();
  await normal.close();
  srv.kill();
}
if (problems.length) {
  console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log('screenvideo e2e ok');
