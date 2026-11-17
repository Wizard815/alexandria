// Audit: world settings hold things only the DM should read (the WorldLore source and folder, what the DM's agent may do unasked).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventTap } from './security-kit.ts';
import { boot, type Kit } from './audit-kit.ts';

let k: Kit;
before(async () => { k = await boot(); });
after(() => k?.close());
const settle = () => new Promise((r) => setTimeout(r, 150));

test('Audit_Settings: DM-only settings never reach a player, a guest, a model asking as a player, or their live stream', async () => {
  const tap = new EventTap(k.base + k.w('/events'), k.T.jess);
  await settle();
  const root = 'DM Secrets/ZQXLOREROOT';
  await k.ok('PATCH', k.w('/settings'), k.T.dm, { worldLore: { kind: 'library', root, defaultLevel: 'dm', url: 'https://wiki.example.com/ZQXLOREURL' }, agentAutoApprove: ['ZQXAUTOTOOL'], brokerTopics: ['rumours'] });
  await settle();
  await tap.close();
  const seen: string[] = [];
  for (const who of ['jess', 'visitor']) {
    for (const u of ['', '/settings']) {
      const r = await k.call('GET', k.w(u), k.T[who]);
      assert.equal(r.status, 200);
      seen.push(...['ZQXLOREROOT', 'ZQXLOREURL', 'ZQXAUTOTOOL'].filter((t) => r.text.includes(t)).map((t) => `${t} in ${who} GET ${u || '/'}`));
    }
  }
  seen.push(...['ZQXLOREROOT', 'ZQXLOREURL', 'ZQXAUTOTOOL'].filter((t) => tap.text.includes(t)).map((t) => `${t} in jess's event stream`));
  assert.deepEqual(seen, []);
  // The DM still sees everything.
  const dm = await k.call('GET', k.w('/settings'), k.T.dm);
  assert.ok(dm.text.includes('ZQXLOREROOT') && dm.text.includes('ZQXAUTOTOOL'));
});
