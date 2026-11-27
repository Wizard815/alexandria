// Downloading a picture (or a map) from a source: shared by the connectors that import images. Only PNG, JPEG, GIF and WebP, checked by the
// file's own first bytes; never from a private address; never sends a token to another host.
import type { ConnectorContext, SyncRecord } from './connector.ts';
import { createHash } from 'node:crypto';
import type { Block, Entry } from './model.ts';
import { sniffImage } from './records.ts';

/** A host that must never be fetched from a picture address: loopback, private ranges, link-local and local names. */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('::ffff:')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Download one picture. Never sends the API token off the endpoint's own host; a picture on another host is fetched only when the mapped URL
 * is absolute (the GM accepted this endpoint, so its address list is theirs), without the token, never from a private address, and redirects
 * are followed only within the host they started on. Only PNG, JPEG, GIF and WebP (by content type AND by the file's own first bytes), at most
 * `maxBytes`. SVG and anything else is refused. Null: not stored.
 */
export async function downloadImage(url: string, apiOrigin: string, apiHeaders: Record<string, string>, ctx: ConnectorContext, maxBytes: number): Promise<{ data: Uint8Array; mime: string } | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const startOrigin = u.origin;
  if (startOrigin !== apiOrigin && privateHost(u.hostname)) { ctx.log(`Picture skipped: ${u.host} is a private address`); return null; }
  for (let hop = 0; hop < 3; hop++) {
    const prev = ctx.calls?.phase;
    if (ctx.calls) ctx.calls.phase = 'detail';
    try { await ctx.calls?.take(); } finally { if (ctx.calls && prev) ctx.calls.phase = prev; }
    const hdrs: Record<string, string> = u.origin === apiOrigin ? { ...apiHeaders } : {};
    hdrs.Accept = 'image/png,image/jpeg,image/gif,image/webp';
    const r = await ctx.fetch(u.toString(), { headers: hdrs, redirect: 'manual', signal: ctx.signal });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      let next: URL | null = null;
      try { next = loc ? new URL(loc, u) : null; } catch { next = null; }
      if (!next || next.origin !== startOrigin) return null;
      u = next;
      continue;
    }
    // A busy or broken server is worth asking again later; any other refusal is an answer.
    if (r.status === 429 || r.status >= 500) throw new Error(`${u.host} answered ${r.status}`);
    if (!r.ok) return null;
    const type = String(r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(type)) return null;
    const len = Number(r.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = r.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) { reader.cancel().catch(() => {}); return null; }
        chunks.push(value);
      }
    } else {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > maxBytes) return null;
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks);
    const mime = sniffImage(data);
    return mime ? { data, mime } : null;
  }
  return null;
}


const downloadedBy = new WeakMap<object, number>();

/**
 * The image record of a map (or any picture a connector found by address): the file is downloaded now unless the same version (`marker`:
 * address and update time) is already held, within the run's limits (`ctx.imageLimits`: size cap, downloads a run, total held; maps have their
 * own, larger size cap). A download counts as a detail call. Returns null when there is nothing to store (too many this run, not a picture,
 * too big, not reachable); a version already held is returned without a file so it is only linked again.
 */
export async function pictureRecord(ctx: ConnectorContext, a: { externalId: string; pageRef: string; name: string; url: string; updated?: string | null; visible: boolean; map: boolean; origin: string; headers?: Record<string, string> }): Promise<SyncRecord | null> {
  const lim = ctx.imageLimits ?? { maxBytes: 20 * 1024 * 1024, perRun: 20, maxHeld: 500, maxMapBytes: 60 * 1024 * 1024 };
  const held = ctx.heldImages ?? new Map<string, string>();
  const marker = `${a.url}|${a.updated ?? ''}`;
  const rec: SyncRecord = { kind: 'image', externalId: a.externalId, pageRef: a.pageRef, name: a.name, marker, url: a.url, visibility: a.visible ? 'party' : 'dm', ...(a.map ? { map: true } : {}) };
  if (held.get(a.externalId) === marker) return rec;
  const n = downloadedBy.get(ctx) ?? 0;
  const keepOld = (): SyncRecord | null => (held.has(a.externalId) ? { ...rec, marker: held.get(a.externalId)! } : null);
  if (n >= lim.perRun || held.size + n >= lim.maxHeld) { ctx.log(`Picture ${a.name} waits for the next run (${lim.perRun} pictures a run)`); return keepOld(); }
  downloadedBy.set(ctx, n + 1);
  let got: { data: Uint8Array; mime: string } | null = null;
  try { got = await downloadImage(a.url, a.origin, a.headers ?? {}, ctx, a.map ? lim.maxMapBytes : lim.maxBytes); } catch (err: any) { if (ctx.signal.aborted) throw err; ctx.log(`Picture ${a.name} not downloaded: ${String(err?.message ?? err).slice(0, 120)}`); }
  if (got) return { ...rec, mime: got.mime, data: got.data } as SyncRecord;
  ctx.log(`Picture ${a.name} was not stored (not a PNG, JPEG, GIF or WebP, too big, or not reachable)`);
  return keepOld();
}


/** Pictures of one page worth keeping: the most a page queues. */
export const MAX_PICTURES_A_PAGE = 40;
const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const httpUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2000;

/**
 * The pictures a page shows by address, as records queued for the downloader (`later`), so they are stored here and served from here (and
 * kept for offline reading) instead of loaded from the source's servers: its banner or portrait (`picture`, the page's primary picture) and
 * every picture in its text (`inline`). A picture inside a secret block is the GM's even on a shared page; the rest follow the page. A map
 * block's picture is left out (the connector stores maps itself). Nothing is downloaded here.
 */
export function entryPictures(e: Entry): SyncRecord[] {
  if (!e?.externalId) return [];
  const out: SyncRecord[] = [];
  const seen = new Set<string>();
  const shared = e.visibility === 'party';
  const add = (url: string, name: string, inline: boolean, secret: boolean) => {
    if (seen.has(url) || out.length >= MAX_PICTURES_A_PAGE) return;
    seen.add(url);
    out.push({ kind: 'image', externalId: `${e.externalId}#pic:${shortHash(url)}`, pageRef: e.externalId, name: name.slice(0, 300), marker: url, url, later: true, visibility: shared && !secret ? 'party' : 'dm', ...(inline ? { inline: true } : {}) });
  };
  // A map page's picture is the map itself, which the connector stores as a map (Kanka gives it as the entity's image too).
  if (httpUrl(e.banner) && e.type !== 'map') add(e.banner, e.title, false, false);
  const walk = (bs: Block[] | undefined, secret: boolean) => {
    for (const b of Array.isArray(bs) ? bs : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.kind === 'image') { if (httpUrl(b.url)) add(b.url, String(b.alt ?? '') || e.title, true, secret); continue; }
      const kids = (b as any).children;
      if (Array.isArray(kids)) walk(kids, secret || b.kind === 'secret');
    }
  };
  walk(e.blocks, false);
  return out;
}

/** Queued page pictures whose address the connector already stores for the same page (a Kanka map's image is also its portrait): left out, so one file is kept. */
export function withoutDuplicatePictures(records: SyncRecord[]): SyncRecord[] {
  const own = new Set<string>();
  for (const r of records) if (r.kind === 'image' && !r.later && r.url) own.add(`${r.pageRef ?? ''}\u0000${r.url}`);
  if (!own.size) return records;
  return records.filter((r) => !(r.kind === 'image' && r.later && r.url && own.has(`${r.pageRef ?? ''}\u0000${r.url}`)));
}
