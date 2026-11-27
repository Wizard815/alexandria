// A stand-in Foundry world (librarian/test/foundry-stub.js) running the real
// Alexandria Bridge module, for the browser and real-model tests. It ticks
// like the GM's Foundry tab once started.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { root } from './lib.mjs';

export function foundryWorld(base, key, keepPng) {
  const files = { 'worlds/sunken/keep.png': keepPng };
  const ctx = { console: { log() {}, error: console.error, warn() {} }, Blob, File, atob, Buffer, ImageData: class {}, document: { getElementById: () => null, createElement: () => ({ dataset: {} }), body: { appendChild() {} } } };
  ctx.setTimeout = () => 0;
  ctx.clearTimeout = () => {};
  ctx.fetch = async (url, init) => {
    if (/^https?:/.test(url)) return fetch(url, init);
    const f = files[url];
    return f ? new Response(new Uint8Array(f), { headers: { 'Content-Type': 'image/png' } }) : new Response('no', { status: 404 });
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'librarian/test/foundry-stub.js'), 'utf8'), ctx);
  const fv = ctx.makeFoundry({ imageSize: [1600, 1000] });
  Object.assign(ctx, fv.api);
  ctx.globalThis = ctx;
  const mod = fs.readFileSync(path.join(root, 'librarian/src/features/foundry/client/alexandria.js'), 'utf8');
  vm.runInContext(`${mod.replace(/^export /gm, '')}\n;globalThis.__alx = { fogPixels };`, ctx);
  const jessU = fv.user('jess', false), tomU = fv.user('tom', false);
  const jess = fv.addActor('Jessamine', 'character', [jessU], 24, 24);
  const tom = fv.addActor('Tomas', 'character', [tomU], 31, 31);
  const gob = fv.addActor('Goblin boss', 'npc', [], 21, 21);
  const keep = fv.addScene('Sunken Keep', 'worlds/sunken/keep.png', 1600, 1000, 40);
  const jt = fv.addToken(keep, 'Jessamine', jess, 7, 7);
  const tt = fv.addToken(keep, 'Tomas', tom, 11, 9);
  const gt = fv.addToken(keep, 'Goblin boss', gob, 31, 19);
  fv.addScene('Goblin Warrens', 'worlds/sunken/warrens.png', 2000, 1400, 50);
  fv.ready();
  const m = () => ctx.game.modules.get('alexandria-bridge').api;
  ctx.game.settings.set('alexandria-bridge', 'url', base);
  ctx.game.settings.set('alexandria-bridge', 'key', key);
  let timer = null;
  return {
    fv, ctx, keep, jt, tt, gt, jess,
    async start() { await m().reconnect(); timer = setInterval(() => void m().bridge.tick(), 600); },
    stop() { clearInterval(timer); m().bridge?.stop(); },
    fogPixels: (...a) => ctx.__alx.fogPixels(...a),
  };
}

