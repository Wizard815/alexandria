import { randomBytes, createHash } from 'node:crypto';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const now = () => new Date().toISOString();
export const id = (prefix = '') => prefix + randomBytes(9).toString('base64url');
export const secret = (prefix: string) => prefix + randomBytes(24).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function str(v: unknown, field: string, opts: { max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new HttpError(400, `${field} is required`);
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const max = opts.max ?? 10_000;
  if (v.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
  return v;
}

export function int(v: unknown, field: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return null;
    throw new HttpError(400, `${field} is required`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw new HttpError(400, `${field} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new HttpError(400, `${field} must be at most ${opts.max}`);
  return n;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function isoDate(v: unknown, field: string): string {
  const s = str(v, field, { max: 40 });
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} must be a date and time`);
  return d.toISOString();
}
