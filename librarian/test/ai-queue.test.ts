// The queue in front of a model server: no more than maxConcurrent requests at once, the rest wait and go by priority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, gateStats, setJobResolver, withPriority } from '../src/core/ai.ts';

const msgs = [{ role: 'user' as const, content: 'hi' }];
test('AiQueue_AtMostMaxConcurrentAtOnceAndTheMostUrgentGoFirst', async () => {
  let running = 0, peak = 0;
  const order: string[] = [];
  const release: (() => void)[] = [];
  const d: any = {
    db: null,
    fetch: async (_u: string, init: any) => {
      const who = JSON.parse(init.body).messages.at(-1).content;
      running++; peak = Math.max(peak, running); order.push(who);
      await new Promise<void>((r) => release.push(r));
      running--;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: who }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  setJobResolver(() => ({ baseUrl: 'http://queue.test/v1', model: 'm', location: 'local', options: { maxConcurrent: 2 } }));
  try {
    const ask = (who: string, p: number) => withPriority(p, () => chat(d, 'chat', { messages: [{ role: 'user', content: who }] }));
    const all = [ask('bg1', 0), ask('bg2', 0), ask('player', 1), ask('bg3', 0), ask('dm', 2)];
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(running, 2, 'two at a time on this server');
    assert.equal(gateStats().find((g) => g.server === 'http://queue.test/v1')!.waiting, 3);
    while (order.length < 5 || release.length) { const r = release.shift(); if (r) r(); await new Promise((x) => setTimeout(x, 5)); }
    await Promise.all(all);
    assert.equal(peak, 2);
    assert.deepEqual(order.slice(2), ['dm', 'player', 'bg3'], 'waiting requests go GM first, then players, then background');
  } finally { setJobResolver(null); }
  void msgs;
});

test('AiQueue_AQueuedCallSaysHowManyAreAhead', async () => {
  const release: (() => void)[] = [];
  const d: any = { db: null, fetch: async () => { await new Promise<void>((r) => release.push(r)); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } };
  setJobResolver(() => ({ baseUrl: 'http://wait.test/v1', model: 'w', location: 'local', options: { maxConcurrent: 1 } }));
  try {
    const heard: number[] = [];
    const first = withPriority(1, () => chat(d, 'chat', { messages: msgs }));
    await new Promise((r) => setTimeout(r, 10));
    const second = withPriority(1, () => chat(d, 'chat', { messages: msgs }), (ahead) => heard.push(ahead));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(heard, [1], 'one ahead of it (the one running)');
    while (release.length || heard.length < 1) { release.shift()?.(); await new Promise((r) => setTimeout(r, 5)); }
    release.shift()?.();
    await new Promise((r) => setTimeout(r, 10));
    release.shift()?.();
    await Promise.all([first, second]);
  } finally { setJobResolver(null); }
});
