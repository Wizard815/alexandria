// Session chats: table and party channels, the DM kept out of party chat
// (REST, live events, MCP), mentions, server-side dice, hidden page links,
// the edit window, moderation, retention, sessions that end, and trades.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { run, one } from '../src/core/db.ts';
import { parseRoll } from '../src/features/sessionchat/dice.ts';
import { toolsFor } from '../src/routes/mcpServer.ts';

let base = '';
let server: any;
let tmp = '';
let deps: any;
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
const P: Record<string, string> = {};
let W = '';
const C = (p = '') => `/api/worlds/${W}/sessionchat${p}`;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}
const ok = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const mcp = async (key: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return r.body;
};
const mcpTools = async (key: string) => (await call('POST', '/mcp', key, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t: any) => t.name) as string[];
const say = (who: string, ch: string, body: string, extra: Record<string, unknown> = {}) => ok('POST', C(`/chat/${ch}`), T[who], { body, ...extra });
const coin = async (who: string) => (await ok('GET', `/api/worlds/${W}/live/ledger`, T[who])).cp as number;
const items = async (who: string) => (await ok('GET', `/api/worlds/${W}/inventory`, T[who])).items as any[];

/** Collect live events for one account until closed. */
function listen(token: string) {
  const events: { type: string; data: any }[] = [];
  const req = http.get(`${base}/api/worlds/${W}/events`, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const t = /^event: (.+)$/m.exec(block);
        const d = /^data: (.+)$/m.exec(block);
        if (t && d) events.push({ type: t[1], data: JSON.parse(d[1]) });
      }
    });
  });
  return { events, close: () => req.destroy() };
}
const settle = () => new Promise((r) => setTimeout(r, 150));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-sch-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Chatland', dmAccountId: ID.dm })).id;
  for (const [name, role] of [['jess', 'player'], ['tom', 'player'], ['gus', 'guest']] as const) {
    const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role });
    const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: name, password: 'player pass 123', characterName: name === 'jess' ? 'Jessamine' : name });
    T[name] = j.token;
    ID[name] = j.account.id;
  }
  const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
  P.open = await page('places/Saltmarsh', 'party', '# Saltmarsh\nA fishing town.\n');
  P.secret = await page('dm/Velmira', 'dm', '# Velmira\nSecret queen.\n');
  for (const who of ['jess', 'tom']) {
    const k = await ok('POST', '/api/keys', T[who], { scope: 'scribe', worldId: W, label: 'ai', access: 'read' });
    T[`${who}Key`] = k.key;
  }
  T.dmKey = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dm', access: 'write' })).key;
  T.dmReadKey = (await ok('POST', '/api/keys', T.dm, { scope: 'scribe', worldId: W, label: 'dmr', access: 'read' })).key;
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 2000, note: 'start' });
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.tom, amountCp: 500, note: 'start' });
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { playerTransfers: true, playerChangesNeedApproval: false });
});

after(async () => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('TestSessionChat_NeedsASessionAndTheDMStartsOne', async () => {
  const cur = await ok('GET', C('/current'), T.jess);
  assert.equal(cur.session, null);
  const r = await call('POST', C('/chat/table'), T.jess, { body: 'hello?' });
  assert.equal(r.status, 409);
  assert.equal((await call('POST', C('/sessions/start'), T.jess, {})).status, 403);
  const s = await ok('POST', C('/sessions/start'), T.dm, { title: 'Night one' });
  assert.equal(s.open, true);
  assert.equal((await call('POST', C('/sessions/start'), T.dm, {})).status, 409);
  const after = await ok('GET', C('/current'), T.jess);
  assert.equal(after.session.id, s.id);
  assert.deepEqual(after.channels.map((c: any) => c.channel), ['table', 'party']);
  const dmCur = await ok('GET', C('/current'), T.dm);
  assert.deepEqual(dmCur.channels.map((c: any) => c.channel), ['table']);
});

test('TestSessionChat_DMCannotReadListOrReceivePartyChat', async () => {
  const dmEvents = listen(T.dm);
  const jessEvents = listen(T.jess);
  const adminEvents = listen(T.admin);
  await settle();
  const secret = 'we ambush the baron at dusk';
  const m = await say('jess', 'party', secret);
  await say('tom', 'table', 'table hello');
  await settle();
  // REST: the DM, the guest and the admin are all refused; messages by id too.
  for (const who of ['dm', 'gus']) {
    assert.equal((await call('GET', C('/chat/party'), T[who])).status, 403, who);
    assert.equal((await call('POST', C('/chat/party'), T[who], { body: 'hi' })).status, 403, who);
  }
  assert.equal((await call('GET', C('/chat/party'), T.admin)).status, 404); // not a member of the world
  assert.equal((await call('PATCH', C(`/messages/${m.id}`), T.dm, { body: 'x' })).status, 404);
  assert.equal((await call('POST', C(`/messages/${m.id}/hide`), T.dm, {})).status, 404);
  assert.equal((await call('POST', C(`/messages/${m.id}/react`), T.dm, { emoji: '+' })).status, 404);
  assert.equal((await call('POST', C('/read'), T.dm, { channel: 'party' })).status, 403);
  // Nothing in the DM's other views mentions it.
  const dmSees = JSON.stringify([await ok('GET', C('/current'), T.dm), await ok('GET', C('/sessions'), T.dm), await ok('GET', C('/chat/table'), T.dm)]);
  assert.ok(!dmSees.includes(secret));
  // Live events: the DM never gets a party event; players do; the table event reaches everyone.
  assert.ok(!JSON.stringify(dmEvents.events).includes(secret));
  assert.ok(!dmEvents.events.some((e) => e.type === 'chat' && e.data.channel === 'party'));
  assert.ok(dmEvents.events.some((e) => e.type === 'chat' && e.data.channel === 'table'));
  assert.ok(jessEvents.events.some((e) => e.type === 'chat' && e.data.channel === 'party' && e.data.message.body === secret));
  assert.ok(!JSON.stringify(adminEvents.events).includes(secret));
  // MCP: a DM's write key and read key cannot list or call it; a player key can.
  for (const key of [T.dmKey, T.dmReadKey]) {
    assert.ok(!(await mcpTools(key)).includes('read_party_chat'));
    const r = await mcp(key, 'read_party_chat', {});
    assert.ok(r.error, 'unknown tool for a DM key');
    assert.ok(!JSON.stringify(r).includes(secret));
  }
  assert.ok((await mcpTools(T.dmKey)).includes('read_table_chat'));
  assert.ok((await mcpTools(T.dmKey)).includes('send_table_chat'));
  assert.ok(!(await mcpTools(T.jessKey)).includes('send_table_chat'));
  assert.ok((await mcpTools(T.jessKey)).includes('read_party_chat'));
  const mine = await mcp(T.jessKey, 'read_party_chat', {});
  assert.ok(JSON.stringify(mine).includes(secret));
  assert.ok(!(await mcp(T.jessKey, 'send_table_chat', { body: 'x' })).result);
  // Even calling the REST route directly with the DM's key (the agent's path) fails.
  assert.equal((await call('GET', C('/chat/party'), T.dmKey)).status, 403);
  assert.ok(!toolsFor(true).some((t) => t.name === 'read_party_chat'), 'the DM agent never gets the party chat tool');
  assert.ok(toolsFor(false).some((t) => t.name === 'read_party_chat'));
  // The DM's MCP can read and send table chat.
  const sent = await mcp(T.dmKey, 'send_table_chat', { body: 'Welcome, adventurers' });
  assert.ok(!sent.result.isError, JSON.stringify(sent));
  const tbl = await mcp(T.tomKey, 'read_table_chat', { limit: 10 });
  assert.ok(JSON.stringify(tbl).includes('Welcome, adventurers'));
  assert.ok(!JSON.stringify(tbl).includes(secret));
  dmEvents.close(); jessEvents.close(); adminEvents.close();
});

test('TestSessionChat_MentionsReplyAndUnread', async () => {
  const jess = listen(T.jess);
  const tom = listen(T.tom);
  await settle();
  await ok('POST', C('/read'), T.jess, { channel: 'table' });
  const first = await say('tom', 'table', 'Hey @Jessamine, are you up for the cellar?');
  assert.deepEqual(first.mentions, [ID.jess]);
  const reply = await say('jess', 'table', 'yes!', { replyTo: first.id });
  assert.equal(reply.replyTo.id, first.id);
  assert.ok(reply.replyTo.snippet.includes('cellar'));
  await settle();
  const ev = jess.events.find((e) => e.type === 'chat' && e.data.message.id === first.id);
  assert.equal(ev?.data.message.mentionsMe, true);
  assert.equal(tom.events.find((e) => e.type === 'chat' && e.data.message.id === first.id)?.data.message.mentionsMe, false);
  // The DM cannot be pinged into a party message they can't read, nor can a mention leak the channel.
  const pm = await say('jess', 'party', '@dungeon psst @tom');
  assert.deepEqual(pm.mentions, [ID.tom]);
  // Unread counts per channel.
  await ok('POST', C('/read'), T.jess, { channel: 'table' });
  const before = (await ok('GET', C('/current'), T.jess)).channels;
  assert.equal(before.find((c: any) => c.channel === 'table').unread, 0);
  const tomView = (await ok('GET', C('/current'), T.tom)).channels;
  assert.ok(tomView.find((c: any) => c.channel === 'party').unread >= 1);
  await say('tom', 'table', 'one more');
  assert.equal((await ok('GET', C('/current'), T.jess)).channels.find((c: any) => c.channel === 'table').unread, 1);
  await ok('POST', C('/read'), T.jess, { channel: 'table' });
  assert.equal((await ok('GET', C('/current'), T.jess)).channels.find((c: any) => c.channel === 'table').unread, 0);
  // A reply to another channel's message is refused.
  const r = await call('POST', C('/chat/table'), T.tom, { body: 'x', replyTo: pm.id });
  assert.equal(r.status, 400);
  jess.close(); tom.close();
});

test('TestSessionChat_RollIsRolledOnTheServer', async () => {
  const m = await say('jess', 'table', '/roll 2d6+3 sneak attack');
  assert.equal(m.kind, 'roll');
  assert.equal(m.roll.terms[0].dice.length, 2);
  assert.equal(m.roll.total, m.roll.terms[0].dice[0] + m.roll.terms[0].dice[1] + 3);
  assert.equal(m.roll.note, 'sneak attack');
  // The client cannot supply a result.
  const fake = await ok('POST', C('/chat/table'), T.jess, { body: '/roll d20', roll: { total: 20 }, total: 20 });
  assert.ok(fake.roll.total >= 1 && fake.roll.total <= 20);
  assert.equal((await call('POST', C('/chat/table'), T.jess, { body: '/roll banana' })).status, 400);
  assert.equal((await call('POST', C('/chat/table'), T.jess, { body: '/roll 500d6' })).status, 400);
  assert.equal((await call('PATCH', C(`/messages/${m.id}`), T.jess, { body: '/roll 1d1' })).status, 400, 'rolls cannot be edited');
  // The parser, with a fixed die.
  const p = parseRoll('/roll 4d6kh3 - 1', () => 4);
  assert.equal(p.total, 12 - 1);
  assert.equal(parseRoll('/roll d20+5', () => 7).total, 12);
  assert.equal(parseRoll('/roll 2d8-1d4+2', (n) => n).total, 16 - 4 + 2);
  // A party roll stays in the party channel.
  const pr = await say('tom', 'party', '/roll d20');
  assert.equal(pr.channel, 'party');
  assert.ok(!JSON.stringify(await ok('GET', C('/chat/table'), T.dm)).includes(pr.id));
});

test('TestSessionChat_LinksToPagesPlayersCannotSeeAreHidden', async () => {
  // A player may link a page they can see, and the server checks it.
  const ok1 = await say('jess', 'table', `We go to [[page:${P.open}]] first`);
  assert.ok(ok1.body.includes(`[[page:${P.open}|Saltmarsh]]`));
  assert.equal((await call('POST', C('/chat/table'), T.jess, { body: `see [[page:${P.secret}]]` })).status, 400);
  assert.equal((await call('POST', C('/chat/party'), T.jess, { body: `see [[page:nope]]` })).status, 400);
  // The DM may link a DM-only page; players read "(hidden)", the DM sees the title.
  const dmMsg = await say('dm', 'table', `Remember [[page:${P.secret}]]`);
  assert.ok(dmMsg.body.includes('Velmira'));
  const asPlayer = (await ok('GET', C('/chat/table'), T.tom)).messages.find((m: any) => m.id === dmMsg.id);
  assert.equal(asPlayer.body, 'Remember (hidden)');
  assert.ok(!JSON.stringify(asPlayer).includes('Velmira'));
  // The page is made DM-only after the fact: it turns "(hidden)" for players.
  run(deps.db, `UPDATE pages SET visibility = 'dm' WHERE id = ?`, P.open);
  const later = (await ok('GET', C('/chat/table'), T.tom)).messages.find((m: any) => m.id === ok1.id);
  assert.ok(later.body.includes('(hidden)') && !later.body.includes('Saltmarsh'));
  run(deps.db, `UPDATE pages SET visibility = 'party' WHERE id = ?`, P.open);
});

test('TestSessionChat_EditAndDeleteWithinTenMinutes', async () => {
  const m = await say('jess', 'table', 'typo here');
  const edited = await ok('PATCH', C(`/messages/${m.id}`), T.jess, { body: 'fixed here @tom' });
  assert.equal(edited.body, 'fixed here @tom');
  assert.ok(edited.editedAt);
  assert.deepEqual(edited.mentions, [ID.tom]);
  assert.equal((await call('PATCH', C(`/messages/${m.id}`), T.tom, { body: 'hax' })).status, 403);
  assert.equal((await call('DELETE', C(`/messages/${m.id}`), T.dm)).status, 403);
  assert.equal((await call('PATCH', C(`/messages/${m.id}`), T.jess, { body: 'x'.repeat(2001) })).status, 400);
  // 11 minutes later it is locked.
  run(deps.db, 'UPDATE sessionchat_messages SET at = ? WHERE id = ?', new Date(Date.now() - 11 * 60_000).toISOString(), m.id);
  assert.equal((await call('PATCH', C(`/messages/${m.id}`), T.jess, { body: 'late' })).status, 403);
  assert.equal((await call('DELETE', C(`/messages/${m.id}`), T.jess)).status, 403);
  const n = await say('jess', 'table', 'delete me');
  await ok('DELETE', C(`/messages/${n.id}`), T.jess);
  const row = (await ok('GET', C('/chat/table'), T.tom)).messages.find((x: any) => x.id === n.id);
  assert.equal(row.deleted, true);
  assert.equal(row.body, '');
  assert.equal((await call('POST', C('/chat/table'), T.jess, { body: 'x'.repeat(2001) })).status, 400);
  assert.equal((await say('jess', 'table', 'y'.repeat(2000))).body.length, 2000);
});

test('TestSessionChat_DMModeratesTableChatOnly', async () => {
  const m = await say('tom', 'table', 'something rude');
  assert.equal((await call('POST', C(`/messages/${m.id}/hide`), T.jess, {})).status, 403);
  const hidden = await ok('POST', C(`/messages/${m.id}/hide`), T.dm, {});
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.body, 'something rude', 'the DM still sees what was hidden');
  const asPlayer = (await ok('GET', C('/chat/table'), T.jess)).messages.find((x: any) => x.id === m.id);
  assert.equal(asPlayer.hidden, true);
  assert.equal(asPlayer.body, '');
  assert.ok(one(deps.db, `SELECT 1 FROM audit WHERE action = 'sessionchat.hide'`));
  const unhidden = await ok('POST', C(`/messages/${m.id}/hide`), T.dm, { hidden: false });
  assert.equal(unhidden.hidden, false);
  // Reactions.
  const re = await ok('POST', C(`/messages/${m.id}/react`), T.jess, { emoji: '👍' });
  assert.deepEqual(re.reactions, [{ emoji: '👍', count: 1, mine: true }]);
  const off = await ok('POST', C(`/messages/${m.id}/react`), T.jess, { emoji: '👍' });
  assert.deepEqual(off.reactions, []);
});

test('TestSessionChat_RetentionFollowsMessageDays', async () => {
  const old = await say('jess', 'table', 'ancient words');
  const oldParty = await say('jess', 'party', 'ancient party words');
  const stamp = new Date(Date.now() - 20 * 864e5).toISOString();
  run(deps.db, 'UPDATE sessionchat_messages SET at = ? WHERE id IN (?, ?)', stamp, old.id, oldParty.id);
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { messageDays: 30 });
  await ok('GET', C('/current'), T.jess);
  assert.ok(one(deps.db, 'SELECT 1 FROM sessionchat_messages WHERE id = ?', old.id), '30 days keeps a 20 day old message');
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { messageDays: 14 });
  await ok('GET', C('/current'), T.jess);
  assert.ok(!one(deps.db, 'SELECT 1 FROM sessionchat_messages WHERE id = ?', old.id));
  assert.ok(!one(deps.db, 'SELECT 1 FROM sessionchat_messages WHERE id = ?', oldParty.id));
  await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, { messageDays: 14 });
});

test('TestSessionChat_TradeAcceptMovesBothSidesAtOnce', async () => {
  const i = (who: string) => `/api/worlds/${W}/inventory`;
  const rope = await ok('POST', i('jess'), T.dm, { owner: ID.jess, name: 'Silk rope', qty: 3, reason: 'test' });
  const gem = await ok('POST', i('tom'), T.dm, { owner: ID.tom, name: 'Ruby', qty: 2, reason: 'test' });
  const jessCoin = await coin('jess'), tomCoin = await coin('tom');
  // Offer rope x2 + 50 cp for a ruby.
  const t = await ok('POST', C('/trades'), T.jess, { to: ID.tom, offerItemId: rope.id, offerQty: 2, offerCp: 50, wantItem: 'ruby', wantQty: 1, note: 'deal?' });
  assert.equal(t.status, 'open');
  assert.equal((await call('POST', C(`/trades/${t.id}/accept`), T.jess, {})).status, 403, 'the offerer cannot accept their own');
  assert.equal((await call('GET', C('/trades'), T.dm)).status, 403);
  const acc = await ok('POST', C(`/trades/${t.id}/accept`), T.tom, {});
  assert.equal(acc.status, 'accepted');
  const jI = await items('jess'), tI = await items('tom');
  assert.equal(jI.find((x) => x.name === 'Silk rope').qty, 1);
  assert.equal(jI.find((x) => x.name === 'Ruby').qty, 1);
  assert.equal(tI.find((x) => x.name === 'Silk rope').qty, 2);
  assert.equal(tI.find((x) => x.name === 'Ruby').qty, 1);
  assert.equal(await coin('jess'), jessCoin - 50);
  assert.equal(await coin('tom'), tomCoin + 50);
  assert.ok(gem.id);
  assert.equal((await call('POST', C(`/trades/${t.id}/accept`), T.tom, {})).status, 409, 'cannot accept twice');
  // The DM sees the swaps in the transfer log.
  const log = (await ok('GET', `/api/worlds/${W}/inventory/transfers`, T.dm)).transfers;
  assert.ok(log.some((x: any) => x.kind === 'item' && x.item_name === 'Silk rope' && x.note === 'Trade'));
});

test('TestSessionChat_TradeDeclineCancelAndOwnership', async () => {
  const rope = (await items('tom')).find((x) => x.name === 'Silk rope');
  const ruby = (await items('jess')).find((x) => x.name === 'Ruby');
  // You cannot offer an item you do not own.
  const stolen = await call('POST', C('/trades'), T.jess, { to: ID.tom, offerItemId: rope.id, offerQty: 1, wantCp: 10 });
  assert.equal(stolen.status, 403);
  // Nor more than you have, nor coin you lack.
  assert.equal((await call('POST', C('/trades'), T.jess, { to: ID.tom, offerItemId: ruby.id, offerQty: 5, wantCp: 10 })).status, 400);
  assert.equal((await call('POST', C('/trades'), T.jess, { to: ID.tom, offerCp: 9_999_999, wantCp: 10 })).status, 402);
  assert.equal((await call('POST', C('/trades'), T.jess, { to: ID.jess, offerCp: 5, wantCp: 10 })).status, 400);
  assert.equal((await call('POST', C('/trades'), T.jess, { to: ID.dm, offerCp: 5, wantCp: 10 })).status, 400, 'with players only');
  assert.equal((await call('POST', C('/trades'), T.jess, { to: ID.tom, offerCp: 5 })).status, 400, 'must ask for something');
  // Decline: nothing moves.
  const before = JSON.stringify([await items('jess'), await items('tom'), await coin('jess'), await coin('tom')]);
  const t = await ok('POST', C('/trades'), T.jess, { to: ID.tom, offerItemId: ruby.id, offerQty: 1, wantCp: 100 });
  assert.equal((await call('POST', C(`/trades/${t.id}/decline`), T.jess, {})).status, 403);
  assert.equal((await ok('POST', C(`/trades/${t.id}/decline`), T.tom, {})).status, 'declined');
  assert.equal(JSON.stringify([await items('jess'), await items('tom'), await coin('jess'), await coin('tom')]), before);
  // Cancel by the offerer.
  const c = await ok('POST', C('/trades'), T.jess, { to: ID.tom, offerCp: 5, wantCp: 6 });
  assert.equal((await ok('POST', C(`/trades/${c.id}/cancel`), T.jess, {})).status, 'cancelled');
  assert.equal((await call('POST', C(`/trades/${c.id}/accept`), T.tom, {})).status, 409);
  // Third parties cannot touch it.
  const x = await ok('POST', C('/trades'), T.jess, { to: ID.tom, offerCp: 5, wantCp: 6 });
  assert.equal((await call('POST', C(`/trades/${x.id}/accept`), T.dm, {})).status, 403);
});

test('TestSessionChat_TradeIsAtomicWhenOneSideFails', async () => {
  // Jess offers a ruby for 100 cp; Tom spends his coin before accepting, and Jess's ruby leaves her pack.
  const ruby = (await items('jess')).find((x) => x.name === 'Ruby');
  const t = await ok('POST', C('/trades'), T.jess, { to: ID.tom, offerItemId: ruby.id, offerQty: 1, wantCp: 100 });
  const tomCoin = await coin('tom');
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.tom, amountCp: -(tomCoin - 10), note: 'spent' });
  const snapshot = JSON.stringify([await items('jess'), await items('tom'), await coin('jess'), await coin('tom')]);
  const r = await call('POST', C(`/trades/${t.id}/accept`), T.tom, {});
  assert.equal(r.status, 402);
  assert.equal(JSON.stringify([await items('jess'), await items('tom'), await coin('jess'), await coin('tom')]), snapshot, 'nothing moved');
  assert.equal(one<any>(deps.db, 'SELECT status FROM sessionchat_trades WHERE id = ?', t.id)!.status, 'open');
  // Now the failure comes on the last step: the item side would already have moved. Break it with a coin shortfall for A.
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.tom, amountCp: 500, note: 'refund' });
  const t2 = await ok('POST', C('/trades'), T.jess, { to: ID.tom, offerItemId: ruby.id, offerQty: 1, offerCp: 20, wantCp: 100 });
  const jessCoin = await coin('jess');
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: -(jessCoin - 5), note: 'spent' });
  const snap2 = JSON.stringify([await items('jess'), await items('tom'), await coin('jess'), await coin('tom')]);
  assert.equal((await call('POST', C(`/trades/${t2.id}/accept`), T.tom, {})).status, 409);
  assert.equal(JSON.stringify([await items('jess'), await items('tom'), await coin('jess'), await coin('tom')]), snap2);
  // A trade whose offered item was given away since is no longer possible.
  await ok('POST', `/api/worlds/${W}/live/ledger`, T.dm, { owner: ID.jess, amountCp: 1000, note: 'refund' });
  await ok('POST', `/api/worlds/${W}/inventory/${ruby.id}/move`, T.jess, { to: 'party' });
  assert.equal((await call('POST', C(`/trades/${t2.id}/accept`), T.tom, {})).status, 409);
});

test('TestSessionChat_GivingWorksBetweenTwoPlayers', async () => {
  const before = { jess: await coin('jess'), tom: await coin('tom') };
  await ok('POST', `/api/worlds/${W}/inventory/coin/transfer`, T.jess, { to: ID.tom, amountCp: 30, note: 'thanks' });
  assert.equal(await coin('jess'), before.jess - 30);
  assert.equal(await coin('tom'), before.tom + 30);
  const lamp = await ok('POST', `/api/worlds/${W}/inventory`, T.dm, { owner: ID.jess, name: 'Lamp', qty: 1, reason: 'test' });
  await ok('POST', `/api/worlds/${W}/inventory/${lamp.id}/move`, T.jess, { to: ID.tom });
  assert.ok((await items('tom')).some((x) => x.name === 'Lamp'));
  assert.equal((await call('POST', `/api/worlds/${W}/inventory/${lamp.id}/move`, T.jess, { to: ID.jess })).status, 403, 'not hers any more');
  // Coin requests exist.
  const rq = await ok('POST', `/api/worlds/${W}/inventory/coin-requests`, T.jess, { to: ID.tom, amountCp: 5, note: 'beer' });
  assert.ok(rq.id);
});

test('TestSessionChat_EndingTheSessionMakesChatsReadOnly', async () => {
  const m = await say('jess', 'table', 'last words');
  const pm = await say('jess', 'party', 'last party words');
  const cur = (await ok('GET', C('/current'), T.jess)).session;
  assert.equal((await call('POST', C('/sessions/end'), T.jess, {})).status, 403);
  const ended = await ok('POST', C('/sessions/end'), T.dm, {});
  assert.equal(ended.open, false);
  assert.equal((await call('POST', C('/sessions/end'), T.dm, {})).status, 409);
  assert.equal((await call('POST', C('/chat/table'), T.jess, { body: 'more' })).status, 409);
  assert.equal((await call('POST', C('/chat/party'), T.jess, { body: 'more' })).status, 409);
  assert.equal((await call('PATCH', C(`/messages/${m.id}`), T.jess, { body: 'edit' })).status, 409);
  assert.equal((await call('DELETE', C(`/messages/${pm.id}`), T.jess)).status, 409);
  assert.equal((await call('POST', C(`/messages/${m.id}/react`), T.tom, { emoji: '👍' })).status, 409);
  assert.equal((await ok('GET', C('/current'), T.jess)).session, null);
  // History stays readable by the right people.
  const hist = await ok('GET', C(`/chat/party?session=${cur.id}`), T.tom);
  assert.ok(hist.messages.some((x: any) => x.id === pm.id));
  assert.equal((await call('GET', C(`/chat/party?session=${cur.id}`), T.dm)).status, 403);
  assert.ok((await ok('GET', C(`/chat/table?session=${cur.id}`), T.dm)).messages.some((x: any) => x.id === m.id));
  const list = await ok('GET', C('/sessions'), T.dm);
  assert.deepEqual(Object.keys(list[0].counts), ['table']);
});

test('TestSessionChat_RecordingOrPresenceStartsASession', async () => {
  // The DM just ended the last one; nothing restarts on its own.
  assert.equal((await ok('GET', C('/current'), T.jess)).session, null);
  // A recording that starts afterwards makes one; it ends when the recording stops.
  run(deps.db, 'INSERT INTO audio_sessions (id, world_id, name, started_at, started_by) VALUES (?, ?, ?, ?, ?)', 'aud_1', W, 'Recorded night', new Date(Date.now() + 1000).toISOString(), ID.dm);
  const s = (await ok('GET', C('/current'), T.jess)).session;
  assert.equal(s.source, 'audio');
  assert.equal(s.title, 'Recorded night');
  run(deps.db, 'UPDATE audio_sessions SET stopped_at = ? WHERE id = ?', new Date().toISOString(), 'aud_1');
  assert.equal((await ok('GET', C('/current'), T.jess)).session, null);
  // Players checking in on /live make one too.
  await new Promise((r) => setTimeout(r, 20));
  await ok('PUT', `/api/worlds/${W}/live/presence`, T.jess, { location: 'At the table' });
  const live = (await ok('GET', C('/current'), T.tom)).session;
  assert.equal(live.source, 'live');
  await say('jess', 'table', 'we are live');
  await ok('DELETE', `/api/worlds/${W}/live/presence`, T.jess);
  assert.equal((await ok('GET', C('/current'), T.tom)).session, null);
});
