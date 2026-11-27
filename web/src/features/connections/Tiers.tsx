// The tiered crawl on the world page: for each source, the index (list calls,
// pages), the details read so far, the background budget, "Fetch everything
// now" and pause. Also the GM's depth badge on a library page.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';

export interface TierInfo {
  id: string; name: string; tiered: boolean; connector?: string; pages?: number; read?: number;
  depth?: { index: number; summary: number; full: number; stale: number };
  calls?: { index: number; indexTotal: number; detailTotal: number };
  budget?: number; budgetDefault?: number; rateLimit?: number; paused?: boolean; fetchAll?: boolean; waiting?: number; waitingAll?: number;
  /** The connection's limits (shared by every world that uses it) and this source's scan spread. */
  limits?: { perMinute: number; perSecond: number; perHour?: number; spreadMinutes: number; spreadOwn: boolean };
  /** Set while the source's key is refused for page content (lists work, content does not): the sentence to show. */
  refused?: string | null;
  /** Set while calls are held back: the site asked us to slow down, our own limit is reached, or the first scan is being spread out. */
  throttle?: { waitMs: number; reason: 'asked' | 'limit' | 'pace' } | null;
}

/** "Waiting 12 s — the site asked us to slow down" */
export function throttleText(t: TierInfo['throttle']): string | null {
  if (!t) return null;
  const s = Math.max(1, Math.round(t.waitMs / 1000));
  const wait = s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
  const why = t.reason === 'asked' ? 'the site asked us to slow down' : t.reason === 'pace' ? 'spreading the first scan out' : 'keeping under the calls-per-minute and calls-per-hour limits';
  return `Waiting ${wait} — ${why}`;
}

const n = (x: number | undefined) => (x ?? 0).toLocaleString();

/** "Index: 14 calls, 2,031 pages · Details: 120 of 2,031 · Budget 30/min" */
export const tierLine = (t: TierInfo) => `Index: ${n(t.calls?.index)} calls, ${n(t.pages)} pages · Details: ${n(t.read)} of ${n(t.pages)} · Budget ${t.paused ? 'paused' : `${t.budget}/min`}`;

export function TierPanel({ worldId, active }: { worldId: string; active: boolean }) {
  const { client } = useAuth();
  const tiers = useLoad(() => client.request<TierInfo[]>('GET', `/api/admin/connections/tiers/world/${worldId}`), [worldId]);
  // The background reads a few pages every few seconds: follow it while something waits.
  const moving = active || !!tiers.data?.some((t) => t.tiered && (!!t.throttle || (!t.paused && ((t.fetchAll && (t.waitingAll ?? 0) > 0) || (t.waiting ?? 0) > 0))));
  useEffect(() => {
    if (!moving) return;
    const i = setInterval(() => void tiers.reload(), 4000);
    return () => clearInterval(i);
  }, [moving, tiers]);
  const list = (tiers.data ?? []).filter((t) => t.tiered);
  if (!list.length) return null;
  return (
    <div className="stack tight" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <strong>Reading the sources</strong>
      <p className="tiny muted" style={{ margin: 0 }}>A crawl only lists: the fewest calls that put every page in the library with its title, type, tags and parent. Pages are read in full when someone opens one, when the agent or a search needs it, and in the background within the budget below. Until then a page is GM-only.</p>
      {list.map((t) => <TierRow key={t.id} t={t} onChanged={() => void tiers.reload()} />)}
      <ErrorBox error={tiers.error} />
    </div>
  );
}

function TierRow({ t, onChanged }: { t: TierInfo; onChanged: () => void }) {
  const { client } = useAuth();
  const a = useAction();
  const [budget, setBudget] = useState(String(t.budget ?? ''));
  useEffect(() => setBudget(String(t.budget ?? '')), [t.budget]);
  const [perMin, setPerMin] = useState(String(t.limits?.perMinute ?? ''));
  const [perSec, setPerSec] = useState(String(t.limits?.perSecond ?? ''));
  const [perHour, setPerHour] = useState(String(t.limits?.perHour ?? 0));
  const [spread, setSpread] = useState(String(t.limits?.spreadMinutes ?? ''));
  useEffect(() => { setPerMin(String(t.limits?.perMinute ?? '')); setPerSec(String(t.limits?.perSecond ?? '')); setPerHour(String(t.limits?.perHour ?? 0)); setSpread(String(t.limits?.spreadMinutes ?? '')); }, [t.limits?.perMinute, t.limits?.perSecond, t.limits?.perHour, t.limits?.spreadMinutes]);
  const limitsDirty = perMin !== String(t.limits?.perMinute) || perSec !== String(t.limits?.perSecond) || perHour !== String(t.limits?.perHour ?? 0) || spread !== String(t.limits?.spreadMinutes);
  const saveLimits = () => patch({ limits: { perMinute: Number(perMin), perSecond: Number(perSec || 0), perHour: Number(perHour || 0) }, spread: spread === '' ? null : Number(spread) });
  const slow = throttleText(t.throttle);
  const patch = (body: Record<string, unknown>) => a.run(async () => { await client.request('PATCH', `/api/admin/connections/tiers/${t.id}`, body); onChanged(); });
  const pct = t.pages ? Math.round(((t.read ?? 0) / t.pages) * 100) : 0;
  return (
    <div className="stack tight" style={{ background: 'var(--surface-2, transparent)', borderRadius: 8 }}>
      <div className="row between wrap"><strong>{t.name}</strong><span className="small">{tierLine(t)}</span></div>
      <div role="progressbar" aria-label={`${t.name} read in full`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} /></div>
      <div className="row wrap tiny muted" style={{ gap: 12 }}>
        <span>{n(t.depth?.index)} listed only</span>{!!t.depth?.summary && <span>{n(t.depth.summary)} with an excerpt</span>}<span>{n(t.depth?.full)} read in full</span>{!!t.depth?.stale && <span>{n(t.depth.stale)} changed at the source</span>}
        <span>{n(t.waiting)} waiting{t.fetchAll ? ' (everything)' : ' (opened or linked to)'}</span>
      </div>
      <div className="row wrap">
        <label className="row small" style={{ gap: 6 }}>Budget <input type="number" min={0} max={600} value={budget} style={{ width: 80 }} aria-label={`${t.name} background calls per minute`} onChange={(e) => setBudget(e.target.value)} /> calls a minute
          <span className="tiny muted">(limit about {t.rateLimit}; default {t.budgetDefault})</span></label>
        <button type="button" className="btn small" disabled={a.busy || budget === String(t.budget)} onClick={() => void patch({ budget: budget === '' ? null : Number(budget) })}>Set</button>
        <button type="button" className={`btn small${t.fetchAll ? ' on' : ''}`} disabled={a.busy} onClick={() => void patch({ fetchAll: !t.fetchAll })} title="Reads every page in the background, at the budget. It can take hours.">{t.fetchAll ? 'Stop fetching everything' : 'Fetch everything now'}</button>
        <button type="button" className="btn small" disabled={a.busy} onClick={() => void patch({ paused: !t.paused })}>{t.paused ? 'Resume' : 'Pause'}</button>
      </div>
      {t.limits && (
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="stack tight small" style={{ gap: 2 }}>Max calls per minute
            <input type="number" min={1} max={6000} value={perMin} style={{ width: 90 }} onChange={(e) => setPerMin(e.target.value)} aria-label={`${t.name} max calls per minute`} /></label>
          <label className="stack tight small" style={{ gap: 2 }}>Max calls per second
            <input type="number" min={0} max={100} value={perSec} style={{ width: 90 }} onChange={(e) => setPerSec(e.target.value)} aria-label={`${t.name} max calls per second`} /></label>
          <label className="stack tight small" style={{ gap: 2 }}>Max calls per hour
            <input type="number" min={0} max={100000} value={perHour} style={{ width: 90 }} onChange={(e) => setPerHour(e.target.value)} aria-label={`${t.name} max calls per hour`} /></label>
          <label className="stack tight small" style={{ gap: 2 }}>Spread the first scan over (minutes)
            <input type="number" min={0} max={1440} value={spread} style={{ width: 90 }} onChange={(e) => setSpread(e.target.value)} aria-label={`${t.name} spread the first scan over minutes`} /></label>
          <button type="button" className="btn small" disabled={a.busy || !limitsDirty || perMin === ''} onClick={() => void saveLimits()}>Save limits</button>
          <span className="tiny muted" style={{ flexBasis: '100%' }}>The three limits belong to the connection and are shared by every world that uses it: keep them at or under what the site allows (LegendKeeper also shares 12,000 an hour across every key of one project; Alexandria counts that too). If the site reports a lower per-minute limit, that one is used. A fifth of the minute and of the hour is kept for pages someone opens, so the background reader never takes all of it. 0 calls a second or an hour means no such cap; 0 minutes means the first scan runs as fast as the limits allow.</span>
        </div>
      )}
      {t.refused && <div role="alert" className="error-box small">{t.refused}</div>}
      {slow && <div role="status" className="small" style={{ color: 'var(--accent-strong)' }}>{slow}</div>}
      <ErrorBox error={a.error} />
    </div>
  );
}

/** GM only: how much of a library page has been read from its source. Shows nothing for a page read in full. */
export function DepthBadge({ pageId }: { pageId: string }) {
  const { w, isGM } = useWorld();
  const d = useLoad<{ depths: Record<string, string> }>(() => (isGM ? w.call('GET', '/world-sources/depths') : Promise.resolve({ depths: {} })), [w, isGM, pageId]);
  const v = d.data?.depths?.[pageId];
  if (!isGM || !v) return null;
  const text = v === 'index' ? 'Listed only' : v === 'summary' ? 'Excerpt only' : 'Changed at source';
  return <span className="chip" title="Pages are read from their source when opened; this view is from before that.">{text}</span>;
}
