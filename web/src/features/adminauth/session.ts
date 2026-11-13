// The gateway admin session token. It lives under its own localStorage key,
// so signing out of the table (or of the admin pages) never signs out the other.
import { useSyncExternalStore } from 'react';

export const ADMIN_KEY = 'alx.admin.token';

function read(): string | null {
  try { return localStorage.getItem(ADMIN_KEY); } catch { return null; }
}
let token: string | null = read();
const subs = new Set<() => void>();

export function setAdminToken(t: string | null) {
  token = t;
  try { if (t) localStorage.setItem(ADMIN_KEY, t); else localStorage.removeItem(ADMIN_KEY); } catch { /* ignore */ }
  subs.forEach((f) => f());
}

export function useAdminToken(): string | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => token, () => null);
}
