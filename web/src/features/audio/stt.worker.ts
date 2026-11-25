// Speech to text on this device, off the page's main thread. The library (transformers.js) and the Whisper model
// files come from the librarian (/api/stt/...), never from another site, and only once a session records with
// speech to text on this device: nothing is fetched for anyone else.
//
// Messages in:  { type: 'load', lib, models, model, device, dtype }   { type: 'run', id, audio: Float32Array (16 kHz) }
// Messages out: { type: 'progress', pct, file }  { type: 'ready', ms }  { type: 'error', message }
//               { type: 'result', id, ok, words?: { word, start, end }[], segments?: { text, start, end }[], ms, error? }

interface Ctx { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null; location: Location }
const ctx = self as unknown as Ctx;
let pipe: ((audio: Float32Array, opts: Record<string, unknown>) => Promise<any>) | null = null;
/** Whether the model gives word times; when it fails once, segments are asked for instead. */
let wordTimes = true;

/** Model-file requests carry a ticket in their path: the cache key leaves it out, so a new ticket does not mean a new download. */
const norm = (r: RequestInfo | URL) => String(typeof r === 'string' || r instanceof URL ? r : r.url).replace(/\/api\/stt\/[^/]+\/models\//, '/api/stt/_/models/');

async function load(m: { lib: string; models: string; model: string; device: string; dtype: unknown }) {
  const origin = ctx.location.origin;
  const libUrl = new URL(`${m.lib}transformers.min.js`, origin).href;
  const T: any = await import(/* @vite-ignore */ libUrl);
  T.env.allowLocalModels = false;
  T.env.allowRemoteModels = true;
  T.env.remoteHost = new URL(m.models, origin).href;
  T.env.remotePathTemplate = '{model}/resolve/{revision}/';
  T.env.backends.onnx.wasm = { ...(T.env.backends.onnx.wasm ?? {}), wasmPaths: new URL(m.lib, origin).href, proxy: false };
  const store = typeof caches !== 'undefined' ? await caches.open('alx-stt-models').catch(() => null) : null;
  T.env.useBrowserCache = false;
  if (store) {
    T.env.useCustomCache = true;
    T.env.customCache = { match: (r: RequestInfo) => store.match(norm(r)), put: (r: RequestInfo, res: Response) => store.put(norm(r), res) };
  }
  const files = new Map<string, { loaded: number; total: number }>();
  const p = await T.pipeline('automatic-speech-recognition', m.model, {
    device: m.device, dtype: m.dtype,
    progress_callback: (x: any) => {
      if (x?.status !== 'progress' || !x.file) return;
      files.set(x.file, { loaded: Number(x.loaded) || 0, total: Number(x.total) || 0 });
      let a = 0; let b = 0;
      for (const f of files.values()) { a += f.loaded; b += f.total; }
      ctx.postMessage({ type: 'progress', pct: b ? a / b : 0, file: x.file });
    },
  });
  return p;
}

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m?.type === 'load') {
    const t0 = performance.now();
    try {
      pipe = await load(m);
      // One short run so the first real chunk is not slowed by shader compilation.
      await pipe!(new Float32Array(16000), { return_timestamps: true }).catch(() => null);
      ctx.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) });
    } catch (err: any) {
      pipe = null;
      ctx.postMessage({ type: 'error', message: String(err?.message ?? err).slice(0, 200) });
    }
    return;
  }
  if (m?.type === 'run') {
    const t0 = performance.now();
    if (!pipe) { ctx.postMessage({ type: 'result', id: m.id, ok: false, error: 'not loaded', ms: 0 }); return; }
    try {
      let out: any = null;
      if (wordTimes) {
        try { out = await pipe(m.audio, { return_timestamps: 'word', chunk_length_s: 30 }); } catch { wordTimes = false; }
      }
      if (out && Array.isArray(out.chunks)) {
        const words = out.chunks.filter((c: any) => typeof c?.text === 'string' && Array.isArray(c.timestamp)).map((c: any) => ({ word: c.text, start: Number(c.timestamp[0]) || 0, end: Number(c.timestamp[1] ?? c.timestamp[0]) || 0 }));
        ctx.postMessage({ type: 'result', id: m.id, ok: true, words, ms: Math.round(performance.now() - t0) });
        return;
      }
      out = await pipe(m.audio, { return_timestamps: true, chunk_length_s: 30 });
      const segments = (Array.isArray(out?.chunks) ? out.chunks : [{ text: String(out?.text ?? ''), timestamp: [0, m.audio.length / 16000] }])
        .map((c: any) => ({ text: String(c.text ?? ''), start: Number(c.timestamp?.[0]) || 0, end: Number(c.timestamp?.[1] ?? m.audio.length / 16000) || 0 }));
      ctx.postMessage({ type: 'result', id: m.id, ok: true, segments, ms: Math.round(performance.now() - t0) });
    } catch (err: any) {
      ctx.postMessage({ type: 'result', id: m.id, ok: false, error: String(err?.message ?? err).slice(0, 200), ms: Math.round(performance.now() - t0) });
    }
  }
};
