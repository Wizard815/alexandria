// Media tickets. An <audio> tag cannot send the sign-in header, so the app
// asks for a ticket for one file (checked like a normal file request) and
// puts /api/media/<kind>/<ticket> in the tag. A ticket is signed, names one
// file and one account, and expires; the file's permission is checked again
// every time it is used, so when the DM stops something players lose it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const secret = randomBytes(32);
const TTL_MS = 12 * 3600_000;

export interface Ticket { w: string; k: string; f: string; a: string; exp: number }

const sign = (body: string) => createHmac('sha256', secret).update(body).digest('base64url');

export function mintTicket(t: Omit<Ticket, 'exp'>): string {
  const body = Buffer.from(JSON.stringify({ ...t, exp: Date.now() + TTL_MS })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readTicket(token: string): Ticket | null {
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as Ticket;
    return t.exp > Date.now() ? t : null;
  } catch { return null; }
}
