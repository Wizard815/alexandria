// DM: what the story bible is doing now, how far it is, start, pause and check it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, useAction, useToast } from '../../ui/index.tsx';
import { progressText, type Progress } from './EmbeddingsCard.tsx';

interface Scope { eligible: number; pending: number; indexed: number; facts: number }
interface Status { chat: boolean; configured: boolean; model: string | null; runs: string; reading: boolean; now: { pageId: string; title: string; scope: string; since: string } | null; failed: number; embedded: { facts: number; withVectors: number };
  log: { at: string; pageId: string; title: string; scope: string; ok: boolean; facts: number; ms: number }[]; scopes: Record<string, Scope>; progress?: Progress }
interface Finding { kind: string; pageId: string; title: string; scope: string; note: string }
interface Audit { facts: number; counts: Record<string, number>; findings: Finding[] }
const READERS: [string, string][] = [['party', 'Players'], ['broker', 'Broker'], ['dm', 'DM']];
const WHO: Record<string, string> = { party: 'players', broker: 'broker', dm: 'DM', lifted: 'shared with some' };
const KINDS: Record<string, string> = { failed: 'Could not be read', empty: 'Read, but nothing found', unsupported: 'Names something the page does not' };

export function BibleControls({ left, onChanged }: { left: string; onChanged: () => void }) {
  const { w, info, reloadInfo } = useWorld();
  const st = useLoad<Status>(() => w.call('GET', '/bible/status'), [w], ['settings', 'chat-session', 'recording']);
  const [open, setOpen] = useState<'log' | 'audit' | null>(null);
  const [audit, setAudit] = useState<Audit | null>(null);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const s = st.data;
  const busy = !!s?.now;
  useEffect(() => { const t = setInterval(() => void st.reload(), busy ? 4000 : 20_000); return () => clearInterval(t); }, [busy, st.reload]);
  if (!s) return <ErrorBox error={st.error} />;
  const set = (bibleRuns: string) => act.run(async () => { await w.updateSettings({ bibleRuns } as any); if (bibleRuns === 'off') await w.call('POST', '/bible/stop'); await reloadInfo(); await st.reload(); onChanged(); });
  const readNow = () => act.run(async () => { await w.call('POST', '/bible/read-now'); toast('Reading up to 25 pages'); await st.reload(); });
  const check = () => act.run(async () => { setAudit(await w.call<Audit>('GET', '/bible/audit')); setOpen('audit'); });
  const reread = (ids: string[]) => act.run(async () => { const r = await w.call<{ pages: number }>('POST', '/bible/reread', { pageIds: [...new Set(ids)].slice(0, 500) }); toast(`${r.pages} will be read again`); setAudit(await w.call<Audit>('GET', '/bible/audit')); await st.reload(); onChanged(); });
  const href = (id: string) => `/w/${info.slug}/dm/library?page=${encodeURIComponent(id)}`;
  const state = s.now ? `Reading “${s.now.title}” (${WHO[s.now.scope] ?? s.now.scope} copy)` : !s.configured ? 'No model is set' : s.runs === 'off' ? 'Paused' : s.reading ? 'Ready, between pages' : 'Waiting for the next session';
  return (
    <section className="card" aria-label="Story bible progress" data-testid="bible-controls">
      <ErrorBox error={act.error ?? st.error} />
      <div className="row between">
        <span><span className={`live-dot${s.now ? '' : ' off'}`} /> <strong>{state}</strong>{left && <span className="small muted" data-testid="bible-progress"> · {left}</span>}</span>
        <span className="row" style={{ gap: 6 }}>
          {s.now ? <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', '/bible/stop'); await st.reload(); })}>Stop this run</button> : <button type="button" className="btn small" disabled={act.busy || !s.configured} onClick={() => void readNow()}>Read 25 now</button>}
          <select className="input" style={{ width: 'auto', minHeight: 30 }} aria-label="When it reads" value={s.runs} onChange={(e) => void set(e.target.value)}><option value="session">During sessions</option><option value="always">Any time</option><option value="off">Paused</option></select>
          <button type="button" className={`btn small${open === 'log' ? ' on' : ''}`} aria-expanded={open === 'log'} onClick={() => setOpen(open === 'log' ? null : 'log')}>Log</button>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void check()}>Check it</button>
        </span>
      </div>
      <div className="row" style={{ gap: 18 }}>
        {READERS.map(([k, label]) => { const x = s.scopes[k]; return x ? <label key={k} className="small stack tight" style={{ flex: '1 1 160px' }}><span>{label}: {x.indexed} of {x.eligible} pages · {x.facts.toLocaleString()} facts</span><progress value={x.indexed} max={Math.max(1, x.eligible)} style={{ width: '100%' }} /></label> : null; })}
      </div>
      <span className="tiny faint">{s.embedded.withVectors.toLocaleString()} of {s.embedded.facts.toLocaleString()} facts are embedded (found by meaning).{s.model ? ` Model: ${s.model}.` : ''}{s.failed ? ` ${s.failed} could not be read.` : ''}</span>
      {open === 'log' && (s.log.length ? <div className="scroll-x"><table className="table"><thead><tr><th>When</th><th>Page</th><th>For</th><th>Result</th><th>Took</th></tr></thead><tbody>{s.log.map((r, i) => <tr key={i}><td className="small">{new Date(r.at).toLocaleTimeString()}</td><td><Link to={href(r.pageId)}>{r.title}</Link></td><td className="small">{WHO[r.scope] ?? r.scope}</td><td className="small">{r.ok ? `${r.facts} facts` : 'no usable answer'}</td><td className="small">{(r.ms / 1000).toFixed(1)} s</td></tr>)}</tbody></table></div> : <p className="small muted">Nothing read since the server started.</p>)}
      {open === 'audit' && audit && (
        <div className="stack tight">
          <p className="small">Checked {audit.facts.toLocaleString()} facts. {['failed', 'empty', 'unsupported'].map((k) => `${KINDS[k]}: ${audit.counts[k]}`).join(' · ')}. {audit.counts.copies > 0 && `${audit.counts.copies} pages exist more than once, so each copy is read.`}</p>
          {audit.findings.length > 0 && <div className="row"><button type="button" className="btn small" disabled={act.busy} onClick={() => { if (window.confirm(`Read these ${new Set(audit.findings.map((f) => f.pageId)).size} pages again? Their facts are removed until then.`)) void reread(audit.findings.map((f) => f.pageId)); }}>Read all of these again</button></div>}
          <div className="share-list" style={{ maxHeight: 320 }}>{audit.findings.map((f, i) => <div key={i} className="list-item"><span className="stack tight grow"><Link to={href(f.pageId)}>{f.title}</Link><span className="tiny muted">{KINDS[f.kind] ?? f.kind} ({WHO[f.scope] ?? f.scope}): {f.note}</span></span><button type="button" className="btn small" disabled={act.busy} onClick={() => void reread([f.pageId])}>Read again</button></div>)}</div>
          {!audit.findings.length && <p className="ok-box small">Nothing to fix.</p>}
        </div>
      )}
      {toastNode}
    </section>
  );
}
