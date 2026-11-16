// Admin → Worlds → Set up a world: make a world, pick or make a connection,
// give the world-specific settings, choose who the source is for, then
// "Connect and crawl". The world and its source are saved first; the crawl
// can be cancelled on the world page without losing either.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Field, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { SourceFields, newDraft, problem, saveDraft, type Draft } from './SourceForm.tsx';
import { AUDIENCES, scheduleLabel, type Connection, type Connector } from './shared.tsx';

const STEPS = ['World', 'Connection', 'Settings', 'Audience', 'Crawl'] as const;

export default function SetupFlow() {
  const { client, me } = useAuth();
  const nav = useNavigate();
  const connectors = useLoad(() => client.request<Connector[]>('GET', '/api/admin/connectors'), []);
  const connections = useLoad(() => client.request<Connection[]>('GET', '/api/admin/connections'), []);
  const accounts = useLoad(() => client.request<any[]>('GET', '/api/admin/accounts'), []);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [dm, setDm] = useState(me?.account.id ?? '');
  const [d, setD] = useState<Draft | null>(null);
  // What is already saved, so a retry never makes a second world or source.
  const [worldId, setWorldId] = useState<string | null>(null);
  const [sourceDone, setSourceDone] = useState(false);
  const a = useAction();

  if (!connectors.data || !connections.data || !accounts.data) return <div className="page"><ErrorBox error={connectors.error || connections.error || accounts.error} /><Loading /></div>;
  const draft = d ?? newDraft(connectors.data, connections.data);
  const c = connectors.data.find((x) => x.id === draft.kind);
  const issue = problem(draft, c);

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const canNext = step === 0 ? !!name.trim() && !!dm : step === 1 ? !!c && (!c.hasConnection || !!draft.connectionId || !!draft.newName.trim()) : step === 2 ? !!draft.name.trim() : step === 3 ? draft.audience !== 'party' || draft.confirm : true;

  const go = () => a.run(async () => {
    let wid = worldId;
    if (!wid) { wid = (await client.request<{ id: string }>('POST', '/api/admin/worlds', { name: name.trim(), slug: slug.trim() || undefined, dmAccountId: dm })).id; setWorldId(wid); }
    if (!sourceDone) { await saveDraft(client, wid, draft, c!, (id) => setD({ ...draft, connectionId: id })); setSourceDone(true); }
    if (!c!.push) await client.request('POST', `/api/admin/worlds/${wid}/crawl`, {});
    nav(`/admin/worlds/${wid}`);
  });

  return (
    <div className="page">
      <PageHead title="Set up a world" lead="Make a world, connect it to where its lore lives, and read it all in. You can cancel the crawl at any point; the world and its source stay.">
        <Link className="btn" to="/admin/worlds">Back to worlds</Link>
      </PageHead>
      <ol className="row wrap" aria-label="Steps" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 6 }}>
        {STEPS.map((s, i) => <li key={s} className={`chip ${i === step ? 'gold' : ''}`} aria-current={i === step ? 'step' : undefined}>{i + 1}. {s}</li>)}
      </ol>
      <div className="card">
        {step === 0 && (
          <div className="stack">
            <Field label="World name"><input value={name} maxLength={80} placeholder="e.g. The Saltmarsh Chronicles" onChange={(e) => setName(e.target.value)} disabled={!!worldId} /></Field>
            <Field label="Short name for links (optional)" help="Lowercase letters, numbers and dashes. Left empty, it is made from the name."><input className="mono" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!!worldId} /></Field>
            <Field label="Dungeon Master"><select value={dm} onChange={(e) => setDm(e.target.value)} disabled={!!worldId}>{accounts.data.map((acc) => <option key={acc.id} value={acc.id}>{acc.display_name} ({acc.username})</option>)}</select></Field>
          </div>
        )}
        {step === 1 && <div className="stack"><SourceFields d={draft} set={setD} connectors={connectors.data} connections={connections.data} parts={['kind', 'connection']} /></div>}
        {step === 2 && <div className="stack"><p className="small muted" style={{ margin: 0 }}>What is specific to this world: its campaign or project, folder or address, and how often to read it again.</p><SourceFields d={draft} set={setD} connectors={connectors.data} connections={connections.data} parts={['settings']} /></div>}
        {step === 3 && <div className="stack"><SourceFields d={draft} set={setD} connectors={connectors.data} connections={connections.data} parts={['audience']} /></div>}
        {step === 4 && (
          <div className="stack">
            <h2 style={{ margin: 0 }}>Ready</h2>
            <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
              <li>World <strong>{name}</strong>{slug ? <> (<span className="mono">{slug}</span>)</> : null}</li>
              <li>{c?.label}: <strong>{draft.name || 'unnamed source'}</strong>{c?.hasConnection ? <> using {draft.connectionId ? <strong>{connections.data.find((x) => x.id === draft.connectionId)?.name}</strong> : <>a new connection <strong>{draft.newName}</strong></>}</> : null}</li>
              <li>Audience: <strong>{AUDIENCES.find((x) => x.id === draft.audience)?.label}</strong>{!c?.push && <> · {scheduleLabel(draft.schedule ? Number(draft.schedule) : null)}</>}</li>
            </ul>
            <p className="small muted" style={{ margin: 0 }}>{c?.push ? 'A push source has nothing to crawl: your tool sends its entries.' : 'The crawl reads every page, then embeds them for semantic search. If no embeddings model is set, it says so and finishes with the library.'}</p>
            {issue && <p className="error-box">{issue}</p>}
          </div>
        )}
        <ErrorBox error={a.error} />
        <div className="row between">
          <button type="button" className="btn" disabled={step === 0 || a.busy} onClick={back}>Back</button>
          {step < STEPS.length - 1
            ? <button type="button" className="btn primary" disabled={!canNext} onClick={next}>Next</button>
            : <button type="button" className="btn primary" disabled={a.busy || !!issue || !name.trim()} onClick={() => void go()}>{a.busy ? 'Working…' : c?.push ? 'Save' : 'Connect and crawl'}</button>}
        </div>
      </div>
    </div>
  );
}
