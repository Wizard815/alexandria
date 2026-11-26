// Web Push without a third party: VAPID (RFC 8292) to say who sends, and the aes128gcm
// payload encryption (RFC 8291) so the push service never reads the text. The browser's
// own push service (Google, Mozilla, Apple) delivers it, even with the app closed.
import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign, type ECDH, type KeyObject } from 'node:crypto';
import type { DB } from '../../core/db.ts';
import { one, run } from '../../core/db.ts';

const b64u = (b: Buffer) => b.toString('base64url');

export interface Vapid { publicKey: string; key: KeyObject }

/** This server's VAPID key pair, made once and kept in the database. */
export function vapid(db: DB): Vapid {
  let row = one<{ public_key: string; private_pem: string }>(db, 'SELECT public_key, private_pem FROM push_vapid WHERE id = 1');
  if (!row) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    run(db, 'INSERT OR IGNORE INTO push_vapid (id, public_key, private_pem) VALUES (1, ?, ?)', b64u(raw), privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    row = one<{ public_key: string; private_pem: string }>(db, 'SELECT public_key, private_pem FROM push_vapid WHERE id = 1')!;
  }
  return { publicKey: row.public_key, key: createPrivateKey(row.private_pem) };
}

function vapidHeader(v: Vapid, endpoint: string, subject: string): string {
  const aud = new URL(endpoint).origin;
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${v.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** The aes128gcm body for one subscription (RFC 8291, a single record). */
export function encrypt(payload: Buffer, p256dh: string, authSecret: string, salt = randomBytes(16), ecdh?: ECDH): Buffer {
  const ua = Buffer.from(p256dh, 'base64url');
  const auth = Buffer.from(authSecret, 'base64url');
  if (ua.length !== 65 || auth.length < 16) throw new Error('bad subscription keys');
  const e = ecdh ?? createECDH('prime256v1');
  if (!ecdh) e.generateKeys();
  const as = e.getPublicKey();
  const shared = e.computeSecret(ua);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([c.update(Buffer.concat([payload, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([as.length]), as, enc]);
}

export interface Sub { endpoint: string; p256dh: string; auth: string }

/** Send one push. Returns the push service's status (404 and 410 mean the subscription is gone). */
export async function sendPush(f: typeof fetch, v: Vapid, sub: Sub, payload: unknown, subject: string): Promise<number> {
  const body = encrypt(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const r = await f(sub.endpoint, {
    method: 'POST',
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Authorization: vapidHeader(v, sub.endpoint, subject) },
    body,
  });
  return r.status;
}

/** Push services browsers use. A subscription for any other host is refused, so the
 *  server never posts to an address a page made up (ALX_PUSH_HOSTS adds more, comma-separated). */
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function pushHostOk(endpoint: string, extra = ''): boolean {
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const hosts = [...PUSH_HOSTS, ...extra.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
  const h = u.hostname.toLowerCase();
  return hosts.some((x) => h === x || h.endsWith(`.${x}`));
}
