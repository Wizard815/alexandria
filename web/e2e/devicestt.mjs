// Speech to text on the devices, end to end, with Chromium's fake microphones and no real speech model.
//
// The librarian serves the speech library from ALX_STT_LIB_URL; here that is a tiny local server that first answers
// 404 (the library cannot load, as when a browser has neither WebGPU nor WebAssembly to spare) and then a stand-in
// module with the same shape as transformers.js (pipeline + env) that "hears" a fixed sentence per five seconds of
// wall clock. So the real path runs: the worker, the audio decode, the text upload and the server's handling.
//
//   1. fallback: the world asks for on-device speech to text, the library does not load: the GM's page says the
//      server transcribes, every chunk is done by the server, none is left waiting.
//   2. device: the GM's computer and a player's phone both transcribe on the device; the phone says so; the GM sees
//      each mic on the device and its speed; lines come from the devices; after Stop the final pass syncs both mics
//      into one transcript (no sentence twice), shown on Recordings, and Transcript.md / session.json say so.
//   3. (E2E_REAL_STT=1 only) the real library and the smallest Whisper model, fetched through the librarian. Chromium's
//      fake mic plays a tone, which Whisper hears as nothing: give it speech with DSTT_WAV=<a .wav of someone talking>
//      (it loops) to check that real words with times reach the transcript. The librarian fetches from the internet,
//      so behind a proxy run Node with NODE_USE_ENV_PROXY=1.
//
// Run from web/: npm run build && node e2e/devicestt.mjs   (DSTT_PORT, DSTT_FAKE_PORT, DSTT_SHOTS=<dir>)
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.DSTT_PORT || 8873);
const FAKE_PORT = Number(process.env.DSTT_FAKE_PORT || 8879);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.DSTT_SHOTS || path.join(tmpDir('dstt-shots'));
fs.mkdirSync(SHOTS, { recursive: true });
const REAL = process.env.E2E_REAL_STT === '1';
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); else console.log('  ok  ' + msg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in speech library -------------------------------------------------------------------------------
const SENTENCES = [
  'The lantern flickers as the ferry drifts toward the misty harbour',
  'Somebody should check the cellar before the smugglers return tonight',
  'Roll initiative because the goblins are climbing over the wall',
  'The old map shows a hidden stair beneath the chapel ruins',
];
const FAKE_LIB = `
export const env = { backends: { onnx: { wasm: {} } } };
const SENTENCES = ${JSON.stringify(SENTENCES)};
export async function pipeline(task, model, opts = {}) {
  for (const pct of [10, 60, 100]) { opts.progress_callback?.({ status: 'progress', file: 'onnx/encoder_model.onnx', loaded: pct, total: 100 }); await new Promise((r) => setTimeout(r, 150)); }
  return async (audio, o = {}) => {
    const secs = audio.length / 16000;
    if (secs < 2) return { text: '', chunks: [] };
    const words = SENTENCES[Math.floor(Date.now() / 5000) % SENTENCES.length].split(' ');
    const step = Math.min(0.35, (secs - 0.6) / words.length);
    await new Promise((r) => setTimeout(r, 120));
    const chunks = words.map((w, i) => ({ text: ' ' + w, timestamp: [0.3 + i * step, 0.3 + i * step + step * 0.9] }));
    return o.return_timestamps === 'word' ? { text: words.join(' '), chunks } : { text: words.join(' '), chunks: [{ text: words.join(' '), timestamp: [0.3, 0.3 + words.length * step] }] };
  };
}
`;
let libUp = false;
const fake = http.createServer((req, res) => {
  if (!libUp || !req.url.endsWith('/transformers.min.js')) { res.writeHead(404); return res.end('not here'); }
  res.writeHead(200, { 'Content-Type': 'text/javascript' });
  res.end(FAKE_LIB);
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

process.env.ALX_RECORDINGS_BUILD_DELAY_MS = '0';
process.env.ALX_AUDIO_REFINE_DELAY_MS = '0';
process.env.ALX_AUDIO_FINAL_WAIT_MS = '4000';
process.env.ALX_AUDIO_TEXT_WAIT_MS = '15000';
if (!REAL) process.env.ALX_STT_LIB_URL = `http://127.0.0.1:${FAKE_PORT}/dist/`;
const data = path.join(tmpDir('dstt'), 'data');
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', data, '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');

const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
const tokDM = await login('dm', 'game master 123');
const tokTom = await login('tom', 'player pass 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + tokDM } })).json())[0].id;
const api = async (tok, method, p, body) => { const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };

const WAV = REAL && process.env.DSTT_WAV ? path.resolve(process.env.DSTT_WAV) : '';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...(WAV ? [`--use-file-for-fake-audio-capture=${WAV}`] : [])] });
const watch = (page, who) => {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text()) && !/ERR_|Failed to load resource/.test(m.text())) problems.push(`${who} console: ${m.text()}`); });
};
async function signIn(user, pass, viewport = { width: 1280, height: 900 }, mobile = false) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, permissions: ['microphone'] });
  const page = await ctx.newPage();
  watch(page, user);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}
const micsDM = async () => (await api(tokDM, 'GET', '/audio/mics')).body;

/** The GM turns on this computer's (fake) mic and starts a session. */
async function dmStart(page, name) {
  await page.goto(`${base}/w/saltreach/gm/audio`);
  await page.getByRole('button', { name: /allow the microphone|refresh the list/i }).click();
  const sw = page.getByRole('switch', { name: /^Use /i }).first();
  await sw.waitFor({ timeout: 10000 });
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
  await page.getByPlaceholder(/Session 12/).fill(name);
  await page.getByRole('button', { name: /start recording/i }).click();
  await page.getByRole('button', { name: /stop recording/i }).waitFor({ timeout: 15000 });
}
async function dmStop(page) {
  await page.getByRole('button', { name: /stop recording/i }).click();
  await page.getByRole('button', { name: /start recording/i }).waitFor({ timeout: 30000 });
}
async function setMode(page, label) {
  await page.goto(`${base}/w/saltreach/gm/audio`);
  await page.getByRole('radio', { name: label }).check();
  await page.getByText('Saved').first().waitFor({ timeout: 5000 }).catch(() => {});
  for (let i = 0; i < 20; i++) { if ((await api(tokDM, 'GET', '/audio/status')).body.transcription.stt) break; await sleep(100); }
}
const sessionByName = async (name) => (await api(tokDM, 'GET', '/audio/recordings')).body.sessions.find((x) => x.name === name);
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(500); }
}

try {
  const { page: dm } = await signIn('dm', 'game master 123');

  // ---- 1. the library cannot load: the server transcribes everything ---------------------------------------------
  if (!REAL) {
    console.log('1. on-device speech to text that cannot load falls back to the server');
    await setMode(dm, /On each device/);
    check((await api(tokDM, 'GET', '/audio/status')).body.transcription.stt === 'device', 'the GM set "On each device"');
    check((await api(tokTom, 'GET', '/audio/status')).body.transcription.stt === 'device', 'players read the mode too');
    await dmStart(dm, 'E2E fallback');
    const note = dm.locator('.au-stt-note.server');
    await note.waitFor({ timeout: 20000 });
    const text = await note.innerText();
    check(/server transcribes/i.test(text) && /did not load|cannot|not serve/i.test(text), `the GM's page says the server transcribes this mic ("${text.replace(/\s+/g, ' ').slice(0, 120)}")`);
    await sleep(11000);
    const m1 = (await micsDM()).find((m) => m.stt?.device);
    check(m1 && ['error', 'unsupported'].includes(m1.stt.device.state), `the device told the server it cannot transcribe (${m1?.stt?.device?.state})`);
    await dm.screenshot({ path: path.join(SHOTS, '1-fallback-setup.png'), fullPage: true });
    await dmStop(dm);
    const s1 = await sessionByName('E2E fallback');
    const counts = await waitFor(async () => { const m = (await micsDM()).find((x) => x.stt?.chunks?.server > 0); return m && m.stt.chunks.awaiting === 0 ? m.stt.chunks : null; }, 30000, 'server-transcribed chunks');
    check(counts.server >= 2 && counts.device === 0 && counts.awaiting === 0, `every chunk was transcribed by the server, none waits (${JSON.stringify(counts)})`);
    check(!!s1, 'the session is listed on Recordings');
  }

  // ---- 2. two devices transcribe; the final pass syncs them ------------------------------------------------------
  console.log('2. the GM computer and a player phone transcribe on the device');
  libUp = true;
  await setMode(dm, /On each device/);
  const { page: tom } = await signIn('tom', 'player pass 123', { width: 390, height: 844 }, true);
  await tom.goto(`${base}/w/saltreach/audio`);
  const allow = tom.getByRole('button', { name: 'Allow the microphone' });
  if (await allow.isVisible().catch(() => false)) await allow.click();
  await tom.getByText(/Speech to text on this device/).first().waitFor({ timeout: 10000 });
  check(true, 'the player sees that the GM asked devices to transcribe');
  const micSelect = tom.getByRole('combobox').first();
  await tom.waitForFunction(() => [...document.querySelectorAll('select option')].some((o) => o.value), null, { timeout: 10000 });
  const firstDevice = await micSelect.evaluate((s) => [...s.options].find((o) => o.value)?.value);
  await micSelect.selectOption(firstDevice);
  const use = tom.getByRole('switch', { name: 'Use my microphone' });
  if ((await use.getAttribute('aria-checked')) !== 'true') await use.click();

  await dmStart(dm, 'E2E device session');
  await tom.reload();
  const on = tom.locator('.au-stt-note.on');
  await on.waitFor({ timeout: REAL ? 240000 : 30000 });
  const tomNote = await on.innerText();
  check(/Transcribing on this device/.test(tomNote), `the phone shows "Transcribing on this device" (${tomNote.replace(/\s+/g, ' ').slice(0, 100)})`);
  await tom.locator('.au-badge-stt').waitFor({ timeout: 10000 });
  check(true, 'the recording badge on the phone says "transcribing on this device"');
  await dm.locator('.au-stt-note.on').waitFor({ timeout: 30000 });
  check(true, 'the GM computer transcribes its own mic too');
  console.log('  recording for 22 s with two fake mics...');
  await sleep(22000);
  await tom.screenshot({ path: path.join(SHOTS, '2-phone-transcribing.png'), fullPage: true });
  const ms = await micsDM();
  const devMics = ms.filter((m) => m.stt?.chunks?.device > 0);
  check(devMics.length >= 2, `two mics have chunks transcribed on their device (${ms.map((m) => `${m.label}: ${JSON.stringify(m.stt?.chunks)}`).join('; ')})`);
  const tomMic = ms.find((m) => m.owner && /tom/i.test(m.owner) && m.stt?.device);
  check(tomMic && tomMic.stt.device.backend && tomMic.stt.device.rtf !== null, `the GM sees the phone's engine and speed (${tomMic?.stt?.device?.backend}, rtf ${tomMic?.stt?.device?.rtf})`);
  await dm.getByRole('heading', { name: 'Mics in this world' }).scrollIntoViewIfNeeded();
  await dm.waitForFunction(() => [...document.querySelectorAll('[data-stt="device"]')].length >= 1, null, { timeout: 12000 }).catch(async (e) => { console.log(await dm.locator('.au-stt').allInnerTexts()); throw e; });
  const rowText = await dm.locator('[data-stt="device"]').first().innerText();
  check(/Device · (CPU|GPU)/.test(rowText) && /real time/.test(rowText), `each mic shows on-device and its speed on the GM's page ("${rowText.trim()}")`);
  await dm.screenshot({ path: path.join(SHOTS, '2-dm-setup.png'), fullPage: true });
  const sid = (await api(tokDM, 'GET', '/audio/status')).body.session?.id;
  const liveLines = (await api(tokDM, 'GET', `/audio/sessions/${sid}/lines`)).body.lines;
  if (!REAL) check(liveLines.some((l) => SENTENCES.some((s) => l.text.includes(s.split(' ').slice(1, 4).join(' ')))), `lines come from the devices' text (${liveLines.length} lines)`);
  else if (WAV) check(liveLines.some((l) => /\w+\s+\w+/.test(l.text) && l.end > l.start), `the real model's words reach the transcript (${liveLines.length} lines: "${(liveLines[0]?.text ?? '').slice(0, 60)}")`);
  else console.log(`  (real model, tone only: ${liveLines.length} lines; set DSTT_WAV to check real words)`);

  // A mode change reaches the recording phone live: no reload, no restart of the recording.
  const tomUrl = tom.url();
  check((await api(tokDM, 'PATCH', '/settings', { speechToText: 'server' })).status === 200, 'the GM switches speech to text to the server mid-session');
  await tom.locator('.au-stt-note.on').waitFor({ state: 'detached', timeout: 15000 }).then(() => check(true, 'the phone stops transcribing on the device at once'), () => check(false, 'the phone still transcribes on the device after the switch to the server'));
  const offMic = await waitFor(async () => { const m = (await micsDM()).find((x) => x.owner && /tom/i.test(x.owner)); return m && (!m.stt?.device || m.stt.device.state === 'off') ? m : null; }, 15000, 'the phone reports off').catch(() => null);
  check(!!offMic, 'the phone told the server it stopped transcribing');
  check((await api(tokDM, 'PATCH', '/settings', { speechToText: 'device' })).status === 200, 'and back to "On each device"');
  await tom.locator('.au-stt-note.on').waitFor({ timeout: REAL ? 240000 : 30000 }).then(() => check(true, 'the phone transcribes on the device again without a restart'), () => check(false, 'the phone did not switch back to the device'));
  check(tom.url() === tomUrl && (await api(tokDM, 'GET', '/audio/status')).body.session?.id === sid, 'the same page and the same recording session throughout');
  await sleep(6000);

  await dmStop(dm);
  const fin = await waitFor(async () => { const s = await sessionByName('E2E device session'); return s?.final?.status === 'done' ? s : null; }, 90000, 'the final transcript');
  check(fin.final.stats.mics >= 2, `the final pass synced ${fin.final.stats.mics} mics`);
  const finalLines = (await api(tokDM, 'GET', `/audio/sessions/${sid}/lines`)).body.lines;
  // The same sentence from two mics at the same moment must be one line now.
  const dupes = finalLines.filter((a, i) => finalLines.some((b, j) => j > i && a.text === b.text && Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0));
  check(dupes.length === 0, `no sentence is in the final transcript twice at the same time (${finalLines.length} lines, live had ${(await api(tokDM, 'GET', `/audio/sessions/${sid}/lines?version=live`)).body.lines.length})`);
  check((await api(tokTom, 'GET', `/audio/sessions/${sid}/lines?version=live`)).status === 403, 'a player cannot read the live version');

  await dm.goto(`${base}/w/saltreach/gm/recordings`);
  await dm.getByRole('button', { name: /E2E device session/ }).click();
  const box = dm.getByRole('region', { name: 'Final transcript' });
  await box.locator('[data-final="done"]').waitFor({ timeout: 15000 });
  check(/Synced [2-9] mics onto one timeline/.test(await box.innerText()), 'Recordings shows the final transcript and the sync per mic');
  await dm.screenshot({ path: path.join(SHOTS, '2-dm-recordings.png'), fullPage: true });
  if (ffmpeg) {
    const rec = await waitFor(async () => { const s = await sessionByName('E2E device session'); return s?.status === 'ready' || s?.status === 'failed' ? s : null; }, 60000, 'the build');
    const dir = path.join(data, rec.folder ?? '');
    const md = fs.existsSync(path.join(dir, 'Transcript.md')) ? fs.readFileSync(path.join(dir, 'Transcript.md'), 'utf8') : '';
    if (!REAL || WAV) check(/microphones synced onto one timeline/.test(md), 'Transcript.md is the final transcript');
    const doc = fs.existsSync(path.join(dir, 'session.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) : {};
    check(doc.transcript?.status === 'done' && doc.microphones?.some((m) => m.speechToText?.deviceChunks > 0), 'session.json says which chunks each device transcribed');
  } else console.log('  (ffmpeg missing: the recording folder checks are skipped)');
  // Undo puts the live lines back (a tone heard by the real model leaves no lines, so nothing to undo).
  if (!REAL || WAV) {
    await box.getByRole('button', { name: /Undo/ }).click();
    await box.getByText(/Undone/).waitFor({ timeout: 10000 });
    check(true, 'Undo brings the live transcript back');
  }
  const wide = await tom.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 1, `no sideways scroll on the phone (${wide}px)`);
} catch (e) {
  problems.push('crashed: ' + (e?.stack ?? e));
} finally {
  await browser.close();
  srv.kill();
  fake.close();
}
console.log(`screenshots: ${SHOTS}`);
if (problems.length) { console.log('\nPROBLEMS:\n- ' + problems.join('\n- ')); process.exit(1); }
console.log('\ndevice speech-to-text e2e: ok');
