// The last line of defence (core/ai.ts): before any request leaves for a model,
// its text is checked against every 8-word run of classified text in every
// world. A hit refuses the call (ClassifiedRefused) and writes an audit row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { all } from '../src/core/db.ts';
import { ClassifiedRefused, ModelUnavailable, chat, chatJson, chatStream, embed, screenOutgoing, speak, transcribe } from '../src/core/ai.ts';
import { baseOf, client, MODEL_ENV, fakeModels, recordMounts } from './security-kit.ts';
import { makeAccounts, type Seed } from './security-world.ts';

recordMounts();

const SECRET = 'The sealed vault beneath the old lighthouse opens only for the bearer of the moonlit brass key';
const OTHER = 'Queen Aldreda secretly poisoned her own brother at the midwinter feast of the drowned saints';
const DM_ONLY = 'The smuggler captain Velmira hides her ledger under the third floorboard of the tavern';

let server: any;
let tmp = '';
let deps: any;
let S: Seed;
const models = fakeModels(fetch);
const http = client(() => baseOf(server));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-secguard-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: models.fetch, env: { ...MODEL_ENV, ALX_RATE_LIMIT: '0' } });
  deps = made.deps;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  S = await makeAccounts({ ...http, deps });
  const L = deps.library;
  L.save(S.W, { path: 'secret/vault.md', title: 'Vault', body: `# Vault\n${SECRET}.\n`, visibility: 'classified' }, null);
  L.save(S.W, { path: 'dm/ledger.md', title: 'Ledger', body: `# Ledger\n${DM_ONLY}.\n`, visibility: 'dm' }, null);
  L.save(S.W, { path: 'lore/public.md', title: 'Public', body: '# Public\nThe harbour is run by a council of seven captains who meet at dusk.\n', visibility: 'party' }, null);
  // Another world: its classified text is refused in this one too.
  L.save(S.W2, { path: 'secret/queen.md', title: 'Queen', body: `# Queen\n${OTHER}.\n`, visibility: 'classified' }, null);
});

after(() => {
  server?.close();
  server?.closeAllConnections?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const refusals = () => all<any>(deps.db, "SELECT * FROM audit WHERE action = 'ai.classified_refused'");
const calls = () => models.calls.length;

async function refused(label: string, run: () => Promise<unknown>) {
  const before = calls();
  await assert.rejects(run, (e: any) => e instanceof ClassifiedRefused && e instanceof ModelUnavailable && /classified/i.test(e.message), `${label} throws ClassifiedRefused`);
  assert.equal(calls(), before, `${label}: nothing was sent`);
}

test('TestSecurityGuard_EveryModelCallRefusesClassifiedText', async () => {
  const n = refusals().length;
  const msgs = [{ role: 'system' as const, content: 'You help a DM.' }, { role: 'user' as const, content: `Please summarise: ${SECRET}.` }];
  await refused('chat', () => chat(deps, 'chat', { messages: msgs }));
  await refused('chat (audit job)', () => chat(deps, 'audit', { messages: msgs }));
  await refused('chatStream', () => chatStream(deps, 'chat', { messages: msgs }, () => {}));
  await refused('embed', () => embed(deps, ['a harmless line', SECRET]));
  await refused('speak', () => speak(deps, `Read this aloud: ${SECRET}`));
  await refused('transcribe', () => transcribe(deps, new Uint8Array([1, 2, 3]), 'audio/webm', { prompt: `Names: ${SECRET}` }));
  // chatJson never throws for a model problem: it answers null, and still sends nothing.
  const before = calls();
  assert.equal(await chatJson(deps, 'chat', msgs), null);
  assert.equal(calls(), before);
  // The text can hide in an earlier message or in a tool call's arguments.
  await refused('an earlier message', () => chat(deps, 'chat', { messages: [{ role: 'user', content: SECRET }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and now?' }] }));
  await refused('a tool call', () => chat(deps, 'chat', { messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: JSON.stringify({ text: SECRET }) } }] }] }));
  // Another world's classified text, in this world's request.
  await refused('another world', () => chat(deps, 'chat', { messages: [{ role: 'user', content: OTHER }] }));
  // Each refusal is audited, with the world and page but never the text.
  const rows = refusals();
  assert.ok(rows.length - n >= 9, `${rows.length - n} audit rows`);
  for (const r of rows) assert.ok(!/moonlit|lighthouse|Aldreda/i.test(r.detail), 'no classified text in the audit row');
  assert.ok(rows.some((r) => r.world_id === S.W) && rows.some((r) => r.world_id === S.W2));
});

test('TestSecurityGuard_FindsTheTextHoweverItIsWritten', async () => {
  const variants = [
    SECRET.toUpperCase(),
    SECRET.replace(/ /g, '   '),
    `> **${SECRET}**`,
    `- ${SECRET.replace(/ /g, '\n')}`,
    SECRET.replace(/the /g, 'the, '),
    `…${SECRET}…`,
    `Intro text here. ${SECRET.slice(0, 60)}${SECRET.slice(60)} and more after it.`,
    SECRET.replace(/'/g, '’'),
  ];
  for (const v of variants) await refused(v.slice(0, 30), () => chat(deps, 'chat', { messages: [{ role: 'user', content: v }] }));
  // Eight words are enough, seven are not (a short phrase is not a leak by itself).
  const words = SECRET.split(' ');
  await refused('eight words', () => chat(deps, 'chat', { messages: [{ role: 'user', content: words.slice(2, 10).join(' ') }] }));
  const ok = await chat(deps, 'chat', { messages: [{ role: 'user', content: words.slice(2, 9).join(' ') }] });
  assert.ok(ok.content);
});

test('TestSecurityGuard_AllowsEverythingThatIsNotClassified', async () => {
  // DM-only text is for the DM's own agent: only classified text is blocked.
  const r = await chat(deps, 'chat', { messages: [{ role: 'user', content: `Context: ${DM_ONLY}. A long ordinary question about the harbour and its council of seven captains.` }] });
  assert.ok(r.content);
  assert.ok(await embed(deps, [DM_ONLY, 'The harbour is run by a council of seven captains who meet at dusk.']));
  assert.equal((await speak(deps, 'Welcome to the harbour, traveller. The council is waiting for you.')).audio.length > 0, true);
});

test('TestSecurityGuard_FollowsEveryChangeToAPage', async () => {
  const L = deps.library;
  const secret2 = 'A second secret about the drowned bell that rings thrice before every storm in autumn';
  const say = (t: string) => chat(deps, 'chat', { messages: [{ role: 'user', content: t }] });
  assert.ok(await say(secret2), 'not classified yet');
  // A new classified page.
  L.save(S.W, { path: 'secret/bell.md', title: 'Bell', body: `# Bell\n${secret2}.\n`, visibility: 'classified' }, null);
  await refused('new classified page', () => say(secret2));
  // A classified block in a shared page (the rest of the page is fine).
  const b = 'A hidden tunnel connects the chapel crypt to the old harbour wall behind the salt warehouse';
  L.save(S.W, { path: 'lore/chapel.md', title: 'Chapel', body: `# Chapel\nThe chapel is open to all pilgrims.\n\n> [!classified]\n> ${b}\n`, visibility: 'party' }, null);
  await refused('classified block', () => say(b));
  assert.ok(await say('The chapel is open to all pilgrims and the door is never locked at night.'));
  // The DM lowers the level: the text may be sent.
  L.setLevel(S.W, 'secret/bell.md', 'dm', null);
  assert.ok(await say(secret2), 'a DM-level page may be sent');
  // And raises it again.
  L.setLevel(S.W, 'secret/bell.md', 'classified', null);
  await refused('classified again', () => say(secret2));
  // Editing the classified words away.
  L.save(S.W, { path: 'secret/bell.md', title: 'Bell', body: '# Bell\nNothing to see here.\n', visibility: 'classified' }, null);
  assert.ok(await say(secret2), 'the old words are no longer classified');
  // Deleting the page.
  L.save(S.W, { path: 'secret/temp.md', title: 'Temp', body: '# Temp\nThe fisherman buried the black pearl beneath the third mooring post at low tide.\n', visibility: 'classified' }, null);
  await refused('before delete', () => say('the fisherman buried the black pearl beneath the third mooring post at low tide'));
  L.remove(S.W, all<any>(deps.db, "SELECT id FROM pages WHERE path = 'secret/temp.md'")[0].id);
  assert.ok(await say('the fisherman buried the black pearl beneath the third mooring post at low tide'));
  // Text that is classified on one page and public on another is not blocked (a model may read it anywhere else).
  L.save(S.W, { path: 'lore/echo.md', title: 'Echo', body: `# Echo\n${OTHER}.\n`, visibility: 'party' }, null);
  assert.ok(await say(OTHER), 'the same words are public on another page');
});

test('TestSecurityGuard_IsFast', async () => {
  // 400 pages, 40 of them classified: build the index once, then time prompts of typical and large size.
  const L = deps.library;
  const para = (i: number, k: number) => Array.from({ length: 60 }, (_x, j) => `w${i}x${j}y${k}`).join(' ');
  for (let i = 0; i < 400; i++) L.save(S.W, { path: `bulk/p${i}.md`, title: `P${i}`, body: `# P${i}\n${para(i, 0)}\n\n${i % 10 === 0 ? `> [!classified]\n> ${para(i, 99)}\n` : ''}`, visibility: i % 3 === 0 ? 'dm' : 'party' }, null, { batch: true });
  L.rebuildPlayerCopies(S.W);
  let t0 = performance.now();
  const size = L.classifiedGrams().size;
  const buildMs = performance.now() - t0;
  assert.ok(size > 2000, `${size} runs indexed`);
  assert.ok(buildMs < 3000, `index built in ${Math.round(buildMs)} ms`);
  const typical = `You are the assistant of the Dungeon Master.\n${para(3, 0)}\n${para(7, 0)}\n${para(9, 0)}\nWho runs the harbour council and what do they want? `.repeat(2);
  const big = Array.from({ length: 30 }, (_x, i) => para(i, 0)).join('\n');
  for (const [label, text, limit] of [['typical prompt', typical, 5], ['large prompt', big, 25]] as const) {
    for (let i = 0; i < 20; i++) screenOutgoing(deps, 'chat', [text]); // warm up
    t0 = performance.now();
    const runs = 300;
    for (let i = 0; i < runs; i++) screenOutgoing(deps, 'chat', [text]);
    const per = (performance.now() - t0) / runs;
    console.log(`# guard: ${label} (${text.length} chars, ${size} classified runs indexed in ${Math.round(buildMs)} ms): ${per.toFixed(3)} ms per check`);
    assert.ok(per < limit, `${label} (${text.length} chars): ${per.toFixed(3)} ms per check`);
    if (label === 'typical prompt') assert.ok(per < 5);
  }
  // Writing a page marks the index stale; the next check rebuilds it once.
  L.save(S.W, { path: 'bulk/new.md', title: 'New', body: '# New\nplain text', visibility: 'party' }, null);
  t0 = performance.now();
  screenOutgoing(deps, 'chat', [typical]);
  assert.ok(performance.now() - t0 < 3000);
});

test('TestSecurityGuard_AnswersToModelsAreCheckedToo', async () => {
  const W = `/api/worlds/${S.W}`;
  const asModel = { 'X-Alexandria-Caller': 'model' };
  // The DM typed classified words into a sculpt value; the model call was refused but the history keeps what the DM wrote.
  await http.call('POST', `${W}/sculpt/run`, S.T.dm, { template: 'npc', values: { name: SECRET } });
  const app = await http.call('GET', `${W}/sculpt/history`, S.T.dm);
  assert.equal(app.status, 200);
  assert.ok(app.text.includes('moonlit'), 'the DM sees their own history in the app');
  const model = await http.call('GET', `${W}/sculpt/history`, S.T.dm, undefined, asModel);
  assert.equal(model.status, 409);
  assert.ok(!model.text.includes('moonlit'), 'a model gets a refusal, not the text');
  assert.ok(all<any>(deps.db, "SELECT detail FROM audit WHERE action = 'ai.classified_withheld'").length >= 1);
  // Through MCP the same.
  const rpc = await http.call('POST', '/mcp', S.K.dmWrite, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sculpt_templates', arguments: {} } });
  assert.ok(!rpc.text.includes('moonlit'));
  // And the model gateway refuses to carry it out.
  const gw = await http.call('POST', '/v1/chat/completions', S.T.dm, { messages: [{ role: 'user', content: SECRET }] });
  assert.equal(gw.status, 422);
  const fine = await http.call('POST', '/v1/chat/completions', S.T.dm, { messages: [{ role: 'user', content: 'hello there' }] });
  assert.equal(fine.status, 200);
});
