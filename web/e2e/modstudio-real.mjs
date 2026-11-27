// The Mod studio against a REAL chat model (OpenRouter): the GM asks the assistant for each kind of house rule in
// plain words (counters, a whole data system, a copy of a built-in rule) and it must read the guide, check the file
// until it has no errors, and propose saving it. Approving the card saves the rule; then it is turned on, so the rule
// really works here. No browser. Skipped unless ASSISTANT_REAL=1 (it spends a few cents). Run from web/:
//   NODE_USE_ENV_PROXY=1 ASSISTANT_REAL=1 node e2e/modstudio-real.mjs
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.ASSISTANT_REAL !== '1') { console.log('modstudio-real: skipped (set ASSISTANT_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const CHAT = process.env.ASSISTANT_CHAT || 'tencent/hy4-flash';
const CAP = Number(process.env.SPEND_CAP || 0.2);
const ONLY = process.env.ONLY || '';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.ASSISTANT_REAL_PORT || 8214);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('modstudio-real'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };

const ASKS = [
  { kind: 'counters', text: 'Make a house rule for my table: luck points. Each player starts a session with 1 luck point and can hold at most 2. A player spends one to reroll their own latest roll. I can give one for good roleplay with a reason.',
    want: (f) => f.resources?.length >= 1 && f.actions?.some((a) => a.by === 'dm') && f.actions?.some((a) => a.by === 'owner') },
  { kind: 'data', text: 'Make a house rule for my table: crafting projects. A player starts a project with a name and how many days it needs. Each long rest adds 1 day to every open project, and when the days are in it is done and posts to chat. I can add or take days. Show the projects on a GM tab and on the player sheet.',
    want: (f) => f.records && Object.keys(f.records).length >= 1 && f.recordActions?.length >= 2 && f.timers?.length >= 1 && f.views?.length >= 1 },
  { kind: 'downtime', text: 'Make a house rule for my table called Downtime. There are ready-made downtime activities by tier, common to legendary, each taking days (common 1 day, uncommon 3, rare 7, very rare 30, legendary 90), and players can add new ones. When a day passes in session I press a Downtime button and every player gets a popup: keep working, start an activity, or skip. I can add or take days and drop a task. A task is done when its days are in.',
    want: (f) => f.records && Object.keys(f.records).length >= 2 && f.prompts?.length >= 1 && f.timers?.some((t) => String(t.on).startsWith('prompt:')) },
  { kind: 'copy', text: 'Make a house rule for my table: inspiration as rerolls, but each player can hold up to 3 of each kind. Base it on the inspiration-rerolls rule that comes with Alexandria, as a copy with its own id.',
    want: (f) => f.resources?.length >= 1 && f.id !== 'inspiration-rerolls' },
].filter((a) => !ONLY || ONLY.split(',').includes(a.kind));

try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  const pid = prov.provider?.id ?? prov.id;
  await j('PUT', '/api/admin/models', admin, { jobs: { chat: { providerId: pid, model: CHAT, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } } } });
  const tok = (await j('POST', '/api/auth/login', null, { username: 'dm', password: 'game master 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', tok)).x[0].id;
  const P = `/api/worlds/${WID}`;
  const before = new Set(((await j('GET', `${P}/mods`, tok)).x.mods ?? []).map((m) => m.id));
  for (const ask of ASKS) {
    const s = await usage();
    if (s !== null && spend0 !== null && s - spend0 > CAP) { problems.push(`stopped before ${ask.kind}: spend passed $${CAP}`); break; }
    const chat = (await j('POST', `${P}/agent/chats`, tok, {})).x;
    const t0 = Date.now();
    const turn = async (text) => {
      await j('POST', `${P}/agent/chats/${chat.id}/messages`, tok, { text });
      let c;
      for (let i = 0; i < 1200; i++) { c = (await j('GET', `${P}/agent/chats/${chat.id}`, tok)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 250)); }
      return c;
    };
    const pending = (c) => (c.actions ?? []).filter((a) => a.status === 'pending' && a.tool === 'house_rule_save');
    let c = await turn(ask.text);
    if (!pending(c).length) c = await turn('That looks right. Save it.');
    const saves = pending(c);
    console.log(`${ask.kind}: ${Math.round((Date.now() - t0) / 1000)} s, ${saves.length} save card(s)`);
    if (process.env.DUMP) {
      const th = (await j('GET', `${P}/active/thoughts?limit=40`, tok)).x.thoughts ?? [];
      for (const t of th.filter((x) => x.chatId === chat.id)) console.log(`   [${t.kind}] ${t.text}${t.detail ? `\n      ${String(t.detail).slice(0, 1500)}` : ''}`);
      console.log(`   reply: ${String(c.messages?.at(-1)?.text ?? '').slice(0, 600)}`);
    }
    if (!saves.length) { problems.push(`${ask.kind}: no save card. Last reply: ${JSON.stringify(c.messages?.at(-1) ?? c).slice(0, 400)}`); continue; }
    const r = await j('POST', `${P}/agent/actions/${saves[0].id}`, tok, { decision: 'approve' });
    if (r.x.status !== 'done') { problems.push(`${ask.kind}: save ended ${r.x.status} ${JSON.stringify(r.x).slice(0, 300)}`); continue; }
    const now = (await j('GET', `${P}/mods`, tok)).x.mods ?? [];
    const added = now.filter((m) => !before.has(m.id));
    for (const m of added) before.add(m.id);
    if (!added.length) { problems.push(`${ask.kind}: approved, but no new rule`); continue; }
    const m = added[0];
    const f = (await j('GET', `${P}/mods/${m.id}/file`, tok)).x.file;
    const preview = (await j('POST', `${P}/mods/check`, tok, { mod: { ...f, id: `${m.id}-x` } })).x.preview ?? [];
    console.log(`  saved ${m.id} (${m.name}):\n${preview.map((l) => '    - ' + l).join('\n')}`);
    if (!ask.want(f)) problems.push(`${ask.kind}: the saved rule ${m.id} does not have the parts asked for`);
    const on = await j('PUT', `${P}/mods/${m.id}/enabled`, tok, { on: true, cascade: true });
    if (on.s >= 300) problems.push(`${ask.kind}: could not turn ${m.id} on: ${JSON.stringify(on.x).slice(0, 200)}`);
  }
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }
const spend1 = await usage();
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('modstudio-real ok');
