// Connect an AI app (Claude, Cursor, Claude Code...) to the librarian's MCP
// endpoint. Players get read-only keys. The DM can also make a write key.
// In Library admin (no world), admins make admin keys for the admin API.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { ErrorBox, Field, PageHead, useAction } from '../../ui/index.tsx';
import { McpCard, type McpConnection } from './McpCard.tsx';

export default function ConnectAI() {
  const { world } = useParams();
  const { client, me } = useAuth();
  const w = world ? me?.worlds.find((x) => x.slug === world || x.id === world) : null;
  const keys = useLoad(() => client.keys(), []);
  const [label, setLabel] = useState('');
  const [made, setMade] = useState<McpConnection | null>(null);
  const [adminKey, setAdminKey] = useState<string | null>(null);
  const a = useAction();
  const isDM = w?.role === 'dm';

  const make = (access: 'read' | 'write') => void a.run(async () => {
    if (!w) {
      const r = await client.createKey('admin', label || 'Admin key');
      setAdminKey(r.key);
    } else {
      const r = (await client.request('POST', '/api/keys', { scope: 'scribe', label: label || (access === 'write' ? 'DM AI (write)' : 'AI (read-only)'), worldId: w.id, access })) as any;
      setMade(r.mcp);
    }
    setLabel('');
    await keys.reload();
  });
  const revoke = (id: string) => {
    if (!confirm('Revoke this key? Apps using it stop working at once.')) return;
    void a.run(async () => { await client.revokeKey(id); await keys.reload(); });
  };
  const mine = (keys.data ?? []).filter((k: any) => (w ? k.world_id === w.id : k.scope === 'admin'));

  return (
    <div className={w ? 'page' : 'stack loose'}>
      <PageHead
        title={w ? 'Connect an AI' : 'Keys & AI'}
        lead={w
          ? isDM
            ? 'Give an AI app access to this world through MCP. A read key only looks things up. A write key can also change things as the DM: save pages, add people, schedule sessions, send quick events.'
            : 'Give an AI app access to this world through MCP. Your key is read-only: it sees only what you can see and cannot change anything. One was made for you when you joined; make another for each app.'
          : 'Admin keys work with the admin API (accounts, worlds, sources). For a world’s AI connection, open the world and use “Connect an AI”.'}
      />
      <div className="card">
        <Field label="Name this key" help="So you can tell your apps apart, e.g. “Claude on my laptop”."><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <div className="row">
          {w ? (
            <>
              <button type="button" className="btn primary" disabled={a.busy} onClick={() => make('read')}>Make a read-only key</button>
              {isDM && <button type="button" className="btn danger" disabled={a.busy} onClick={() => make('write')}>Make a DM write key</button>}
            </>
          ) : (
            <button type="button" className="btn primary" disabled={a.busy} onClick={() => make('write')}>Make an admin key</button>
          )}
        </div>
        <ErrorBox error={a.error} />
      </div>
      {made && <McpCard mcp={made} />}
      {adminKey && <div className="card gold"><h2>New admin key</h2><p className="small muted">Shown once. Send it as <span className="mono">Authorization: Bearer …</span>.</p><p className="mono" style={{ wordBreak: 'break-all' }}>{adminKey}</p></div>}
      <div className="card flush scroll-x">
        <table className="table">
          <thead><tr><th>Key</th><th>Access</th><th>Made</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {mine.map((k: any) => (
              <tr key={k.id} style={k.revoked ? { opacity: 0.5 } : undefined}>
                <td>{k.label}<br /><span className="mono tiny muted">{k.prefix}…</span></td>
                <td><span className={`chip ${k.access === 'write' ? 'red' : 'teal'}`}>{k.access === 'write' ? 'Write' : 'Read-only'}</span></td>
                <td className="small">{when(k.created_at)}</td>
                <td className="small">{when(k.last_used_at) || 'never'}</td>
                <td>{k.revoked ? <span className="small faint">revoked</span> : <button type="button" className="btn small danger" onClick={() => revoke(k.id)}>Revoke</button>}</td>
              </tr>
            ))}
            {!mine.length && <tr><td colSpan={5} className="muted">No keys yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
