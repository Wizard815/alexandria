// Gateway admin → Permissions & leak guard: the four secrecy levels, how a player can come to see more, the
// real page counts per level, and what the guards stopped in the last 7 days (kind and time only, never the text).
// The leak crawler itself is a test (npm test, docs/SECURITY.md); it is not run from here.
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { Pill, Section, Tile, type Tone } from '../../pages/admin/kit.tsx';

interface Guard { levels: Record<'party' | 'broker' | 'dm' | 'classified', number>; blanketKeys: number; perUserKeys: number; events: { id: number; at: string; world: string | null; kind: string; what: string }[] }

const LEVEL_ROWS: { id: keyof Guard['levels']; label: string; players: [string, Tone]; broker: [string, Tone]; dm: [string, Tone]; ai: [string, Tone] }[] = [
  { id: 'party', label: 'Party', players: ['Yes', 'ok'], broker: ['Yes', 'ok'], dm: ['Yes', 'ok'], ai: ['Yes', 'ok'] },
  { id: 'broker', label: 'Broker', players: ['Only once the DM approves a deal', 'warn'], broker: ['Yes', 'ok'], dm: ['Yes', 'ok'], ai: ['Yes', 'ok'] },
  { id: 'dm', label: 'DM', players: ['Never', 'bad'], broker: ['Never', 'bad'], dm: ['Yes', 'ok'], ai: ['DM agent only', 'warn'] },
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
            <Tile label="Blanket or unsure keys" value={d.blanketKeys} tone={d.blanketKeys ? 'warn' : ''} sub="can only feed a DM question" />
          </div>
          <Section title="Secrecy levels" lead="Every page and block has one. Lower levels can never see higher ones.">
            <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
              <thead><tr><th>Level</th><th className="num">Pages now</th><th>Players</th><th>Broker answers</th><th>DM</th><th>Any AI model</th></tr></thead>
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
              <dt>Source audience</dt><dd>A “DM only” source never reaches players; “Players only” stays out of DM-only tools.</dd>
              <dt>Their own per-user key</dt><dd>Unlocks only what the service already lets them see, only for them. It never lifts a DM-only source or secret blocks.</dd>
              <dt>A share</dt><dd>Carries the sharer's player view only. It ends when unshared or when the sharer loses sight of the page.</dd>
              <dt>A broker deal</dt><dd>Delivered only after the DM approves it.</dd>
              <dt>Index-only pages</dt><dd>Pages with unknown visibility are always DM only until their full text is read.</dd>
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
          <Section title="Leak crawler">
            <p className="small muted">The leak crawler reads every route, live stream, offline copy and AI tool as each kind of viewer and fails the build when a marker reaches someone who may not see it. It runs with the tests (<span className="mono">npm test</span>), not from this page. See docs/SECURITY.md.</p>
          </Section>
        </>
      )}
    </div>
  );
}
