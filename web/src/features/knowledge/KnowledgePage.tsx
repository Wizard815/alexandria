// DM: how current everything the AI knows about the world is (sources, pictures, search index, story bible, Minerva's codex links), and
// "Refresh world": one job that brings all of it up to date, step by step.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { formatSize } from '../../lib/offline.ts';
import { ErrorBox, Loading, PageHead, useAction, useToast } from '../../ui/index.tsx';

type StepState = 'waiting' | 'running' | 'done' | 'skipped' | 'error' | 'stopped';
interface Step { id: string; label: string; state: StepState; detail: string }
interface Refresh { id: string; status: 'running' | 'ok' | 'error' | 'stopped'; full: boolean; startedAt: string; finishedAt: string | null; steps: Step[] }
interface Pics { held: number; waiting: number; failed: number; bytes: number }
interface Source { id: string; name: string; kind: string; enabled: boolean; lastSyncAt: string | null; lastStatus: string | null; pages: number; pictures: Pics }
interface Coverage { configured: boolean; model: string | null; eligible: number; indexed: number; pending: number }
interface Status {
  running: boolean; crawling: boolean; indexing: boolean; refresh: Refresh | null; pages: number; sources: Source[]; pictures: Pics;
  embeddings: (Coverage & { chunks: number }) | null; bible: (Coverage & { facts: number }) | null;
  minerva: { on: boolean; pages: number; linked: number; broken: number };
}

const ICON: Record<StepState, string> = { waiting: 'fa-regular fa-circle', running: 'fa-solid fa-spinner fa-spin', done: 'fa-solid fa-circle-check', skipped: 'fa-solid fa-circle-minus', error: 'fa-solid fa-triangle-exclamation', stopped: 'fa-solid fa-circle-stop' };
const WORD: Record<StepState, string> = { waiting: 'Waiting', running: 'Running', done: 'Done', skipped: 'Skipped', error: 'Problem', stopped: 'Stopped' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);

export default function KnowledgePage() {
  const { w, info } = useWorld();
  const st = useLoad<Status>(() => w.call('GET', '/knowledge'), [w], ['knowledge', 'crawl']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const s = st.data;
  const busy = !!s?.running;
  useEffect(() => { const t = setInterval(() => void st.reload(), busy ? 2000 : 30_000); return () => clearInterval(t); }, [busy, st.reload]);
  if (!s) return st.error ? <ErrorBox error={st.error} /> : <Loading what="knowledge" />;
  const start = (full: boolean) => act.run(async () => { await w.call('POST', '/knowledge/refresh', { full }); toast('Refreshing the world'); await st.reload(); });
  const stop = () => act.run(async () => { await w.call('POST', '/knowledge/refresh/stop'); await st.reload(); });
  const dm = (to: string) => `/w/${info.slug}/dm/${to}`;
  const r = s.refresh;
  return (
    <div className="stack">
      <PageHead title="Knowledge" lead="Everything the assistant knows about this world: your sources, their pictures, the search index, the story bible and Minerva’s codex. Refresh it all in one step." />
      <ErrorBox error={act.error ?? st.error} />
      <section className="card stack" aria-label="Refresh world" data-testid="knowledge-refresh">
        <div className="row between">
          <span><span className={`live-dot${busy ? '' : ' off'}`} /> <strong>{busy ? 'Refreshing the world' : r ? `Last refresh: ${r.status === 'ok' ? 'finished' : r.status === 'stopped' ? 'stopped' : 'finished with problems'}` : 'Not refreshed yet'}</strong>
            {r && <span className="small muted"> · {busy ? `started ${when(r.startedAt)}` : when(r.finishedAt)}</span>}</span>
          <span className="row" style={{ gap: 6 }}>
            {busy ? <button type="button" className="btn small" disabled={act.busy} onClick={() => void stop()}>Stop</button> : <>
              <button type="button" className="btn small primary" disabled={act.busy || s.crawling} title={s.crawling ? 'A crawl is running' : 'Sync what changed, store pictures, index, and mend links'} onClick={() => void start(false)}><i className="fa-solid fa-arrows-rotate" aria-hidden="true" /> Refresh world</button>
              <button type="button" className="btn small" disabled={act.busy || s.crawling} title="Lists every page of every source again: slower, and removes pages a source no longer has" onClick={() => void start(true)}>Full refresh</button>
            </>}
          </span>
        </div>
        {r && (
          <ol className="stack tight" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {r.steps.map((x) => (
              <li key={x.id} className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                <i className={ICON[x.state]} aria-hidden="true" style={{ width: 16 }} />
                <span className="stack tight grow"><span><strong>{x.label}</strong> <span className="tiny muted">{WORD[x.state]}</span></span>{x.detail && <span className="small muted">{x.detail}</span>}</span>
              </li>
            ))}
          </ol>
        )}
        {!r && <p className="small muted">A refresh syncs every source, downloads the pictures they show so they work offline, reads new pages into the search index and story bible, and mends Minerva’s links to library pages.</p>}
      </section>

      <section className="card stack" aria-label="Sources">
        <h3 style={{ margin: 0 }}>Sources</h3>
        {s.sources.length ? <div className="scroll-x"><table className="table"><thead><tr><th>Source</th><th>Pages</th><th>Pictures</th><th>Last sync</th></tr></thead><tbody>
          {s.sources.map((x) => (
            <tr key={x.id}>
              <td>{x.name}{!x.enabled && <span className="tiny faint"> (off)</span>}</td>
              <td>{x.pages.toLocaleString()}</td>
              <td className="small">{x.pictures.held.toLocaleString()} stored{x.pictures.bytes ? ` (${formatSize(x.pictures.bytes)})` : ''}{x.pictures.waiting ? `, ${x.pictures.waiting} waiting` : ''}{x.pictures.failed ? `, ${x.pictures.failed} failed` : ''}</td>
              <td className="small">{when(x.lastSyncAt)}{x.lastStatus && <span className="tiny muted"> · {x.lastStatus}</span>}</td>
            </tr>
          ))}
        </tbody></table></div> : <p className="small muted">No sources yet. Add Kanka, LegendKeeper, World Anvil, Notion, Obsidian or a folder in <Link to={dm('settings')}>Settings</Link>.</p>}
      </section>

      <section className="card stack" aria-label="Indexes">
        <h3 style={{ margin: 0 }}>Indexes</h3>
        <Meter label="Search index (embeddings)" c={s.embeddings} extra={s.embeddings ? `${s.embeddings.chunks.toLocaleString()} chunks` : ''} />
        <Meter label="Story bible" c={s.bible} extra={s.bible ? `${s.bible.facts.toLocaleString()} facts` : ''} to={dm('bible')} />
        <div className="small">
          <strong>Minerva’s codex</strong>{' '}
          {s.minerva.on ? <span className="muted">{s.minerva.linked} of {s.minerva.pages} pages linked to the library{s.minerva.broken ? <>, <span className="warn">{s.minerva.broken} point at a page that is gone</span></> : ''}. <Link to={dm('minerva')}>Open Minerva</Link></span> : <span className="muted">Minerva is off for this world.</span>}
        </div>
        <span className="tiny faint">{s.pages.toLocaleString()} library pages · {s.pictures.held.toLocaleString()} pictures stored here{s.pictures.waiting ? `, ${s.pictures.waiting} waiting` : ''}.</span>
      </section>
      {toastNode}
    </div>
  );
}

function Meter({ label, c, extra, to }: { label: string; c: Coverage | null; extra: string; to?: string }) {
  if (!c || !c.configured) return <div className="small"><strong>{label}</strong> <span className="muted">No model is set (Admin &gt; Models).</span></div>;
  return (
    <label className="small stack tight">
      <span><strong>{to ? <Link to={to}>{label}</Link> : label}</strong> <span className="muted">{c.indexed.toLocaleString()} of {c.eligible.toLocaleString()} pages ({pct(c.indexed, c.eligible)}%){c.pending ? `, ${c.pending.toLocaleString()} waiting` : ''}{extra ? ` · ${extra}` : ''}{c.model ? ` · ${c.model}` : ''}</span></span>
      <progress value={c.indexed} max={Math.max(1, c.eligible)} style={{ width: '100%' }} />
    </label>
  );
}
