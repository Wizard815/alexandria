// Gateway admin → Integrations: the devices each world's table uses through this gateway (lights, microphones,
// macros and their trigger URLs). Counts and names only; the settings live in the world.
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { Pill, Section } from '../../pages/admin/kit.tsx';

interface Dev { id: string; name: string; lights: { kind: string; name: string; enabled: boolean }[]; macros: number; triggers: number; mics: { label: string; mode: string }[]; speakers: { label: string; seenAt: string; connected: boolean }[] }

export default function Integrations() {
  const { client } = useAuth();
  const dev = useLoad(() => client.request<{ worlds: Dev[]; desktopApps: number | null }>('GET', '/api/admin/gateway/devices'), []);
  const worlds = dev.data?.worlds ?? [];
  return (
    <div className="page">
      <PageHead title="Integrations" lead="Lights, microphones and macros are hosted here, so any app at the table can use them. Each world sets its own up from its DM pages." />
      <ErrorBox error={dev.error} />
      {dev.loading && !dev.data ? <Loading /> : (
        <Section title="Devices per world">
          {worlds.length ? (
            <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
              <thead><tr><th>World</th><th>Lights</th><th>Microphones</th><th>Speakers</th><th>Macros</th></tr></thead>
              <tbody>{worlds.map((w) => (
                <tr key={w.id}>
                  <td><Link to={`/admin/worlds/${w.id}`}>{w.name}</Link></td>
                  <td>{w.lights.length ? w.lights.map((l) => <span key={l.name} className="tiny" style={{ display: 'block' }}>{l.name} <span className="muted">· {l.kind}</span> {!l.enabled && <Pill>off</Pill>}</span>) : <span className="faint">none</span>}</td>
                  <td>{w.mics.length ? w.mics.map((m) => <span key={m.label} className="tiny" style={{ display: 'block' }}>{m.label} <span className="muted">· {m.mode}</span></span>) : <span className="faint">none</span>}</td>
                  <td>{w.speakers.length ? w.speakers.map((sp, i) => <span key={i} className="tiny" style={{ display: 'block' }}>{sp.label} <Pill tone={sp.connected ? 'ok' : ''}>{sp.connected ? 'connected' : `seen ${when(sp.seenAt)}`}</Pill></span>) : <span className="faint">none</span>}</td>
                  <td>{w.macros ? `${w.macros} macro${w.macros === 1 ? '' : 's'} · ${w.triggers} trigger URL${w.triggers === 1 ? '' : 's'}` : <span className="faint">none</span>}</td>
                </tr>
              ))}</tbody>
            </table></div></div>
          ) : <Empty>No worlds yet.</Empty>}
        </Section>
      )}
      {dev.data && (
        <Section title="DM desktop apps" lead="Apps on a DM's computer that talk to this gateway.">
          <p className="muted small">{dev.data.desktopApps === null ? 'Nothing registers a desktop app with the gateway yet, so there is no list to show. Speakers above are the browsers and apps that joined a world’s sound board.' : `${dev.data.desktopApps} connected`}</p>
        </Section>
      )}
    </div>
  );
}
