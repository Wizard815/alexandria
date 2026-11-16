// The tiered crawl on the world page: for each source, the index (list calls,
// pages), the details read so far, the background budget, "Fetch everything
// now" and pause. Also the DM's depth badge on a library page.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';

export interface TierInfo {
  id: string; name: string; tiered: boolean; connector?: string; pages?: number; read?: number;
  depth?: { index: number; summary: number; full: number; stale: number };
  calls?: { index: number; indexTotal: number; detailTotal: number };
  budget?: number; budgetDefault?: number; rateLimit?: number; paused?: boolean; fetchAll?: boolean; waiting?: number; waitingAll?: number;
}

const n = (x: number | undefined) => (x ?? 0).toLocaleString();

/** "Index: 14 calls, 2,031 pages · Details: 120 of 2,031 · Budget 30/min" */
export const tierLine = (t: TierInfo) => `Index: ${n(t.calls?.index)} calls, ${n(t.pages)} pages · Details: ${n(t.read)} of ${n(t.pages)} · Budget ${t.paused ? 'paused' : `${t.budget}/min`}`;

export function TierPanel({ worldId, active }: { worldId: string; active: boolean }) {
  const { client } = useAuth();
  const tiers = useLoad(() => client.request<TierInfo[]>('GET', `/api/admin/connections/tiers/world/${worldId}`), [worldId]);
  // The background reads a few pages every few seconds: follow it while something waits.
  const moving = active || !!tiers.data?.some((t) => t.tiered && !t.paused && ((t.fetchAll && (t.waitingAll ?? 0) > 0) || (t.waiting ?? 0) > 0));
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
      <p className="tiny muted" style={{ margin: 0 }}>A crawl only lists: the fewest calls that put every page in the library with its title, type, tags and parent. Pages are read in full when someone opens one, when the agent or a search needs it, and in the background within the budget below. Until then a page is DM-only.</p>
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
      <ErrorBox error={a.error} />
    </div>
  );
}

/** DM only: how much of a library page has been read from its source. Shows nothing for a page read in full. */
export function DepthBadge({ pageId }: { pageId: string }) {
  const { w, isDM } = useWorld();
  const d = useLoad<{ depths: Record<string, string> }>(() => (isDM ? w.call('GET', '/world-sources/depths') : Promise.resolve({ depths: {} })), [w, isDM, pageId]);
  const v = d.data?.depths?.[pageId];
  if (!isDM || !v) return null;
  const text = v === 'index' ? 'Listed only' : v === 'summary' ? 'Excerpt only' : 'Changed at source';
  return <span className="chip" title="Pages are read from their source when opened; this view is from before that.">{text}</span>;
}
