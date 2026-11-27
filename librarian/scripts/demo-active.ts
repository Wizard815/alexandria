// A short tour of Minerva's two modes on the seeded demo world and its fake models:
// Assistant mode (a proposal the GM approves), /takeover and Active mode reading
// a spoken session (music, tracker, items, the stage), the command log with an
// undo, a reject and a "wrong", an agent macro, and a player using the journal
// draft helper. It leaves the demo running with that history in place, so the
// screens (Active page, log, cards) can be looked at.
//
//   node --experimental-strip-types librarian/scripts/demo-active.ts --port 8450 [--data DIR]
//
// Nothing here calls a real model. Exit code 0 when every check passed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name: string, def = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; };
const port = Number(arg('port')) || 8450;
const data = arg('data') || fs.mkdtempSync(path.join(os.tmpdir(), 'alx-demo-active-'));
process.env.ALX_AUDIO_MERGE_MS = '200';
process.argv.push('--port', String(port), '--models-port', String(port + 1), '--data', data);
const log = console.log;
console.log = () => {};
try { await import('./demo.ts'); } finally { console.log = log; }
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function raw(method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(base + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = text;
  try { j = text ? JSON.parse(text) : null; } catch { /* text */ }
  return { status: r.status, body: j };
}
async function api(method: string, p: string, token?: string, body?: unknown): Promise<any> {
  const r = await raw(method, p, token, body);
  if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}
let checks = 0;
const check = (cond: unknown, msg: string): void => { checks++; if (!cond) { log(`  ✗ ${msg}`); process.exitCode = 1; throw new Error(`Check failed: ${msg}`); } log(`  ✓ ${msg}`); };

const login = async (u: string, p: string) => (await api('POST', '/api/auth/login', undefined, { username: u, password: p })).token as string;
const dm = await login('dm', 'game master 123');
const tom = await login('tom', 'player pass 123');
const jess = await login('jess', 'player pass 123');
const worlds = await api('GET', '/api/worlds', dm);
const W = `/api/worlds/${(worlds.worlds ?? worlds)[0].slug}`;
const members = await api('GET', `${W}/members`, dm);
const tomId = members.find((m: any) => m.display_name === 'tom').id;
const logRows = async (status?: string) => (await api('GET', `${W}/active/log${status ? `?status=${status}` : ''}`, dm)).log as any[];

log('\nMinerva: Assistant and Active mode\n');

// ---- 1. Assistant mode -----------------------------------------------------------------
log('1. Assistant mode: she proposes, the GM approves');
await api('PUT', `${W}/active`, dm, { mode: 'assistant' });
const chat = (await api('POST', `${W}/agent/chats`, dm, { title: 'Tonight' })).id;
await api('POST', `${W}/agent/chats/${chat}/messages`, dm, { text: 'Put on something tense for the cellar.\nFAKE_CALL play_music {"mood":"tense"}' });
let prop: any;
for (let i = 0; i < 60 && !prop; i++) { await sleep(200); const c = await api('GET', `${W}/agent/chats/${chat}`, dm); prop = c.actions.find((a: any) => a.status === 'pending'); }
check(prop?.tool === 'play_music', 'the music is proposed, not played');
check((await logRows('pending')).some((r) => r.tool === 'play_music' && r.mode === 'assistant'), 'the proposal is in the command log, pending');
await api('POST', `${W}/agent/actions/${prop.id}`, dm, { decision: 'approve' });
check((await logRows('done')).some((r) => r.tool === 'play_music' && r.mode === 'assistant'), 'approved: the log row is done');

// ---- 2. /takeover ----------------------------------------------------------------------
log('2. /takeover: every category to auto');
await api('PUT', `${W}/active`, dm, { cats: { stage: 'ask', items: 'ask' } });
const c2 = (await api('POST', `${W}/active/command`, dm, { text: '/takeover' }));
check(c2.mode === 'active' && Object.entries(c2.cats).every(([k, v]) => (k === 'notes' ? v === 'draft' : v === 'auto')), 'Active mode on, every category auto');

// ---- 3. a session, spoken ---------------------------------------------------------------
log('3. Active mode reads the spoken session');
for (const u of ['jess', 'tom']) await api('POST', `${W}/audio/consent`, u === 'jess' ? jess : tom, { agree: true });
await raw('POST', `${W}/actions/run`, dm, { action: 'recording.stop', args: {} });
const ses = await api('POST', `${W}/audio/sessions`, dm, { name: 'Active mode demo' });
const mic = async (tok: string, dev: string, lab: string, extra: object = {}) => (await api('POST', `${W}/audio/mics`, tok, { deviceId: dev, label: lab, mode: 'always', playersTranscript: true, ...extra })).id as string;
const mics = { dm: await mic(dm, 'act-dm', 'GM voice', { room: false }), tom: await mic(tom, 'act-tom', 'Tomas phone') };
const tokOf: Record<string, string> = { dm, tom };
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
let at = 1000, seq = 0;
const speak = async (who: 'dm' | 'tom', text: string) => {
  const r = await fetch(`${base}${W}/audio/sessions/${ses.id}/chunks?mic=${mics[who]}&seq=${seq++}&start=${at}&end=${at + 4000}&level=0.6`, { method: 'POST', headers: { Authorization: `Bearer ${tokOf[who]}`, 'Content-Type': 'audio/webm' }, body: Buffer.concat([WEBM, Buffer.from(`FAKE:${text}`)]) });
  if (r.status >= 300) throw new Error(`chunk ${r.status}`);
  at += 9000;
  await sleep(2200);
};
await api('POST', `${W}/live/combatants`, dm, { name: 'Ogre', initiative: 12, hp: 59, maxHp: 59 });
await api('PUT', `${W}/live/combat`, dm, { active: true });
await api('PUT', `${W}/library/pages`, dm, { path: 'maps/Docks Map', visibility: 'party', markdown: '# Docks Map\nThe docks of Saltmarsh.\n' });
await api('PUT', `${W}/library/pages`, dm, { path: 'dm/Velmira Ledger', visibility: 'dm', markdown: '# Velmira Ledger\nVelmira pays three captains. SECRETLEDGER\n' });
await speak('dm', 'You step into a cold cellar. Music: something sneaky.');
await speak('dm', 'The ogre takes 12 from the fireball.');
await speak('dm', 'You find a silver key under the barrel.');
await speak('dm', 'Show them the map of the docks.');
await speak('dm', 'Show them the Velmira ledger.');
let rows = await logRows();
check(rows.some((r) => r.tool === 'play_music' && r.status === 'done' && r.trigger === 'line'), 'sneaky music started by itself');
const dmg = rows.find((r) => r.tool === 'damage_combatant' && r.status === 'done');
check(!!dmg, 'the ogre\'s 12 damage went into the tracker');
const keyCard = rows.find((r) => r.tool === 'add_item' && r.status === 'pending');
check(!!keyCard, 'the silver key is a card, not an action: the rules alone are not sure it is a pickup (no audit model settled it)');
await api('POST', `${W}/active/log/${keyCard.id}/approve`, dm);
rows = await logRows();
check(rows.some((r) => r.tool === 'show_on_stage' && r.status === 'done' && JSON.stringify(r.args).includes('Docks')), 'the docks map is on the stage (a party page)');
check(!JSON.stringify(rows).includes('SECRETLEDGER') && !rows.some((r) => r.status === 'done' && /ledger/i.test(r.summary)), 'the GM-only ledger was never shown');
check(!JSON.stringify(await api('GET', `${W}/stage`, jess)).includes('SECRETLEDGER'), 'players see none of it');

// ---- 4. undo, wrong, reject ---------------------------------------------------------------
log('4. The command log: undo, wrong, reject');
await api('POST', `${W}/active/log/${dmg.id}/undo`, dm);
check((await api('GET', `${W}/live/combat`, dm)).combatants.find((c: any) => c.name === 'Ogre').hp === 59, 'undo put the ogre\'s hit points back');
const key = rows.find((r) => r.tool === 'add_item' && r.status === 'done');
check(!!key, 'the approved key is a done row');
await api('POST', `${W}/active/log/${key.id}/wrong`, dm);
check((await api('GET', `${W}/active/rules`, dm)).rules.length === 1, 'marked wrong: undone, and that cue will not fire again');
await api('PUT', `${W}/active`, dm, { cats: { items: 'ask' } });
await speak('dm', 'Give Tom 50 gold.');
const card = (await logRows('pending')).find((r) => r.tool === 'add_coin');
check(!!card, 'with items on ask, the gold waits on a card');
await api('POST', `${W}/active/log/${card.id}/reject`, dm);
check((await logRows('rejected')).length === 1, 'the card was rejected');
await speak('dm', 'You find a rusty lantern near the wall.');
check((await logRows('pending')).length >= 1, 'a new card is waiting (visible on the desktop and the GM phone)');

// ---- 5. a macro ----------------------------------------------------------------------------
log('5. Agent macros');
const tpl = await api('POST', `${W}/actions/macro-templates/reveal-handout/copy`, dm, {});
check(tpl.steps[0].action === 'minerva.run', 'a template copied: Reveal handout');
const mac = await api('POST', `${W}/actions/macros`, dm, { name: 'Cellar mood', params: [{ name: 'place', type: 'string', default: 'the cellar' }], steps: [{ action: 'minerva.run', args: { prompt: 'The party is in {{place}}. Play tense music.\nFAKE_CALL play_music {"mood":"tense"}', mode: 'do', tools: 'play_music' } }] });
const rep = await api('POST', `${W}/actions/macros/${mac.id}/run`, dm, {});
check(rep.ok, 'the macro ran: ' + JSON.stringify(rep.steps[0].result).slice(0, 80));

// ---- 6. a player ---------------------------------------------------------------------------
log('6. A player uses the journal helper');
const pc = (await api('POST', `${W}/agent/chats`, tom, { title: 'Journal' })).id;
await api('POST', `${W}/agent/chats/${pc}/messages`, tom, { text: 'Draft my journal for tonight.\nFAKE_CALL my_journal_draft {}' });
let reply = '';
for (let i = 0; i < 60 && !reply; i++) { await sleep(200); const c = await api('GET', `${W}/agent/chats/${pc}`, tom); if (!c.busy) reply = c.messages.filter((m: any) => m.role === 'assistant').at(-1)?.text ?? ''; }
check(reply.length > 0, 'the broker answered');
check(!/minerva|SECRETLEDGER|takeover/i.test(reply), 'the reply never mentions Minerva or GM-only text');
const draft = await api('GET', `${W}/helper/journal-draft`, tom);
check(/silver key|Ogre|ogre|map of the docks|cold cellar/i.test(draft.markdown) && !/SECRETLEDGER/.test(draft.markdown), 'the draft is built from what the table heard');

log(`\nAll ${checks} checks passed. The demo keeps running at ${base} (GM: dm / game master 123).`);
log(`Look at: ${base}/w/saltreach/dm/active and ${base}/w/saltreach/dm/phone`);
