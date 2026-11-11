// Alexandria's service worker: keeps the app itself (HTML, scripts, styles,
// fonts) on the device so it opens with no connection. World data is not
// cached here; the app keeps that per account in IndexedDB.
const SHELL = 'alx-shell-v1';
const NEVER = /^\/(api|mcp|v1|dav|health)(\/|$)/;

async function cacheShell() {
  const cache = await caches.open(SHELL);
  const res = await fetch('/', { cache: 'no-store' });
  if (!res.ok) return;
  const html = await res.clone().text();
  await cache.put('/index.html', res);
  // The built scripts and styles index.html names, so the first visit works offline too.
  const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
  // Fonts and images the stylesheets point at.
  for (const u of urls.filter((x) => x.endsWith('.css'))) {
    const css = await (await cache.match(u))?.text();
    const refs = [...(css || '').matchAll(/url\(["']?(\/assets\/[^"')?#]+)/g)].map((m) => m[1]);
    await Promise.all(refs.map((r) => cache.add(r).catch(() => {})));
  }
  return urls;
}

self.addEventListener('install', (e) => {
  e.waitUntil(cacheShell().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;

  // Pages: network first, so a new build shows up at once; the saved shell offline.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
          const copy = res.clone();
          e.waitUntil((async () => {
            const cache = await caches.open(SHELL);
            await cache.put('/index.html', copy);
            // Drop built files the new index.html no longer uses.
            const html = await (await cache.match('/index.html')).text();
            const keep = new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]));
            for (const r of await cache.keys()) {
              const p = new URL(r.url).pathname;
              if (p.startsWith('/assets/') && /\.(js|css)$/.test(p) && !keep.has(p)) await cache.delete(r);
            }
            await Promise.all([...keep].map((u) => cache.match(u).then((hit) => hit || cache.add(u).catch(() => {}))));
          })());
        }
        return res;
      } catch {
        return (await caches.match('/index.html')) || new Response('Alexandria is offline and has not been saved on this device yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Built files have content hashes: cache first. Other same-origin files: refresh in the background.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req);
    const net = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') e.waitUntil(cache.put(req, res.clone()));
      return res;
    });
    if (hit) {
      if (!url.pathname.startsWith('/assets/')) e.waitUntil(net.catch(() => {}));
      return hit;
    }
    try { return await net; } catch { return new Response('', { status: 504 }); }
  })());
});
