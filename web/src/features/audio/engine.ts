// Recording in the browser. This lives outside React so it keeps running as
// the GM or a player moves between pages; the transcript island (an overlay
// on every page) keeps it attached to the signed-in world.
//
// Each mic sends a chunk every 5 seconds. A chunk is its own MediaRecorder (so
// it is a whole, playable file) that starts 3 seconds before its 5-second hop:
// two recorders overlap by 3 s, and the speech model hears each stretch with a
// little of what came before (5 s pieces alone cost about ten points of word
// error). The server uses each stretch from the chunk it is most central in.
// Chunks carry their start and end (ms since the session began, on the
// server's clock) and the average signal level. Hold keys (and on-screen buttons) are sent as hold windows; the
// server honours them. Hold keys only work while this tab is focused.
// When the world runs speech to text on the devices (stt.ts), a chunk this device is transcribing is uploaded with
// wait=1 and its text follows; anything this device cannot do is handed to the server.
import { useSyncExternalStore } from 'react';
import { deviceStt, type SttMode } from './stt.ts';

export type Mode = 'always' | 'hold-to-talk' | 'hold-to-mute' | 'off';
export interface MicSetting {
  /** The browser's id for the input device. */
  deviceId: string;
  label: string;
  /** The device's own name when it was picked: what finds it again if the browser hands out a new id. */
  deviceLabel?: string;
  enabled: boolean;
  mode: Mode;
  playersTranscript: boolean;
  aside: boolean;
  /** KeyboardEvent.code of the hold key, or ''. */
  key: string;
  /** The librarian's id once registered. */
  serverId?: string;
}
export interface MicState { level: number; sent: number; failed: number; recording: boolean; held: boolean; error?: string }
export interface EngineState {
  attached: boolean;
  recording: boolean;
  sessionId: string | null;
  consent: boolean;
  mics: Record<string, MicState>;
  error: string | null;
}

/** One chunk is sent every HOP_MS and carries OVERLAP_MS of the audio before it (except the first). */
const HOP_MS = 5000;
const OVERLAP_MS = 3000;
const safe = <T,>(f: () => T, fallback: T): T => { try { return f(); } catch { return fallback; } };

interface Cfg { baseUrl: string; token: string; worldId: string; isGM: boolean }

/**
 * Open the saved microphone. Some browsers hand out new device ids from one start to the next (WebKit in the desktop
 * app on Linux, Safari, a cleared profile), so when the saved id is gone the microphone with the same name is used.
 */
export async function openMic(s: { deviceId: string; label: string; deviceLabel?: string }): Promise<MediaStream> {
  const md = navigator.mediaDevices;
  if (!s.deviceId) return md.getUserMedia({ audio: true });
  try {
    return await md.getUserMedia({ audio: { deviceId: { exact: s.deviceId } } });
  } catch (e: any) {
    if (e?.name !== 'OverconstrainedError' && e?.name !== 'NotFoundError') throw e;
    const same = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label && d.label === (s.deviceLabel || s.label));
    if (same.length !== 1) throw e;
    return md.getUserMedia({ audio: { deviceId: { exact: same[0].deviceId } } });
  }
}

/**
 * A saved mic whose id the browser no longer lists, moved to the one listed device with the same name; the setting
 * itself when it is still there or the name matches nothing (or several). Device names only show once the
 * microphone was allowed, so with no names listed nothing is changed.
 */
export function healMic<T extends { deviceId: string; label: string; deviceLabel?: string }>(s: T, inputs: { deviceId: string; label: string }[]): T {
  if (!s.deviceId || inputs.some((i) => i.deviceId === s.deviceId)) return s;
  const same = inputs.filter((i) => i.label && i.label === (s.deviceLabel || s.label));
  return same.length === 1 ? { ...s, deviceId: same[0].deviceId, deviceLabel: same[0].label } : s;
}

class Runner {
  e: Engine;
  s: MicSetting;
  stream: MediaStream | null = null;
  ctxA: AudioContext | null = null;
  recs = new Set<MediaRecorder>();
  active = false;
  seq = 0;
  timer: ReturnType<typeof setTimeout> | undefined;
  meter: ReturnType<typeof setInterval> | undefined;
  /** Level samples (time in ms, rms), kept for the last 12 s. */
  samples: { t: number; v: number }[] = [];
  /** Hold spans in session ms; end null while the key is down. */
  holds: { start: number; end: number | null }[] = [];
  queue: Promise<void> = Promise.resolve();
  stopped: Promise<void>[] = [];
  /** Chunk texts this device is still making and sending. */
  texts = new Set<Promise<void>>();

  constructor(e: Engine, s: MicSetting) { this.e = e; this.s = s; }

  async start() {
    this.stream = await openMic(this.s);
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctxA = new AC();
    const an = this.ctxA!.createAnalyser();
    an.fftSize = 1024;
    this.ctxA!.createMediaStreamSource(this.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    this.meter = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();
      this.samples.push({ t: now, v: rms });
      while (this.samples.length && this.samples[0].t < now - 12_000) this.samples.shift();
      this.e.patchMic(this.s.serverId!, { level: Math.min(1, rms * 5) });
    }, 100);
    this.active = true;
    this.begin(HOP_MS);
    this.timer = setTimeout(() => this.tick(), HOP_MS - OVERLAP_MS);
  }

  /** Every hop, a recorder that covers the hop and the OVERLAP_MS before it. */
  private tick() {
    if (!this.active) return;
    this.begin(HOP_MS + OVERLAP_MS);
    this.timer = setTimeout(() => this.tick(), HOP_MS);
  }

  private mime() {
    for (const m of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported?.(m)) return m;
    return '';
  }

  private begin(durMs: number) {
    if (!this.active || !this.stream) return;
    const m = this.mime();
    const rec = new MediaRecorder(this.stream, m ? { mimeType: m } : undefined);
    const parts: Blob[] = [];
    const startMs = this.e.sessionMs();
    const startWall = Date.now();
    rec.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };
    let done!: () => void;
    if (this.stopped.length > 8) this.stopped = this.stopped.slice(-4);
    this.stopped.push(new Promise<void>((r) => { done = r; }));
    rec.onstop = () => {
      this.recs.delete(rec);
      const endMs = this.e.sessionMs();
      const mine = this.samples.filter((x) => x.t >= startWall);
      const level = mine.length ? mine.reduce((a, x) => a + x.v, 0) / mine.length : 0;
      const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
      this.maybeSend(blob, startMs, endMs, level);
      done();
    };
    this.recs.add(rec);
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, durMs);
  }

  private maybeSend(blob: Blob, start: number, end: number, level: number) {
    if (end <= start || !blob.size) return;
    // Hold to talk: nothing leaves this computer unless the key was down during the chunk.
    if (this.s.mode === 'hold-to-talk' && !this.holds.some((h) => h.start < end && (h.end ?? Infinity) > start)) return;
    // Complete silence is not worth sending.
    if (level < 0.0008) { this.holds = this.holds.filter((h) => h.end === null || h.end > end - 60_000); return; }
    // Unique even after a page reload mid-session: the chunk start in centiseconds.
    const seq = Math.max(0, Math.floor(start / 10));
    const lv = Math.min(1, level * 5);
    // This device transcribes the chunk itself (in parallel with the upload) when it is keeping up.
    const text = deviceStt.active ? deviceStt.transcribe(blob, end - start) : null;
    this.queue = this.queue.then(async () => {
      const ok = await this.upload(blob, seq, start, end, lv, !!text);
      if (!ok || !text) return;
      const p: Promise<void> = text.then((r) => this.sendText(seq, r)).finally(() => { this.texts.delete(p); });
      this.texts.add(p);
    });
  }

  private async upload(blob: Blob, seq: number, start: number, end: number, level: number, wait: boolean): Promise<boolean> {
    const sid = this.e.state.sessionId ?? this.e.lastSession;
    if (!sid || !this.s.serverId) return false;
    const url = `${this.e.cfg!.baseUrl}/api/worlds/${encodeURIComponent(this.e.cfg!.worldId)}/audio/sessions/${sid}/chunks?mic=${this.s.serverId}&seq=${seq}&start=${Math.round(start)}&end=${Math.round(end)}&level=${level.toFixed(3)}${wait ? '&wait=1' : ''}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // `sent`: this device's session clock as it sends, so the server can tell how far apart the devices' clocks are.
        const r = await fetch(`${url}&sent=${Math.round(this.e.sessionMs())}`, { method: 'POST', headers: { Authorization: `Bearer ${this.e.cfg!.token}`, 'Content-Type': blob.type || 'audio/webm' }, body: blob });
        if (r.ok) { this.e.patchMic(this.s.serverId!, { sent: (this.e.state.mics[this.s.serverId!]?.sent ?? 0) + 1, error: undefined }); return true; }
        if (r.status === 403 || r.status === 409 || r.status === 413 || r.status === 415) {
          const msg = await r.json().then((j: any) => j.error).catch(() => `Upload refused (${r.status})`);
          this.e.patchMic(this.s.serverId!, { error: msg, failed: (this.e.state.mics[this.s.serverId!]?.failed ?? 0) + 1 });
          if (r.status === 403 || r.status === 409) void this.stop();
          return false;
        }
      } catch { /* offline: try again */ }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    this.e.patchMic(this.s.serverId!, { failed: (this.e.state.mics[this.s.serverId!]?.failed ?? 0) + 1, error: 'Could not upload; the server is unreachable' });
    return false;
  }

  /** This device's text for a chunk it uploaded, or (it could not make any) a note that the server should do it. */
  private async sendText(seq: number, r: Awaited<ReturnType<typeof deviceStt.transcribe>>) {
    const sid = this.e.state.sessionId ?? this.e.lastSession;
    if (!sid || !this.s.serverId) return;
    const v = deviceStt.view;
    const body = r.ok
      ? { ...(r.words ? { words: r.words } : { segments: r.segments ?? [] }), stt: { model: v.model, backend: v.backend, ms: r.ms, rtf: v.rtf } }
      : { giveUp: true };
    if (!r.ok) deviceStt.handedOver();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${this.e.cfg!.baseUrl}/api/worlds/${encodeURIComponent(this.e.cfg!.worldId)}/audio/sessions/${sid}/chunks/${seq}/text?mic=${this.s.serverId}`, { method: 'POST', headers: { Authorization: `Bearer ${this.e.cfg!.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        // Refused (bad text, session long over): the server takes the chunk when its wait runs out.
        if (res.ok || (res.status >= 400 && res.status < 500)) return;
      } catch { /* offline: try again */ }
      await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
    }
  }

  press(now: number) { if (!this.holds.some((h) => h.end === null)) this.holds.push({ start: now, end: null }); }
  release(now: number) { const h = this.holds.find((x) => x.end === null); if (h) h.end = now; return h; }

  async stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);
    clearInterval(this.meter);
    for (const r of this.recs) if (r.state !== 'inactive') r.stop();
    await Promise.all(this.stopped);
    await this.queue;
    // The last chunks' text from this device: waited for a while; whatever is not done by then the server takes.
    if (this.texts.size) await Promise.race([Promise.all(this.texts), new Promise((r) => setTimeout(r, 20_000))]);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctxA?.close();
    this.stream = null; this.ctxA = null; this.recs.clear(); this.stopped = [];
    this.e.patchMic(this.s.serverId!, { recording: false, level: 0, held: false });
  }
}

class Engine {
  cfg: Cfg | null = null;
  state: EngineState = { attached: false, recording: false, sessionId: null, consent: false, mics: {}, error: null };
  lastSession: string | null = null;
  private skew = 0;
  private startedAt = 0;
  private runners = new Map<string, Runner>();
  private subs = new Set<() => void>();
  private asideKey = '';
  private asideOpen: number | null = null;

  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  getState = () => this.state;
  private set(p: Partial<EngineState>) { this.state = { ...this.state, ...p }; for (const f of this.subs) f(); }
  patchMic(id: string, p: Partial<MicState>) {
    const cur = this.state.mics[id] ?? { level: 0, sent: 0, failed: 0, recording: false, held: false };
    this.set({ mics: { ...this.state.mics, [id]: { ...cur, ...p } } });
  }

  sessionMs() { return Date.now() + this.skew - this.startedAt; }

  attach(cfg: Cfg) {
    const changed = !this.cfg || this.cfg.worldId !== cfg.worldId;
    this.cfg = cfg;
    this.asideKey = this.loadAsideKey();
    if (changed) { void this.stopAll(); this.set({ attached: true, recording: false, sessionId: null, mics: {} }); }
    if (!listening) { listening = true; window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey); window.addEventListener('blur', releaseAll); }
  }

  api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const c = this.cfg!;
    return fetch(`${c.baseUrl}/api/worlds/${encodeURIComponent(c.worldId)}/audio${path}`, {
      method, headers: { Authorization: `Bearer ${c.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as any).error ?? `Request failed (${r.status})`);
      return j as T;
    });
  }

  // ---- saved settings (this computer, this world) ----------------------------------
  private key() { return `alx.audio.mics.${this.cfg?.worldId}`; }
  loadMics(): MicSetting[] { return safe(() => JSON.parse(localStorage.getItem(this.key()) ?? '[]'), [] as MicSetting[]); }
  saveMics(list: MicSetting[]) { safe(() => localStorage.setItem(this.key(), JSON.stringify(list)), undefined); this.asideKey = this.loadAsideKey(); }
  loadAsideKey(): string { return safe(() => localStorage.getItem(`alx.audio.asideKey.${this.cfg?.worldId}`) ?? '', ''); }
  saveAsideKey(k: string) { safe(() => localStorage.setItem(`alx.audio.asideKey.${this.cfg?.worldId}`, k), undefined); this.asideKey = k; }
  /** One id per computer, so a GM's mics keep their names across sessions. */
  computerId(): string {
    return safe(() => { let v = localStorage.getItem('alx.audio.computer'); if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem('alx.audio.computer', v); } return v; }, 'tab');
  }

  /** Register (or update) a mic with the librarian; returns the setting with its server id. */
  async register(s: MicSetting): Promise<MicSetting> {
    const m = await this.api<any>('POST', '/mics', { deviceId: `${this.computerId()}:${s.deviceId.slice(0, 40)}`, label: s.label, mode: s.mode, playersTranscript: s.playersTranscript, aside: s.aside });
    return { ...s, serverId: m.id };
  }

  // ---- sessions --------------------------------------------------------------------------
  async refresh() {
    if (!this.cfg) return;
    const st = await this.api<any>('GET', '/status');
    this.skew = Date.parse(st.serverNow) - Date.now();
    this.set({ consent: !!st.consent?.agreed });
    if (st.session) await this.begin(st.session.id, st.session.startedAt);
    else if (this.state.recording) await this.stopAll();
    return st;
  }

  async begin(sessionId: string, startedAt: string) {
    if (this.state.sessionId === sessionId && this.state.recording) return;
    this.startedAt = Date.parse(startedAt);
    this.lastSession = sessionId;
    this.set({ recording: true, sessionId, error: null });
    if (!this.state.consent && !this.cfg?.isGM) return; // starts once they agree
    void this.startStt();
    for (const s of this.loadMics()) if (s.enabled && s.serverId && s.mode !== 'off' && !this.runners.has(s.serverId)) {
      const r = new Runner(this, s);
      this.runners.set(s.serverId, r);
      try { await r.start(); this.patchMic(s.serverId, { recording: true, error: undefined }); } catch (err: any) {
        this.runners.delete(s.serverId);
        this.patchMic(s.serverId, { recording: false, error: err?.name === 'NotAllowedError' ? 'The browser blocked the microphone' : `Could not open ${s.label}: ${err?.message ?? err}` });
      }
    }
  }

  setConsent(agreed: boolean) {
    this.set({ consent: agreed });
    if (!agreed) void this.stopRunners();
    else if (this.state.recording && this.lastSession) { const id = this.lastSession; this.set({ sessionId: null, recording: false }); void this.begin(id, new Date(this.startedAt).toISOString()); }
  }

  private async stopRunners() {
    const rs = [...this.runners.values()];
    const ids = [...this.runners.keys()];
    this.runners.clear();
    this.closeOpenHolds();
    // Each runner waits (a little) for the text of its last chunks from this device before it stops.
    await Promise.all(rs.map((r) => r.stop()));
    this.stopStt(ids);
  }

  async stopAll() {
    await this.stopRunners();
    this.set({ recording: false, sessionId: null });
  }

  // ---- speech to text on this device ------------------------------------------------------
  private sttTimer: ReturnType<typeof setInterval> | undefined;
  private sttUnsub: (() => void) | null = null;
  private sttLast = '';

  /** Load this device's speech model if the world wants it (only once a mic of this device records), and report on it. */
  private async startStt() {
    if (!this.runners.size && !this.loadMics().some((s) => s.enabled && s.serverId && s.mode !== 'off')) return;
    let mode: SttMode = 'server';
    let assets: { lib: string; models: string } | null = null;
    try { const r = await this.api<any>('GET', '/stt/assets'); mode = r.mode; assets = r.assets; } catch { /* older server: server mode */ }
    if (!this.state.recording) return;
    this.sttApplied = mode;
    clearInterval(this.sttTimer);
    this.sttUnsub?.();
    if (mode !== 'server') {
      // Every few seconds, and at once when the state changes, so the GM sees each mic's speed and a failure is taken over by the server straight away.
      this.sttUnsub = deviceStt.subscribe(() => { const v = deviceStt.view; if (v.state !== this.sttLast) { this.sttLast = v.state; this.reportStt(); } });
      this.sttTimer = setInterval(() => this.reportStt(), 5000);
    }
    // Not awaited: loading a model can take minutes, and a mode change meanwhile must not wait for it (stopStt frees it).
    void deviceStt.start(mode, assets).then(() => this.reportStt());
  }
  private reportStt() {
    const v = deviceStt.view;
    if (v.mode === 'server' || !this.state.recording) return;
    for (const id of this.runners.keys()) void this.api('POST', `/mics/${id}/stt`, { state: v.state, model: v.model, backend: v.backend, rtf: v.rtf ?? undefined, backlog: v.backlog, progress: v.progress ?? undefined, note: v.note }).catch(() => {});
  }
  private sttChain: Promise<void> = Promise.resolve();
  /** The mode the server gave when speech to text last started here (null: not started this session). */
  private sttApplied: SttMode | null = null;
  /**
   * The world's speech to text mode changed (the 'stt-mode' live event). A device that is recording switches now: it frees its
   * model (chunks waiting for it go to the server) and starts again, reading the mode from the server. One switch at a time, in
   * order, so a quick server-then-device change ends on the last one; a repeat of the mode already running is ignored.
   */
  sttModeChanged(mode: SttMode) {
    if (!this.state.recording || !this.runners.size) return;
    this.sttChain = this.sttChain.then(async () => {
      if (!this.state.recording || !this.runners.size || this.sttApplied === mode) return;
      this.stopStt([...this.runners.keys()]);
      await this.startStt();
    }).catch(() => {});
  }
  /** The session stopped here: free the model and tell the server, which takes over anything still owed. */
  private stopStt(ids: string[]) {
    clearInterval(this.sttTimer);
    this.sttUnsub?.();
    this.sttUnsub = null;
    this.sttLast = '';
    this.sttApplied = null;
    if (deviceStt.view.mode !== 'server' && deviceStt.view.state !== 'off') for (const id of ids) void this.api('POST', `/mics/${id}/stt`, { state: 'off' }).catch(() => {});
    deviceStt.stop();
  }

  // ---- holds -----------------------------------------------------------------------------------
  private post(micId: string | null, kind: 'talk' | 'mute' | 'aside', start: number, end: number) {
    const sid = this.state.sessionId ?? this.lastSession;
    if (!sid) return;
    void this.api('POST', `/sessions/${sid}/holds`, { micId: micId ?? undefined, kind, start: Math.max(0, Math.round(start)), end: Math.max(0, Math.round(end)) }).catch(() => {});
  }
  pressMic(serverId: string) {
    const r = this.runners.get(serverId);
    if (!r || r.s.mode === 'always' || r.s.mode === 'off') return;
    r.press(this.sessionMs());
    this.patchMic(serverId, { held: true });
  }
  releaseMic(serverId: string) {
    const r = this.runners.get(serverId);
    if (!r) return;
    const h = r.release(this.sessionMs());
    this.patchMic(serverId, { held: false });
    if (h) this.post(serverId, r.s.mode === 'hold-to-mute' ? 'mute' : 'talk', h.start, h.end ?? this.sessionMs());
  }
  pressAside() { if (this.asideOpen === null && this.state.recording) { this.asideOpen = this.sessionMs(); this.set({}); } }
  releaseAside() {
    if (this.asideOpen === null) return;
    const first = [...this.runners.keys()][0] ?? null;
    this.post(first, 'aside', this.asideOpen, this.sessionMs());
    this.asideOpen = null;
    this.set({});
  }
  get asideHeld() { return this.asideOpen !== null; }
  private closeOpenHolds() { for (const id of this.runners.keys()) this.releaseMic(id); this.releaseAside(); }

  keyDown(code: string) {
    for (const [id, r] of this.runners) if (r.s.key && r.s.key === code) this.pressMic(id);
    if (this.asideKey && code === this.asideKey) this.pressAside();
  }
  keyUp(code: string) {
    for (const [id, r] of this.runners) if (r.s.key && r.s.key === code) this.releaseMic(id);
    if (this.asideKey && code === this.asideKey) this.releaseAside();
  }
}

export const engine = new Engine();
let listening = false;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
function onKey(e: KeyboardEvent) {
  if (typing(e.target) || e.repeat) return;
  if (e.type === 'keydown') engine.keyDown(e.code); else engine.keyUp(e.code);
}
function releaseAll() { engine.releaseAside(); for (const s of engine.loadMics()) if (s.serverId) engine.releaseMic(s.serverId); }

export const useEngine = () => useSyncExternalStore(engine.subscribe, engine.getState);
