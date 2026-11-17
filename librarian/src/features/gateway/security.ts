// Is an admin still signed in with a password anyone could guess? Only a yes or no leaves this file: never a
// password, a hash, or which password matched.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { checkPassword } from '../../core/auth.ts';

/** The passwords a fresh install, a README or the demo hands out, and the ones people pick first. */
const KNOWN = ['password', 'password123', 'changeme', 'changeme123', 'change-me', 'admin', 'admin123', 'admin12345', 'alexandria', 'alexandria123', 'librarian', 'letmein', 'library admin 123'];

// One check per stored hash: a changed password is a new hash, so a change is seen at once and a scrypt run is never repeated.
const seen = new Map<string, boolean>();

/** True when any admin account's password is its own username or one of the well-known ones. */
export function adminHasDefaultPassword(db: DB): boolean {
  for (const a of all<{ username: string; pass_hash: string | null }>(db, 'SELECT username, pass_hash FROM accounts WHERE is_admin = 1 AND pass_hash IS NOT NULL')) {
    const key = `${a.username}|${a.pass_hash}`;
    let weak = seen.get(key);
    if (weak === undefined) {
      weak = [a.username, ...KNOWN].some((p) => checkPassword(p, a.pass_hash));
      seen.set(key, weak);
    }
    if (weak) return true;
  }
  return false;
}
