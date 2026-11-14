// Admin → Models: VRAM view. For each Argos provider: the cards, what is loaded, a budget row
// for the models the jobs use, and a "Copy Argos config" button that keeps those models resident.
// Reads Argos's GET /api/pool and GET /running through the librarian; nothing from a world.
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Loading, useToast } from '../../ui/index.tsx';

interface Card { id: string; capGiB: number; usedGiB: number; freeGiB: number; models: string[] }
interface PoolModel { id: string; state: string; sizeGiB: number; sizeKnown: boolean; cards: string[]; persistent: boolean }
type Fit = 'ok' | 'undeclared' | 'unknown-to-argos' | 'too-big' | 'wont-fit';
interface Row { job: string; model: string; sizeGiB: number | null; loaded: boolean; fit: Fit; note: string }
interface Budget { rows: Row[]; neededGiB: number; availableGiB: number; totalGiB: number; usedGiB: number; freeGiB: number; allFit: boolean; incomplete: boolean }
interface Prov {
  id: string; name: string; ok: boolean; error?: string; router: string;
  pool: { enabled: boolean; router: string; cards: Card[]; models: PoolModel[] } | null;
  running: { model: string; state: string; ttl?: number; usedByJobs: string[] }[];
  budget: Budget | null; jobModels: { job: string; model: string }[];
  config: { group: string; pool: string };
}

const gib = (n: number) => `${Math.round(n * 10) / 10} GiB`;
const FIT_TEXT: Record<Fit, string> = { ok: 'fits', undeclared: 'no vram declared', 'unknown-to-argos': 'not an Argos model name', 'too-big': 'too big for the cards', 'wont-fit': "won't fit with the others" };

function Bar({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return <div role="img" aria-label={`${pct}% used`} style={{ height: 8, borderRadius: 4, background: 'var(--line, #ddd)', overflow: 'hidden', minWidth: 90 }}><div style={{ width: `${pct}%`, height: '100%', background: pct > 90 ? 'var(--red, #b3261e)' : 'var(--accent, #4a6fa5)' }} /></div>;
}

function Provider({ p }: { p: Prov }) {
  const [which, setWhich] = useState<'group' | 'pool'>(p.router === 'pool' ? 'pool' : 'group');
  const { toast, toastNode } = useToast();
  const text = p.config[which];
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Select the text and copy it')); };
  const b = p.budget;
  return (
    <div className="stack tight" data-vram-provider={p.id}>
      <h3 style={{ margin: 0 }}>{p.name}</h3>
      {!p.ok && <div className="error-box" role="alert">{p.error ?? 'Argos did not answer.'}</div>}
      {p.ok && p.pool?.enabled && (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="small" style={{ borderCollapse: 'collapse', minWidth: 360 }} data-testid="vram-cards">
              <thead><tr><th align="left">Card</th><th align="right">Total</th><th align="right">Used</th><th align="right">Free</th><th align="left"> </th></tr></thead>
              <tbody>{p.pool.cards.map((c) => (
                <tr key={c.id} data-card={c.id}><td>{c.id}</td><td align="right">{gib(c.capGiB)}</td><td align="right">{gib(c.usedGiB)}</td><td align="right">{gib(c.freeGiB)}</td><td><Bar used={c.usedGiB} cap={c.capGiB} /></td></tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small" style={{ margin: 0 }}><strong>Loaded:</strong> {p.pool.models.filter((m) => m.state === 'ready' || m.state === 'starting').map((m) => `${m.id} (${m.sizeKnown ? gib(m.sizeGiB) : 'size not declared'}${m.cards.length ? `, card ${m.cards.join('+')}` : ''}${m.persistent ? ', persistent' : ''})`).join('; ') || 'nothing'}</p>
          <p className="tiny muted" style={{ margin: 0 }}>These are the pool's plan from each model's declared <code>vram</code>, not live memory. The Argos Performance page shows the real memory.</p>
          {b && (
            <div className="stack tight" data-testid="vram-budget">
              <p className="small" style={{ margin: 0 }}>
                <strong>Your jobs:</strong> {gib(b.neededGiB)} wanted{b.incomplete ? ' (at least: some sizes are missing)' : ''}, {gib(b.availableGiB)} available to them of {gib(b.totalGiB)}.{' '}
                {b.allFit && !b.incomplete ? <span className="chip green">fits</span> : b.allFit ? <span className="chip gold">fits as far as known</span> : <span className="chip red">does not all fit</span>}
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table className="small" style={{ borderCollapse: 'collapse', minWidth: 400 }}>
                  <thead><tr><th align="left">Job</th><th align="left">Model</th><th align="right">VRAM</th><th align="left">State</th><th align="left">Check</th></tr></thead>
                  <tbody>{b.rows.map((r) => (
                    <tr key={r.job} data-budget-job={r.job} data-fit={r.fit}>
                      <td>{r.job}</td><td>{r.model}</td><td align="right">{r.sizeGiB === null ? '?' : gib(r.sizeGiB)}</td><td>{r.loaded ? 'loaded' : 'not loaded'}</td>
                      <td><span className={`chip ${r.fit === 'ok' ? 'green' : r.fit === 'undeclared' || r.fit === 'unknown-to-argos' ? 'gold' : 'red'}`} title={r.note}>{FIT_TEXT[r.fit]}</span></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {b.rows.filter((r) => r.note).map((r) => <p key={r.job} className="tiny muted" style={{ margin: 0 }}>{r.job}: {r.note}</p>)}
            </div>
          )}
        </>
      )}
      {p.ok && !p.pool?.enabled && (
        <div className="stack tight" data-testid="vram-nopool">
          <p className="small" style={{ margin: 0 }}>The pool router is off on this Argos{p.pool?.router ? ` (it uses the ${p.pool.router} router)` : ''}, so it reports no VRAM. This is what is running:</p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {p.running.length === 0 && <li className="muted">Nothing is loaded.</li>}
            {p.running.map((m) => <li key={m.model}>{m.model} ({m.state}{m.ttl === 0 ? ', never unloads' : m.ttl ? `, unloads after ${m.ttl}s idle` : ''}){m.usedByJobs.length ? ` for ${m.usedByJobs.join(', ')}` : ''}</li>)}
          </ul>
          <p className="tiny muted" style={{ margin: 0 }}>To see cards and a fit check, switch Argos to the pool router (<code>routing.router.use: pool</code>) and set <code>vram</code> on each model.</p>
        </div>
      )}

      {p.ok && (
        <div className="stack tight" data-testid="argos-config">
          <p className="small" style={{ margin: 0 }}><strong>Keep these models resident.</strong> Pick the snippet for the router Argos uses{p.pool ? ` (this one reports ${p.pool.enabled ? 'pool' : p.pool.router || 'group'})` : ''}:</p>
          <ul className="tiny" style={{ margin: 0, paddingLeft: 18 }}>
            <li><strong>Group router</strong> (the default): a <code>dnd</code> group with <code>persistent: true</code>, <code>swap: false</code>, <code>exclusive: false</code>, so these models all stay loaded and no other group can evict them. Plus <code>ttl: 0</code> so idle time never unloads them.</li>
            <li><strong>Pool router:</strong> models share the GPUs while they fit. List them under <code>pool.persistent</code> so they are never evicted for another model, and give each a <code>vram</code> so the pool can plan.</li>
          </ul>
          <div className="row">
            <select value={which} onChange={(e) => setWhich(e.target.value as 'group' | 'pool')} aria-label="Argos router">
              <option value="group">Group router</option>
              <option value="pool">Pool router</option>
            </select>
            <button type="button" className="btn" onClick={copy} disabled={p.jobModels.length === 0}>Copy Argos config</button>
          </div>
          <pre className="small" style={{ margin: 0, overflowX: 'auto', whiteSpace: 'pre' }} data-testid="argos-config-text">{text}</pre>
        </div>
      )}
      {toastNode}
    </div>
  );
}

export default function VramCard({ refreshKey }: { refreshKey: string }) {
  const { client } = useAuth();
  const [provs, setProvs] = useState<Prov[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setProvs((await client.request<{ providers: Prov[] }>('GET', '/api/admin/models/vram')).providers); } catch (e: any) { setError(String(e?.message ?? e)); }
  }, [client]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return (
    <section className="card" aria-label="VRAM" data-testid="vram">
      <div className="row between">
        <div><h2 style={{ margin: 0 }}>VRAM</h2><p className="muted small" style={{ margin: 0 }}>What each Argos has loaded and whether the models your jobs use fit together.</p></div>
        <button type="button" className="btn small" onClick={() => void load()}>Refresh</button>
      </div>
      <ErrorBox error={error} />
      {!provs ? <Loading /> : provs.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Add an Argos provider above to see its VRAM.</p> : provs.map((p) => <Provider key={p.id + p.config.group.length} p={p} />)}
    </section>
  );
}
