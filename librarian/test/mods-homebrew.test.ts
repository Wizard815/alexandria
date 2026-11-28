// Homebrew rules: the Game Master's quick form (a name and a sentence, optionally a sheet roll button), the rule
// reaching players and every assistant's context, and the roll button rolling on the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { checkMod } from '../src/features/mods/format.ts';
import { alwaysNote, cleanSuggestions, homebrewFile, homebrewWords, nextVersion, rollExpr, ruleSuggestions } from '../src/features/mods/homebrew.ts';
import { quickBrief } from '../src/features/playerhelp/quick.ts';
import { rulesAnswer } from '../src/features/broker2/other.ts';
import { enabledModFiles } from '../src/features/mods/store.ts';
import { DEFAULT_SETTINGS } from '../src/core/policy.ts';

let base = '';
let server: any;
let deps: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const M = () => `/api/worlds/${W}/mods`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-homebrew-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.gm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'gamemaster', password: 'gm password 123' })).account.id;
  T.gm = (await ok('POST', '/api/auth/login', undefined, { username: 'gamemaster', password: 'gm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Brewhold', dmAccountId: ID.gm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.gm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jessamine' });
  T.jess = j.token;
  ID.jess = j.account.id;
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const BONUS = 'You can make one weapon attack with your bonus action, at disadvantage. It does not add your ability modifier to damage.';

test('TestHomebrew_FileIsAValidRuleWithWordsFromTheText', () => {
  const f = homebrewFile('hb-bonus-strike', { name: 'Bonus action strike', text: BONUS, roll: { label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage' } });
  const { mod, errors } = checkMod(f);
  assert.deepEqual(errors, []);
  assert.ok(mod!.homebrew && mod!.assistant!.always);
  assert.deepEqual(mod!.rolls, [{ id: 'roll', label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage', note: '', places: ['sheet'], word: '' }]);
  assert.match(checkMod({ ...f, rolls: [{ id: 'r', label: 'x', word: 'roll' }] }).errors.join(' '), /belongs to the chat/);
  assert.match(checkMod({ ...f, rolls: [{ id: 'r', label: 'x', places: ['fridge'] }] }).errors.join(' '), /places\[0\]/);
  assert.ok(homebrewWords('Bonus action strike', BONUS).includes('bonus action'));
  assert.ok(!homebrewWords('x', 'You gain disadvantage').includes('advantage'), 'advantage is not found inside disadvantage');
  assert.equal(nextVersion('1.0.0'), '1.0.1');
  assert.equal(rollExpr('disadvantage', 5), '2d20kl1+5');
  assert.equal(rollExpr('advantage', -1), '2d20kh1-1');
  assert.equal(rollExpr('normal', 0), '1d20');
  assert.match(checkMod({ ...f, rolls: [{ id: 'r', label: 'x', mode: 'sideways' }] }).errors.join(' '), /mode must be one of/);
});

test('TestHomebrew_QuickFormSavesTurnsOnAndPlayersSeeIt', async () => {
  const r = await call('POST', `${M()}/homebrew`, T.gm, { name: 'Bonus action strike', text: BONUS, gm: 'Allow it only with a light weapon.', roll: { label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.id, 'hb-bonus-action-strike');
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.homebrew, true);
  assert.equal(r.body.form.gm, 'Allow it only with a light weapon.');
  // Players see it, with its text and roll button, but not the Game Master's note.
  const seen = await ok('GET', M(), T.jess);
  const mine = seen.mods.find((m: any) => m.id === 'hb-bonus-action-strike');
  assert.equal(mine.rules[0].text, BONUS);
  assert.equal(mine.rolls[0].mode, 'disadvantage');
  assert.equal(mine.form, undefined);
  // Players cannot make one.
  assert.equal((await call('POST', `${M()}/homebrew`, T.jess, { name: 'x', text: 'y' })).status, 403);
  // A second rule with the same name gets its own id; an edit keeps the id and raises the version.
  const two = await ok('POST', `${M()}/homebrew`, T.gm, { name: 'Bonus action strike', text: 'Another.' });
  assert.equal(two.id, 'hb-bonus-action-strike-2');
  const ed = await ok('POST', `${M()}/homebrew`, T.gm, { id: two.id, name: 'Quick potions', text: 'Drinking a potion is a bonus action.', on: false });
  assert.equal(ed.version, '1.0.1');
  assert.equal(ed.enabled, false);
  assert.equal((await call('POST', `${M()}/homebrew`, T.gm, { id: 'inspiration-rerolls', name: 'x', text: 'y' })).status, 404, 'a shipped rule is not edited here');
  assert.equal((await call('POST', `${M()}/homebrew`, T.gm, { name: '', text: 'y' })).status, 400);
});

test('TestHomebrew_EveryAssistantKeepsItInMind', async () => {
  const files = enabledModFiles(deps.db, W);
  const gm = alwaysNote(files, true);
  const player = alwaysNote(files, false);
  assert.match(gm, /Bonus action strike: .*light weapon/);
  assert.match(player, /Bonus action strike: You can make one weapon attack/);
  assert.ok(!player.includes('light weapon'), 'the Game Master note stays with the Game Master');
  assert.ok(!gm.includes('Quick potions'), 'a rule that is off is left out');
  // Squire's brief carries it even for a question that never names the rule.
  const brief = await quickBrief(deps, W, ID.jess, DEFAULT_SETTINGS as any, 'turn', 'what can I do on my turn?');
  assert.ok(brief.sections.some((s) => s.label === 'Table house rules' && s.text.includes('Bonus action strike')), JSON.stringify(brief.sections.map((s) => s.label)));
  // The Broker's rules answer puts the table's rule first.
  const a = rulesAnswer(deps, W, 'Can I attack with my bonus action?');
  assert.match(a.answer, /^Bonus action strike \(house rule at this table\)/);
  assert.equal(a.sources[0].title, 'House rule: Bonus action strike');
});

test('TestHomebrew_SheetRollButtonRollsOnTheServer', async () => {
  // No session: the roll has nowhere to go.
  assert.equal((await call('POST', `${M()}/hb-bonus-action-strike/rolls/roll`, T.jess, { bonus: 4 })).status, 409);
  await ok('POST', `/api/worlds/${W}/sessionchat/sessions/start`, T.gm, { title: 'Night one' });
  // A typed bonus.
  const r1 = await ok('POST', `${M()}/hb-bonus-action-strike/rolls/roll`, T.jess, { bonus: 4 });
  assert.equal(r1.expr, '2d20kl1+4');
  assert.match(r1.note, /Bonus action attack at disadvantage \(Bonus action strike\)/);
  // A weapon from the Character module.
  await ok('PUT', `/api/worlds/${W}/sheet/me/modules`, T.jess, { modules: [{ id: 'character', type: 'character', title: 'Character', data: { source: 'dndbeyond', name: 'Jessamine', attacks: [{ name: 'Shortsword', hit: 6, damage: '1d6+4', range: '' }] } }] });
  const atk = await ok('GET', `${M()}/attacks`, T.jess);
  assert.deepEqual(atk.attacks, [{ name: 'Shortsword', hit: 6 }]);
  const r2 = await ok('POST', `${M()}/hb-bonus-action-strike/rolls/roll`, T.jess, { attack: 0 });
  assert.equal(r2.expr, '2d20kl1+6');
  assert.match(r2.note, /^Shortsword: /);
  const chat = await ok('GET', `/api/worlds/${W}/sessionchat/chat/table`, T.gm);
  const msgs = chat.messages ?? chat;
  const last = msgs.find((m: any) => m.id === r2.id);
  assert.ok(last && last.kind === 'roll', JSON.stringify(last));
  assert.ok(r2.total >= 7 && r2.total <= 26);
  // Bad input and a rule that is off.
  assert.equal((await call('POST', `${M()}/hb-bonus-action-strike/rolls/roll`, T.jess, { attack: 5 })).status, 404);
  assert.equal((await call('POST', `${M()}/hb-bonus-action-strike/rolls/roll`, T.jess, { bonus: 99 })).status, 400);
  assert.equal((await call('POST', `${M()}/hb-bonus-action-strike/rolls/nope`, T.jess, {})).status, 404);
  assert.equal((await call('POST', `${M()}/hb-bonus-action-strike-2/rolls/roll`, T.jess, {})).status, 409);
});

test('TestHomebrew_SuggestExtrasWithoutAModelUsesTheRuleWords', async () => {
  const r = ruleSuggestions('Bonus action strike', BONUS);
  assert.deepEqual(r.roll && { label: r.roll.label, kind: r.roll.kind, mode: r.roll.mode }, { label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage' });
  assert.equal(ruleSuggestions('Quick potions', 'Drinking a potion is a bonus action.').roll, null);
  assert.equal(ruleSuggestions('Lucky saves', 'You have advantage on saving throws against fear.').roll?.kind, 'd20');
  const c = cleanSuggestions({ roll: { label: 'Off-hand jab', kind: 'weird', mode: 'disadvantage', why: 'x' }, gm: { text: '  Only light weapons. ' }, words: { list: ['off-hand', 'x'] } }, 'model');
  assert.equal(c.roll!.kind, 'attack');
  assert.equal(c.gm!.text, 'Only light weapons.');
  assert.deepEqual(c.words!.list, ['off-hand']);
  // The route: no model is set up in this test server, so the word rules answer; a rule that has a roll gets none.
  const fresh = await ok('POST', `${M()}/homebrew`, T.gm, { name: 'Shove strike', text: 'After a shove you can make one attack at disadvantage.' });
  const s1 = await ok('POST', `${M()}/homebrew/${fresh.id}/suggest`, T.gm);
  assert.equal(s1.source, 'rules');
  assert.equal(s1.roll.mode, 'disadvantage');
  const s2 = await ok('POST', `${M()}/homebrew/hb-bonus-action-strike/suggest`, T.gm);
  assert.equal(s2.roll, null);
  assert.equal((await call('POST', `${M()}/homebrew/inspiration-rerolls/suggest`, T.gm)).status, 404);
  await ok('DELETE', `${M()}/${fresh.id}`, T.gm);
});

test('TestHomebrew_ChatWordAndPlacesShowUpForPlayers', async () => {
  const cur = (await ok('GET', M(), T.gm)).mods.find((m: any) => m.id === 'hb-bonus-action-strike');
  const ed = await ok('POST', `${M()}/homebrew`, T.gm, { id: cur.id, ...cur.form, roll: { ...cur.form.roll, places: ['sheet', 'home'], word: 'bastrike' } });
  assert.deepEqual(ed.rolls[0].places, ['sheet', 'home']);
  assert.equal(ed.form.roll.word, 'bastrike');
  const said = await ok('POST', `/api/worlds/${W}/sessionchat/chat/table`, T.jess, { body: '/bastrike short' });
  assert.match(JSON.stringify(said), /Shortsword: Bonus action attack at disadvantage/);
  assert.ok(said.roll);
  const said2 = await ok('POST', `/api/worlds/${W}/sessionchat/chat/table`, T.jess, { body: '/bastrike 3' });
  assert.match(JSON.stringify(said2), /2d20kl1\+3/);
  // A chat word another rule already uses is refused.
  await ok('PUT', `${M()}/inspiration-rerolls/enabled`, T.gm, { on: true });
  assert.equal((await call('POST', `${M()}/homebrew`, T.gm, { name: 'Other', text: 'x', roll: { label: 'x', word: 'reroll' } })).status, 409);
});
