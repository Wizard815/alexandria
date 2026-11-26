// DM → Setup → Discord: the bot token, the server, which channels get recaps
// and rolls, what players get as Discord messages, and who is linked.
import { useEffect, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';

interface Link { accountId: string; name: string; role: string | null; discordUser: string; discordName: string; linkedAt: string }
interface View {
  enabled: boolean; tokenSet: boolean; tokenEnd: string | null; guildId: string | null; recapChannel: string | null; rollChannel: string | null;
  postRecaps: boolean; postRolls: boolean; brokerDms: boolean; brokerText: boolean; helper: boolean;
  status: { connected: boolean; error: string | null; botName: string | null; applicationId: string | null; guilds: { id: string; name: string }[]; inServer: boolean } | null;
  inviteUrl: string | null;
  links: Link[];
}
interface Channel { id: string; name: string }

export default function DiscordPage() {
  const { w } = useWorld();
  const v = useLoad(() => w.call<View>('GET', '/discord'), [w]);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [token, setToken] = useState('');
  const [guild, setGuild] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [chError, setChError] = useState<string | null>(null);

  const d = v.data;
  const connected = !!d?.status?.connected;
  const inServer = !!d?.status?.inServer;
  // Once the bot is in the server, list its text channels to pick from.
  useEffect(() => {
    if (!connected || !inServer) return;
    w.call<Channel[]>('GET', '/discord/channels').then((c) => { setChannels(c); setChError(null); }).catch((e) => setChError(e.message));
  }, [w, connected, inServer, d?.guildId]);
  // The bot connects in the background: look again shortly after a change.
  useEffect(() => {
    if (!d?.tokenSet || connected || d.status?.error) return;
    const t = setTimeout(() => void v.reload(), 2000);
    return () => clearTimeout(t);
  }, [d, connected]);

  if (!d) return <Loading />;
  const save = (patch: Partial<View> & { token?: string | null }) => act.run(async () => { await w.call('PUT', '/discord', patch); await v.reload(); });
  const guildValue = guild ?? d.guildId ?? '';
  const pick = (label: string, key: 'recapChannel' | 'rollChannel', help: string) => (
    <Field label={label} help={help}>
      {channels ? (
        <select value={d[key] ?? ''} onChange={(e) => void save({ [key]: e.target.value || null })}>
          <option value="">Not posted</option>
          {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      ) : (
        <input defaultValue={d[key] ?? ''} placeholder="Channel id" onBlur={(e) => { if (e.target.value !== (d[key] ?? '')) void save({ [key]: e.target.value || null }); }} />
      )}
    </Field>
  );

  return (
    <div className="stack loose">
      <PageHead title="Discord" lead="A bot in your Discord server. It posts recaps when you publish them and the table's dice rolls, sends players their broker answers, and lets linked players /roll, /ask their quick helper and read /recap." />
      <ErrorBox error={v.error || act.error} />

      <section className="card stack">
        <h3>1. The bot</h3>
        <p className="small muted">
          Make an application at <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers</a>, open Bot, press Reset Token and paste it here.
          The bot needs no privileged intents. The token stays on this server and is never shown again.
        </p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Bot token" help={d.tokenSet ? `Saved (ends in ${d.tokenEnd}). Paste a new one to replace it.` : undefined}>
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={d.tokenSet ? '••••••••' : 'Paste the token'} />
          </Field>
          <button type="button" className="btn primary" disabled={act.busy || !token.trim()} onClick={() => void save({ token: token.trim() }).then(() => setToken(''))}>Save token</button>
          {d.tokenSet && <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void save({ token: null })}>Remove</button>}
        </div>
        <Status d={d} />
      </section>

      <section className="card stack">
        <h3>2. Your server</h3>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Server id" help="In Discord: Settings → Advanced → Developer Mode on, then right-click the server → Copy Server ID.">
            {d.status?.guilds.length ? (
              <select value={guildValue} onChange={(e) => { setGuild(e.target.value); void save({ guildId: e.target.value || null }); }}>
                <option value="">Pick a server</option>
                {d.status.guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                {d.guildId && !d.status.guilds.some((g) => g.id === d.guildId) && <option value={d.guildId}>{d.guildId} (bot not in it yet)</option>}
              </select>
            ) : (
              <input value={guildValue} onChange={(e) => setGuild(e.target.value)} placeholder="123456789012345678" />
            )}
          </Field>
          {!d.status?.guilds.length && <button type="button" className="btn" disabled={act.busy || guildValue === (d.guildId ?? '')} onClick={() => void save({ guildId: guildValue || null })}>Save</button>}
          {d.inviteUrl && <a className="btn" href={d.inviteUrl} target="_blank" rel="noreferrer"><i className="fa-solid fa-user-plus" aria-hidden="true" /> Invite the bot</a>}
        </div>
        {d.guildId && d.status?.connected && !d.status.inServer && <div className="small warn">The bot is not in that server yet. Press Invite the bot.</div>}
      </section>

      <section className="card stack">
        <h3>3. What it posts</h3>
        {chError && <ErrorBox error={chError} />}
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          {pick('Recaps channel', 'recapChannel', 'A session recap, the moment you publish it.')}
          {pick('Dice channel', 'rollChannel', 'Rolls in the table chat (never the party chat).')}
          <button type="button" className="btn" disabled={act.busy || !connected || (!d.recapChannel && !d.rollChannel)} onClick={() => void act.run(async () => {
            const r = await w.call<{ results: { ok: boolean; error?: string }[] }>('POST', '/discord/test', {});
            toast(r.results.every((x) => x.ok) ? 'Test message sent' : r.results.find((x) => !x.ok)?.error ?? 'It did not work');
          })}>Send a test</button>
        </div>
        <label className="row small"><Switch label="Post recaps when I publish them" checked={d.postRecaps} onChange={(x) => void save({ postRecaps: x })} /> Post recaps when I publish them</label>
        <label className="row small"><Switch label="Post table-chat dice rolls" checked={d.postRolls} onChange={(x) => void save({ postRolls: x })} /> Post table-chat dice rolls</label>
        <label className="row small"><Switch label="Send players their broker messages as Discord DMs" checked={d.brokerDms} onChange={(x) => void save({ brokerDms: x })} /> Send players their broker messages as Discord DMs</label>
        {d.brokerDms && <label className="row small"><Switch label="Include the broker's answer in the DM (off: only a note to open the app)" checked={d.brokerText} onChange={(x) => void save({ brokerText: x })} /> Include the broker's answer in the DM (off: only a note to open the app)</label>}
        <label className="row small"><Switch label="Players can /ask their quick helper in Discord" checked={d.helper} onChange={(x) => void save({ helper: x })} /> Players can /ask their quick helper in Discord</label>
        <label className="row small"><Switch label="Bot on" checked={d.enabled} onChange={(x) => void save({ enabled: x })} /> Bot on</label>
        <p className="small muted">Nothing DM-only is ever posted. A player's /ask answer and /recap are only shown to them unless they choose to share. Your requests to the local models still go first.</p>
      </section>

      <section className="card stack">
        <h3>Linked players</h3>
        <p className="small muted">Players link themselves: Settings &amp; account → Discord gives them a code to type as /link.</p>
        {d.links.length === 0 ? <Empty>Nobody is linked yet.</Empty> : d.links.map((l) => (
          <div key={l.accountId} className="row between">
            <span><strong>{l.name}</strong> <span className="tiny muted">{l.discordName || l.discordUser}{l.role ? '' : ' · left the world'}</span></span>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', `/discord/links/${l.accountId}`); await v.reload(); })}>Unlink</button>
          </div>
        ))}
      </section>
      {toastNode}
    </div>
  );
}

function Status({ d }: { d: View }) {
  if (!d.tokenSet) return <div className="small muted">No token yet.</div>;
  if (!d.guildId) return <div className="small muted">Saved. Pick your server below to start the bot.</div>;
  if (!d.enabled) return <div className="small muted">The bot is off.</div>;
  const s = d.status;
  if (!s) return <div className="small muted">Starting…</div>;
  if (s.connected) return <div className="small"><i className="fa-solid fa-circle-check" aria-hidden="true" /> Connected as <strong>{s.botName}</strong>{s.error ? <span className="warn"> · {s.error}</span> : null}</div>;
  return <div className="small warn"><i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> {s.error ?? 'Connecting…'}</div>;
}
