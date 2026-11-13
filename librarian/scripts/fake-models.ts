// A fake OpenAI-compatible models server for demos and tests. Deterministic,
// no dependencies beyond node:http. See docs/MODELS.md.
//
//   node --experimental-strip-types librarian/scripts/fake-models.ts --port 8300
//
// Point any job at http://127.0.0.1:8300/v1 (any key, any model name).
// In tests: const f = await startFakeModels(0); ... f.baseUrl ... await f.close();
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface FakeRequest { method: string; path: string; authorization: string | undefined; body: any }
export interface FakeModels {
  port: number;
  /** http://127.0.0.1:<port>/v1 */
  baseUrl: string;
  /** Every request seen, newest last (the audio upload is not kept, only its size). */
  requests: FakeRequest[];
  close: () => Promise<void>;
}

const MODELS = ['fake-chat', 'fake-audit', 'fake-whisper', 'fake-kokoro', 'fake-embed'];

function text(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ');
  return '';
}

function firstSentence(s: string): string {
  const t = s.trim();
  const m = t.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : t.split('\n')[0]).trim();
}

function chatReply(body: any): { content: string | null; tool_calls?: any[]; finish: string } {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  const userText = text(lastUser?.content);

  // A tool call when the last message is the user's and it names one of the tools.
  const tools: any[] = Array.isArray(body?.tools) ? body.tools : [];
  if (last?.role === 'user' && tools.length) {
    const hit = tools.map((t) => t?.function?.name as string).filter(Boolean).find((n) => userText.includes(n));
    if (hit) return { content: null, finish: 'tool_calls', tool_calls: [{ id: 'call_fake_1', type: 'function', function: { name: hit, arguments: '{}' } }] };
  }

  if (body?.response_format?.type === 'json_object') {
    const sys = messages.filter((m) => m?.role === 'system').map((m) => text(m.content)).join('\n');
    const m = sys.match(/^FAKE_JSON:\s*(\{.*\})\s*$/m);
    let out = '{}';
    if (m) { try { out = JSON.stringify(JSON.parse(m[1])); } catch { out = '{}'; } }
    return { content: out, finish: 'stop' };
  }

  const all = messages.map((m) => text(m?.content)).join('\n');
  const ctx = all.match(/Context:\s*([\s\S]*)/);
  const ctxLine = ctx ? firstSentence(ctx[1]) : '';
  const said = userText.replace(/\s+/g, ' ').trim().slice(0, 80);
  let reply = `You said: "${said}".`;
  if (ctxLine) reply += ` From the context: ${ctxLine}`;
  return { content: reply, finish: 'stop' };
}

/** Pull the uploaded file and the other form fields out of a multipart body. */
function multipart(buf: Buffer, contentType: string): { file: Buffer | null; fields: Record<string, string> } {
  const b = contentType.match(/boundary=("?)([^";]+)\1/);
  const out = { file: null as Buffer | null, fields: {} as Record<string, string> };
  if (!b) return out;
  const delim = Buffer.from('--' + b[2]);
  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next < 0) break;
    const part = buf.subarray(pos + delim.length + 2, next - 2); // drop the CRLF after the boundary and before the next
    const hEnd = part.indexOf('\r\n\r\n');
    if (hEnd > 0) {
      const head = part.subarray(0, hEnd).toString('latin1');
      const data = part.subarray(hEnd + 4);
      const name = head.match(/name="([^"]*)"/)?.[1] ?? '';
      if (/filename=/.test(head)) { if (name === 'file') out.file = data; } else out.fields[name] = data.toString('utf8');
    }
    pos = next;
  }
  return out;
}

function transcript(file: Buffer | null) {
  // The marker may follow a real audio header (the librarian checks for one).
  const at = file ? file.indexOf('FAKE:', 0, 'latin1') : -1;
  const raw = file && at >= 0 ? file.subarray(at + 5).toString('utf8').replace(/\u0000/g, '').trim() : '';
  const tokens = raw ? raw.split(/\s+/) : [];
  if (!tokens.length) {
    return { text: '(inaudible)', language: 'en', duration: 1, segments: [{ id: 0, start: 0, end: 1, text: '(inaudible)', avg_logprob: -1.5, no_speech_prob: 0.8, words: [{ word: '(inaudible)', start: 0, end: 1, probability: 0.2 }] }] };
  }
  const STEP = 0.4;
  const words = tokens.map((t, i) => {
    const m = t.match(/^(.*)\|p=([0-9.]+)$/);
    const word = m ? m[1] : t;
    return { word, start: +(i * STEP).toFixed(2), end: +((i + 1) * STEP).toFixed(2), probability: m ? Math.min(1, Math.max(0, Number(m[2]) || 0)) : 0.95 };
  });
  // A segment ends after a word that ends in . ! or ?
  const segments: any[] = [];
  let cur: typeof words = [];
  const flush = () => {
    if (!cur.length) return;
    const p = cur.reduce((s, w) => s + w.probability, 0) / cur.length;
    segments.push({ id: segments.length, start: cur[0].start, end: cur[cur.length - 1].end, text: ' ' + cur.map((w) => w.word).join(' '), avg_logprob: +Math.log(Math.max(p, 0.01)).toFixed(3), no_speech_prob: 0.01, words: cur });
    cur = [];
  };
  for (const w of words) { cur.push(w); if (/[.!?]$/.test(w.word)) flush(); }
  flush();
  return { text: words.map((w) => w.word).join(' '), language: 'en', duration: +(words.length * STEP).toFixed(2), segments, words };
}

/** A 0.3 s, 440 Hz tone as a 16-bit mono WAV. */
export function toneWav(seconds = 0.3, rate = 22050, hz = 440): Buffer {
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return b;
}

/** 64 floats from a hash of the text: the same text always gives the same unit vector. */
export function fakeEmbedding(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; bytes.length < 64; i++) bytes.push(...createHash('sha256').update(`${i}:${s}`).digest());
  const v = bytes.slice(0, 64).map((x) => x / 127.5 - 1);
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => +(x / norm).toFixed(6));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

export function startFakeModels(port = 8300, host = '127.0.0.1'): Promise<FakeModels> {
  const requests: FakeRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
    const send = (status: number, body: unknown, type = 'application/json') => {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    };
    try {
      const raw = await readBody(req);
      const ct = String(req.headers['content-type'] ?? '');
      let body: any = null;
      let up: ReturnType<typeof multipart> | null = null;
      if (ct.includes('multipart/form-data')) up = multipart(raw, ct);
      else if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      requests.push({ method: req.method ?? 'GET', path, authorization: req.headers.authorization, body: up ? { ...up.fields, fileBytes: up.file?.length ?? 0 } : body });

      if (req.method === 'GET' && path === '/v1/models') {
        return send(200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'fake' })) });
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const r = chatReply(body);
        const message: any = { role: 'assistant', content: r.content };
        if (r.tool_calls) message.tool_calls = r.tool_calls;
        const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
        if (body?.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const delta = r.tool_calls ? { role: 'assistant', content: null, tool_calls: r.tool_calls.map((t, index) => ({ index, ...t })) } : { role: 'assistant', content: r.content };
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: body.model ?? 'fake-chat', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: body.model ?? 'fake-chat', choices: [{ index: 0, delta: {}, finish_reason: r.finish }] })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        return send(200, { id: 'chatcmpl-fake', object: 'chat.completion', created: 0, model: body?.model ?? 'fake-chat', choices: [{ index: 0, message, finish_reason: r.finish }], usage });
      }
      if (req.method === 'POST' && path === '/v1/audio/transcriptions') {
        return send(200, transcript(up?.file ?? null));
      }
      if (req.method === 'POST' && path === '/v1/audio/speech') {
        return send(200, toneWav(), 'audio/wav');
      }
      if (req.method === 'POST' && path === '/v1/embeddings') {
        const input = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
        return send(200, { object: 'list', model: body?.model ?? 'fake-embed', data: input.map((s: unknown, index: number) => ({ object: 'embedding', index, embedding: fakeEmbedding(String(s)) })), usage: { prompt_tokens: 1, total_tokens: 1 } });
      }
      send(404, { error: { message: `fake-models: no route ${req.method} ${path}` } });
    } catch (err: any) {
      send(500, { error: { message: String(err?.message ?? err) } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = (server.address() as { port: number }).port;
      resolve({
        port: p,
        baseUrl: `http://${host}:${p}/v1`,
        requests,
        close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 8300;
  const f = await startFakeModels(port, process.env.HOST || '127.0.0.1');
  console.log(`fake models listening on ${f.baseUrl}`);
}
