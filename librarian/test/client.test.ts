// The scribe apps' client, run against a real librarian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { AlexandriaClient } from '../../packages/client/src/AlexandriaClient.ts';

test('TestClient_PlayerFlowEndToEnd', async () => {
  const { app } = createApp({ env: {}, noScheduler: true });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const admin = new AlexandriaClient({ baseUrl: base });
    assert.equal((await admin.needsSetup()).needsSetup, true);
    const a = await admin.setup('wizard', 'correct horse battery');
    const w = await admin.request('POST', '/api/admin/worlds', { name: 'BloodEarth', dmAccountId: a.account.id });
    const dm = admin.world(w.slug);
    const { code } = await dm.invite('player');

    const player = new AlexandriaClient({ baseUrl: base });
    await player.join(code, 'jess', 'player pass 123', 'Mira');
    const pw = player.world(w.slug);

    const events: string[] = [];
    const stop = pw.subscribe((e) => events.push(e.type));
    await new Promise((r) => setTimeout(r, 50));

    await dm.savePage({ path: 'Old Kesh', visibility: 'party', markdown: 'A port.\n\n> [!secret]\n> Spies.' });
    await dm.savePage({ path: 'Plot', body: 'The twist.' });
    assert.deepEqual((await pw.pages()).map((p) => p.title), ['Old Kesh']);
    await pw.here('At the table');
    const ev = await dm.sendQuickEvent({ kind: 'vote', title: 'Where?', prompt: 'Sleep where?', options: ['Inn', 'Camp'] });
    await pw.respond(ev.id, { choice: 1 });
    await new Promise((r) => setTimeout(r, 80));
    stop();

    assert.ok(events.includes('page') && events.includes('presence') && events.includes('quick-event'));
    assert.equal(events.filter((e) => e === 'page').length, 1, 'only the shared page was announced');
    assert.match(pw.icsUrl(), /\/dav\/worlds\/bloodearth\/sessions\.ics$/);
  } finally {
    server.close();
  }
});
