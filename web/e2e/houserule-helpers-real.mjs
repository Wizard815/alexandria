// House rules with REAL models (OpenRouter): a downtime rule is on, a player's table helper (the small player model)
// is asked what to do for downtime, and the GM's assistant is told a day passes. The helper must suggest real
// activities from the rule's list; the GM's assistant must propose opening the rule's Downtime prompt. No browser.
// Skipped unless ASSISTANT_REAL=1 (it spends a fraction of a cent). Run from web/:
//   NODE_USE_ENV_PROXY=1 ASSISTANT_REAL=1 node e2e/houserule-helpers-real.mjs
import fs from 'node:fs';
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.ASSISTANT_REAL !== '1') { console.log('houserule-helpers-real: skipped (set ASSISTANT_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const GM_MODEL = process.env.ASSISTANT_CHAT || 'tencent/hy4-flash';
const PLAYER_MODEL = process.env.ASSISTANT_PLAYER || 'prism-ml/ternary-bonsai-2-9b';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.ASSISTANT_REAL_PORT || 8216);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('houserule-helpers'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
const wait = async (P, tok, chatId, text) => {
  await j('POST', `${P}/agent/chats/${chatId}/messages`, tok, { text });
  let c;
  for (let i = 0; i < 1200; i++) { c = (await j('GET', `${P}/agent/chats/${chatId}`, tok)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 250)); }
  return c;
};
try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  const pid = prov.provider?.id ?? prov.id;
  await j('PUT', '/api/admin/models', admin, { jobs: {
    chat: { providerId: pid, model: GM_MODEL, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } },
    player: { providerId: pid, model: PLAYER_MODEL, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } },
  } });
  const gm = (await j('POST', '/api/auth/login', null, { username: 'gm', password: 'game master 123' })).x.token;
  const jess = (await j('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', gm)).x[0].id;
  const P = `/api/worlds/${WID}`;
  await j('PATCH', `${P}/settings`, gm, { agentPlayerHelper: true });
  const file = JSON.parse(fs.readFileSync(path.join(root, 'mods/examples/downtime-lite.alxmod.json'), 'utf8'));
  const imp = await j('POST', `${P}/mods/import`, gm, { mod: file });
  if (imp.s >= 300) throw new Error('import: ' + JSON.stringify(imp.x));
  await j('PUT', `${P}/mods/downtime-lite/enabled`, gm, { on: true });

  // The player's helper.
  const h = (await j('POST', `${P}/agent/chats`, jess, { mode: 'helper' })).x;
  let t0 = Date.now();
  const hc = await wait(P, jess, h.id, 'What should I do for downtime? I want to earn some gold or meet useful people.');
  const reply = String(hc.messages?.at(-1)?.text ?? '');
  console.log(`helper (${PLAYER_MODEL}), ${Math.round((Date.now() - t0) / 1000)} s:\n  ${reply.replace(/\n/g, '\n  ').slice(0, 900)}`);
  if (!/work a trade|carouse/i.test(reply)) problems.push('the helper did not suggest an activity from the rule');
  if (/open the Downtime day prompt|house_rule_prompt/i.test(reply)) problems.push("the helper repeated the GM's guidance");

  // The GM's assistant.
  const c = (await j('POST', `${P}/agent/chats`, gm, {})).x;
  t0 = Date.now();
  const dc = await wait(P, gm, c.id, 'A day passes between adventures. Run downtime for the party.');
  const cards = (dc.actions ?? []).filter((a) => a.status === 'pending' || a.status === 'done');
  console.log(`GM assistant (${GM_MODEL}), ${Math.round((Date.now() - t0) / 1000)} s: ${cards.map((a) => `${a.tool} ${a.status} (${a.summary})`).join(' | ') || 'no cards'}\n  ${String(dc.messages?.at(-1)?.text ?? '').slice(0, 400)}`);
  const card = cards.find((a) => a.tool === 'house_rule_prompt');
  if (!card) problems.push('the GM assistant did not propose the Downtime prompt');
  else if (card.status === 'pending') {
    const r = await j('POST', `${P}/agent/actions/${card.id}`, gm, { decision: 'approve' });
    if (r.x.status !== 'done') problems.push(`approving the prompt ended ${r.x.status}`);
    const open = (await j('GET', `${P}/mods/prompts/open`, jess)).x;
    console.log(`  approved: Jess sees ${(open.rounds ?? open.prompts ?? []).length} open prompt(s)`);
    if (!(open.rounds ?? open.prompts ?? []).length) problems.push('no open prompt for the player after approval');
  }

  // The table rules that ship in mods/: a rules-only one reaches the helper, a data one reaches the GM.
  for (const id of ['potion-bonus-action', 'lingering-injuries']) await j('PUT', `${P}/mods/${id}/enabled`, gm, { on: true, cascade: true });
  const h2 = (await j('POST', `${P}/agent/chats`, jess, { mode: 'helper' })).x;
  const pc = await wait(P, jess, h2.id, 'Can I drink a healing potion and still attack this turn?');
  const pr = String(pc.messages?.at(-1)?.text ?? '');
  console.log(`helper on potions: ${pr.replace(/\n/g, ' ').slice(0, 300)}`);
  if (!/bonus action/i.test(pr)) problems.push('the helper did not know potions are a bonus action here');
  const c2 = (await j('POST', `${P}/agent/chats`, gm, {})).x;
  const ic = await wait(P, gm, c2.id, 'Jessamine just took a critical hit to the chest. Give her a lingering injury that fits.');
  const inj = (ic.actions ?? []).find((a) => a.tool === 'house_rule_record_act');
  console.log(`GM on injuries: ${inj ? `${inj.status} (${inj.summary})` : 'no card'} / ${String(ic.messages?.at(-1)?.text ?? '').slice(0, 200)}`);
  if (!inj) problems.push('the GM assistant did not propose an injury');
  else if (inj.status === 'pending') {
    const r = await j('POST', `${P}/agent/actions/${inj.id}`, gm, { decision: 'approve' });
    const mine = (await j('GET', `${P}/mods/lingering-injuries/records?kind=injury`, jess)).x.records?.injury ?? [];
    console.log(`  approved -> ${r.x.status}; Jess has ${mine.length} injur${mine.length === 1 ? 'y' : 'ies'}: ${mine.map((x) => `${x.name} (${x.effect}, ${x.days} days)`).join('; ')}`);
    if (r.x.status !== 'done' || !mine.length) problems.push('the injury did not land on Jess');
  }
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }
const spend1 = await usage();
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('houserule-helpers-real ok');
