// Gateway admin → Access & MCP: Alexandria's own MCP server (address, tools, which keys reach it) and how admins sign in.
// Keys are listed by owner, world and last use only. A key is never shown again after it is made.
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { when } from '../../lib/format.ts';
import { Pill, Section, Tile } from '../../pages/admin/kit.tsx';

interface Mcp {
  url: string | null;
  tools: { name: string; description: string; write: boolean; dmOnly: boolean; playerOnly: boolean }[];
  keys: { scribe: number; write: number; admin: number; list: { id: string; owner: string; world: string | null; label: string; scope: string; access: string; createdAt: string; lastUsedAt: string | null }[] };
}

export default function Access() {
  const { client } = useAuth();
  const m = useLoad(() => client.request<Mcp>('GET', '/api/admin/gateway/mcp'), []);
  const d = m.data;
  const url = d ? d.url ?? `${window.location.origin}/mcp` : '';
  const config = JSON.stringify({ mcpServers: { alexandria: { url, headers: { Authorization: 'Bearer <scribe key>' } } } }, null, 2);
  const read = d?.tools.filter((t) => !t.write) ?? [];
  const write = d?.tools.filter((t) => t.write) ?? [];
  return (
    <div className="page">
      <PageHead title="Access & MCP" lead="Who can reach Alexandria, the keys it has handed out, and its own MCP server for AI apps." />
      <ErrorBox error={m.error} />
      {m.loading && !d ? <Loading /> : d && (
        <>
          <div className="tiles">
            <Tile label="Tools offered" value={d.tools.length} sub={`${read.length} read · ${write.length} write (GM write keys only)`} />
            <Tile label="Scribe keys" value={d.keys.scribe} sub={`${d.keys.write} can write`} />
            <Tile label="Admin keys" value={d.keys.admin} tone={d.keys.admin ? 'warn' : ''} sub="reach every admin page" />
          </div>
          <Section title="Alexandria's MCP server" lead="One address for Claude Desktop, Claude Code or any MCP app. It obeys the signed-in scribe's role: a player's key only ever reads what that player may see.">
            <dl className="adm-kv">
              <dt>Address</dt><dd className="mono">{url}</dd>
              <dt>Public address</dt><dd>{d.url ? 'set (ALX_PUBLIC_URL)' : <span className="muted">not set (ALX_PUBLIC_URL); this is the address of this browser tab</span>}</dd>
            </dl>
            <h3>Add to an app</h3>
            <pre className="adm-code" tabIndex={0}>{config}</pre>
            <p className="small muted">Use a scribe key, so the app gets that person's access and nothing more. Scribe keys are made in a world, by its players and GM.</p>
          </Section>
          <Section title="Tools it offers" lead="Every tool calls the librarian with the caller's own key, so the same visibility rules apply.">
            <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
              <thead><tr><th>Tool</th><th>What it does</th><th>Who</th></tr></thead>
              <tbody>{d.tools.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td><td className="small">{t.description}</td>
                  <td>{t.write ? <Pill tone="warn">GM write key</Pill> : t.dmOnly ? <Pill>GM</Pill> : t.playerOnly ? <Pill>Players</Pill> : <Pill tone="ok">Any key</Pill>}</td>
                </tr>
              ))}</tbody>
            </table></div></div>
          </Section>
          <Section title="Keys" lead="Metadata only. A key's value is shown once, when it is made, and never again.">
            {d.keys.list.length ? (
              <div className="adm-table-wrap"><div className="scroll-x"><table className="table">
                <thead><tr><th>Key</th><th>Owner</th><th>World</th><th>Access</th><th>Last used</th></tr></thead>
                <tbody>{d.keys.list.map((k) => (
                  <tr key={k.id}>
                    <td><strong>{k.label}</strong><span className="tiny muted">made {when(k.createdAt)}</span></td><td>{k.owner}</td><td>{k.world ?? <span className="faint">all (admin)</span>}</td>
                    <td><Pill tone={k.access === 'write' || k.access === 'admin' ? 'warn' : ''}>{k.access}</Pill></td>
                    <td className="small">{k.lastUsedAt ? when(k.lastUsedAt) : <span className="faint">never</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div></div>
            ) : <p className="muted">No keys yet.</p>}
          </Section>
          <Section title="Admin sign-in">
            <p className="small muted">Admin pages have their own sign-in, with an authenticator code and an optional allowed network. Set those, and see recovery steps, on <Link to="/admin/access?tab=security">Security</Link>. A forgotten password is reset from <Link to="/admin/accounts">Accounts</Link>.</p>
          </Section>
        </>
      )}
    </div>
  );
}
