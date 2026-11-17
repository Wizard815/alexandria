// A connection's live status, shared by the Connections page and the Overview: a health pill, calls an hour as bars,
// the last success and error, and where it stands against its rate limit. Errors here are already cleaned by the server.
import { Pill } from '../../pages/admin/kit.tsx';
import { ago, clock, usePolled, type ConnStatus, type Health } from './api.ts';
import './gwstatus.css';

const HEALTH: Record<Health, ['ok' | 'warn' | 'bad' | '', string]> = {
  ok: ['ok', 'Healthy'], slow: ['warn', 'Slow'], failing: ['bad', 'Failing'], throttled: ['warn', 'Rate limited'], idle: ['', 'No calls yet'],
};

export function HealthPill({ health }: { health: Health }) {
  const [tone, label] = HEALTH[health];
  return <Pill tone={tone}>{label}</Pill>;
}

/** Calls an hour for the last 24 hours. The part of a bar that failed is drawn in the error colour. */
export function Bars({ series }: { series: ConnStatus['series'] }) {
  const max = Math.max(1, ...series.map((s) => s.calls));
  const total = series.reduce((n, s) => n + s.calls, 0);
  return (
    <svg className="gws-bars" viewBox={`0 0 ${series.length * 6} 30`} preserveAspectRatio="none" role="img" aria-label={`Calls an hour over the last 24 hours: ${total} in all`}>
      {series.map((s, i) => {
        const h = s.calls ? Math.max(2, (s.calls / max) * 28) : 1;
        const bad = s.calls ? (s.errors / s.calls) * h : 0;
        return (
          <g key={s.hour}>
            <rect x={i * 6 + 0.5} y={30 - h} width={4.5} height={h} rx={1} className={s.calls ? 'gws-bar' : 'gws-bar none'} />
            {bad > 0 && <rect x={i * 6 + 0.5} y={30 - bad} width={4.5} height={bad} rx={1} className="gws-bar bad" />}
            <title>{`${s.hour.slice(11)}:00 UTC · ${s.calls} calls${s.errors ? `, ${s.errors} failed` : ''}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

function rateLine(s: ConnStatus): string {
  const r = s.rate;
  const cap = r.perMinuteInEffect > 0 ? `${r.usedLastMinute} of ${r.perMinuteInEffect} calls this minute` : `${r.usedLastMinute} calls this minute (no limit set)`;
  const lower = r.perMinuteInEffect > 0 && r.perMinuteInEffect < r.perMinute ? ` · held to ${r.perMinuteInEffect} a minute ${r.siteLimit ? `because the site allows ${r.siteLimit}` : 'after the site asked for fewer'}` : '';
  return `${cap}${r.perSecond ? ` · at most ${r.perSecond} a second` : ''}${lower}`;
}

export function StatusFacts({ s }: { s: ConnStatus }) {
  const r = s.rate;
  return (
    <dl className="adm-kv gws-facts">
      <dt>Calls</dt><dd>{s.callsToday.toLocaleString()} today · {s.callsLastHour.toLocaleString()} in the last hour{s.errorsToday ? <span className="gws-bad"> · {s.errorsToday} failed today</span> : null}{s.avgMs !== null ? <span className="muted"> · {s.avgMs} ms average</span> : null}</dd>
      <dt>Last success</dt><dd>{s.lastSuccessAt ? ago(s.lastSuccessAt) : <span className="muted">never</span>}</dd>
      <dt>Last error</dt><dd>{s.lastError ? <><span className="gws-bad">{s.lastError.message}</span> <span className="muted">· {ago(s.lastError.at)}</span></> : <span className="muted">none</span>}</dd>
      <dt>Rate limit</dt>
      <dd>
        {rateLine(s)}
        {r.waiting ? <div className="gws-wait">Waiting until {clock(r.waiting.until)} ({r.waiting.reason === 'asked' ? 'the site asked us to slow down' : r.waiting.reason === 'pace' ? 'spreading a scan out' : 'our own limit'}).</div> : null}
        <div className="tiny muted">
          {r.lastRetryAfterSec !== null ? `Last Retry-After: ${r.lastRetryAfterSec} s. ` : ''}
          {r.remaining !== null ? `The site says ${r.remaining}${r.siteLimit ? ` of ${r.siteLimit}` : ''} calls remain. ` : ''}
          {r.lastRetryAfterSec === null && r.remaining === null ? 'The site has not reported its own limits.' : ''}
        </div>
      </dd>
    </dl>
  );
}

/** The whole block for one connection. */
export function StatusBlock({ s }: { s: ConnStatus }) {
  return (
    <div className="gws-block">
      <div className="gws-chart"><Bars series={s.series} /><span className="tiny faint">last 24 hours, UTC</span></div>
      <StatusFacts s={s} />
    </div>
  );
}

/** Statuses by connection id (`con:<id>`), refreshed while the page is open. */
export function useConnStatuses() {
  const q = usePolled<{ at: string; connections: ConnStatus[] }>('/connections', 8000);
  const list = q.data?.connections ?? [];
  return { ...q, list, byConnection: new Map(list.filter((c) => c.connectionId).map((c) => [c.connectionId as string, c])) };
}
