// A short run of the GM assistant against a REAL chat model (OpenRouter), over the API: ask for changes, see the
// approval cards, approve them back to back and time it, then switch Auto on and ask again. No browser.
// Skipped unless ASSISTANT_REAL=1 and OpenRouter answers (it spends a few cents). Run from web/:
//   NODE_USE_ENV_PROXY=1 ASSISTANT_REAL=1 node e2e/assistant-real.mjs
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.ASSISTANT_REAL !== '1') { console.log('assistant-real: skipped (set ASSISTANT_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const CHAT = process.env.ASSISTANT_CHAT || 'tencent/hy4-flash';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.ASSISTANT_REAL_PORT || 8212);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('assistant-real'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const j = async (m, p, tok, b) => { const t0 = performance.now(); const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})), ms: Math.round(performance.now() - t0) }; };
try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  const pid = prov.provider?.id ?? prov.id;
  await j('PUT', '/api/admin/models', admin, { jobs: { chat: { providerId: pid, model: CHAT, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } } } });
  const tok = (await j('POST', '/api/auth/login', null, { username: 'gm', password: 'game master 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', tok)).x[0].id;
  const P = `/api/worlds/${WID}`;
  const chat = (await j('POST', `${P}/agent/chats`, tok, {})).x;
  const ask = async (text) => {
    const t0 = Date.now();
    await j('POST', `${P}/agent/chats/${chat.id}/messages`, tok, { text });
    let firstCard = null, c;
    for (let i = 0; i < 600; i++) {
      c = (await j('GET', `${P}/agent/chats/${chat.id}`, tok)).x;
      if (firstCard === null && c.actions.some((a) => a.status === 'pending')) firstCard = Date.now() - t0;
      if (!c.busy) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return { c, firstCard, total: Date.now() - t0 };
  };
  const a = await ask('Add two goblins to the combat: Snik with 7 HP and Snak with 7 HP.');
  const waiting = a.c.actions.filter((x) => x.status === 'pending');
  console.log(`ask 1: first card after ${a.firstCard} ms, reply finished after ${a.total} ms, ${waiting.length} card(s): ${waiting.map((x) => x.summary).join(' | ')}`);
  if (waiting.length < 1) problems.push('the real model proposed no card');
  for (const w of waiting) {
    const r = await j('POST', `${P}/agent/actions/${w.id}`, tok, { decision: 'approve' });
    console.log(`  approve ${w.tool}: HTTP ${r.s} in ${r.ms} ms -> ${r.x.status}`);
    if (r.ms > 1000 || r.x.status !== 'done') problems.push(`approve of ${w.tool} took ${r.ms} ms, ended ${r.x.status}`);
  }
  await j('PATCH', `${P}/settings`, tok, { agentAuto: true });
  const b = await ask('Add one more goblin to the combat called Snek with 7 HP.');
  const autos = b.c.actions.filter((x) => x.auto);
  console.log(`ask 2 (Auto): finished after ${b.total} ms, ${autos.length} applied automatically, ${b.c.actions.filter((x) => x.status === 'pending').length} waiting`);
  if (!autos.length) problems.push('Auto mode applied nothing');
  const names = ((await j('GET', `${P}/live/combat`, tok)).x.combatants ?? []).map((x) => x.name);
  console.log('  combatants:', names.join(', '));
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }
const spend1 = await usage();
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('assistant-real ok');
