// core/ai.ts against a fake fetch that answers the way the real OpenAI API and
// the OpenAI-compatible servers (llama-server, Ollama, LM Studio, vLLM) do:
// token-limit names, temperature, JSON modes and their 400s, 429 retries,
// timeouts, and streamed chunks with tool calls split across them.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkAssembler, ModelUnavailable, chat, chatJson, chatStream, forgetLearned, learnedModes, setJobResolver, type JobConfig } from '../src/core/ai.ts';

type Reply = Response | ((body: any, n: number) => Response | Promise<Response>);
interface Fake { d: any; calls: { url: string; headers: Record<string, string>; body: any }[] }

/** A deps stub whose chat job is `cfg`, and whose fetch walks through `replies` (the last one repeats). */
function fake(cfg: Partial<JobConfig>, ...replies: Reply[]): Fake {
  const calls: Fake['calls'] = [];
  const d: any = {
    env: {},
    fetch: async (url: string, init: any) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, headers: init.headers, body });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (typeof r !== 'function') return r.clone();
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return r(body, calls.length - 1);
    },
  };
  setJobResolver((_d, job) => (job === 'chat' || job === 'audit' ? { baseUrl: 'http://models.test/v1', model: 'm', ...cfg } : null));
  return { d, calls };
}
afterEach(() => { setJobResolver(null); forgetLearned(); });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const ok = (content = 'hi', extra: Record<string, unknown> = {}) => json({ id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
const err = (status: number, message: string, headers: Record<string, string> = {}) => json({ error: { message, type: 'invalid_request_error', param: null, code: null } }, status, headers);
const msgs = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'hello' }];

/** Server-sent events cut into pieces of `size` bytes, to prove lines that arrive in halves still parse. */
function sse(lines: (string | object)[], size = 17, headers: Record<string, string> = {}): Response {
  const text = lines.map((l) => (typeof l === 'string' ? l : `data: ${JSON.stringify(l)}`)).join('\n\n') + '\n\n';
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}
const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({ id: 'chatcmpl-9', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', system_fingerprint: 'fp_1', choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra });

// ---- token limits, temperature, tool options ----

test('AI: api.openai.com gets max_completion_tokens and everyone else max_tokens', async () => {
  const a = fake({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' }, ok());
  await chat(a.d, 'chat', { messages: msgs, maxTokens: 50 });
  assert.equal(a.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(a.calls[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(a.calls[0].body.max_completion_tokens, 50);
  assert.equal(a.calls[0].body.max_tokens, undefined);
  const b = fake({}, ok());
  await chat(b.d, 'chat', { messages: msgs, maxTokens: 50 });
  assert.equal(b.calls[0].body.max_tokens, 50);
  assert.equal(b.calls[0].body.max_completion_tokens, undefined);
  // The job option overrides the host guess, and never reaches the server.
  const c = fake({ options: { maxTokensParam: 'max_completion_tokens', timeoutMs: 5000, noTemperature: true, jsonMode: 'off', top_k: 20 } }, ok());
  await chat(c.d, 'chat', { messages: msgs, maxTokens: 50 });
  assert.equal(c.calls[0].body.max_completion_tokens, 50);
  assert.equal(c.calls[0].body.top_k, 20);
  for (const k of ['maxTokensParam', 'timeoutMs', 'noTemperature', 'jsonMode']) assert.ok(!(k in c.calls[0].body), `${k} was sent`);
  const e = fake({ baseUrl: 'https://api.openai.com/v1', options: { maxTokensParam: 'max_tokens' } }, ok());
  await chat(e.d, 'chat', { messages: msgs, maxTokens: 9 });
  assert.equal(e.calls[0].body.max_tokens, 9);
});

test('AI: a server that rejects max_tokens is switched to max_completion_tokens, and remembered', async () => {
  const f = fake({}, err(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), ok('fine'));
  const r = await chat(f.d, 'chat', { messages: msgs, maxTokens: 20 });
  assert.equal(r.content, 'fine');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.max_completion_tokens, 20);
  assert.equal(f.calls[1].body.max_tokens, undefined);
  assert.equal(r.timings?.attempts, 2);
  await chat(f.d, 'chat', { messages: msgs, maxTokens: 20 });
  assert.equal(f.calls[2].body.max_completion_tokens, 20, 'the next call starts with what worked');
});

test('AI: temperature is omitted when the job says so, or after the model rejects it', async () => {
  const a = fake({ options: { noTemperature: true } }, ok());
  await chat(a.d, 'chat', { messages: msgs, temperature: 0.2 });
  assert.ok(!('temperature' in a.calls[0].body));
  const b = fake({}, ok());
  await chat(b.d, 'chat', { messages: msgs, temperature: 0.2 });
  assert.equal(b.calls[0].body.temperature, 0.2);
  const c = fake({}, err(400, "Unsupported value: 'temperature' does not support 0.4 with this model. Only the default (1) value is supported."), ok());
  await chat(c.d, 'chat', { messages: msgs });
  assert.ok(!('temperature' in c.calls[1].body));
  assert.equal(learnedModes(c.d, 'chat')?.noTemp, true);
});

test('AI: tool_choice and parallel_tool_calls are sent with tools, and only with tools', async () => {
  const tool = { type: 'function' as const, function: { name: 'find', description: 'd', parameters: { type: 'object', properties: {} } } };
  const f = fake({}, ok());
  await chat(f.d, 'chat', { messages: msgs, tools: [tool], toolChoice: { name: 'find' }, parallelToolCalls: false });
  assert.deepEqual(f.calls[0].body.tool_choice, { type: 'function', function: { name: 'find' } });
  assert.equal(f.calls[0].body.parallel_tool_calls, false);
  await chat(f.d, 'chat', { messages: msgs, tools: [tool], toolChoice: 'required', parallelToolCalls: true });
  assert.equal(f.calls[1].body.tool_choice, 'required');
  assert.equal(f.calls[1].body.parallel_tool_calls, true);
  await chat(f.d, 'chat', { messages: msgs, toolChoice: 'auto', parallelToolCalls: true });
  assert.ok(!('tools' in f.calls[2].body) && !('tool_choice' in f.calls[2].body) && !('parallel_tool_calls' in f.calls[2].body));
  // A server that does not know parallel_tool_calls: drop it and go on.
  const g = fake({}, err(400, 'Unknown parameter: parallel_tool_calls'), ok());
  await chat(g.d, 'chat', { messages: msgs, tools: [tool], parallelToolCalls: true });
  assert.ok(!('parallel_tool_calls' in g.calls[1].body));
});

test('AI: tool calls without ids, or with object arguments (Ollama, llama-server), come back in the OpenAI shape', async () => {
  const f = fake({}, ok('', { tool_calls: [{ function: { name: 'find', arguments: { q: 'x' } } }, { id: 'call_2', type: 'function', function: { name: 'read', arguments: '' } }] }));
  const r = await chat(f.d, 'chat', { messages: msgs });
  assert.equal(r.toolCalls.length, 2);
  assert.match(r.toolCalls[0].id, /^call_/);
  assert.equal(r.toolCalls[0].function.arguments, '{"q":"x"}');
  assert.equal(r.toolCalls[1].function.arguments, '{}');
  assert.equal(r.finishReason, 'tool_calls');
  assert.ok(r.timings && r.timings.totalMs >= 0 && r.timings.attempts === 1);
});

// ---- structured output ----

const schema = { name: 'answer', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };

test('AI: response_format json_object, and json_schema when given a schema', async () => {
  const f = fake({}, ok('{"ok":true}'));
  assert.deepEqual(await chatJson(f.d, 'chat', msgs), { ok: true });
  assert.deepEqual(f.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(f.calls[0].body.temperature, 0);
  await chatJson(f.d, 'chat', msgs, undefined, { schema });
  assert.equal(f.calls[1].body.response_format.type, 'json_schema');
  assert.equal(f.calls[1].body.response_format.json_schema.name, 'answer');
  assert.deepEqual(f.calls[1].body.response_format.json_schema.schema, schema.schema);
  // The job can cap it.
  const g = fake({ options: { jsonMode: 'object' } }, ok('{"ok":true}'));
  await chatJson(g.d, 'chat', msgs, undefined, { schema });
  assert.equal(g.calls[0].body.response_format.type, 'json_object');
});

test('AI: JSON mode falls back from json_schema to json_object to a prompt-only instruction on 400, and the working mode is cached', async () => {
  // llama-server and Ollama word these differently, or not at all.
  const f = fake({}, err(400, "Unsupported response_format: json_schema"), err(400, 'bad request'), ok('{"ok":true}'));
  const r = await chat(f.d, 'chat', { messages: msgs, jsonSchema: schema.name ? schema : undefined });
  assert.equal(r.content, '{"ok":true}');
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].body.response_format.type, 'json_schema');
  assert.equal(f.calls[1].body.response_format.type, 'json_object');
  assert.equal(f.calls[2].body.response_format, undefined);
  assert.match(f.calls[2].body.messages[0].content, /single valid JSON object/);
  assert.equal(r.timings?.jsonMode, 'prompt');
  // Cached: the next call goes straight to prompt-only.
  const again = await chatJson(f.d, 'chat', msgs, undefined, { schema });
  assert.deepEqual(again, { ok: true });
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[3].body.response_format, undefined);
  assert.equal(learnedModes(f.d, 'chat')?.json, 'off');
  // Another job (or model) learns on its own.
  const other = fake({ model: 'other' }, ok('{"ok":false}'));
  await chatJson(other.d, 'chat', msgs, undefined, { schema });
  assert.equal(other.calls[0].body.response_format.type, 'json_schema');
});

test('AI: a 400 that is not about response_format is not blamed on it', async () => {
  const f = fake({}, err(400, "This model's maximum context length is 8192 tokens"));
  await assert.rejects(chat(f.d, 'chat', { messages: msgs, json: true }), (e: any) => e instanceof ModelUnavailable && e.status === 400 && /400/.test(e.message));
  assert.equal(learnedModes(f.d, 'chat')?.json, undefined, 'a failed retry teaches nothing');
  // chatJson never throws for a model problem.
  assert.equal(await chatJson(f.d, 'chat', msgs), null);
});

// ---- errors, 429, timeouts ----

test('AI: 401 and 404 say what is wrong', async () => {
  const a = fake({ model: 'gpt-nope' }, err(401, 'Incorrect API key provided: sk-****'));
  await assert.rejects(chat(a.d, 'chat', { messages: msgs }), (e: any) => e instanceof ModelUnavailable && e.status === 401 && /rejected the API key/.test(e.message) && /Admin → Models/.test(e.message));
  const b = fake({ model: 'gpt-nope' }, err(404, 'The model `gpt-nope` does not exist or you do not have access to it.'));
  await assert.rejects(chat(b.d, 'chat', { messages: msgs }), (e: any) => e.status === 404 && /"gpt-nope" was not found/.test(e.message) && /does not exist/.test(e.message));
});

test('AI: a 429 is retried after Retry-After, then the call goes through', async () => {
  const f = fake({}, err(429, 'Rate limit reached for gpt-4o', { 'Retry-After': '0' }), err(429, 'Rate limit reached', { 'retry-after': '0' }), ok('finally'));
  const t0 = Date.now();
  const r = await chat(f.d, 'chat', { messages: msgs });
  assert.equal(r.content, 'finally');
  assert.equal(f.calls.length, 3);
  assert.equal(r.timings?.attempts, 3);
  assert.ok(Date.now() - t0 < 2000);
});

test('AI: Retry-After is honored, and a 429 that keeps coming says so', async () => {
  const f = fake({}, err(429, 'Rate limit reached', { 'Retry-After': '0.12' }), ok('later'));
  const t0 = Date.now();
  await chat(f.d, 'chat', { messages: msgs });
  assert.ok(Date.now() - t0 >= 100, 'waited for Retry-After');
  const g = fake({}, err(429, 'Rate limit reached', { 'Retry-After': '0' }));
  await assert.rejects(chat(g.d, 'chat', { messages: msgs }), (e: any) => e.status === 429 && /rate limited/.test(e.message));
  assert.equal(g.calls.length, 3, 'one try and two retries');
  // Out of quota is not worth retrying.
  const h = fake({}, json({ error: { message: 'You exceeded your current quota, please check your plan', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429));
  await assert.rejects(chat(h.d, 'chat', { messages: msgs }), (e: any) => /out of quota/.test(e.message));
  assert.equal(h.calls.length, 1);
});

test('AI: a server that never answers times out after timeoutMs, with a clear message', async () => {
  const hang: Reply = (_b, _n) => new Promise<Response>(() => { /* never */ });
  const calls: any[] = [];
  const d: any = { env: {}, fetch: (_u: string, init: any) => new Promise((_res, rej) => { calls.push(init); init.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))); }) };
  void hang;
  setJobResolver(() => ({ baseUrl: 'http://models.test/v1', model: 'm', options: { timeoutMs: 60 } }));
  const t0 = Date.now();
  await assert.rejects(chat(d, 'chat', { messages: msgs }), (e: any) => e instanceof ModelUnavailable && /did not answer within/.test(e.message) && /timeoutMs/.test(e.message));
  assert.ok(Date.now() - t0 < 1500);
  // A caller's own abort stays an abort.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  setJobResolver(() => ({ baseUrl: 'http://models.test/v1', model: 'm' }));
  await assert.rejects(chat(d, 'chat', { messages: msgs }, ac.signal), (e: any) => e.name === 'AbortError');
});

// ---- streaming ----

test('AI: chatStream assembles content deltas and the usage chunk, as OpenAI sends them', async () => {
  const f = fake({}, sse([
    chunk({ role: 'assistant', content: '', refusal: null }),
    chunk({ content: 'The ' }), chunk({ content: 'harbour ' }), chunk({ content: 'bells ring.' }),
    chunk({}, 'stop'),
    { id: 'chatcmpl-9', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
    'data: [DONE]',
  ]));
  const got: string[] = [];
  const r = await chatStream(f.d, 'chat', { messages: msgs, maxTokens: 100 }, (t) => got.push(t));
  assert.deepEqual(got, ['The ', 'harbour ', 'bells ring.']);
  assert.equal(r.content, 'The harbour bells ring.');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 });
  assert.deepEqual(r.toolCalls, []);
  assert.equal(f.calls[0].body.stream, true);
  assert.deepEqual(f.calls[0].body.stream_options, { include_usage: true });
  assert.ok(r.timings && typeof r.timings.firstTokenMs === 'number' && r.timings.firstTokenMs <= r.timings.totalMs);
});

test('AI: chatStream assembles tool calls split across chunks (id, name, argument fragments, two calls by index)', async () => {
  const f = fake({}, sse([
    chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_aaa', type: 'function', function: { name: 'search_library', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'ery":"vel' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_bbb', type: 'function', function: { name: 'read_page', arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'mira"}' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '{"page":' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '"pg_1"}' } }] }),
    chunk({}, 'tool_calls'),
    'data: [DONE]',
  ], 11));
  const got: string[] = [];
  const r = await chatStream(f.d, 'chat', { messages: msgs, parallelToolCalls: true, tools: [{ type: 'function', function: { name: 'search_library', description: '', parameters: {} } }] }, (t) => got.push(t));
  assert.deepEqual(got, []);
  assert.equal(r.finishReason, 'tool_calls');
  assert.deepEqual(r.toolCalls, [
    { id: 'call_aaa', type: 'function', function: { name: 'search_library', arguments: '{"query":"velmira"}' } },
    { id: 'call_bbb', type: 'function', function: { name: 'read_page', arguments: '{"page":"pg_1"}' } },
  ]);
});

test('AI: chatStream copes with llama-server: no ids, no indexes, content and tool_calls together, CRLF, comments, a final usage-less stop', async () => {
  const text = [
    ': keep-alive', '',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me look. ', reasoning_content: 'thinking…' } }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ function: { name: 'search_library', arguments: '{"query":' } }] } }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '"x"}' } }] } }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], timings: { predicted_ms: 5 } }),
    'data: [DONE]', '',
  ].join('\r\n\r\n');
  const f = fake({}, new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const got: string[] = [];
  const r = await chatStream(f.d, 'chat', { messages: msgs }, (t) => got.push(t));
  assert.equal(r.content, 'Let me look. ', 'reasoning text is not content');
  assert.deepEqual(got, ['Let me look. ']);
  assert.equal(r.toolCalls.length, 1);
  assert.match(r.toolCalls[0].id, /^call_/, 'a missing id is made up');
  assert.deepEqual([r.toolCalls[0].function.name, r.toolCalls[0].function.arguments], ['search_library', '{"query":"x"}']);
  assert.equal(r.finishReason, 'tool_calls', 'stop with tool calls is a tool_calls finish');
  // Two calls that have ids but no index are two calls.
  const asm = new ChunkAssembler();
  asm.feed('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'one', arguments: '{}' } }] } }] }) + '\n\n');
  asm.feed('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'two', arguments: '{}' } }] } }] }) + '\n\n');
  assert.deepEqual(asm.toolCalls().map((c) => c.function.name), ['one', 'two']);
});

test('AI: chatStream accepts a server that ignores stream:true and answers with plain JSON', async () => {
  const f = fake({}, ok('one piece'));
  const got: string[] = [];
  const r = await chatStream(f.d, 'chat', { messages: msgs }, (t) => got.push(t));
  assert.deepEqual(got, ['one piece']);
  assert.equal(r.content, 'one piece');
  assert.deepEqual(r.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
});

test('AI: chatStream drops stream_options for a server that rejects it, and reports an in-stream error', async () => {
  const f = fake({}, err(400, "Unknown parameter: 'stream_options'."), sse([chunk({ content: 'ok' }), chunk({}, 'stop'), 'data: [DONE]']));
  const r = await chatStream(f.d, 'chat', { messages: msgs }, () => {});
  assert.equal(r.content, 'ok');
  assert.ok(!('stream_options' in f.calls[1].body));
  const g = fake({}, sse([chunk({ content: 'half' }), { error: { message: 'out of memory', type: 'server_error' } }]));
  await assert.rejects(chatStream(g.d, 'chat', { messages: msgs }, () => {}), (e: any) => e instanceof ModelUnavailable && /out of memory/.test(e.message));
});

test('AI: chatStream stops when its signal aborts, and times out a stream that goes quiet', async () => {
  const ac = new AbortController();
  const slow = (): Response => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('data: ' + JSON.stringify(chunk({ content: 'first ' })) + '\n\n')); },
      cancel() { /* the reader gave up */ },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const f = fake({}, slow());
  const got: string[] = [];
  setTimeout(() => ac.abort(), 40);
  await assert.rejects(chatStream(f.d, 'chat', { messages: msgs }, (t) => got.push(t), ac.signal), (e: any) => e.name === 'AbortError');
  assert.deepEqual(got, ['first ']);
  const g = fake({ options: { timeoutMs: 50 } }, slow());
  await assert.rejects(chatStream(g.d, 'chat', { messages: msgs }, () => {}), (e: any) => e instanceof ModelUnavailable && /stopped sending/.test(e.message));
});
