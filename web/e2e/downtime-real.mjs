// DownTime against REAL models (OpenRouter), over the API, no browser. The GM's assistant (Hy4 Flash) starts a
// Downtime round, takes time off a task and assigns one with a reward, each through an approval card; the player
// helper model (Bonsai 2 9B) ranks activities and rates a new one's tier, and answers a player's "what am I doing in
// my downtime" with the downtime tool. Skipped unless DOWNTIME_REAL=1 (it spends a few cents). Run from web/:
//   NODE_USE_ENV_PROXY=1 DOWNTIME_REAL=1 node e2e/downtime-real.mjs
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.DOWNTIME_REAL !== '1') { console.log('downtime-real: skipped (set DOWNTIME_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.DOWNTIME_KEY || 'sk-or-proxy';
const CHAT = process.env.DOWNTIME_CHAT || 'tencent/hy4-flash';
const PLAYER = process.env.DOWNTIME_PLAYER || 'prism-ml/ternary-bonsai-2-9b';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.DOWNTIME_REAL_PORT || 8222);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('downtime-real'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); console.log(`  ${ok ? 'ok ' : 'BAD'} ${msg}`); };
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  const pid = prov.provider?.id ?? prov.id;
  await j('PUT', '/api/admin/models', admin, { jobs: {
    chat: { providerId: pid, model: CHAT, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } },
    player: { providerId: pid, model: PLAYER, enabled: true, options: { reasoning: 'off', reasoningModel: false, contextTokens: 4096 } },
  } });
  const gm = (await j('POST', '/api/auth/login', null, { username: 'gm', password: 'game master 123' })).x.token;
  const jess = (await j('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', gm)).x[0].id;
  const P = `/api/worlds/${WID}`;
  await j('PUT', `${P}/mods/downtime/enabled`, gm, { on: true });
  const sh = (await j('POST', `${P}/downtime/tasks`, gm, { player: 'Tomas', activityId: 'pre-stronghold' })).x;
  await j('POST', `${P}/downtime/tasks/${sh.id}/work`, gm, { days: 10 });

  // ---- the GM's assistant (chat model) ----
  const chat = (await j('POST', `${P}/agent/chats`, gm, {})).x;
  const ask = async (tok, chatId, text) => {
    await j('POST', `${P}/agent/chats/${chatId}/messages`, tok, { text });
    let c;
    for (let i = 0; i < 800; i++) { c = (await j('GET', `${P}/agent/chats/${chatId}`, tok)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 150)); }
    return c;
  };
  const approveAll = async (c) => { for (const a of c.actions.filter((x) => x.status === 'pending')) { const r = await j('POST', `${P}/agent/actions/${a.id}`, gm, { decision: 'approve' }); console.log(`    ${a.tool} ${JSON.stringify(a.args)} -> ${r.x.status} ${String(r.x.result ?? '').slice(0, 160)}`); } return c.actions.filter((x) => x.status === 'pending').map((x) => x.tool); };
  const prompts = [
    ['Start a downtime round: 2 days resting in Saltmarsh.', 'downtime_round', async () => !!(await j('GET', `${P}/downtime/rounds/current`, gm)).x.round],
    ['Tomas lost two days on his stronghold to a fever, take them off.', 'downtime_time', async () => (await j('GET', `${P}/downtime/tasks?player=Tomas`, gm)).x.tasks.find((t) => t.name === 'Build a stronghold')?.doneMin === 8 * 8 * 60],
    ['Give Jessamine a rare downtime task: research the lighthouse keeper\'s past. Reward 20 gp when she finishes.', 'downtime_assign', async () => (await j('GET', `${P}/downtime/tasks?player=Jessamine`, gm)).x.tasks.some((t) => /lighthouse/i.test(t.name) && t.tier === 'rare' && t.reward?.cp === 2000)],
  ];
  let good = 0;
  for (const [text, tool, verify] of prompts) {
    const c = await ask(gm, chat.id, text);
    const tools = await approveAll(c);
    const ok = tools.includes(tool) && await verify();
    if (ok) good++;
    check(ok, `GM: "${text}" -> ${tools.join(', ') || 'no card'}${ok ? '' : ` · ${(c.messages?.at(-1)?.text ?? '').slice(0, 160)}`}`);
  }
  console.log(`GM assistant (${CHAT}): ${good}/${prompts.length}`);

  // ---- the player helper model: rank and decide ----
  const s = (await j('POST', `${P}/downtime/suggest`, jess, { want: 'I need money for a better bow' })).x;
  check(s.by === 'model' && s.picks?.length >= 1, `rank (${PLAYER}): ${s.by} -> ${(s.picks ?? []).map((p) => `${p.name} (${p.why})`).join(' | ')}`);
  const d1 = (await j('POST', `${P}/downtime/decide`, jess, { name: 'Forge a blade from dragon bone', summary: 'With the dwarven smith, using the bones we found' })).x;
  check(d1.by === 'model' && ['rare', 'very-rare', 'legendary'].includes(d1.tier), `decide: dragon-bone blade -> ${d1.tier}, ${d1.days} days, ${d1.hoursPerDay}h (${d1.why})`);
  const d2 = (await j('POST', `${P}/downtime/decide`, jess, { name: 'Sweep the tavern floor', summary: 'For a free meal' })).x;
  check(d2.by === 'model' && ['common', 'uncommon'].includes(d2.tier), `decide: sweep the tavern -> ${d2.tier}, ${d2.days} days (${d2.why})`);
  const d3 = (await j('POST', `${P}/downtime/decide`, jess, { name: 'Pray at dawn every day for three months', summary: 'A vow to the sea goddess' })).x;
  check(d3.by === 'model' && d3.hoursPerDay <= 2, `decide: daily vow -> ${d3.tier}, ${d3.days} days, ${d3.hoursPerDay}h a day (${d3.why})`);

  // ---- a player asks their helper (player job) ----
  const pc = (await j('POST', `${P}/agent/chats`, jess, {})).x;
  const pa = await ask(jess, pc.id, 'What am I working on in my downtime, and how long is left?');
  const reply = pa.messages?.at(-1)?.text ?? '';
  check(/lighthouse/i.test(reply), `player helper: "${reply.replace(/\s+/g, ' ').slice(0, 200)}"`);
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }
const spend1 = await usage();
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('downtime-real ok');
