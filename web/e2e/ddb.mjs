// End-to-end test of importing a character from D&D Beyond onto the player
// sheet. It never calls D&D Beyond: the player uses the "paste the JSON"
// fallback with a made-up character. The warning that this is not an official
// API shows before anything is read and on the Character module; the import
// sets HP and conditions, sends items to Inventory for the DM to approve, and
// the DM sees the Character module on the player's sheet.
// Run from web/: npm run build && node e2e/ddb.mjs   (DDB_PORT, default 19813)
// DDB_SHOTS=<dir> also saves screenshots there.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, quiet } from './lib.mjs';

const PORT = Number(process.env.DDB_PORT || 19813);
const SHOTS = process.env.DDB_SHOTS || '';
const base = `http://127.0.0.1:${PORT}`;
const W = `${base}/w/saltreach`;
const problems = [];
const note = (m) => console.log('  ' + m);
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false }); } };

const character = {
  id: 87654321, success: true,
  data: {
    id: 87654321, name: 'Brindle Ashvale', readonlyUrl: 'https://www.dndbeyond.com/characters/87654321',
    race: { fullName: 'Hill Dwarf', weightSpeeds: { normal: { walk: 25 } } }, background: { definition: { name: 'Sage' } }, alignmentId: 2,
    classes: [{ level: 5, hitDiceUsed: 2, definition: { name: 'Wizard', hitDice: 6, spellCastingAbilityId: 4, spellRules: { multiClassSpellSlotDivisor: 1, levelSpellSlots: [[], [2], [3], [4, 2], [4, 3], [4, 3, 2]] } },
      classFeatures: [{ definition: { name: 'Arcane Recovery', requiredLevel: 1 } }], subclassDefinition: { name: 'School of Evocation', classFeatures: [{ definition: { name: 'Sculpt Spells', requiredLevel: 2 } }] } }],
    spellSlots: [{ level: 1, used: 2 }], inspiration: true,
    actions: { class: [{ name: 'Arcane Recovery', limitedUse: { maxUses: 1, numberUsed: 0, resetType: 2 } }] },
    traits: { personalityTraits: 'Reads at the table.', flaws: 'Too curious.' }, notes: { backstory: 'Raised in a library.' },
    stats: [{ id: 1, value: 10 }, { id: 2, value: 14 }, { id: 3, value: 13 }, { id: 4, value: 16 }, { id: 5, value: 12 }, { id: 6, value: 8 }],
    bonusStats: [], overrideStats: [],
    baseHitPoints: 22, removedHitPoints: 5, temporaryHitPoints: 0,
    modifiers: { race: [{ type: 'bonus', subType: 'constitution-score', value: 2 }, { type: 'language', friendlySubtypeName: 'Dwarvish' }], class: [{ type: 'proficiency', subType: 'intelligence-saving-throws' }, { type: 'proficiency', subType: 'arcana' }] },
    inventory: [{ quantity: 1, equipped: true, definition: { name: 'Quarterstaff', filterType: 'Weapon', attackType: 1, damage: { diceString: '1d6' }, damageType: 'Bludgeoning' } }, { quantity: 1, equipped: false, definition: { name: 'Spellbook' } }, { quantity: 3, equipped: false, definition: { name: 'Potion of Healing' } }],
    currencies: { gp: 42 }, conditions: [{ id: 11 }],
    classSpells: [{ spells: [{ definition: { name: 'Fire Bolt', level: 0 } }, { definition: { name: 'Magic Missile', level: 1 } }, { definition: { name: 'Fireball', level: 3 } }] }],
  },
};

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('ddb'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
// The import is a house rule: the DM turns it on first (World → House rules).
{
  const dmTok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dm', password: 'dungeon master 123' }) })).json()).token;
  const wid = (await (await fetch(base + '/api/worlds', { headers: { Authorization: 'Bearer ' + dmTok } })).json())[0].id;
  const r = await fetch(`${base}/api/worlds/${wid}/mods/dndbeyond-import/enabled`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dmTok }, body: JSON.stringify({ on: true }) });
  if (!r.ok) throw new Error(`turning on the house rule: ${r.status} ${await r.text()}`);
}
const browser = await chromium.launch();
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error on ${page.url()}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${who} console on ${page.url()}: ${m.text()}`); });
  // Nothing here may reach D&D Beyond.
  page.on('request', (r) => { if (/dndbeyond\.com/.test(r.url())) problems.push(`${who} called D&D Beyond: ${r.url()}`); });
}
async function signIn(user, pass, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  watch(page, user);
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(/\/w\/saltreach/, { timeout: 15000 });
  return { ctx, page };
}
const closeQuick = async (page) => { const c = page.locator('.modal[role=dialog]').getByRole('button', { name: 'Close' }); if (await c.waitFor({ timeout: 1200 }).then(() => true, () => false)) await c.click(); };

try {
  // 1. A player on a phone opens Import: the warning is the first thing in it.
  const { page: pl } = await signIn('jess', 'player pass 123', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pl.goto(`${W}/sheet`);
  await closeQuick(pl);
  await pl.getByTestId('sheet').waitFor({ timeout: 10000 });
  await pl.getByTestId('sheet-import').click();
  const box = pl.getByTestId('ddb-import');
  await box.waitFor({ timeout: 5000 });
  check(/no official API/.test(await box.getByTestId('ddb-warning').innerText()), 'the import shows the unofficial-API warning');
  await shot(pl, '1-import-warning');
  note('player: the import opens with the warning');

  // 2. Paste the JSON (the fallback when the link does not work), read it, see what will change.
  await box.getByRole('button', { name: /Paste the JSON/ }).click();
  await box.getByLabel('Character JSON').fill(JSON.stringify(character));
  await box.getByTestId('ddb-read').click();
  await box.getByTestId('ddb-apply').waitFor({ timeout: 8000 });
  if (!check(await box.getByText(/HP 27\/32/).count() > 0, 'the preview shows HP 27/32'));
  await box.getByLabel(/Send 3 items to Inventory/).check();
  await shot(pl, '2-import-preview');
  await box.getByTestId('ddb-apply').click();
  await pl.getByText(/Imported Brindle Ashvale/).waitFor({ timeout: 10000 });
  note('player: imported (paste)');

  // 3. The sheet: the Character module first, HP and Poisoned from D&D Beyond.
  const mod = pl.getByTestId('mod-character');
  await mod.getByTestId('ddb-character').waitFor({ timeout: 8000 });
  check(/Hill Dwarf/.test(await mod.innerText()), 'the module shows the race');
  check(await mod.getByTestId('ddb-warning').count() === 1, 'the module keeps a short warning');
  const vit = pl.getByTestId('mod-vitals');
  await vit.getByTestId('hp').getByText('27').waitFor({ timeout: 8000 });
  check(await vit.getByText('Poisoned').count() > 0, 'the condition came across');
  check(/Passive Perception/.test(await mod.innerText()) && /Quarterstaff/.test(await mod.innerText()), 'the module shows passive Perception and attacks');
  check(await pl.getByTestId('mod-counters').getByText('Arcane Recovery').count() === 1, 'limited uses became counters');
  const stats = pl.getByTestId('mod-stats');
  check(await stats.getByLabel('Passive Perception').inputValue() === '11', 'the Stats module has passive Perception from D&D Beyond');
  check(await stats.getByLabel('Spell save DC').inputValue() === '14', 'the Stats module has the spell save DC');
  if (SHOTS) await stats.screenshot({ path: path.join(SHOTS, '3c-stats-module.png') });
  await mod.scrollIntoViewIfNeeded();
  await shot(pl, '3-character-module');
  if (SHOTS) await mod.screenshot({ path: path.join(SHOTS, '3b-character-module-full.png') });
  note('player: Character module, HP 27/32, Poisoned');

  // 4. The DM sees the module on the player's sheet and the items waiting for approval.
  const { page: dm } = await signIn('dm', 'dungeon master 123', { viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 });
  await dm.goto(`${W}/dm/sheets`);
  await closeQuick(dm);
  const tab = dm.getByRole('tab', { name: /Brindle Ashvale/ });
  if (!check(await tab.waitFor({ timeout: 8000 }).then(() => true, () => false), 'the DM has a tab for Brindle Ashvale')) await shot(dm, 'x-dm-sheets');
  else await tab.click();
  await dm.getByTestId('ddb-character').first().waitFor({ timeout: 10000 });
  check(await dm.getByTestId('sheet-import').count() > 0, 'the DM can import onto the player sheet');
  await shot(dm, '4-dm-sees-character');
  note('DM: sees the Character module');
  await dm.goto(`${W}/dm/approvals`);
  await dm.getByText('Potion of Healing').first().waitFor({ timeout: 10000 });
  await shot(dm, '5-dm-approves-items');
  note('DM: the imported items wait for approval');
} catch (e) {
  problems.push('crashed: ' + (e.stack || e));
} finally {
  await browser.close();
  srv.kill();
}

if (problems.length) { console.log(`\n${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); process.exit(1); }
console.log('ddb ok');
