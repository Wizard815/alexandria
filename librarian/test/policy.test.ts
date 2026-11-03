import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSee, redactMarkdown, playerFrontmatter, healthForPlayers, mergeSettings, DEFAULT_SETTINGS } from '../src/core/policy.ts';
import { splitFrontmatter } from '../src/core/frontmatter.ts';
import { relationsFromFrontmatter } from '../src/core/library.ts';

test('TestPolicy_VisibilityRules', () => {
  const dm = { accountId: 'd', role: 'dm' as const };
  const p = { accountId: 'p', role: 'player' as const };
  assert.equal(canSee(p, 'party'), true);
  assert.equal(canSee(p, 'dm'), false);
  assert.equal(canSee(p, 'dm', 'p'), true, 'owner sees their own DM-shared item');
  assert.equal(canSee(dm, 'me', 'p'), false, '"only me" hides it from the DM too');
  assert.equal(canSee(p, 'weird-value'), false, 'unknown visibility fails closed');
  assert.equal(canSee(p, undefined as any), false);
});

test('TestPolicy_UnclosedDmMarkerHidesTheRest', () => {
  const out = redactMarkdown('Open text.\n<!-- dm -->\nSecret plan forever');
  assert.ok(out.includes('Open text') && !out.includes('Secret plan'));
});

test('TestPolicy_HeadingsInsideCodeAreNotSections', () => {
  const out = redactMarkdown('Intro\n```\n# Secrets\n```\nAfter the code.\n\n## Notes (DM)\nhidden\n# Next\nshown');
  assert.ok(out.includes('After the code') && out.includes('shown') && !out.includes('hidden'));
});

test('TestPolicy_SecretCalloutsAllVariants', () => {
  const out = redactMarkdown('a\n> [!SECRET]\n> x1\n>x2\nb\n> [!gm] title\n> y\nc\n> [!info]\n> keep');
  assert.ok(out.includes('a') && out.includes('b') && out.includes('c') && out.includes('keep'));
  assert.ok(!/x1|x2|\by\b/.test(out));
});

test('TestPolicy_FrontmatterDmKeysStripped', () => {
  const { fm } = splitFrontmatter('---\ntitle: X\ndm_notes: hush\ngm: a\nsecret:\n  a: b\nfacts:\n  age: 40\n  secret: bastard\n---\nbody');
  assert.deepEqual(playerFrontmatter(fm), { title: 'X', facts: { age: 40 } });
});

test('TestFrontmatter_ListsAndWikilinks', () => {
  const { fm, body } = splitFrontmatter('---\ntags: [noble, "house varn"]\nparents:\n  - "[[Old Lord Varn]]"\n  - Lady Ysolde\nrelations:\n  - kind: rival of\n    to: "[[House Orl]]"\n  - "sworn to: [[The Crown]]"\n---\nHi');
  assert.equal(body, 'Hi');
  assert.deepEqual(fm.tags, ['noble', 'house varn']);
  const rel = relationsFromFrontmatter('Aldric', fm).map((r) => `${r.kind}>${r.to}`);
  assert.deepEqual(rel, ['child of>Old Lord Varn', 'child of>Lady Ysolde', 'rival of>House Orl', 'sworn to>The Crown']);
});

test('TestPolicy_HealthWordsAndSettings', () => {
  assert.equal(healthForPlayers(5, 11, 'words'), 'Bloodied');
  assert.equal(healthForPlayers(0, 11, 'words'), 'Down');
  assert.equal(healthForPlayers(11, 11, 'bar'), '100');
  assert.equal(healthForPlayers(5, 11, 'none'), null);
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { coins: 'diamonds' }));
  assert.throws(() => mergeSettings(DEFAULT_SETTINGS, { trackWeight: 'yes' }));
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { messageDays: null }).messageDays, null);
});
