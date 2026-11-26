// "DM first": the DM's model calls get through at once even when players fill every slot of a local model.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { chat, chatStream, gateStats, ModelPreempted, setDmFirstResolver, setJobResolver, withPriority, DM_FIRST_DEFAULTS, type DmFirst } from '../src/core/ai.ts';
import { createApp } from '../src/app.ts';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const answer = (text: string) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** A fake model server: every request waits until released (or aborted), and says who asked. */
function server() {
  const live = new Map<string, () => void>();
  const log: string[] = [];
  const fetch = async (u: string, init: any) => {
    const who = JSON.parse(init.body).messages.at(-1).content as string;
    log.push(`start ${who}`);
    await new Promise<void>((resolve, reject) => {
      live.set(who, resolve);
      init.signal?.addEventListener('abort', () => { live.delete(who); log.push(`stopped ${who}`); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
    live.delete(who);
    log.push(`done ${who}`);
    return answer(`${who} ok @${new URL(u).host}`);
  };
  const release = async (who: string) => { for (let i = 0; i < 100 && !live.has(who); i++) await tick(5); const r = live.get(who); assert.ok(r, `${who} is running`); r!(); await tick(); };
  return { d: { db: null, fetch } as any, live, log, release };
}
function setup(host: string, max: number, policy: Partial<DmFirst>) {
  setJobResolver((_d, job) => ({ baseUrl: `http://${job === 'player' ? `helper.${host}` : host}/v1`, model: job === 'player' ? 'small' : 'm', location: 'local', options: { maxConcurrent: max } }));
  setDmFirstResolver(() => ({ ...DM_FIRST_DEFAULTS, ...policy }));
}
const reset = () => { setJobResolver(null); setDmFirstResolver(null); };
const ask = (d: any, who: string, p: number, job: 'chat' | 'player' = 'chat') => withPriority(p, () => chat(d, job, { messages: [{ role: 'user', content: who }] }));

test('TestDmFirst_TheDmStopsTheNewestPlayerCallWhichRunsAgainAfter', async () => {
  const s = server();
  setup('preempt.test', 2, { preempt: true });
  try {
    const p1 = ask(s.d, 'p1', 1);
    await tick();
    const p2 = ask(s.d, 'p2', 1);
    await tick();
    const dm = ask(s.d, 'dm', 2);
    await tick();
    assert.ok(s.live.has('dm'), 'the DM runs at once');
    assert.ok(s.live.has('p1') && !s.live.has('p2'), 'the newest player call gave way');
    assert.equal(gateStats().find((g) => g.server === 'http://preempt.test/v1')!.preempted, 1);
    await s.release('dm');
    assert.equal((await dm).content, 'dm ok @preempt.test');
    assert.ok(s.live.has('p2'), 'the stopped call started again after the DM');
    await s.release('p1');
    await s.release('p2');
    assert.deepEqual([(await p1).content, (await p2).content], ['p1 ok @preempt.test', 'p2 ok @preempt.test'], 'both players still get their answer');
    assert.deepEqual(s.log.filter((l) => l.startsWith('start')), ['start p1', 'start p2', 'start dm', 'start p2']);
  } finally { reset(); }
});

test('TestDmFirst_PreemptOffTheDmWaitsAtTheFrontOfTheLine', async () => {
  const s = server();
  setup('nopreempt.test', 1, { preempt: false });
  try {
    const p1 = ask(s.d, 'p1', 1);
    await tick();
    const p2 = ask(s.d, 'p2', 1);
    const dm = ask(s.d, 'dm', 2);
    await tick();
    assert.ok(s.live.has('p1') && !s.live.has('dm'), 'nothing is stopped');
    await s.release('p1');
    assert.ok(s.live.has('dm') && !s.live.has('p2'), 'the DM goes next, before the player who asked first');
    await s.release('dm');
    await s.release('p2');
    await Promise.all([p1, p2, dm]);
  } finally { reset(); }
});

test('TestDmFirst_AStreamedPlayerAnswerAlreadyShowingTextEndsWithModelPreempted', async () => {
  let shown = '';
  const enc = new TextEncoder();
  const d: any = {
    db: null,
    fetch: async (_u: string, init: any) => {
      const who = JSON.parse(init.body).messages.at(-1).content as string;
      if (who === 'dm') return answer('dm ok');
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Once upon' } }] })}\n\n`));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  setup('stream.test', 1, { preempt: true });
  try {
    const player = withPriority(1, () => chatStream(d, 'chat', { messages: [{ role: 'user', content: 'tell me a story' }] }, (t) => { shown += t; }));
    await tick(20);
    assert.equal(shown, 'Once upon');
    const dm = ask(d, 'dm', 2);
    await assert.rejects(player, (e: any) => e instanceof ModelPreempted, 'it cannot start over: its text was shown');
    assert.equal((await dm).content, 'dm ok');
  } finally { reset(); }
});

test('TestDmFirst_AReservedSlotIsLeftForTheDm', async () => {
  const s = server();
  setup('reserve.test', 2, { preempt: false, reserve: 1 });
  try {
    const p1 = ask(s.d, 'p1', 1);
    const p2 = ask(s.d, 'p2', 1);
    await tick();
    assert.ok(s.live.has('p1') && !s.live.has('p2'), 'players share what is left: one slot');
    const dm = ask(s.d, 'dm', 2);
    await tick();
    assert.ok(s.live.has('dm'), 'the DM gets the kept slot at once');
    await s.release('dm');
    assert.ok(!s.live.has('p2'), 'the kept slot stays the DM\'s');
    await s.release('p1');
    await s.release('p2');
    await Promise.all([p1, p2, dm]);
    // Asking for more than there is still leaves one slot for everyone else.
    setDmFirstResolver(() => ({ ...DM_FIRST_DEFAULTS, reserve: 5 }));
    const p3 = ask(s.d, 'p3', 1);
    await tick();
    assert.ok(s.live.has('p3'));
    await s.release('p3');
    await p3;
  } finally { reset(); }
});

test('TestDmFirst_HoldPlayersWaitsWhileTheDmIsBusyOnAnyLocalModel', async () => {
  const s = server();
  setup('hold.test', 4, { preempt: false, holdPlayers: true });
  try {
    const dm = ask(s.d, 'dm', 2);
    await tick();
    const helper = ask(s.d, 'quick', 1, 'player');
    const bg = ask(s.d, 'summary', 0);
    await tick();
    assert.ok(s.live.has('dm'));
    assert.ok(!s.live.has('quick') && !s.live.has('summary'), 'the player\'s small model and background work wait for the DM');
    await s.release('dm');
    assert.ok(s.live.has('quick') && s.live.has('summary'), 'and start once the DM is done');
    await s.release('quick');
    await s.release('summary');
    assert.equal((await helper).content, 'quick ok @helper.hold.test');
    await Promise.all([dm, bg]);
  } finally { reset(); }
});

test('TestDmFirst_ACallStoppedWhileWaitingLeavesTheLine', async () => {
  const s = server();
  setup('abort.test', 1, {});
  try {
    const p1 = ask(s.d, 'p1', 1);
    await tick();
    const ctl = new AbortController();
    const waiting = withPriority(1, () => chat(s.d, 'chat', { messages: [{ role: 'user', content: 'p2' }] }, ctl.signal));
    await tick();
    assert.equal(gateStats().find((g) => g.server === 'http://abort.test/v1')!.waiting, 1);
    ctl.abort();
    await assert.rejects(waiting, (e: any) => e?.name === 'AbortError');
    assert.equal(gateStats().find((g) => g.server === 'http://abort.test/v1')!.waiting, 0);
    await s.release('p1');
    await p1;
    assert.ok(!s.log.includes('start p2'));
  } finally { reset(); }
});

test('TestDmFirst_TheAdminSetsItAndBadValuesAreRefused', async () => {
  const { app } = createApp({ noScheduler: true, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0' } });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  after(() => { srv.close(); srv.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const token = (await call('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).body.token as string;
  assert.deepEqual((await call('GET', '/api/admin/models/queue', token)).body.dmFirst, DM_FIRST_DEFAULTS);
  const put = await call('PUT', '/api/admin/models/dm-first', token, { reserve: 1, holdPlayers: true });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.dmFirst, { preempt: true, reserve: 1, holdPlayers: true });
  assert.deepEqual((await call('GET', '/api/admin/models/queue', token)).body.dmFirst, { preempt: true, reserve: 1, holdPlayers: true });
  assert.equal((await call('PUT', '/api/admin/models/dm-first', token, { reserve: -1 })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models/dm-first', token, { preempt: 'yes' })).status, 400);
  assert.equal((await call('PUT', '/api/admin/models/dm-first', undefined, { preempt: false })).status, 401);
});
