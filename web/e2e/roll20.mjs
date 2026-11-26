// End-to-end test of the Roll20 connection, with the real scripts:
// - the DM opens DM → Roll20, makes a bridge key and downloads the bridge;
// - a stand-in Roll20 game page (served for app.roll20.net by the test) runs
//   the real Mod script in a fake Mod sandbox (librarian/test/roll20-sandbox.js)
//   and the downloaded bridge userscript, with a GM_xmlhttpRequest like
//   Tampermonkey's;
// - HP, markers, rolls and a handout then move both ways through the chat.
// Run from web/: npm run build && node e2e/roll20.mjs   (ROLL20_PORT, default 19822)
// ROLL20_SHOTS=<dir> also saves screenshots there.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.ROLL20_PORT || 19822);
const SHOTS = process.env.ROLL20_SHOTS || '';
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

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('roll20'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json());
const dmLogin = await login('dm', 'dungeon master 123');
const jessLogin = await login('jess', 'player pass 123');
const WID = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + dmLogin.token } })).json())[0].id;
const api = async (token, method, p, body) => {
  const r = await fetch(`${base}/api/worlds/${WID}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const jessId = jessLogin.account.id;
const tomLogin = await login('tom', 'player pass 123');
const tomLoginToken = () => tomLogin.token;

const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
}

try {
  // ---- the DM sets up ----
  const dmCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, deviceScaleFactor: SHOTS ? 2 : 1 });
  const dm = await dmCtx.newPage();
  watch(dm, 'dm');
  await dm.goto(base + '/login');
  await dm.getByLabel(/username/i).fill('dm');
  await dm.getByLabel(/password/i).fill('dungeon master 123');
  await dm.getByRole('button', { name: /sign in|log in/i }).click();
  await dm.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  await dm.goto(`${base}/w/saltreach/dm/roll20`);
  await dm.getByText('Not set up').waitFor();
  await shot(dm, '1-dm-roll20-before');
  await dm.getByRole('button', { name: 'Make a bridge key' }).click();
  const key = (await dm.getByTestId('roll20-key').textContent()).trim();
  check(/^alx_r20_/.test(key), `key shown once: ${key}`);
  const [dl] = await Promise.all([dm.waitForEvent('download'), dm.getByRole('button', { name: 'Download the bridge' }).click()]);
  const bridgeJs = fs.readFileSync(await dl.path(), 'utf8');
  check(dl.suggestedFilename() === 'alexandria-bridge.user.js', 'bridge file name');
  check(bridgeJs.includes(JSON.stringify(key)) && bridgeJs.includes(JSON.stringify(base)), 'the bridge has the address and key in it');
  const modJs = (await api(dmLogin.token, 'GET', '/roll20/files/alexandria.mod.js')).text;
  note('key made, bridge downloaded');

  // ---- a stand-in Roll20 game with the Mod and the bridge ----
  const sandboxJs = fs.readFileSync(path.join(root, 'librarian/test/roll20-sandbox.js'), 'utf8');
  const gameHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Test game</title><style>
    body{margin:0;font:14px system-ui,sans-serif;background:#2b2f36;color:#ddd;display:flex;height:100vh}
    #board{flex:1;position:relative;background:#3c4a3b;background-image:linear-gradient(#0002 1px,transparent 1px),linear-gradient(90deg,#0002 1px,transparent 1px);background-size:70px 70px}
    #board h1{position:absolute;top:8px;left:12px;margin:0;font-size:13px;font-weight:500;color:#fffa;background:#0006;padding:4px 8px;border-radius:6px}
    .tok{position:absolute;width:90px;text-align:center}
    .tok .c{width:64px;height:64px;border-radius:50%;margin:0 auto;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:20px;color:#fff}
    .tok .bar{height:7px;background:#400;border-radius:4px;margin:4px 6px}.tok .bar i{display:block;height:100%;background:#3a3;border-radius:4px}
    .tok .n{font-size:12px}.tok .m{font-size:11px;color:#fc6;min-height:14px}
    #textchat{width:360px;background:#f4f4f4;color:#222;display:flex;flex-direction:column}
    #textchat .content{flex:1;overflow:auto;padding:8px}.message{padding:6px 4px;border-bottom:1px solid #ddd}.message .by{font-weight:600}
    .message.whisper{background:#eef}.message.api{color:#888}
    #textchat-input{display:flex;gap:6px;padding:8px;border-top:1px solid #ccc}#textchat-input textarea{flex:1;height:44px}
    </style></head><body><div id="board"><h1>Test game (a stand-in for a Roll20 game)</h1></div>
    <div id="textchat"><div class="content"></div><div id="textchat-input"><textarea></textarea><button class="btn">Send</button></div></div></body></html>`;
  const game = await (await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  watch(game, 'game');
  await game.route('https://app.roll20.net/**', (r) => r.fulfill({ contentType: 'text/html', body: gameHtml }));
  // Tampermonkey's GM_xmlhttpRequest: the request is made outside the page (no CORS).
  await game.exposeFunction('__gmXhr', async (o) => {
    const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.data });
    return { status: r.status, responseText: await r.text() };
  });
  await game.goto('https://app.roll20.net/editor/');
  await game.addScriptTag({ content: sandboxJs });
  await game.evaluate(() => {
    const sb = window.makeRoll20Sandbox({});
    window.__sb = sb;
    Object.assign(window, sb.api);
    window.state = sb.api.state;
    const log = document.querySelector('#textchat .content');
    // What the GM sees in the chat: open lines, and whispers to the GM.
    sb.api.onChatLine = (m) => {
      if (m.type === 'api') return;
      const d = document.createElement('div');
      d.className = `message ${m.type}`;
      d.innerHTML = `<span class="by"></span> <span class="t"></span>`;
      d.querySelector('.by').textContent = (m.type === 'whisper' ? '(To GM) ' : '') + m.who + ':';
      d.querySelector('.t').textContent = m.inlinerolls ? m.content.replace(/\$\[\[(\d+)\]\]/g, (_, i) => `[${m.inlinerolls[i].results.total}]`) : m.content;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };
    // The GM pressing Send.
    const ta = document.querySelector('#textchat-input textarea');
    document.querySelector('#textchat-input .btn').addEventListener('click', () => { const t = ta.value; ta.value = ''; if (t) sb.say(window.__gm.id, t); });
    window.GM_xmlhttpRequest = (o) => window.__gmXhr({ method: o.method, url: o.url, headers: o.headers, data: o.data }).then((r) => o.onload(r), () => o.onerror());
    window.__gm = sb.addPlayer('The DM', true);
    const pj = sb.addPlayer('jess', false), pt = sb.addPlayer('tom', false);
    window.__pj = pj;
    window.__toks = [
      ['Jessamine', pj.id, 24, 24, '#7b4bb3', 120, 160], ['Tomas', pt.id, 31, 31, '#b35b2e', 300, 260], ['Goblin', null, 7, 7, '#556b2f', 520, 180],
    ].map(([name, owner, hp, max, color, x, y]) => ({ ...sb.addCharacter(name, owner ? [owner] : [], hp, max), color, x, y }));
    // Draw the tokens from the game's state.
    const board = document.getElementById('board');
    const draw = () => {
      for (const t of window.__toks) {
        let el = document.getElementById('tok-' + t.ch.id);
        if (!el) { el = document.createElement('div'); el.className = 'tok'; el.id = 'tok-' + t.ch.id; el.style.left = t.x + 'px'; el.style.top = t.y + 'px'; el.innerHTML = '<div class="c"></div><div class="bar"><i></i></div><div class="n"></div><div class="m"></div>'; board.appendChild(el); }
        const a = sb.attr(t.ch.id, 'hp');
        const hp = Number(a.get('current')), max = Number(a.get('max')) || 1;
        el.querySelector('.c').style.background = t.color;
        el.querySelector('.c').textContent = t.ch.get('name')[0];
        el.querySelector('.bar i').style.width = Math.max(0, Math.min(100, (hp / max) * 100)) + '%';
        el.querySelector('.n').textContent = `${t.ch.get('name')} ${hp}/${max}`;
        el.querySelector('.m').textContent = t.tok.get('statusmarkers').split(',').filter(Boolean).join(' · ');
      }
    };
    setInterval(draw, 200);
    draw();
  });
  await game.addScriptTag({ content: modJs });
  await game.evaluate(() => window.__sb.ready());
  await game.addScriptTag({ content: bridgeJs });
  note('game page up with the Mod and the bridge');

  // ---- connected: the characters are linked by name ----
  await until(async () => (await game.locator('#alx-bridge').textContent()) === 'Alexandria: Connected', 'bridge says Connected');
  const st = await until(async () => { const s = await api(dmLogin.token, 'GET', '/roll20'); return s.links.length === 2 ? s : null; }, 'two characters linked');
  check(st?.online === true, 'the DM sees the bridge online');
  check(st?.links.find((l) => l.name === 'Jessamine')?.accountId === jessId, 'Jessamine linked to jess');
  check(await game.locator('.message:has-text("ALX::")').evaluateAll((els) => els.every((e) => getComputedStyle(e).display === 'none')), 'bridge lines are hidden in the chat');
  // The demo already has HP for Jessamine? Whatever it had, Roll20 filled only what was missing.
  const jessHpStart = (await api(dmLogin.token, 'GET', `/sheet/${jessId}`)).hp;
  note(`linked; Jessamine's HP in Alexandria: ${jessHpStart}`);

  // Right after linking, Alexandria sends its numbers once; wait for that before playing.
  await until(async () => (await api(dmLogin.token, 'GET', '/roll20')).activity.some((a) => a.dir === 'out' && a.text.startsWith('Jessamine')), 'first push to Roll20');
  await game.waitForTimeout(1500);
  // ---- Roll20 → Alexandria: damage on the token ----
  await game.evaluate(() => { const t = window.__toks[0]; window.__sb.userSet(window.__sb.attr(t.ch.id, 'hp'), 'current', '15'); });
  await until(async () => (await api(dmLogin.token, 'GET', `/sheet/${jessId}`)).hp === 15, 'Roll20 damage reaches the sheet');
  // ---- Alexandria → Roll20: the DM poisons and hurts her ----
  await api(dmLogin.token, 'POST', `/sheet/${jessId}/vitals`, { damage: 4, conditions: ['Poisoned'] });
  await until(() => game.evaluate(() => { const t = window.__toks[0]; return window.__sb.attr(t.ch.id, 'hp').get('current') === 11 && t.tok.get('statusmarkers') === 'chemical-bolt'; }), 'Alexandria damage and condition reach Roll20');
  // ---- a marker added in Roll20 ----
  await game.evaluate(() => { const t = window.__toks[0]; window.__sb.userSet(t.tok, 'statusmarkers', 'chemical-bolt,grab'); });
  await until(async () => (await api(dmLogin.token, 'GET', `/sheet/${jessId}`)).conditions.includes('Grappled'), 'a marker becomes a condition');
  note('HP and conditions moved both ways');

  // ---- a roll in Roll20 lands in the table chat ----
  await api(dmLogin.token, 'POST', '/sessionchat/sessions/start', { title: 'Roll20 night' }).catch(() => null);
  await game.evaluate(() => window.__sb.say(window.__pj.id, '&{template:default} {{name=Rapier}} {{attack=$[[0]]}}', { who: 'Jessamine', inlinerolls: [{ expression: '1d20+6', results: { total: 19, rolls: [{ type: 'R', results: [{ v: 13 }] }] } }] }));
  const roll = await until(async () => (await api(jessLogin.token, 'GET', '/sessionchat/chat/table')).messages.find((m) => m.kind === 'roll' && m.roll.total === 19), 'the Roll20 roll in the table chat');
  check(roll?.authorId === jessId && /Rapier/.test(roll?.roll.note ?? ''), 'rolled by Jessamine, labelled Rapier');

  // ---- the DM sends a handout and a line from the Roll20 page ----
  await dm.reload();
  const shared = (await api(dmLogin.token, 'GET', '/library/pages')).find((p) => p.visibility === 'party');
  await dm.getByLabel('Library page').fill(shared.title);
  await dm.getByRole('button', { name: 'Send as a handout' }).click();
  await dm.getByLabel('Say in the Roll20 chat').fill('The tide turns. Roll initiative!');
  await dm.getByRole('button', { name: 'Say it' }).click();
  await until(() => game.evaluate((t) => window.__sb.api.findObjs({ _type: 'handout', name: t }).length === 1, shared.title), 'the handout is in the game');
  await until(() => game.locator('.message:has-text("Roll initiative")').count(), 'the line is in the Roll20 chat');
  // The GM was typing when all this arrived: their text is still there.
  await game.locator('#textchat-input textarea').fill('half-typed note');
  await api(dmLogin.token, 'POST', '/roll20/say', { text: 'One more line' });
  await until(() => game.locator('.message:has-text("One more line")').count(), 'second line');
  await until(async () => (await game.locator('#textchat-input textarea').inputValue()) === 'half-typed note', 'what the GM was typing is kept');
  await game.locator('#textchat-input textarea').fill('');
  note('handout and chat lines sent');

  // ---- what the DM sees ----
  await dm.reload();
  await dm.getByText(/Connected/).first().waitFor();
  await dm.getByText(/Jessamine: HP/).first().waitFor();
  await shot(dm, '2-dm-roll20-connected');
  await dm.getByText('Condition → status marker').click();
  await dm.locator('section[aria-label="What moves"]').scrollIntoViewIfNeeded();
  await shot(dm, '3-dm-roll20-options');
  await shot(game, '4-test-game-with-bridge');
  await dm.goto(`${base}/w/saltreach/dm/sheets`);
  await dm.waitForTimeout(800);
  await shot(dm, '5-sheet-log-from-roll20');

  // ======== a game without the Mod script (no Roll20 Pro): the bridge works alone ========
  await game.context().close();
  const free = await (await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: SHOTS ? 2 : 1 })).newPage();
  watch(free, 'free game');
  await free.route('https://app.roll20.net/**', (r) => r.fulfill({ contentType: 'text/html', body: gameHtml.replace('a stand-in for a Roll20 game', 'a stand-in for a Roll20 game, no Mod script') }));
  await free.exposeFunction('__gmXhr', async (o) => {
    const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.data });
    return { status: r.status, responseText: await r.text() };
  });
  await free.goto('https://app.roll20.net/editor/');
  await free.evaluate(() => {
    // The page's own game data, shaped like Roll20's (Backbone models and collections).
    function M(a) { this.attributes = a; this.id = a.id; }
    M.prototype.get = function (k) { return this.attributes[k]; };
    M.prototype.set = function (o) { Object.assign(this.attributes, o); };
    M.prototype.save = function (o) { this.set(o); };
    function C(ms) { this.models = ms || []; }
    C.prototype.get = function (id) { return this.models.find((m) => m.id === id); };
    C.prototype.create = function (a) { const m = new M({ id: 'h' + this.models.length, ...a }); m.updateBlobs = (b) => { m.blobs = { ...b }; }; this.models.push(m); return m; };
    const players = new C([new M({ id: 'p-gm', displayname: 'The DM' }), new M({ id: 'p-jess', displayname: 'jess' }), new M({ id: 'p-tom', displayname: 'tom' })]);
    const mk = (id, name, owner, hp, max, color, x, y) => {
      const ch = new M({ id, name, controlledby: owner });
      ch.attribs = new C([new M({ id: id + '-hp', name: 'hp', current: String(hp), max: String(max) }), new M({ id: id + '-tmp', name: 'hp_temp', current: '0', max: '' })]);
      const tok = new M({ id: id + '-tok', represents: id, bar1_value: String(hp), bar1_max: String(max), bar1_link: id + '-hp', statusmarkers: '' });
      return { ch, tok, color, x, y };
    };
    window.__toks = [mk('c-jess', 'Jessamine', 'p-jess', 24, 24, '#7b4bb3', 120, 160), mk('c-tom', 'Tomas', 'p-tom', 31, 31, '#b35b2e', 300, 260), mk('c-gob', 'Goblin', '', 7, 7, '#556b2f', 520, 180)];
    const page = new M({ id: 'pg1', name: 'Docks' });
    page.thegraphics = new C(window.__toks.map((t) => t.tok));
    const camp = new M({ id: 'camp', name: 'Free game', token_markers: '[]' });
    camp.characters = new C(window.__toks.map((t) => t.ch));
    camp.players = players;
    camp.handouts = new C([]);
    camp.pages = new C([page]);
    window.Campaign = camp;

    // The chat: what the GM types shows as a message (an unknown !command too, as a game without the Mod would).
    const log = document.querySelector('#textchat .content');
    let n = 0;
    window.__msg = (who, html, cls) => {
      const d = document.createElement('div');
      d.className = 'message ' + (cls || 'general');
      d.setAttribute('data-messageid', '-m' + n++);
      d.innerHTML = (who ? '<span class="by"></span>' : '') + html;
      if (who) d.querySelector('.by').textContent = who + ':';
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };
    const ta = document.querySelector('#textchat-input textarea');
    document.querySelector('#textchat-input .btn').addEventListener('click', () => {
      const t = ta.value; ta.value = '';
      const as = /^\/as "([^"]+)" (.*)$/s.exec(t);
      if (as) window.__msg(as[1], '<span class="t"></span>'), log.lastChild.querySelector('.t').textContent = as[2];
      else window.__msg('The DM', '<span class="t"></span>'), log.lastChild.querySelector('.t').textContent = t;
    });
    window.GM_xmlhttpRequest = (o) => window.__gmXhr({ method: o.method, url: o.url, headers: o.headers, data: o.data }).then((r) => o.onload(r), () => o.onerror());
    // An old roll already in the chat when the game opens is history, not a new roll.
    window.__msg('Jessamine', '<div class="formula">rolling 1d20</div><div class="formula formattedformula"><div class="diceroll d20"><div class="didroll">20</div></div></div><strong>=</strong><div class="rolled">20</div>', 'rollresult');
    const board = document.getElementById('board');
    const draw = () => {
      for (const t of window.__toks) {
        let el = document.getElementById('tok-' + t.ch.id);
        if (!el) { el = document.createElement('div'); el.className = 'tok'; el.id = 'tok-' + t.ch.id; el.style.left = t.x + 'px'; el.style.top = t.y + 'px'; el.innerHTML = '<div class="c"></div><div class="bar"><i></i></div><div class="n"></div><div class="m"></div>'; board.appendChild(el); }
        const a = t.ch.attribs.models[0];
        const hp = Number(a.get('current')), max = Number(a.get('max')) || 1;
        el.querySelector('.c').style.background = t.color;
        el.querySelector('.c').textContent = t.ch.get('name')[0];
        el.querySelector('.bar i').style.width = Math.max(0, Math.min(100, (hp / max) * 100)) + '%';
        el.querySelector('.n').textContent = `${t.ch.get('name')} ${hp}/${max}`;
        el.querySelector('.m').textContent = t.tok.get('statusmarkers').split(',').filter(Boolean).join(' · ');
      }
    };
    setInterval(draw, 200);
    draw();
  });
  await free.addScriptTag({ content: bridgeJs });
  await until(async () => (await free.locator('#alx-bridge').textContent()) === 'Alexandria: Connected (no Mod script)', 'bridge works alone without the Mod', 20000);
  check(await free.locator('.message:has-text("!alx-in")').evaluateAll((els) => els.length > 0 && els.every((e) => getComputedStyle(e).display === 'none')), 'the one hidden command a game without the Mod shows is hidden');
  const fst = await until(async () => { const s = await api(dmLogin.token, 'GET', '/roll20'); return s.mode === 'free' && s.links.some((l) => l.id === 'c-jess' && l.accountId === jessId) ? s : null; }, 'free mode linked Jessamine');
  check(fst?.modVersion === null, 'no Mod version in free mode');
  // Alexandria sends its numbers once to the newly linked characters; let that land first.
  await free.waitForTimeout(5000);
  // A player changes HP on their Roll20 sheet: the bridge sees it in the page data.
  await free.evaluate(() => window.__toks[0].ch.attribs.models[0].set({ current: '9' }));
  await until(async () => (await api(dmLogin.token, 'GET', `/sheet/${jessId}`)).hp === 9, 'free mode: Roll20 HP reaches the sheet');
  // The DM heals her and makes her prone in Alexandria.
  await api(dmLogin.token, 'POST', `/sheet/${jessId}/vitals`, { heal: 6, conditions: ['Prone'] });
  await until(() => free.evaluate(() => window.__toks[0].ch.attribs.models[0].get('current') === 15 && window.__toks[0].tok.get('statusmarkers') === 'back-pain'), 'free mode: Alexandria HP and condition reach Roll20');
  await free.waitForTimeout(2500);
  check((await api(dmLogin.token, 'GET', `/sheet/${jessId}`)).hp === 15, 'free mode: what Alexandria set is not sent back as a change');
  // Rolls drawn in the chat: a /roll, a template with inline rolls; a whisper stays private.
  const before20 = (await api(jessLogin.token, 'GET', '/sessionchat/chat/table')).messages.length;
  await free.evaluate(() => {
    window.__msg('Tomas', '<div class="formula">rolling 1d20+3</div><div class="formula formattedformula"><div class="diceroll d20"><div class="didroll">11</div></div>+3</div><strong>=</strong><div class="rolled">14</div>', 'rollresult');
    window.__msg('Jessamine', '<table class="sheet-rolltemplate-default"><caption>Shortbow</caption><tr><td>Attack</td><td><span class="inlinerollresult showtip" title="Rolling 1d20+6 = (&lt;span class=&quot;basicdiceroll&quot;&gt;9&lt;/span&gt;)+6">15</span></td></tr></table>', 'general');
    window.__msg('Tomas', '<span class="inlinerollresult" title="Rolling 1d20 = (&lt;span class=&quot;basicdiceroll&quot;&gt;2&lt;/span&gt;)">2</span>', 'whisper');
  });
  const msgs = await until(async () => { const m = (await api(jessLogin.token, 'GET', '/sessionchat/chat/table')).messages; return m.length >= before20 + 2 ? m : null; }, 'free mode: chat rolls reach the table chat');
  const r1 = msgs?.find((m) => m.kind === 'roll' && m.roll.total === 14);
  const r2 = msgs?.find((m) => m.kind === 'roll' && m.roll.total === 15);
  check(r1 && r1.roll.expr === '1d20+3' && r1.roll.terms[0].dice[0] === 11, `free mode /roll: ${JSON.stringify(r1?.roll)}`);
  check(r2 && r2.authorId === jessId && /Shortbow/.test(r2.roll.note) && r2.roll.terms[0].dice[0] === 9, `free mode template roll: ${JSON.stringify(r2?.roll)}`);
  check(!msgs?.some((m) => m.kind === 'roll' && (m.roll.total === 2 || m.roll.total === 20)), 'whispers and old chat history are not sent');
  // A line, a handout and a table roll from Alexandria.
  await api(dmLogin.token, 'PATCH', '/settings', { roll20RollsOut: true });
  await api(dmLogin.token, 'POST', '/roll20/say', { text: 'The {{bell}} tolls [[1d6]].' });
  await api(dmLogin.token, 'POST', '/roll20/handout', { page: shared.title, players: true });
  await api(tomLoginToken(), 'POST', '/sessionchat/chat/table', { body: '/roll 2d6 courage' });
  await until(() => free.locator('.message:has-text("((bell)) tolls 1d6.")').count(), 'free mode: chat line typed as Alexandria (no templates or rolls)');
  const ho = await until(() => free.evaluate((t) => { const h = window.Campaign.handouts.models.find((m) => m.get('name') === t); return h ? { j: h.get('inplayerjournals'), notes: h.blobs?.notes ?? '' } : null; }, shared.title), 'free mode: handout made');
  check(ho?.j === 'all' && ho?.notes.length > 0, 'free mode handout in players journals with notes');
  await until(() => free.locator('.message:has-text("rolls 2d6")').count(), 'free mode: table roll shown in Roll20');
  await shot(free, '6-test-game-no-mod');
  await dm.goto(`${base}/w/saltreach/dm/roll20`);
  await dm.getByText(/Without the Mod script/).first().waitFor();
  await shot(dm, '7-dm-roll20-no-mod');
  note('without the Mod: HP, conditions, rolls, lines and handouts moved');
} catch (e) {
  problems.push(`crashed: ${e.stack ?? e}`);
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) {
  console.log(`roll20: ${problems.length} problem(s)`);
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('roll20: all good');
