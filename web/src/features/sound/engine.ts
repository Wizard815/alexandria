// The audio engine: plays what the librarian's `sound` events ask for, with
// fades, loops, crossfades and speaker groups. Used by the overlay on every
// page, so music keeps playing while the DM moves around the app.
import type { WorldClient } from '@alx/client';

export type Channel = 'music' | 'ambience' | 'sfx' | 'voice';
export type Target = 'table' | 'players' | 'both';
export interface SoundEvent {
  channel: Channel; action: 'play' | 'stop' | 'set'; url: string | null; volume: number; loop: boolean; fadeMs: number;
  target: Target; at: string; layer?: string; id?: string; effect?: 'none' | 'echo' | 'radio'; pitch?: number; label?: string; title?: string;
}

const lsGet = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

/** A random id for this browser, kept in localStorage, so the DM can tell a player's devices apart. */
export function deviceId(): string {
  let v: string | null = null;
  try { v = localStorage.getItem('alx.sound.device'); } catch { /* ignore */ }
  if (!v) {
    v = 'dev-' + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('');
    try { localStorage.setItem('alx.sound.device', v); } catch { /* ignore */ }
  }
  return v;
}

// ---- speaker groups (this computer only) --------------------------------------
export interface Speakers { groups: Record<string, string[]>; assign: Partial<Record<Channel, string>>; tableOn: boolean }
export const sinkSupported = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
export const loadSpeakers = (): Speakers => ({ groups: {}, assign: {}, tableOn: true, ...lsGet<Partial<Speakers>>('alx.sound.speakers', {}) });
export const saveSpeakers = (s: Speakers) => { lsSet('alx.sound.speakers', s); window.dispatchEvent(new Event('alx-speakers')); };

// ---- files -----------------------------------------------------------------------
// An <audio> tag cannot send the sign-in header, so ask the gateway for a
// ticket for the file and play from the ticket's address. Tickets are kept
// for an hour so a repeated pad does not ask again.
const tickets = new Map<string, { url: Promise<string>; at: number }>();
export function mediaUrl(w: WorldClient, url: string): Promise<string> {
  const hit = tickets.get(url);
  if (hit && Date.now() - hit.at < 3600_000) return hit.url;
  const p = w.client.request<{ url: string }>('GET', `${url}/ticket`).then((r) => r.url);
  tickets.set(url, { url: p, at: Date.now() });
  p.catch(() => tickets.delete(url));
  return p;
}

// ---- one playing sound ---------------------------------------------------------------
class Voice {
  els: HTMLAudioElement[] = [];
  level = 0;       // 0..1 relative fade level
  volume = 1;      // target volume
  master: () => number;
  private raf = 0;
  private ctx?: AudioContext;
  constructor(master: () => number) { this.master = master; }
  apply() { for (const e of this.els) e.volume = Math.min(1, Math.max(0, this.level * this.volume * this.master())); }
  /** Move the fade level to `to` over `ms`. Resolves when done. */
  fadeTo(to: number, ms: number): Promise<void> {
    cancelAnimationFrame(this.raf);
    const from = this.level;
    const t0 = performance.now();
    return new Promise((res) => {
      const step = (t: number) => {
        const k = ms <= 0 ? 1 : Math.min(1, (t - t0) / ms);
        this.level = from + (to - from) * k;
        this.apply();
        if (k < 1) this.raf = requestAnimationFrame(step); else res();
      };
      step(t0);
    });
  }
  stopNow() { cancelAnimationFrame(this.raf); for (const e of this.els) { try { e.pause(); e.removeAttribute('src'); e.load(); } catch { /* ignore */ } } this.els = []; void this.ctx?.close().catch(() => {}); }
  /** Play through an effect chain (echo, radio) with WebAudio. */
  async effect(kind: 'echo' | 'radio', e: HTMLAudioElement) {
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const src = ctx.createMediaElementSource(e);
    if (kind === 'radio') {
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
      const sh = ctx.createWaveShaper(); const c = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = (i / 128) - 1; c[i] = Math.tanh(x * 3); } sh.curve = c;
      src.connect(hp); hp.connect(lp); lp.connect(sh); sh.connect(ctx.destination);
    } else {
      const dry = ctx.createGain(); dry.gain.value = 1;
      const delay = ctx.createDelay(1); delay.delayTime.value = 0.28;
      const fb = ctx.createGain(); fb.gain.value = 0.4;
      const wet = ctx.createGain(); wet.gain.value = 0.5;
      src.connect(dry); dry.connect(ctx.destination);
      src.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(ctx.destination);
    }
  }
}

export interface EngineOpts {
  w: WorldClient;
  /** Master volume (0..1) for a channel. */
  master: (c: Channel) => number;
  /** Which output group this channel plays on (this computer's choice), or none for the default output. */
  sinks: (c: Channel) => string[];
  onBlocked: () => void;
}

export class Engine {
  o: EngineOpts;
  music: Voice | null = null;
  musicInfo: { id?: string; title?: string } = {};
  ambience = new Map<string, Voice>();
  oneShots = new Map<string, Voice>();
  constructor(o: EngineOpts) { this.o = o; }

  private async make(c: Channel, url: string, loop: boolean, volume: number, effect?: 'echo' | 'radio', pitch = 1): Promise<Voice | null> {
    const src = await mediaUrl(this.o.w, url);
    const v = new Voice(() => this.o.master(c));
    v.volume = volume;
    const sinks = effect ? [] : this.o.sinks(c);
    for (const sink of sinks.length ? sinks : ['']) {
      const e = new Audio(src);
      e.loop = loop;
      e.preload = 'auto';
      // Pitch is the browser's playback rate with pitch correction off, so it changes speed too.
      if (pitch !== 1) { (e as any).preservesPitch = false; e.playbackRate = pitch; }
      if (sink && 'setSinkId' in e) { try { await (e as any).setSinkId(sink); } catch { /* device gone: default output */ } }
      v.els.push(e);
    }
    if (effect) await v.effect(effect, v.els[0]);
    v.apply();
    try { await Promise.all(v.els.map((e) => e.play())); } catch (err: any) {
      if (err?.name === 'NotAllowedError') this.o.onBlocked();
      v.stopNow();
      return null;
    }
    return v;
  }

  async handle(ev: SoundEvent) {
    try {
      if (ev.channel === 'music') return await this.onMusic(ev);
      if (ev.channel === 'ambience') return await this.onAmbience(ev);
      return await this.onShot(ev);
    } catch { /* a missing file must not break the page */ }
  }

  private async onMusic(ev: SoundEvent) {
    const old = this.music;
    if (ev.action === 'stop' || !ev.url) {
      this.music = null; this.musicInfo = {};
      if (old) void old.fadeTo(0, ev.fadeMs).then(() => old.stopNow());
      return;
    }
    const v = await this.make('music', ev.url, true, ev.volume);
    if (!v) return;
    v.level = 0; v.apply();
    this.music = v; this.musicInfo = { id: ev.id, title: ev.title };
    void v.fadeTo(1, ev.fadeMs);
    if (old) void old.fadeTo(0, ev.fadeMs).then(() => old.stopNow());
  }

  private async onAmbience(ev: SoundEvent) {
    const key = ev.layer ?? ev.url ?? '';
    const cur = this.ambience.get(key);
    if (ev.action === 'stop' || !ev.url) {
      if (cur) { this.ambience.delete(key); void cur.fadeTo(0, ev.fadeMs).then(() => cur.stopNow()); }
      return;
    }
    if (cur && ev.action === 'set') { cur.volume = ev.volume; cur.apply(); return; }
    if (cur) { this.ambience.delete(key); void cur.fadeTo(0, ev.fadeMs).then(() => cur.stopNow()); }
    const v = await this.make('ambience', ev.url, true, ev.volume);
    if (!v) return;
    v.level = 0; v.apply();
    this.ambience.set(key, v);
    void v.fadeTo(1, ev.fadeMs);
  }

  private async onShot(ev: SoundEvent) {
    const key = ev.id ?? ev.url ?? '';
    if (ev.action === 'stop') {
      const cur = this.oneShots.get(key);
      if (cur) { this.oneShots.delete(key); void cur.fadeTo(0, ev.fadeMs).then(() => cur.stopNow()); }
      return;
    }
    if (!ev.url) return;
    const eff = ev.channel === 'voice' && ev.effect && ev.effect !== 'none' ? ev.effect : undefined;
    const v = await this.make(ev.channel, ev.url, ev.loop, ev.volume, eff, ev.channel === 'voice' ? ev.pitch : 1);
    if (!v) return;
    v.level = 1; v.apply();
    const k = ev.loop ? key : key + Math.random();
    this.oneShots.set(k, v);
    v.els[0].addEventListener('ended', () => { this.oneShots.delete(k); v.stopNow(); });
  }

  /** Stop one channel (a player turned its switch off). */
  stopChannel(c: Channel, fadeMs = 400) {
    if (c === 'music' && this.music) { const o = this.music; this.music = null; void o.fadeTo(0, fadeMs).then(() => o.stopNow()); }
    if (c === 'ambience') for (const [k, v] of this.ambience) { this.ambience.delete(k); void v.fadeTo(0, fadeMs).then(() => v.stopNow()); }
    if (c === 'sfx' || c === 'voice') for (const [k, v] of this.oneShots) { this.oneShots.delete(k); v.stopNow(); }
  }
  /** Volume sliders changed. */
  refresh() { this.music?.apply(); for (const v of this.ambience.values()) v.apply(); for (const v of this.oneShots.values()) v.apply(); }
  stopAll() { for (const c of ['music', 'ambience', 'sfx'] as Channel[]) this.stopChannel(c, 0); }
}
