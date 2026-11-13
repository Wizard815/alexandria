// IPv4 and IPv6 CIDR matching for ALX_ADMIN_ALLOW.
import { isIP } from 'node:net';

export interface Cidr { v: 4 | 6; net: bigint; bits: number; text: string }

function parseV4(s: string): bigint | null {
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = 0n;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = (n << 8n) | BigInt(part);
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input.split('%')[0];
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const v4 = parseV4(m[2]);
    if (v4 === null) return null;
    s = m[1] + ((v4 >> 16n) & 0xffffn).toString(16) + ':' + (v4 & 0xffffn).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + rest.length > 7) return null;
  const fill = halves.length === 2 ? Array(8 - head.length - rest.length).fill('0') : [];
  let n = 0n;
  for (const g of [...head, ...fill, ...rest]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** An address as (version, number). IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as IPv4. */
export function parseIp(ip: string): { v: 4 | 6; n: bigint } | null {
  const kind = isIP(ip.split('%')[0]);
  if (kind === 4) { const n = parseV4(ip); return n === null ? null : { v: 4, n }; }
  if (kind === 6) {
    const n = parseV6(ip);
    if (n === null) return null;
    if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  return null;
}

export function parseCidr(text: string): Cidr {
  const [addr, len, extra] = text.trim().split('/');
  if (extra !== undefined) throw new Error(`Bad CIDR "${text}"`);
  const ip = parseIp(addr);
  if (!ip) throw new Error(`Bad address in CIDR "${text}"`);
  const max = ip.v === 4 ? 32 : 128;
  if (len !== undefined && !/^\d{1,3}$/.test(len)) throw new Error(`Bad prefix length in CIDR "${text}"`);
  const bits = len === undefined ? max : Number(len);
  if (bits > max) throw new Error(`Bad prefix length in CIDR "${text}"`);
  const host = BigInt(max - bits);
  return { v: ip.v, net: (ip.n >> host) << host, bits, text: text.trim() };
}

export function parseAllowList(list: string | undefined): Cidr[] {
  return (list ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(parseCidr);
}

/** No list means no restriction. A list means only those ranges; an unparseable address is refused. */
export function ipAllowed(ip: string | undefined, cidrs: Cidr[]): boolean {
  if (!cidrs.length) return true;
  const p = ip ? parseIp(ip) : null;
  if (!p) return false;
  const max = p.v === 4 ? 32 : 128;
  return cidrs.some((c) => {
    if (c.v !== p.v) return false;
    const host = BigInt(max - c.bits);
    return (p.n >> host) << host === c.net;
  });
}
