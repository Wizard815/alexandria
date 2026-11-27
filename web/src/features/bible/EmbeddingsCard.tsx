// Admin > Models: the embeddings job, and how much of each world it (and the
// story bible) has read, per scope. "Index all now" reads everything waiting
// in one bulk pass (a job); "Re-embed world" forgets one world's vectors and
// facts and makes them again the same way.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import './bible.css';

interface Scope { eligible: number; pending: number; indexed: number; chunks?: number; facts?: number }
export interface Progress { eligible: number; indexed: number; pending: number; perMinute: number | null; etaSeconds: number | null; refused?: number }
interface WorldCov { id: string; name: string; embeddings: { scopes: Record<string, Scope>; chunks: number; progress?: Progress }; bible: { scopes: Record<string, Scope>; progress?: Progress } }

/** "12 of 58 · about 3 min left" */
export function progressText(p: Progress | undefined): string {
  if (!p || !p.pending) return '';
  const eta = p.etaSeconds === null ? 'working it out…' : p.etaSeconds < 90 ? 'about a minute left' : `about ${Math.round(p.etaSeconds / 60)} min left`;
  return `Indexing ${p.indexed} of ${p.eligible} · ${eta}`;
}
interface Cov { configured: boolean; model: string | null; location: string | null; chat: boolean; worlds: WorldCov[] }
const SCOPES: [string, string][] = [['dm', 'GM copy'], ['broker', 'Broker copy'], ['party', 'Party copy'], ['lifted', 'Shared with some']];

export default function EmbeddingsCard() {
  const { client } = useAuth();
  const [cov, setCov] = useState<Cov | null>(null);
  const act = useAction();
  const setError = act.setError;
  const load = useCallback(async () => { try { setCov(await client.request<Cov>('GET', '/api/admin/embeddings')); } catch (e: any) { setError(String(e?.message ?? e)); } }, [client, setError]);
  const busy = !!cov?.worlds.some((w) => w.embeddings.progress?.pending || w.bible.progress?.pending);
  useEffect(() => { void load(); const t = setInterval(() => void load(), busy ? 4000 : 15000); return () => clearInterval(t); }, [load, busy]);
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
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small" disabled={act.busy} title="Embed and read into the story bible everything that is waiting, in one fast pass" onClick={() => void act.run(async () => { await client.request('POST', `/api/admin/embeddings/${wd.id}/build`); await load(); })}>Index all now</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await client.request('POST', `/api/admin/embeddings/${wd.id}/reembed`); await load(); })}>Re-embed world</button>
            </span>
          </div>
          {(wd.embeddings.progress?.pending || wd.bible.progress?.pending) ? (
            <div className="small" role="status" data-testid="embed-progress">
              {wd.embeddings.progress?.pending ? <div><strong>Embeddings:</strong> {progressText(wd.embeddings.progress)}{wd.embeddings.progress.refused ? ` · ${wd.embeddings.progress.refused} held back by the guard` : ''}</div> : null}
              {wd.bible.progress?.pending ? <div><strong>Story bible:</strong> {progressText(wd.bible.progress)}</div> : null}
            </div>
          ) : null}
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
