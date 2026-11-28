// New things piling up, with REAL models (OpenRouter): over four "sessions" the GM adds a house rule nobody has seen
// before (no assistant part, as a downloaded or hand-made file would be), a custom item, and a templates pack, each
// with most of the shipped house rules already on. After each one, a fresh chat with the GM's assistant and with a
// player's table helper (the small player model) must use the new thing; the last session asks for all three at once
// and asks the assistant what is new. No browser. Skipped unless ASSISTANT_REAL=1 (it spends about a cent). From web/:
//   NODE_USE_ENV_PROXY=1 ASSISTANT_REAL=1 node e2e/buildup-real.mjs
import fs from 'node:fs';
import path from 'node:path';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.ASSISTANT_REAL !== '1') { console.log('buildup-real: skipped (set ASSISTANT_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const GM_MODEL = process.env.ASSISTANT_CHAT || 'tencent/hy4-flash';
const PLAYER_MODEL = process.env.ASSISTANT_PLAYER || 'prism-ml/ternary-bonsai-2-9b';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.ASSISTANT_REAL_PORT || 8217);
const base = `http://127.0.0.1:${PORT}`;
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('buildup'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const problems = [];
const results = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };
const ask = async (P, tok, chatId, text) => {
  await j('POST', `${P}/agent/chats/${chatId}/messages`, tok, { text });
  let c;
  for (let i = 0; i < 1200; i++) { c = (await j('GET', `${P}/agent/chats/${chatId}`, tok)).x; if (!c.busy) break; await new Promise((r) => setTimeout(r, 250)); }
  return c;
};
const last = (c) => String(c.messages?.at(-1)?.text ?? '');
const cards = (c) => (c.actions ?? []).filter((a) => a.status === 'pending' || a.status === 'done');
const check = (name, ok, detail) => { results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ''}`); };
const show = (who, c) => console.log(`  ${who}: ${cards(c).map((a) => `[${a.tool} ${a.status}: ${String(a.summary ?? '').slice(0, 90)}]`).join(' ')} ${last(c).replace(/\s+/g, ' ').slice(0, 420)}`);

// A house rule the models have never seen, with no assistant part: everything they get comes from the file itself.
const CORRUPTION = {
  kit: 2, id: 'shrine-corruption', name: 'Shrine corruption', version: '1.0.0', author: 'A GM', summary: 'The drowned shrine marks those who listen to it.',
  alexandria: '>=0.1',
  resources: [{ id: 'corruption', label: 'Corruption', icon: 'fa-skull', max: 5, start: 0 }],
  actions: [
    { id: 'mark', label: 'Mark', by: 'gm', resource: 'corruption', add: 1, askReason: true },
    { id: 'cleanse', label: 'Cleanse', by: 'gm', resource: 'corruption', add: -1, askReason: true },
  ],
  rules: [{ term: 'Corruption (house rule)', text: 'The drowned shrine gives **corruption** (0 to 5). At **3 or more** you have disadvantage on Wisdom saving throws. At **5** the shrine claims you and the GM takes your character for one scene. A long rest in holy ground removes one.' }],
};
const LANTERN = { name: 'Emberglass Lantern', type: 'wondrous item', rarity: 'uncommon', cost: '350 gp', description: 'A lantern of smoky red glass. Its light shows invisible undead within 30 feet as faint embers, and once per day it can flare to deal 2d6 radiant damage to one undead you can see.', properties: 'Light 30 ft; flare 1/day 2d6 radiant vs undead', gmNotes: 'Made by the shrine priests before the flood.' };
const PACK = {
  type: 'alexandria-templates', version: 1, name: 'Haunted places', exported: '2026-11-27T00:00:00.000Z', alexandria: '0.1.0',
  templates: [{
    kind: 'guide', name: 'Haunted inns', description: 'An inn with a ghost that wants something.', triggers: ['haunted inn'], enabled: true,
    spec: {
      task: 'Make a haunted inn', instructions: 'Every haunted inn has a ghost with unfinished business, a keeper who hides it, and a room nobody rents. Give the ghost a want the party can resolve.',
      steps: [{ kind: 'instruction', text: 'Write the page with exactly the sections below; the ghost\'s secret goes in a GM-only callout.' }],
      sections: ['Overview', 'The keeper', 'The room nobody rents', 'Unfinished business'], tone: 'Quiet dread, small details.', folder: 'Places/Inns', exemplars: [],
    },
  }],
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
  const gmChat = async () => (await j('POST', `${P}/agent/chats`, gm, {})).x.id;
  const helper = async () => (await j('POST', `${P}/agent/chats`, jess, { mode: 'helper' })).x.id;
  const approve = async (a) => (a?.status === 'pending' ? (await j('POST', `${P}/agent/actions/${a.id}`, gm, { decision: 'approve' })).x.status : a?.status);

  // A busy world: the table rules that ship in mods/ are on (not the magic modes or the big systems).
  const shipped = (await j('GET', `${P}/mods`, gm)).x.mods ?? [];
  const skip = /spell-points|mana|open5e|downtime|spell-crafting/;
  let on = 0;
  for (const m of shipped) { if (skip.test(m.id)) continue; const r = await j('PUT', `${P}/mods/${m.id}/enabled`, gm, { on: true, cascade: true }); if (r.s < 300) on++; }
  console.log(`busy world: ${on} shipped house rules on`);

  // Session 1: a new house rule.
  console.log('session 1: a new house rule (Shrine corruption)');
  const imp = await j('POST', `${P}/mods/import`, gm, { mod: CORRUPTION });
  if (imp.s >= 300) throw new Error('import: ' + JSON.stringify(imp.x));
  await j('PUT', `${P}/mods/shrine-corruption/enabled`, gm, { on: true });
  let c = await ask(P, gm, await gmChat(), "The shrine's whispers got into Jessamine's head. Mark her with a point of corruption.");
  show('GM', c);
  const mark = cards(c).find((a) => a.tool === 'house_rule_grant' && JSON.stringify(a.args ?? a.summary ?? '').includes('shrine-corruption'));
  check('1 GM: grants corruption with the new rule', !!mark, cards(c).map((a) => a.tool).join(', ') || 'no cards');
  if (mark) check('1 GM: the grant runs', (await approve(mark)) === 'done');
  c = await ask(P, jess, await helper(), 'What happens to me if my corruption keeps going up?');
  show('helper', c);
  check('1 helper: explains the new rule', /disadvantage|wisdom/i.test(last(c)) && /\b(3|three|5|five)\b/i.test(last(c)), last(c).slice(0, 160));

  // Session 2: a new item in the item database.
  console.log('session 2: a new item (Emberglass Lantern)');
  const it = await j('POST', `${P}/shop/items`, gm, LANTERN);
  if (it.s >= 300) throw new Error('item: ' + JSON.stringify(it.x));
  c = await ask(P, gm, await gmChat(), 'What does the Emberglass Lantern do, and what is it worth?');
  show('GM', c);
  check('2 GM: knows the new item', /undead/i.test(last(c)) && /350/.test(last(c)), last(c).slice(0, 160));
  c = await ask(P, gm, await gmChat(), 'Give Jessamine an Emberglass Lantern. She found it in the flooded crypt.');
  show('GM', c);
  const give = cards(c).find((a) => a.tool === 'add_item');
  check('2 GM: gives the item', !!give, cards(c).map((a) => a.tool).join(', ') || 'no cards');
  if (give) check('2 GM: the give runs', (await approve(give)) === 'done');
  c = await ask(P, jess, await helper(), 'What does my Emberglass Lantern do?');
  show('helper', c);
  check('2 helper: explains the item she holds', /undead/i.test(last(c)) && /radiant|ember|invisible/i.test(last(c)), last(c).slice(0, 160));

  // Session 3: a templates pack.
  console.log('session 3: a templates pack (Haunted inns guide)');
  const tp = await j('POST', `${P}/templates/import`, gm, PACK);
  if (tp.s >= 300) throw new Error('templates: ' + JSON.stringify(tp.x));
  c = await ask(P, gm, await gmChat(), 'Make a haunted inn on the road to Saltmere for next session.');
  show('GM', c);
  const usedGuide = (c.messages ?? []).some((m) => JSON.stringify(m.guides ?? []).includes('Haunted inns'));
  check('3 GM: follows the new guide', usedGuide);
  const page = cards(c).find((a) => a.tool === 'save_page' || a.tool === 'create_page');
  const pageText = JSON.stringify(page?.args ?? page ?? '');
  check('3 GM: drafts the inn with the guide\'s sections', !!page && /room nobody rents/i.test(pageText) && /unfinished business/i.test(pageText), page ? pageText.slice(0, 200) : 'no page card');

  // Session 4: all of it at once, in a fresh chat.
  console.log('session 4: everything at once');
  c = await ask(P, gm, await gmChat(), 'Fallout from last session: Jessamine slept in the haunted inn, so mark her with another point of corruption, and she found a second Emberglass Lantern under the floor. Sort both out.');
  show('GM', c);
  const tools4 = cards(c).map((a) => a.tool);
  check('4 GM: corruption and item together', tools4.includes('house_rule_grant') && tools4.includes('add_item'), tools4.join(', ') || 'no cards');
  for (const a of cards(c)) await approve(a);
  c = await ask(P, gm, await gmChat(), 'What have I added to this world lately? New house rules, items and templates.');
  show('GM', c);
  const r4 = last(c);
  check('4 GM: knows what is new', /corruption/i.test(r4) && /emberglass/i.test(r4) && /haunted inn/i.test(r4), r4.slice(0, 200));
  c = await ask(P, jess, await helper(), 'How much corruption do I have now, and what am I carrying that helps against undead?');
  show('helper', c);
  check('4 helper: counter and item', /\b(2|two)\b/i.test(last(c)) && /emberglass/i.test(last(c)), last(c).slice(0, 200));
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }
const spend1 = await usage();
console.log('\n' + results.join('\n'));
console.log(`spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
if (problems.length) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
console.log('buildup-real ok');
