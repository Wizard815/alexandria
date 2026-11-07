// Alexandria librarian: one server for every world's library, live
// session, calendar, messages and model access.
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.ts';

const dataDir = path.resolve(process.env.ALX_DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.LIBRARIAN_PORT || 8090);

const { app } = createApp({
  dbFile: process.env.ALX_DB || path.join(dataDir, 'librarian.db'),
  dataDir,
  vaultsDir: process.env.ALX_VAULTS_DIR ? path.resolve(process.env.ALX_VAULTS_DIR) : null,
  // The React app, built with `npm run build` in web/.
  webDir: path.resolve(process.env.ALX_WEB_DIR || new URL('../../web/dist', import.meta.url).pathname),
});

app.listen(port, () => {
  console.log(`Alexandria librarian on :${port} (data in ${dataDir})`);
  console.log('First run? POST /api/setup with {username, password} to create the admin.');
});
