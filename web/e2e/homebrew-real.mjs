// Homebrew rules with REAL models (OpenRouter): the Game Master adds "a weapon attack with your bonus action, at
// disadvantage" with the quick form, then the Game Master's assistant (Minerva), a player's table helper and the
// quick helper (Squire) are asked questions that never name the rule. Each must answer with the table's rule.
// The sheet roll button is checked too. No browser. Skipped unless ASSISTANT_REAL=1 (it spends a fraction of a cent).
// Run from web/:
//   NODE_USE_ENV_PROXY=1 ASSISTANT_REAL=1 node e2e/homebrew-real.mjs
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.ASSISTANT_REAL !== '1') { console.log('homebrew-real: skipped (set ASSISTANT_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const GM_MODEL = process.env.ASSISTANT_CHAT || 'tencent/hy4-flash';
const PLAYER_MODEL = process.env.ASSISTANT_PLAYER || GM_MODEL;
const CAP = Number(process.env.SPEND_CAP || 0.1);
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.ASSISTANT_REAL_PORT || 8217);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('homebrew-real'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
const wait = async (P, tok, chatId, text) => {
  await j('POST', `${P}/agent/chats/${chatId}/messages`, tok, { text });
  let c;
  for (let i = 0; i < 1200; i++) { c = (await j('GET', `${P}/agent/chats/${chatId}`, tok)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 250)); }
  return String(c.messages?.at(-1)?.text ?? '');
};
const RULE = /disadvantage/i;
try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  const pid = prov.provider?.id ?? prov.id;
  const job = (model) => ({ providerId: pid, model, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } });
  await j('PUT', '/api/admin/models', admin, { jobs: { chat: job(GM_MODEL), player: job(PLAYER_MODEL), helper: job(PLAYER_MODEL) } });
  const gm = (await j('POST', '/api/auth/login', null, { username: 'dm', password: 'dungeon master 123' })).x.token;
  const jess = (await j('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', gm)).x[0].id;
  const P = `/api/worlds/${WID}`;
  await j('PATCH', `${P}/settings`, gm, { agentPlayerHelper: true });
  const add = await j('POST', `${P}/mods/homebrew`, gm, { name: 'Bonus action strike', text: 'You can make one weapon attack with your bonus action, at disadvantage. You do not add your ability modifier to its damage.', });
  if (add.s >= 300) throw new Error('homebrew: ' + JSON.stringify(add.x));

  // Suggest extras: the assistant reads the saved mini-mod and proposes what could go with it.
  const sug = await j('POST', `${P}/mods/homebrew/hb-bonus-action-strike/suggest`, gm);
  console.log(`suggest extras (${GM_MODEL}): ${JSON.stringify(sug.x).slice(0, 500)}`);
  if (sug.x.source !== 'model') problems.push('Suggest extras did not use the model');
  const spent = async () => { const s = await usage(); return s !== null && spend0 !== null && s - spend0 > CAP; };
  // Minerva, with a question that never says "bonus action".
  let t0 = Date.now();
  const c = (await j('POST', `${P}/agent/chats`, gm, {})).x;
  const r1 = await wait(P, gm, c.id, 'Jessamine the fighter used her Attack action. Can she still swing her sword again this turn? Answer in two sentences.');
  console.log(`Minerva (${GM_MODEL}), ${Math.round((Date.now() - t0) / 1000)} s:\n  ${r1.replace(/\n/g, '\n  ').slice(0, 600)}`);
  if (!RULE.test(r1)) problems.push('Minerva did not use the homebrew rule');

  // The player's table helper.
  if (!(await spent())) {
    t0 = Date.now();
    const h = (await j('POST', `${P}/agent/chats`, jess, { mode: 'helper' })).x;
    const r2 = await wait(P, jess, h.id, 'What can I do with my bonus action? I am a fighter with one longsword and no spells.');
    console.log(`table helper (${PLAYER_MODEL}), ${Math.round((Date.now() - t0) / 1000)} s:\n  ${r2.replace(/\n/g, '\n  ').slice(0, 600)}`);
    if (!RULE.test(r2)) problems.push('the table helper did not use the homebrew rule');
  }

  // Squire, the quick helper.
  if (!(await spent())) {
    t0 = Date.now();
    const q = await j('POST', `${P}/helper/quick`, jess, { task: 'rules', question: 'Can I attack twice in one turn without Extra Attack?' });
    console.log(`Squire (${PLAYER_MODEL}), ${Math.round((Date.now() - t0) / 1000)} s: ${q.s} ${String(q.x.answer ?? JSON.stringify(q.x)).replace(/\n/g, ' ').slice(0, 400)}`);
    if (!RULE.test(String(q.x.answer ?? ''))) problems.push('Squire did not use the homebrew rule');
  }

  // The sheet button (added after the suggestion, as the Game Master would).
  const cur = (await j('GET', `${P}/mods`, gm)).x.mods.find((m) => m.id === 'hb-bonus-action-strike');
  await j('POST', `${P}/mods/homebrew`, gm, { id: cur.id, ...cur.form, roll: { label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage', places: ['sheet'], word: 'bastrike' } });
  await j('POST', `${P}/sessionchat/sessions/start`, gm, { title: 'Homebrew night' });
  const roll = await j('POST', `${P}/mods/hb-bonus-action-strike/rolls/roll`, jess, { bonus: 5 });
  console.log(`roll button: ${roll.s} ${roll.x.expr} = ${roll.x.total} · ${roll.x.note}`);
  if (roll.x.expr !== '2d20kl1+5') problems.push('the roll button did not roll at disadvantage');
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }
const spend1 = await usage();
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('homebrew-real ok');
