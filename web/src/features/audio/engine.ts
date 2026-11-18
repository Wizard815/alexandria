// Recording in the browser. This lives outside React so it keeps running as
// the DM or a player moves between pages; the transcript island (an overlay
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
import { useSyncExternalStore } from 'react';

export type Mode = 'always' | 'hold-to-talk' | 'hold-to-mute' | 'off';
export interface MicSetting {
  /** The browser's id for the input device. */
  deviceId: string;
  label: string;
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

interface Cfg { baseUrl: string; token: string; worldId: string; isDM: boolean }

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

  constructor(e: Engine, s: MicSetting) { this.e = e; this.s = s; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.s.deviceId ? { deviceId: { exact: this.s.deviceId } } : true });
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
    this.queue = this.queue.then(() => this.upload(blob, seq, start, end, lv));
  }

  private async upload(blob: Blob, seq: number, start: number, end: number, level: number) {
    const sid = this.e.state.sessionId ?? this.e.lastSession;
    if (!sid || !this.s.serverId) return;
    const url = `${this.e.cfg!.baseUrl}/api/worlds/${encodeURIComponent(this.e.cfg!.worldId)}/audio/sessions/${sid}/chunks?mic=${this.s.serverId}&seq=${seq}&start=${Math.round(start)}&end=${Math.round(end)}&level=${level.toFixed(3)}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${this.e.cfg!.token}`, 'Content-Type': blob.type || 'audio/webm' }, body: blob });
        if (r.ok) { this.e.patchMic(this.s.serverId!, { sent: (this.e.state.mics[this.s.serverId!]?.sent ?? 0) + 1, error: undefined }); return; }
        if (r.status === 403 || r.status === 409 || r.status === 413 || r.status === 415) {
          const msg = await r.json().then((j: any) => j.error).catch(() => `Upload refused (${r.status})`);
          this.e.patchMic(this.s.serverId!, { error: msg, failed: (this.e.state.mics[this.s.serverId!]?.failed ?? 0) + 1 });
          if (r.status === 403 || r.status === 409) void this.stop();
          return;
        }
      } catch { /* offline: try again */ }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    this.e.patchMic(this.s.serverId!, { failed: (this.e.state.mics[this.s.serverId!]?.failed ?? 0) + 1, error: 'Could not upload; the server is unreachable' });
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
  /** One id per computer, so a DM's mics keep their names across sessions. */
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
    if (!this.state.consent && !this.cfg?.isDM) return; // starts once they agree
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
    this.runners.clear();
    this.closeOpenHolds();
    await Promise.all(rs.map((r) => r.stop()));
  }

  async stopAll() {
    await this.stopRunners();
    this.set({ recording: false, sessionId: null });
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
