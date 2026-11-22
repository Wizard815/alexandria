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

export const DM_ROUTES = ['', 'combat', 'quick', 'party', 'inbox', 'approvals', 'broker', 'clock', 'sessionlog', 'bible', 'sound', 'audio', 'stage', 'screens', 'chat', 'library', 'people', 'relations', 'map', 'requests', 'messages', 'calendar', 'whiteboard', 'rules', 'sculpt', 'generators', 'worldlore', 'minerva', 'settings', 'connect', 'phone'];
export const PLAYER_ROUTES = ['', 'live', 'library', 'broker', 'people', 'me', 'inventory', 'map', 'messages', 'calendar', 'ask', 'whiteboard', 'connect', 'rules', 'chat', 'sessionlog', 'bible', 'stage', 'audio', 'journal'];

/** Console noise that is expected: permission checks (403/404), fonts, ResizeObserver. */
export const quiet = (t) => /Failed to load resource.*(40[34])|fonts\.g|net::ERR_|ResizeObserver/.test(t);

export const DESTRUCTIVE = /delete|remove|sign out|log ?out|wipe|unload|end (the )?(session|combat|fight)|clear|discard|revoke|purge|reset|disconnect|✕|×|trash|archive|stop (session|recording)|kick|\bban\b|leave world/i;

// Helper installed in every page: lists and finds controls the same way every time.
export const INIT = () => {
  const SEL = 'button, a[href], [role=button], [role=tab], [role=switch], [role=menuitem], summary, input[type=checkbox], input[type=radio]';
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const region = (e) => e.closest('#alx-dock') ? 'dock' : e.closest('[role=dialog], [aria-modal=true], .modal') ? 'overlay' : e.closest('nav, .topbar, .side, .dm-phonebar, .bottomnav, .sheet, .side-foot') ? 'shell' : 'main';
  const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || e.getAttribute('href') || e.getAttribute('name') || 'unnamed').trim().replace(/\s+/g, ' ').slice(0, 60);
  window.__crawl = {
    list() {
      const counts = {};
      return [...document.querySelectorAll(SEL)].filter((e) => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.closest('[inert]')).map((e) => {
        const r = region(e), l = label(e), k = `${r}|${l}`;
        counts[k] = (counts[k] ?? -1) + 1;
        const submit = e.tagName === 'BUTTON' && !!e.form && (e.type === 'submit');
        return { region: r, label: l, key: k, nth: counts[k], href: e.tagName === 'A' ? e.getAttribute('href') : null, target: e.getAttribute('target'), download: e.hasAttribute('download'), submit, title: e.getAttribute('title') || '', selected: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true' || (e.getAttribute('aria-current') ?? 'false') !== 'false' };
      });
    },
    find(key, nth) {
      const counts = {};
      for (const e of document.querySelectorAll(SEL)) {
        if (!visible(e) || e.disabled) continue;
        const k = `${region(e)}|${label(e)}`;
        counts[k] = (counts[k] ?? -1) + 1;
        if (k === key && counts[k] === nth) return e;
      }
      return null;
    },
    snap() {
      let h = 0; const s = document.body.innerHTML;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      let ls = ''; try { ls = JSON.stringify(localStorage); } catch { /* blocked */ }
      return `${location.href}#${h}#${s.length}#${ls.length}#${document.querySelectorAll('dialog[open], [role=dialog]').length}#${document.activeElement?.tagName}`;
    },
  };
};

