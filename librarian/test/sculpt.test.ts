// Sculpting: seeded templates, one model call per sculpt, locks, secret blocks
// on save, the player-scene leak check, custom templates, no-model fallback.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

const DM_SECRET = 'The harbour council secretly answers to the smuggler queen Velmira every single night';
const cleanups: (() => void)[] = [];
after(() => { for (const c of cleanups) c(); });

interface Model { calls: any[]; reply: (blank: string[], body: any) => any }
async function boot(withModel: boolean) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-sculpt-'));
  const model: Model = { calls: [], reply: (blank) => Object.fromEntries(blank.map((k) => [k, `filled ${k}`])) };
  const fake = (async (url: any, init?: any) => {
    if (String(url).startsWith('http://fake.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      model.calls.push(body);
      const user = JSON.parse(body.messages[1].content);
      const out = model.reply(user.blank.map((f: any) => f.key), user);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, init);
  }) as typeof fetch;
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ...(withModel ? { ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake' } : {}) }, fetch: fake });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let json: any = t;
    try { json = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sculptland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  const page = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown });
  await page('places/Saltmarsh', 'party', `# Saltmarsh\nSaltmarsh is a fishing town of grey roofs and gulls.\n\n> [!secret] DM\n> ${DM_SECRET}.\n`);
  const S = `/api/worlds/${W}/sculpt`;
  return { made, model, T, W, S, call, ok };
}
const tplId = async (e: Awaited<ReturnType<typeof boot>>, name: string) => (await e.ok('GET', `${e.S}/templates`, e.T.dm)).templates.find((t: any) => t.name === name).id;

const env = await boot(true);
const bare = await boot(false);

test('Sculpt: the built-in templates are seeded per world and cannot be deleted', async () => {
  const { templates } = await env.ok('GET', `${env.S}/templates`, env.T.dm);
  const names = templates.map((t: any) => t.name);
  for (const n of ['Quick statblock', 'NPC for quick RP', 'Shop or store', 'Scene, DM perspective', 'Scene, player perspective', 'Tavern', 'Quest hook']) assert.ok(names.includes(n), n);
  assert.ok(templates.every((t: any) => t.builtin));
  assert.equal((await bare.ok('GET', `${bare.S}/templates`, bare.T.dm)).templates.length, templates.length);
  const id = templates[0].id;
  assert.equal((await env.call('DELETE', `${env.S}/templates/${id}`, env.T.dm)).status, 409);
  // A built-in is an editable copy.
  const t = templates.find((x: any) => x.name === 'Tavern');
  const put = await env.ok('PUT', `${env.S}/templates/${t.id}`, env.T.dm, { ...t, description: 'Mine now' });
  assert.equal(put.description, 'Mine now');
  const reset = await env.ok('POST', `${env.S}/templates/${t.id}/reset`, env.T.dm);
  assert.notEqual(reset.description, 'Mine now');
});

test('Sculpt: one model call fills only the empty fields and keeps locked ones', async () => {
  const id = await tplId(env, 'NPC for quick RP');
  env.model.calls.length = 0;
  const r = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: id, values: { name: 'Mara Quill', look: 'Tall and ink-stained', voice: '' }, lock: ['voice'] });
  assert.equal(env.model.calls.length, 1);
  assert.equal(r.values.name, 'Mara Quill');
  assert.equal(r.values.look, 'Tall and ink-stained');
  assert.equal(r.values.voice, '', 'a locked empty field stays empty');
  assert.equal(r.values.wants, 'filled wants');
  assert.ok(r.filled.includes('secret') && !r.filled.includes('look') && !r.filled.includes('voice'));
  assert.ok(r.md.includes('> [!secret] DM'));
  // The prompt names only the blank fields; the filled ones are context.
  const user = JSON.parse(env.model.calls[0].messages[1].content);
  assert.ok(!user.blank.some((f: any) => f.key === 'name' || f.key === 'look' || f.key === 'voice'));
  assert.equal(user.filled.name, 'Mara Quill');
  // Re-roll one field: still one call, others untouched.
  env.model.calls.length = 0;
  const again = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: id, values: r.values, only: ['wants'] });
  assert.equal(env.model.calls.length, 1);
  assert.deepEqual(JSON.parse(env.model.calls[0].messages[1].content).blank.map((f: any) => f.key), ['wants']);
  assert.equal(again.values.look, 'Tall and ink-stained');
  // Names come from a generator, not the model: a fully typed sheet but a blank name makes no extra call.
  env.model.calls.length = 0;
  const gen = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: id, values: {} });
  assert.ok(gen.values.name.trim().length > 2 && !gen.values.name.startsWith('filled'));
  assert.equal(env.model.calls.length, 1);
  const hist = await env.ok('GET', `${env.S}/history`, env.T.dm);
  assert.ok(hist.history.length >= 2);
});

test('Sculpt: a shop is stocked without the model and a quick statblock is checked', async () => {
  const shop = await tplId(env, 'Shop or store');
  env.model.calls.length = 0;
  const r = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: shop, values: { name: 'The Anvil', kind: 'smith', owner: 'Brann', location: 'Dock row', price: 'dear', haggling: 'Hates being rushed' } });
  assert.equal(env.model.calls.length, 0, 'nothing left for the model');
  assert.match(r.values.inventory, /—\s*\d/);
  const sbT = await tplId(env, 'Quick statblock');
  env.model.reply = (blank) => Object.fromEntries(blank.map((k) => [k, k === 'statblock' ? { name: 'Bog Ghoul', ac: 12, hp: 30, speed: { walk: '30 ft.' }, abilities: { str: 14, dex: 12, con: 12, int: 6, wis: 10, cha: 6 }, actions: [{ name: 'Claw', text: 'Melee Attack Roll: +4. Hit: 7 (1d8+3) Slashing damage.' }] } : k === 'cr' ? '1' : k === 'role' ? 'brute' : 'x']));
  const s = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: sbT, values: { name: 'Bog Ghoul' } });
  env.model.reply = (blank) => Object.fromEntries(blank.map((k) => [k, `filled ${k}`]));
  assert.match(s.md, /Bog Ghoul/);
  assert.match(s.md, /statblock-json/);
  const saved = await env.ok('POST', `${env.S}/save`, env.T.dm, { templateId: sbT, values: s.values });
  assert.equal(saved.kind, 'combat');
  const c = await env.ok('POST', `${env.S}/combat`, env.T.dm, { templateId: sbT, values: s.values, pageId: saved.pageId });
  assert.equal(c.combatant.hp, 30);
  const live = await env.ok('GET', `/api/worlds/${env.W}/live/combat`, env.T.dm);
  assert.ok(JSON.stringify(live).includes('Bog Ghoul'));
});

test('Sculpt: DM-only sections become secret blocks that players never see', async () => {
  const id = await tplId(env, 'NPC for quick RP');
  const values = { name: 'Orrin Vale', race: 'Human', role: 'Ferryman', look: 'Stooped', voice: 'Slow', wants: 'Quiet', knows: 'The tides', secret: 'Orrin ferries stolen goods past the watch every moonless night', hook: 'He needs a courier' };
  const saved = await env.ok('POST', `${env.S}/save`, env.T.dm, { templateId: id, values, target: { visibility: 'party' } });
  assert.equal(saved.kind, 'person');
  const dmPage = await env.ok('GET', `/api/worlds/${env.W}/library/pages/${saved.pageId}`, env.T.dm);
  assert.match(dmPage.body, /> \[!secret\] DM/);
  assert.match(dmPage.body, /stolen goods/);
  const pp = await env.ok('GET', `/api/worlds/${env.W}/library/pages/${saved.pageId}`, env.T.jess);
  assert.ok(!JSON.stringify(pp).includes('stolen goods'), 'the player copy has no secret');
  assert.ok(JSON.stringify(pp).includes('Ferryman'));
  const people = await env.ok('GET', `/api/worlds/${env.W}/people`, env.T.jess);
  assert.ok(people.some((p: any) => p.name === 'Orrin Vale'));
  const search = await env.ok('GET', `/api/worlds/${env.W}/library/search?q=${encodeURIComponent('stolen goods moonless')}`, env.T.jess);
  assert.ok(!JSON.stringify(search).includes('stolen'));
  // A shop's haggling notes too.
  const shop = await tplId(env, 'Shop or store');
  const sv = await env.ok('POST', `${env.S}/save`, env.T.dm, { templateId: shop, values: { name: 'Salt & Iron', kind: 'smith', owner: 'Brann', location: 'Dock', price: 'fair', inventory: '- Dagger — 2 gp\n- Shield — 10 gp', haggling: 'Gives way when you mention her late husband' }, target: { visibility: 'party' } });
  assert.deepEqual(sv.items, [{ name: 'Dagger', price: '2 gp' }, { name: 'Shield', price: '10 gp' }]);
  const sp = await env.ok('GET', `/api/worlds/${env.W}/library/pages/${sv.pageId}`, env.T.jess);
  assert.ok(!JSON.stringify(sp).includes('late husband'));
});

test('Sculpt: the player-perspective scene never contains DM-only text, even when the model echoes it', async () => {
  const id = await tplId(env, 'Scene, player perspective');
  env.model.calls.length = 0;
  env.model.reply = (blank) => Object.fromEntries(blank.map((k) => [k, k === 'description' ? `You walk the quay. ${DM_SECRET}. Gulls wheel overhead.` : 'grey and damp']));
  const r = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: id, values: { location: 'Saltmarsh' } });
  env.model.reply = (blank) => Object.fromEntries(blank.map((k) => [k, `filled ${k}`]));
  assert.equal(r.values.description, '', 'the leaking field is blocked');
  assert.ok(r.leaks.some((l: any) => l.key === 'description'));
  assert.ok(!r.md.includes('Velmira'));
  // The model saw player copies only.
  assert.equal(env.model.calls.length, 1);
  assert.ok(!JSON.stringify(env.model.calls[0]).includes('Velmira'), 'no DM text in the model context');
  assert.ok(JSON.stringify(env.model.calls[0]).includes('gulls'), 'the player copy is used');
  // Saving, checking and sending refuse a leaking text typed by hand too.
  const leaky = { location: 'Saltmarsh', description: `${DM_SECRET}.` };
  assert.equal((await env.call('POST', `${env.S}/save`, env.T.dm, { templateId: id, values: leaky })).status, 409);
  assert.equal((await env.call('POST', `${env.S}/send`, env.T.dm, { templateId: id, values: leaky })).status, 409);
  const chk = await env.ok('POST', `${env.S}/check`, env.T.dm, { templateId: id, values: leaky });
  assert.equal(chk.ok, false);
  assert.ok(!chk.md.includes('Velmira'));
  // A clean one is sent to the players as a message.
  const clean = { location: 'Saltmarsh', time: 'Dusk', description: 'Lanterns flicker along the quay as the tide turns.' };
  await env.ok('POST', `${env.S}/send`, env.T.dm, { templateId: id, values: clean });
  const threads = await env.ok('GET', `/api/worlds/${env.W}/messages`, env.T.jess);
  assert.ok(threads.some((t: any) => t.last?.includes('Lanterns')));
  // DM templates cannot be sent.
  assert.equal((await env.call('POST', `${env.S}/send`, env.T.dm, { templateId: await tplId(env, 'Tavern'), values: {} })).status, 422);
});

test('Sculpt: custom templates can be created, edited and deleted', async () => {
  const body = { name: 'Trinket', description: 'A pocket oddity', perspective: 'dm', fields: [{ key: 'what', label: 'What', type: 'item' }, { key: 'worth', label: 'Worth', type: 'coins' }, { key: 'story', label: 'Story', type: 'longtext', dmOnly: true }], body: '# {{what}}\nWorth {{worth}}\n\n{{#dm}}\n{{story}}\n{{/dm}}\n', target: { kind: 'page', path: 'Trinkets/{{what}}', visibility: 'dm' } };
  const made = await env.ok('POST', `${env.S}/templates`, env.T.dm, body);
  assert.equal(made.builtin, false);
  assert.equal((await env.call('POST', `${env.S}/templates`, env.T.dm, { ...body, body: '{{nope}}' })).status, 422);
  assert.equal((await env.call('POST', `${env.S}/templates`, env.T.dm, { ...body, perspective: 'player' })).status, 422);
  env.model.calls.length = 0;
  const r = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: made.id, values: {} });
  assert.ok(r.values.what && /gp$/.test(r.values.worth));
  assert.equal(env.model.calls.length, 1);
  const up = await env.ok('PUT', `${env.S}/templates/${made.id}`, env.T.dm, { ...body, name: 'Trinket 2' });
  assert.equal(up.name, 'Trinket 2');
  const saved = await env.ok('POST', `${env.S}/save`, env.T.dm, { templateId: 'Trinket 2', values: r.values });
  assert.ok(saved.path.startsWith('Trinkets/'));
  await env.ok('DELETE', `${env.S}/templates/${made.id}`, env.T.dm);
  assert.equal((await env.call('GET', `${env.S}/templates`, env.T.dm)).body.templates.some((t: any) => t.id === made.id), false);
});

test('Sculpt: without a chat model the generators fill what they can and the rest says so', async () => {
  const id = await tplId(bare, 'NPC for quick RP');
  const r = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: id, values: {} });
  assert.equal(r.model, false);
  assert.ok(r.values.name.length > 2);
  assert.equal(r.values.look, '');
  assert.ok(r.notes.some((n: string) => /No chat model/.test(n)));
  const shop = await tplId(bare, 'Shop or store');
  const s = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: shop, values: { kind: 'alchemist' } });
  assert.match(s.values.inventory, /gp|sp|cp/);
});

test('Sculpt: players get 403 everywhere, and the MCP tool is a write tool', async () => {
  for (const [m, u] of [['GET', '/templates'], ['POST', '/run'], ['POST', '/save'], ['POST', '/send'], ['POST', '/check'], ['GET', '/history'], ['POST', '/templates']] as const) {
    assert.equal((await env.call(m, `${env.S}${u}`, env.T.jess, m === 'POST' ? {} : undefined)).status, 403, `${m} ${u}`);
  }
  const { featureMcpTools } = await import('../src/features/registry.ts');
  const t = featureMcpTools().find((x) => x.name === 'sculpt');
  assert.ok(t?.write);
  assert.equal(t!.call({ template: 'Tavern' }).path, '/sculpt/run');
});
