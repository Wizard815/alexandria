// Gateway admin → Overview: the worlds, what is being read from where, who is waiting on a DM, what the
// guards stopped, the model jobs and the devices. Every number comes from the admin API; a part with
// nothing to show says so.
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { tierLine, type TierInfo } from '../../features/connections/Tiers.tsx';
import { Callout, Pill, Section, Tile } from './kit.tsx';

const RUN: Record<string, 'ok' | 'bad' | 'teal' | ''> = { ok: 'ok', error: 'bad', stopped: '', running: 'teal' };
const MODEL_NAMES: Record<string, string> = { chat: 'Chat (DM and players)', audit: 'Audit (decisions)', audio: 'Audio (speech to text)', voice: 'Voice (text to speech)', extra: 'Extra (embeddings)', rerank: 'Rerank' };
const SEEN: Record<string, [string, 'ok' | 'warn' | 'bad' | '']> = { loaded: ['Warm', 'ok'], unloaded: ['Not loaded', 'warn'], unknown: ['Status unknown', ''], missing: ['Model not found', 'bad'], unreachable: ['Not reachable', 'bad'] };

interface Gw {
  waiting: { questions: number; brokerDeals: number }; roles: Record<string, number>;
  guard: { blocked7d: number; last: string | null }; devices: { lights: number; macros: number; triggers: number; mics: number; speakers: number; speakersConnected: number };
  security: { defaultAdminPassword: boolean }; leak: { at: string | null; leaks: number; status: string; pages: number; viewers: number; error: string | null } | null;
  activity: { id: number; at: string; world: string | null; what: string }[];
}

export default function AdminOverview() {
  const { client } = useAuth();
  const get = <T,>(path: string) => client.request<T>('GET', `/api/admin${path}`);
  const o = useLoad(() => get<any>('/overview'), []);
  const gw = useLoad(() => get<Gw>('/gateway/overview'), []);
  const worlds = useLoad(() => get<any[]>('/worlds'), []);
  const conns = useLoad(() => get<any[]>('/connections'), []);
  const models = useLoad(() => get<{ jobs: any[] }>('/models'), []);
  const status = useLoad(() => get<{ jobs: Record<string, { primary?: string }> }>('/models/status'), []);
  const backup = useAction();
  const d = o.data;

  const download = () => void backup.run(async () => {
    const r = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${client.token}` } });
    if (!r.ok) throw new Error(`Backup failed (${r.status})`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `alexandria-${new Date().toISOString().slice(0, 10)}.db`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  const g = gw.data;
  const waiting = g ? g.waiting.questions + g.waiting.brokerDeals : null;
  const people = g ? (g.roles.dm ?? 0) + (g.roles.player ?? 0) + (g.roles.guest ?? 0) : null;

  return (
    <div className="page">
      <PageHead title="Overview" lead="The gateway: its worlds, connections, models and devices, and who is waiting on a DM. Being an admin does not open a world's secrets; you need to be its DM.">
        <button type="button" className="btn" onClick={download} disabled={backup.busy}>{backup.busy && !backup.offline ? 'Preparing…' : 'Download backup'}</button>
      </PageHead>
      <ErrorBox error={o.error || backup.error || gw.error} />
      {g?.leak && g.leak.leaks > 0 && (
        <Callout tone="bad">
          <strong>The leak check found {g.leak.leaks} place{g.leak.leaks === 1 ? '' : 's'} where hidden text reached a player view.</strong> {when(g.leak.at)}. <Link to="/admin/permissions">See where</Link>. Nothing is shown here but the pages and kinds of read involved.
        </Callout>
      )}
      {g?.leak?.status === 'error' && <Callout tone="warn">The last leak check did not finish{g.leak.error ? `: ${g.leak.error}` : ''}. <Link to="/admin/permissions">Run it again</Link>.</Callout>}
      {g?.security.defaultAdminPassword && (
        <Callout tone="bad">
          <strong>An admin account still uses a default or easy-to-guess password.</strong> Change it now: anyone who guesses it can reach every world's settings and keys. <Link to="/admin/accounts">Accounts</Link>
        </Callout>
      )}
      {o.loading && !d ? <Loading /> : d && (
        <>
          <div className="tiles">
            <Tile label="Worlds" value={d.worlds} sub={`${conns.data?.length ?? 0} connections · ${d.sources.length} sources`} />
            <Tile label="Connected now" value={d.liveConnections} sub={g ? `${d.accounts} accounts · ${g.roles.dm ?? 0} DM, ${g.roles.player ?? 0} players, ${g.roles.guest ?? 0} guests in worlds` : `${d.accounts} accounts`} />
            <Tile label="Waiting on the DM" value={waiting ?? '…'} tone={waiting ? 'warn' : ''} sub={g ? `${g.waiting.questions} question${g.waiting.questions === 1 ? '' : 's'} · ${g.waiting.brokerDeals} broker deal${g.waiting.brokerDeals === 1 ? '' : 's'}` : undefined} />
            <Tile label="Guard, last 7 days" value={g ? g.guard.blocked7d : '…'} tone={g?.guard.blocked7d ? 'warn' : 'ok'} sub={g ? (g.guard.blocked7d ? `stopped; latest ${when(g.guard.last)}` : 'nothing had to be stopped') : undefined} />
            <Tile label="Library pages" value={d.pages.toLocaleString()} sub={people !== null ? `${people} people with a seat` : undefined} />
          </div>

          <Crawls worlds={worlds.data ?? []} />

          <Section title="Model jobs" lead="Nothing classified is ever sent to a model." actions={<Link className="btn small" to="/admin/models">Models</Link>}>
            {models.data ? (
              <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                <thead><tr><th>Job</th><th>Model</th><th>Runs on</th><th>Status</th></tr></thead>
                <tbody>{models.data.jobs.map((j) => {
                  const seen = status.data?.jobs[j.job]?.primary;
                  const [text, tone] = !j.model && j.source === 'none' ? ['Not set', ''] as const : seen ? SEEN[seen] ?? [seen, ''] as const : j.enabled ? ['Set', ''] as const : ['Off', ''] as const;
                  return (
                    <tr key={j.job}>
                      <td>{MODEL_NAMES[j.job] ?? j.job}</td>
                      <td className="mono">{j.model || <span className="faint">{j.source === 'env' ? 'from the environment' : 'none'}</span>}</td>
                      <td>{j.location === 'cloud' ? 'Cloud' : j.location === 'local' ? 'Local' : <span className="faint">unknown</span>}{j.fallback?.allowCloud ? <span className="tiny">cloud fallback allowed</span> : null}</td>
                      <td><Pill tone={tone}>{text}</Pill></td>
                    </tr>
                  );
                })}</tbody>
              </table></div></div>
            ) : <Loading />}
          </Section>

          <div className="adm-two">
            <Section title="Connections" lead="Logins to services, shared by any world that uses them." actions={<Link className="btn small" to="/admin/connections">Manage</Link>}>
              {conns.data?.length ? (
                <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                  <thead><tr><th>Connection</th><th>Template</th><th>Used by</th></tr></thead>
                  <tbody>{conns.data.map((c) => (
                    <tr key={c.id}><td><strong>{c.name}</strong></td><td>{c.connector?.label ?? c.kind}</td><td>{c.sources} source{c.sources === 1 ? '' : 's'} · {c.worlds} world{c.worlds === 1 ? '' : 's'}</td></tr>
                  ))}</tbody>
                </table></div></div>
              ) : <p className="muted">No connections yet. <Link to="/admin/connections">Make one</Link>, or <Link to="/admin/worlds/setup">set up a world</Link>.</p>}
            </Section>
            <Section title="Gateway devices" lead="Hosted here, so any world's table can use them." actions={<Link className="btn small" to="/admin/integrations">Integrations</Link>}>
              {g ? (
                <dl className="adm-kv">
                  <dt>Lights</dt><dd>{g.devices.lights ? `${g.devices.lights} configured` : <span className="muted">none set up</span>}</dd>
                  <dt>Microphones</dt><dd>{g.devices.mics ? `${g.devices.mics} registered` : <span className="muted">none registered</span>}</dd>
                  <dt>Speakers</dt><dd>{g.devices.speakers ? `${g.devices.speakers} joined · ${g.devices.speakersConnected} seen today` : <span className="muted">none yet</span>}</dd>
                  <dt>Macros</dt><dd>{g.devices.macros ? `${g.devices.macros} · ${g.devices.triggers} trigger URL${g.devices.triggers === 1 ? '' : 's'}` : <span className="muted">none</span>}</dd>
                </dl>
              ) : <Loading />}
            </Section>
            <Section title="Recent activity" lead="Library changes, syncs and guard events. Their text is not shown here.">
              {g?.activity.length ? (
                <ul className="adm-feed">{g.activity.map((a) => <li key={a.id}><time>{when(a.at)}</time><span>{a.what}{a.world ? <span className="muted"> · {a.world}</span> : null}</span></li>)}</ul>
              ) : <p className="muted">Nothing yet.</p>}
            </Section>
          </div>

          <Section title="Recent syncs" actions={<Link className="btn small" to="/admin/sources">World sources</Link>} flush>
            {d.runs.length ? (
              <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                <thead><tr><th>Source</th><th>World</th><th>Started</th><th>Status</th><th>Pages</th></tr></thead>
                <tbody>{d.runs.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.source}</td><td>{r.world}</td><td className="small">{when(r.started_at)}</td>
                    <td><Pill tone={RUN[r.status] ?? ''}>{r.status}</Pill>{r.error && <span className="tiny" style={{ color: 'var(--danger-text)' }}>{r.error}</span>}</td>
                    <td className="small">{r.stats.pages ?? 0} · {r.stats.shared ?? 0} shared · {r.stats.dmOnly ?? 0} DM-only{r.stats.removed ? ` · ${r.stats.removed} removed` : ''}</td>
                  </tr>
                ))}</tbody>
              </table></div></div>
            ) : <p className="muted">No syncs yet. <Link to="/admin/sources">Add a source</Link> to fill a world's library.</p>}
          </Section>

          <Section title="This server">
            <dl className="adm-kv">
              <dt>Public address</dt><dd className="mono">{d.system.publicUrl ?? <span className="muted">not set (ALX_PUBLIC_URL); AI settings use the address in the browser</span>}</dd>
              <dt>Data folder</dt><dd className="mono">{d.system.dataDir ?? 'none (memory only)'}</dd>
              <dt>Vault folder</dt><dd className="mono">{d.system.vaultsDir ?? <span className="muted">off (ALX_VAULTS_DIR)</span>}</dd>
              <dt>Model endpoint</dt><dd>{d.system.modelEndpoint ? 'set' : <span className="muted">not set; AI features fall back to library search</span>}</dd>
              <dt>Local MCP servers</dt><dd className="mono">{d.system.stdioMcpServers.length ? d.system.stdioMcpServers.join(', ') : <span className="muted">none (ALX_MCP_STDIO)</span>}</dd>
              <dt>Node</dt><dd className="mono">{d.system.node}</dd>
            </dl>
            <p className="tiny faint">Setup and settings are explained in docs/HOSTING.md.</p>
          </Section>
        </>
      )}
    </div>
  );
}

/** One row for every tiered source of every world: how far the index and the details have come. */
function Crawls({ worlds }: { worlds: any[] }) {
  const { client } = useAuth();
  const key = worlds.map((w) => w.id).join(',');
  const tiers = useLoad(async () => {
    const out: { world: any; t: TierInfo }[] = [];
    await Promise.all(worlds.map(async (w) => {
      for (const t of await client.request<TierInfo[]>('GET', `/api/admin/connections/tiers/world/${w.id}`)) out.push({ world: w, t });
    }));
    return out.sort((a, b) => a.world.name.localeCompare(b.world.name) || a.t.name.localeCompare(b.t.name));
  }, [key]);
  const state = (t: TierInfo): ['ok' | 'warn' | 'teal', string] => (t.paused ? ['warn', 'Paused'] : (t.waiting ?? 0) > 0 || (t.fetchAll && (t.waitingAll ?? 0) > 0) ? ['teal', 'Filling in'] : ['ok', 'Up to date']);
  const rows = (tiers.data ?? []).filter((x) => x.t.tiered);
  return (
    <Section title="Crawls" lead="Lists first, so every page exists at once; full text fills in as pages are used." actions={<Link className="btn small" to="/admin/worlds">Open worlds</Link>}>
      {tiers.loading && !tiers.data ? <Loading /> : rows.length ? (
        <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
          <thead><tr><th>World</th><th>Source</th><th>Progress</th><th>State</th></tr></thead>
          <tbody>{rows.map(({ world, t }) => {
            const [tone, text] = state(t);
            return <tr key={t.id}><td><Link to={`/admin/worlds/${world.id}`}>{world.name}</Link></td><td>{t.name}</td><td className="small">{tierLine(t)}</td><td><Pill tone={tone}>{text}</Pill></td></tr>;
          })}</tbody>
        </table></div></div>
      ) : <p className="muted">No source is read in tiers yet. A world's sources are on its page under <Link to="/admin/worlds">Worlds</Link>.</p>}
    </Section>
  );
}
