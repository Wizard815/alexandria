// Files for speech to text on a recording device: the transformers.js library, its ONNX runtime (WebAssembly) and
// the Whisper model files. The librarian serves them from its own origin, so the app's Content-Security-Policy stays
// 'self' and every device at the table downloads a model from the server (on the LAN) rather than from the internet.
//
// Nothing is bundled: the first device that asks makes the librarian fetch the file once (pinned library version, a
// short allowlist of models and files) and keep it under data/stt-cache. An offline server can be given the files
// in ALX_STT_ASSET_DIR (same layout) instead. ALX_STT_ASSETS=off turns all of it off: devices then report that they
// cannot transcribe, and the server transcribes their audio.
//
//   GET /api/stt/<ticket>/lib/<file>                                the library and its runtime (a signed-in member's ticket)
//   GET /api/stt/<ticket>/models/<org>/<model>/resolve/main/<file>  model files (the same ticket)
//
// Every route needs the ticket, so nobody who is not signed in can make the server download anything. The ticket is in the
// path because a worker's import() and the runtime's own fetches cannot send the sign-in header. It is minted for one account in
// one world, is checked against that membership on every request, and expires (sound/ticket.ts). Without one: 404.
import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { HttpError } from '../../core/util.ts';
import { mintTicket, readTicket } from '../sound/ticket.ts';

export const STT_LIB_VERSION = '3.8.1';
const LIB_FILES = new Set(['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']);
/** Whisper models that carry word timestamps (cross-attention heads), in the sizes a device can run. */
export const STT_MODELS = ['onnx-community/whisper-tiny_timestamped', 'onnx-community/whisper-base_timestamped', 'onnx-community/whisper-tiny.en_timestamped', 'onnx-community/whisper-base.en_timestamped'];
const MODEL_FILE = /^(?:[a-z_]+\.json|onnx\/(?:encoder_model|decoder_model_merged)(?:_(?:fp16|q4|q4f16|int8|uint8|quantized|bnb4))?\.onnx(?:_data)?)$/;
const MAX_BYTES = 400 * 1024 * 1024;

const enabled = (d: Deps) => String(d.env.ALX_STT_ASSETS ?? 'on').toLowerCase() !== 'off';
const cacheRoot = (d: Deps) => d.env.ALX_STT_ASSET_DIR || (d.dataDir ? path.join(d.dataDir, 'stt-cache') : null);

/** What a device needs to load its model: null when this server does not serve the files. */
export function sttAssetsFor(d: Deps, worldId: string, accountId: string) {
  if (!enabled(d) || !cacheRoot(d)) return null;
  const ticket = ticketFor(worldId, accountId);
  return { version: STT_LIB_VERSION, lib: `/api/stt/${ticket}/lib/`, models: `/api/stt/${ticket}/models/`, allowed: STT_MODELS };
}

/** One ticket per account and world for a few hours, so the browser's HTTP cache keeps the library across page loads. */
const tickets = new Map<string, { t: string; at: number }>();
const REUSE_MS = 4 * 3600_000;
function ticketFor(worldId: string, accountId: string) {
  const key = `${worldId}\n${accountId}`;
  const had = tickets.get(key);
  if (had && Date.now() - had.at < REUSE_MS && readTicket(had.t)) return had.t;
  const t = mintTicket({ w: worldId, k: 'stt', f: '', a: accountId });
  tickets.set(key, { t, at: Date.now() });
  if (tickets.size > 5000) for (const [k, v] of tickets) if (Date.now() - v.at >= REUSE_MS) tickets.delete(k);
  return t;
}

/** The ticket is good: signed, not expired, for speech files, and its account is still a member of its world. */
function ticketOk(d: Deps, raw: string) {
  const t = readTicket(raw);
  return !!t && t.k === 'stt' && !!one(d.db, 'SELECT 1 FROM members WHERE world_id = ? AND account_id = ?', t.w, t.a);
}

const inflight = new Map<string, Promise<void>>();

/** The cached copy of `rel`, fetched from `url` the first time (one download however many devices ask at once). */
async function cached(d: Deps, rel: string, url: string): Promise<string> {
  const root = cacheRoot(d)!;
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep) || rel.split(/[\\/]/).includes('..')) throw new HttpError(404, 'File not found');
  if (fs.existsSync(file)) return file;
  let p = inflight.get(file);
  if (!p) {
    p = (async () => {
      const r = await d.fetch(url, { redirect: 'follow' });
      if (!r.ok || !r.body) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'File not found' : 'Could not fetch the speech model files');
      const len = Number(r.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) throw new HttpError(502, 'That file is too large');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.part-${process.pid}-${Date.now()}`;
      let seen = 0;
      const cap = new Transform({ transform(c: Buffer, _e, cb) { seen += c.length; cb(seen > MAX_BYTES ? new HttpError(502, 'That file is too large') : null, c); } });
      try {
        await pipeline(Readable.fromWeb(r.body as any), cap, fs.createWriteStream(tmp));
        fs.renameSync(tmp, file);
      } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    })().finally(() => inflight.delete(file));
    inflight.set(file, p);
  }
  await p;
  return file;
}

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8' };

function sendCached(res: Response, file: string, maxAge: number) {
  res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
  // private: the URL holds a ticket, so no shared cache keeps it.
  res.setHeader('Cache-Control', `private, max-age=${maxAge}${maxAge > 86400 ? ', immutable' : ''}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
}

export function sttAssetRoutes(app: Express, d: Deps) {
  const guard = () => { if (!enabled(d) || !cacheRoot(d)) throw new HttpError(404, 'This server does not serve speech models'); };
  const fail = (res: Response, e: unknown) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error('audio: speech model files', e);
    res.status(502).json({ error: 'Could not fetch the speech model files' });
  };

  app.get(/^\/api\/stt\/([^/]+)\/lib\/([^/]+)$/, async (req: Request, res: Response) => {
    try {
      guard();
      const [ticket, f] = [0, 1].map((i) => String((req.params as any)[i] ?? ''));
      if (!ticketOk(d, ticket) || !LIB_FILES.has(f)) throw new HttpError(404, 'File not found');
      const upstream = (d.env.ALX_STT_LIB_URL || `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${STT_LIB_VERSION}/dist/`).replace(/\/?$/, '/');
      sendCached(res, await cached(d, path.join('lib', STT_LIB_VERSION, f), upstream + f), 365 * 86400);
    } catch (e) { fail(res, e); }
  });

  app.get(/^\/api\/stt\/([^/]+)\/models\/([\w-]+)\/([\w.-]+)\/resolve\/main\/(.+)$/, async (req: Request, res: Response) => {
    try {
      guard();
      const [ticket, org, name, file] = [0, 1, 2, 3].map((i) => String((req.params as any)[i] ?? ''));
      if (!ticketOk(d, ticket)) throw new HttpError(404, 'File not found');
      const model = `${org}/${name}`;
      if (!STT_MODELS.includes(model) || !MODEL_FILE.test(file)) throw new HttpError(404, 'File not found');
      const upstream = (d.env.ALX_STT_MODEL_URL || 'https://huggingface.co/').replace(/\/?$/, '/');
      sendCached(res, await cached(d, path.join('models', org, name, 'main', file), `${upstream}${model}/resolve/main/${file}`), 86400);
    } catch (e) { fail(res, e); }
  });
}
