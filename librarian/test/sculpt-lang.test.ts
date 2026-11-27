// The template language: inline generators, world context, conditionals and
// lists, the new field types, batch, every built-in, and validation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, cleanups, tplId } from './sculptBoot.ts';

after(() => { for (const c of cleanups) c(); });
const env = await boot(true);
const bare = await boot(false);

const make = (e: typeof env, over: Record<string, unknown>) => e.ok('POST', `${e.S}/templates`, e.T.dm, {
  name: `T ${Math.random().toString(36).slice(2, 8)}`, description: '', perspective: 'dm', fields: [{ key: 'name', label: 'Name', type: 'text' }], body: '# {{name}}', target: { kind: 'none' }, ...over,
});
const run = (e: typeof env, t: any, values: Record<string, unknown> = {}, more: Record<string, unknown> = {}) => e.ok('POST', `${e.S}/run`, e.T.dm, { templateId: t.id, values, ...more });

test('Sculpt language: inline generators, dice and pick render without a model and repeat for the same values', async () => {
  const t = await make(bare, {
    body: '# {{name}}\n{{gen:name race=elf gender=female}}\n{{gen:item rarity=rare type=weapon}}\n{{gen:coins mode=hoard level=5}}\n{{dice:2d6+3}}\n{{pick:red|green|blue}}\n',
  });
  const r = await run(bare, t, { name: 'Gens' });
  assert.equal(bare.model.calls.length, 0);
  const lines = r.md.split('\n').filter(Boolean);
  assert.ok(lines.length >= 6, r.md);
  assert.match(r.md, /\d+ \(2d6\+3\)/);
  assert.match(r.md, /\b(red|green|blue)\b/);
  assert.match(r.md, /\(rare weapon,/);
  assert.match(r.md, /\d+ gp/);
  // The same values (with their seed) always render the same text; Sculpt again rolls fresh ones.
  assert.ok(r.values.__seed);
  const again = await bare.ok('POST', `${bare.S}/check`, bare.T.dm, { templateId: t.id, values: r.values });
  assert.equal(again.md, r.md);
  const other = await run(bare, t, { name: 'Gens' });
  assert.notEqual(other.values.__seed, r.values.__seed);
});

test('Sculpt language: world context variables come from the clock, the party and the request', async () => {
  const t = await make(bare, { body: '# {{name}}\nDate: {{world.date}}\nSeason: {{world.season}}\nParty: {{party.names}}\nLevel: {{party.level}}\nWhere: {{location}}\nPage: {{page:Saltmarsh}}\n' });
  const r = await run(bare, t, { name: 'Ctx' }, { context: { location: 'The Quay', partyLevel: 7 } });
  assert.match(r.md, /Date: .*\d{3,4}/);
  assert.match(r.md, /Party: Jess/);
  assert.match(r.md, /Level: 7/);
  assert.match(r.md, /Where: The Quay/);
  // A GM template reads the AI copy of a page, and keeps that line GM-only.
  const pageLine = r.parts.find((p: any) => /gulls/.test(p.md));
  assert.ok(pageLine?.dm, 'the page excerpt is in a GM-only part');
  // The current location falls back to nothing, and a page used as context sets it.
  const ctx = await bare.ok('GET', `${bare.S}/context?location=Dock`, bare.T.dm);
  assert.equal(ctx.vars.location, 'Dock');
  assert.ok(ctx.names.includes('world.date'));
});

test('Sculpt language: a player template gets the player excerpt of a page and never GM text', async () => {
  const t = await make(env, { perspective: 'player', body: '*{{name}}*\n\n{{page:Saltmarsh}}\n' });
  const r = await run(env, t, { name: 'Hello' });
  assert.match(r.md, /gulls/);
  assert.ok(!r.md.includes('Velmira'));
  assert.ok(!JSON.stringify(env.model.calls).includes('Velmira'));
});

test('Sculpt language: conditionals and lists', async () => {
  const t = await make(bare, {
    fields: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'pets', label: 'Pets', type: 'list' }, { key: 'note', label: 'Note', type: 'text' }],
    body: '# {{name}}\n{{#if note}}Note: {{note}}{{else}}No note{{/if}}\n{{#if !pets}}No pets{{/if}}{{#each pets}}\n{{@n}}. {{this}}{{/each}}\n',
  });
  const a = await run(bare, t, { name: 'A', pets: '- cat\n- owl', note: 'hello' }, { lock: ['pets', 'note'] });
  assert.match(a.md, /Note: hello/);
  assert.match(a.md, /1\. cat/);
  assert.match(a.md, /2\. owl/);
  assert.ok(!/No note|No pets/.test(a.md));
  const b = await run(bare, t, { name: 'B' }, { lock: ['pets', 'note'] });
  assert.match(b.md, /No note/);
  assert.match(b.md, /No pets/);
  // #dm still works around inline blocks.
  const dm = await make(bare, { fields: [{ key: 'name', label: 'Name', type: 'text' }], body: '# {{name}}\n{{#if name}}\n{{#dm}}\nsecret {{dice:1d1}}\n{{/dm}}\n{{/if}}\n' });
  const d = await run(bare, dm, { name: 'Z' });
  assert.ok(d.md.includes('> [!secret] GM') && d.md.includes('secret 1'));
});

test('Sculpt language: dice, table, image, pageLink and rollTable fields', async () => {
  const t = await make(bare, {
    fields: [
      { key: 'name', label: 'Name', type: 'text' }, { key: 'dmg', label: 'Damage', type: 'dice' },
      { key: 'prices', label: 'Prices', type: 'table', columns: ['Item', 'Cost'] }, { key: 'pic', label: 'Picture', type: 'image' },
      { key: 'where', label: 'Where', type: 'pageLink' }, { key: 'die', label: 'Die', type: 'select', options: ['d6', 'd20'], default: 'd20' },
      { key: 'rows', label: 'Rows', type: 'rollTable', dieField: 'die', fallback: 'pick:one|two|three|four|five|six|seven|eight|nine|ten|a|b|c|d|e|f|g|h|i|j|k|l|m' },
    ],
    body: '# {{name}}\nDamage {{dmg}}\n\n{{prices}}\n\n{{pic}}\n\n{{where}}\n\n{{rows}}\n',
  });
  const r = await run(bare, t, { name: 'Types', dmg: '3d4+1', prices: 'Sword | 10 gp\nBow | 25 gp', pic: 'https://example.com/a.png', where: 'Saltmarsh' });
  assert.match(r.values.dmg, /^\d+ \(3d4\+1\)$/);
  assert.match(r.md, /\| Item \| Cost \|/);
  assert.match(r.md, /\| Sword \| 10 gp \|/);
  assert.match(r.md, /!\[Picture\]\(https:\/\/example\.com\/a\.png\)/);
  assert.match(r.md, /\[\[Saltmarsh\]\]/);
  assert.match(r.md, /\| d20 \| Result \|/);
  assert.equal(r.values.rows.split('\n').length, 20, 'a d20 table has twenty rows');
  assert.ok(r.values.rows.startsWith('1 | '));
  // A picture that is not an https link or stage upload never renders as an image.
  const bad = await run(bare, t, { name: 'x', pic: 'javascript:alert(1)' });
  assert.ok(!bad.md.includes('!['));
  // With a model the roll table rows come from it, one call.
  env.model.calls.length = 0;
  const e2 = await make(env, { fields: [{ key: 'die', label: 'Die', type: 'select', options: ['d6', 'd20'], default: 'd6' }, { key: 'rows', label: 'Rows', type: 'rollTable', dieField: 'die' }], body: '{{rows}}' });
  const m = await run(env, e2, {});
  assert.equal(env.model.calls.length, 1);
  assert.equal(m.values.rows.split('\n').length, 6);
  assert.match(m.values.rows, /^1 \| filled row 1/);
});

test('Sculpt language: bad templates are refused with a reason', async () => {
  const bad = async (over: Record<string, unknown>) => (await bare.call('POST', `${bare.S}/templates`, bare.T.dm, { name: 'Bad', description: '', perspective: 'dm', fields: [{ key: 'name', label: 'Name', type: 'text' }], body: '# {{name}}', target: { kind: 'none' }, ...over })).status;
  assert.equal(await bad({ body: '{{#if name}}never closed' }), 422);
  assert.equal(await bad({ body: '{{gen:nonsense}}' }), 422);
  assert.equal(await bad({ body: '{{dice:2d6}} {{wat.is.this}}' }), 422);
  assert.equal(await bad({ body: '{{#each nope}}x{{/each}}' }), 422);
  assert.equal(await bad({ fields: [{ key: 'name', label: 'Name', type: 'text', gen: 'gen:coins level=$missing' }] }), 422);
  assert.equal(await bad({ fields: [{ key: 'name', label: 'Name', type: 'weird' }] }), 422);
  assert.equal(await bad({ perspective: 'player', body: '{{#dm}}x{{/dm}} {{name}}' }), 422);
  assert.equal(await bad({ outputs: { send: true } }), 422, 'only player templates can be sent');
  assert.equal(await bad({ body: '# ok {{name}} {{world.date}} {{pick:a|b}}' }), 201);
});

test('Sculpt batch: make N is one model call that returns an array', async () => {
  const t = await make(env, {
    fields: [{ key: 'name', label: 'Name', type: 'name' }, { key: 'rumour', label: 'Rumour', type: 'text' }],
    body: '## {{name}}\n{{rumour}}\n',
  });
  env.model.calls.length = 0;
  const r = await run(env, t, {}, { count: 6 });
  assert.equal(env.model.calls.length, 1, 'six results, one call');
  assert.equal(r.count, 6);
  assert.equal(r.results.length, 6);
  assert.equal(new Set(r.results.map((x: any) => x.values.rumour)).size, 6, 'each result got its own text');
  assert.equal(new Set(r.results.map((x: any) => x.values.name)).size, 6, 'names come from the generator, not the model');
  const user = JSON.parse(env.model.calls[0].messages[1].content);
  assert.equal(user.count, 6);
  assert.deepEqual(user.blank.map((f: any) => f.key), ['rumour']);
  assert.ok(r.md.split('---').length >= 6);
  // 99 is capped, and no-model batches still produce distinct generator results.
  const nm = await make(bare, { fields: [{ key: 'tavern', label: 'Tavern', type: 'text', gen: 'gen:place kind=tavern' }], body: '- {{tavern}}' });
  const many = await run(bare, nm, {}, { count: 99 });
  assert.equal(many.results.length, 20);
  assert.equal(bare.model.calls.length, 0);
  assert.ok(new Set(many.results.map((x: any) => x.values.tavern)).size > 10);
  // A failing model leaves the batch to the generators.
  env.model.reply = () => 'not json at all';
  const fb = await make(env, { fields: [{ key: 'bark', label: 'Bark', type: 'text', fallback: 'pick:hello|hi|hey|yo' }], body: '{{bark}}' });
  const f = await run(env, fb, {}, { count: 3 });
  assert.equal(f.results.length, 3);
  assert.ok(f.results.every((x: any) => /hello|hi|hey|yo/.test(x.values.bark)));
});

const NEW_BUILTINS = ['Encounter', 'Loot hoard', 'Rumour table', 'Random travel event', 'Weather', 'Trap', 'Puzzle or riddle', 'Settlement or village', 'Dungeon room', 'Faction', 'Magic item', 'Letter or handout', 'Villain monologue', 'Session prep checklist', 'NPC quick bark'];

test('Sculpt built-ins: every new built-in is seeded, categorised and sculpts with no model, fast', async () => {
  const { templates, categories } = await bare.ok('GET', `${bare.S}/templates`, bare.T.dm);
  assert.deepEqual(categories, ['Combat', 'NPCs', 'Places', 'Loot', 'Story', 'Prep']);
  for (const n of NEW_BUILTINS) assert.ok(templates.some((t: any) => t.name === n && t.builtin && categories.includes(t.category)), n);
  for (const c of categories) assert.ok(templates.some((t: any) => t.category === c), `a template in ${c}`);
  for (const n of NEW_BUILTINS) {
    const t = templates.find((x: any) => x.name === n);
    const t0 = performance.now();
    const r = await run(bare, t, {});
    const ms = performance.now() - t0;
    assert.equal(bare.model.calls.length, 0);
    assert.ok(r.md.trim().length > 40, `${n}: ${r.md}`);
    assert.ok(!/(^|[\s*·])…($|[\s*·])/m.test(r.md), `${n} has empty gaps: ${r.md}`);
    assert.ok(ms < 250, `${n} took ${Math.round(ms)} ms`);
    assert.ok(!r.notes.some((x: string) => /No chat model/.test(x)), `${n}: ${r.notes}`);
  }
  // Specifics.
  const enc = await run(bare, templates.find((x: any) => x.name === 'Encounter'), { env: 'dungeon', difficulty: 'hard' }, { context: { partyLevel: 5 } });
  assert.match(enc.values.monsters, /\d+× .+ \(CR [\d/]+, AC \d+, HP \d+\)/);
  assert.match(enc.values.budget, /hard for \d+ level 5/);
  const tbl = await run(bare, templates.find((x: any) => x.name === 'Rumour table'), { die: 'd20' });
  assert.equal(tbl.values.rumours.split('\n').length, 20);
  const item = await run(bare, templates.find((x: any) => x.name === 'Magic item'), { want_rarity: 'rare' });
  assert.equal(item.values.rarity, 'rare');
  assert.match(item.values.price, /gp/);
});

test('Sculpt built-ins: every built-in sculpts with a fake model in at most one call', async () => {
  const { templates } = await env.ok('GET', `${env.S}/templates`, env.T.dm);
  env.model.reply = (blank, user) => (user.count > 1 ? { results: [] } : Object.fromEntries(blank.map((f: any) => [f.key, f.type === 'statblock' ? { name: 'X', ac: 12, hp: 9, speed: { walk: '30 ft.' }, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, actions: [{ name: 'Hit', text: 'Hit: 3.' }] } : f.type === 'select' ? f.options[0] : f.type === 'list' ? ['a', 'b'] : f.type === 'rollTable' ? Array.from({ length: f.rows }, (_x, i) => `row ${i}`) : f.type === 'number' ? 4 : f.type === 'table' ? [['a']] : `filled ${f.key}`])));
  for (const t of templates.filter((x: any) => x.builtin)) {
    env.model.calls.length = 0;
    const r = await run(env, t, {});
    assert.ok(env.model.calls.length <= 1, `${t.name} made ${env.model.calls.length} calls`);
    assert.ok(r.md.trim().length > 0, t.name);
  }
});

test('Sculpt built-ins: a player template stays clean, and the model never gets classified text', async () => {
  await env.ok('PUT', `/api/worlds/${env.W}/library/pages`, env.T.dm, { path: 'lore/Vault', visibility: 'classified', markdown: '# Vault\nclassifiedmarker9911 beneath the quay lies a vault of silver bells and drowned crowns.\n' });
  const scene = await tplId(env, 'Scene, player perspective');
  env.model.calls.length = 0;
  env.model.reply = (blank) => Object.fromEntries(blank.map((f: any) => [f.key, `Lanterns glow along the quay ${f.key}`]));
  await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: scene, values: { location: 'Saltmarsh' } });
  const npc = await tplId(env, 'NPC for quick RP');
  await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: npc, values: { role: 'a keeper of the vault, silver bells, drowned crowns' }, context: { page: 'Vault' } });
  const sent = JSON.stringify(env.model.calls);
  assert.ok(!sent.includes('classifiedmarker9911'), 'no classified text in a model request');
  // A player-view sculpt model request has no GM-only text at all.
  const playerCall = JSON.stringify(env.model.calls[0]);
  assert.ok(!playerCall.includes('Velmira'));
});
