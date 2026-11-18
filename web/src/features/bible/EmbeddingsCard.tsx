// Admin > Models: the embeddings job, and how much of each world it (and the
// story bible) has read, per scope. "Re-embed world" forgets one world's
// vectors and facts so they are made again in the background.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import './bible.css';

interface Scope { eligible: number; pending: number; indexed: number; chunks?: number; facts?: number }
interface WorldCov { id: string; name: string; embeddings: { scopes: Record<string, Scope>; chunks: number }; bible: { scopes: Record<string, Scope> } }
interface Cov { configured: boolean; model: string | null; location: string | null; chat: boolean; worlds: WorldCov[] }
const SCOPES: [string, string][] = [['dm', 'DM copy'], ['broker', 'Broker copy'], ['party', 'Party copy'], ['lifted', 'Shared with some']];

export default function EmbeddingsCard() {
  const { client } = useAuth();
  const [cov, setCov] = useState<Cov | null>(null);
  const act = useAction();
  const setError = act.setError;
  const load = useCallback(async () => { try { setCov(await client.request<Cov>('GET', '/api/admin/embeddings')); } catch (e: any) { setError(String(e?.message ?? e)); } }, [client, setError]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]);
  if (!cov) return <div className="card"><ErrorBox error={act.error} /></div>;
  return (
    <div className="card stack">
      <div className="row">
        <strong>Embeddings job</strong>
        {cov.configured ? <span className="chip green">on · {cov.model}{cov.location ? ` · ${cov.location}` : ''}</span> : <span className="chip">off: search is keyword only</span>}
        <span className={`chip ${cov.chat ? 'green' : ''}`}>story bible: {cov.chat ? 'chat model set' : 'needs a chat model'}</span>
      </div>
      <ErrorBox error={act.error} />
      {cov.worlds.map((wd) => (
        <div key={wd.id} className="stack tight">
          <div className="row between">
            <strong>{wd.name}</strong>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await client.request('POST', `/api/admin/embeddings/${wd.id}/reembed`); await load(); })}>Re-embed world</button>
          </div>
          <div className="emb-grid">
            {SCOPES.map(([k, label]) => {
              const e = wd.embeddings.scopes[k]; const b = wd.bible.scopes[k];
              return (
                <div key={k} className="emb-cell">
                  <strong>{label}</strong>
                  <span className="small">{e.indexed}/{e.eligible} pages</span><br />
                  <span className="tiny muted">{e.chunks ?? 0} chunks{e.pending ? ` · ${e.pending} waiting` : ''}</span><br />
                  <span className="tiny muted">{b.facts ?? 0} facts{b.pending ? ` · ${b.pending} waiting` : ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
