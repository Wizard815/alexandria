// A booted app with a world, a DM, a player and a fake chat model, shared by the sculpt tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';

export const DM_SECRET = 'The harbour council secretly answers to the smuggler queen Velmira every single night';
export const cleanups: (() => void)[] = [];

export interface Model { calls: any[]; reply: (blank: any[], body: any) => any }
export const answerFor = (f: any, i = 0): unknown => {
  if (f.type === 'statblock') return { name: 'Bog Ghoul', ac: 12, hp: 30, speed: { walk: '30 ft.' }, abilities: { str: 14, dex: 12, con: 12, int: 6, wis: 10, cha: 6 }, actions: [{ name: 'Claw', text: 'Melee Attack Roll: +4. Hit: 7 (1d8+3) Slashing damage.' }] };
  if (f.type === 'select') return f.options?.[0] ?? '';
  if (f.type === 'list') return [`filled ${f.key} a${i}`, `filled ${f.key} b${i}`];
  if (f.type === 'rollTable') return Array.from({ length: f.rows ?? 6 }, (_x, n) => `filled row ${n + 1} of ${f.key}${i}`);
  if (f.type === 'table') return [['a', 'b'], ['c', 'd']];
  if (f.type === 'number') return 4;
  return `filled ${f.key}${i ? ` ${i}` : ''}`;
};

export async function boot(withModel: boolean, opts: { modelUp?: boolean } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-sculpt-'));
  const model: Model = { calls: [], reply: (blank, user) => (user.count > 1 ? { results: Array.from({ length: user.count }, (_x, i) => Object.fromEntries(blank.map((f: any) => [f.key, answerFor(f, i)]))) } : Object.fromEntries(blank.map((f: any) => [f.key, answerFor(f)]))) };
  const fake = (async (url: any, init?: any) => {
    if (String(url).startsWith('http://fake.test/v1/chat/completions')) {
      const body = JSON.parse(init.body);
      model.calls.push(body);
      const user = JSON.parse(body.messages[1].content);
      const out = model.reply(user.blank, user);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return fetch(url, init);
  }) as typeof fetch;
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), env: { ALX_ADMIN_TABLE_LOGIN: '1', ...(withModel ? { ALX_MODEL_CHAT_URL: 'http://fake.test/v1', ALX_MODEL_CHAT_MODEL: 'fake' } : {}) }, fetch: fake });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const call = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let json: any = t;
    try { json = JSON.parse(t); } catch { /* text */ }
    return { status: r.status, body: json };
  };
  const ok = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await call(method, url, token, body);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', undefined, { username: 'wizard', password: 'correct horse battery' })).token;
  const dm = await ok('POST', '/api/admin/accounts', T.admin, { username: 'dungeon', password: 'dm password 123' });
  T.dm = (await ok('POST', '/api/auth/login', undefined, { username: 'dungeon', password: 'dm password 123' })).token;
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Sculptland', dmAccountId: dm.account.id })).id;
  const inv = await ok('POST', `/api/worlds/${W}/invites`, T.dm, { role: 'player' });
  T.jess = (await ok('POST', '/api/join', undefined, { code: inv.code, username: 'jess', password: 'player pass 123', characterName: 'Jess' })).token;
  const page = (p: string, visibility: string, markdown: string) => ok('PUT', `/api/worlds/${W}/library/pages`, T.dm, { path: p, visibility, markdown });
  await page('places/Saltmarsh', 'party', `# Saltmarsh\nSaltmarsh is a fishing town of grey roofs and gulls.\n\n> [!secret] DM\n> ${DM_SECRET}.\n`);
  void opts;
  const S = `/api/worlds/${W}/sculpt`;
  return { made, model, T, W, S, call, ok, base };
}
export type Env = Awaited<ReturnType<typeof boot>>;
export const tplId = async (e: Env, name: string) => (await e.ok('GET', `${e.S}/templates`, e.T.dm)).templates.find((t: any) => t.name === name || t.key === name).id;
