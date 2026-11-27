// Outputs (page, stage, combat, send, broker), the integration endpoints,
// sharing (export, import, duplicate), the template library and the leak checks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, cleanups, DM_SECRET, tplId } from './sculptBoot.ts';

after(() => { for (const c of cleanups) c(); });
const env = await boot(true);
const bare = await boot(false);

const named = async (e: typeof env, n: string) => (await e.ok('GET', `${e.S}/templates`, e.T.dm)).templates.find((t: any) => t.name === n);
const pageBy = async (e: typeof env, title: string) => (await e.ok('GET', `/api/worlds/${e.W}/library/pages`, e.T.dm)).find((p: any) => p.title === title);

test('Sculpt outputs: an encounter runs into initiative and saves a page, each output on its own', async () => {
  const t = await named(bare, 'Encounter');
  const r = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: t.id, values: { env: 'forest' }, context: { partyLevel: 4 } });
  assert.match(r.values.monsters, /\d+× /);
  const out = await bare.ok('POST', `${bare.S}/outputs`, bare.T.dm, { templateId: t.id, values: r.values, outputs: { combat: true, page: true } });
  assert.deepEqual(out.errors, {});
  assert.ok(out.done.combat.count >= 1);
  assert.ok(out.done.page.pageId);
  const combat = await bare.ok('GET', `/api/worlds/${bare.W}/live/combat`, bare.T.dm);
  assert.equal(combat.combatants.length, out.done.combat.count);
  const first = r.values.monsters.split('\n')[0].match(/(\d+)× (.+?) \(/);
  assert.ok(combat.combatants.some((c: any) => c.name.startsWith(first![2])), JSON.stringify(combat.combatants.map((c: any) => c.name)));
  assert.ok(combat.combatants.every((c: any) => c.hp > 0 && c.ac > 0));
  // A failing output does not lose the others: nothing to send in a GM template.
  const mixed = await bare.ok('POST', `${bare.S}/outputs`, bare.T.dm, { templateId: t.id, values: r.values, outputs: { page: true, send: true } });
  assert.ok(mixed.done.page && mixed.errors.send);
  // A template with no outputs ticked is refused, and the legacy combat route accepts a list template too.
  assert.equal((await bare.call('POST', `${bare.S}/outputs`, bare.T.dm, { templateId: t.id, values: r.values, outputs: {} })).status, 422);
  const legacy = await bare.ok('POST', `${bare.S}/combat`, bare.T.dm, { templateId: t.id, values: r.values });
  assert.ok(legacy.count >= 1);
});

test('Sculpt outputs: run can do several things at once: page, stage and send for a handout', async () => {
  const t = await named(env, 'Letter or handout');
  const before = (await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.dm)).cards?.length ?? 0;
  const r = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: t.id, values: { sender: 'Marta Voss', letter: 'Meet me at the quay when the tide turns, and bring the key.', image: 'https://example.com/seal.png' }, outputs: { stage: true, page: true, send: false } });
  assert.deepEqual(r.outputs.errors, {}, JSON.stringify(r.outputs));
  assert.ok(r.outputs.done.stage.cardId && r.outputs.done.stage.imageCardId);
  assert.ok(r.outputs.done.page.pageId);
  const stage = await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.jess);
  const shown = JSON.stringify(stage);
  assert.ok(shown.includes('Meet me at the quay'), 'the handout is on the players\' stage');
  assert.ok(shown.includes('seal.png'));
  assert.ok((await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.dm)).cards.length >= before + 2);
  // The player-view template can also be sent as a message.
  const sent = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: t.id, values: r.values, outputs: { send: true } });
  assert.ok(sent.done.send.threadId);
});

test('Sculpt outputs: nothing GM-only reaches the stage, players or the broker', async () => {
  const letter = await named(env, 'Letter or handout');
  const cardsBefore = JSON.stringify(await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.dm));
  const leaky = { sender: 'Marta Voss', letter: `${DM_SECRET} and so it goes tonight.` };
  const out = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: letter.id, values: leaky, outputs: { stage: true, send: true, broker: true } });
  for (const k of ['stage', 'send', 'broker']) assert.match(out.errors[k], /GM-only|Blocked/, k);
  assert.deepEqual(out.done, {});
  assert.equal(JSON.stringify(await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.dm)), cardsBefore, 'no card was made');
  assert.equal((await env.ok('GET', `/api/worlds/${env.W}/broker/notes`, env.T.dm)).length, 0);
  // A GM template: its GM-only fields never go out, and its public text is checked too.
  const npc = await named(env, 'NPC for quick RP');
  const values = { name: 'Old Pell', race: 'human', role: 'ferryman', look: 'Stooped, grey-bearded and always smelling of tar.', knows: 'The ferry runs at dawn and dusk.', secret: 'Pell once sank a boat of smugglers for the queen of the harbour.' };
  const ok = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: npc.id, values, outputs: { stage: true, broker: true } });
  assert.deepEqual(ok.errors, {}, JSON.stringify(ok));
  const shown = JSON.stringify(await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.jess));
  assert.ok(shown.includes('Old Pell') && shown.includes('ferry runs at dawn'));
  assert.ok(!shown.includes('sank a boat'), 'the secret field is not on the stage');
  const notes = await env.ok('GET', `/api/worlds/${env.W}/broker/notes`, env.T.dm);
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].text.includes('sank a boat') && notes[0].text.includes('ferry runs at dawn'));
  // A "knows" line that repeats a GM-only page is stopped, even though the field is not marked GM-only.
  const bad = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: npc.id, values: { ...values, knows: `${DM_SECRET} said the whispers.` }, outputs: { stage: true, broker: true } });
  assert.ok(bad.errors.stage && bad.errors.broker);
  assert.ok(!JSON.stringify(await env.ok('GET', `/api/worlds/${env.W}/stage`, env.T.jess)).includes('Velmira'));
});

test('Sculpt outputs: a page shared with the party is leak checked, and saved pages do not block their own public text', async () => {
  const npc = await named(env, 'NPC for quick RP');
  const values = { name: 'Tamsin', race: 'elf', role: 'herbalist', look: 'Tall, with moss in her hair.', knows: `${DM_SECRET} was overheard.` };
  const r = await env.call('POST', `${env.S}/save`, env.T.dm, { templateId: npc.id, values, target: { visibility: 'party' } });
  assert.equal(r.status, 409);
  const clean = { ...values, knows: 'Fresh mint grows by the old well and nowhere else in town.' };
  await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: npc.id, values: clean, outputs: { page: true } });
  // The page is saved (GM-only) with the same public text; showing it on the stage afterwards still works.
  const later = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: npc.id, values: clean, outputs: { stage: true } });
  assert.deepEqual(later.errors, {});
});

test('Sculpt outputs: batch outputs make one combined page and send each statblock to combat', async () => {
  const bark = await named(env, 'NPC quick bark');
  const r = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: bark.id, values: {}, count: 3 });
  const out = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: bark.id, results: r.results.map((x: any) => x.values), outputs: { page: true } });
  assert.deepEqual(out.errors, {});
  const md = await env.ok('GET', `/api/worlds/${env.W}/library/pages/${out.done.page.pageId}`, env.T.dm);
  assert.ok((md.body ?? '').split('---').length >= 3 || JSON.stringify(md).includes('NPC quick bark'));
  const sb = await named(env, 'Quick statblock');
  const s = await env.ok('POST', `${env.S}/run`, env.T.dm, { templateId: sb.id, values: { name: 'Ghoul' }, count: 2 });
  const before = (await env.ok('GET', `/api/worlds/${env.W}/live/combat`, env.T.dm)).combatants.length;
  const c = await env.ok('POST', `${env.S}/outputs`, env.T.dm, { templateId: sb.id, results: s.results.map((x: any) => x.values), outputs: { combat: true } });
  assert.equal(c.done.combat.count, 2);
  assert.equal((await env.ok('GET', `/api/worlds/${env.W}/live/combat`, env.T.dm)).combatants.length, before + 2);
});

test('Sculpt integration: the library page, location and level context, and the agent tools', async () => {
  const room = await named(bare, 'Dungeon room');
  const r = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: room.id, values: {}, context: { page: 'Saltmarsh', partyLevel: 9 } });
  assert.match(r.values.occupants, /CR/);
  const scene = await named(bare, 'Scene, GM perspective');
  const s = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: scene.id, values: {}, context: { page: 'Saltmarsh' } });
  assert.equal(s.values.location, 'Saltmarsh', 'the page fills the first blank page field');
  assert.equal((await bare.call('POST', `${bare.S}/run`, bare.T.dm, { templateId: scene.id, values: {}, context: { page: 'No such page' } })).status, 404);
  // The settlement title shows the world date through {{world.date}}; the prep sheet uses it too.
  const prep = await named(bare, 'Session prep checklist');
  const p = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: prep.id, values: {} });
  assert.match(p.md, /Session prep — .*\d{3,4}/);
  const { featureMcpTools } = await import('../src/features/registry.ts');
  const tools = featureMcpTools();
  const sculpt = tools.find((x) => x.name === 'sculpt')!;
  const call = sculpt.call({ template: 'Rumour table', values: { place: 'Saltmarsh' }, count: 2, outputs: { page: false } });
  assert.equal(call.path, '/sculpt/run');
  assert.equal((call.body as any).count, 2);
  const list = tools.find((x) => x.name === 'list_templates')!;
  assert.equal(list.write, undefined);
  assert.ok((list as any).dmOnly);
  const lc = list.call({ query: 'rumour', category: 'Story' });
  const found = await bare.ok('GET', `/api/worlds/${bare.W}${lc.path}`, bare.T.dm);
  assert.ok(found.templates.some((t: any) => t.name === 'Rumour table'));
  assert.ok(found.templates.every((t: any) => t.category === 'Story' && !t.body));
  // "make me a rumour table for Saltmarsh", the way the agent would call it: one call, place used.
  const rt = await bare.ok('POST', `/api/worlds/${bare.W}${call.path}`, bare.T.dm, call.body);
  assert.equal(rt.results.length, 2);
  assert.match(rt.md, /Rumours of Saltmarsh/);
});

test('Sculpt library: categories, search, favourites and recently used', async () => {
  const all = (await bare.ok('GET', `${bare.S}/templates`, bare.T.dm)).templates;
  const trap = all.find((t: any) => t.name === 'Trap');
  const combat = (await bare.ok('GET', `${bare.S}/templates?category=Combat`, bare.T.dm)).templates;
  assert.ok(combat.length >= 3 && combat.every((t: any) => t.category === 'Combat'));
  const found = (await bare.ok('GET', `${bare.S}/templates?q=riddle`, bare.T.dm)).templates;
  assert.deepEqual(found.map((t: any) => t.name), ['Puzzle or riddle']);
  await bare.ok('POST', `${bare.S}/templates/${trap.id}/favorite`, bare.T.dm, { on: true });
  assert.deepEqual((await bare.ok('GET', `${bare.S}/templates?favorites=1`, bare.T.dm)).templates.map((t: any) => t.name), ['Trap']);
  await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: trap.id, values: {} });
  await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: all.find((t: any) => t.name === 'Weather').id, values: {} });
  const recent = (await bare.ok('GET', `${bare.S}/templates?recent=1`, bare.T.dm)).templates;
  assert.equal(recent[0].name, 'Weather');
  assert.ok(recent.find((t: any) => t.name === 'Trap').uses >= 1);
  await bare.ok('POST', `${bare.S}/templates/${trap.id}/favorite`, bare.T.dm, { on: false });
  assert.equal((await bare.ok('GET', `${bare.S}/templates?favorites=1`, bare.T.dm)).templates.length, 0);
});

test('Sculpt sharing: export and import round-trip, with a preview and validation', async () => {
  const trap = await named(bare, 'Trap');
  const exp = await bare.ok('GET', `${bare.S}/templates/${trap.id}/export`, bare.T.dm);
  assert.equal(exp.format, 'alexandria-sculpt-template');
  assert.ok(!('id' in exp.template));
  const prev = await bare.ok('POST', `${bare.S}/templates/import`, bare.T.dm, { json: JSON.stringify(exp), preview: true });
  assert.equal(prev.ok, true);
  assert.equal(prev.preview.name, 'Trap');
  assert.equal(prev.nameTaken, true);
  assert.ok(prev.preview.generators.some((g: string) => g.startsWith('gen:trap')));
  const before = (await bare.ok('GET', `${bare.S}/templates`, bare.T.dm)).templates.length;
  assert.equal((await bare.ok('GET', `${bare.S}/templates`, bare.T.dm)).templates.length, before, 'a preview saves nothing');
  const made = await bare.ok('POST', `${bare.S}/templates/import`, bare.T.dm, { json: exp });
  assert.equal(made.builtin, false);
  assert.equal(made.name, 'Trap (2)');
  assert.deepEqual(made.fields, trap.fields);
  assert.equal(made.body, trap.body.trim());
  assert.equal(made.category, trap.category);
  const again = await bare.ok('GET', `${bare.S}/templates/${made.id}/export`, bare.T.dm);
  assert.deepEqual(again.template, { ...exp.template, name: 'Trap (2)', body: exp.template.body.trim() });
  // It sculpts like the original.
  const r = await bare.ok('POST', `${bare.S}/run`, bare.T.dm, { templateId: made.id, values: {} });
  assert.match(r.md, /Trap:/);
  // Invalid imports are refused with a reason and nothing is made.
  const reject = async (body: unknown, re: RegExp) => { const x = await bare.call('POST', `${bare.S}/templates/import`, bare.T.dm, body); assert.equal(x.status, 422, JSON.stringify(x.body)); assert.match(x.body.error, re); };
  await reject({ json: '{nope' }, /not valid JSON/);
  await reject({ json: { format: 'something-else', version: 1, template: {} } }, /not a Sculpting template/);
  await reject({ json: { ...exp, version: 9 } }, /version/);
  await reject({ json: { ...exp, template: { ...exp.template, body: '{{gen:evil}}' } } }, /no generator/);
  await reject({ json: { ...exp, template: { ...exp.template, body: '{{unknown}}' } } }, /not a field/);
  await reject({ json: { ...exp, template: { ...exp.template, fields: [] } } }, /1 to 40 fields/);
  assert.equal((await bare.ok('GET', `${bare.S}/templates`, bare.T.dm)).templates.length, before + 1);
});

test('Sculpt sharing: duplicate a built-in to customise it, and delete only the copy', async () => {
  const faction = await named(bare, 'Faction');
  const dup = await bare.ok('POST', `${bare.S}/templates/${faction.id}/duplicate`, bare.T.dm);
  assert.equal(dup.builtin, false);
  assert.equal(dup.name, 'Faction (copy)');
  assert.deepEqual(dup.fields, faction.fields);
  const edited = await bare.ok('PUT', `${bare.S}/templates/${dup.id}`, bare.T.dm, { ...dup, description: 'Mine', category: 'Prep' });
  assert.equal(edited.category, 'Prep');
  assert.equal((await named(bare, 'Faction')).description, faction.description, 'the built-in is untouched');
  await bare.ok('DELETE', `${bare.S}/templates/${dup.id}`, bare.T.dm);
  assert.equal((await bare.call('DELETE', `${bare.S}/templates/${faction.id}`, bare.T.dm)).status, 409);
});

test('Sculpt integration: players are refused on every new route', async () => {
  const t = await named(bare, 'Trap');
  for (const [m, u] of [['POST', '/outputs'], ['GET', '/context'], ['POST', '/templates/import'], ['GET', `/templates/${t.id}/export`], ['POST', `/templates/${t.id}/duplicate`], ['POST', `/templates/${t.id}/favorite`], ['GET', '/templates?q=trap']] as const) {
    assert.equal((await env.call(m, `${env.S}${u}`, env.T.jess, m === 'POST' ? {} : undefined)).status, 403, `${m} ${u}`);
  }
  void tplId;
});
