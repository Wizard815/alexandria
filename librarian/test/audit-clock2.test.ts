// Audit: raw minutes in clock events must not be able to break every read of the world's events.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());
const C = () => k.w('/clock');

test('Audit_Clock: an event with absurd raw minutes is refused and never breaks the event list', async () => {
  for (const start of [1e300, 2 ** 60, -(2 ** 60), 9e15, -9e15]) {
    const r = await k.call('POST', `${C()}/events`, k.T.dm, { title: `far ${start}`, start, visibility: 'party' });
    assert.ok(r.status === 400 || r.status === 201, `start ${start} -> ${r.status} ${r.text.slice(0, 100)}`);
    for (const who of ['dm', 'jess', 'visitor']) {
      const list = await k.call('GET', `${C()}/events`, k.T[who]);
      assert.equal(list.status, 200, `${who} cannot list events after an event at ${start} (${r.status}): ${list.text.slice(0, 100)}`);
      const up = await k.call('GET', `${C()}/upcoming`, k.T[who]);
      assert.equal(up.status, 200, `${who} cannot read upcoming after an event at ${start}: ${up.text.slice(0, 100)}`);
      const one = await k.call('GET', C(), k.T[who]);
      assert.equal(one.status, 200);
    }
  }
});
