// DM → Roll20: connect a Roll20 game to this world. Two small scripts carry
// the data (Roll20's Mod scripts cannot reach the internet): the Alexandria
// Mod script in the game, and the bridge userscript in the DM's browser.
// Here the DM makes the bridge key, installs both, links Roll20 characters
// to players, picks what moves, sends handouts and watches what happened.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { copyText, CopyButton } from '../../lib/copy.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, Loading, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';

interface Link { id: string; name: string; controlledBy: string[]; accountId: string | null; player: string | null; seenAt: string }
interface Status {
  key: { prefix: string; createdAt: string } | null;
  lastSeen: string | null; online: boolean; modVersion: string | null; mode: 'mod' | 'free' | null; latestModVersion: string; campaign: string | null;
  links: Link[]; markers: Record<string, string>; activity: { dir: 'in' | 'out'; text: string; at: string }[];
}

function save(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};

export default function Roll20Page() {
  const { w } = useWorld();
  const st = useLoad<Status>(() => w.call('GET', '/roll20'), [w], ['roll20', 'settings', 'member']);
  if (!st.data) return <div className="stack loose"><PageHead title="Roll20" /><ErrorBox error={st.error} />{!st.error && <Loading />}</div>;
  const s = st.data;
  return (
    <div className="stack loose" data-testid="roll20-page">
      <PageHead title="Roll20" lead="Keep a Roll20 game and this world in step: HP, conditions, rolls and handouts." />
      <StatusCard s={s} />
      <Install s={s} reload={st.reload} />
      <Characters s={s} />
      <Options markers={s.markers} />
      <Send />
      <Activity s={s} />
    </div>
  );
}

function StatusCard({ s }: { s: Status }) {
  const old = s.mode === 'mod' && s.modVersion && s.modVersion !== s.latestModVersion;
  return (
    <section className="card row between" aria-label="Connection" style={{ justifyContent: 'space-between' }}>
      <span className="row">
        <i className={`fa-solid fa-circle ${s.online ? 'ok' : 'faint'}`} aria-hidden="true" style={{ color: s.online ? '#3fa66b' : undefined }} />
        <span className="stack tight">
          <strong style={{ fontWeight: 500 }}>{s.online ? `Connected${s.campaign ? ` to ${s.campaign}` : ''}` : s.key ? 'Not connected' : 'Not set up'}</strong>
          <span className="small muted">
            {s.key ? `Bridge last seen ${ago(s.lastSeen)}` : 'Make a bridge key below to start.'}
            {s.mode === 'mod' ? ` · With the Mod script${s.modVersion ? ` ${s.modVersion}` : ''}` : s.mode === 'free' ? ' · Without the Mod script (bridge only)' : ''}
          </span>
        </span>
      </span>
      {old && <span className="small" role="note">A newer Mod script ({s.latestModVersion}) is here: paste it into Roll20 again.</span>}
    </section>
  );
}

function Install({ s, reload }: { s: Status; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const { client } = useAuth();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [key, setKey] = useState<string | null>(null);
  const file = (name: string) => w.call<{ name: string; text: string }>('GET', `/roll20/files/${name}`);
  const makeKey = () => act.run(async () => {
    if (s.key && !window.confirm('A new key disconnects the bridge you installed before. Make a new one?')) return;
    const r = await w.call<{ key: string }>('POST', '/roll20/key', {});
    setKey(r.key);
    await reload();
  });
  const bridge = () => act.run(async () => {
    if (!key) return;
    const f = await file('alexandria-bridge.user.js');
    save(f.name, f.text.replace("'__ALX_URL__'", JSON.stringify(client.baseUrl)).replace("'__ALX_KEY__'", JSON.stringify(key)));
  });
  const mod = (how: 'copy' | 'save') => act.run(async () => {
    const f = await file('alexandria.mod.js');
    if (how === 'save') save(f.name, f.text);
    else toast((await copyText(f.text)) ? 'Mod script copied' : 'Copy failed: use Download');
  });
  return (
    <section className="card stack" aria-label="Set up">
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Set up</h2>
      <ErrorBox error={act.error} />
      <div className="row" style={{ alignItems: 'stretch', flexWrap: 'wrap' }} aria-label="Two ways to host">
        <div className="card stack tight" style={{ flex: '1 1 260px' }}>
          <strong style={{ fontWeight: 500 }}><i className="fa-solid fa-crown" aria-hidden="true" /> With Roll20 Pro</strong>
          <span className="small muted">The game creator adds the Alexandria Mod script. Roll20 itself makes the changes: HP, conditions, handouts and rolls, on every page. The most reliable way.</span>
        </div>
        <div className="card stack tight" style={{ flex: '1 1 260px' }}>
          <strong style={{ fontWeight: 500 }}><i className="fa-solid fa-feather" aria-hidden="true" /> Without Pro</strong>
          <span className="small muted">Just the bridge, in your browser. Rolls and chat lines always work. HP, conditions and handouts go through Roll20's page data, which Roll20 does not document, so a Roll20 update can stop them until the bridge is updated.</span>
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>The bridge picks the way by itself: it looks for the Mod script when the game opens and works alone when there is none.</p>
      <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Make a bridge key.</strong> <span className="small muted">The bridge, a small script in your browser, uses it to reach Alexandria. The key only opens the Roll20 connection.</span></span>
          {s.key && !key && <span className="small muted">Key {s.key.prefix}… made {ago(s.key.createdAt)}.</span>}
          {key && (
            <span className="row" role="status">
              <code style={{ userSelect: 'all', wordBreak: 'break-all' }} data-testid="roll20-key">{key}</code>
              <CopyButton text={key} label="Copy key" />
            </span>
          )}
          <span className="row">
            <button type="button" className={`btn small${s.key ? ' ghost' : ' primary'}`} disabled={act.busy} onClick={() => void makeKey()}>{s.key ? 'Make a new key' : 'Make a bridge key'}</button>
          </span>
        </li>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Install the bridge in the browser you run the game from.</strong> <span className="small muted">Install Tampermonkey or Violentmonkey, then open the downloaded file. It has your address and key in it, so keep it to yourself. Open your game: a small “Alexandria: Connected” tag shows bottom left.</span></span>
          <span className="row">
            <button type="button" className="btn small primary" disabled={act.busy || !key} onClick={() => void bridge()}><i className="fa-solid fa-download" aria-hidden="true" /> Download the bridge</button>
            {!key && <span className="small muted">{s.key ? 'The key is only shown once: make a new key to download the bridge again.' : 'Make a key first (it goes into the file).'}</span>}
          </span>
        </li>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>With Roll20 Pro only: add the Alexandria Mod script to the game.</strong> <span className="small muted">In the game: Settings → Mod (API) Scripts → New Script, paste it, Save. Without Pro, skip this step.</span></span>
          <span className="row">
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void mod('copy')}><i className="fa-solid fa-copy" aria-hidden="true" /> Copy the Mod script</button>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void mod('save')}><i className="fa-solid fa-download" aria-hidden="true" /> Download</button>
          </span>
        </li>
      </ol>
      {toastNode}
    </section>
  );
}

function Characters({ s }: { s: Status }) {
  const { w, members } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const players = members.filter((m) => m.role === 'player');
  const link = (id: string, accountId: string) => act.run(async () => { await w.call('PUT', `/roll20/links/${encodeURIComponent(id)}`, { accountId: accountId || null }); toast('Linked: Alexandria’s HP goes to Roll20 next'); });
  const push = () => act.run(async () => { const r = await w.call<{ queued: number }>('POST', '/roll20/push', {}); toast(`Sending HP and conditions for ${r.queued} character${r.queued === 1 ? '' : 's'}`); });
  return (
    <section className="card stack" aria-label="Characters">
      <div className="row between">
        <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Characters</h2>
        {s.links.some((l) => l.accountId) && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void push()}>Send Alexandria’s HP to Roll20</button>}
      </div>
      <ErrorBox error={act.error} />
      {s.links.length === 0 && <Empty>No Roll20 characters yet. Once the bridge connects, every character a player controls shows here, linked to a player when the names match.</Empty>}
      {s.links.map((l) => (
        <div key={l.id} className="row between">
          <span className="stack tight">
            <strong style={{ fontWeight: 500 }}>{l.name || l.id}</strong>
            <span className="tiny muted">{l.controlledBy.length ? `Played by ${l.controlledBy.join(', ')} in Roll20` : 'Nobody controls it in Roll20'}</span>
          </span>
          <Field label="Alexandria player">
            <select aria-label={`Player for ${l.name}`} value={l.accountId ?? ''} disabled={act.busy} onChange={(e) => void link(l.id, e.target.value)}>
              <option value="">Not linked</option>
              {players.map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}
            </select>
          </Field>
        </div>
      ))}
      {toastNode}
    </section>
  );
}

const OPTION_ROWS: [string, string, string][] = [
  ['roll20Hp', 'HP', 'HP, max HP and temporary HP of linked characters, both ways.'],
  ['roll20Conditions', 'Conditions', 'Conditions ↔ token status markers, both ways.'],
  ['roll20RollsIn', 'Roll20 rolls → table chat', 'Open rolls in Roll20 show in Alexandria’s table chat (not whispers or GM rolls).'],
  ['roll20RollsOut', 'Table chat rolls → Roll20', 'Rolls made in Alexandria’s table chat show in the Roll20 chat.'],
];

function Options({ markers }: { markers: Record<string, string> }) {
  const { w, info, reloadInfo } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const set = info.settings as unknown as Record<string, unknown>;
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(markers));
  const put = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await reloadInfo(); toast('Saved'); });
  const saveMarkers = () => {
    const out: Record<string, string> = {};
    // Defaults left out of the list are turned off.
    for (const k of Object.keys(markers)) out[k] = '';
    for (const [c, m] of rows) if (c.trim()) out[c.trim()] = m.trim();
    return put({ roll20Markers: out });
  };
  return (
    <section className="card stack" aria-label="What moves">
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>What moves</h2>
      <ErrorBox error={act.error} />
      {OPTION_ROWS.map(([k, label, help]) => (
        <div key={k} className="row between">
          <span className="stack tight"><strong style={{ fontWeight: 500 }}>{label}</strong><span className="small muted">{help}</span></span>
          <Switch checked={set[k] === true} label={label} onChange={(v) => void put({ [k]: v })} />
        </div>
      ))}
      <details>
        <summary className="small">Condition → status marker</summary>
        <p className="small muted">Roll20 marker names (e.g. skull, sleepy, chemical-bolt), or the name of a marker in your game's custom marker set. Clear a marker to stop that condition showing.</p>
        <div className="stack tight">
          {rows.map(([c, m], i) => (
            <div key={i} className="row">
              <input aria-label="Condition" value={c} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} style={{ maxWidth: 180 }} />
              <input aria-label={`Marker for ${c}`} value={m} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} style={{ maxWidth: 200 }} />
            </div>
          ))}
          <span className="row">
            <button type="button" className="btn small ghost" onClick={() => setRows([...rows, ['', '']])}>Add a condition</button>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void saveMarkers()}>Save markers</button>
          </span>
        </div>
      </details>
      {toastNode}
    </section>
  );
}

function Send() {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [page, setPage] = useState('');
  const [players, setPlayers] = useState(true);
  const [text, setText] = useState('');
  return (
    <section className="card stack" aria-label="Send to Roll20">
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Send to Roll20</h2>
      <ErrorBox error={act.error} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Library page" help="Its title. Players get their copy of the page; your copy goes in the GM notes."><input value={page} onChange={(e) => setPage(e.target.value)} placeholder="The Drowned Bell" /></Field>
        <Switch checked={players} label="In the players' journals" onChange={setPlayers} />
        <button type="button" className="btn primary" disabled={act.busy || !page.trim()} onClick={() => void act.run(async () => { await w.call('POST', '/roll20/handout', { page: page.trim(), players }); setPage(''); toast('Handout on its way'); })}>Send as a handout</button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Say in the Roll20 chat"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="The bell tolls twice." /></Field>
        <button type="button" className="btn" disabled={act.busy || !text.trim()} onClick={() => void act.run(async () => { await w.call('POST', '/roll20/say', { text: text.trim() }); setText(''); toast('Sent'); })}>Say it</button>
      </div>
      {toastNode}
    </section>
  );
}

function Activity({ s }: { s: Status }) {
  return (
    <section className="card stack" aria-label="Activity">
      <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Activity</h2>
      {s.activity.length === 0 ? <Empty>Nothing has moved yet.</Empty> : (
        <ul className="stack tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {s.activity.map((a, i) => (
            <li key={i} className="row small">
              <i className={`fa-solid ${a.dir === 'in' ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}`} aria-label={a.dir === 'in' ? 'From Roll20' : 'To Roll20'} />
              <span>{a.text}</span>
              <span className="tiny faint">{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
