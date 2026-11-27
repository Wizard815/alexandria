// The Discord bot against a stand-in Discord (discord-fake.ts): setting it up,
// linking a player with a code, /roll, /ask (the quick helper), /recap, and
// what Alexandria posts by itself (recaps, table rolls, broker messages),
// with nothing GM-only or party-only ever leaving.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { one, run } from '../src/core/db.ts';
import { managerOf, rollText, md } from '../src/features/discord/bot.ts';
import { chunks } from '../src/features/discord/rest.ts';
import { APP_ID, FakeDiscord, GOOD_TOKEN, GUILD } from './discord-fake.ts';

const RECAPS = '600000000000000001';
const ROLLS = '600000000000000002';
const JESS = { id: '500000000000000001', username: 'jess_d' };
const TOM = { id: '500000000000000002', username: 'tommy' };
const STRANGER = { id: '500000000000000009', username: 'lurker' };
const SECRET = 'The council answers to the smuggler queen Velmira';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const fake = new FakeDiscord();
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
let helperReply = 'Dodge: attacks against you have disadvantage until your next turn.';

const fakeFetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://helper.invalid/')) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: helperReply }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return fetch(url, init);
}) as typeof fetch;

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
const w = (p: string) => `/api/worlds/${W}${p}`;
const until = async (what: string, fn: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};
/** The reply Discord got for one interaction (callback, then any edit). */
const answerTo = (i: { id: string; token: string }) => until(`the reply to ${i.id}`, () => {
  const cb = fake.calls.find((c) => c.path === `/interactions/${i.id}/${i.token}/callback`);
  if (!cb) return null;
  if (cb.body.type === 5) { const e = fake.calls.find((c) => c.method === 'PATCH' && c.path === `/webhooks/${APP_ID}/${i.token}/messages/@original`); return e ? { ...e.body, flags: cb.body.data.flags, deferred: true } : null; }
  return cb.body.data;
});

before(async () => {
  await fake.listen();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-discord-'));
  const made = createApp({
    noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: fakeFetch,
    env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ALX_DISCORD_API: fake.base, ALX_PUBLIC_URL: 'https://alx.example', ALX_MODEL_HELPER_URL: 'http://helper.invalid/v1', ALX_MODEL_HELPER_MODEL: 'bonsai-tiny' },
  });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  managerOf(deps).start();
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  ID.dm = (await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' })).account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Saltmarsh', dmAccountId: ID.dm })).id;
  for (const [name, ch] of [['jess', 'Brindle'], ['tom', 'Oskar']]) {
    const inv = await ok('POST', w('/invites'), T.dm, { role: 'player' });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: ch });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  await ok('PUT', w('/library/pages'), T.dm, { path: 'places/Saltmarsh', visibility: 'party', markdown: `# Saltmarsh\nSaltmarsh is a fishing town ruled by a council of seven captains.\n\n> [!secret] GM\n> ${SECRET}.\n` });
});

after(async () => {
  managerOf(deps)?.stop();
  server?.close();
  server?.closeAllConnections?.();
  fake.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
});

test('TestDiscord_FormatsRollsAndKeepsMentionsOut', () => {
  const t = rollText('Brindle', { expr: '2d6+3', terms: [{ term: '+2d6', dice: [4, 4], sum: 8 }, { term: '+3', dice: [], sum: 3 }], total: 11, note: 'sneak attack' });
  assert.equal(t, '🎲 **Brindle** rolled `2d6+3` sneak attack: **11**  (2d6 [4, 4] +3)');
  assert.match(rollText('A', { expr: 'd20', terms: [{ term: '+1d20', dice: [20], sum: 20 }], total: 20, note: '' }), /natural 20!/);
  assert.equal(md('@everyone *hi* <@123>'), '@\u200beveryone \\*hi\\* <\u200b@123\\>');
  const parts = chunks(`${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 2000));
});

test('TestDiscord_PlayersCannotSeeOrChangeTheBot', async () => {
  assert.equal((await call('GET', w('/discord'), T.jess)).status, 403);
  assert.equal((await call('PUT', w('/discord'), T.jess, { guildId: GUILD })).status, 403);
  const me = await ok('GET', w('/discord/me'), T.jess);
  assert.equal(me.available, false);
  assert.equal((await call('POST', w('/discord/me/code'), T.jess)).status, 409);
});

test('TestDiscord_DMConnectsTheBotAndCommandsAreRegistered', async () => {
  assert.equal((await call('PUT', w('/discord'), T.dm, { token: 'not a token' })).status, 400);
  assert.equal((await call('PUT', w('/discord'), T.dm, { guildId: 'my server' })).status, 400);
  const v = await ok('PUT', w('/discord'), T.dm, { token: GOOD_TOKEN, guildId: GUILD, recapChannel: RECAPS, rollChannel: ROLLS });
  assert.equal(v.tokenSet, true);
  assert.equal(JSON.stringify(v).includes(GOOD_TOKEN), false, 'the token never comes back');
  const reg = await until('commands registered', () => fake.find('PUT', new RegExp(`/applications/${APP_ID}/guilds/${GUILD}/commands`))[0]);
  assert.deepEqual((reg as any).body.map((c: any) => c.name), ['link', 'unlink', 'roll', 'ask', 'recap']);
  const s = await ok('GET', w('/discord'), T.dm);
  assert.equal(s.status.connected, true);
  assert.equal(s.status.botName, 'AlexBot');
  assert.equal(s.status.inServer, true);
  assert.match(s.inviteUrl, new RegExp(`client_id=${APP_ID}.*applications\\.commands`));
  assert.equal(fake.identified[0].token, GOOD_TOKEN);
  // A token sent as '' keeps the saved one.
  assert.equal((await ok('PUT', w('/discord'), T.dm, { token: '', postRolls: true })).tokenSet, true);
  const ch = await ok('GET', w('/discord/channels'), T.dm);
  assert.deepEqual(ch.map((c: any) => c.name), ['recaps', 'rolls'], 'text channels only, in order');
  const t = await ok('POST', w('/discord/test'), T.dm);
  assert.equal(t.results.length, 2);
  assert.ok(t.results.every((r: any) => r.ok));
});

test('TestDiscord_LinkingNeedsAFreshCodeFromTheApp', async () => {
  const bad = fake.interaction(JESS, 'link', { code: 'WRONG123' });
  assert.match((await answerTo(bad) as any).content, /did not work/);
  const code = await ok('POST', w('/discord/me/code'), T.jess);
  assert.match(code.code, /^[A-HJ-NP-Z2-9]{8}$/);
  const good = fake.interaction(JESS, 'link', { code: code.code.toLowerCase() });
  const a: any = await answerTo(good);
  assert.match(a.content, /Linked: on this server you are \*\*Brindle\*\*/);
  assert.equal(a.flags, 64, 'only Jess sees it');
  // A code works once.
  const again = fake.interaction(TOM, 'link', { code: code.code });
  assert.match((await answerTo(again) as any).content, /did not work/);
  const me = await ok('GET', w('/discord/me'), T.jess);
  assert.equal(me.linked.discordName, 'jess_d');
  assert.equal(me.serverName, 'The Table');
  const tomCode = await ok('POST', w('/discord/me/code'), T.tom);
  await answerTo(fake.interaction(TOM, 'link', { code: tomCode.code }));
  assert.equal((await ok('GET', w('/discord'), T.dm)).links.length, 2);
});

test('TestDiscord_UnlinkedPeopleCanDoNothing', async () => {
  const i = fake.interaction(STRANGER, 'roll', { dice: 'd20' });
  assert.match((await answerTo(i) as any).content, /Link your character first/);
  const a = fake.interaction(STRANGER, 'ask', { question: 'Who rules Saltmarsh?' });
  assert.match((await answerTo(a) as any).content, /Link your character first/);
});

test('TestDiscord_RollGoesToTheTableChatAndIsNotPostedTwice', async () => {
  // No session yet: rolled, but only in Discord.
  const first: any = await answerTo(fake.interaction(JESS, 'roll', { dice: 'd20+5 perception' }));
  assert.match(first.content, /\*\*Brindle\*\* rolled `d20\+5` perception: \*\*\d+\*\*/);
  assert.match(first.content, /not in the table chat/);
  assert.equal(first.flags, 0, 'rolls are public');

  await ok('POST', w('/sessionchat/sessions/start'), T.dm, { title: 'Game night' });
  const from = fake.calls.length;
  const r: any = await answerTo(fake.interaction(JESS, 'roll', { dice: '2d6+3 sneak attack' }));
  assert.doesNotMatch(r.content, /not in the table chat/);
  const chat = await ok('GET', w('/sessionchat/chat/table'), T.dm);
  const m = chat.messages.at(-1);
  assert.equal(m.kind, 'roll');
  assert.equal(m.authorId, ID.jess);
  assert.equal(m.roll.expr, '2d6+3');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fake.find('POST', new RegExp(`/channels/${ROLLS}/messages`), from).length, 0, 'answered in the roll channel already');
});

test('TestDiscord_TableRollsArePostedPartyRollsAreNot', async () => {
  const from = fake.calls.length;
  const m = await ok('POST', w('/sessionchat/chat/table'), T.tom, { body: '/roll d20 initiative' });
  const post: any = await until('the roll post', () => fake.find('POST', new RegExp(`/channels/${ROLLS}/messages`), from)[0]);
  assert.match(post.body.content, /\*\*Oskar\*\* rolled `d20` initiative/);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
  await ok('POST', w('/sessionchat/chat/party'), T.tom, { body: '/roll d20 secret plan' });
  await ok('POST', w('/sessionchat/chat/table'), T.tom, { body: 'plain words, not a roll' });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fake.find('POST', new RegExp(`/channels/${ROLLS}/messages`), from).length, 1, 'party chat and plain text stay home');
  // The GM hides the roll: it comes down in Discord too.
  await ok('POST', w(`/sessionchat/messages/${m.id}/hide`), T.dm, {});
  await until('the delete', () => fake.find('DELETE', new RegExp(`/channels/${ROLLS}/messages/${post.body ? '\\d+' : ''}`), from)[0]);
});

test('TestDiscord_AskUsesTheQuickHelperPrivately', async () => {
  helperReply = 'Dodge: attacks against you have disadvantage until your next turn.';
  const a: any = await answerTo(fake.interaction(JESS, 'ask', { question: 'What does Dodge do?', task: 'rules' }));
  assert.equal(a.deferred, true);
  assert.equal(a.flags, 64, 'only the asker sees it');
  assert.match(a.content, /Dodge: attacks against you have disadvantage/);
  assert.match(a.content, /^> What does Dodge do\?/);
  // In-world questions go to the broker, with a link to the app.
  const b: any = await answerTo(fake.interaction(JESS, 'ask', { question: 'Who secretly rules Saltmarsh?' }));
  assert.match(b.content, /broker/i);
  assert.match(b.content, /https:\/\/alx\.example\/w\/[^/]+\/broker/);
  assert.equal(b.content.includes('Velmira'), false);
  // Shared: posted for the channel.
  const s: any = await answerTo(fake.interaction(JESS, 'ask', { task: 'turn', share: true }));
  assert.equal(s.flags, 0);
  // The GM is not a player: no quick helper.
  const dmCode = await ok('POST', w('/discord/me/code'), T.dm);
  const GM = { id: '500000000000000005', username: 'the_dm' };
  await answerTo(fake.interaction(GM, 'link', { code: dmCode.code }));
  assert.match((await answerTo(fake.interaction(GM, 'ask', { question: 'Hi?' })) as any).content, /for players/);
  // The GM switches the helper off for Discord.
  await ok('PUT', w('/discord'), T.dm, { helper: false });
  assert.match((await answerTo(fake.interaction(JESS, 'ask', { question: 'What does Dodge do?' })) as any).content, /turned the quick helper off in Discord/);
  await ok('PUT', w('/discord'), T.dm, { helper: true });
});

test('TestDiscord_PublishedRecapIsPostedOnce', async () => {
  const none: any = await answerTo(fake.interaction(TOM, 'recap'));
  assert.match(none.content, /not published a session recap yet/);
  const from = fake.calls.length;
  const draft = await ok('POST', w('/sessionlog/drafts'), T.dm, { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date().toISOString(), title: 'The Lighthouse' });
  await ok('PUT', w(`/sessionlog/drafts/${draft.id}`), T.dm, { markdown: '# The Lighthouse\nThe party climbed the old lighthouse and met the keeper.' });
  const pub = await ok('POST', w(`/sessionlog/drafts/${draft.id}/publish`), T.dm, {});
  const post: any = await until('the recap post', () => fake.find('POST', new RegExp(`/channels/${RECAPS}/messages`), from)[0]);
  assert.match(post.body.content, /Saltmarsh: Session 1: The Lighthouse/);
  assert.match(post.body.content, /met the keeper/);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(fake.find('POST', new RegExp(`/channels/${RECAPS}/messages`), from).length, 1);
  const mine: any = await answerTo(fake.interaction(TOM, 'recap'));
  assert.match(mine.content, /met the keeper/);
  assert.equal(mine.flags, 64);
  // The GM can post it again on purpose.
  const entry = pub.entry?.id ?? one<any>(deps.db, 'SELECT id FROM sessionlog_entries WHERE world_id = ?', W).id;
  await ok('POST', w(`/discord/recap/${entry}`), T.dm);
  assert.equal(fake.find('POST', new RegExp(`/channels/${RECAPS}/messages`), from).length, 2);
});

test('TestDiscord_BrokerMessagesGoToTheAskerOnly', async () => {
  // A guarded question waits for the GM's price.
  const rid = 'brq_discordtest1';
  run(deps.db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, status, created_at) VALUES (?, ?, ?, ?, 'short', 'secret', 'pricing', ?)`, rid, W, ID.jess, 'Who does the council answer to?', new Date().toISOString());
  const jessDm = `7${JESS.id.slice(1)}`;
  const from = fake.calls.length;
  await ok('POST', w(`/broker/${rid}/price`), T.dm, { costCp: 500, answer: 'To the smuggler queen.', waitAmount: 0, waitUnit: 'minutes', clock: 'real' });
  const priced: any = await until('the price direct message', () => fake.find('POST', new RegExp(`/channels/${jessDm}/messages`), from)[0]);
  assert.match(priced.body.content, /names a price/);
  assert.equal(priced.body.content.includes('smuggler queen'), false, 'no answer before paying');
  await ok('POST', w('/live/ledger'), T.dm, { owner: ID.jess, amountCp: 1000, note: 'Reward' });
  await ok('POST', w(`/broker/${rid}/accept`), T.jess, { from: 'me' });
  const st = one<any>(deps.db, 'SELECT status FROM broker_requests WHERE id = ?', rid).status;
  if (st === 'waiting') await ok('POST', w(`/broker/${rid}/deliver`), T.dm, {});
  const answered: any = await until('the answer direct message', () => fake.find('POST', new RegExp(`/channels/${jessDm}/messages`), from).find((c) => /has an answer/.test(c.body.content)));
  assert.match(answered.body.content, /To the smuggler queen/);
  assert.equal(fake.find('POST', /\/users\/@me\/channels/, from).every((c) => c.body.recipient_id === JESS.id), true, 'only Jess got a direct message');
});

test('TestDiscord_BrokerOffersSendTheTeaserNotTheInfo', async () => {
  const from = fake.calls.length;
  await ok('POST', w('/broker/offers'), T.dm, { title: 'The vault key', teaser: 'I know where a key is kept.', info: 'Under the third step of the lighthouse.', priceCp: 2000, targets: ['party'] });
  await until('two offer direct messages', () => fake.find('POST', /\/channels\/7\d+\/messages/, from).length >= 2);
  const posts = fake.find('POST', /\/channels\/7\d+\/messages/, from);
  assert.ok(posts.every((p) => /The vault key/.test(p.body.content) && /key is kept/.test(p.body.content)));
  assert.ok(posts.every((p) => !p.body.content.includes('third step')), 'the information stays in the app');
});

test('TestDiscord_LeavingTheWorldEndsTheLink', async () => {
  run(deps.db, 'DELETE FROM members WHERE world_id = ? AND account_id = ?', W, ID.tom);
  const i = fake.interaction(TOM, 'roll', { dice: 'd20' });
  assert.match((await answerTo(i) as any).content, /Link your character first/);
});

test('TestDiscord_PlayerUnlinksFromTheApp', async () => {
  await ok('DELETE', w('/discord/me'), T.jess);
  assert.equal((await ok('GET', w('/discord/me'), T.jess)).linked, null);
  const i = fake.interaction(JESS, 'roll', { dice: 'd20' });
  assert.match((await answerTo(i) as any).content, /Link your character first/);
});

test('TestDiscord_WrongTokenStopsWithAReason', async () => {
  const W2 = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Other', dmAccountId: ID.dm })).id;
  assert.equal((await call('PUT', `/api/worlds/${W2}/discord`, T.dm, { guildId: GUILD })).status, 409, 'one world per Discord server');
  await ok('PUT', `/api/worlds/${W2}/discord`, T.dm, { token: ['fake-test-bot-token-1111', 'wxyz', 'wrong-and-also-not-real-token'].join('.'), guildId: '800000000000000002' });
  const got: any = await (async () => { for (let k = 0; k < 100; k++) { const v = await ok('GET', `/api/worlds/${W2}/discord`, T.dm); if (v.status?.error) return v; await new Promise((r) => setTimeout(r, 20)); } return null; })();
  assert.ok(got, 'an error shows');
  assert.match(got.status.error, /token/);
  assert.equal(got.status.connected, false);
});
