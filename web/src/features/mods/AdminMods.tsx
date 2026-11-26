// Admin → Mods: the server rules (mods/ files with scope "server"), each a whole feature such as a content source or
// an admin page, with a switch. Turning one on or off here changes it for every world; worlds never see these in
// their House rules. See docs/MODS.md, "Server rules".
import { useAuth } from '../../lib/auth.tsx';
import { setServerModsOn } from '../../lib/servermods.ts';
import { useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Loading, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';

interface ServerRule {
  id: string; name: string; version: string; author: string; summary: string; feature: string; enabled: boolean; onByDefault: boolean;
  group: string | null; requires: { mods: Record<string, string> }; conflicts: string[]; updatedAt: string | null;
}

export default function AdminMods() {
  const { client } = useAuth();
  const list = useLoad(() => client.request<{ mods: ServerRule[] }>('GET', '/api/admin/mods'), []);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const mods = list.data?.mods ?? [];
  const name = (id: string) => mods.find((m) => m.id === id)?.name ?? id;

  const flip = (m: ServerRule, on: boolean) => act.run(async () => {
    const r = await client.request<{ turnedOn: string[]; turnedOff: string[]; mods: ServerRule[] }>('PUT', `/api/admin/mods/${encodeURIComponent(m.id)}/enabled`, { on });
    setServerModsOn(r.mods.filter((x) => x.enabled).map((x) => x.id));
    const also = [...r.turnedOn.map((id) => `turned on ${name(id)}`), ...r.turnedOff.map((id) => `turned off ${name(id)}`)];
    toast(`${m.name} is ${on ? 'on' : 'off'}${also.length ? `; also ${also.join(', ')}` : ''}.`);
    await list.reload();
  });

  return (
    <div className="page" data-testid="admin-mods">
      <PageHead title="Mods" lead="Server rules turn a whole feature on or off for this server, such as a content source or an admin page. They come from the mods/ folder; a world's own house rules are under each world's settings." />
      <ErrorBox error={list.error ?? act.error} />
      {list.loading && !list.data ? <Loading /> : !mods.length ? (
        <Empty>No server rules are installed. Put a mod file with <span className="mono">"scope": "server"</span> in the mods/ folder and restart.</Empty>
      ) : (
        <div className="stack">
          {mods.map((m) => (
            <div className="card" key={m.id} data-testid={`servermod-${m.id}`}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <h3 style={{ margin: 0 }}>{m.name} <span className="tiny faint mono">{m.id} {m.version}</span></h3>
                  {m.summary && <p className="small muted" style={{ margin: '4px 0 0' }}>{m.summary}</p>}
                  <p className="tiny faint" style={{ margin: '4px 0 0' }}>
                    {m.author ? `By ${m.author}. ` : ''}
                    {Object.keys(m.requires?.mods ?? {}).length ? `Needs ${Object.keys(m.requires.mods).map(name).join(', ')}. ` : ''}
                    {m.conflicts?.length ? `Can't be on with ${m.conflicts.map(name).join(', ')}. ` : ''}
                    {m.updatedAt ? `Changed ${when(m.updatedAt)}.` : m.onByDefault ? 'On by default.' : 'Off by default.'}
                  </p>
                </div>
                <Switch checked={m.enabled} label={`${m.name} on`} onChange={(v) => { if (!act.busy) void flip(m, v); }} />
              </div>
            </div>
          ))}
        </div>
      )}
      {toastNode}
    </div>
  );
}
