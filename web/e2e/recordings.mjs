// Recordings, end to end: the DM records a short session with Chromium's fake microphone, stops it, waits
// for the build, then plays the full recording and each mic track, clicks a transcript line to seek,
// downloads files, changes retention, and a player sees only their own track and the players' transcript.
// Needs ffmpeg. Run from web/: npm run build && node e2e/recordings.mjs   (REC_PORT, REC_SHOTS=<dir>)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('recordings e2e: skipped (ffmpeg is not installed)'); process.exit(0); }

const PORT = Number(process.env.REC_PORT || 8851);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.REC_SHOTS || '/tmp/claude-0/-home-user/26e3dbe6-7466-590f-acf8-13740003567a/scratchpad/recordings';
fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); else console.log('  ok  ' + msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.ALX_RECORDINGS_BUILD_DELAY_MS = '0';
process.env.ALX_AUDIO_REFINE_DELAY_MS = '0';
const data = path.join(tmpDir('rec'), 'data');
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', data, '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');

const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tokDM = await login('dm', 'dungeon master 123');
const tokTom = await login('tom', 'player pass 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tokDM } })).json())[0].id;
const api = async (tok, method, p, body) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const recs = async () => (await api(tokDM, 'GET', '/audio/recordings')).body.sessions;
const waitReady = async (name, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const s = (await recs()).find((x) => x.name === name);
    if (s && (s.status === 'ready' || s.status === 'failed')) return s;
    if (Date.now() > end) throw new Error(`the build of ${name} did not finish`);
    await sleep(500);
  }
};

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/ERR_|Failed to load resource/.test(m.text())) problems.push(`${who} console: ${m.text()}`); });
};
async function signIn(user, pass, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ['microphone'], acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page, user);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}

try {
  // ---- 1. the DM records a short session with the fake microphone ----
  const { ctx: dctx, page } = await signIn('dm', 'dungeon master 123');
  await page.goto(`${base}/w/saltreach/dm/audio`);
  await page.getByRole('button', { name: /allow the microphone|refresh the list/i }).click();
  const sw = page.getByRole('switch', { name: /^Use /i }).first();
  await sw.waitFor({ timeout: 10000 });
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
  await page.getByPlaceholder(/Session 12/).fill('E2E live session');
  await page.getByRole('button', { name: /start recording/i }).click();
  await page.getByRole('button', { name: /stop recording/i }).waitFor({ timeout: 15000 });
  console.log('  recording for 14 s with the fake mic...');
  await sleep(14000);
  await page.getByRole('button', { name: /stop recording/i }).click();
  await page.getByRole('button', { name: /start recording/i }).waitFor({ timeout: 15000 });
  const live = await waitReady('E2E live session');
  check(live.status === 'ready', `the live recording was built (${live.status}${live.error ? ': ' + live.error : ''})`);
  check(live.durationMs > 8000, `the live recording is about as long as it was recorded (${Math.round(live.durationMs / 1000)} s)`);
  check(live.rawChunks === 0, 'the raw chunks were removed after the build');
  const folder = path.join(data, live.folder);
  const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  check(files.includes('Full session.mp3') && files.includes('Transcript.md') && files.includes('session.json') && files.some((f) => / - dm\.mp3$/.test(f) || /\.mp3$/.test(f) && f !== 'Full session.mp3'), `the folder on disk is readable (${files.join(', ')})`);

  // ---- 2. the DM's Recordings page ----
  await page.goto(`${base}/w/saltreach/dm/recordings`);
  await page.getByRole('heading', { name: 'Recordings', level: 1 }).waitFor({ timeout: 10000 }).catch(() => {});
  await page.getByText('E2E live session').first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: path.join(SHOTS, 'dm-list.png'), fullPage: true });
  // the demo's session, built from its tones
  const s21 = await waitReady('Session 21');
  check(s21.status === 'ready', `Session 21 (demo) was built (${s21.status}${s21.error ? ': ' + s21.error : ''})`);
  await page.getByRole('button', { name: /Session 21/ }).click();
  await page.getByRole('heading', { name: /Session 21/ }).waitFor();
  const main = page.locator('.rec-track.main audio');
  await main.waitFor({ timeout: 10000 });
  await page.waitForFunction(() => { const a = document.querySelector('.rec-track.main audio'); return a && a.readyState >= 1 && a.duration > 0; }, null, { timeout: 15000 });
  const dur = await main.evaluate((a) => a.duration);
  check(dur > 15 && dur < 30, `the full recording plays in the browser (${dur.toFixed(1)} s)`);
  const tracks = await page.locator('.rec-track').count();
  check(tracks === 4, `the full recording and three mic tracks are listed (${tracks})`);
  const trackText = await page.locator('.rec-players').innerText();
  check(/Tomas's phone/.test(trackText) && /DM headset/.test(trackText) && /Table/.test(trackText), 'each mic is labelled with its name');
  check(/Full session/.test(trackText) && /· (tom|Tom)/i.test(trackText), 'tracks name the person they belong to');
  // every track plays
  const durations = await page.locator('.rec-track audio').evaluateAll((els) => Promise.all(els.map((a) => new Promise((r) => { if (a.readyState >= 1) r(a.duration); else { a.addEventListener('loadedmetadata', () => r(a.duration), { once: true }); a.load(); setTimeout(() => r(0), 8000); } }))));
  check(durations.every((d) => d > 1), `all four players load (${durations.map((d) => d.toFixed(1)).join(', ')} s)`);
  // click a transcript line: the recording jumps there
  const line = page.locator('.rec-line', { hasText: /ferry costs two silver/i });
  await line.waitFor({ timeout: 10000 });
  await line.click();
  await sleep(600);
  const t = await main.evaluate((a) => a.currentTime);
  check(t >= 4.5 && t < 8, `clicking a transcript line seeks the full recording (at ${t.toFixed(1)} s)`);
  check((await page.locator('.rec-lines li.on').count()) === 1, 'the line being played is highlighted');
  await page.locator('.rec-line', { hasText: /Fireball/i }).click();
  await sleep(500);
  check((await main.evaluate((a) => a.currentTime)) >= 15, 'a later line seeks later');
  check(await page.getByText('DM only').first().isVisible(), 'DM-only lines are marked for the DM');
  await page.locator('.rec-track.main audio').evaluate((a) => a.pause());
  await page.screenshot({ path: path.join(SHOTS, 'dm-session.png'), fullPage: true });

  // downloads
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('link', { name: 'Download Full session' }).click()]);
  const dlPath = await dl.path();
  check(dl.suggestedFilename() === 'Full session.mp3' && fs.statSync(dlPath).size > 5000, `the full mix downloads (${dl.suggestedFilename()}, ${fs.statSync(dlPath).size} bytes)`);
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('link', { name: /^Download Tomas's phone/ }).click()]);
  check(/Tomas's phone - .*\.mp3$/.test(dl2.suggestedFilename()), `a mic track downloads (${dl2.suggestedFilename()})`);
  const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: /\.md$/ }).click()]);
  const md = fs.readFileSync(await dl3.path(), 'utf8');
  check(/Remember Velmira/.test(md) && /DM only/.test(md), 'the transcript downloads as Markdown, DM-only lines marked');

  // retention
  await page.getByLabel('How long to keep the audio').selectOption('days');
  await page.getByLabel('Days to keep the audio').fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /Session 21/ }).getByText(/Deletes in [45] days/).waitFor({ timeout: 8000 });
  check(true, 'the list says "Deletes in 5 days"');
  await page.getByLabel('How long to keep the audio').selectOption('forever');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: /Session 21/ }).getByText('Kept forever').waitFor({ timeout: 8000 });
  check(true, 'keep forever shows on the list');
  await page.screenshot({ path: path.join(SHOTS, 'dm-retention.png'), fullPage: true });

  // delete now, with a confirm, on the live session
  await page.getByRole('button', { name: /E2E live session/ }).click();
  let asked = '';
  page.once('dialog', async (d) => { asked = d.message(); await d.dismiss(); });
  await page.getByRole('button', { name: 'Delete audio now' }).click();
  await sleep(400);
  check(/Delete the audio/.test(asked) && (await recs()).find((x) => x.name === 'E2E live session').status === 'ready', 'Delete audio now asks first, and a "no" deletes nothing');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Delete audio now' }).click();
  await page.getByRole('button', { name: /E2E live session/ }).getByText('Audio deleted').first().waitFor({ timeout: 8000 });
  check(!fs.existsSync(path.join(folder, 'Full session.mp3')) && fs.existsSync(path.join(folder, 'Transcript.md')), 'the audio files are gone from disk; the transcript stays');
  await page.screenshot({ path: path.join(SHOTS, 'dm-deleted.png'), fullPage: true });
  await dctx.close();

  // ---- 3. a player sees only their own track ----
  const { ctx: pctx, page: p } = await signIn('tom', 'player pass 123');
  await p.goto(`${base}/w/saltreach/recordings`);
  await p.getByRole('heading', { name: 'My recordings' }).waitFor({ timeout: 10000 });
  await p.locator('.rec-track.main audio').waitFor({ timeout: 10000 });
  const ptext = await p.locator('.page').innerText();
  check(/Tomas's phone/.test(ptext), 'the player sees their own mic track');
  check(!/Full session|DM headset|Table\b.*·/.test(await p.locator('.rec-players').innerText()), 'the player does not see the full mix or other mics');
  check(!/Velmira|DM only/.test(ptext), 'the player sees no DM-only lines');
  check((await p.locator('.rec-track').count()) === 1, 'exactly one track');
  await p.waitForFunction(() => { const a = document.querySelector('.rec-track audio'); return a && a.readyState >= 1 && a.duration > 0; }, null, { timeout: 15000 });
  await p.locator('.rec-line').first().click();
  await sleep(500);
  check((await p.locator('.rec-track audio').evaluate((a) => a.currentTime)) >= 0, 'the player can click a line to seek their track');
  await p.screenshot({ path: path.join(SHOTS, 'player.png'), fullPage: true });
  // the API agrees: the full mix and other mics are 403 for the player
  const detail = (await api(tokDM, 'GET', `/audio/recordings/${s21.id}`)).body;
  const full = detail.tracks.find((x) => x.kind === 'full');
  const head = detail.tracks.find((x) => x.label === 'DM headset');
  const mine = detail.tracks.find((x) => x.label === "Tomas's phone");
  check((await api(tokTom, 'GET', `/audio/recordings/tracks/${full.id}/file`)).status === 403, 'API: the full mix is 403 for a player');
  check((await api(tokTom, 'GET', `/audio/recordings/tracks/${head.id}/file`)).status === 403, "API: someone else's track is 403 for a player");
  check((await api(tokTom, 'GET', `/audio/recordings/tracks/${mine.id}/file`)).status === 200, 'API: their own track plays');
  check((await api(tokTom, 'GET', '/audio/recordings')).status === 403, 'API: the DM list is 403 for a player');
  await pctx.close();

  // a player who was not recorded has nothing to play
  const tokJess = await login('jess', 'player pass 123');
  const jl = (await api(tokJess, 'GET', '/audio/recordings/mine')).body.sessions;
  check(jl.every((x) => x.tracks.every((t) => t.label !== "Tomas's phone")), "another player never gets Tomas's track");

  // phone width
  const { ctx: mctx, page: mp } = await signIn('tom', 'player pass 123', { width: 390, height: 844 });
  await mp.goto(`${base}/w/saltreach/recordings`);
  await mp.locator('.rec-track.main').waitFor({ timeout: 10000 });
  const wide = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 1, `no sideways scroll on a phone (${wide}px)`);
  await mp.screenshot({ path: path.join(SHOTS, 'player-phone.png'), fullPage: true });
  await mctx.close();
} catch (e) {
  problems.push('crashed: ' + (e?.stack ?? e));
} finally {
  await browser.close();
  srv.kill();
}
if (problems.length) { console.log('\nPROBLEMS:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('\nrecordings e2e: ok');
