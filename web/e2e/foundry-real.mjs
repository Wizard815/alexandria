// The GM assistant drives the Foundry connection with a REAL chat model (OpenRouter, Hy4 Flash by default): it reads
// the connection, moves a token (approved like any change) and posts a chat line, against a stand-in Foundry world
// running the real module. Skipped unless FOUNDRY_REAL=1 (it spends a few cents). Run from web/:
//   NODE_USE_ENV_PROXY=1 FOUNDRY_REAL=1 node e2e/foundry-real.mjs
import path from 'node:path';
import zlib from 'node:zlib';
import { root, startScript, tmpDir } from './lib.mjs';
import { foundryWorld } from './foundry-world.mjs';

if (process.env.FOUNDRY_REAL !== '1') { console.log('foundry-real: skipped (set FOUNDRY_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const CHAT = process.env.ASSISTANT_CHAT || 'tencent/hy4-flash';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.FOUNDRY_REAL_PORT || 8213);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('foundry-real'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A plain PNG for the scene. */
function png(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
  const raw = Buffer.alloc((w + 1) * h, 0x90); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let fd = null;
try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  await j('PUT', '/api/admin/models', admin, { jobs: { chat: { providerId: prov.provider?.id ?? prov.id, model: CHAT, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } } } });
  const tok = (await j('POST', '/api/auth/login', null, { username: 'dm', password: 'game master 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', tok)).x[0].id;
  const P = `/api/worlds/${WID}`;
  const key = (await j('POST', `${P}/foundry/key`, tok, {})).x.key;
  fd = foundryWorld(base, key, png(160, 100));
  await fd.start();
  const keepId = fd.keep.id;
  await j('POST', `${P}/foundry/scenes/${keepId}/import`, tok, {});
  for (let i = 0; i < 40; i++) { if ((await j('GET', `${P}/foundry`, tok)).x.scenes?.find((s) => s.id === keepId)?.tokens.length === 3) break; await wait(250); }

  const chat = (await j('POST', `${P}/agent/chats`, tok, {})).x;
  const ask = async (text) => {
    await j('POST', `${P}/agent/chats/${chat.id}/messages`, tok, { text });
    let c;
    for (let i = 0; i < 600; i++) { c = (await j('GET', `${P}/agent/chats/${chat.id}`, tok)).x; if (!c.busy) break; await wait(200); }
    return c;
  };
  const reply = (c) => { const m = [...(c.messages ?? [])].reverse().find((x) => x.role === 'assistant'); return String(m?.text ?? m?.body ?? m?.content ?? ''); };

  let c = await ask('Is Foundry connected? Which tokens are on the Sunken Keep scene?');
  console.log('ask 1:', reply(c).slice(0, 300).replace(/\s+/g, ' '));
  if (!/goblin/i.test(reply(c))) problems.push('the answer did not list the Goblin boss token');

  const gx = fd.gt.x;
  c = await ask('In Foundry, move the Goblin boss token to the middle of the map (x 50, y 50).');
  let waiting = c.actions.filter((x) => x.status === 'pending');
  console.log('ask 2 cards:', waiting.map((x) => `${x.tool} ${JSON.stringify(x.args)}`).join(' | ') || reply(c).slice(0, 200));
  const mv = waiting.find((x) => x.tool === 'foundry_move_token');
  if (!mv) problems.push('no foundry_move_token card');
  else {
    const r = await j('POST', `${P}/agent/actions/${mv.id}`, tok, { decision: 'approve' });
    if (r.x.status !== 'done') problems.push(`move ended ${r.x.status}: ${r.x.result}`);
    for (let i = 0; i < 20 && fd.gt.x === gx; i++) await wait(250);
    console.log(`  goblin in Foundry: x ${gx} -> ${fd.gt.x}`);
    if (fd.gt.x === gx) problems.push('the goblin did not move in Foundry');
  }

  c = await ask('Post this in the Foundry chat as the Bellringer: "The bell tolls twice."');
  waiting = c.actions.filter((x) => x.status === 'pending' && x.tool === 'foundry_say');
  console.log('ask 3 cards:', waiting.map((x) => `${x.tool} ${JSON.stringify(x.args)}`).join(' | ') || reply(c).slice(0, 200));
  if (!waiting.length) problems.push('no foundry_say card');
  else {
    await j('POST', `${P}/agent/actions/${waiting[0].id}`, tok, { decision: 'approve' });
    for (let i = 0; i < 20 && !fd.fv.chat.some((m) => /bell tolls/i.test(m.content)); i++) await wait(250);
    const said = fd.fv.chat.find((m) => /bell tolls/i.test(m.content));
    console.log('  Foundry chat:', said ? `${said.speaker?.alias}: ${said.content}` : 'nothing');
    if (!said) problems.push('nothing said in Foundry');
  }
} catch (e) { problems.push('run failed: ' + (e.stack ?? e.message)); } finally { fd?.stop(); srv.kill(); }
const spend1 = await usage();
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('foundry-real ok');
