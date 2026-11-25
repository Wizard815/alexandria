// Speech to text on this device (the world's speechToText is 'device' or 'auto'). The recording engine hands every
// chunk it uploads to `deviceStt.take()`: when this device can keep up, the chunk is uploaded with `wait=1` and its
// text follows; otherwise (no model, a failure, or more than a few chunks behind) the server is told to do it, so the
// transcript never has a gap. Nothing here loads until a session actually records with on-device speech to text.
//
// Which engine: WebGPU when the browser has a usable GPU (Whisper base; tiny on phones), else WebAssembly on the CPU
// (Whisper tiny, 'device' mode only). 'auto' uses the device only with WebGPU.
import { useSyncExternalStore } from 'react';

export type SttMode = 'server' | 'device' | 'auto';
export type SttState = 'off' | 'unsupported' | 'loading' | 'ready' | 'running' | 'behind' | 'error';
export interface SttView {
  mode: SttMode;
  /** off: the server transcribes (by mode, or this device opted out); unsupported: cannot here; loading, ready, running, behind, error. */
  state: SttState;
  backend: '' | 'webgpu' | 'wasm';
  model: string;
  /** Download progress of the model, 0..1, while loading. */
  progress: number | null;
  /** Processing time over audio time, averaged over recent chunks (0.2 = five times faster than real time). */
  rtf: number | null;
  /** Chunks waiting for this device. */
  backlog: number;
  /** Chunks this device transcribed, and chunks it handed to the server, this session. */
  done: number;
  handed: number;
  note: string;
}

const OPT_OUT = 'alx.audio.sttLocal';
const BEHIND = 3;
const safe = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

/** Whether this browser could run a speech model, and how. Cheap: asks for a GPU adapter, loads nothing. */
export async function sttCapability(): Promise<{ webgpu: boolean; f16: boolean; wasm: boolean; mobile: boolean; workers: boolean }> {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  let webgpu = false; let f16 = false;
  try {
    const gpu = (navigator as any).gpu;
    const a = gpu ? await gpu.requestAdapter() : null;
    if (a && !a.isFallbackAdapter && !a.info?.isFallbackAdapter) { webgpu = true; f16 = !!a.features?.has?.('shader-f16'); }
  } catch { /* no GPU */ }
  return { webgpu, f16, wasm: typeof WebAssembly === 'object', mobile, workers: typeof Worker === 'function' };
}

interface Job { id: number; blob: Blob; durMs: number; resolve: (r: Result) => void }
type Result = { ok: true; words?: { word: string; start: number; end: number }[]; segments?: { text: string; start: number; end: number }[]; ms: number } | { ok: false; error: string };

class DeviceStt {
  view: SttView = { mode: 'server', state: 'off', backend: '', model: '', progress: null, rtf: null, backlog: 0, done: 0, handed: 0, note: '' };
  private subs = new Set<() => void>();
  private worker: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private queue: Job[] = [];
  private running = false;
  private nextId = 1;
  private waiting = new Map<number, (r: Result) => void>();
  private rtfs: number[] = [];
  private behind = false;

  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getView = () => this.view;
  private set(p: Partial<SttView>) { this.view = { ...this.view, ...p }; for (const f of this.subs) f(); }

  /** This device's own choice (players can keep their phone's battery): on unless turned off here. */
  get allowed() { return safe(() => localStorage.getItem(OPT_OUT) !== 'off', true); }
  setAllowed(v: boolean) { safe(() => localStorage.setItem(OPT_OUT, v ? 'on' : 'off'), undefined); if (!v) this.stop('This device is set not to transcribe'); }

  /** Is this device transcribing right now (a chunk taken now would wait for this device's text)? */
  get active() { return (this.view.state === 'ready' || this.view.state === 'running') && !this.behind; }

  /**
   * A session is recording with this world mode. Loads the model when this device should transcribe (and can).
   * `assets` is what /audio/stt/assets returned (null: the server does not serve the model files).
   */
  async start(mode: SttMode, assets: { lib: string; models: string } | null) {
    this.set({ mode, done: 0, handed: 0, backlog: 0, note: '' });
    this.behind = false;
    if (mode === 'server') return this.stop('', 'off');
    if (!this.allowed) return this.stop('This device is set not to transcribe', 'off');
    if (this.ready) { await this.ready; return; }
    const cap = await sttCapability();
    if (!assets) return this.stop('This server does not serve speech models', 'unsupported');
    if (!cap.workers) return this.stop('This browser cannot run a speech model', 'unsupported');
    let backend: 'webgpu' | 'wasm';
    if (cap.webgpu) backend = 'webgpu';
    else if (mode === 'device' && cap.wasm) backend = 'wasm';
    else return this.stop(mode === 'auto' ? 'No usable GPU here, so the server transcribes this mic' : 'This browser cannot run a speech model', 'unsupported');
    const small = backend === 'wasm' || cap.mobile;
    const model = `onnx-community/whisper-${small ? 'tiny' : 'base'}_timestamped`;
    const dtype = backend === 'wasm' ? 'q8' : cap.f16 ? { encoder_model: 'fp16', decoder_model_merged: 'q4f16' } : { encoder_model: 'fp32', decoder_model_merged: 'q4' };
    this.set({ state: 'loading', backend, model: `whisper-${small ? 'tiny' : 'base'}`, progress: 0, note: '' });
    this.ready = new Promise<boolean>((resolve) => {
      try {
        const w = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
        this.worker = w;
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') this.set({ progress: Math.max(0, Math.min(1, m.pct)) });
          else if (m.type === 'ready') { this.set({ state: 'ready', progress: null }); resolve(true); }
          else if (m.type === 'error') { this.fail(`The speech model did not load: ${m.message}`); resolve(false); }
          else if (m.type === 'result') { const f = this.waiting.get(m.id); this.waiting.delete(m.id); f?.(m.ok ? { ok: true, words: m.words, segments: m.segments, ms: m.ms } : { ok: false, error: m.error ?? 'failed' }); }
        };
        w.onerror = (e) => { e.preventDefault?.(); this.fail('The speech model stopped working'); resolve(false); };
        w.postMessage({ type: 'load', lib: assets.lib, models: assets.models, model, device: backend, dtype });
      } catch (err: any) { this.fail(String(err?.message ?? err)); resolve(false); }
    });
    await this.ready;
  }

  private fail(note: string) {
    this.worker?.terminate();
    this.worker = null;
    for (const f of this.waiting.values()) f({ ok: false, error: note });
    this.waiting.clear();
    for (const j of this.queue.splice(0)) j.resolve({ ok: false, error: note });
    this.set({ state: 'error', note, progress: null, backlog: 0 });
  }

  /** The session stopped (or the mode is server): free the model. */
  stop(note = '', state: SttState = 'off') {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const f of this.waiting.values()) f({ ok: false, error: 'stopped' });
    this.waiting.clear();
    for (const j of this.queue.splice(0)) j.resolve({ ok: false, error: 'stopped' });
    this.running = false;
    this.set({ state, note, progress: null, backlog: 0, ...(state === 'off' || state === 'unsupported' ? { backend: '', model: '' } : {}) });
  }

  /** Transcribe one chunk (resolves with its words, or not ok: the caller then hands it to the server). */
  transcribe(blob: Blob, durMs: number): Promise<Result> {
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, blob, durMs, resolve });
      this.set({ backlog: this.queue.length + (this.running ? 1 : 0) });
      void this.pump();
    });
  }

  /** Record that a chunk went to the server instead (counted for the status line). */
  handedOver() { this.set({ handed: this.view.handed + 1 }); }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && this.worker) {
        // More than a few chunks behind: the oldest waiting ones go to the server, this device catches up.
        if (this.queue.length > BEHIND) {
          this.behind = true;
          for (const j of this.queue.splice(0, this.queue.length - 1)) j.resolve({ ok: false, error: 'behind' });
          this.set({ state: 'behind', note: 'This device is falling behind; the server is taking some chunks' });
        }
        const job = this.queue.shift()!;
        this.set({ backlog: this.queue.length + 1, state: this.behind ? 'behind' : 'running' });
        let audio: Float32Array;
        try { audio = await decode16k(job.blob); } catch { job.resolve({ ok: false, error: 'This browser could not decode the audio' }); continue; }
        const r = await new Promise<Result>((resolve) => { const id = job.id; this.waiting.set(id, resolve); this.worker?.postMessage({ type: 'run', id, audio }, [audio.buffer]); });
        if (r.ok) {
          this.rtfs.push(r.ms / Math.max(1, job.durMs));
          if (this.rtfs.length > 8) this.rtfs.shift();
          const rtf = this.rtfs.reduce((a, b) => a + b, 0) / this.rtfs.length;
          this.set({ rtf: Math.round(rtf * 100) / 100, done: this.view.done + 1 });
          // Caught up again, and fast enough to stay so.
          if (this.behind && this.queue.length <= 1 && rtf < 0.9) { this.behind = false; this.set({ note: '' }); }
        }
        job.resolve(r);
      }
    } finally {
      this.running = false;
      if (this.worker && this.view.state !== 'error') this.set({ backlog: this.queue.length, state: this.behind ? 'behind' : this.queue.length ? 'running' : 'ready' });
    }
  }
}

/** A recorded chunk (webm/ogg) as 16 kHz mono samples, the rate Whisper listens at. */
async function decode16k(blob: Blob): Promise<Float32Array> {
  const OAC = window.OfflineAudioContext ?? (window as any).webkitOfflineAudioContext;
  const ctx = new OAC(1, 16000, 16000);
  const buf: AudioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  if (buf.sampleRate === 16000 && buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const off = new OAC(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0).slice();
}

export const deviceStt = new DeviceStt();
export const useDeviceStt = () => useSyncExternalStore(deviceStt.subscribe, deviceStt.getView);

export const STT_MODE_LABELS: Record<SttMode, string> = {
  server: 'On the server',
  device: 'On each device',
  auto: 'Auto (device when it has a GPU)',
};

/** A short line for a mic's speech to text, as the DM sees it. */
export function sttLine(s: { mode: SttMode; device: null | { state: string; backend: string; model: string; rtf: number | null; backlog: number; progress: number | null; note: string }; chunks: { device: number; server: number; awaiting: number; pending: number } } | undefined): { where: 'device' | 'server' | 'loading'; text: string } {
  if (!s) return { where: 'server', text: '' };
  const c = s.chunks;
  const counts = `${c.device} on device, ${c.server} on server${c.awaiting ? `, ${c.awaiting} waiting` : ''}`;
  const d = s.device;
  if (s.mode === 'server' || !d || d.state === 'off' || d.state === 'unsupported' || d.state === 'error') {
    const why = s.mode === 'server' ? '' : d?.note ? ` (${d.note})` : d ? '' : ' (no report from the device yet)';
    return { where: 'server', text: `Server${why} · ${counts}` };
  }
  if (d.state === 'loading') return { where: 'loading', text: `Loading ${d.model || 'the model'} on the device${d.progress !== null ? ` (${Math.round(d.progress * 100)}%)` : ''}` };
  const speed = d.rtf !== null ? ` · ${d.rtf <= 0 ? '—' : `${(1 / Math.max(0.01, d.rtf)).toFixed(d.rtf > 0.5 ? 1 : 0)}× real time`}` : '';
  return { where: 'device', text: `Device · ${d.backend === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'} · ${d.model}${speed}${d.state === 'behind' ? ' · behind, server helping' : ''} · ${counts}` };
}
