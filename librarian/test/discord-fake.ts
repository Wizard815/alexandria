// A stand-in Discord for the bot's tests: the REST calls it records and
// answers, and a gateway (a tiny WebSocket server, no library) that says
// HELLO, checks IDENTIFY, sends READY and GUILD_CREATE, and lets a test send
// INTERACTION_CREATE as if someone typed a slash command.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// Made of parts so it does not look like a real token to secret scanners. It is not one.
export const GOOD_TOKEN = ['fake-test-bot-token-0000', 'abcd', 'not-a-real-discord-token-xyz'].join('.');
export const APP_ID = '900000000000000001';
export const GUILD = '800000000000000001';

export interface Call { method: string; path: string; body: any }

export class FakeDiscord {
  calls: Call[] = [];
  identified: any[] = [];
  socks = new Set<Socket>();
  server: http.Server;
  base = '';
  guilds = [{ id: GUILD, name: 'The Table' }];
  private seq = 0;
  private nextId = 1000;

  constructor() {
    this.server = http.createServer((req, res) => this.http(req, res));
    this.server.on('upgrade', (req, sock: Socket) => this.upgrade(req, sock));
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close() {
    for (const s of this.socks) s.destroy();
    this.server.close();
    this.server.closeAllConnections?.();
  }

  /** REST calls since `from`, matching method and a path pattern. */
  find(method: string, path: RegExp, from = 0) { return this.calls.slice(from).filter((c) => c.method === method && path.test(c.path)); }

  private http(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = String(req.url);
      const method = String(req.method);
      this.calls.push({ method, path, body });
      const send = (status: number, j: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(j === null ? '' : JSON.stringify(j)); };
      if (req.headers.authorization !== `Bot ${GOOD_TOKEN}`) return send(401, { message: '401: Unauthorized', code: 0 });
      if (path === '/gateway/bot') return send(200, { url: this.base.replace('http', 'ws'), shards: 1 });
      if (/^\/applications\/\d+\/guilds\/\d+\/commands$/.test(path)) return send(200, body);
      if (path === '/users/@me/channels') return send(200, { id: `7${String(body.recipient_id).slice(1)}`, type: 1 });
      if (/^\/channels\/\d+\/messages$/.test(path)) return send(200, { id: String(this.nextId++), content: body.content });
      if (/^\/channels\/\d+\/messages\/\d+$/.test(path) && method === 'DELETE') return send(204, null);
      if (/^\/guilds\/\d+\/channels$/.test(path)) return send(200, [{ id: '600000000000000002', name: 'rolls', type: 0, position: 2 }, { id: '600000000000000001', name: 'recaps', type: 0, position: 1 }, { id: '600000000000000003', name: 'Voice', type: 2, position: 3 }]);
      if (/^\/interactions\//.test(path)) return send(204, null);
      if (/^\/webhooks\//.test(path)) return send(200, { id: String(this.nextId++) });
      send(404, { message: 'Unknown', code: 0 });
    });
  }

  // ---- the gateway ----

  private upgrade(req: http.IncomingMessage, sock: Socket) {
    const key = String(req.headers['sec-websocket-key']);
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.socks.add(sock);
    sock.on('close', () => this.socks.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const f = readFrame(buf);
        if (!f) break;
        buf = buf.subarray(f.used);
        if (f.op === 8) { sock.end(frame(Buffer.from([0x03, 0xe8]), 8)); return; }
        if (f.op === 1) this.onGateway(sock, JSON.parse(f.data.toString()));
      }
    });
    this.sendTo(sock, { op: 10, d: { heartbeat_interval: 45_000 } });
  }

  private sendTo(sock: Socket, p: unknown) { sock.write(frame(Buffer.from(JSON.stringify(p)), 1)); }

  private onGateway(sock: Socket, p: any) {
    if (p.op === 1) return this.sendTo(sock, { op: 11 });
    if (p.op === 2) {
      this.identified.push(p.d);
      if (p.d.token !== GOOD_TOKEN) { sock.end(closeFrame(4004)); return; }
      this.sendTo(sock, { op: 0, s: ++this.seq, t: 'READY', d: { v: 10, session_id: 'sess1', resume_gateway_url: this.base.replace('http', 'ws'), user: { id: APP_ID, username: 'AlexBot' }, application: { id: APP_ID } } });
      for (const g of this.guilds) this.sendTo(sock, { op: 0, s: ++this.seq, t: 'GUILD_CREATE', d: g });
    }
  }

  /** Someone typed a slash command in a channel of the test server. */
  interaction(user: { id: string; username: string }, name: string, options: Record<string, unknown> = {}, channel = '600000000000000002') {
    const i = {
      id: String(this.nextId++), token: `tok${this.nextId}`, type: 2, application_id: APP_ID, guild_id: GUILD, channel_id: channel,
      member: { user }, data: { name, options: Object.entries(options).map(([k, v]) => ({ name: k, value: v })) },
    };
    for (const s of this.socks) this.sendTo(s, { op: 0, s: ++this.seq, t: 'INTERACTION_CREATE', d: i });
    return i;
  }
}

function frame(data: Buffer, op: number): Buffer {
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, data]);
}
const closeFrame = (code: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(code); return frame(b, 8); };

function readFrame(buf: Buffer): { op: number; data: Buffer; used: number } | null {
  if (buf.length < 2) return null;
  const op = buf[0] & 15;
  const masked = !!(buf[1] & 0x80);
  let len = buf[1] & 127;
  let at = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); at = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); at = 10; }
  const mask = masked ? buf.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const data = Buffer.from(buf.subarray(at, at + len));
  if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
  return { op, data, used: at + len };
}
