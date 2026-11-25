// Tool arguments from local models: repaired when it is safe, refused with the reason when not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArgs, nearestToolNames, parseToolArgs } from '../src/features/agent/toolargs.ts';

test('ToolArgs: parse repairs fences, trailing commas, text around the object and double encoding', () => {
  assert.deepEqual(parseToolArgs(''), { ok: true, args: {} });
  assert.deepEqual(parseToolArgs(undefined), { ok: true, args: {} });
  assert.deepEqual(parseToolArgs('{"a":1}'), { ok: true, args: { a: 1 } });
  assert.deepEqual(parseToolArgs('```json\n{"a": 1,}\n```'), { ok: true, args: { a: 1 } });
  assert.deepEqual(parseToolArgs('Here: {"a": [1, 2,], "b": "x"} done'), { ok: true, args: { a: [1, 2], b: 'x' } });
  assert.deepEqual(parseToolArgs(JSON.stringify(JSON.stringify({ a: 1 }))), { ok: true, args: { a: 1 } });
  assert.deepEqual(parseToolArgs({ a: 2 }), { ok: true, args: { a: 2 } });
  const bad = parseToolArgs('name=Bandit');
  assert.equal(bad.ok, false);
  assert.equal(parseToolArgs('[1,2]').ok, false, 'a list is not an arguments object');
});

test('ToolArgs: check fixes numbers, booleans, enum case, JSON-text lists and optional nulls; names the rest', () => {
  const tool = { props: { n: { type: 'integer' }, x: { type: 'number' }, b: { type: 'boolean' }, mood: { type: 'string', enum: ['calm', 'tense'] }, list: { type: 'array', items: { type: 'integer' } }, when: { type: 'object' }, s: { type: 'string' } }, required: ['n'] };
  assert.deepEqual(checkArgs(tool, { n: '3', x: '1.5', b: 'True', mood: 'Tense', list: '[1, "2"]', s: 7, when: 90 }), { args: { n: 3, x: 1.5, b: true, mood: 'tense', list: [1, 2], s: '7', when: 90 }, problems: [] });
  assert.deepEqual(checkArgs(tool, { n: 1, mood: null }).args, { n: 1 }, 'null for an optional field is dropped');
  assert.deepEqual(checkArgs(tool, {}).problems, ['n is required']);
  assert.deepEqual(checkArgs(tool, { n: 2.5 }).problems, ['n must be a whole number, got 2.5']);
  assert.match(checkArgs(tool, { n: 1, mood: 'angry' }).problems[0], /mood must be one of "calm", "tense"/);
  assert.match(checkArgs(tool, { n: 1, b: 'maybe' }).problems[0], /b must be true or false/);
  assert.deepEqual(checkArgs(tool, { n: 1, extra: 'kept' }).args, { n: 1, extra: 'kept' }, 'fields the schema does not name are left alone');
});

test('ToolArgs: the nearest real tool names to one the model made up', () => {
  const names = ['search_library', 'read_page', 'play_music', 'stop_music', 'add_combatant', 'damage_combatant'];
  assert.equal(nearestToolNames('search', names)[0], 'search_library');
  assert.equal(nearestToolNames('add-combatant', names)[0], 'add_combatant');
  assert.equal(nearestToolNames('playMusic', names).includes('play_music'), false, 'camelCase is one word, so no false match is promised');
  assert.deepEqual(nearestToolNames('zzz', names), []);
});
