// Optional write-back of a library file to the source its page came from,
// when the GM ticks "Also send to <source>". Uses the source's own connection
// credentials (effectiveConfig), one explicit upload per file, never for a
// classified file. Supported:
//   Kanka (API token):    POST /campaigns/{id}/entities/{entity}/entity_assets
//                         (multipart: name (max 45), type_id=1, visibility_id, files).
//                         visibility_id 1 (everyone) only for a party file, else 2 (admins).
//   LegendKeeper (API key): the three-step image upload of the v3 API, into the
//                         project's asset library (there is no multipart POST):
//                           1. POST {project api}/assets/uploads  { contentType, contentLength, contentHash }
//                              -> { uploadKey, uploadUrl, method: PUT, headers, expiresAt }
//                           2. PUT the bytes to uploadUrl with exactly those headers (no API key)
//                           3. POST {project api}/assets/images   { uploadKey, name }  -> Asset
//                         JPEG, PNG, GIF and WebP only; other files are not offered.
// See docs/API_VERIFICATION.md.
// Any other source (mcp-kanka, LegendKeeper MCP, Markdown, generic API: it has
// no upload role) cannot receive files, so the option is not offered.
import { createHash, randomUUID } from 'node:crypto';
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { effectiveConfig } from '../../intake/connections.ts';
import { connectorFor } from '../../intake/registry.ts';
import { kankaBase } from '../../intake/connectors/kanka.ts';
import { privateHost } from '../../intake/images.ts';

export interface Target { sourceId: string; sourceName: string; app: 'Kanka' | 'LegendKeeper' }
export interface Remote { source: string; app: string; id: string | null; error: string | null; at: string }

const KANKA_EID = /^kanka:(\d{1,12})$/;
const LK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The picture types LegendKeeper's createImageUpload accepts. */
export const LK_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Where this file could be sent, or null (option hidden). A classified file is never sent anywhere.
 * `mime` (when known) hides LegendKeeper for anything but its four picture types.
 */
export function targetFor(d: Deps, worldId: string, page: { source_id: string | null; external_id: string | null }, level: string, mime?: string): Target | null {
  if (level === 'classified' || !page.source_id || !page.external_id) return null;
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ? AND world_id = ?', page.source_id, worldId);
  if (!src || !src.enabled) return null;
  const cfg = effectiveConfig(d.db, src);
  const c = connectorFor(src.kind, cfg);
  if (c?.id === 'kanka-api' && cfg.token && cfg.campaignId && KANKA_EID.test(page.external_id)) return { sourceId: src.id, sourceName: src.name, app: 'Kanka' };
  if (c?.id === 'legendkeeper-api' && cfg.apiKey && cfg.apiUrl && LK_ID.test(page.external_id) && (mime === undefined || LK_IMAGE_TYPES.has(mime))) return { sourceId: src.id, sourceName: src.name, app: 'LegendKeeper' };
  return null;
}

/** Kanka limits an asset's name to 45 characters; keep the extension when the name is cut. */
export function kankaAssetName(name: string): string {
  if (name.length <= 45) return name;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  return name.slice(0, 45 - ext.length) + ext;
}

const form = (name: string, mime: string, bytes: Uint8Array, extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  f.set('name', kankaAssetName(name));
  // The documented field is `files` ("the file or files to be uploaded", exclusive and required for type_id 1).
  f.set('files', new Blob([Buffer.from(bytes)], { type: mime }), name);
  return f;
};

const REFUSED = 'The source refused the upload';

/** One request with a short wait-and-retry on 429 (Retry-After, in seconds). Returns the response when it is ok. */
async function request(d: Deps, url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await d.fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
    if (r.status === 429 && attempt < 2) {
      const ra = Number(r.headers.get('retry-after'));
      await new Promise((ok) => setTimeout(ok, Math.min(Number.isFinite(ra) ? ra : 2, 10) * 1000));
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new Error(`${REFUSED} (${r.status}). The token or key must be allowed to write.`);
    if (r.status === 402) throw new Error('LegendKeeper API keys need the project owner on a paid plan');
    if (r.status === 413) throw new Error('The source is out of storage space or the file is too large (413)');
    if (!r.ok) throw new Error(`The source answered ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    return r;
  }
}

const post = async (d: Deps, url: string, token: string, body: FormData): Promise<any> =>
  (await request(d, url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body })).json().catch(() => ({}));

const lkJson = async (d: Deps, url: string, key: string, idem: string, body: unknown): Promise<any> =>
  (await request(d, url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': idem }, body: JSON.stringify(body) })).json().catch(() => ({}));

/** The three LegendKeeper image-upload calls. Returns the created asset's id. */
async function lkUploadImage(d: Deps, apiUrl: string, key: string, f: { name: string; mime: string; bytes: Uint8Array }): Promise<string | null> {
  if (!LK_IMAGE_TYPES.has(f.mime)) throw new Error('LegendKeeper takes only JPEG, PNG, GIF and WebP pictures');
  const root = apiUrl.replace(/\/$/, '');
  const run = randomUUID();
  const hash = createHash('sha256').update(f.bytes).digest('hex');
  const up = await lkJson(d, `${root}/assets/uploads`, key, `alx-up-${run}`, { contentType: f.mime, contentLength: f.bytes.length, contentHash: hash });
  if (!up?.uploadKey || typeof up.uploadUrl !== 'string') throw new Error('LegendKeeper did not return an upload address');
  let target: URL;
  try { target = new URL(up.uploadUrl); } catch { throw new Error('LegendKeeper returned a bad upload address'); }
  if (target.protocol !== 'https:' || privateHost(target.hostname)) throw new Error('LegendKeeper returned an upload address that is not a public https address');
  // Storage takes exactly the headers it signed, and never our API key.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(up.headers ?? {})) if (typeof v === 'string' && !/^authorization$/i.test(k)) headers[k] = v;
  const put = await d.fetch(target.toString(), { method: String(up.method || 'PUT'), headers, body: Buffer.from(f.bytes), signal: AbortSignal.timeout(120_000) });
  if (!put.ok) throw new Error(`LegendKeeper storage answered ${put.status} for the upload`);
  const asset = await lkJson(d, `${root}/assets/images`, key, `alx-img-${run}`, { uploadKey: up.uploadKey, name: f.name.slice(0, 200) || 'file' });
  return asset?.id !== undefined ? String(asset.id) : null;
}

/** Upload one file. Returns the id the source gave it. Throws a readable Error on failure. */
export async function sendFile(d: Deps, worldId: string, page: { source_id: string | null; external_id: string | null }, f: { name: string; mime: string; level: string; bytes: Uint8Array }): Promise<{ target: Target; remoteId: string | null }> {
  const target = targetFor(d, worldId, page, f.level, f.mime);
  if (!target) throw new Error('This file cannot be sent to a source (classified, or the source takes no file of this type)');
  const src = one<any>(d.db, 'SELECT * FROM sources WHERE id = ?', target.sourceId)!;
  const cfg = effectiveConfig(d.db, src);
  if (target.app === 'Kanka') {
    const eid = KANKA_EID.exec(page.external_id!)![1];
    const url = `${kankaBase(cfg)}/campaigns/${encodeURIComponent(String(cfg.campaignId))}/entities/${eid}/entity_assets`;
    const j = await post(d, url, String(cfg.token), form(f.name, f.mime, f.bytes, { type_id: '1', visibility_id: f.level === 'party' ? '1' : '2' }));
    return { target, remoteId: j?.data?.id !== undefined ? String(j.data.id) : null };
  }
  return { target, remoteId: await lkUploadImage(d, String(cfg.apiUrl), String(cfg.apiKey), f) };
}
