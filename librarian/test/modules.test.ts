// Game modules: built-ins, order on clashes, rules search ranking, keyword
// matching (longest, whole words, never DM-only titles for players), and the
// zip / folder / JSON / git / API importers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { readZip } from '../src/features/modules/zip.ts';

let base = '';
let server: any;
let tmp = '';
const T: Record<string, string> = {};
const ID: Record<string, string> = {};
let W = '';
const M = () => `/api/worlds/${W}/modules`;

async function call(method: string, url: string, token?: string, body?: unknown, raw?: { type: string; data: Buffer }) {
  const r = await fetch(base + url, {
    method,
    headers: { ...(raw ? { 'Content-Type': raw.type } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body),
  });
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

/** Build a zip (stored or deflated) without a library. */
function makeZip(files: Record<string, string>, opts: { fakeSize?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameB = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(opts.fakeSize ?? data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    parts.push(lh, nameB, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(opts.fakeSize ?? data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    cd.push(ch, nameB);
    offset += lh.length + nameB.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const FILES: Record<string, string> = {
  'spells/Ember Lance.md': '---\nkind: spell\naliases: [Lance of Embers, ember bolt]\nsummary: A thin line of fire.\n---\nYou hurl a **lance** of embers. 2d6 fire damage.\n',
  'rules/Slow Falling.md': '# Slow Falling\n\nYou drift down at 60 feet per round.\n',
  'conditions/Singed.md': '---\nkind: condition\n---\nA singed creature has disadvantage on Stealth checks.\n',
  'notes/readme.md': 'Ignore me.',
};

const fakeFetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith('http://rules.example.test/api')) {
    const p = Number(new URL(u).searchParams.get('page') ?? 1);
    const pages: any[] = [
      { data: { items: [{ name: 'Moonflare', slug: 'moonflare', type: 'Spell', desc: '<p>A <b>big</b> boom.</p>', alt: 'Boom' }, { name: 'Quickstep', slug: 'quickstep', type: 'Spell', desc: '<p>Fast.</p>' }] } },
      { data: { items: [{ name: 'Quilloth', slug: 'quilloth', type: 'Monster', desc: '<p>Small and mean.</p>', stats: { ac: 15 } }] } },
      { data: { items: [] } },
    ];
    return new Response(JSON.stringify(pages[p - 1] ?? pages[2]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return fetch(url, init);
}) as typeof fetch;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-mod-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ALLOW_LOCAL_URLS: '1' }, fetch: fakeFetch });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  ID.dm = dm.account.id;
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Modland', dmAccountId: ID.dm })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  const j = await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' });
  T.jess = j.token;
});

after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const importJson = (mod: any, extra: any = {}) => call('POST', `${M()}/import`, T.dm, { type: 'json', json: mod, ...extra });
const termIds = async (q: string, token = T.jess) => (await ok('GET', `${M()}/terms?q=${encodeURIComponent(q)}`, token)).terms as any[];

test('Modules: the 2024 SRD is on by default, with its attribution', async () => {
  const r = await ok('GET', `${M()}/`, T.jess);
  assert.deepEqual(r.modules.map((m: any) => m.id), ['dnd-2024']);
  assert.match(r.modules[0].attribution, /System Reference Document 5\.2/);
  assert.match(r.modules[0].attribution, /creativecommons\.org\/licenses\/by\/4\.0/);
  assert.equal(r.modules[0].license, 'CC-BY-4.0');
  assert.deepEqual(r.available.map((m: any) => m.id).sort(), ['dnd-2014', 'dnd-2024']);
  const blinded = (await termIds('Blinded'))[0];
  assert.equal(blinded.kind, 'condition');
  const full = await ok('GET', `${M()}/terms/${encodeURIComponent(blinded.id)}`, T.jess);
  assert.match(full.text, /Can't See/);
  const fireball = (await termIds('Fireball'))[0];
  const spell = await ok('GET', `${M()}/terms/${encodeURIComponent(fireball.id)}`, T.jess);
  assert.equal(spell.data.level, 3);
  const dragon = await ok('GET', `${M()}/terms/${encodeURIComponent((await termIds('Adult Blue Dragon'))[0].id)}`, T.jess);
  assert.equal(dragon.data.abilities.str, 25);
  assert.ok(Array.isArray(dragon.data.actions) && dragon.data.actions.length > 0);
  const conds = await ok('GET', `${M()}/terms?kind=condition&limit=100`, T.jess);
  assert.ok(conds.total >= 14, 'all conditions are bundled');
});

test('Modules: only a DM changes which modules are on', async () => {
  assert.equal((await call('PUT', `${M()}/enabled`, T.jess, { ids: ['dnd-2014'] })).status, 403);
  assert.equal((await call('PUT', `${M()}/enabled`, T.dm, { ids: ['nope'] })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.jess, { type: 'json', json: {} })).status, 403);
  assert.equal((await call('POST', `${M()}/import`, T.jess, { type: 'json', json: {} })).status, 403);
});

test('Modules: earlier modules win on a clash, and order can change', async () => {
  const home = { id: 'house', name: 'House rules', terms: [{ term: 'Grapple', kind: 'rule', summary: 'House: grapple is a bonus action.', text: 'House rule grapple text.' }, { term: 'Fireball', kind: 'spell', summary: 'House fireball.', text: 'House fireball text.' }] };
  await ok('POST', `${M()}/import`, T.dm, { type: 'json', json: home, enable: false });
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['house', 'dnd-2024'] });
  let g = (await termIds('Grapple')).filter((t: any) => t.kind === 'rule' && t.term === 'Grapple');
  assert.equal(g.length, 1, 'one Grapple, the clash is resolved');
  assert.equal(g[0].moduleId, 'house');
  const f = (await termIds('Fireball')).filter((t: any) => t.term === 'Fireball');
  assert.equal(f.length, 1);
  assert.equal(f[0].moduleId, 'house');
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2024', 'house'] });
  g = (await termIds('Grapple')).filter((t: any) => t.term === 'Grapple');
  assert.equal(g.length, 1);
  assert.equal(g[0].moduleId, 'dnd-2024');
  // Both SRDs on: the 2024 one first, and Fireball appears once.
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2024', 'dnd-2014'] });
  const both = (await termIds('Fireball')).filter((t: any) => t.term === 'Fireball');
  assert.equal(both.length, 1);
  assert.equal(both[0].moduleId, 'dnd-2024');
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2014', 'dnd-2024'] });
  assert.equal((await termIds('Fireball')).filter((t: any) => t.term === 'Fireball')[0].moduleId, 'dnd-2014');
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2024'] });
  await ok('DELETE', `${M()}/imported/house`, T.dm);
});

test('Modules: rules search ranks the right rule first, with citations', async () => {
  const top = async (q: string, n = 1) => ((await ok('GET', `${M()}/rules/search?q=${encodeURIComponent(q)}&limit=${n}`, T.jess)).results as any[]);
  const g = (await top('How does grappling work?'))[0];
  assert.equal(g.term, 'Grapple');
  assert.match(g.citation, /D&D 2024 \(SRD 5\.2\): Grapple/);
  assert.match(g.passage, /Grappled condition/);
  assert.equal((await top('cover'))[0].term, 'Cover');
  assert.equal((await top('what are death saves'))[0].term, 'Death Saving Throw');
  assert.equal((await top('how do opportunity attacks work'))[0].term, 'Opportunity Attack');
  assert.equal((await top('what does the Dodge action do'))[0].term, 'Dodge');
  assert.equal((await top('how long is a long rest'))[0].term, 'Long Rest');
  assert.equal((await top('what does the blinded condition do'))[0].term, 'Blinded');
  assert.equal((await top('fireball'))[0].term, 'Fireball');
  assert.deepEqual(await top('the and of'), [], 'only stop words finds nothing');
  const many = await top('grapple', 5);
  assert.ok(many.length > 1 && many[0].score >= many[1].score, 'sorted by score');
  // The same questions against the 2014 module cite it.
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2014'] });
  const old = (await top('cover'))[0];
  assert.equal(old.term, 'Cover');
  assert.match(old.citation, /SRD 5\.1/);
  await ok('PUT', `${M()}/enabled`, T.dm, { ids: ['dnd-2024'] });
});

test('Modules: match finds the longest whole-word phrase, case-insensitively', async () => {
  await importJson({ id: 'ash', name: 'Ash tales', terms: [{ term: 'Ash', kind: 'other', text: 'x' }, { term: 'Ash Wraith', kind: 'monster', aliases: ['Cinder Ghost'], text: 'y' }, { term: 'Wraith', kind: 'monster', text: 'z' }] });
  const text = 'An ASH   wraith rose. Ashes fell, and a cinder ghost watched the wraiths. Ash\'s glow; the Ash-Wraith flees.';
  const ms = (await call('POST', `${M()}/match`, T.jess, { text })).body as any[];
  const hit = (m: any) => text.slice(m.start, m.end);
  assert.deepEqual(ms.map(hit), ['ASH   wraith', 'cinder ghost', "Ash", 'Ash-Wraith']);
  assert.equal(ms[0].term, 'Ash Wraith');
  assert.equal(ms[0].source, 'module');
  assert.equal(ms[0].kind, 'monster');
  assert.equal(ms[1].term, 'Ash Wraith', 'aliases match');
  assert.ok(ms.every((m) => !/^Ashes|^wraiths/i.test(hit(m))), 'whole words only: Ashes and wraiths do not match');
  // Plain words with their own entry still match alone.
  const solo = (await call('POST', `${M()}/match`, T.jess, { text: 'the wraith' })).body as any[];
  assert.equal(solo[0].term, 'Wraith');
  // SRD terms.
  const srd = 'He is Blinded, then a Death Saving Throw; cover and Long Rest help.';
  const s = (await call('POST', `${M()}/match`, T.jess, { text: srd })).body as any[];
  assert.deepEqual(s.map((m) => srd.slice(m.start, m.end)), ['Blinded', 'Death Saving Throw', 'cover', 'Long Rest']);
  // Ids lead to cards.
  const card = await ok('GET', `${M()}/card/module/${encodeURIComponent(s[0].id)}`, T.jess);
  assert.equal(card.title, 'Blinded');
  assert.match(card.attribution, /SRD 5\.2/);
  await ok('DELETE', `${M()}/imported/ash`, T.dm);
});

test('Modules: players never match DM-only page titles, aliases or cards', async () => {
  const page = async (p: string, visibility: string, markdown: string) => (await ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown })).id;
  const pub = await page('places/Saltmarsh', 'party', '---\naliases: [The Marsh Town]\n---\n# Saltmarsh\nA fishing town.\n\n> [!secret] DM\n> The council answers to Velmira.\n');
  const secret = await page('dm/Velmira the Smuggler', 'dm', '---\naliases: [Queen of Salt]\n---\n# Velmira the Smuggler\nKeeps her treasury beneath the lighthouse.\n');
  const text = 'In Saltmarsh the Marsh Town folk whisper of Velmira the Smuggler, the Queen of Salt. Velmira the Smuggler waits.';
  const dm = (await call('POST', `${M()}/match`, T.dm, { text })).body as any[];
  const pl = (await call('POST', `${M()}/match`, T.jess, { text })).body as any[];
  const names = (ms: any[]) => ms.map((m) => text.slice(m.start, m.end));
  assert.deepEqual(names(dm), ['Saltmarsh', 'the Marsh Town', 'Velmira the Smuggler', 'Queen of Salt', 'Velmira the Smuggler']);
  assert.ok(dm.every((m) => m.source === 'library'));
  assert.deepEqual(names(pl), ['Saltmarsh', 'the Marsh Town']);
  assert.equal(pl[0].id, pub);
  const flat = JSON.stringify(pl);
  for (const w of ['Velmira', 'Smuggler', 'Queen of Salt', secret]) assert.ok(!flat.includes(w), `leaked ${w}`);
  // The player's card never carries DM text; a DM-only card is a 404.
  assert.equal((await call('GET', `${M()}/card/library/${secret}`, T.jess)).status, 404);
  const pc = await ok('GET', `${M()}/card/library/${pub}`, T.jess);
  assert.match(pc.text, /fishing town/);
  assert.ok(!JSON.stringify(pc).includes('Velmira'), 'secret callout is not in the player card');
  assert.match((await ok('GET', `${M()}/card/library/${secret}`, T.dm)).text, /treasury/);
  // Hiding a shared page removes it for players at once (the index follows the page).
  await page('places/Saltmarsh', 'dm', '# Saltmarsh\nA fishing town.\n');
  const after = (await call('POST', `${M()}/match`, T.jess, { text })).body as any[];
  assert.deepEqual(names(after), []);
  // And sharing a page adds it.
  await page('dm/Velmira the Smuggler', 'party', '# Velmira the Smuggler\nA known rogue.\n');
  assert.deepEqual(names((await call('POST', `${M()}/match`, T.jess, { text })).body), ['Velmira the Smuggler', 'Velmira the Smuggler']);
});

test('Modules: match stays fast with 10,000 terms', async () => {
  const terms = Array.from({ length: 10_000 }, (_, i) => ({ term: `Zorbax Thing ${i} of Number ${i % 97}`, kind: 'other', text: 't' }));
  terms.push({ term: 'Quillfeather', kind: 'monster', text: 'a bird' });
  await importJson({ id: 'big', name: 'Big', terms });
  const sentence = 'The Quillfeather flew past the zorbax thing 42 of number 42 and some ordinary words about nothing at all. ';
  const text = sentence.repeat(600); // ~60k characters
  const t0 = performance.now();
  const ms = (await call('POST', `${M()}/match`, T.jess, { text })).body as any[];
  const first = performance.now() - t0; // includes building the index
  const t1 = performance.now();
  await call('POST', `${M()}/match`, T.jess, { text });
  const second = performance.now() - t1;
  assert.equal(ms.length, 1200);
  assert.ok(first < 3000 && second < 1000, `slow: ${first.toFixed(0)}ms then ${second.toFixed(0)}ms`);
  await ok('DELETE', `${M()}/imported/big`, T.dm);
});

test('Modules: import a zip of Markdown files (preview, then save)', async () => {
  const zip = makeZip({ 'mymod/module.json': JSON.stringify({ name: 'Ember Tales', version: '1', license: 'CC0', attribution: 'By nobody.' }), ...Object.fromEntries(Object.entries(FILES).map(([k, v]) => ['mymod/' + k, v])) });
  const entries = readZip(zip);
  assert.equal(entries.length, 5);
  const pre = await call('POST', `${M()}/import/preview`, T.dm, undefined, { type: 'application/zip', data: zip });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.module.id, 'ember-tales');
  assert.deepEqual(pre.body.counts, { spell: 1, rule: 1, condition: 1 });
  assert.equal(pre.body.total, 3);
  assert.ok(pre.body.samples.length <= 5 && pre.body.samples.length === 3);
  assert.equal(pre.body.module.attribution, 'By nobody.');
  assert.equal((await ok('GET', `${M()}/`, T.dm)).available.some((m: any) => m.id === 'ember-tales'), false, 'preview does not save');
  const saved = await call('POST', `${M()}/import`, T.dm, undefined, { type: 'application/zip', data: zip });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const info = await ok('GET', `${M()}/`, T.jess);
  assert.deepEqual(info.modules.map((m: any) => m.id), ['dnd-2024', 'ember-tales'], 'new modules go last');
  const lance = (await termIds('Lance of Embers'))[0];
  assert.equal(lance.term, 'Ember Lance');
  assert.equal(lance.kind, 'spell');
  assert.equal(lance.summary, 'A thin line of fire.');
  const slow = (await termIds('Slow Falling'))[0];
  assert.equal(slow.kind, 'rule', 'kind comes from the folder name');
  const full = await ok('GET', `${M()}/terms/${encodeURIComponent(slow.id)}`, T.jess);
  assert.match(full.text, /60 feet per round/);
  assert.ok(!full.text.startsWith('# '), 'the H1 became the term name');
  assert.equal((await call('POST', `${M()}/import`, T.dm, undefined, { type: 'application/zip', data: zip })).status, 409, 'saving again needs replace');
  assert.equal((await call('POST', `${M()}/import?replace=1`, T.dm, undefined, { type: 'application/zip', data: zip })).status, 200);
  await ok('DELETE', `${M()}/imported/ember-tales`, T.dm);
  assert.deepEqual((await ok('GET', `${M()}/`, T.jess)).modules.map((m: any) => m.id), ['dnd-2024']);
});

test('Modules: zip limits and bad zips are refused', async () => {
  const bomb = makeZip({ 'a.md': 'a'.repeat(3_000_000) });
  const r = await call('POST', `${M()}/import/preview`, T.dm, undefined, { type: 'application/zip', data: bomb });
  assert.equal(r.status, 413);
  const lying = makeZip({ 'a.md': 'a'.repeat(5000) }, { fakeSize: 10 });
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, undefined, { type: 'application/zip', data: lying })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, undefined, { type: 'application/zip', data: Buffer.from('definitely not a zip file at all') })).status, 400);
  // A zip sent as base64 in JSON works too.
  const small = makeZip({ 'x.md': '# Zed\n\nA letter.\n' });
  const j = await call('POST', `${M()}/import/preview`, T.dm, { type: 'zip', zip: small.toString('base64'), module: { name: 'Zed pack' } });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.equal(j.body.total, 1);
});

test('Modules: import files picked from a folder', async () => {
  const files = Object.entries(FILES).map(([p, text]) => ({ path: 'Pack/' + p, text }));
  const pre = await ok('POST', `${M()}/import/preview`, T.dm, { type: 'folder', files, module: { name: 'Folder pack' } });
  assert.equal(pre.module.id, 'folder-pack');
  assert.deepEqual(pre.counts, { spell: 1, rule: 1, condition: 1 });
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'folder', files: [] })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'folder', files: [{ path: 'a.txt', text: 'nope' }], module: { name: 'x' } })).status, 400, 'no Markdown files, no module');
});

test('Modules: import a JSON module, and refuse junk', async () => {
  const mod = { id: 'tiny', name: 'Tiny', version: '1.0', license: 'MIT', attribution: 'Me', terms: [{ id: 'glim', term: 'Glimmerorb', kind: 'item', summary: 'x'.repeat(500), text: 'A glowing orb.', data: { weight: 1 } }, { term: 'Blip', kind: 'banana', text: 'odd kind' }, { kind: 'rule', text: 'no name' }] };
  const pre = await ok('POST', `${M()}/import/preview`, T.dm, { type: 'json', json: JSON.stringify(mod) });
  assert.equal(pre.total, 2);
  assert.equal(pre.counts.item, 1);
  assert.equal(pre.counts.other, 1, 'unknown kinds become other');
  assert.ok(pre.warnings.some((w: string) => /no name/.test(w)));
  await importJson(mod);
  
  const orb = await ok('GET', `${M()}/terms/${encodeURIComponent('tiny:glim')}`, T.jess);
  assert.ok(orb.summary.length <= 300);
  assert.deepEqual(orb.data, { weight: 1 });
  assert.equal(orb.attribution, 'Me');
  assert.equal((await importJson({ id: 'dnd-2024', name: 'Evil twin', terms: [{ term: 'x', text: 'y' }] })).status, 400, 'built-in ids are reserved');
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'json', json: { name: 'Empty', terms: [] } })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'json', json: { terms: [{ term: 'a' }] } })).status, 400, 'a name is required');
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'json', json: 'not json {' })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'carrier pigeon' })).status, 400);
  await ok('DELETE', `${M()}/imported/tiny`, T.dm);
});

test('Modules: import from a JSON API with a field mapping and paging', async () => {
  const req = { type: 'api', url: 'http://rules.example.test/api', itemsPath: 'data.items', paging: 'page', pageStart: 1, textFormat: 'html', mapping: { term: 'name', id: 'slug', kind: 'type', text: 'desc', aliases: 'alt', data: 'stats' }, module: { name: 'Open rules', license: 'OGL' } };
  const pre = await ok('POST', `${M()}/import/preview`, T.dm, req);
  assert.equal(pre.total, 3);
  assert.deepEqual(pre.counts, { spell: 2, monster: 1 });
  await ok('POST', `${M()}/import`, T.dm, req);
  const fb = await ok('GET', `${M()}/terms/${encodeURIComponent('open-rules:moonflare')}`, T.jess);
  assert.equal(fb.kind, 'spell');
  assert.match(fb.text, /A \*\*big\*\* boom\./, 'HTML became Markdown');
  assert.deepEqual(fb.aliases, ['Boom']);
  const gob = await ok('GET', `${M()}/terms/${encodeURIComponent('open-rules:quilloth')}`, T.jess);
  assert.deepEqual(gob.data, { ac: 15 });
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { ...req, itemsPath: 'nothing.here' })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { ...req, url: 'ftp://x.test/a' })).status, 400);
  await ok('DELETE', `${M()}/imported/open-rules`, T.dm);
});

test('Modules: API imports refuse private addresses unless the host allows them', async () => {
  const strict = createApp({ noScheduler: true, env: {} });
  const s = strict.app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const post = async (u: string, t: string | undefined, body: unknown) => (await fetch(b + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(body) }));
    const setup: any = await (await post('/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).json();
    const dmAcc: any = await (await post('/api/admin/accounts', setup.token, { username: 'dm', password: 'dm password 123' })).json();
    const w: any = await (await post('/api/admin/worlds', setup.token, { name: 'Strict', dmAccountId: dmAcc.account.id })).json();
    const login: any = await (await post('/api/auth/login', undefined, { username: 'dm', password: 'dm password 123' })).json();
    for (const url of ['http://127.0.0.1:9/x', 'http://localhost/x', 'http://192.168.1.5/x', 'http://[::1]/x']) {
      const r = await post(`/api/worlds/${w.id}/modules/import/preview`, login.token, { type: 'api', url, mapping: {} });
      assert.equal(r.status, 400, url);
    }
    const g = await post(`/api/worlds/${w.id}/modules/import/preview`, login.token, { type: 'git', url: '/etc' });
    assert.equal(g.status, 400);
  } finally { s.close(); }
});

test('Modules: import from a git repository (cloned read-only, then read as a folder)', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  for (const [p, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), text); }
  fs.writeFileSync(path.join(repo, 'module.json'), JSON.stringify({ name: 'Git pack', id: 'git-pack', attribution: 'From a repo.' }));
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const pre = await call('POST', `${M()}/import/preview`, T.dm, { type: 'git', url: repo });
  assert.equal(pre.status, 200, JSON.stringify(pre.body));
  assert.equal(pre.body.module.id, 'git-pack');
  assert.deepEqual(pre.body.counts, { spell: 1, rule: 1, condition: 1 });
  assert.equal(pre.body.module.attribution, 'From a repo.');
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'modules-tmp')) || fs.readdirSync(path.join(tmp, 'data', 'modules-tmp')).length === 0, 'the temporary clone is removed');
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'git', url: repo, ref: '--upload-pack=x' })).status, 400);
  assert.equal((await call('POST', `${M()}/import/preview`, T.dm, { type: 'git', url: path.join(tmp, 'missing') })).status, 400);
  assert.equal((await call('POST', `${M()}/import`, T.dm, { type: 'git', url: repo })).status, 200);
  await ok('DELETE', `${M()}/imported/git-pack`, T.dm);
});

test('Modules: MCP tools lookup_rule and lookup_term', async () => {
  const k = (await ok('POST', '/api/keys', T.jess, { scope: 'scribe', label: 'mcp', worldId: W })).key;
  const rpc = async (name: string, args: any) => (await call('POST', '/mcp', k, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).body;
  const tools = (await call('POST', '/mcp', k, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map((t: any) => t.name);
  assert.ok(tools.includes('lookup_rule') && tools.includes('lookup_term') && tools.includes('read_term'));
  const rule = await rpc('lookup_rule', { query: 'how does cover work' });
  assert.equal(rule.result.isError, false);
  assert.equal(JSON.parse(rule.result.content[0].text).results[0].term, 'Cover');
  const term = await rpc('lookup_term', { term: 'fireball', kind: 'spell' });
  const hits = JSON.parse(term.result.content[0].text).terms;
  assert.equal(hits[0].term, 'Fireball');
  const full = await rpc('read_term', { id: hits[0].id });
  assert.match(JSON.parse(full.result.content[0].text).text, /8d6/);
});
