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
import { MODEL_ENV, client, fakeModels, markers } from '../../librarian/test/security-kit.ts';

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
const slug = all(made.deps.db, 'SELECT slug FROM worlds WHERE id = ?', S.W)[0].slug;
console.log('LEAKWORLD ' + JSON.stringify({ slug, markers: Object.values(markers), pages: S.pages }));
