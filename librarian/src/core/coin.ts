// Coin helpers shared by the ledger, transfers and the broker.
import { type DB, one } from './db.ts';

/** Approved balance of a purse: an account id or 'party'. */
export const balance = (db: DB, worldId: string, owner: string) =>
  one<{ cp: number }>(db, `SELECT COALESCE(SUM(amount_cp), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status = 'approved'`, worldId, owner)!.cp;

/**
 * What a purse can spend right now: its approved balance less coin already promised to debits still waiting for the
 * GM. Pending credits never count (they may be refused). Every spend check uses this, inside the same transaction as
 * the debit it guards, so a waiting debit approved later can never overdraw the purse.
 */
export const spendable = (db: DB, worldId: string, owner: string) =>
  one<{ cp: number }>(db, `SELECT COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_cp WHEN status = 'pending' AND amount_cp < 0 THEN amount_cp ELSE 0 END), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status IN ('approved', 'pending')`, worldId, owner)!.cp;

/** "3 gp 2 sp", for messages. */
export const money = (cp: number) => {
  if (!cp) return 'nothing';
  const neg = cp < 0;
  const n = Math.abs(cp);
  const gp = Math.floor(n / 100), sp = Math.floor((n % 100) / 10), c = n % 10;
  return (neg ? '-' : '') + [gp && `${gp} gp`, sp && `${sp} sp`, c && `${c} cp`].filter(Boolean).join(' ');
};
