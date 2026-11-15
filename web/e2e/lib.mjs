// Shared parts of the browser crawlers (buttons.mjs, leaks.mjs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
export const here = path.dirname(new URL(import.meta.url).pathname);
export const root = path.resolve(here, '../..');

/** Start a script from librarian/scripts under Node's type stripping and wait until it prints `ready`. */
export async function startScript(script, args, ready, tag) {
  const srv = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script, ...args], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; if (process.env.E2E_VERBOSE) process.stderr.write(`[${tag}] ${d}`); });
  for (let i = 0; i < 300 && !out.includes(ready); i++) await new Promise((r) => setTimeout(r, 200));
  if (!out.includes(ready)) { console.log(out); srv.kill(); throw new Error(`${tag} did not start`); }
  return { srv, out };
}

export const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `alx-${name}-`));

export async function signIn(browser, base, user, pass, viewport, mobile, landing = /\/w\/saltreach/) {
  const ctx = await browser.newContext({ viewport, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  await page.goto(base + '/login');
  await page.getByLabel(/username/i).fill(user);
  await page.getByLabel(/password/i).fill(pass);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL(landing, { timeout: 15000 });
  return { ctx, page };
}

export const DM_ROUTES = ['', 'combat', 'quick', 'party', 'approvals', 'broker', 'clock', 'sessionlog', 'sound', 'audio', 'stage', 'chat', 'library', 'people', 'relations', 'map', 'requests', 'messages', 'calendar', 'whiteboard', 'rules', 'sculpt', 'worldlore', 'settings', 'connect'];
export const PLAYER_ROUTES = ['', 'live', 'library', 'broker', 'people', 'me', 'inventory', 'map', 'messages', 'calendar', 'ask', 'whiteboard', 'connect', 'rules', 'chat', 'sessionlog', 'stage', 'audio'];

/** Console noise that is expected: permission checks (403/404), fonts, ResizeObserver. */
export const quiet = (t) => /Failed to load resource.*(40[34])|fonts\.g|net::ERR_|ResizeObserver/.test(t);
