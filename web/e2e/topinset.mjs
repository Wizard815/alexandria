// The phone top bar sits snugly under the status bar: the inset (--safe-top, i.e. env(safe-area-inset-top)) is applied exactly once,
// as the bar's own top padding, and the bar is one slim row. Checked on the player app and the DM phone layout at 390x844 and
// 412x915, with and without an emulated 36px inset. (Chromium cannot emulate display-mode: standalone; no style depends on it, the inset comes only from env().)
// Run from web/: npm run build && node e2e/topinset.mjs   (TOPINSET_PORT, TOPINSET_SHOTS=<dir>)
import fs from 'node:fs';
import path from 'node:path';
import { chromium, root, startScript, tmpDir, signIn, quiet } from './lib.mjs';

const PORT = Number(process.env.TOPINSET_PORT || 8843);
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.TOPINSET_SHOTS || '/tmp/claude-0/-home-user/26e3dbe6-7466-590f-acf8-13740003567a/scratchpad/workspace';
fs.mkdirSync(SHOTS, { recursive: true });
const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); return ok; };

const { srv } = await startScript('librarian/scripts/demo.ts', ['--port', String(PORT), '--data', path.join(tmpDir('topinset'), 'data'), '--web', path.join(root, 'web/dist')], 'Alexandria demo is running', 'demo');
const browser = await chromium.launch();
try {
  const html = await (await fetch(base + '/')).text();
  check(/viewport-fit=cover/.test(html), 'index.html: viewport-fit=cover is missing');
  check(/theme-color" content="#171C26"/.test(html), 'index.html: theme-color should be the top bar colour #171C26');
  for (const [w, h] of [[390, 844], [412, 915]]) {
    for (const [user, pass, route, bar] of [['jess', 'player pass 123', '/w/saltreach', '.topbar'], ['dm', 'dungeon master 123', '/w/saltreach/dm', '.dmx-top']]) {
      for (const inset of [0, 36]) {
        const { ctx, page } = await signIn(browser, base, user, pass, { width: w, height: h }, true, /\/w\/saltreach/);
        page.on('pageerror', (e) => problems.push(`${user} page error: ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error' && !quiet(m.text())) problems.push(`${user} console: ${m.text()}`); });
        await page.goto(base + route);
        await page.locator(bar).first().waitFor({ state: 'visible' });
        // The browser has no status bar to report: stand in for it by setting the one variable env() feeds.
        await page.addStyleTag({ content: `:root { --safe-top: ${inset}px !important; }` });
        await page.waitForTimeout(800);
        const m = await page.evaluate((sel) => {
          const t = document.querySelector(sel); const r = t.getBoundingClientRect(); const cs = getComputedStyle(t);
          const kids = [...t.children].filter((c) => c.getBoundingClientRect().height > 0);
          const first = Math.min(...kids.map((c) => c.getBoundingClientRect().top));
          const last = Math.max(...kids.map((c) => c.getBoundingClientRect().bottom));
          return { h: r.height, top: r.top, pt: parseFloat(cs.paddingTop), bg: cs.backgroundColor, first, last, docPad: parseFloat(getComputedStyle(document.body).paddingTop) + parseFloat(getComputedStyle(document.documentElement).paddingTop) };
        }, bar);
        const tag = `${user} ${w}x${h} inset ${inset}`;
        check(m.top === 0, `${tag}: bar does not start at the top (${m.top})`);
        check(m.pt >= inset && m.pt <= inset + 6, `${tag}: top padding ${m.pt} is not the inset plus a slim 4-6px`);
        check(m.docPad === 0, `${tag}: body/html also pad the top`);
        check(m.first - m.top <= inset + 12, `${tag}: content starts ${m.first - m.top}px down, more than inset + slim padding`);
        check(m.h <= inset + 56, `${tag}: bar is ${m.h}px tall; it should be one slim row (<= ${inset + 56})`);
        if (inset === 36 && w === 390) await page.screenshot({ path: path.join(SHOTS, `topinset-${user}-${w}.png`), clip: { x: 0, y: 0, width: w, height: 140 } });
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  srv.kill();
}
console.log('');
if (problems.length) { console.log(`${problems.length} problem(s):`); for (const p of problems) console.log(' - ' + p); console.log('\nFAIL'); process.exit(1); }
console.log('topinset: all good');
