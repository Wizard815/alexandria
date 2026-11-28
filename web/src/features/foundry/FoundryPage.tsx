// GM → Foundry VTT: connect a Foundry world to this world. One Foundry module
// (the Alexandria Bridge, installed in Foundry by its manifest URL) carries
// the data from the GM's Foundry tab. Here the GM makes the bridge key, links
// Foundry actors to players and scenes to maps, sends maps to Foundry, picks
// what moves and watches what happened.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { CopyButton } from '../../lib/copy.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, Loading, PageHead, Switch, useAction, useToast } from '../../ui/index.tsx';

interface Actor { id: string; name: string; owners: string[]; accountId: string | null; player: string | null }
interface Token { id: string; name: string; x: number; y: number; hidden: boolean; player: string | null }
interface Scene { id: string; name: string; active: boolean; hasPicture: boolean; mapId: string | null; pic: string | null; picName: string | null; tokens: Token[] }
interface Status {
  key: { prefix: string; createdAt: string } | null;
  lastSeen: string | null; online: boolean; moduleVersion: string | null; latestModuleVersion: string;
  foundryWorld: string | null; system: string | null; foundryVersion: string | null; statusIds: string[];
  actors: Actor[]; scenes: Scene[]; statuses: Record<string, string>; activity: { dir: 'in' | 'out'; text: string; at: string }[];
}
interface Pic { value: string; label: string }

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
const H2 = ({ children }: { children: string }) => <h2 style={{ margin: 0, fontSize: '1.05rem' }}>{children}</h2>;

/** Every map picture the GM can link or send: the library's maps and the sources' map pictures. */
function usePictures() {
  const { w } = useWorld();
  const lib = useLoad<{ id: string; name: string; pageTitle?: string }[]>(() => w.call('GET', '/files/maps').catch(() => []), [w], ['libfile']);
  const imp = useLoad<{ id: string; name: string; page: { title: string } | null }[]>(() => w.call('GET', '/intake/map-images').catch(() => []), [w], ['page']);
  const list: Pic[] = [
    ...(lib.data ?? []).map((f) => ({ value: `lib:${f.id}`, label: `${f.name}${f.pageTitle ? ` (${f.pageTitle})` : ''}` })),
    ...(imp.data ?? []).map((m) => ({ value: `imp:${m.id}`, label: `${m.name || 'Map'}${m.page ? ` (${m.page.title})` : ''} · from a source` })),
  ];
  return list;
}

export default function FoundryPage() {
  const { w } = useWorld();
  const st = useLoad<Status>(() => w.call('GET', '/foundry'), [w], ['foundry', 'settings', 'member', 'map-mark', 'map-mark-removed']);
  const pics = usePictures();
  if (!st.data) return <div className="stack loose"><PageHead title="Foundry VTT" /><ErrorBox error={st.error} />{!st.error && <Loading />}</div>;
  const s = st.data;
  return (
    <div className="stack loose" data-testid="foundry-page">
      <PageHead title="Foundry VTT" lead="Keep a Foundry world and this world in step: maps, tokens, fog of war, HP, conditions, rolls and journal entries." />
      <StatusCard s={s} />
      <Install s={s} reload={st.reload} />
      <Scenes s={s} pics={pics} />
      <Characters s={s} />
      <Options s={s} />
      <Send />
      <Activity s={s} />
    </div>
  );
}

function StatusCard({ s }: { s: Status }) {
  const old = s.moduleVersion && s.moduleVersion !== s.latestModuleVersion;
  return (
    <section className="card row between" aria-label="Connection" style={{ justifyContent: 'space-between' }}>
      <span className="row">
        <i className={`fa-solid fa-circle ${s.online ? 'ok' : 'faint'}`} aria-hidden="true" style={{ color: s.online ? '#3fa66b' : undefined }} />
        <span className="stack tight">
          <strong style={{ fontWeight: 500 }} data-testid="foundry-state">{s.online ? `Connected${s.foundryWorld ? ` to ${s.foundryWorld}` : ''}` : s.key ? 'Not connected' : 'Not set up'}</strong>
          <span className="small muted">
            {s.key ? `Module last seen ${ago(s.lastSeen)}` : 'Make a bridge key below to start.'}
            {s.foundryVersion ? ` · Foundry ${s.foundryVersion}` : ''}{s.system ? ` · ${s.system}` : ''}{s.moduleVersion ? ` · module ${s.moduleVersion}` : ''}
          </span>
        </span>
      </span>
      {old && <span className="small" role="note">A newer module ({s.latestModuleVersion}) is here: update it in Foundry's module list.</span>}
    </section>
  );
}

function Install({ s, reload }: { s: Status; reload: () => Promise<void> }) {
  const { w } = useWorld();
  const { client } = useAuth();
  const act = useAction();
  const [key, setKey] = useState<string | null>(null);
  const manifest = `${client.baseUrl}/api/foundry/module.json`;
  const makeKey = () => act.run(async () => {
    if (s.key && !window.confirm('A new key disconnects the Foundry module you set up before. Make a new one?')) return;
    const r = await w.call<{ key: string }>('POST', '/foundry/key', {});
    setKey(r.key);
    await reload();
  });
  return (
    <section className="card stack" aria-label="Set up">
      <H2>Set up</H2>
      <ErrorBox error={act.error} />
      <ol className="stack" style={{ margin: 0, paddingLeft: 20 }}>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Install the Alexandria Bridge module in Foundry.</strong> <span className="small muted">In Foundry's setup screen: Add-on Modules → Install Module, paste this address in Manifest URL, Install. Then turn it on in your world (Game Settings → Manage Modules).</span></span>
          <span className="row">
            <code style={{ userSelect: 'all', wordBreak: 'break-all' }} data-testid="foundry-manifest">{manifest}</code>
            <CopyButton text={manifest} label="Copy" />
          </span>
          {/^http:/.test(manifest) && <span className="small muted">If your Foundry page is on https, this server must be on https too: a browser will not let an https page call an http server.</span>}
        </li>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>Make a bridge key.</strong> <span className="small muted">The module uses it to reach Alexandria. It only opens the Foundry connection.</span></span>
          {s.key && !key && <span className="small muted">Key {s.key.prefix}… made {ago(s.key.createdAt)}.</span>}
          {key && (
            <span className="row" role="status">
              <code style={{ userSelect: 'all', wordBreak: 'break-all' }} data-testid="foundry-key">{key}</code>
              <CopyButton text={key} label="Copy key" />
            </span>
          )}
          <span className="row">
            <button type="button" className={`btn small${s.key ? ' ghost' : ' primary'}`} disabled={act.busy} onClick={() => void makeKey()}>{s.key ? 'Make a new key' : 'Make a bridge key'}</button>
          </span>
        </li>
        <li className="stack tight">
          <span><strong style={{ fontWeight: 500 }}>In your Foundry world, as the GM:</strong> <span className="small muted">Game Settings → Configure Settings → Alexandria Bridge. Paste the address below and the key. They stay in your browser; players never get the key. A small “Alexandria: Connected” tag shows bottom left.</span></span>
          <span className="row">
            <code style={{ userSelect: 'all' }}>{client.baseUrl}</code>
            <CopyButton text={client.baseUrl} label="Copy address" />
          </span>
        </li>
      </ol>
      <p className="small muted" style={{ margin: 0 }}>Keep Foundry open in your browser while you play: the bridge runs in the GM's tab.</p>
    </section>
  );
}

function Scenes({ s, pics }: { s: Status; pics: Pic[] }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [mapId, setMapId] = useState('');
  const [pic, setPic] = useState('');
  const [send, setSend] = useState('');
  const [name, setName] = useState('');
  const open = (sc: Scene) => { setEditing(sc.id); setMapId(sc.mapId ?? sc.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '')); setPic(sc.pic ?? pics[0]?.value ?? ''); };
  return (
    <section className="card stack" aria-label="Maps and scenes">
      <H2>Maps and scenes</H2>
      <p className="small muted" style={{ margin: 0 }}>A scene linked to an Alexandria map shares its tokens and fog with that map: tokens show on the Map page and the table screen, Alexandria's fog is drawn over the scene in Foundry, and player tokens uncover fog as they move.</p>
      <ErrorBox error={act.error} />
      {s.scenes.length === 0 && <Empty>No scenes yet. Once the module connects, every scene in your Foundry world shows here.</Empty>}
      {s.scenes.map((sc) => (
        <div key={sc.id} className="stack tight" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }} data-testid="foundry-scene">
          <div className="row between">
            <span className="stack tight">
              <strong style={{ fontWeight: 500 }}>{sc.name}{sc.active && <span className="chip" style={{ marginLeft: 6 }}>Active</span>}</strong>
              <span className="tiny muted">
                {sc.mapId ? <>On the map <strong>{sc.mapId}</strong>{sc.picName ? ` (${sc.picName})` : ''} · {sc.tokens.length} token{sc.tokens.length === 1 ? '' : 's'}</> : 'Not linked to an Alexandria map'}
              </span>
            </span>
            <span className="row">
              {sc.hasPicture && <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/foundry/scenes/${encodeURIComponent(sc.id)}/import`, {}); toast(`Bringing "${sc.name}" in…`); })}>{sc.mapId ? 'Bring its picture in again' : 'Bring into Alexandria'}</button>}
              <button type="button" className="btn small ghost" onClick={() => (editing === sc.id ? setEditing(null) : open(sc))}>{sc.mapId ? 'Change link' : 'Link to a map'}</button>
              {sc.mapId && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('PUT', `/foundry/scenes/${encodeURIComponent(sc.id)}`, { mapId: null }); toast('Unlinked'); })}>Unlink</button>}
            </span>
          </div>
          {editing === sc.id && (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Alexandria map"><input value={mapId} onChange={(e) => setMapId(e.target.value)} placeholder="old-kesh" /></Field>
              <Field label="Map picture">
                <select value={pic} onChange={(e) => setPic(e.target.value)}>
                  {pics.length === 0 && <option value="">No map pictures yet</option>}
                  {pics.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </Field>
              <button type="button" className="btn primary small" disabled={act.busy || !mapId.trim() || !pic} onClick={() => void act.run(async () => { await w.call('PUT', `/foundry/scenes/${encodeURIComponent(sc.id)}`, { mapId: mapId.trim(), pic }); setEditing(null); toast('Linked'); })}>Link</button>
            </div>
          )}
          {sc.tokens.length > 0 && (
            <details>
              <summary className="small">Tokens</summary>
              <ul className="small" style={{ margin: 0 }}>
                {sc.tokens.map((t) => <li key={t.id}>{t.name}{t.player ? ` (${t.player})` : ''}{t.hidden ? ' · hidden' : ''} · {Math.round(t.x)}, {Math.round(t.y)}</li>)}
              </ul>
            </details>
          )}
        </div>
      ))}
      <div className="row" style={{ alignItems: 'flex-end', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <Field label="Send a map to Foundry" help="Makes a new scene of the picture's size, linked to the map.">
          <select value={send} onChange={(e) => setSend(e.target.value)} aria-label="Map picture to send">
            <option value="">Pick a map picture</option>
            {pics.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
        <Field label="Scene name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="The Harbor" /></Field>
        <button type="button" className="btn primary" disabled={act.busy || !send} onClick={() => void act.run(async () => { const r = await w.call<{ name: string }>('POST', '/foundry/scenes', { pic: send, name: name.trim() || undefined }); setSend(''); setName(''); toast(`"${r.name}" is on its way to Foundry`); })}>Make the scene</button>
      </div>
      {toastNode}
    </section>
  );
}

function Characters({ s }: { s: Status }) {
  const { w, members } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const players = members.filter((m) => m.role === 'player');
  const link = (id: string, accountId: string) => act.run(async () => { await w.call('PUT', `/foundry/actors/${encodeURIComponent(id)}`, { accountId: accountId || null }); toast('Linked: Alexandria’s HP goes to Foundry next'); });
  const push = () => act.run(async () => { const r = await w.call<{ queued: number }>('POST', '/foundry/push', {}); toast(`Sending HP and conditions for ${r.queued} character${r.queued === 1 ? '' : 's'}`); });
  return (
    <section className="card stack" aria-label="Characters">
      <div className="row between">
        <H2>Characters</H2>
        {s.actors.some((a) => a.accountId) && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void push()}>Send Alexandria’s HP to Foundry</button>}
      </div>
      <ErrorBox error={act.error} />
      {s.actors.length === 0 && <Empty>No actors yet. Once the module connects, every actor a player owns shows here, linked to a player when the names match.</Empty>}
      {s.actors.map((a) => (
        <div key={a.id} className="row between">
          <span className="stack tight">
            <strong style={{ fontWeight: 500 }}>{a.name || a.id}</strong>
            <span className="tiny muted">{a.owners.length ? `Owned by ${a.owners.join(', ')} in Foundry` : 'No player owns it in Foundry'}</span>
          </span>
          <Field label="Alexandria player">
            <select aria-label={`Player for ${a.name}`} value={a.accountId ?? ''} disabled={act.busy} onChange={(e) => void link(a.id, e.target.value)}>
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
  ['foundryHp', 'HP', 'HP and temporary HP of linked characters, both ways (max HP comes from Foundry).'],
  ['foundryConditions', 'Conditions', 'Conditions ↔ status effects on the actor, both ways.'],
  ['foundryTokens', 'Tokens', 'Tokens on linked scenes show on the Alexandria map. Hidden tokens are only for you.'],
  ['foundryPlayersMove', 'Players move their tokens', 'A player can drag their own character’s token on the Alexandria map, and it moves in Foundry.'],
  ['foundryFog', 'Fog of war', 'Alexandria’s fog is drawn over linked scenes in Foundry (a tint for you, solid for players).'],
  ['foundryRollsIn', 'Foundry rolls → table chat', 'Open rolls in the Foundry chat show in Alexandria’s table chat (not whispers or blind rolls).'],
  ['foundryRollsOut', 'Table chat rolls → Foundry', 'Rolls made in Alexandria’s table chat show in the Foundry chat.'],
  ['foundryPushMax', 'Send max HP too', 'Alexandria’s max HP is written into Foundry (in dnd5e this overrides the worked-out max).'],
];

function Options({ s }: { s: Status }) {
  const { w, info, reloadInfo } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const set = info.settings as unknown as Record<string, unknown>;
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(s.statuses));
  const [paths, setPaths] = useState(() => ({ foundryHpPath: String(set.foundryHpPath ?? ''), foundryMaxPath: String(set.foundryMaxPath ?? ''), foundryTempPath: String(set.foundryTempPath ?? '') }));
  const put = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await reloadInfo(); toast('Saved'); });
  const saveStatuses = () => {
    const out: Record<string, string> = {};
    for (const k of Object.keys(s.statuses)) out[k] = '';
    for (const [c, m] of rows) if (c.trim()) out[c.trim()] = m.trim();
    return put({ foundryStatuses: out });
  };
  return (
    <section className="card stack" aria-label="What moves">
      <H2>What moves</H2>
      <ErrorBox error={act.error} />
      {OPTION_ROWS.map(([k, label, help]) => (
        <div key={k} className="row between">
          <span className="stack tight"><strong style={{ fontWeight: 500 }}>{label}</strong><span className="small muted">{help}</span></span>
          <Switch checked={set[k] === true} label={label} onChange={(v) => void put({ [k]: v })} />
        </div>
      ))}
      <div className="row between">
        <span className="stack tight"><strong style={{ fontWeight: 500 }}>Player tokens uncover fog</strong><span className="small muted">How far around a player token the fog lifts when it moves, in grid squares. 0 turns it off.</span></span>
        <input type="number" min={0} max={60} aria-label="Squares uncovered around a player token" defaultValue={Number(set.foundryRevealSquares ?? 6)} style={{ width: 80 }}
          onBlur={(e) => { const n = Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))); if (n !== set.foundryRevealSquares) void put({ foundryRevealSquares: n }); }} />
      </div>
      <details>
        <summary className="small">Condition → status effect</summary>
        <p className="small muted">Foundry status effect ids (dnd5e: poisoned, prone, unconscious…). Clear one to stop that condition showing.{s.statusIds.length ? ` This world has: ${s.statusIds.join(', ')}.` : ''}</p>
        <div className="stack tight">
          {rows.map(([c, m], i) => (
            <div key={i} className="row">
              <input aria-label="Condition" value={c} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} style={{ maxWidth: 180 }} />
              <input aria-label={`Status for ${c}`} value={m} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} style={{ maxWidth: 200 }} />
            </div>
          ))}
          <span className="row">
            <button type="button" className="btn small ghost" onClick={() => setRows([...rows, ['', '']])}>Add a condition</button>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void saveStatuses()}>Save status effects</button>
          </span>
        </div>
      </details>
      <details>
        <summary className="small">Where HP is in your game system</summary>
        <p className="small muted">The actor data paths. The defaults fit dnd5e.</p>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="HP"><input value={paths.foundryHpPath} onChange={(e) => setPaths({ ...paths, foundryHpPath: e.target.value })} /></Field>
          <Field label="Max HP"><input value={paths.foundryMaxPath} onChange={(e) => setPaths({ ...paths, foundryMaxPath: e.target.value })} /></Field>
          <Field label="Temp HP"><input value={paths.foundryTempPath} onChange={(e) => setPaths({ ...paths, foundryTempPath: e.target.value })} /></Field>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void put(paths)}>Save paths</button>
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
    <section className="card stack" aria-label="Send to Foundry">
      <H2>Send to Foundry</H2>
      <ErrorBox error={act.error} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Library page" help="Its title. Players get their copy of the page; your copy goes on a GM-only page of the entry."><input value={page} onChange={(e) => setPage(e.target.value)} placeholder="The Drowned Bell" /></Field>
        <Switch checked={players} label="Players can read it" onChange={setPlayers} />
        <button type="button" className="btn primary" disabled={act.busy || !page.trim()} onClick={() => void act.run(async () => { await w.call('POST', '/foundry/handout', { page: page.trim(), players }); setPage(''); toast('Journal entry on its way'); })}>Send as a journal entry</button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Field label="Say in the Foundry chat"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="The bell tolls twice." /></Field>
        <button type="button" className="btn" disabled={act.busy || !text.trim()} onClick={() => void act.run(async () => { await w.call('POST', '/foundry/say', { text: text.trim() }); setText(''); toast('Sent'); })}>Say it</button>
      </div>
      {toastNode}
    </section>
  );
}

function Activity({ s }: { s: Status }) {
  return (
    <section className="card stack" aria-label="Activity">
      <H2>Activity</H2>
      {s.activity.length === 0 ? <Empty>Nothing has moved yet.</Empty> : (
        <ul className="stack tight" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {s.activity.map((a, i) => (
            <li key={i} className="row small">
              <i className={`fa-solid ${a.dir === 'in' ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}`} aria-label={a.dir === 'in' ? 'From Foundry' : 'To Foundry'} />
              <span>{a.text}</span>
              <span className="tiny faint">{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
