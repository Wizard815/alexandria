// The light drivers. All talk to the local network: WLED, a Philips Hue
// bridge (v1 local API), Home Assistant and OpenRGB. HTTP goes through
// `d.fetch` so tests can fake it; OpenRGB is a plain TCP packet.
//
// A driver gets one target (what to light) and one state, and either
// resolves or throws. Callers never wait on it for the game: see engine.ts.
import net from 'node:net';
import type { Deps } from '../../app.ts';
import { HttpError } from '../../core/util.ts';
import { type RGB, parseColor, rgbToXy } from './color.ts';

export const KINDS = ['wled', 'hue', 'ha', 'openrgb'] as const;
export type Kind = (typeof KINDS)[number];

export interface LightState {
  on: boolean;
  color: RGB;
  /** 0 to 100. */
  brightness: number;
  effect: string;
  transitionMs: number;
}

export const MASK = '••••••';
const SECRETS: Record<Kind, string[]> = { wled: [], hue: ['user'], ha: ['token'], openrgb: [] };
export const TIMEOUT_MS = 1000;

// ---- validation ---------------------------------------------------------------------

/** host or host:port on the local network. Public IP addresses and link-local ones (cloud metadata) are refused. */
export function cleanHost(v: unknown, field = 'host'): string {
  if (typeof v !== 'string') throw new HttpError(400, `${field} is required`);
  const s = v.trim();
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,120}[a-zA-Z0-9])?(:\d{1,5})?$/.test(s)) throw new HttpError(400, `${field} must be a host name or IP address (with an optional :port), no http:// or path`);
  const host = s.replace(/:\d+$/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) throw new HttpError(400, `${field} is not a valid address`);
    if (a === 0 || (a === 169 && b === 254)) throw new HttpError(400, `${field}: that address is not allowed`);
    const priv = a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
    if (!priv && process.env.ALX_LIGHTS_ALLOW_PUBLIC !== '1') throw new HttpError(400, `${field}: lights must be on your local network (set ALX_LIGHTS_ALLOW_PUBLIC=1 to allow other addresses)`);
  }
  return s;
}

function cleanBase(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError(400, 'baseUrl is required, e.g. http://homeassistant.local:8123');
  let u: URL;
  try { u = new URL(v.trim()); } catch { throw new HttpError(400, 'baseUrl is not a web address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'baseUrl must start with http:// or https://');
  if (u.username || u.password) throw new HttpError(400, 'baseUrl must not contain a login');
  cleanHost(u.host, 'baseUrl');
  return `${u.protocol}//${u.host}`;
}

const txt = (v: unknown, field: string, max = 300, optional = false): string => {
  if (v === undefined || v === null || v === '') { if (optional) return ''; throw new HttpError(400, `${field} is required`); }
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${field} must be text of up to ${max} characters`);
  return v.trim();
};

/** The stored config for a driver: validated, with an untouched secret (blank or masked) kept from the current one. */
export function cleanConfig(kind: Kind, input: any, cur?: Record<string, any>): Record<string, any> {
  const b = input && typeof input === 'object' ? input : {};
  const keep = (k: string, max: number) => {
    const v = b[k];
    if (v === undefined || v === '' || v === MASK) return cur?.[k] ?? '';
    return txt(v, k, max);
  };
  switch (kind) {
    case 'wled': return { host: cleanHost(b.host) };
    case 'hue': return { host: cleanHost(b.host), user: keep('user', 120) };
    case 'ha': {
      const token = keep('token', 600);
      if (!token) throw new HttpError(400, 'token is required (a long-lived access token from your Home Assistant profile)');
      return { baseUrl: cleanBase(b.baseUrl), token };
    }
    case 'openrgb': {
      const port = b.port === undefined || b.port === '' ? 6742 : Number(b.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'port must be 1 to 65535');
      return { host: cleanHost(b.host), port };
    }
  }
}

export function maskConfig(kind: Kind, cfg: Record<string, any>): Record<string, any> {
  const out = { ...cfg };
  for (const k of SECRETS[kind]) if (out[k]) out[k] = MASK;
  return out;
}

/** What a group lights, per kind. */
export function cleanTarget(kind: Kind, input: any): Record<string, any> {
  const b = input && typeof input === 'object' ? input : {};
  switch (kind) {
    case 'wled': return {};
    case 'hue': {
      const g = String(b.group ?? '').trim();
      if (!/^\d{1,4}$/.test(g)) throw new HttpError(400, 'target.group must be the number of a Hue group (0 is every light)');
      return { group: g };
    }
    case 'ha': {
      const ents = Array.isArray(b.entities) ? b.entities : typeof b.entities === 'string' ? b.entities.split(/[,\s]+/) : [];
      const list = ents.map((e: unknown) => String(e).trim()).filter(Boolean);
      if (!list.length || list.length > 40 || list.some((e: string) => !/^(light|switch|group)\.[a-z0-9_]+$/.test(e))) throw new HttpError(400, 'target.entities must be Home Assistant light entity ids such as light.desk');
      return { entities: list };
    }
    case 'openrgb': {
      const devs = Array.isArray(b.devices) ? b.devices : [];
      const list = devs.map((x: any) => ({ index: Number(x?.index), leds: Number(x?.leds) }));
      if (!list.length || list.length > 32 || list.some((x: any) => !Number.isInteger(x.index) || x.index < 0 || x.index > 255 || !Number.isInteger(x.leds) || x.leds < 1 || x.leds > 4000)) {
        throw new HttpError(400, 'target.devices must be a list of { index, leds }: the OpenRGB device number and how many LEDs it has');
      }
      return { devices: list };
    }
  }
}

// ---- WLED effect names --------------------------------------------------------------

const WLED_FX: Record<string, number> = { solid: 0, blink: 1, breathe: 2, wipe: 3, colorloop: 8, rainbow: 9, fade: 12, strobe: 23, fire: 66 };
export const EFFECTS = ['', ...Object.keys(WLED_FX)];

/** An effect is a name from the list or (WLED, Home Assistant) any effect name or number the device knows. */
export const cleanEffect = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 60) throw new HttpError(400, 'effect must be text of up to 60 characters');
  return v.trim();
};

// ---- sending ------------------------------------------------------------------------

/** Race a promise with a timer, so a device that ignores the abort signal still cannot hold anything up. */
export function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function http(d: Deps, url: string, method: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await withTimeout(d.fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) }));
  if (!res.ok) throw new Error(`${method} ${new URL(url).host} answered ${res.status}`);
  const text = await withTimeout(res.text()).catch(() => '');
  try { return JSON.parse(text); } catch { return text; }
}

const bri255 = (pct: number) => Math.max(1, Math.min(255, Math.round((pct / 100) * 255)));

export const wledBody = (s: LightState) => s.on
  ? { on: true, bri: bri255(s.brightness), transition: Math.round(s.transitionMs / 100), seg: [{ col: [[...s.color]], fx: /^\d+$/.test(s.effect) ? Number(s.effect) : WLED_FX[s.effect.toLowerCase()] ?? 0 }] }
  : { on: false, transition: Math.round(s.transitionMs / 100) };

export const hueBody = (s: LightState) => s.on
  ? { on: true, bri: Math.max(1, Math.min(254, Math.round((s.brightness / 100) * 254))), xy: rgbToXy(s.color), transitiontime: Math.round(s.transitionMs / 100), effect: s.effect === 'colorloop' ? 'colorloop' : 'none' }
  : { on: false, transitiontime: Math.round(s.transitionMs / 100) };

export const haBody = (target: { entities: string[] }, s: LightState) => s.on
  ? { entity_id: target.entities, rgb_color: [...s.color], brightness: bri255(s.brightness), ...(s.effect ? { effect: s.effect } : {}), transition: s.transitionMs / 1000 }
  : { entity_id: target.entities, transition: s.transitionMs / 1000 };

// ---- OpenRGB SDK protocol -----------------------------------------------------------
// Little-endian packets: 'ORGB', device index, packet id, size, then the data.
// We send our name, switch each device to a custom mode, then set all its LEDs
// to one colour. The LED count comes from the group's target, so no
// controller data has to be parsed.

export const ORGB_PORT = 6742;
const PKT_SET_CLIENT_NAME = 50;
const PKT_UPDATE_LEDS = 1050;
const PKT_SET_CUSTOM_MODE = 1100;

export function orgbPacket(device: number, id: number, data: Buffer = Buffer.alloc(0)): Buffer {
  const h = Buffer.alloc(16);
  h.write('ORGB', 0, 'ascii');
  h.writeUInt32LE(device, 4);
  h.writeUInt32LE(id, 8);
  h.writeUInt32LE(data.length, 12);
  return Buffer.concat([h, data]);
}

export function orgbUpdateLeds(device: number, leds: number, c: RGB): Buffer {
  const data = Buffer.alloc(4 + 2 + leds * 4);
  data.writeUInt32LE(data.length, 0);
  data.writeUInt16LE(leds, 4);
  for (let i = 0; i < leds; i++) { data[6 + i * 4] = c[0]; data[7 + i * 4] = c[1]; data[8 + i * 4] = c[2]; }
  return orgbPacket(device, PKT_UPDATE_LEDS, data);
}

/** Everything sent for one state: name, then per device custom mode and colours. */
export function orgbPackets(devices: { index: number; leds: number }[], s: LightState): Buffer {
  const k = s.on ? s.brightness / 100 : 0;
  const c: RGB = [Math.round(s.color[0] * k), Math.round(s.color[1] * k), Math.round(s.color[2] * k)];
  const parts = [orgbPacket(0, PKT_SET_CLIENT_NAME, Buffer.from('Alexandria\0', 'ascii'))];
  for (const x of devices) { parts.push(orgbPacket(x.index, PKT_SET_CUSTOM_MODE), orgbUpdateLeds(x.index, x.leds, c)); }
  return Buffer.concat(parts);
}

function tcpSend(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const done = (err?: Error) => { sock.destroy(); err ? reject(err) : resolve(); };
    sock.setTimeout(TIMEOUT_MS, () => done(new Error(`OpenRGB at ${host}:${port} did not answer within ${TIMEOUT_MS} ms`)));
    sock.once('error', (e) => done(e));
    sock.once('connect', () => sock.end(bytes, () => done()));
  });
}

export async function send(d: Deps, kind: Kind, cfg: Record<string, any>, target: Record<string, any>, s: LightState): Promise<void> {
  switch (kind) {
    case 'wled':
      await http(d, `http://${cfg.host}/json/state`, 'POST', wledBody(s));
      return;
    case 'hue': {
      if (!cfg.user) throw new Error('This Hue bridge is not paired yet (press its button, then Pair)');
      const out = await http(d, `http://${cfg.host}/api/${encodeURIComponent(cfg.user)}/groups/${encodeURIComponent(target.group)}/action`, 'PUT', hueBody(s));
      const err = Array.isArray(out) ? (out as any[]).find((x) => x?.error)?.error : null;
      if (err) throw new Error(`Hue: ${String(err.description ?? 'error').slice(0, 120)}`);
      return;
    }
    case 'ha':
      await http(d, `${cfg.baseUrl}/api/services/light/${s.on ? 'turn_on' : 'turn_off'}`, 'POST', haBody(target as { entities: string[] }, s), { Authorization: `Bearer ${cfg.token}` });
      return;
    case 'openrgb':
      await tcpSend(String(cfg.host).replace(/:\d+$/, ''), Number(cfg.port ?? ORGB_PORT), orgbPackets(target.devices, s));
      return;
  }
}

/** The Hue pairing call: pressing the bridge button, then this, returns a username. */
export async function huePair(d: Deps, host: string): Promise<{ user: string | null; waiting: boolean; error?: string }> {
  const out = await http(d, `http://${host}/api`, 'POST', { devicetype: 'alexandria#gateway' });
  const first = Array.isArray(out) ? (out as any[])[0] : null;
  if (first?.success?.username) return { user: String(first.success.username), waiting: false };
  if (first?.error?.type === 101) return { user: null, waiting: true };
  return { user: null, waiting: false, error: String(first?.error?.description ?? 'The bridge did not answer as a Hue bridge') };
}

export { parseColor };
