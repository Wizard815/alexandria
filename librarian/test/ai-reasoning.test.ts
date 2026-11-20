// Reasoning models: an output-token floor per job, and a wider retry when an
// empty answer was cut off by the limit (the budget went on thinking).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chat, chatJson, chatStream, forgetLearned, jobBudget, setJobResolver, type JobConfig } from '../src/core/ai.ts';

type Reply = Response | ((body: any, n: number) => Response | Promise<Response>);
interface Fake { d: any; calls: { url: string; body: any }[] }

function fake(cfg: Partial<JobConfig>, ...replies: Reply[]): Fake {
  const calls: Fake['calls'] = [];
  const d: any = {
    env: {},
    fetch: async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (typeof r !== 'function') return r.clone();
      return r(body, calls.length - 1);
    },
  };
  setJobResolver((_d, job) => (job === 'chat' || job === 'audit' ? { baseUrl: 'http://models.test/v1', model: 'm', ...cfg } : null));
  return { d, calls };
}
afterEach(() => { setJobResolver(null); forgetLearned(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (content = 'hi') => json({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const cut = () => json({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] });
const err = (status: number, message: string) => json({ error: { message } }, status);
const msgs = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];
const chunk = (delta: object, finish: string | null = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
const sse = (lines: (string | object)[]) => new Response(lines.map((l) => (typeof l === 'string' ? l : `data: ${JSON.stringify(l)}`)).join('\n\n') + '\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

test('AiReasoning_FloorsOutputTokensForChatAndAudit', async () => {
  const a = fake({}, ok());
  await chat(a.d, 'chat', { messages: msgs, maxTokens: 300 });
  await chat(a.d, 'audit', { messages: msgs, maxTokens: 700 });
  assert.equal(a.calls[0].body.max_tokens, 2000);
  assert.equal(a.calls[1].body.max_tokens, 2000);
  await chat(a.d, 'chat', { messages: msgs, maxTokens: 5000 });
  assert.equal(a.calls[2].body.max_tokens, 5000, 'a bigger ask is kept');
  await chat(a.d, 'chat', { messages: msgs });
  assert.equal(a.calls[3].body.max_tokens, undefined, 'no limit asked, none sent');
  assert.equal(jobBudget(a.d, 'chat', 900), 2000, 'what the extractor uses');
});

test('AiReasoning_JobOptionsSetOrRemoveTheFloor', async () => {
  const own = fake({ options: { minOutputTokens: 3000 } }, ok());
  await chat(own.d, 'chat', { messages: msgs, maxTokens: 300 });
  assert.equal(own.calls[0].body.max_tokens, 3000);
  assert.ok(!('minOutputTokens' in own.calls[0].body), 'job options are never sent');
  const plain = fake({ options: { reasoningModel: false } }, ok());
  await chat(plain.d, 'chat', { messages: msgs, maxTokens: 300 });
  assert.equal(plain.calls[0].body.max_tokens, 300);
  assert.ok(!('reasoningModel' in plain.calls[0].body));
  const tiny = fake({}, ok());
  await chat(tiny.d, 'chat', { messages: msgs, maxTokens: 16, noFloor: true });
  assert.equal(tiny.calls[0].body.max_tokens, 16, 'the readiness probe stays tiny');
});

test('AiReasoning_EmptyLengthCutOffIsRetriedOnceWithDoubleTheBudget', async () => {
  const f = fake({}, cut(), ok('real answer'));
  const r = await chat(f.d, 'chat', { messages: msgs, maxTokens: 900 });
  assert.equal(r.content, 'real answer');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.max_tokens, 2000);
  assert.equal(f.calls[1].body.max_tokens, 4000);
  assert.equal(f.calls[1].body.reasoning, undefined, 'a plain server is not sent OpenRouter fields');
  const g = fake({}, cut());
  const r2 = await chat(g.d, 'chat', { messages: msgs, maxTokens: 900 });
  assert.equal(r2.content, '');
  assert.equal(g.calls.length, 2, 'only one retry');
  const h = fake({}, cut(), ok('{"a":1}'));
  assert.deepEqual(await chatJson(h.d, 'audit', msgs), { a: 1 });
});

test('AiReasoning_OpenRouterRetryTurnsReasoningOffAndRemembersARefusal', async () => {
  const f = fake({ baseUrl: 'https://openrouter.ai/api/v1' }, cut(), ok('after'));
  const r = await chat(f.d, 'chat', { messages: msgs, maxTokens: 500 });
  assert.equal(r.content, 'after');
  assert.deepEqual(f.calls[1].body.reasoning, { enabled: false });
  assert.equal(f.calls[0].body.reasoning, undefined);
  const g = fake({ baseUrl: 'https://openrouter.ai/api/v1' }, cut(), err(400, 'reasoning is not supported by this model'), ok('ok'));
  const r2 = await chat(g.d, 'chat', { messages: msgs, maxTokens: 500 });
  assert.equal(r2.content, 'ok');
  assert.equal(g.calls[2].body.reasoning, undefined);
});

test('AiReasoning_StreamedEmptyCutOffIsRetriedWiderToo', async () => {
  const f = fake({}, sse([chunk({ role: 'assistant', content: '' }, 'length'), 'data: [DONE]']), sse([chunk({ content: 'late ' }), chunk({ content: 'answer' }, 'stop'), 'data: [DONE]']));
  const got: string[] = [];
  const r = await chatStream(f.d, 'chat', { messages: msgs, maxTokens: 400 }, (t) => got.push(t));
  assert.equal(r.content, 'late answer');
  assert.equal(got.join(''), 'late answer');
  assert.equal(f.calls[1].body.max_tokens, 4000);
});

test('AiReasoning_AuditJobAsksOpenRouterNotToThinkByDefault', async () => {
  const OR = { baseUrl: 'https://openrouter.ai/api/v1' };
  const a = fake(OR, ok('yes'));
  await chat(a.d, 'audit', { messages: msgs, maxTokens: 50 });
  assert.deepEqual(a.calls[0].body.reasoning, { enabled: false }, 'audit: no thinking');
  const c = fake(OR, ok('hi'));
  await chat(c.d, 'chat', { messages: msgs, maxTokens: 50 });
  assert.equal(c.calls[0].body.reasoning, undefined, 'chat: left to the model');
  const on = fake({ ...OR, options: { reasoning: 'on' } }, ok('yes'));
  await chat(on.d, 'audit', { messages: msgs, maxTokens: 50 });
  assert.equal(on.calls[0].body.reasoning, undefined, 'reasoning: on lets audit think');
  assert.ok(!('reasoning' in (on.calls[0].body.options ?? {})), 'the option is not sent');
  const off = fake({ ...OR, options: { reasoning: 'off' } }, ok('hi'));
  await chat(off.d, 'chat', { messages: msgs, maxTokens: 50 });
  assert.deepEqual(off.calls[0].body.reasoning, { enabled: false }, 'reasoning: off for chat');
  const local = fake({}, ok('yes'));
  await chat(local.d, 'audit', { messages: msgs, maxTokens: 50 });
  assert.equal(local.calls[0].body.reasoning, undefined, 'a plain server is not sent the field by default');
  const asked = fake({ options: { reasoning: 'off' } }, ok('yes'));
  await chat(asked.d, 'audit', { messages: msgs, maxTokens: 50 });
  assert.deepEqual(asked.calls[0].body.reasoning, { enabled: false }, 'unless the job option asks for it');
});

test('AiReasoning_OpenRouterProviderErrorIsTriedOnceMore', async () => {
  const f = fake({ baseUrl: 'https://openrouter.ai/api/v1' }, err(502, 'Provider returned error'), ok('second time'));
  const r = await chat(f.d, 'chat', { messages: msgs, maxTokens: 50 });
  assert.equal(r.content, 'second time');
  assert.equal(f.calls.length, 2);
});
