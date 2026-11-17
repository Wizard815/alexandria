// Shared setup for the audit-*.test.ts files: one app, two worlds (each with a DM),
// players jess and tom and a guest in world A, a player in world B, and small helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';

export interface Res { status: number; body: any; text: string; headers: Headers }

export async function boot(opts: { fetch?: typeof fetch; env?: Record<string, string>; settings?: Record<string, unknown> } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alx-audit-'));
  const made = createApp({ noScheduler: true, dataDir: path.join(tmp, 'data'), vaultsDir: path.join(tmp, 'vaults'), fetch: opts.fetch, env: { ALX_ADMIN_TABLE_LOGIN: '1', ALX_RATE_LIMIT: '0', ...(opts.env ?? {}) } });
  const server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const deps = made.deps;
  async function call(method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body: json, text, headers: r.headers };
  }
  async function ok(method: string, url: string, token?: string | null, body?: unknown, headers?: Record<string, string>) {
    const r = await call(method, url, token, body, headers);
    assert.ok(r.status < 300, `${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}`);
    return r.body;
  }
  const T: Record<string, string> = {};
  const ID: Record<string, string> = {};
  T.admin = (await ok('POST', '/api/setup', null, { username: 'wizard', password: 'correct horse battery' })).token;
  for (const [k, name] of [['dm', 'dungeon'], ['dm2', 'dungeon2']] as const) {
    ID[k] = (await ok('POST', '/api/admin/accounts', T.admin, { username: name, password: 'dm password 123' })).account.id;
    T[k] = (await ok('POST', '/api/auth/login', null, { username: name, password: 'dm password 123' })).token;
  }
  const W = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Harbourtown', dmAccountId: ID.dm })).id as string;
  const W2 = (await ok('POST', '/api/admin/worlds', T.admin, { name: 'Elsewhere', dmAccountId: ID.dm2 })).id as string;
  const join = async (world: string, dm: string, role: string, name: string) => {
    const inv = await ok('POST', `/api/worlds/${world}/invites`, T[dm], { role });
    const j = await ok('POST', '/api/join', null, { code: inv.code, username: name, password: 'player pass 123', characterName: name });
    T[name] = j.token; ID[name] = j.account.id;
  };
  await join(W, 'dm', 'player', 'jess');
  await join(W, 'dm', 'player', 'tom');
  await join(W, 'dm', 'guest', 'visitor');
  await join(W2, 'dm2', 'player', 'wendy');
  if (opts.settings) await ok('PATCH', `/api/worlds/${W}/settings`, T.dm, opts.settings);
  const w = (p: string) => `/api/worlds/${W}${p}`;
  const w2 = (p: string) => `/api/worlds/${W2}${p}`;
  const close = () => { server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { call, ok, T, ID, W, W2, w, w2, deps, base, close, tmp, app: made.app };
}
export type Kit = Awaited<ReturnType<typeof boot>>;
