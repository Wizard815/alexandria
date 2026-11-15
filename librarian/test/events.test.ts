// The live-event hub: server-side listeners (taps) hear per-viewer events too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/core/events.ts';

test('EventHub_TapsHearPerViewerEventsWithTheDmView', () => {
  const hub = new EventHub();
  const heard: unknown[] = [];
  const off = hub.tap((w, type, data) => heard.push([w, type, data]));
  hub.emitPer('w1', 'combat', (v) => (v.role === 'dm' ? { hp: 52, hidden: true } : { hp: 'Bloodied' }));
  hub.emit('w1', 'clock', { minutes: 5 }, () => true);
  assert.deepEqual(heard, [['w1', 'combat', { hp: 52, hidden: true }], ['w1', 'clock', { minutes: 5 }]]);
  // A view that throws or returns nothing reaches no listener, and never breaks the emit.
  hub.emitPer('w1', 'x', () => { throw new Error('boom'); });
  hub.emitPer('w1', 'y', () => null);
  assert.equal(heard.length, 2);
  off();
  hub.emitPer('w1', 'combat', () => ({}));
  assert.equal(heard.length, 2, 'unsubscribed');
});
