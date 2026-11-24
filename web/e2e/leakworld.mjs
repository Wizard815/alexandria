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
// Library sharing: per-player shares, a folder rule for one player (with a classified page inside it), and a file given to one player.
// A per-player share reaches that player only; a folder rule never lifts a classified page; a file shared with Jess is not Tom's.
const lib = `${fogw}/library/pages`;
const sharePage = await http.ok('PUT', lib, S.T.dm, { path: 'Shared/Jess Only.md', visibility: 'dm', body: `A page only Jess was sent. ${mark('share_page_jess', ['dm', 'jess'], 'a DM page shared with Jess only')}` });
await http.ok('PUT', `${fogw}/libshare/share`, S.T.dm, { kind: 'page', id: sharePage.id, mode: 'players', players: [S.ID.jess], notify: true });
const ruleOpen = await http.ok('PUT', lib, S.T.dm, { path: 'Tom Folder/Open.md', visibility: 'dm', body: `In a folder shared with Tom. ${mark('share_folder_tom', ['dm', 'tom'], 'a DM page in a folder shared with Tom only')}` });
const ruleHidden = await http.ok('PUT', lib, S.T.dm, { path: 'Tom Folder/Sealed.md', visibility: 'classified', body: `Sealed. ${mark('share_folder_classified', ['dm'], 'a classified page inside a shared folder', { long: true, ai: false })}` });
const ruleBroker = await http.ok('PUT', lib, S.T.dm, { path: 'Tom Folder/Broker.md', visibility: 'broker', body: `For sale. ${mark('share_folder_broker', ['dm'], 'a broker page inside a shared folder')}` });
await http.ok('PUT', `${fogw}/libshare/share`, S.T.dm, { kind: 'folder', sourceId: '', path: 'Tom Folder', mode: 'players', players: [S.ID.tom], confirm: true });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const fname = mark('share_file_jess', ['dm', 'jess'], 'the name of a file given to Jess only');
const up = await fetch(`http://127.0.0.1:${port}${fogw}/files?page=${sharePage.id}&name=${encodeURIComponent(fname)}.png&level=dm`, { method: 'POST', headers: { Authorization: `Bearer ${S.T.dm}`, 'Content-Type': 'application/octet-stream' }, body: png });
const upFile = await up.json();
await http.ok('PUT', `${fogw}/libshare/share`, S.T.dm, { kind: 'file', id: upFile.id, mode: 'players', players: [S.ID.jess], notify: true });
Object.assign(S.pages, { share_page_jess: { id: sharePage.id }, share_folder_tom: { id: ruleOpen.id }, share_folder_classified: { id: ruleHidden.id }, share_folder_broker: { id: ruleBroker.id } });
const slug = all(made.deps.db, 'SELECT slug FROM worlds WHERE id = ?', S.W)[0].slug;
console.log('LEAKWORLD ' + JSON.stringify({ slug, markers: Object.values(markers), pages: S.pages }));
