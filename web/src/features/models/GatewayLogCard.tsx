// The /v1 model gateway call log (Admin > Models > Gateway calls): who called, when, which model, the tokens, the status, and
// whether the gate refused or limited the call; and per account, today's totals against its caps. The server never logs a prompt
// or an answer, so none can be shown here. Lists, not wide tables, so it reads at phone width.
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox } from '../../ui/index.tsx';

interface Call { id: number; at: string; job: string; model: string | null; path: string | null; accountId: string | null; username: string | null; status: number | null; ms: number | null; tokensIn: number | null; tokensOut: number | null; outcome: 'passed' | 'refused' | 'limited' }
interface UserToday { accountId: string; username: string | null; role: string; allowed: boolean; requests: number; tokens: number; refused: number; limited: number; errors: number; lastAt: string | null; caps: { dailyRequests: number; dailyTokens: number; ratePerMinute: number } }
interface Log { since: string; calls: Call[]; users: UserToday[] }

const n = (v: number) => v.toLocaleString();
const when = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
const cap = (used: number, max: number) => (max > 0 ? `${n(used)} / ${n(max)}` : `${n(used)} (no cap)`);
const pct = (used: number, max: number) => (max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0);

function Meter({ used, max, label }: { used: number; max: number; label: string }) {
  const p = pct(used, max);
  return (
    <div className="stack tight" style={{ minWidth: 0, flex: '1 1 140px' }}>
      <span className="tiny muted">{label}: <strong>{cap(used, max)}</strong></span>
      {max > 0 && (
        <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} style={{ height: 6, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}>
          <div style={{ width: `${p}%`, height: '100%', background: p >= 100 ? 'var(--danger)' : p >= 80 ? 'var(--accent-strong)' : 'var(--accent)' }} />
        </div>
      )}
    </div>
  );
}

function Outcome({ c }: { c: Call }) {
  if (c.outcome === 'refused') return <span className="chip red" data-outcome="refused">refused</span>;
  if (c.outcome === 'limited') return <span className="chip gold" data-outcome="limited">limited</span>;
  const bad = c.status === null || c.status === 0 || c.status >= 400;
  return <span className={`chip ${bad ? 'red' : 'green'}`} data-outcome="passed">{c.status === 0 ? 'no answer' : c.status ?? '?'}</span>;
}

export default function GatewayLogCard() {
  const { client } = useAuth();
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'stopped'>('all');
  useEffect(() => {
    let alive = true;
    const tick = () => client.request<Log>('GET', '/api/admin/models/activity/gateway?limit=100')
      .then((r) => { if (alive) { setLog(r); setError(null); } })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    void tick();
    const t = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [client]);
  const calls = (log?.calls ?? []).filter((c) => only === 'all' || c.outcome !== 'passed');

  return (
    <div className="stack" data-testid="gateway-log">
      <p className="muted small" style={{ margin: 0 }}>
        Calls to this server's <code>/v1</code> model gateway (chat, embeddings, the model list) from people and apps. Who, when, which model, the tokens and the answer; never what was asked: prompts are not logged. Refused: the caller is not allowed. Limited: a rate or daily cap stopped it (those do not count against the cap). Updates every 10 seconds.
      </p>
      <ErrorBox error={error} />
      <section className="card" aria-label="Today per account" data-testid="gateway-today">
        <div className="card-head"><strong>Today per account</strong><span className="tiny muted">since 00:00 UTC</span></div>
        {!log ? <p className="muted small">Loading…</p> : !log.users.length ? <p className="muted small">Nobody has called the gateway today, and no account is listed.</p> : (
          <div className="list">
            {log.users.map((u) => (
              <div key={u.accountId} className="list-item" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }} data-user={u.username ?? u.accountId}>
                <div className="stack tight" style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <div className="row" style={{ flexWrap: 'wrap' }}><strong style={{ overflowWrap: 'anywhere' }}>{u.username ?? u.accountId}</strong><span className="chip">{u.role}</span></div>
                  <span className="tiny muted">
                    {u.lastAt ? `last ${when(u.lastAt)}` : 'no calls today'}
                    {u.refused > 0 && ` · ${u.refused} refused`}{u.limited > 0 && ` · ${u.limited} limited`}{u.errors > 0 && ` · ${u.errors} failed`}
                    {` · ${u.caps.ratePerMinute > 0 ? `${u.caps.ratePerMinute} a minute` : 'no rate limit'}`}
                  </span>
                </div>
                <Meter used={u.requests} max={u.caps.dailyRequests} label="Requests" />
                <Meter used={u.tokens} max={u.caps.dailyTokens} label="Tokens" />
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="card" aria-label="Recent gateway calls" data-testid="gateway-calls">
        <div className="card-head">
          <strong>Recent calls</strong>
          <label className="row small"><input type="checkbox" checked={only === 'stopped'} onChange={(e) => setOnly(e.target.checked ? 'stopped' : 'all')} /> Only refused and limited</label>
        </div>
        {!log ? <p className="muted small">Loading…</p> : !calls.length ? <p className="muted small">{only === 'all' ? 'No calls to the gateway yet.' : 'Nothing refused or limited.'}</p> : (
          <div className="list">
            {calls.map((c) => (
              <div key={c.id} className="list-item" style={{ flexWrap: 'wrap', gap: 6 }} data-call={c.outcome}>
                <Outcome c={c} />
                <strong style={{ overflowWrap: 'anywhere' }}>{c.username ?? (c.accountId ? c.accountId : 'unknown')}</strong>
                <span className="small" style={{ overflowWrap: 'anywhere' }}>{c.path ?? ''}{c.model ? ` · ${c.model}` : ` · ${c.job}`}</span>
                <span className="tiny muted" style={{ marginLeft: 'auto' }}>
                  {when(c.at)}
                  {(c.tokensIn !== null || c.tokensOut !== null) && ` · ${n(c.tokensIn ?? 0)} in / ${n(c.tokensOut ?? 0)} out`}
                  {c.ms !== null && ` · ${n(c.ms)} ms`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
