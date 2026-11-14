// Shared parts of the security tests: the leak crawler's world (every secret
// spot gets a marker), route enumeration, and a recording fake for every model.
// See docs/SECURITY.md.
import express from 'express';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// ---- routes ------------------------------------------------------------------------
// Express 5 keeps no mount path on a router layer, so remember it as it is registered.
// Must run before createApp().
let patched = false;
export function recordMounts() {
  if (patched) return;
  patched = true;
  const proto: any = (express.Router as any).prototype;
  const use = proto.use;
  proto.use = function (this: any, ...args: any[]) {
    const before = this.stack.length;
    const r = use.apply(this, args);
    const p = typeof args[0] === 'string' ? args[0] : '';
    for (let i = before; i < this.stack.length; i++) this.stack[i].__mount = p;
    return r;
  };
}

export interface RouteDef { method: string; path: string }

/** Every route of an app (all methods), with :params left in the path. */
export function listRoutes(app: any): RouteDef[] {
  const out: RouteDef[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const l of stack) {
      if (l.route) {
        if (typeof l.route.path !== 'string') continue;
        for (const m of Object.keys(l.route.methods)) if (m !== '_all') out.push({ method: m.toUpperCase(), path: `${prefix}${l.route.path}`.replace(/\/{2,}/g, '/') });
      } else if (l.handle?.stack) walk(l.handle.stack, prefix + (l.__mount ?? ''));
    }
  };
  walk(app.router.stack, '');
  return out;
}

// ---- markers -----------------------------------------------------------------------
export type Who = 'dm' | 'jess' | 'tom' | 'guest' | 'dm2';
export interface Marker {
  id: string;
  token: string;
  /** What is seeded: a short sentence or the token itself. */
  text: string;
  /** Who may see it. Everyone else must never get it. */
  seen: Who[];
  /** May a model see it? false for classified content. */
  ai: boolean;
  where: string;
  /** For numbers: matched as a whole word instead of a substring. */
  re?: RegExp;
  /** Shared when it was made and hidden later: a live event that went out then is fine, reading it again is not. */
  eventsOk?: boolean;
}

export const RUN = randomBytes(3).toString('hex');
export const markers: Record<string, Marker> = {};

/** A marker that only these people may see. */
export function mark(id: string, seen: Who[], where: string, opts: { ai?: boolean; long?: boolean; eventsOk?: boolean } = {}): string {
  const token = `ZQX-${id.toUpperCase().replace(/_/g, '')}-${RUN}`;
  // Classified text is checked by 8-word runs, so it is a whole sentence.
  const text = opts.long ? `The sealed vault beneath the old lighthouse opens only for bearers of ${token} and none other` : token;
  // What everyone at the table may read, a guest may read.
  const all = seen.includes('dm') && seen.includes('jess') && seen.includes('tom');
  markers[id] = { id, token, text, seen: all ? [...seen, 'guest'] : seen, ai: opts.ai ?? true, where, eventsOk: opts.eventsOk };
  return text;
}
/** A marker that is a number (monster HP): matched as a whole word. */
export function markNum(id: string, seen: Who[], where: string, n: number): number {
  markers[id] = { id, token: String(n), text: String(n), seen, ai: true, where, re: new RegExp(`(?<![0-9A-Za-z])${n}(?![0-9A-Za-z])`) };
  return n;
}
const found = (m: Marker, h: string) => (m.re ? m.re.test(h) : h.includes(m.token.toLowerCase()));
export const tok = (id: string) => markers[id].token;
export const txt = (id: string) => markers[id].text;

/** Where each marker shows up, lower case, with markup removed too (search snippets wrap words in <mark>). */
export const hay = (s: string) => { const l = s.toLowerCase(); return `${l}\n${l.replace(/<[^>]*>/g, '')}`; };

/** Markers found in `text` that `who` must not see. */
export function leaksFor(who: Who, text: string): Marker[] {
  const h = hay(text);
  return Object.values(markers).filter((m) => !m.seen.includes(who) && found(m, h));
}
/** Every marker found in `text`, allowed or not. */
export function markersIn(text: string): Marker[] {
  const h = hay(text);
  return Object.values(markers).filter((m) => found(m, h));
}
/** Which markers each viewer was able to read in the crawl: a marker nobody allowed to see it ever read means the seed (or the crawl) missed it. */
export const readBy = new Map<string, Set<string>>();
export function noteRead(who: string, text: string) {
  for (const m of markersIn(text)) { let s = readBy.get(m.id); if (!s) readBy.set(m.id, (s = new Set())); s.add(who); }
}
/** Classified (never to a model) markers found in `text`. */
export function classifiedIn(text: string): Marker[] {
  const h = hay(text);
  return Object.values(markers).filter((m) => !m.ai && found(m, h));
}

// ---- http --------------------------------------------------------------------------
export interface Res { status: number; text: string; json: any; headers: Headers; buf: Buffer }

export function client(base: () => string) {
  const call = async (method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const raw = body instanceof Uint8Array;
    const r = await fetch(base() + url, {
      method,
      headers: { ...(raw || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : raw ? (body as any) : JSON.stringify(body),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const text = buf.toString('latin1');
    let json: any = null;
    try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
    return { status: r.status, text, json, headers: r.headers, buf };
  };
  const ok = async (method: string, url: string, token?: string | null, body?: unknown, headers?: Record<string, string>) => {
    const r = await call(method, url, token, body, headers);
    if (r.status >= 300) throw new Error(`${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.json ?? r.text;
  };
  return { call, ok };
}

export const baseOf = (server: any) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---- live events ---------------------------------------------------------------------
export class EventTap {
  text = '';
  private ctl = new AbortController();
  private done: Promise<void>;
  constructor(url: string, token: string) {
    this.done = (async () => {
      try {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: this.ctl.signal });
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        for (;;) { const { value, done } = await reader.read(); if (done) break; this.text += dec.decode(value, { stream: true }); }
      } catch { /* aborted */ }
    })();
  }
  async close() { this.ctl.abort(); await this.done; }
}

// ---- a recording fake for every model ------------------------------------------------------
export const MODEL_HOST = 'http://models.test';
export interface ModelCall { path: string; body: string; /** The same without the arguments of tool calls (those are the model's own words, not what it was given). */ given: string }

export function fakeModels(real: typeof fetch) {
  const calls: ModelCall[] = [];
  /** Tools the fake model asks for on the first round of a tool-using chat. */
  const plan: { tools: (offered: string[]) => { name: string; args: unknown }[] } = { tools: () => [] };
  const text = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v instanceof FormData) { const o: string[] = []; for (const [k, x] of v.entries()) o.push(`${k}=${typeof x === 'string' ? x : '[file]'}`); return o.join('\n'); }
    return v === undefined || v === null ? '' : String(v);
  };
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.startsWith(MODEL_HOST)) return real(input, init);
    const path = url.slice(MODEL_HOST.length);
    const body = text(init?.body);
    let given = body;
    try { const j = JSON.parse(body); for (const m of j.messages ?? []) for (const t of m.tool_calls ?? []) t.function.arguments = "{}"; given = JSON.stringify(j); } catch { /* not JSON */ }
    calls.push({ path, body, given });
    if (path.endsWith('/chat/completions')) {
      const b = JSON.parse(body);
      const msgs: any[] = b.messages ?? [];
      const offered: string[] = (b.tools ?? []).map((t: any) => t.function.name);
      const usedTools = msgs.some((m) => m.role === 'tool');
      if (offered.length && !usedTools) {
        const asks = plan.tools(offered).filter((a) => offered.includes(a.name));
        if (asks.length) {
          return json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: asks.map((a, i) => ({ id: `call_${i}`, type: 'function', function: { name: a.name, arguments: JSON.stringify(a.args) } })) } }] });
        }
      }
      const wantsJson = !!b.response_format || /valid JSON object/i.test(body);
      const content = wantsJson ? JSON.stringify({ flavour: 'A short vivid line.', summary: 'A quiet night.', topic: null, topics: [], values: {}, markdown: '## Recap\n- Nothing happened.' }) : 'Here is a short answer.';
      return json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    if (path.endsWith('/embeddings')) {
      const b = JSON.parse(body);
      const inputs: unknown[] = Array.isArray(b.input) ? b.input : [b.input];
      return json({ data: inputs.map((_x, i) => ({ index: i, embedding: [0.1 + i * 0.001, 0.2, 0.3] })) });
    }
    if (path.endsWith('/audio/speech')) return new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), { headers: { 'Content-Type': 'audio/mpeg' } });
    if (path.endsWith('/audio/transcriptions')) return json({ text: 'hello there', segments: [{ start: 0, end: 1, text: 'hello there' }] });
    if (path.endsWith('/models')) return json({ data: [{ id: 'fake' }] });
    return json({ error: { message: 'not found' } }, 404);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, calls, plan };
}

export const MODEL_ENV: Record<string, string> = {
  ALX_MODEL_CHAT_URL: `${MODEL_HOST}/v1`, ALX_MODEL_CHAT_MODEL: 'fake-chat',
  ALX_MODEL_AUDIT_URL: `${MODEL_HOST}/v1`, ALX_MODEL_AUDIT_MODEL: 'fake-audit',
  ALX_MODEL_AUDIO_URL: `${MODEL_HOST}/v1`, ALX_MODEL_AUDIO_MODEL: 'fake-audio',
  ALX_MODEL_VOICE_URL: `${MODEL_HOST}/v1`, ALX_MODEL_VOICE_MODEL: 'fake-voice',
  ALX_MODEL_EXTRA_URL: `${MODEL_HOST}/v1`, ALX_MODEL_EXTRA_MODEL: 'fake-embed',
};
