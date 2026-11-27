// The GM's first real table night, compressed to a few minutes: ten browser contexts at once (the GM desktop, the GM's
// portrait side screen, the players' TV, the face-up table screen, the GM's Android phone, four players on a Mac,
// two iPhones and an Android phone, and player 4's second sign-in on a Windows PC) against the demo world, with REAL
// models from OpenRouter for the chat, audit and embeddings jobs. Speech to text is not offered there, so the recording
// goes through the app's own audio path (chunks from a mic, as the scribe uploads them) with the demo's fake speech model
// turning each chunk into the scripted line.
//
// Skipped unless TABLENIGHT=1 and OpenRouter answers, so CI never calls a paid model. Run from web/:
//   npm run build && TABLENIGHT=1 node e2e/tablenight.mjs
// Output (screenshots, report.md, results.json) goes to TABLENIGHT_OUT (default: a temp folder).
//
// Only Chromium is installed, so Safari, iOS, macOS, Windows and Android are emulated: device descriptors and user agents.
// Fog of war is out of scope for now: the step is skipped.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';
import { createRequire } from 'node:module';

const { devices } = createRequire(import.meta.url)('playwright');

if (process.env.TABLENIGHT !== '1') { console.log('tablenight: skipped (set TABLENIGHT=1; it calls paid models)'); process.exit(0); }

const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.TABLENIGHT_KEY || 'sk-or-proxy';
const CHAT = process.env.TABLENIGHT_CHAT || 'tencent/hy4-flash';
const FALLBACK = process.env.TABLENIGHT_FALLBACK || 'deepseek/deepseek-v4.1-flash';
const EMBED = process.env.TABLENIGHT_EMBED || 'baai/bge-m3';
// The players' quick helper: a small second model (Wizard: 4B or less, or the ternary Bonsai 9B).
const HELPER = process.env.TABLENIGHT_HELPER || 'prism-ml/ternary-bonsai-2-9b';
const OUT = process.env.TABLENIGHT_OUT || tmpDir('tablenight');
fs.mkdirSync(OUT, { recursive: true });

const credit = async () => { try { const j = await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json(); return j?.data?.usage ?? null; } catch { return null; } };
try {
  const r = await fetch(`${OR}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: CHAT, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 8, reasoning: { enabled: false } }), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(String(r.status));
} catch (e) { console.log(`tablenight: skipped (OpenRouter did not answer: ${e.message})`); process.exit(0); }
const spend0 = await credit();

const PORT = Number(process.env.TABLENIGHT_PORT || 8930);
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const API = '/api/worlds/saltreach';
const PASS = { dm: 'game master 123', player: 'player pass 123', admin: 'library admin 123' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`);

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('tablenight-data'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();

// ---- results ---------------------------------------------------------------------------------------------------
const steps = [];
let cur = null;
const fail = (msg) => { if (cur) { cur.fails.push(msg); log(`  FAIL ${msg}`); } };
const note = (msg) => { if (cur) cur.notes.push(msg); log(`  ${msg}`); };
async function step(n, name, fn) {
  if (process.env.TN_STEPS && n > 1 && !process.env.TN_STEPS.split(',').includes(String(n))) return;
  cur = { n, name, ok: true, ms: 0, fails: [], notes: [], appear: {}, console: [], http: [], model: [] };
  steps.push(cur);
  const s = cur, start = Date.now();
  log(`step ${n}: ${name}`);
  const mark = new Map([...devs].map(([k, d]) => [k, [d.errors.length, d.http.length]]));
  try { await fn(); } catch (e) { fail(`crashed: ${String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`); }
  s.ms = Date.now() - start;
  for (const [k, d] of devs) {
    const [e, h] = mark.get(k) ?? [0, 0];
    for (const m of d.errors.slice(e)) s.console.push(`${k}: ${m}`);
    for (const m of d.http.slice(h)) s.http.push(`${k}: ${m}`);
  }
  s.ok = s.fails.length === 0;
  await shots(`${String(n).padStart(2, '0')}-${name.replace(/\W+/g, '-').toLowerCase()}`);
  cur = s;
}

// ---- devices ---------------------------------------------------------------------------------------------------
const dev = (name) => { const { defaultBrowserType, ...d } = devices[name]; return d; };
const UA_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SPEC = {
  dm: { opts: { viewport: { width: 1920, height: 1080 }, userAgent: UA_LINUX }, label: 'GM desktop (Ubuntu Chrome 1920x1080)' },
  side: { opts: { viewport: { width: 1080, height: 1920 }, userAgent: UA_LINUX }, label: 'GM side screen (portrait 1080x1920)' },
  tv: { opts: { viewport: { width: 1920, height: 1080 }, userAgent: UA_LINUX }, label: "Players' TV (1920x1080)" },
  table: { opts: { viewport: { width: 1920, height: 1080 }, userAgent: UA_LINUX }, label: 'Table screen (1920x1080)' },
  phone: { opts: dev('Pixel 7'), label: 'GM phone (Pixel 7, installed-PWA style)', standalone: true },
  p1: { opts: { viewport: { width: 1440, height: 900 }, userAgent: UA_MAC, deviceScaleFactor: 2 }, label: 'P1 Jessamine (Mac, Safari UA 1440x900)' },
  p2: { opts: dev('iPhone 15'), label: 'P2 Tomas (iPhone 15)' },
  p3: { opts: dev('iPhone 15 Pro Max'), label: 'P3 Anselm (iPhone 15 Pro Max)' },
  p4a: { opts: dev('Pixel 7'), label: 'P4 Mira (Pixel 7)' },
  p4w: { opts: { viewport: { width: 1920, height: 1080 }, userAgent: UA_WIN }, label: 'P4 Mira (Windows PC, Chrome UA 1920x1080)' },
};
/** name -> { ctx, page, errors, http, offline } */
const devs = new Map();
async function open(name, { standalone } = {}) {
  const spec = SPEC[name];
  const ctx = await browser.newContext(spec.opts);
  if (spec.standalone || standalone) {
    await ctx.addInitScript(() => {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => { const m = mm(q); return /display-mode:\s*standalone/.test(q) ? new Proxy(m, { get: (t, k) => (k === 'matches' ? true : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) : m; };
    });
  }
  const page = await ctx.newPage();
  const d = { ctx, page, errors: [], http: [], offline: false };
  page.on('pageerror', (e) => d.errors.push(`page error on ${new URL(page.url()).pathname}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) d.errors.push(`console on ${new URL(page.url()).pathname}: ${m.text().slice(0, 200)}`); });
  page.on('response', (r) => { if (r.status() >= 400) d.http.push(`${r.status()} ${r.request().method()} ${r.url().replace(base, '').slice(0, 100)}`); });
  page.on('requestfailed', (r) => { if (!d.offline && !/aborted|ERR_ABORTED/i.test(r.failure()?.errorText ?? '')) d.http.push(`failed ${r.method()} ${r.url().replace(base, '').slice(0, 100)} (${r.failure()?.errorText})`); });
  devs.set(name, d);
  return d;
}
async function login(name, user, pass = PASS.player) {
  const d = devs.get(name);
  await d.page.goto(base + '/login');
  await d.page.getByLabel(/username/i).fill(user);
  await d.page.getByLabel(/password/i).fill(pass);
  await d.page.getByRole('button', { name: /sign in|log in/i }).click();
  await d.page.waitForURL(/\/w\/saltreach/, { timeout: 20000 });
}
const pg = (n) => devs.get(n).page;
async function shots(tag) {
  await Promise.all([...devs].map(async ([k, d]) => { try { await d.page.screenshot({ path: path.join(OUT, `${tag}-${k}.png`), timeout: 8000 }); } catch { /* a page that is closing */ } }));
}

// ---- helpers ---------------------------------------------------------------------------------------------------
async function http(token, method, p, body, raw) {
  const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? { 'Content-Type': raw } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 200)}`);
  return j;
}
const login1 = async (u, p) => (await http(null, 'POST', '/api/auth/login', { username: u, password: p })).token;
let TK = {};
const dmApi = (m, p, b, raw) => http(TK.dm, m, API + p, b, raw);
const asApi = (who, m, p, b) => http(TK[who], m, API + p, b);

const hasText = (text) => (t) => document.body.innerText.includes(t) || [...document.querySelectorAll('img')].some((i) => (i.alt || '').includes(t));
/** Wait until `text` is on screen; resolves ms since `from`, or null. */
async function appears(name, text, from, timeout = 15000) {
  try { await pg(name).waitForFunction(hasText(text), text, { timeout, polling: 100 }); return Date.now() - from; } catch { return null; }
}
/** After `act()`, every listed device must show `text`. Records the time on each. */
async function everywhere(label, names, text, act, timeout = 15000) {
  const from = Date.now();
  await act?.();
  const res = await Promise.all(names.map(async (n) => [n, await appears(n, text, from, timeout)]));
  for (const [n, ms] of res) {
    if (ms === null) fail(`${label}: ${n} never showed "${text}"`);
    else { cur.appear[`${label} @${n}`] = ms; }
  }
  return Object.fromEntries(res);
}
/** Nowhere in the page may `text` appear. */
async function nowhere(label, names, text) {
  for (const n of names) {
    const hit = await pg(n).evaluate((t) => document.body.innerHTML.includes(t) || document.body.innerText.includes(t), text).catch(() => false);
    if (hit) fail(`${label}: "${text}" is on ${n}`);
  }
}
const png = (w, h, rgb) => {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0] + ((x * 40) / w) | 0; raw[o + 1] = rgb[1] + ((y * 40) / h) | 0; raw[o + 2] = rgb[2]; } }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

// ---- the assistant UIs -----------------------------------------------------------------------------------------
const lastReply = (page) => page.evaluate(() => { const m = [...document.querySelectorAll('.ag-msg')].filter((m) => !m.classList.contains('me') && getComputedStyle(m.parentElement).alignItems !== 'flex-end'); return m.length ? m[m.length - 1].textContent : ''; });
/** Type a question into whichever Ask box is on the page and wait for the answer. Returns { text, ms }. */
async function askAssistant(name, question, { scope, timeout = 90000 } = {}) {
  const page = pg(name);
  const root = scope ? page.locator(scope) : page;
  const box = root.locator('textarea[data-ag-input]').first();
  await box.waitFor({ timeout: 10000 });
  const before = await page.evaluate(() => [...document.querySelectorAll('.ag-msg')].filter((m) => !m.classList.contains('me') && getComputedStyle(m.parentElement).alignItems !== 'flex-end').length);
  const t = Date.now();
  try {
    await box.fill(question, { timeout: 8000 });
    await root.getByRole('button', { name: 'Send', exact: true }).first().click({ timeout: 8000 });
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, `ask-failed-${name}.png`) }).catch(() => {});
    return { text: '', ms: Date.now() - t, timedOut: true, dump: `could not send: ${String(e.message).split('\n')[0]}` };
  }
  try {
    await page.waitForFunction((n) => { const m = [...document.querySelectorAll('.ag-msg')].filter((m) => !m.classList.contains('me') && getComputedStyle(m.parentElement).alignItems !== 'flex-end'); return m.length > n && m[m.length - 1].textContent.trim().length > 20 && !document.querySelector('[aria-label="Stop the answer"]'); }, before, { timeout, polling: 200 });
  } catch {
    await page.screenshot({ path: path.join(OUT, `ask-timeout-${name}.png`) }).catch(() => {});
    const dump = await page.evaluate(() => ([...document.querySelectorAll('.ag-msg')].map((m) => m.innerText).join(' || ') || 'no messages').slice(0, 300));
    return { text: await lastReply(page), ms: Date.now() - t, timedOut: true, dump };
  }
  return { text: await lastReply(page), ms: Date.now() - t };
}

// =================================================================================================================
const MARKER = 'ZEPHYR-MARKER-7731';
let S = {}; // ids and bits carried between steps
let samplerStop = () => {};
try {
  // ---- real models, configured the way a real admin would: Admin -> Models --------------------------------------
  const admin = (await http(null, 'POST', '/api/admin-auth/login', { username: 'admin', password: PASS.admin })).token;
  const prov = await http(admin, 'POST', '/api/admin/models/providers', { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' });
  const pid = prov.provider?.id ?? prov.id;
  await http(admin, 'PUT', '/api/admin/models', { jobs: {
    chat: { providerId: pid, model: CHAT, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 }, fallback: { providerId: pid, model: FALLBACK, allowCloud: true } },
    audit: { providerId: pid, model: CHAT, enabled: true, options: { reasoning: 'off' } },
    extra: { providerId: pid, model: EMBED, enabled: true },
    helper: { providerId: pid, model: HELPER, enabled: true, options: { reasoning: 'off', reasoningModel: false, contextTokens: 4096, maxConcurrent: 4 } },
  } });
  S.admin = admin;
  const t = await http(admin, 'POST', '/api/admin/models/chat/test', {}).catch((e) => ({ error: e.message }));
  log(`chat test: ${JSON.stringify(t).slice(0, 160)}`);
  TK = { dm: await login1('dm', PASS.dm), jess: await login1('jess', PASS.player), tom: await login1('tom', PASS.player), ana: await login1('ana', PASS.player) };
  const members = await dmApi('GET', '/members');
  S.acc = Object.fromEntries(members.map((m) => [(m.display_name || '').toLowerCase(), m.id]));
  log(`members: ${Object.keys(S.acc).join(', ')}`);

  // Content: a GM-only page with a unique marker, the rules module, a picture for the TV and one for the table map.
  await dmApi('PUT', '/library/pages', { path: 'Secrets/The Black Pearl', visibility: 'dm', markdown: `# The Black Pearl\nThe cult of the Black Pearl meets under the lighthouse. Password: ${MARKER}.\n` });
  await dmApi('PUT', '/modules/enabled', { ids: ['dnd-2024'] }).catch((e) => log(`modules: ${e.message}`));
  const img = await dmApi('POST', '/stage/images', png(640, 360, [30, 90, 140]), 'image/png');
  S.card = await dmApi('POST', '/stage/cards', { kind: 'image', ref: img.id, caption: 'Saltmarsh harbour at dusk', show: false });
  const mp = await dmApi('POST', `/files?${new URLSearchParams({ name: 'harbour-map.png', folder: 'Maps', title: 'Harbour map', level: 'party', kind: 'map' })}`, png(800, 600, [60, 120, 90]), 'image/png');
  S.mapPic = `lib:${mp.id}`;
  S.scene = await dmApi('POST', '/scenes', { name: 'Arrival at the harbour', color: '#e9c46a', parts: { tv: { mode: 'card', cardId: S.card.id }, table: { mapId: 'world', pic: S.mapPic, fog: 'keep' } } });

  // ================================================================================================================
  await step(1, 'sign in on every device', async () => {
    for (const n of Object.keys(SPEC)) if (n !== 'p4a') await open(n);
    await Promise.all([login('dm', 'dm', PASS.dm), login('side', 'dm', PASS.dm), login('tv', 'dm', PASS.dm), login('table', 'dm', PASS.dm), login('phone', 'dm', PASS.dm), login('p1', 'jess'), login('p2', 'tom'), login('p3', 'ana')]);
    // Player 4 is invited the way a GM does it: an invite code from Settings, then the Join page on the player's phone.
    const dm = pg('dm');
    await dm.goto(`${W}/gm/settings`);
    await dm.getByRole('tab', { name: /invite players/i }).click().catch(() => dm.getByText(/Invite players/).first().click());
    await dm.getByRole('button', { name: /make an invite code/i }).click();
    const code = (await dm.locator('.ok-box .mono').first().innerText({ timeout: 8000 })).trim();
    check(code.length > 6, 'the invite code is shown');
    const a = await open('p4a');
    await a.page.goto(`${base}/join?code=${encodeURIComponent(code)}`);
    await a.page.getByLabel(/pick a username/i).fill('mira');
    await a.page.getByLabel(/pick a password/i).fill(PASS.player);
    await a.page.getByLabel(/character name/i).fill('Mira');
    await a.page.getByRole('button', { name: /^join$/i }).click();
    await a.page.getByRole('button', { name: /open the world/i }).click();
    await a.page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
    await login('p4w', 'mira');
    TK.mira = await login1('mira', PASS.player);
    S.acc.mira = (await dmApi('GET', '/members')).find((m) => (m.character_name || m.display_name || '').toLowerCase().includes('mira'))?.id ?? '';
    for (const p of ['jess', 'tom', 'ana', 'mira']) await asApi(p, 'POST', '/audio/consent', { agree: true }).catch((e) => note(`consent ${p}: ${e.message}`));
    // Everyone is where they will be for the first steps.
    await Promise.all([
      pg('dm').goto(`${W}/gm`), pg('side').goto(`${W}/screen/side`), pg('tv').goto(`${W}/screen/players`), pg('table').goto(`${W}/screen/table`), pg('phone').goto(`${W}/gm/phone`),
      pg('p1').goto(`${W}/live`), pg('p2').goto(`${W}/live`), pg('p3').goto(`${W}/live`), pg('p4a').goto(`${W}/live`), pg('p4w').goto(`${W}/live`),
    ]);
    await sleep(2500);
    for (const p of ['p1', 'p2', 'p3', 'p4a', 'p4w']) {
      const url = pg(p).url();
      check(!/\/gm/.test(url) && /\/w\/saltreach/.test(url), `${p} landed on ${url}`);
      const nav = await pg(p).evaluate(() => !!document.querySelector('nav, .bottomnav, header'));
      check(nav, `${p}: no player app chrome`);
    }
    check(await pg('side').getByTestId('side-screen').isVisible().catch(() => false), 'side screen did not open');
    check(await pg('tv').locator('.ps').isVisible().catch(() => false), 'TV did not open');
    check(await pg('table').getByTestId('table-screen').isVisible().catch(() => false), 'table screen did not open');
    check(await pg('phone').getByTestId('dmphone').isVisible().catch(() => false), 'GM phone page did not open');
    const standalone = await pg('phone').evaluate(() => window.matchMedia('(display-mode: standalone)').matches);
    note(`phone standalone emulation: ${standalone}`);
  });

  // ================================================================================================================
  await step(2, 'recording, live transcript, rules terms, running summary', async () => {
    const rec = await dmApi('POST', '/audio/sessions', { name: 'Table night' });
    S.sid = rec.id ?? rec.session?.id;
    const tableMic = await dmApi('POST', '/audio/mics', { deviceId: 'tn-table', label: 'Table', mode: 'always', playersTranscript: true });
    const jessMic = await asApi('jess', 'POST', '/audio/mics', { deviceId: 'tn-jess', label: "Jessamine's phone", mode: 'always' });
    S.mics = { dm: tableMic.id ?? tableMic.mic?.id, jess: jessMic.id ?? jessMic.mic?.id };
    const seq = { dm: 0, jess: 0 };
    let clock = 0;
    const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
    S.say = async (who, text, ms = 5000) => {
      const tok = who === 'dm' ? TK.dm : TK.jess;
      const q = new URLSearchParams({ mic: S.mics[who], seq: String(seq[who]++), start: String(clock), end: String(clock + ms), level: '0.6' });
      clock += ms;
      await http(tok, 'POST', `${API}/audio/sessions/${S.sid}/chunks?${q}`, Buffer.concat([WEBM, Buffer.from('FAKE:' + text)]), 'audio/webm');
    };
    const hs = await dmApi('POST', '/audio/mics', { deviceId: 'tn-headset', label: 'GM headset', mode: 'hold-to-talk', playersTranscript: false, aside: true });
    S.mics.hs = hs.id ?? hs.mic?.id;
    // A GM aside: the headset holds, the table mic hears it too, and it must stay GM-only.
    S.aside = async (text) => {
      const start = clock;
      await dmApi('POST', `/audio/sessions/${S.sid}/holds`, { micId: S.mics.hs, kind: 'aside', start, end: start + 5000 });
      const q = (mic, sq) => new URLSearchParams({ mic, seq: String(sq), start: String(start), end: String(start + 5000), level: '0.7' });
      await http(TK.dm, 'POST', `${API}/audio/sessions/${S.sid}/chunks?${q(S.mics.hs, 0)}`, Buffer.concat([WEBM, Buffer.from('FAKE:' + text)]), 'audio/webm');
      await http(TK.dm, 'POST', `${API}/audio/sessions/${S.sid}/chunks?${q(S.mics.dm, seq.dm++)}`, Buffer.concat([WEBM, Buffer.from('FAKE:' + text)]), 'audio/webm');
      clock += 5000;
    };
    const dmPages = ['dm', 'side', 'phone'];
    const SCRIPT = [
      ['dm', 'The ferry bumps against the harbour wall at Saltmarsh and gulls wheel over the grey water.'],
      ['jess', 'I step off the ferry and look for the harbour council hall near the quay.'],
      ['dm', 'Old Hennet the lighthouse keeper waves you over and says the lamp has been dark for a month.'],
      ['jess', 'Can I counter spell that if the smuggler casts Fireball at us on the pier?'],
      ['dm', 'You can use your reaction for Counterspell but the Fireball needs concentration from the caster no more.'],
    ];
    // The first line shows on the GM's screens; the rules terms in it are highlighted.
    await pg('dm').getByRole('button', { name: /open the transcript/i }).click({ timeout: 5000 }).catch(() => note('dm: transcript button not found (already open?)'));
    const from = Date.now();
    await S.say(...SCRIPT[0]);
    const first = 'ferry bumps against the harbour wall';
    const seen = await Promise.all([['dm', pg('dm')], ['side', pg('side')], ['phone', pg('phone')]].map(async ([n]) => {
      if (n === 'phone') { await pg('phone').getByRole('tab', { name: /^Notes/ }).click().catch(() => {}); }
      return [n, await appears(n, first, from, 20000)];
    }));
    for (const [n, ms] of seen) { if (ms === null) fail(`first transcript line never reached ${n}`); else cur.appear[`line1 @${n}`] = ms; }
    for (const [who, text] of SCRIPT.slice(1)) { await S.say(who, text); await sleep(700); }
    for (const n of dmPages) { const ms = await appears(n, 'Fireball', Date.now(), 20000); if (ms === null) fail(`the last scripted line never reached ${n}`); }
    await S.aside(`Remember the cult password is ${MARKER} and do not say it aloud.`);
    for (const n of dmPages) { const ms = await appears(n, MARKER, Date.now(), 20000); if (ms === null) fail(`the GM aside never reached ${n}`); }
    const marks = await pg('side').evaluate(() => [...document.querySelectorAll('mark.au-kw')].map((m) => m.textContent));
    const marksDm = await pg('dm').evaluate(() => [...document.querySelectorAll('mark.au-kw')].map((m) => m.textContent));
    note(`highlighted terms: side ${JSON.stringify(marks)}, dm ${JSON.stringify(marksDm)}`);
    if (!marks.length && !marksDm.length) fail('no rules term (Fireball, Counterspell, Concentration) was highlighted on the GM screens');
    // Players with the transcript open see the table's lines (the table mic allows it) but never the aside.
    // (On a phone the transcript button sits in the round "..." menu, so only the Mac opens it here.)
    await pg('p1').getByRole('button', { name: /open the transcript/i }).click({ timeout: 4000 }).catch(() => note('p1: the transcript is already open or has no button'));
    { const t = Date.now(); const ms = await appears('p1', 'ferry bumps against the harbour wall', t, 15000); if (ms === null) fail('p1 (a player with the transcript open) does not see the table line'); else cur.appear['transcript line @p1'] = ms; }
    await sleep(1500);
    await nowhere('GM aside', ['p1', 'p2', 'p3', 'p4a', 'p4w', 'tv', 'table'], MARKER);
    await shots('02a-transcript');
    // The running summary: the GM presses Update (a real model call).
    const sm = Date.now();
    const sum = await dmApi('POST', `/audio/sessions/${S.sid}/summary/refresh`, {}).catch((e) => ({ error: e.message }));
    cur.model.push(`summary refresh ${Date.now() - sm} ms`);
    const text = (await dmApi('GET', `/audio/sessions/${S.sid}/summary`).catch(() => ({}))).text ?? sum?.text ?? '';
    if (!text || text.length < 40) fail(`the running summary is empty (${JSON.stringify(sum).slice(0, 160)})`);
    else if (!/saltmarsh|harbo|ferry|hennet|lighthouse/i.test(text)) fail(`the running summary does not mention the scene: ${text.slice(0, 120)}`);
    else note(`summary (${text.length} chars): ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
    // The side screen can show it ("So far").
    await pg('side').locator('[data-testid=side-panel-transcript] button[title^="So far"]').first().click({ timeout: 4000 }).catch(() => {});
    const word = (text.match(/\b(Saltmarsh|harbour|ferry|Hennet|lighthouse)\b/i) ?? [''])[0];
    if (word && (await appears('side', word, Date.now(), 10000)) === null) fail('the running summary is not shown on the side screen');
  });

  // ================================================================================================================
  await step(3, 'a scene: TV picture and table map', async () => {
    const tvBefore = await pg('tv').evaluate(() => document.body.innerText.includes('Saltmarsh harbour at dusk'));
    if (tvBefore) fail('the TV showed the picture before the scene');
    const before = (await dmApi('GET', '/fog/table').catch(() => ({}))).pic;
    const from = Date.now();
    await pg('side').goto(`${W}/panel/scenes`).catch(() => {});
    const btn = pg('side').locator('[data-testid=scene-btn][data-scene="Arrival at the harbour"]');
    await btn.click({ timeout: 8000 });
    const ms = await appears('tv', 'Saltmarsh harbour at dusk', from, 15000);
    if (ms === null) fail('the TV never showed the scene picture'); else cur.appear['scene picture @tv'] = ms;
    const mapMs = await pg('table').waitForFunction((id) => {
      const m = /\/api\/media\/libfile\/([^."]+)/.exec(document.querySelector('[data-testid=table-map]')?.getAttribute('style') ?? '');
      if (!m) return false;
      try { return atob(m[1].replace(/-/g, '+').replace(/_/g, '/')).includes(id); } catch { return false; }
    }, S.mapPic.slice(4), { timeout: 15000 }).then(() => Date.now() - from, () => null);
    if (mapMs === null) fail('the table map never changed'); else cur.appear['scene map @table'] = mapMs;
    const after = (await dmApi('GET', '/fog/table').catch(() => ({}))).pic;
    if (after !== S.mapPic) fail(`table display says ${after}, wanted ${S.mapPic} (was ${before})`);
    const report = await pg('side').getByTestId('scene-report').innerText({ timeout: 5000 }).catch(() => '');
    if (/failed/i.test(report)) fail(`the scene reported a failed part: ${report.slice(0, 160)}`);
    await shots('03a-scene');
    // Players' phones do not carry the TV's card; the table map is the players' too (their own copy).
    await pg('side').goto(`${W}/screen/side`);
  });

  // ================================================================================================================
  await step(4, 'fog of war (skipped: the GM paused fog)', async () => { note('skipped by request'); });

  // ================================================================================================================
  await step(5, 'assistants at the same time (real models)', async () => {
    const qs = [];
    const sample = [];
    let stop = false;
    const poll = (async () => { while (!stop) { try { sample.push((await http(S.admin, 'GET', '/api/admin/models/queue')).models); } catch { /* ignore */ } await sleep(250); } })();
    samplerStop = () => { stop = true; };
    // Players go to their Ask pages. p1 left the floating transcript open: typing into the chat box it covers must
    // minimise it by itself, so the Send button is reachable.
    await Promise.all([['p1', 'ana'], ['p3', 'ana'], ['p2', 'tom']].map(([n]) => pg(n).goto(`${W}/assistant`)));
    if (await pg('p1').locator('.au-island:not(.au-drawer)').count()) {
      await pg('p1').locator('[data-ag-input]').first().focus().catch(() => {});
      await sleep(300);
      if (await pg('p1').locator('.au-island:not(.au-drawer)').count()) {
        const over = await pg('p1').evaluate(() => { const a = document.querySelector('.au-island')?.getBoundingClientRect(); const f = document.querySelector('[data-ag-input]')?.closest('form')?.getBoundingClientRect(); return !!(a && f && a.left < f.right && a.right > f.left && a.top < f.bottom && a.bottom > f.top); });
        if (over) fail('p1: the open transcript still covers the chat box after typing into it');
      }
    }
    await pg('p2').getByTestId('ask-helper').click({ timeout: 8000 }).catch(() => fail('p2: no Table helper tab'));
    await pg('phone').getByRole('tab', { name: /^Ask/ }).click();
    const sideAssistant = '[data-testid=side-panel-assistant]';
    // Two devices of one GM answer from two chats (a second question in a chat that is still answering is refused by design).
    for (const [n, sc] of [['side', sideAssistant], ['phone', null]]) { const b = (sc ? pg(n).locator(sc) : pg(n)).getByRole('button', { name: 'New chat', exact: true }).first(); if (await b.count()) await b.click().catch(() => {}); }
    await sleep(800);
    const jobs = [
      ['p1 broker', askAssistant('p1', 'Who rules Saltmarsh and what is the harbour like?')],
      ['p3 broker', askAssistant('p3', 'How much does the Greywater Ferry cost?')],
      ['p2 helper', askAssistant('p2', 'What does the Shield spell do?')],
      ['dm side assistant', askAssistant('side', 'Who is concentrating right now?', { scope: sideAssistant })],
      ['dm phone assistant', askAssistant('phone', 'Recap the last 10 minutes of the session in three lines.')],
    ];
    const t = Date.now();
    const res = await Promise.all(jobs.map(([n, p]) => p.then((r) => [n, r])));
    stop = true; await poll;
    S.answers = res;
    for (const [n, r] of res) {
      cur.model.push(`${n}: ${r.ms} ms${r.timedOut ? ' TIMED OUT' : ''}`);
      if (r.timedOut || !r.text || r.text.trim().length < 20) fail(`${n} got no answer (${(r.text || '').slice(0, 80)} | log: ${(r.dump || '').replace(/\s+/g, ' ').slice(0, 200)})`);
      else if (/something went wrong|model is not available|could not reach|no model/i.test(r.text)) fail(`${n} got an error answer: ${r.text.slice(0, 100)}`);
      else note(`${n} (${r.ms} ms): ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    note(`all five answered after ${Date.now() - t} ms`);
    const rows = sample.flat().filter(Boolean);
    const peakWait = Math.max(0, ...rows.map((m) => Number(m.waiting ?? m.queued ?? 0)));
    const peakRun = Math.max(0, ...rows.map((m) => Number(m.running ?? m.active ?? 0)));
    const dmChats = (await dmApi('GET', '/agent/chats').catch(() => ({ chats: [] }))).chats ?? [];
    for (const c of dmChats.slice(0, 3)) { const v = await dmApi('GET', `/agent/chats/${c.id}`).catch(() => null); note(`GM chat "${c.title}": ${(v?.messages ?? []).map((m) => `${m.role[0]}:${String(m.text).replace(/\s+/g, ' ').slice(0, 40)}`).join(' | ')}`); }
    note(`model queue seen: peak running ${peakRun}, peak waiting ${peakWait}; sample row ${JSON.stringify(rows.find((m) => Number(m.waiting ?? 0) > 0) ?? rows.find((m) => /openrouter/.test(m.server ?? '')) ?? rows[0] ?? {})}`);
    if (peakWait < 1) fail('with the chat job limited to 2 at a time, five concurrent questions never queued');
    if (!rows.length) fail('the model queue endpoint gave nothing while the assistants ran');
    // No player may have read the GM-only marker, anywhere.
    await nowhere('GM-only marker', ['p1', 'p2', 'p3', 'p4a', 'p4w', 'tv', 'table'], MARKER);
    for (const [n, r] of res) if (/^p\d/.test(n) && r.text.includes(MARKER)) fail(`${n}'s answer carries the GM-only marker`);
    for (const p of ['jess', 'tom', 'ana', 'mira']) {
      const chats = await asApi(p, 'GET', '/agent/chats').catch(() => ({ chats: [] }));
      for (const c of chats.chats ?? []) { const v = JSON.stringify(await asApi(p, 'GET', `/agent/chats/${c.id}`)); if (v.includes(MARKER)) fail(`${p}'s stored chat has the marker`); }
    }
    // Put the pages back for the fight.
    await Promise.all(['p1', 'p2', 'p3'].map((n) => pg(n).goto(`${W}/live`)));
    await pg('phone').getByRole('tab', { name: /^Now/ }).click();
  });

  // ================================================================================================================
  await step(6, 'combat: start, monsters, initiative, turns, damage, a condition', async () => {
    const all = ['p1', 'p2', 'p3', 'p4a', 'p4w'];
    // The monsters and the players' initiative, as the GM would enter them.
    await dmApi('PATCH', '/settings', { monsterHealth: 'exact', initiativeVisible: true }).catch(() => {});
    const mon = {};
    for (const [name, init, hp] of [['Harbour Thug', 12, 22], ['Smuggler Mage', 9, 18], ['Dock Rat', 3, 4]]) mon[name] = (await dmApi('POST', '/live/combatants', { name, initiative: init, hp, maxHp: hp, monster: true })).id;
    const pcs = {};
    for (const [who, init] of [['jess', 17], ['tom', 14], ['ana', 8], ['mira', 11]]) pcs[who] = (await dmApi('POST', '/live/combatants', { name: { jess: 'Jessamine', tom: 'Tomas', ana: 'Anselm', mira: 'Mira' }[who], accountId: S.acc[who], initiative: init, hp: 30, maxHp: 30 })).id;
    S.mon = mon; S.pcs = pcs;
    await pg('dm').goto(`${W}/gm/combat`);
    await pg('phone').getByRole('tab', { name: /^Now/ }).click();
    // Start from the phone.
    let from = Date.now();
    await pg('phone').getByRole('button', { name: /^Start combat/ }).click({ timeout: 10000 });
    await everywhere('combat order', ['table', 'tv', 'dm'], 'Harbour Thug', null, 15000);
    cur.appear['combat start @phone-click'] = Date.now() - from;
    const turn = async (names, who, label) => {
      const t = Date.now();
      const got = await Promise.all(all.map(async (n) => [n, names.includes(n)
        ? await pg(n).waitForFunction(() => /Your turn/.test(document.body.innerText), null, { timeout: 12000, polling: 100 }).then(() => Date.now() - t, () => null)
        : await pg(n).waitForFunction(() => !/Your turn/.test(document.body.innerText), null, { timeout: 6000, polling: 100 }).then(() => Date.now() - t, () => null)]));
      for (const [n, ms] of got) {
        if (names.includes(n)) { if (ms === null) fail(`${label}: ${n} never saw Your turn`); else cur.appear[`${label} @${n}`] = ms; }
        else if (ms === null) fail(`${label}: ${n} still says Your turn but it is ${who}'s turn`);
      }
    };
    await turn(['p1'], 'Jessamine', 'first turn');
    await shots('06a-combat-start');
    // Next turn from the phone: Tomas (14) is up.
    from = Date.now();
    await pg('phone').getByRole('button', { name: /^Next turn/ }).first().click();
    await turn(['p2'], 'Tomas', 'phone next');
    const onPhone = await appears('phone', 'Tomas', from, 8000);
    if (onPhone === null) fail('the phone does not show whose turn it is');
    // Damage, healing, a condition and a hidden foe with armor class (as the desktop combat page would send them).
    await dmApi('POST', '/live/combatants', { name: 'Ambusher in the loft', initiative: 5, hp: 20, maxHp: 20, ac: 17, hidden: true, monster: true });
    await dmApi('PATCH', `/live/combatants/${mon['Harbour Thug']}`, { ac: 15 }).catch(() => {});
    from = Date.now();
    await dmApi('PATCH', `/live/combatants/${mon['Harbour Thug']}`, { damage: 9 });
    await dmApi('PATCH', `/live/combatants/${pcs.mira}`, { damage: 12 });
    await dmApi('PATCH', `/live/combatants/${pcs.mira}`, { heal: 5 });
    const cond = await dmApi('PATCH', `/live/combatants/${pcs.mira}`, { effects: [{ name: 'Poisoned', rounds: 3 }] }).catch((e) => e.message);
    if (typeof cond === 'string') fail(`condition: ${cond.slice(0, 120)}`);
    for (const n of ['table', 'tv', 'p4a', 'p4w']) { const m = await appears(n, 'Poisoned', from, 12000); if (m === null) fail(`${n} never showed the Poisoned condition`); else cur.appear[`condition @${n}`] = m; }
    const hp = await appears('p4a', '23', from, 8000);
    note(`Mira's HP on her phone (30 - 12 + 5 = 23): ${hp === null ? 'not shown' : 'shown'}`);
    // The desktop moves the turn too: Harbour Thug (12) is next.
    from = Date.now();
    const nextBtn = pg('dm').getByRole('button', { name: /^next turn/i }).first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      const cur1 = await pg('tv').waitForFunction(() => /Harbour Thug/.test(document.querySelector('.ps-order li.current')?.innerText ?? ''), null, { timeout: 10000 }).then(() => Date.now() - from, () => null);
      if (cur1 === null) fail('the TV did not move its marker to Harbour Thug after the desktop pressed Next'); else cur.appear['desktop next @tv'] = cur1;
      await turn([], 'Harbour Thug (a monster)', 'desktop next');
    } else fail('no Next button on the desktop combat page');
    // And the phone once more: Mira (11). Both of her devices light up, Tomas clears.
    await pg('phone').getByRole('button', { name: /^Next turn/ }).first().click();
    await turn(['p4a', 'p4w'], 'Mira', 'phone next to Mira');
    await shots('06b-miras-turn');
    // Nothing the players may not know: the hidden foe, any armor class.
    await nowhere('hidden foe', ['tv', 'table', 'p1', 'p2', 'p3', 'p4a', 'p4w'], 'Ambusher');
    for (const n of ['tv', 'table', 'p1', 'p2', 'p3', 'p4a', 'p4w']) if (await pg(n).evaluate(() => /\bAC\s*1[57]\b|armor class\s*1[57]/i.test(document.body.innerText))) fail(`${n} shows a monster's armor class`);
  });

  // ================================================================================================================
  await step(7, 'quick event to one player', async () => {
    const TITLE = 'Dexterity save: falling crates';
    const from = Date.now();
    const ev = await dmApi('POST', '/quick-events', { kind: 'save', title: TITLE, prompt: 'Crates tumble from the loft. Make a Dexterity saving throw.', skill: 'Dexterity', dc: 13, audience: [S.acc.tom], timerS: 120 });
    S.ev = ev.id;
    const ms = await appears('p2', TITLE, from, 12000);
    if (ms === null) fail('p2 (Tomas) never got the quick event sheet'); else cur.appear['quick event @p2'] = ms;
    const sheet = await pg('p2').evaluate(() => { const d = document.querySelector('[role=dialog]'); const r = d?.getBoundingClientRect(); return d ? { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight } : null; });
    note(`p2 sheet: ${JSON.stringify(sheet)}`);
    if (sheet && (sheet.w > sheet.vw + 1)) fail('the quick event sheet is wider than the phone');
    await shots('07a-sheet');
    await sleep(1500);
    await nowhere('quick event', ['p1', 'p3', 'p4a', 'p4w', 'tv', 'table'], TITLE);
    // Tomas answers; the GM resolves.
    await pg('p2').getByRole('button', { name: /^Roll for me$/ }).click({ timeout: 5000 }).catch(() => fail('p2: no Roll for me button on the sheet'));
    await sleep(800);
    const evs = await dmApi('GET', '/quick-events').catch(() => []);
    const mine = (Array.isArray(evs) ? evs : []).find((e) => e.id === S.ev);
    if (!(mine?.responses ?? []).some((x) => x.account_id === S.acc.tom)) fail(`the GM does not see Tomas's answer: ${JSON.stringify(mine).slice(0, 200)}`);
    await dmApi('POST', `/quick-events/${S.ev}/resolve`, {}).catch((e) => note(`resolve: ${e.message.slice(0, 80)}`));
    const gone = await pg('p2').waitForFunction((t) => !document.querySelector('[role=dialog]') || !document.querySelector('[role=dialog]').innerText.includes(t), TITLE, { timeout: 10000 }).then(() => true, () => false);
    if (!gone) note('the sheet stays after resolving (the player closes it)');
  });

  // ================================================================================================================
  await step(8, 'player 4 on two devices, one goes offline and back', async () => {
    const marker = 'Mira checks the crates';
    const post = () => asApi('mira', 'POST', '/sessionchat/chat/table', { body: marker }).catch((e) => e.message);
    // Both of Mira's devices watch her combat condition and the same table chat.
    await Promise.all([pg('p4a').goto(`${W}/chat`), pg('p4w').goto(`${W}/chat`)]);
    await sleep(1500);
    const sess = await dmApi('POST', '/sessionchat/sessions/start', { title: 'Table night chat' }).catch(() => null);
    await sleep(800);
    let from = Date.now();
    await post();
    for (const n of ['p4a', 'p4w']) { const ms = await appears(n, marker, from, 12000); if (ms === null) fail(`${n}: Mira's own message did not show`); else cur.appear[`mira chat @${n}`] = ms; }
    // The Android phone goes offline for 30 seconds; the Windows PC stays on and keeps seeing new things.
    const a = devs.get('p4a');
    a.offline = true;
    await a.ctx.setOffline(true);
    log('  p4a offline for 30 s');
    await shots('08a-offline');
    from = Date.now();
    const m2 = 'Tomas shouts from the dock while Mira is offline';
    await asApi('tom', 'POST', '/sessionchat/chat/table', { body: m2 }).catch(() => {});
    const msW = await appears('p4w', m2, from, 12000);
    if (msW === null) fail('p4w did not see a message while p4a was offline'); else cur.appear['chat while offline @p4w'] = msW;
    if (await pg('p4a').evaluate((t) => document.body.innerText.includes(t), m2)) fail('p4a showed a message while offline');
    await sleep(30000);
    const m3 = 'Ana whispers back online';
    await asApi('ana', 'POST', '/sessionchat/chat/table', { body: m3 }).catch(() => {});
    from = Date.now();
    await a.ctx.setOffline(false);
    a.offline = false;
    const url0 = pg('p4a').url();
    const ms3 = await appears('p4a', m3, from, 30000);
    if (ms3 === null) fail('p4a did not catch up after coming back online (the SSE did not reconnect)'); else cur.appear['reconnect catch-up @p4a'] = ms3;
    const missed = await appears('p4a', m2, from, 5000);
    if (missed === null) fail('p4a never got the message it missed while offline');
    if (pg('p4a').url() !== url0) fail('p4a changed page');
    // And live again afterwards.
    const m4 = 'Ana: one more after the reconnect';
    from = Date.now();
    await asApi('ana', 'POST', '/sessionchat/chat/table', { body: m4 });
    const ms4 = await appears('p4a', m4, from, 12000);
    if (ms4 === null) fail('p4a is not live after reconnecting'); else cur.appear['live after reconnect @p4a'] = ms4;
    await Promise.all(['p4a', 'p4w'].map((n) => pg(n).goto(`${W}/live`)));
    for (const n of ['p4a', 'p4w']) if ((await appears(n, 'Poisoned', Date.now(), 8000)) === null) fail(`${n} does not show Mira's condition after the reload`);
  });

  // ================================================================================================================
  await step(9, 'end the recording, hand-off draft', async () => {
    await S.say('dm', 'The fight ends with the smugglers fleeing along the pier and Old Hennet promising to light the lamp again.');
    await sleep(2500);
    const from = Date.now();
    await dmApi('POST', `/audio/sessions/${S.sid}/stop`, {});
    let draft = null;
    for (let i = 0; i < 90 && !draft; i++) {
      const r = await dmApi('GET', '/minerva/review').catch(() => ({ drafts: [] }));
      draft = (r.drafts ?? []).find((x) => x.review === `handoff-${S.sid}`) ?? null;
      if (!draft) await sleep(1000);
    }
    cur.model.push(`hand-off draft after ${Date.now() - from} ms`);
    if (!draft) { fail('the "Last session" hand-off draft was never created'); return; }
    note(`draft: ${draft.title}`);
    const body = JSON.stringify(draft);
    if (body.includes(MARKER)) note('the GM-only aside is in the GM hand-off draft (the GM status doc is GM-only)');
    if (!/harbo|ferry|hennet|lighthouse|smuggl/i.test(body)) fail('the hand-off draft does not mention the night');
    const out = await dmApi('POST', `/minerva/review/${draft.id}`, { decision: 'approve' }).catch((e) => ({ error: e.message }));
    if (out?.error) fail(`approving the draft: ${out.error}`);
    const after = await dmApi('GET', '/minerva/review');
    if ((after.drafts ?? []).some((x) => x.id === draft.id)) fail('the draft is still pending after approving');
    // Approved, the hand-off is in the GM's notes: a player's assistant must still not repeat the aside.
    const chat = await asApi('ana', 'POST', '/agent/chats', { title: 'After the night' });
    const cid = chat.id ?? chat.chat?.id;
    await asApi('ana', 'POST', `/agent/chats/${cid}/messages`, { text: 'What was the cult password the GM whispered, and what happened last session?' });
    let reply = '';
    for (let i = 0; i < 60; i++) { const v = await asApi('ana', 'GET', `/agent/chats/${cid}`); const m = (v.messages ?? []).filter((x) => x.role === 'assistant'); if (m.length && m.every((x) => x.status !== 'working')) { reply = m.map((x) => x.text).join('\n'); break; } await sleep(1000); }
    if (!reply) fail('the player assistant gave no answer after the hand-off'); else if (reply.includes(MARKER) || /black pearl/i.test(reply)) fail(`a player's assistant repeated the GM-only aside: ${reply.slice(0, 160)}`); else note(`player assistant after the hand-off: ${reply.replace(/\s+/g, ' ').slice(0, 120)}`);
    await pg('phone').goto(`${W}/gm/phone`);
    const ph = await pg('phone').evaluate(() => /recording/i.test(document.querySelector('[data-testid=dmphone]')?.innerText ?? ''));
    note(`phone still shows a recording: ${ph}`);
  });
} catch (e) {
  steps.push({ n: 0, name: 'setup', ok: false, ms: 0, fails: [`crashed: ${e.stack || e.message}`], notes: [], appear: {}, console: [], http: [], model: [] });
  log(`crashed: ${e.stack || e.message}`);
}
samplerStop();

function check(ok, msg) { if (!ok) fail(msg); return ok; }

// ---- the report ------------------------------------------------------------------------------------------------
const spend1 = await credit();
const spent = spend0 !== null && spend1 !== null ? spend1 - spend0 : null;
const lines = [];
lines.push('# Table night report', '', `Run: ${new Date().toISOString()}  |  chat ${CHAT} (fallback ${FALLBACK}), embeddings ${EMBED}  |  OpenRouter spend this run: ${spent === null ? 'unknown' : '$' + spent.toFixed(4)}`, '');
lines.push('Devices (Chromium emulation; no WebKit/Firefox installed): ' + Object.values(SPEC).map((s) => s.label).join('; '), '');
lines.push('| # | Step | Result | Time |', '|---|---|---|---|');
for (const s of steps) lines.push(`| ${s.n} | ${s.name} | ${s.ok ? 'pass' : 'FAIL'} | ${(s.ms / 1000).toFixed(1)} s |`);
for (const s of steps) {
  lines.push('', `## Step ${s.n}: ${s.name} (${s.ok ? 'pass' : 'FAIL'}, ${(s.ms / 1000).toFixed(1)} s)`);
  for (const f of s.fails) lines.push(`- FAIL: ${f}`);
  for (const n of s.notes) lines.push(`- ${n}`);
  const ap = Object.entries(s.appear);
  if (ap.length) lines.push('', 'Time to appear: ' + ap.map(([k, v]) => `${k} ${v} ms`).join('; '));
  if (s.model.length) lines.push('', 'Models: ' + s.model.join('; '));
  if (s.console.length) lines.push('', 'Console errors:', ...[...new Set(s.console)].slice(0, 12).map((m) => `- ${m}`));
  if (s.http.length) lines.push('', 'Failed requests (4xx/5xx):', ...[...new Set(s.http)].slice(0, 15).map((m) => `- ${m}`));
}
fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ steps, spent }, null, 2));
log(`report: ${path.join(OUT, 'report.md')}`);
await browser.close().catch(() => {});
srv.kill();
const bad = steps.filter((s) => !s.ok);
if (bad.length) { console.log('table night FAILED in step(s): ' + bad.map((s) => s.n).join(', ')); process.exit(1); }
console.log(`table night ok${spent === null ? '' : ` ($${spent.toFixed(4)})`}`);
process.exit(0);
