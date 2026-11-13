// A self-contained demo: fake models, the librarian, and a made-up world
// ("Saltreach") filled with data for every feature. Nothing leaves this
// machine and no GPU is needed.
//
//   cd web && npm run build && cd ..
//   node --experimental-strip-types librarian/scripts/demo.ts [--port 8400] [--data /tmp/alx-demo]
//
// Then open http://127.0.0.1:8400 and sign in with the accounts it prints.
// The data folder is wiped and refilled on every start.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeModels } from './fake-models.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(arg('port', '8400'));
const MODELS_PORT = Number(arg('models-port', String(PORT + 1)));
const DATA = path.resolve(arg('data', path.join(process.env.TMPDIR || '/tmp', 'alexandria-demo')));
const WEB = path.resolve(arg('web', path.join(here, '../../web/dist')));
const base = `http://127.0.0.1:${PORT}`;

// ---- fresh data folder with a few generated sounds -------------------------

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

/** A short WAV tone (mono, 8 kHz, 16-bit). Made-up audio, no copyrighted files. */
function tone(file: string, hz: number, seconds = 1.5, wobble = 0) {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = hz + (wobble ? Math.sin(t * 6) * wobble : 0);
    const env = Math.min(1, t * 8, (seconds - t) * 8);
    buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * t) * 9000 * env), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}
const D = (...p: string[]) => path.join(DATA, ...p);
tone(D('music/village/market/morning-bustle.wav'), 330, 2);
tone(D('music/village/calm/hearthside.wav'), 262, 2);
tone(D('music/dungeon/tense/dripping-dark.wav'), 147, 2, 4);
tone(D('music/dungeon/sneaky/soft-steps.wav'), 196, 2);
tone(D('music/combat/battle-drums.wav'), 98, 2, 10);
tone(D('music/demon/combat/abyssal-choir.wav'), 73, 2, 20);
tone(D('ambience/rain/steady-rain.wav'), 880, 2, 200);
tone(D('ambience/tavern/chatter.wav'), 440, 2, 60);
tone(D('ambience/hearth/fire.wav'), 120, 2, 30);
tone(D('ambience/wind/gusts.wav'), 600, 2, 150);
tone(D('sfx/doors/creak.wav'), 520, 0.8, 80);
tone(D('sfx/combat/sword-clash.wav'), 1200, 0.4);

// ---- fake models, then the librarian --------------------------------------

const models = await startFakeModels(MODELS_PORT);
const m = `http://127.0.0.1:${MODELS_PORT}/v1`;
Object.assign(process.env, {
  LIBRARIAN_PORT: String(PORT),
  ALX_DATA_DIR: DATA,
  ALX_WEB_DIR: WEB,
  ALX_PUBLIC_URL: base,
  ALX_RATE_LIMIT: '0',
  ALX_AUDIO_MERGE_MS: '1000',
  ALX_MODEL_CHAT_URL: m, ALX_MODEL_CHAT_MODEL: 'fake-chat',
  ALX_MODEL_AUDIT_URL: m, ALX_MODEL_AUDIT_MODEL: 'fake-audit',
  ALX_MODEL_AUDIO_URL: m, ALX_MODEL_AUDIO_MODEL: 'fake-whisper',
  ALX_MODEL_VOICE_URL: m, ALX_MODEL_VOICE_MODEL: 'fake-kokoro',
  ALX_MODEL_EXTRA_URL: m, ALX_MODEL_EXTRA_MODEL: 'fake-embed',
});
const { createApp } = await import('../src/app.ts');
const { app } = createApp({ dbFile: D('librarian.db'), dataDir: DATA, vaultsDir: null, webDir: fs.existsSync(WEB) ? WEB : null, env: process.env });
await new Promise<void>((r) => app.listen(PORT, '127.0.0.1', () => r()));

// ---- seed through the real API --------------------------------------------

async function call(method: string, p: string, token?: string, body?: unknown, raw?: { data: Uint8Array; type: string }) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (raw) headers['Content-Type'] = raw.type; else if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + p, { method, headers, body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${typeof j === 'string' ? j.slice(0, 200) : JSON.stringify(j).slice(0, 300)}`);
  return j;
}
/** Seed steps keep going if one feature isn't there; the demo shows what works. */
async function step(label: string, fn: () => Promise<unknown>) {
  try { await fn(); console.log(`  ✓ ${label}`); } catch (e: any) { console.log(`  ✗ ${label}: ${String(e.message).slice(0, 200)}`); }
}

const PASS = { admin: 'library admin 123', dm: 'dungeon master 123', player: 'player pass 123' };
console.log('Seeding the demo world…');
await call('POST', '/api/setup', undefined, { username: 'admin', password: PASS.admin });
// The gateway admin signs in separately from the table (/admin/login).
const admin = (await call('POST', '/api/admin-auth/login', undefined, { username: 'admin', password: PASS.admin })).token as string;
const dmAcc = await call('POST', '/api/admin/accounts', admin, { username: 'dm', password: PASS.dm, displayName: 'The DM' });
const dm = (await call('POST', '/api/auth/login', undefined, { username: 'dm', password: PASS.dm })).token as string;
const world = await call('POST', '/api/admin/worlds', admin, { name: 'Saltreach', dmAccountId: dmAcc.account.id });
const W = `/api/worlds/${world.slug}`;

const players: Record<string, { token: string; id: string; name: string }> = {};
for (const [user, character] of [['jess', 'Jessamine'], ['tom', 'Tomas'], ['ana', 'Anselm']]) {
  const inv = await call('POST', `${W}/invites`, dm, { role: 'player' });
  const j = await call('POST', '/api/join', undefined, { code: inv.code, username: user, password: PASS.player, characterName: character });
  players[user] = { token: j.token, id: j.account.id, name: character };
}
const { jess, tom, ana } = players;

// Library: shared pages with DM secrets inside, and DM-only pages.
const page = async (p: string, visibility: 'party' | 'dm', markdown: string) => (await call('PUT', `${W}/library/pages`, dm, { path: p, visibility, markdown })).id as string;
const ids: Record<string, string> = {};
let audioSession = '';
await step('library pages', async () => {
  ids.saltmarsh = await page('Places/Saltmarsh', 'party', `---
knowledge: local
aliases: [Salt Marsh]
tags: [town, coast]
---
# Saltmarsh
A fishing town on the Azure coast, ruled by a harbour council of seven captains. Its lighthouse has been dark for a month.

## The harbour
Fishing boats leave before dawn. The [[Greywater Ferry]] crosses to the far bank twice a day.

> [!secret] DM
> The harbour council secretly answers to [[Velmira]], the smuggler queen. Three of the seven captains are on her payroll.
`);
  ids.ferry = await page('Places/Greywater Ferry', 'party', `---
knowledge: common
---
# Greywater Ferry
A flat-bottomed ferry across the Greywater. Two silver a head, double after dark.
`);
  ids.council = await page('Factions/Harbour Council', 'party', `---
knowledge: local
---
# Harbour Council
Seven captains who set the harbour fees and settle disputes. They meet each new moon in the Lantern Hall.
`);
  ids.lantern = await page('Items/Lantern of the Deep', 'party', `---
knowledge: deep
---
# Lantern of the Deep
A brass lantern that hums near water. When lit underwater, it burns blue and does not go out.

> [!secret] DM
> It was made by the Drowned King to find his lost crown. Whoever carries it is slowly drawn toward the sea.
`);
  ids.velmira = await page('People/Velmira', 'dm', `# Velmira
The smuggler queen of the Azure coast. She keeps her treasury beneath the dark lighthouse and wants the Lantern of the Deep.
`);
  ids.king = await page('Secrets/The Drowned King', 'dm', `# The Drowned King
The campaign's villain: a drowned sorcerer-king waiting beneath the bay for his crown. The party doesn't know he exists yet.
`);
});

// Coin and items; the lantern links to its library page.
await step('coin and items', async () => {
  await call('POST', `${W}/live/ledger`, dm, { owner: jess.id, amountCp: 4250, note: 'Reward from the harbour council' });
  await call('POST', `${W}/live/ledger`, dm, { owner: tom.id, amountCp: 380, note: 'Wages' });
  await call('POST', `${W}/live/ledger`, dm, { owner: ana.id, amountCp: 1200, note: 'Wages' });
  await call('POST', `${W}/live/ledger`, dm, { owner: 'party', amountCp: 2000, note: 'Shared loot' });
  const lantern = await call('POST', `${W}/inventory`, dm, { owner: jess.id, name: 'Brass lantern', qty: 1, note: 'Hums near water', reason: 'Found in the lighthouse', pageId: ids.lantern });
  await call('PUT', `${W}/itemcards/${lantern.id ?? lantern.item?.id}/page`, dm, { pageId: ids.lantern }).catch(() => null);
  await call('POST', `${W}/inventory`, dm, { owner: jess.id, name: 'Arrows', qty: 20, reason: 'Bought in the market' });
  await call('POST', `${W}/inventory`, dm, { owner: tom.id, name: 'Healing potion', qty: 2, reason: 'From the temple' });
  await call('POST', `${W}/inventory`, dm, { owner: 'party', name: 'Rope (50 ft)', qty: 2, reason: 'Bought' });
});

// World clock and events.
await step('world clock and events', async () => {
  const now = (await call('GET', `${W}/clock`, dm)).minutes as number;
  await call('POST', `${W}/clock/events`, dm, { title: 'Harbour Festival', description: 'Boat races and a lantern parade.', start: now + 3 * 1440, kind: 'holiday', visibility: 'party' });
  await call('POST', `${W}/clock/events`, dm, { title: 'Council meeting', description: 'New moon, Lantern Hall.', start: now + 1440 + 600, kind: 'custom', visibility: 'party' });
  await call('POST', `${W}/clock/events`, dm, { title: "Velmira's shipment lands", description: 'At the dark lighthouse, after midnight.', start: now + 2 * 1440, kind: 'deadline', visibility: 'dm' });
  await call('POST', `${W}/clock/advance`, dm, { preset: 'long-rest', reason: 'Rested at the Salty Dog inn' });
});

// Broker: a normal question, a question about a secret, and a DM offer.
await step('information broker', async () => {
  for (const [who, q] of [[jess, 'Who rules Saltmarsh?'], [tom, 'Who does the harbour council secretly answer to?'], [ana, 'How much is the Greywater Ferry?']] as const) {
    const quote = await call('POST', `${W}/broker/quote`, who.token, { question: q });
    await call('POST', `${W}/broker/ask`, who.token, { quoteId: quote.quoteId }).catch(() => null);
  }
  await call('POST', `${W}/broker/notes`, dm, { topic: 'Lighthouse keeper', text: 'The old keeper drinks at the Salty Dog and talks for a pint.', knowledge: 'local' });
  await call('POST', `${W}/broker/offers`, dm, { title: 'The dark lighthouse', teaser: 'I know why the light went out. Interested?', info: 'Someone paid the keeper to let it go dark. The coin was council silver.', priceCp: 1500, targets: 'party', fallbackHours: 72 });
});

// Audio: consent, mics, a recording with overlapping mics and a DM aside.
await step('recording and live transcript', async () => {
  for (const p of [jess, tom, ana]) await call('POST', `${W}/audio/consent`, p.token, { agree: true });
  const table = await call('POST', `${W}/audio/mics`, dm, { deviceId: 'demo-table', label: 'Table', mode: 'always', playersTranscript: true });
  const headset = await call('POST', `${W}/audio/mics`, dm, { deviceId: 'demo-headset', label: 'DM headset', mode: 'hold-to-talk', playersTranscript: false, aside: true });
  const tomMic = await call('POST', `${W}/audio/mics`, tom.token, { deviceId: 'demo-tom-phone', label: "Tomas's phone", mode: 'always' });
  const sess = await call('POST', `${W}/audio/sessions`, dm, { name: 'Session 21' });
  const sid = sess.id ?? sess.session?.id;
  audioSession = sid;
  const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
  const chunk = (text: string) => ({ data: Buffer.concat([WEBM, Buffer.from('FAKE:' + text)]), type: 'audio/webm' });
  const up = (mic: any, token: string, seq: number, start: number, end: number, level: number, text: string) =>
    call('POST', `${W}/audio/sessions/${sid}/chunks?mic=${mic.id ?? mic.mic?.id}&seq=${seq}&start=${start}&end=${end}&level=${level}`, token, undefined, chunk(text));
  // The table mic and Tomas's phone both hear Tomas: one merged line.
  await up(table, dm, 0, 0, 5000, 0.4, 'We should ask the harbour council about the lighthouse.');
  await up(tomMic, tom.token, 0, 0, 5000, 0.9, 'We should ask the harbour council about the lighthouse.');
  await up(table, dm, 1, 5000, 10000, 0.6, 'The ferry costs two silver. The lantern hums near water.');
  // A DM aside on the headset: the table mic hears it too, but it stays DM-only.
  await call('POST', `${W}/audio/sessions/${sid}/holds`, dm, { micId: headset.id ?? headset.mic?.id, kind: 'aside', start: 10000, end: 15000 });
  await up(headset, dm, 0, 10000, 15000, 0.9, 'Remember Velmira owns three of the captains.');
  await up(table, dm, 2, 10000, 15000, 0.3, 'Remember Velmira owns three of the captains.');
  await up(table, dm, 3, 16000, 21000, 0.6, 'Jessamine casts Fireball at the smugglers on the pier.');
  await new Promise((r) => setTimeout(r, 2500));
});

// Sound: library, music by mood, an ambience scene, a pad, players' switches, a voice preset.
await step('sound board and read-aloud', async () => {
  await call('POST', `${W}/sound/rescan`, dm, {});
  await call('POST', `${W}/sound/scenes`, dm, { name: 'Stormy night at the tavern', layers: [{ kind: 'rain', volume: 0.4 }, { kind: 'tavern', volume: 0.7 }, { kind: 'hearth', volume: 0.3 }] }).catch(() => null);
  await call('POST', `${W}/sound/music/mood`, dm, { x: 0.8, y: 0.2, area: 'village' }).catch(() => null);
  await call('PUT', `${W}/sound/me/switches`, tom.token, { deviceId: 'demo-tom-phone', music: true, ambience: true, sfx: false }).catch(() => null);
  await call('POST', `${W}/voice/presets`, dm, { name: 'Narrator', voice: 'af_heart', speed: 1, effect: 'none', target: 'table' });
  await call('POST', `${W}/voice/presets`, dm, { name: 'Old sailor', voice: 'am_michael', speed: 0.9, effect: 'radio', target: 'both' });
});

// Second-round features, if they are present.
await step('session log: draft, date, publish', async () => {
  await call('POST', `${W}/audio/sessions/${audioSession}/stop`, dm, {});
  const d = await call('POST', `${W}/sessionlog/drafts`, dm, { audioSessionId: audioSession, title: 'Session 21: The dark lighthouse' });
  const did = d.id ?? d.draft?.id;
  await call('POST', `${W}/sessionlog/drafts/${did}/date`, dm, { accept: true, minutes: 2 * 1440, reason: 'Two days on the coast road' }).catch(() => null);
  await call('POST', `${W}/sessionlog/drafts/${did}/publish`, dm, {});
  // A second draft stays unpublished, so the DM sees a review in progress.
  await call('POST', `${W}/sessionlog/drafts`, dm, { audioSessionId: audioSession, title: 'Session 22 (draft)' });
});
await step('DM agent chat', async () => {
  const c = await call('POST', `${W}/agent/chats`, dm, { title: 'Prep' });
  await call('POST', `${W}/agent/chats/${c.id ?? c.chat?.id}/messages`, dm, { text: 'Summarise Saltmarsh for me.' });
});

console.log(`
Alexandria demo is running: ${base}

  Gateway admin   ${base}/admin/login   admin / ${PASS.admin}
  Dungeon Master  ${base}/login         dm / ${PASS.dm}
  Players         ${base}/login         jess, tom, ana / ${PASS.player}

Fake models: ${m} (chat, audit, audio, voice, embeddings)
Data folder: ${DATA}
Press Ctrl+C to stop.`);
process.on('SIGINT', () => { void models.close?.(); process.exit(0); });
