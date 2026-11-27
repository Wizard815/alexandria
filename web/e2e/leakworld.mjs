// Serves the security crawler's world (librarian/test/security-world.ts: one
// unique marker at every GM-only, broker and classified spot) on fake models,
// with the built web app, for web/e2e/leaks.mjs.
//   node --experimental-strip-types e2e/leakworld.mjs <port> <data dir> <web dist>
// Prints one line "LEAKWORLD {json}" with the markers, then serves until killed.
import fs from 'node:fs';
import path from 'node:path';
import { all, run } from '../../librarian/src/core/db.ts';
import { createApp } from '../../librarian/src/app.ts';
import { KANKA_WORLD, makeAccounts, seedContent } from '../../librarian/test/security-world.ts';
import { fakeKanka } from '../../librarian/test/sourcekeys-fake.ts';
import { MODEL_ENV, client, fakeModels, mark, markers } from '../../librarian/test/security-kit.ts';

const [port, data, web] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
fs.mkdirSync(data, { recursive: true });
const models = fakeModels(fetch);
const kanka = fakeKanka(models.fetch, KANKA_WORLD);
const made = createApp({ noScheduler: true, dataDir: path.join(data, 'data'), vaultsDir: path.join(data, 'vaults'), webDir: web, fetch: kanka.fetch, env: { ...MODEL_ENV, ALX_RATE_LIMIT: '0', ALX_CRAWL_RATE: '0' } });
const server = made.app.listen(port, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const http = client(() => `http://127.0.0.1:${port}`);
const S = await makeAccounts({ ...http, deps: made.deps });
await seedContent({ ...http, deps: made.deps }, S);
// The players' screen: a hidden queue item whose title is a GM-only marker, and a card shown to everyone,
// so the screen route has content to crawl (leaks.mjs opens it with the GM's own token).
const scr = `/api/worlds/${S.W}/screen/media`;
const hid = await http.ok('POST', `${scr}/items`, S.T.gm, { kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', title: mark('screen_hidden', ['gm'], 'a hidden item in the players-screen queue') });
await http.ok('PATCH', `${scr}/items/${hid.items[0].id}`, S.T.gm, { hidden: true });
await http.ok('PUT', scr, S.T.gm, { mode: 'queue' });
await http.ok('POST', `/api/worlds/${S.W}/stage/cards`, S.T.gm, { kind: 'text', title: 'Board for everyone', text: `The bridge is out. ${mark('stage_card_all', ['gm', 'jess', 'tom'], 'a stage card shown to everyone')}`, show: true });
// A party pin under fog on the map the table screen shows: the table (and every player) must never get it, whatever the page does.
const fogw = `/api/worlds/${S.W}`;
await http.ok('PUT', `${fogw}/fog/map/fogmap/enabled`, S.T.gm, { pic: 'none', enabled: true });
await http.ok('POST', `${fogw}/map/fogmap/marks`, S.T.gm, { kind: 'pin', x: 50, y: 50, label: mark('mark_fogged', ['gm'], 'a party pin under fog on the table map'), visibility: 'party' });
await http.ok('PUT', `${fogw}/fog/table`, S.T.gm, { mapId: 'fogmap', pic: 'none' });
// "Download all" for the crawl night: a built recording folder (the full mix, Jess's and Tom's tracks, each file holding a
// marker), both summaries and an approved hand-off. A player's zip may hold their own track and the players' side only.
{
  const db = made.deps.db;
  const at = new Date().toISOString();
  const rel = path.join('recordings', 'Harbourtown', 'Crawl night');
  fs.mkdirSync(path.join(data, 'data', rel), { recursive: true });
  const tracks = [
    ['trk_full', 'Full session.mp3', 'full', null, mark('zip_full', ['gm'], 'the full mix in Download all')],
    ['trk_jess', 'Jess phone - jess.mp3', 'mic', S.ID.jess, mark('zip_jess', ['gm', 'jess'], "Jess's own track in Download all")],
    ['trk_tom', 'Tom phone - tom.mp3', 'mic', S.ID.tom, mark('zip_tom', ['gm', 'tom'], "Tom's own track in Download all")],
  ];
  for (const [id, file, kind, acct, m] of tracks) {
    const bytes = Buffer.from(`ID3 not really audio ${m}\n`);
    fs.writeFileSync(path.join(data, 'data', rel, file), bytes);
    run(db, 'INSERT INTO audio_tracks (id, session_id, kind, mic_id, account_id, label, person, file, mime, duration_ms, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, 'ses_crawl', kind, null, acct, file.replace(/\.mp3$/, ''), '', file, 'audio/mpeg', 1000, bytes.length, at);
  }
  run(db, "UPDATE audio_sessions SET rec_dir = ?, rec_status = 'ready', rec_built_at = ? WHERE id = 'ses_crawl'", rel, at);
  const sum = (aud, text) => run(db, "INSERT INTO audio_summaries (session_id, audience, world_id, text, upto, lines, updated_at) VALUES ('ses_crawl', ?, ?, ?, '', 1, ?) ON CONFLICT (session_id, audience) DO UPDATE SET text = excluded.text", aud, S.W, text, at);
  sum('party', `The party reached the harbour. ${mark('zip_party_summary', ['gm', 'jess', 'tom'], "the players' summary (control)")}`);
  sum('gm', `The queen waits. ${mark('zip_gm_summary', ['gm'], "the GM's running summary")}`);
  run(db, "INSERT INTO audio_handoffs (id, session_id, world_id, status, text, source, created_at, updated_at, decided_at) VALUES ('ah_crawl', 'ses_crawl', ?, 'approved', ?, 'final', ?, ?, ?)", S.W, `Approved: ${mark('zip_handoff', ['gm'], 'the approved GM summary in Download all')}`, at, at, at);
}
// Library sharing seeds (per-player shares, folder rules, files added later) are in seedContent, so the API crawler covers them too.
const slug = all(made.deps.db, 'SELECT slug FROM worlds WHERE id = ?', S.W)[0].slug;
console.log('LEAKWORLD ' + JSON.stringify({ slug, markers: Object.values(markers), pages: S.pages }));
