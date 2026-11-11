// Shared bits for the broker and approvals screens.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad, type WorldSettings } from '../../lib/world.tsx';
import { coins, when } from '../../lib/format.ts';
import { useAction, ErrorBox, Field } from '../../ui/index.tsx';

/** Settings this work adds. lib/world.tsx does not list them yet. */
export interface ApprovalSettings { playerChangesNeedApproval: boolean; dmChangeReason: boolean; brokerEnabled: boolean; brokerPayer: 'self' | 'party'; playerTransfers: boolean }
export const extra = (s: WorldSettings): ApprovalSettings => {
  const x = s as unknown as Partial<ApprovalSettings>;
  return { playerChangesNeedApproval: x.playerChangesNeedApproval ?? true, dmChangeReason: x.dmChangeReason ?? true, brokerEnabled: x.brokerEnabled ?? true, brokerPayer: x.brokerPayer ?? 'self', playerTransfers: x.playerTransfers ?? true };
};

export type Unit = 'minutes' | 'hours' | 'days';
export interface Tier { id: string; name: string; description: string; knowledge: 'common' | 'local' | 'deep' | 'secret'; costCp: number | null; wait: { amount: number; unit: Unit; clock: 'real' | 'game' } | null }
export interface BrokerConfig {
  persona: { name: string; title: string; description: string; greeting: string; voice: string; portrait: string };
  tiers: Tier[];
  lengths: { id: string; name: string; multiplier: number }[];
  /** Questions it can't answer: the DM prices them, or the broker turns them away. */
  unknown?: 'dm' | 'refuse';
  payer: 'self' | 'party';
  clock: { minutes: number; label: string };
}
export interface BrokerRequest {
  id: string; question: string; length: string; tier: string; tier_name: string; cost_cp: number | null; payer: string | null;
  status: 'pricing' | 'offered' | 'waiting' | 'answered' | 'refused' | 'refunded' | 'declined' | 'noted';
  wait_clock: 'real' | 'game' | null; ready_at: string | null; ready_at_game: number | null; ready_at_game_label: string | null; game_now: number;
  created_at: string; delivered_at: string | null; reply: string | null;
  answer?: string; sources?: { id: string | null; title: string }[]; voice?: string; asker?: string; asker_name?: string;
  /** DM only: how the question was judged. */
  classification?: Classification;
}
export type Verdict = 'shared' | 'secret' | 'unknown';
export interface Classification {
  type: string; verdict: Verdict | null; reason: string; knowledge: string | null; multiplier: number;
  entities: { id: string; title: string; shared: boolean }[];
  dmEvidence: { page: string; title: string; text: string }[];
}
export interface BrokerNote { id: string; page_id: string | null; page_title: string | null; topic: string; text: string; knowledge: 'common' | 'local' | 'deep'; active: boolean; from_request: string | null; at: string }
export interface PageRule { page_id: string; title: string | null; visibility: string | null; page_knowledge: string | null; knowledge: string | null; multiplier: number; never_sell: boolean }
export interface Offer {
  id: string; title: string; teaser: string; price_cp: number; status: 'open' | 'paid' | 'declined' | 'expired' | 'withdrawn';
  expires_at: string; expires_sessions: number | null; created_at: string; paid_at: string | null; paid_by: string | null; paid_by_name: string | null;
  info?: string; page?: { id: string; title: string } | null; for_party?: boolean;
  targets?: string[]; target_names?: string[]; declined_by?: string[]; paid_from?: string | null;
}
/** "until the end of next session", or a date. */
export const offerExpiry = (o: Offer) => `${o.expires_sessions ? `Until the end of ${o.expires_sessions === 1 ? 'the next session' : `${o.expires_sessions} sessions`} · ` : ''}${new Date(o.expires_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
export interface Quote { quoteId: string; tier: string; tier_name: string; length: string; cost_cp: number | null; wait_text: string; secret: boolean; refused?: boolean; line: string; expires_in: number }

export interface Change {
  id: string; type: 'item'; item_id: string; owner: string; kind: 'add' | 'edit' | 'remove';
  before: Record<string, any> | null; after: Record<string, any> | null; reason: string | null; by: string; at: string;
  status: 'pending' | 'approved' | 'rejected' | 'alert' | 'ok' | 'disputed' | 'reverted'; dispute_note: string | null; decided_at: string | null;
}
export interface CoinReq { id: string; type: 'coin'; owner: string; amount_cp: number; note: string; by: string; at: string; status: string; decided_at: string | null }
export interface Mine { coin: CoinReq[]; items: Change[]; alerts: Change[]; party: boolean }

export const waitLabel = (t: Tier['wait']) => (!t || !t.amount ? 'At once' : `${t.amount} ${t.amount === 1 ? t.unit.replace(/s$/, '') : t.unit}${t.clock === 'game' ? ' (game time)' : ''}`);

/** "Ready in 4m 10s", ticking each second. */
export function Countdown({ at }: { at: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const ms = Date.parse(at) - Date.now();
  if (ms <= 0) return <span>Any moment now</span>;
  const s = Math.ceil(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>Ready in {d ? `${d}d ` : ''}{d || h ? `${h}h ` : ''}{m}m {d ? '' : `${r}s`}</span>;
}

export function ReadyLabel({ q }: { q: BrokerRequest }) {
  if (q.status !== 'waiting') return null;
  if (q.wait_clock === 'game') return <span>Ready at {q.ready_at_game_label} <span className="faint">(game time)</span></span>;
  return q.ready_at ? <Countdown at={q.ready_at} /> : null;
}

const STATUS: Record<string, [string, string]> = {
  pricing: ['Asking around', 'teal'], offered: ['Price offered', 'gold'], waiting: ['Waiting', ''], answered: ['Answered', 'green'],
  refused: ['Refused', 'red'], refunded: ['Refunded', 'red'], declined: ['Declined', ''], noted: ['Turned away', ''],
  open: ['Open', 'gold'], paid: ['Paid', 'green'], expired: ['Expired', ''], withdrawn: ['Withdrawn', ''],
  shared: ['Library', 'green'], secret: ['DM secret', 'red'], unknown: ['Unknown', 'teal'],
  pending: ['Waiting for the DM', 'teal'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'],
  alert: ['Changed by the DM', 'gold'], ok: ['Looks right', 'green'], disputed: ['Disputed', 'teal'], reverted: ['Undone', ''],
};
export function StatusChip({ s }: { s: string }) {
  const [label, tone] = STATUS[s] ?? [s, ''];
  return <span className={`chip ${tone}`}>{label}</span>;
}

/** What a change does, in a line. */
export function changeText(c: Change, nameOf: (id: string) => string): string {
  const name = c.after?.name ?? c.before?.name ?? 'an item';
  if (c.kind === 'add') return `Add ${c.after?.qty ?? 1} × ${name} to ${c.owner === 'party' ? 'the party stash' : nameOf(c.owner)}`;
  if (c.kind === 'remove') return `Remove ${name}`;
  const parts: string[] = [];
  for (const k of ['name', 'qty', 'note', 'weight', 'owner', 'link']) {
    if (!c.after || !(k in c.after) || c.before?.[k] === c.after[k]) continue;
    if (k === 'owner') parts.push(`move to ${c.after.owner === 'party' ? 'the party stash' : nameOf(c.after.owner)}`);
    else if (k === 'qty') parts.push(`qty ${c.before?.qty ?? '?'} → ${c.after.qty}`);
    else parts.push(`${k} → “${c.after[k] ?? ''}”`);
  }
  return `${name}: ${parts.join(', ') || 'edit'}`;
}

/** The player's own pending changes and the DM's alerts on their things. */
export function useMine() {
  const { w } = useWorld();
  return useLoad(() => w.call<Mine>('GET', '/approvals/mine'), [w], ['approval', 'item', 'coin']);
}

/** Alerts card: DM changes to my things, with "Looks right" / dispute. */
export function AlertsCard({ mine, reload, compact }: { mine: Mine | null; reload: () => Promise<void>; compact?: boolean }) {
  const { w, nameOf, info } = useWorld();
  const act = useAction();
  const [disputing, setDisputing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const open = (mine?.alerts ?? []).filter((a) => a.status === 'alert' || a.status === 'disputed');
  const coinsWaiting = (mine?.coin ?? []).filter((c) => c.status === 'pending');
  const itemsWaiting = (mine?.items ?? []).filter((c) => c.status === 'pending');
  if (!open.length && !coinsWaiting.length && !itemsWaiting.length) return null;
  return (
    <section className="card" aria-labelledby="alerts-h" style={{ borderColor: open.some((a) => a.status === 'alert') ? 'var(--accent)' : undefined }}>
      <h2 id="alerts-h">Changes to your things</h2>
      <ErrorBox error={act.error} />
      {open.map((a) => (
        <div key={a.id} className="list-item" style={{ display: 'block' }}>
          <div className="row between"><span>{changeText(a, nameOf)}</span><StatusChip s={a.status} /></div>
          <div className="small muted">{nameOf(a.by)} · {when(a.at)}{a.reason ? <> · “{a.reason}”</> : null}</div>
          {a.status === 'disputed' && <div className="small">You said: {a.dispute_note}</div>}
          {a.status === 'alert' && (disputing === a.id ? (
            <div className="stack tight" style={{ marginTop: 6 }}>
              <Field label="What's wrong?"><input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="I still had it after the fight" /></Field>
              <div className="row">
                <button type="button" className="btn small" onClick={() => setDisputing(null)}>Cancel</button>
                <button type="button" className="btn small primary" disabled={!note.trim() || act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/approvals/${a.id}/dispute`, { note: note.trim() }); setDisputing(null); setNote(''); await reload(); })}>Send to the DM</button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/approvals/${a.id}/ack`); await reload(); })}>✓ Looks right</button>
              <button type="button" className="btn small ghost" onClick={() => setDisputing(a.id)}>Dispute</button>
            </div>
          ))}
        </div>
      ))}
      {!compact && itemsWaiting.map((c) => (
        <div key={c.id} className="list-item row between"><span className="small">{changeText(c, nameOf)}</span><StatusChip s="pending" /></div>
      ))}
      {!compact && coinsWaiting.map((c) => (
        <div key={c.id} className="list-item row between"><span className="small">{c.note || 'Coin'}: {c.amount_cp > 0 ? '+' : ''}{coins(c.amount_cp, info.settings.coins)}</span><StatusChip s="pending" /></div>
      ))}
      {compact && (itemsWaiting.length + coinsWaiting.length > 0) && <p className="small muted">{itemsWaiting.length + coinsWaiting.length} change{itemsWaiting.length + coinsWaiting.length === 1 ? '' : 's'} waiting for the DM.</p>}
    </section>
  );
}

/** Home-page card: answers that are ready, and how many are on the way. */
export function BrokerTeaser() {
  const { w, info } = useWorld();
  const on = extra(info.settings).brokerEnabled;
  const list = useLoad(() => (on ? w.call<{ requests: BrokerRequest[] }>('GET', '/broker') : Promise.resolve(null)), [w, on], ['broker', 'broker-clock']);
  const offers = useLoad(() => (on ? w.call<Offer[]>('GET', '/broker/offers') : Promise.resolve(null)), [w, on], ['broker-offer']);
  if (!on) return null;
  const openOffers = (offers.data ?? []).filter((o) => o.status === 'open');
  const rs = list.data?.requests ?? [];
  const fresh = rs.filter((q) => q.status === 'answered' && q.delivered_at && Date.now() - Date.parse(q.delivered_at) < 3 * 86400_000).length;
  const waiting = rs.filter((q) => ['pricing', 'offered', 'waiting'].includes(q.status)).length;
  const offered = rs.filter((q) => q.status === 'offered').length;
  return (
    <section className="card" aria-labelledby="brk-h">
      <div className="card-head"><h2 id="brk-h">The broker</h2><Link to={`/w/${info.slug}/broker`} className="small">Visit →</Link></div>
      <span className="small">{fresh ? `${fresh} answer${fresh === 1 ? ' is' : 's are'} ready.` : waiting ? `${waiting} question${waiting === 1 ? '' : 's'} on the way.` : 'Buy what your character could find out.'}</span>
      {offered > 0 && <span className="small" style={{ color: 'var(--accent-strong)' }}>{offered} price{offered === 1 ? '' : 's'} offered. Pay or decline.</span>}
      {openOffers.map((o) => <span key={o.id} className="small" style={{ color: 'var(--accent-strong)' }}>✉ Someone offers knowledge of “{o.title}” for {coins(o.price_cp, info.settings.coins)}.</span>)}
    </section>
  );
}
