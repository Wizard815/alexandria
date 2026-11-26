// The DM assistant pulls a free book from Open5e with a REAL chat model (OpenRouter) and the real Open5e API:
// the DM asks in plain words, the model proposes import_content, the DM approves, and the book's monsters
// are in the world. No browser. Skipped unless CONTENT_REAL=1 (it spends about a cent). Run from web/:
//   NODE_USE_ENV_PROXY=1 CONTENT_REAL=1 node e2e/content-real.mjs
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.CONTENT_REAL !== '1') { console.log('content-real: skipped (set CONTENT_REAL=1; it calls a paid model and Open5e)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.CONTENT_KEY || 'sk-or-proxy';
const CHAT = process.env.CONTENT_CHAT || 'tencent/hy4-flash';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.CONTENT_REAL_PORT || 8214);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('content-real'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  await j('PUT', '/api/admin/models', admin, { jobs: { chat: { providerId: prov.provider?.id ?? prov.id, model: CHAT, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } } } });
  const tok = (await j('POST', '/api/auth/login', null, { username: 'dm', password: 'dungeon master 123' })).x.token;
  const P = `/api/worlds/${(await j('GET', '/api/worlds', tok)).x[0].id}`;
  const chat = (await j('POST', `${P}/agent/chats`, tok, {})).x;
  const ask = async (text) => {
    await j('POST', `${P}/agent/chats/${chat.id}/messages`, tok, { text });
    let c;
    for (let i = 0; i < 1200; i++) { c = (await j('GET', `${P}/agent/chats/${chat.id}`, tok)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 150)); }
    return c;
  };
  const c = await ask('Pull the monsters from the Tome of Beasts on Open5e into this world, monsters only.');
  const act = c.actions.find((a) => a.tool === 'import_content' && a.status === 'pending');
  console.log('proposed:', act ? JSON.stringify(act.args) : `none (${c.actions.map((a) => a.tool).join(', ') || 'no actions'})`);
  if (!act) problems.push('the model did not propose import_content');
  else {
    if (!(act.args.books ?? []).includes('tob')) problems.push(`books were ${JSON.stringify(act.args.books)}, not tob`);
    // A slow download answers "running" first and finishes by itself; wait for it.
    let done = (await j('POST', `${P}/agent/actions/${act.id}`, tok, { decision: 'approve' })).x;
    for (let i = 0; i < 240 && done.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 500)); done = (await j('GET', `${P}/agent/chats/${chat.id}`, tok)).x.actions.find((a) => a.id === act.id) ?? done; }
    if (done.status !== 'done') problems.push(`approval: ${done.status} ${JSON.stringify(done.error ?? done.result ?? '').slice(0, 400)}`);
    const t = (await j('GET', `${P}/modules/terms?q=nihilethic&kind=monster`, tok)).x.terms ?? [];
    console.log('found after import:', t.map((x) => `${x.term} (${x.module})`).join(', '));
    if (!t.length) problems.push('no Tome of Beasts monster after the import');
  }
} finally { srv.kill(); }
const spend1 = await usage();
if (spend0 !== null && spend1 !== null) console.log(`spent about $${(spend1 - spend0).toFixed(4)}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('content-real: ok');
