import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_SECTIONS, mergeThreads, sectionOf, setSection } from '../src/features/minerva/vault.ts';
import { statusBody } from '../src/features/minerva/seed.ts';

const THREADS = [
  '- [on] [[The darkened lamp]]: who paid the keeper to put the light out',
  "- [ongoing] [[Velmira's payroll]]: three captains owe her",
  '- [simmering] [[The drowned bell]]: it rings at low tide',
  'A loose GM note about the harbour.',
].join('\n');

test('TestMinerva_ThreadHeatChangeKeepsLinkAndDescription', () => {
  const out = mergeThreads(THREADS, [{ title: 'The darkened lamp', heat: 'ongoing' }, { title: 'The drowned bell', heat: 'on' }]);
  const lines = out.split('\n');
  assert.equal(lines[0], '- [ongoing] [[The darkened lamp]]: who paid the keeper to put the light out');
  assert.equal(lines[1], "- [ongoing] [[Velmira's payroll]]: three captains owe her");
  assert.equal(lines[2], '- [on] [[The drowned bell]]: it rings at low tide');
  assert.equal(lines[3], 'A loose GM note about the harbour.');
});

test('TestMinerva_ThreadMergeAddsNewAndDropsPlaceholder', () => {
  assert.equal(mergeThreads('_One line each._', [{ title: 'New hook', heat: 'on' }]), '- [on] [[New hook]]');
  assert.equal(mergeThreads(THREADS, []), THREADS);
  assert.equal(mergeThreads('- [[Bare link]]: why', [{ title: 'Bare link', heat: 'sleeping' }]), '- [sleeping] [[Bare link]]: why');
});

test('TestMinerva_EveryStatusSectionRoundTrips', () => {
  let body = statusBody();
  for (const s of STATUS_SECTIONS) body = setSection(body, s, s === 'Active threads' ? THREADS : `- text of ${s}: keeps its words`);
  const merged = setSection(body, 'Active threads', mergeThreads(sectionOf(body, 'Active threads')!.text, [{ title: 'The darkened lamp', heat: 'simmering' }]));
  for (const s of STATUS_SECTIONS) {
    const txt = sectionOf(merged, s)!.text;
    if (s === 'Active threads') assert.match(txt, /\[simmering\] \[\[The darkened lamp\]\]: who paid the keeper/);
    else assert.equal(txt, `- text of ${s}: keeps its words`);
  }
});
