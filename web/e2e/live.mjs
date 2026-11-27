// Live sync with several people at once: the GM and three players, each in their own browser, on different pages.
// The GM changes things (and one player does); every open page must show it by itself, without a reload, within a
// few seconds. Each check reports how long the change took to appear. Run: node e2e/live.mjs
import { chromium, root, signIn, startScript, tmpDir } from './lib.mjs';

const PORT = Number(process.env.LIVE_PORT || 8831);
const base = `http://127.0.0.1:${PORT}`;
const W = '/api/worlds/saltreach';
const data = tmpDir('live');
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', data], 'Press Ctrl', 'demo');
void root;
const browser = await chromium.launch();
const fails = [];
const api = async (tok, method, p, body) => {
  const r = await fetch(base + W + p, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const token = async (u, p) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token;
/** Do `act`, then wait until every page shows `text` (no reload). */
async function expectEverywhere(name, pages, text, act) {
  const t0 = Date.now();
  await act();
  for (const [who, page] of pages) {
    try {
      await page.waitForFunction((s) => document.body.innerText.includes(s), text, { timeout: 8000 });
      console.log(`  ok ${name}: ${who} saw it after ${Date.now() - t0} ms`);
    } catch {
      fails.push(`${name}: ${who} never saw "${text}" without a reload`);
      console.log(`  FAIL ${name}: ${who} did not see it`);
    }
  }
}

try {
  const view = { width: 1280, height: 800 };
  const gm = await signIn(browser, base, 'gm', 'game master 123', view);
  const jess = await signIn(browser, base, 'jess', 'player pass 123', view);
  const tom = await signIn(browser, base, 'tom', 'player pass 123', { width: 390, height: 844 }, true);
  const ana = await signIn(browser, base, 'ana', 'player pass 123', view);
  const T = { gm: await token('gm', 'game master 123'), jess: await token('jess', 'player pass 123'), tom: await token('tom', 'player pass 123'), ana: await token('ana', 'player pass 123') };
  const members = await api(T.gm, 'GET', '/members');
  const acc = Object.fromEntries(members.map((m) => [m.display_name.toLowerCase(), m.id]));

  // Each person on a different page, like a real table.
  await gm.page.goto(base + '/w/saltreach/gm/combat');
  await jess.page.goto(base + '/w/saltreach/live');
  await tom.page.goto(base + '/w/saltreach/stage');
  await ana.page.goto(base + '/w/saltreach/inventory');
  await new Promise((r) => setTimeout(r, 2500));

  console.log('combat: the GM adds a creature and starts the fight');
  await expectEverywhere('combat', [['jess /live', jess.page], ['gm /combat', gm.page]], 'Sync Wolf', async () => {
    await api(T.gm, 'POST', '/live/combatants', { name: 'Sync Wolf', initiative: 15, hp: 11, maxHp: 11 });
    await api(T.gm, 'PUT', '/live/combat', { active: true });
  });

  console.log('stage: the GM shows a card');
  await expectEverywhere('stage', [['tom /stage (phone)', tom.page]], 'Sync Lighthouse Card', async () => {
    await api(T.gm, 'POST', '/stage/cards', { kind: 'text', title: 'Sync Lighthouse Card', text: 'The lamp flickers.', show: true });
  });

  console.log('inventory: the GM gives Ana an item');
  await expectEverywhere('inventory', [['ana /inventory', ana.page]], 'Sync Brass Compass', async () => {
    await api(T.gm, 'POST', '/inventory', { owner: acc.ana, name: 'Sync Brass Compass', qty: 1, reason: 'found on the pier' });
  });

  console.log('clock: the GM moves the world clock (shown in every header)');
  const before = (await api(T.gm, 'GET', '/clock')).label;
  await api(T.gm, 'POST', '/clock/advance', { minutes: 1440, reason: 'sync test' });
  const after = (await api(T.gm, 'GET', '/clock')).label;
  const day = String(after).split(' ').slice(0, 2).join(' ');
  if (before === after) fails.push('clock: the clock did not move');
  else await expectEverywhere('clock', [['jess', jess.page], ['tom (phone)', tom.page], ['ana', ana.page], ['gm', gm.page]], day, async () => {});

  console.log('session chat: a player writes, the GM and another player see it');
  try { await api(T.gm, 'POST', '/sessionchat/sessions/start', { title: 'Sync night' }); } catch { /* already running */ }
  await gm.page.goto(base + '/w/saltreach/gm/chat');
  await jess.page.goto(base + '/w/saltreach/chat');
  await new Promise((r) => setTimeout(r, 2000));
  await expectEverywhere('chat', [['gm /chat', gm.page], ['jess /chat', jess.page]], 'Sync: Tomas waves from the dock', async () => {
    await api(T.tom, 'POST', '/sessionchat/chat/table', { body: 'Sync: Tomas waves from the dock' });
  });

  // A top-level page: one inside a folder is listed too, but the folder starts folded, so its title is not on screen.
  console.log('library: the GM shares a new page; a player\'s library shows it');
  await ana.page.goto(base + '/w/saltreach/library');
  await new Promise((r) => setTimeout(r, 2000));
  await expectEverywhere('library', [['ana /library', ana.page]], 'Sync Harbour Chart', async () => {
    await api(T.gm, 'PUT', '/library/pages', { path: 'Sync Harbour Chart', visibility: 'party', markdown: '# Sync Harbour Chart\nThe safe channel.\n' });
  });

  console.log('requests: a player asks the GM; the GM\'s approvals page shows it');
  await gm.page.goto(base + '/w/saltreach/gm/requests');
  await new Promise((r) => setTimeout(r, 2000));
  await expectEverywhere('requests', [['gm /requests', gm.page]], 'Sync: may I know the ferry guild', async () => {
    await api(T.jess, 'POST', '/requests', { kind: 'question', title: 'Sync: may I know the ferry guild', body: 'Jessamine grew up on the docks.' });
  });

  console.log('privacy: a GM-only stage card never reaches a player page');
  await api(T.gm, 'POST', '/stage/cards', { kind: 'text', title: 'Sync GM Only Note', text: 'hidden', show: false });
  await new Promise((r) => setTimeout(r, 2500));
  for (const [who, p] of [['jess', jess.page], ['tom', tom.page], ['ana', ana.page]]) if ((await p.evaluate(() => document.body.innerText)).includes('Sync GM Only Note')) fails.push(`privacy: ${who} saw a card that was never shown`);
} catch (e) {
  fails.push(`crashed: ${e.message}`);
} finally {
  await browser.close();
  srv.kill();
}
if (fails.length) { console.log('live sync FAILED:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('live sync ok');
