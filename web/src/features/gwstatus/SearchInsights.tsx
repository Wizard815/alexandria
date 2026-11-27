// Admin → Search, below the search box: what people have been searching for. Words are shown only for worlds the admin is the GM of;
// every other world is counts. "Draft pages for these" makes GM-only drafts for what found nothing, in a world the admin is the GM of.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Loading, useAction, useToast } from '../../ui/index.tsx';
import { Pill, Section } from '../../pages/admin/kit.tsx';
import { ago, usePolled, type SearchStats } from './api.ts';
import './gwstatus.css';

const ORIGIN: Record<string, string> = { library: 'Library search', global: 'Search box', admin: 'Admin search', agent: 'AI assistant' };

function Meter({ value, max }: { value: number; max: number }) {
  return <div className="gws-meter" aria-hidden="true"><span style={{ width: `${Math.max(3, (value / Math.max(1, max)) * 100)}%` }} /></div>;
}

export default function SearchInsights() {
  const [days, setDays] = useState(7);
  const q = usePolled<SearchStats>(`/searches?days=${days}`, 20_000);
  const { client } = useAuth();
  const a = useAction();
  const { toast, toastNode } = useToast();
  const d = q.data;
  const drafts = (world: string, queries?: string[]) => void a.run(async () => {
    const r = await client.request<{ created: unknown[]; skipped: string[] }>('POST', '/api/admin/gwstatus/searches/draft', { world, ...(queries ? { queries } : {}) });
    toast(r.created.length ? `Made ${r.created.length} GM-only draft page${r.created.length === 1 ? '' : 's'} in drafts/` : 'Nothing new to draft');
    await q.reload();
  });
  const range = (
    <span className="gws-range" role="group" aria-label="Period">
      {[7, 30].map((n) => <button key={n} type="button" className={`btn small${days === n ? ' primary' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>{n} days</button>)}
    </span>
  );
  if (q.loading && !d) return <Loading />;
  if (!d) return <ErrorBox error={q.error} />;
  const hiddenWorlds = d.worlds.filter((w) => w.view === 'counts' && w.searches > 0);
  const gmWorlds = d.worlds.filter((w) => w.view === 'gm');
  const maxPop = Math.max(1, ...d.popular.map((p) => p.count));
  const maxSrc = Math.max(1, ...d.bySource.map((s) => s.count));
  const nothingBy = new Map<string, SearchStats['nothing']>();
  for (const n of d.nothing) nothingBy.set(n.world.id, [...(nothingBy.get(n.world.id) ?? []), n]);

  return (
    <>
      <div className="adm-section-head" style={{ marginTop: 8 }}>
        <div className="stack tight">
          <h2 style={{ margin: 0 }}>What people are searching</h2>
          <p className="small muted">{d.totals.searches.toLocaleString()} searches in the last {d.days} days, {d.totals.nothing.toLocaleString()} found nothing. Searches are kept {d.retentionDays} days; result titles are never kept.</p>
        </div>
        {range}
      </div>
      <ErrorBox error={a.error || q.error} />
      <div className="gws-insights">
        <Section title="Most searched" lead="The words people typed, in worlds you are the GM of.">
          {d.popular.length ? (
            <ul className="gws-list">{d.popular.slice(0, 10).map((p) => (
              <li key={`${p.world.id}${p.q}`}>
                <span className="gws-q"><strong>{p.q}</strong> <Pill>{p.world.name}</Pill></span><span className="gws-count">{p.count}×</span>
                <Meter value={p.count} max={maxPop} />
              </li>
            ))}</ul>
          ) : <p className="muted small">{gmWorlds.length ? 'Nobody has searched yet.' : 'You are not the GM of any world, so no words are shown.'}</p>}
          {hiddenWorlds.length > 0 && (
            <p className="tiny muted" style={{ marginTop: 10 }}>
              The words searched in {hiddenWorlds.map((w) => `${w.name} (${w.searches})`).join(', ')} are shown only to {hiddenWorlds.length === 1 ? 'its GM' : 'their GMs'}: you see counts.
            </p>
          )}
        </Section>

        <Section title="Found nothing" lead="Searches whose latest try found no page. A gap in the library, or a different word for something you have.">
          {[...nothingBy].length ? [...nothingBy].map(([wid, list]) => (
            <div key={wid} className="stack tight">
              <div className="gws-world-head"><span>{list[0].world.name}</span>
                <button type="button" className="btn small primary" disabled={a.busy || list.every((x) => x.drafted)} onClick={() => drafts(wid, list.filter((x) => !x.drafted).map((x) => x.q))}>Draft pages for these</button>
              </div>
              <ul className="gws-list">{list.slice(0, 10).map((n) => (
                <li key={n.q}><span className="gws-q"><strong>{n.q}</strong> {n.drafted && <Pill tone="ok">drafted</Pill>}</span><span className="gws-count">{n.count}× <span className="tiny faint">{ago(n.lastAt)}</span></span></li>
              ))}</ul>
            </div>
          )) : <p className="muted small">{d.totals.nothing ? `${d.totals.nothing} searches found nothing; their words are shown only to the GM of each world.` : 'Every search found something.'}</p>}
          {nothingBy.size > 0 && <p className="tiny muted" style={{ marginTop: 8 }}>Drafts are GM-only pages in <span className="mono">drafts/</span>, one per missing search.</p>}
        </Section>

        <Section title="Searches by source" lead="Where the answers came from, counting each result.">
          {d.bySource.length ? (
            <ul className="gws-list">{d.bySource.map((s) => (
              <li key={s.name}><span className="gws-q">{s.name}</span><span className="gws-count">{s.count.toLocaleString()}</span><Meter value={s.count} max={maxSrc} /></li>
            ))}</ul>
          ) : <p className="muted small">No results yet.</p>}
          {d.byOrigin.length > 0 && <p className="tiny muted" style={{ marginTop: 10 }}>{d.byOrigin.map((o) => `${ORIGIN[o.origin] ?? o.origin} ${o.count}`).join(' · ')}</p>}
        </Section>
      </div>
      {toastNode}
    </>
  );
}
