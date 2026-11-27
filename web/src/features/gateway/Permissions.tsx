// Gateway admin → Permissions & leak guard: the four secrecy levels, how a player can come to see more, the
// real page counts per level, and what the guards stopped in the last 7 days (kind and time only, never the text).
// The leak check runs here on demand and every night; the leak crawler (npm test, docs/SECURITY.md) is the build-time twin.
import { useEffect } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { Callout, Pill, Section, Tile, type Tone } from '../../pages/admin/kit.tsx';

interface Guard { levels: Record<'party' | 'broker' | 'dm' | 'classified', number>; blanketKeys: number; perUserKeys: number; events: { id: number; at: string; world: string | null; kind: string; what: string }[] }

const LEVEL_ROWS: { id: keyof Guard['levels']; label: string; players: [string, Tone]; broker: [string, Tone]; dm: [string, Tone]; ai: [string, Tone] }[] = [
  { id: 'party', label: 'Party', players: ['Yes', 'ok'], broker: ['Yes', 'ok'], dm: ['Yes', 'ok'], ai: ['Yes', 'ok'] },
  { id: 'broker', label: 'Broker', players: ['Only once the GM approves a deal', 'warn'], broker: ['Yes', 'ok'], dm: ['Yes', 'ok'], ai: ['Yes', 'ok'] },
  { id: 'dm', label: 'GM', players: ['Never', 'bad'], broker: ['Never', 'bad'], dm: ['Yes', 'ok'], ai: ['GM agent only', 'warn'] },
  { id: 'classified', label: 'Classified', players: ['Never', 'bad'], broker: ['Never', 'bad'], dm: ['Yes', 'ok'], ai: ['Never: refused before sending', 'bad'] },
];

export default function Permissions() {
  const { client } = useAuth();
  const g = useLoad(() => client.request<Guard>('GET', '/api/admin/gateway/guard'), []);
  const d = g.data;
  return (
    <div className="page">
      <PageHead title="Permissions & leak guard" lead="Who may see what, how that can change, and the checks that make sure nothing hidden slips out. When in doubt, it stays hidden." />
      <ErrorBox error={g.error} />
      {g.loading && !d ? <Loading /> : d && (
        <>
          <div className="tiles">
            <Tile label="Stopped, last 7 days" value={d.events.length} tone={d.events.length ? 'warn' : 'ok'} sub={d.events.length ? 'by the guards below' : 'nothing had to be stopped'} />
            <Tile label="Per-user keys" value={d.perUserKeys} sub="each sees their own view" />
            <Tile label="Blanket or unsure keys" value={d.blanketKeys} tone={d.blanketKeys ? 'warn' : ''} sub="can only feed a GM question" />
          </div>
          <Section title="Secrecy levels" lead="Every page and block has one. Lower levels can never see higher ones.">
            <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
              <thead><tr><th>Level</th><th className="num">Pages now</th><th>Players</th><th>Broker answers</th><th>GM</th><th>Any AI model</th></tr></thead>
              <tbody>{LEVEL_ROWS.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.label}</strong></td><td className="num">{d.levels[r.id].toLocaleString()}</td>
                  {[r.players, r.broker, r.dm, r.ai].map(([t, tone], i) => <td key={i}><Pill tone={tone}>{t}</Pill></td>)}
                </tr>
              ))}</tbody>
            </table></div></div>
          </Section>
          <Section title="How a player can see more">
            <dl className="adm-kv">
              <dt>Source audience</dt><dd>A “GM only” source never reaches players; “Players only” stays out of GM-only tools.</dd>
              <dt>Their own per-user key</dt><dd>Unlocks only what the service already lets them see, only for them. It never lifts a GM-only source or secret blocks.</dd>
              <dt>A share</dt><dd>Carries the sharer's player view only. It ends when unshared or when the sharer loses sight of the page.</dd>
              <dt>A broker deal</dt><dd>Delivered only after the GM approves it.</dd>
              <dt>Index-only pages</dt><dd>Pages with unknown visibility are always GM only until their full text is read.</dd>
            </dl>
          </Section>
          <Section title="Stopped by the guard" lead="The last 7 days. Only the kind and the time are kept here, never the text that was stopped.">
            {d.events.length ? (
              <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                <thead><tr><th>When</th><th>World</th><th>What happened</th></tr></thead>
                <tbody>{d.events.map((e) => <tr key={e.id}><td className="small">{when(e.at)}</td><td>{e.world ?? <span className="faint">any</span>}</td><td>{e.what}</td></tr>)}</tbody>
              </table></div></div>
            ) : <p className="muted">Nothing has been stopped in the last 7 days.</p>}
          </Section>
          <LeakCheck />
        </>
      )}
    </div>
  );
}

interface Finding { world: string; worldName: string; viewer: string; surface: string; pageId: string | null; kind: string }
interface Run { id: number; startedAt: string; finishedAt: string | null; trigger: string; status: string; worlds: number; viewers: number; pages: number; reads: number; leaks: number; error: string | null; findings?: Finding[] }
const SURFACE: Record<string, string> = { list: 'page list', page: 'page, offline copy or MCP read', search: 'page search', 'global-search': 'search everything' };

/** Reads every world's library as each player and guest, and checks no GM-only 8-word run shows up. Runs are kept; leaked text never is. */
function LeakCheck() {
  const { client } = useAuth();
  const lc = useLoad(() => client.request<{ running: boolean; runs: Run[] }>('GET', '/api/admin/gateway/leak-check'), []);
  const go = useAction();
  const running = lc.data?.running;
  // While a run is going, look again every couple of seconds.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void lc.reload(), 2000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  const runs = lc.data?.runs ?? [];
  const last = runs.find((r) => r.status !== 'running');
  const start = () => void go.run(async () => { await client.request('POST', '/api/admin/gateway/leak-check/run', {}); await lc.reload(); });
  return (
    <Section title="Leak check" lead="Reads each world as every player and guest (and as a guest with no account) and checks that no run of 8 words of GM-only text, broker or classified text shows up in the page list, any page, search, the offline copy or the MCP read tools. It runs every night."
      actions={<button type="button" className="btn primary small" onClick={start} disabled={go.busy || !!running}>{running ? 'Checking…' : 'Run now'}</button>}>
      <ErrorBox error={go.error || lc.error} />
      {last && last.leaks > 0 && (
        <Callout tone="bad">
          <strong>{last.leaks} leak{last.leaks === 1 ? '' : 's'} found in the last run.</strong> Only where is shown, never the words.
          <ul className="adm-feed">{(last.findings ?? []).slice(0, 20).map((f, i) => <li key={i}><span>{f.worldName} · {f.viewer === 'guest-without-account' ? 'a guest with no account' : 'a player or guest'} · {SURFACE[f.surface] ?? f.surface}{f.pageId ? <span className="mono tiny"> · page {f.pageId}</span> : null}</span></li>)}</ul>
        </Callout>
      )}
      {lc.loading && !lc.data ? <Loading /> : runs.length ? (
        <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
          <thead><tr><th>When</th><th>By</th><th className="num">Viewers</th><th className="num">Pages checked</th><th className="num">Leaks</th><th>Result</th></tr></thead>
          <tbody>{runs.map((r) => (
            <tr key={r.id}>
              <td className="small">{when(r.startedAt)}</td><td>{r.trigger === 'nightly' ? 'Nightly' : 'Run now'}</td>
              <td className="num">{r.viewers}</td><td className="num">{r.pages.toLocaleString()}</td><td className="num">{r.leaks}</td>
              <td>{r.status === 'running' ? <Pill tone="teal">Running</Pill> : r.status === 'error' ? <Pill tone="warn">Did not finish</Pill> : r.leaks ? <Pill tone="bad">Leak found</Pill> : <Pill tone="ok">Clean</Pill>}{r.error && <span className="tiny">{r.error}</span>}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      ) : <p className="muted">It has not run yet. Run it now, or it runs tonight.</p>}
      <p className="tiny faint">Pages a player's own key or a share opens are judged by the copy they are meant to see. The build-time leak crawler (npm test, docs/SECURITY.md) checks more routes and live streams.</p>
    </Section>
  );
}
