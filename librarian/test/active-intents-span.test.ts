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
