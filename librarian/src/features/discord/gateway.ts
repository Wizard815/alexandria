// A small Discord Gateway client (API v10, JSON): enough for a bot that
// answers slash commands. Node's own WebSocket, no library.
//
//   HELLO -> heartbeat every interval (first one jittered) -> IDENTIFY, or
//   RESUME when we have a session; READY gives the session id and the
//   resume address. Op 7 and a dropped socket reconnect and resume; op 9
//   (invalid session) starts again from IDENTIFY. Close codes that mean the
//   token or the bot's settings are wrong stop the client for good, with a
//   reason the DM page shows.

export const API_VERSION = 10;
// GUILDS only: needed for GUILD_CREATE (which servers the bot is in). Slash
// commands arrive as INTERACTION_CREATE whatever the intents.
export const INTENTS = 1;

/** Close codes after which reconnecting cannot help. */
const FATAL: Record<number, string> = {
  4004: 'Discord did not accept the bot token. Copy it again from the Developer Portal (Bot → Reset Token).',
  4010: 'Discord rejected the shard settings.',
  4011: 'This bot is in too many servers for one connection.',
  4012: 'Discord does not support this gateway version any more.',
  4013: 'Discord rejected the intents.',
  4014: 'Discord says the bot asked for intents it is not allowed.',
};

export interface GatewayEvents {
  ready(info: { userId: string; username: string; applicationId: string }): void;
  dispatch(type: string, data: any): void;
  status(s: { connected: boolean; error: string | null; fatal?: boolean }): void;
}

type WS = { send(s: string): void; close(code?: number): void; readyState: number; onopen: any; onmessage: any; onclose: any; onerror: any };

export interface GatewayOptions {
  token: string;
  /** wss://gateway.discord.gg (from GET /gateway/bot). */
  url: string;
  events: GatewayEvents;
  /** Tests: a WebSocket constructor. */
  WebSocketImpl?: new (url: string) => WS;
  log?: (msg: string) => void;
}

export class Gateway {
  private ws: WS | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private firstBeat: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private acked = true;
  private stopped = false;
  private tries = 0;

  private o: GatewayOptions;

  constructor(o: GatewayOptions) { this.o = o; }

  start() { this.stopped = false; this.open(false); }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    try { this.ws?.close(1000); } catch { /* closed */ }
    this.ws = null;
  }

  get connected() { return !!this.ws && this.ws.readyState === 1 && !!this.sessionId; }

  private clearTimers() {
    if (this.beat) clearInterval(this.beat);
    if (this.firstBeat) clearTimeout(this.firstBeat);
    this.beat = null;
    this.firstBeat = null;
  }

  private open(resume: boolean) {
    if (this.stopped) return;
    const base = resume && this.resumeUrl ? this.resumeUrl : this.o.url;
    const url = `${base.replace(/\/+$/, '')}/?v=${API_VERSION}&encoding=json`;
    const Impl = this.o.WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!Impl) { this.o.events.status({ connected: false, error: 'This Node has no WebSocket (needs Node 22 or newer).', fatal: true }); return; }
    let ws: WS;
    try { ws = new Impl(url); } catch (e: any) { this.later(resume, `Could not open the gateway: ${e?.message ?? e}`); return; }
    this.ws = ws;
    ws.onmessage = (ev: any) => {
      let p: any;
      try { p = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      this.onPayload(p, resume);
    };
    ws.onclose = (ev: any) => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = null;
      const code = Number(ev?.code ?? 0);
      if (FATAL[code]) { this.stopped = true; this.o.events.status({ connected: false, error: FATAL[code], fatal: true }); return; }
      // 4007 bad sequence, 4009 session timed out: start a new session.
      if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; }
      this.later(!!this.sessionId, code === 1000 ? null : `The gateway closed (${code || 'no code'})`);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private later(resume: boolean, error: string | null) {
    if (this.stopped) return;
    this.o.events.status({ connected: false, error });
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.tries++, 6)) * (0.5 + Math.random() / 2);
    this.retry = setTimeout(() => { this.retry = null; this.open(resume); }, wait);
    this.retry.unref?.();
  }

  private send(op: number, d: unknown) {
    try { this.ws?.send(JSON.stringify({ op, d })); } catch { /* closing */ }
  }

  private heartbeat() {
    if (!this.acked) { try { this.ws?.close(4900); } catch { /* gone */ } return; } // a zombie connection: reconnect and resume
    this.acked = false;
    this.send(1, this.seq);
  }

  private onPayload(p: any, resuming: boolean) {
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: { // HELLO
        const every = Number(p.d?.heartbeat_interval) || 41_250;
        this.clearTimers();
        this.acked = true;
        this.firstBeat = setTimeout(() => { this.heartbeat(); this.beat = setInterval(() => this.heartbeat(), every); this.beat.unref?.(); }, every * Math.random());
        this.firstBeat.unref?.();
        if (resuming && this.sessionId) this.send(6, { token: this.o.token, session_id: this.sessionId, seq: this.seq });
        else this.send(2, { token: this.o.token, intents: INTENTS, properties: { os: process.platform, browser: 'alexandria', device: 'alexandria' } });
        return;
      }
      case 11: this.acked = true; return;
      case 1: this.send(1, this.seq); return; // Discord asks for a beat now
      case 7: try { this.ws?.close(4901); } catch { /* gone */ } return; // reconnect and resume
      case 9: { // invalid session; d says whether it can be resumed
        if (!p.d) { this.sessionId = null; this.seq = null; }
        setTimeout(() => { try { this.ws?.close(4902); } catch { /* gone */ } }, 1000 + Math.random() * 4000).unref?.();
        return;
      }
      case 0: {
        if (p.t === 'READY') {
          this.sessionId = p.d?.session_id ?? null;
          this.resumeUrl = p.d?.resume_gateway_url ?? null;
          this.tries = 0;
          this.o.events.ready({ userId: String(p.d?.user?.id ?? ''), username: String(p.d?.user?.username ?? ''), applicationId: String(p.d?.application?.id ?? p.d?.user?.id ?? '') });
          this.o.events.status({ connected: true, error: null });
        } else if (p.t === 'RESUMED') {
          this.tries = 0;
          this.o.events.status({ connected: true, error: null });
        }
        try { this.o.events.dispatch(String(p.t), p.d); } catch (e: any) { this.o.log?.(`discord: ${p.t} handler failed: ${e?.message ?? e}`); }
        return;
      }
    }
  }
}
