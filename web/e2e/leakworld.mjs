// Serves the security crawler's world (librarian/test/security-world.ts: one
// unique marker at every DM-only, broker and classified spot) on fake models,
// with the built web app, for web/e2e/leaks.mjs.
//   node --experimental-strip-types e2e/leakworld.mjs <port> <data dir> <web dist>
// Prints one line "LEAKWORLD {json}" with the markers, then serves until killed.
import fs from 'node:fs';
import path from 'node:path';
import { all } from '../../librarian/src/core/db.ts';
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
// The players' screen: a hidden queue item whose title is a DM-only marker, and a card shown to everyone,
// so the screen route has content to crawl (leaks.mjs opens it with the DM's own token).
const scr = `/api/worlds/${S.W}/screen/media`;
const hid = await http.ok('POST', `${scr}/items`, S.T.dm, { kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', title: mark('screen_hidden', ['dm'], 'a hidden item in the players-screen queue') });
await http.ok('PATCH', `${scr}/items/${hid.items[0].id}`, S.T.dm, { hidden: true });
await http.ok('PUT', scr, S.T.dm, { mode: 'queue' });
await http.ok('POST', `/api/worlds/${S.W}/stage/cards`, S.T.dm, { kind: 'text', title: 'Board for everyone', text: `The bridge is out. ${mark('stage_card_all', ['dm', 'jess', 'tom'], 'a stage card shown to everyone')}`, show: true });
// A party pin under fog on the map the table screen shows: the table (and every player) must never get it, whatever the page does.
const fogw = `/api/worlds/${S.W}`;
await http.ok('PUT', `${fogw}/fog/map/fogmap/enabled`, S.T.dm, { pic: 'none', enabled: true });
await http.ok('POST', `${fogw}/map/fogmap/marks`, S.T.dm, { kind: 'pin', x: 50, y: 50, label: mark('mark_fogged', ['dm'], 'a party pin under fog on the table map'), visibility: 'party' });
await http.ok('PUT', `${fogw}/fog/table`, S.T.dm, { mapId: 'fogmap', pic: 'none' });
const slug = all(made.deps.db, 'SELECT slug FROM worlds WHERE id = ?', S.W)[0].slug;
console.log('LEAKWORLD ' + JSON.stringify({ slug, markers: Object.values(markers), pages: S.pages }));
