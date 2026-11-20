import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spanText } from '../src/features/active/intents.ts';

test('ActiveIntents_ClockSummaryIsExact', () => {
  assert.equal(spanText(2160), '1 day 12 hours', 'not "2 day(s)"');
  assert.equal(spanText(90), '1 hour 30 min');
  assert.equal(spanText(180), '3 hours');
  assert.equal(spanText(1440), '1 day');
  assert.equal(spanText(5), '5 min');
  assert.equal(spanText(0), '0 min');
});

import { itemName } from '../src/features/active/intents.ts';
import { allCues } from '../src/features/active/cues.ts';

test('ActiveIntents_ItemNamesFromTableTalkMustBeThings', () => {
  for (const ok of ['silver key', 'Rusty Lantern', 'potion', 'dagger', 'crucible stone', 'day pass', '+1 longsword', 'gem', 'Captain Marrow\'s Letter']) assert.ok(itemName(ok), ok);
  for (const bad of ['Strength Score Of 20', 'Plus Four', 'Resistance', 'Going', 'Health', 'Thought Of The Three On The Funky Boat', 'advantage', 'a reroll', 'inspiration', '20']) assert.ok(!itemName(bad), bad);
});

test('ActiveIntents_AFightAlreadyUnderWayIsOfferedNeverStarted', () => {
  const ctx: any = { combat: { active: false, turn: 0, combatants: [] }, party: [], pages: [], sfx: [], initiativeOpen: false };
  const cue = (t: string) => allCues({ id: 'l', text: t, speaker: 'dm', role: 'dm', accountId: null, aside: false } as any, ctx).filter((c: any) => c.kind === 'combat_start');
  const c = cue('Thirty-three damage, Blake. That hits, it uses a legendary action.');
  assert.equal(c.length, 1);
  assert.equal((c[0] as any).ask, true, 'offered, not started');
  assert.equal(cue('The bakery charges 3 silver for the bread.').length, 0);
  assert.equal(cue('Roll for initiative!').some((x: any) => x.ask), false, 'a real start is not the "under way" ask');
  ctx.combat.active = true;
  assert.equal(cue('It takes 12 damage, that hits.').length, 0, 'not while a fight is tracked');
});
