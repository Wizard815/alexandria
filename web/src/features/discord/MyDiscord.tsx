// A player links their Discord account: a one-time code, typed as /link in the server.
import { useState } from 'react';
import { ErrorBox, Loading, PageHead, useAction } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { CopyButton } from '../../lib/copy.tsx';

interface Me { available: boolean; serverName: string | null; botName: string | null; helper: boolean; linked: { discordName: string; linkedAt: string } | null }

export default function MyDiscord() {
  const { w } = useWorld();
  const me = useLoad(() => w.call<Me>('GET', '/discord/me'), [w]);
  const act = useAction();
  const [code, setCode] = useState<{ code: string; command: string; minutes: number } | null>(null);
  if (!me.data) return <Loading />;
  const m = me.data;
  return (
    <div className="stack loose">
      <PageHead title="Discord" lead="Use your character from your table's Discord server: roll dice, ask your quick helper, read the last recap, and get the broker's answers as Discord messages." />
      <ErrorBox error={me.error || act.error} />
      {!m.available && <div className="card muted">Your GM has not set up a Discord bot for this world yet.</div>}
      {m.available && m.linked && (
        <div className="card stack">
          <div><i className="fa-solid fa-circle-check" aria-hidden="true" /> Linked to <strong>{m.linked.discordName || 'your Discord account'}</strong>{m.serverName ? <> on <strong>{m.serverName}</strong></> : null}.</div>
          <div className="small muted">In the server: <code>/roll 2d6+3</code>, {m.helper ? <><code>/ask</code> (only you see the answer), </> : null}<code>/recap</code>.</div>
          <div><button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', '/discord/me'); setCode(null); await me.reload(); })}>Unlink</button></div>
        </div>
      )}
      {m.available && !m.linked && (
        <div className="card stack">
          <ol className="stack" style={{ margin: 0, paddingLeft: '1.2em' }}>
            <li>Get a code here. It works once and lasts 10 minutes.</li>
            <li>In {m.serverName ? <strong>{m.serverName}</strong> : 'the Discord server'}, type the command below{m.botName ? <> to <strong>{m.botName}</strong></> : null}. Only you see its answer.</li>
          </ol>
          {code ? (
            <div className="row" style={{ alignItems: 'center' }}>
              <code className="big" data-testid="discord-command">{code.command}</code>
              <CopyButton text={code.command} />
            </div>
          ) : null}
          <div className="row">
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.run(async () => setCode(await w.call('POST', '/discord/me/code', {})))}>{code ? 'New code' : 'Get a link code'}</button>
            {code && <button type="button" className="btn" onClick={() => void me.reload()}>I typed it</button>}
          </div>
        </div>
      )}
    </div>
  );
}
