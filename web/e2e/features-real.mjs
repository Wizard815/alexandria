// Can a REAL model use the newer features through their tools? One short prompt per feature to the DM's assistant
// (default tencent/hy4-flash) and a few questions from a player to the player helper (default the ternary
// Bonsai 9B), over the API on the demo world. It reports which tools each prompt reached and checks that a
// player's helper never repeats another player's DM note. No browser.
// Skipped unless FEATURES_REAL=1 (it calls paid models through OpenRouter; a run costs well under a cent). Run from web/:
//   NODE_USE_ENV_PROXY=1 FEATURES_REAL=1 node e2e/features-real.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { root, startScript, tmpDir } from './lib.mjs';

if (process.env.FEATURES_REAL !== '1') { console.log('features-real: skipped (set FEATURES_REAL=1; it calls a paid model)'); process.exit(0); }
const OR = 'https://openrouter.ai/api/v1';
const KEY = process.env.ASSISTANT_KEY || 'sk-or-proxy';
const DM_MODEL = process.env.FEATURES_DM_MODEL || 'tencent/hy4-flash';
const PLAYER_MODEL = process.env.FEATURES_PLAYER_MODEL || 'prism-ml/ternary-bonsai-2-9b';
const usage = async () => { try { return (await (await fetch(`${OR}/key`, { headers: { Authorization: `Bearer ${KEY}` } })).json())?.data?.usage ?? null; } catch { return null; } };
const spend0 = await usage();
const PORT = Number(process.env.FEATURES_REAL_PORT || 8213);
const base = `http://127.0.0.1:${PORT}`;
const data = path.join(tmpDir('features-real'), 'data');
const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', data, '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const db = new DatabaseSync(path.join(data, 'librarian.db'), { readOnly: true });
const problems = [];
const rows = [];
const j = async (m, p, tok, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, x: await r.json().catch(() => ({})) }; };

try {
  const admin = (await j('POST', '/api/admin-auth/login', null, { username: 'admin', password: 'library admin 123' })).x.token;
  const prov = (await j('POST', '/api/admin/models/providers', admin, { name: 'OpenRouter', kind: 'openai-compatible', baseUrl: OR, apiKey: KEY, location: 'cloud' })).x;
  const pid = prov.provider?.id ?? prov.id;
  const job = (model) => ({ providerId: pid, model, enabled: true, options: { reasoning: 'off', maxConcurrent: 2 } });
  await j('PUT', '/api/admin/models', admin, { jobs: { chat: job(DM_MODEL), dm: job(DM_MODEL), player: job(PLAYER_MODEL) } });
  const dm = (await j('POST', '/api/auth/login', null, { username: 'dm', password: 'dungeon master 123' })).x.token;
  const jess = (await j('POST', '/api/auth/login', null, { username: 'jess', password: 'player pass 123' })).x.token;
  const WID = (await j('GET', '/api/worlds', dm)).x[0].id;
  const P = `/api/worlds/${WID}`;
  const members = (await j('GET', `${P}/members`, dm)).x;
  const acc = (u) => members.find((m) => String(m.character_name ?? '').toLowerCase().startsWith(u))?.id;
  const [jessId, tomId] = [acc('jess'), acc('tom')];

  // The state the prompts act on: Jessamine is hurt and poisoned and has a goal; Tomas has a private DM note.
  await j('PATCH', `${P}/settings`, dm, { sheetRerolls: true, downtimeOn: true, agentAutoApprove: [] });
  await j('POST', `${P}/sheet/${jessId}/vitals`, dm, { maxHp: 24, hp: 24 });
  await j('POST', `${P}/sheet/${jessId}/vitals`, dm, { damage: 7, conditions: ['Poisoned'], note: 'Spider bite' });
  await j('POST', `${P}/sheet/${jessId}/dm-notes`, dm, { kind: 'goal', text: 'Find the lighthouse keeper before the new moon.' });
  await j('POST', `${P}/lights/scenes`, dm, { name: 'Candlelight', color: '#ff9933', brightness: 40 });
  await j('POST', `${P}/voice/presets`, dm, { name: 'Gravel', voice: 'bm_george', speed: 0.9, target: 'table' });
  await j('POST', `${P}/sheet/${tomId}/dm-notes`, dm, { kind: 'note', text: 'Your brother Edric is alive and hiding in Saltmarsh.' });

  const ask = async (tok, text, mode) => {
    const chat = (await j('POST', `${P}/agent/chats`, tok, mode ? { mode } : {})).x;
    const since = new Date().toISOString();
    await j('POST', `${P}/agent/chats/${chat.id}/messages`, tok, { text });
    let c;
    for (let i = 0; i < 600; i++) {
      c = (await j('GET', `${P}/agent/chats/${chat.id}`, tok)).x;
      if (!c.busy) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const used = db.prepare(`SELECT detail FROM audit WHERE action IN ('agent.read', 'agent.propose', 'agent.action') AND at >= ? ORDER BY rowid`).all(since).map((r) => String(r.detail).split(' ')[0]);
    const reply = c.messages.filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
    return { used: [...new Set([...used, ...c.actions.map((a) => a.tool)])], reply, actions: c.actions };
  };

  // The DM's assistant: one prompt per feature, and the tools that would serve it.
  const DM_PROMPTS = [
    ['Sheet: party status', "How is the party doing? Check everyone's HP and mana.", ['party_status']],
    ['Sheet: one sheet', "What notes and goals have I put on Jessamine's sheet?", ['read_sheet']],
    ['Sheet: DM goal', "Put a goal on Tomas's sheet: win back his father's sword.", ['add_sheet_note']],
    ['Sheet: HP', 'Tomas took 6 damage from a falling beam. Update his sheet.', ['change_player_hp']],
    ['Sheet: HP history', "Who changed Jessamine's HP tonight, and why?", ['sheet_log']],
    ['House rule: re-roll', 'Give Anselm a personal re-roll for that great speech.', ['give_reroll', 'house_rule_grant']],
    ['House rules: new mod', 'Write a house rule for hero points: each player gets one per session to add a d6 to a roll.', ['house_rule_check', 'house_rule_save', 'house_rule_file', 'house_rule_guide']],
    ['DownTime', 'Start a downtime round: the party has 5 days in Saltmarsh before the ship leaves.', ['downtime_round']],
    ['NPC encounters', 'Send Tomas a street gambler encounter.', ['send_encounter', 'list_encounter_templates']],
    ['Shops', 'Make a small blacksmith shop for this town and save it.', ['generate_shop']],
    ['Fog of war', 'Turn on the fog of war on the world map, then uncover a circle around the middle of it.', ['set_fog', 'reveal_fog']],
    ['Lights', 'Set the room lights to the Candlelight scene.', ['run_light_scene', 'list_light_scenes']],
    ['Quick events', 'Send the party a quick perception save, DC 13, with a 30 second timer.', ['send_quick_event']],
    ['Session prep', 'Write each player a session prep for Friday. Tell them we start at the lighthouse.', ['draft_session_prep']],
    ['NPC voices', 'Give Captain Vex the Gravel voice in encounters, and turn NPC voices on.', ['set_npc_voice', 'set_npc_voices']],
    ['Story events by place', 'Save a story event for the docks: a pickpocket bumps into the player and they can chase or let it go.', ['save_encounter_template']],
    ['Homebrew spell', 'Save a homebrew spell: Lantern Ward, 1st-level abjuration, a ring of light that gives allies +1 AC for a minute.', ['save_homebrew_spell']],
    ['Roll20', 'Is our Roll20 game connected? If so, send the players the Saltmarsh handout there.', ['roll20_status', 'roll20_send_handout']],
    ['Foundry VTT', "Move Tomas's token to the docks in Foundry.", ['foundry_move_token', 'foundry_status']],
    ['Open5e content', 'Which Open5e books could I import monsters from? Tome of Beasts maybe.', ['list_content_books', 'import_content']],
  ];
  for (const [feature, text, want] of DM_PROMPTS) {
    const r = await ask(dm, text);
    const hit = want.some((t) => r.used.includes(t));
    rows.push({ who: 'DM', feature, hit, used: r.used.join(', ') || '(none)' });
    if (!hit) problems.push(`DM, ${feature}: wanted ${want.join(' or ')}, used ${r.used.join(', ') || 'nothing'}`);
  }

  // Session prep, written by the Players model from each player's own brief: Jessamine's must not carry Tomas's private note.
  {
    const preps = (await j('GET', `${P}/prep`, dm)).x.preps.filter((p) => p.status === 'draft');
    const mine = preps.find((p) => p.accountId === jessId);
    const leak = preps.filter((p) => p.accountId !== tomId).some((p) => /Edric/i.test(p.text));
    const okPrep = !!mine && mine.byModel && !leak && /lighthouse/i.test(mine.text);
    rows.push({ who: 'DM', feature: 'Session prep drafts', hit: okPrep, used: `${preps.length} drafts; Jessamine: ${(mine?.text ?? '(none)').replace(/\s+/g, ' ').slice(0, 160)}` });
    if (!okPrep) problems.push(`DM, session prep: ${mine ? (leak ? 'a draft has Tomas\'s note' : mine.byModel ? 'no lighthouse' : 'no model') : 'no draft for Jessamine'}`);
  }

  // Map vision: a dungeon map on the table screen with the fog on; "open the crypt" should look at the map, then uncover the
  // crypt's box (left 60 to 92, top 10 to 43 on the 0 to 100 grid). And a text-only model is refused before any picture is sent.
  {
    const up = await fetch(`${base}${P}/files?name=dungeon.png&kind=map&title=Dungeon`, { method: 'POST', headers: { Authorization: `Bearer ${dm}`, 'Content-Type': 'image/png' }, body: fs.readFileSync(path.join(root, 'web/e2e/fixtures/dungeon-map.png')) });
    const f = await up.json();
    const pic = `lib:${f.id ?? f.file?.id}`;
    await j('PUT', `${P}/fog/table`, dm, { mapId: 'world', pic });
    await j('PUT', `${P}/fog/map/world/enabled`, dm, { pic, enabled: true });
    const sees = (await j('GET', `${P}/fog/vision`, dm)).x;
    rows.push({ who: 'DM', feature: 'Vision check', hit: sees.sees === 'yes', used: sees.why });
    if (sees.sees !== 'yes') problems.push(`DM, vision check: ${sees.why}`);
    const r = await ask(dm, 'Open the crypt for the players.');
    const rv = r.actions.find((a) => a.tool === 'reveal_fog');
    const a = rv?.args ?? {};
    const cx = a.shape === 'rect' ? Number(a.x) + Number(a.w) / 2 : Number(a.x), cy = a.shape === 'rect' ? Number(a.y) + Number(a.h) / 2 : Number(a.y);
    const inCrypt = !!rv && cx >= 60 && cx <= 92 && cy >= 10 && cy <= 43;
    rows.push({ who: 'DM', feature: 'Map vision + fog', hit: r.used.includes('look_at_map') && inCrypt, used: `${r.used.join(', ')} ${rv ? JSON.stringify(a) : '(no reveal)'}` });
    if (!(r.used.includes('look_at_map') && inCrypt)) problems.push(`DM, map vision: used ${r.used.join(', ')}, reveal ${JSON.stringify(a)}`);
    // A text-only model on Map vision: refused, and nothing is sent.
    await j('PUT', '/api/admin/models', admin, { jobs: { vision: job('tencent/hy-mt2-7b') } });
    const blind = (await j('GET', `${P}/fog/vision`, dm)).x;
    const refused = (await j('POST', `${P}/fog/look`, dm, {})).s === 409;
    rows.push({ who: 'DM', feature: 'Blind model refused', hit: blind.sees === 'no' && refused, used: blind.why });
    if (!(blind.sees === 'no' && refused)) problems.push(`DM, blind model: ${blind.sees} ${refused}`);
    await j('PUT', '/api/admin/models', admin, { jobs: { vision: { enabled: false } } });
  }

  // The codex a player's helper reads: Fire Bolt known, Burning Hands ready, Scorching Ray needs Burning Hands too.
  await j('PATCH', `${P}/settings`, dm, { spellCrafting: true, spellCraftApproval: 'dm' });
  await j('POST', `${P}/spells/characters/${jessId}/known`, dm, { spell: 'Fire Bolt' });
  await j('PUT', `${P}/spells/characters/${jessId}`, dm, { level: 3, abilities: { int: 14 } });
  await j('POST', `${P}/spells/recipes`, dm, { result: 'Burning Hands', prereqs: ['Fire Bolt'] });
  await j('POST', `${P}/spells/recipes`, dm, { result: 'Scorching Ray', prereqs: ['Fire Bolt', 'Burning Hands'], stats: { int: 13 } });
  const HELPER_PROMPTS = [
    ['Helper: codex', 'Which spells can I learn now, and what do I still need for Scorching Ray?', (s) => /burning hands/i.test(s) && /scorching ray/i.test(s)],
    ['Helper: quests', 'What are my open quests and goals?', (s) => /keeper|new moon/i.test(s)],
    ['Helper: to the broker', 'Who secretly controls the harbour council?', (s) => /broker/i.test(s)],
    ['Helper: downtime', 'We have a few days of downtime. What could I do with it?', (s) => /craft|train|research|carous|work|study|practi[cs]e/i.test(s)],
  ];
  for (const [feature, text, check] of HELPER_PROMPTS) {
    const r = await ask(jess, text, 'helper');
    const pass = check(r.reply);
    rows.push({ who: 'Player', feature, hit: pass, used: r.reply.replace(/\s+/g, ' ').slice(0, 140) });
    if (!pass) problems.push(`Player, ${feature}: ${r.reply.slice(0, 300)}`);
  }

  // A player's helper: their own sheet, and nothing of another player's.
  const PLAYER_PROMPTS = [
    ['My sheet: HP', 'How much HP do I have left, and am I under any condition?', (s) => /\b17\b/.test(s) && /poison/i.test(s)],
    ['My sheet: goals', 'What goals has the DM given me?', (s) => /new moon/i.test(s)],
    ["Another player's notes", "What did the DM write on Tomas's sheet?", (s) => !/edric|brother/i.test(s)],
  ];
  for (const [feature, text, check] of PLAYER_PROMPTS) {
    const r = await ask(jess, text);
    const pass = check(r.reply);
    rows.push({ who: 'Player', feature, hit: pass, used: r.reply.replace(/\s+/g, ' ').slice(0, 140) });
    if (!pass) problems.push(`Player, ${feature}: ${r.reply.slice(0, 200)}`);
  }
} catch (e) { problems.push('run failed: ' + e.message); } finally { srv.kill(); }

for (const r of rows) console.log(`${r.hit ? 'ok  ' : 'MISS'} ${r.who.padEnd(6)} ${r.feature.padEnd(24)} ${r.used}`);
const spend1 = await usage();
console.log(`models: DM ${DM_MODEL}, player ${PLAYER_MODEL}; spend: ${spend0 !== null && spend1 !== null ? `$${(spend1 - spend0).toFixed(4)}` : 'unknown'}`);
// The spoiler check must always hold; a missed tool is reported for tuning but only fails the run under FEATURES_STRICT=1.
const leaks = problems.filter((p) => p.startsWith("Player, Another player's"));
if (leaks.length || (process.env.FEATURES_STRICT === '1' && problems.length)) { console.log('PROBLEMS:\n' + problems.map((p) => ' - ' + p).join('\n')); process.exit(1); }
if (problems.length) console.log('misses (not failing; FEATURES_STRICT=1 to fail):\n' + problems.map((p) => ' - ' + p).join('\n'));
console.log('features-real ok');
