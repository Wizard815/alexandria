// The extension's popover (the Alexandria button in Owlbear Rodeo's toolbar). The GM pastes the link key and picks what
// the scene shows and who leads the fog; a player sees which world the table is linked to, with a link to it.
import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import OBR, { type Theme } from '@owlbear-rodeo/sdk';
import { api, getKey, listen, setKey, tell, type Hello, type Status, type WorkerNote } from './api.ts';
import { FOG, ROOM, startWorkerOnce } from './sync.ts';
import './popover.css';

const FOLLOW = '__table__';

function useTheme() {
  useEffect(() => {
    const set = (t: Theme) => {
      const s = document.documentElement.style;
      document.documentElement.dataset.mode = t.mode.toLowerCase();
      s.setProperty('--obr-bg', t.background.paper);
      s.setProperty('--obr-text', t.text.primary);
      s.setProperty('--obr-muted', t.text.secondary);
      s.setProperty('--obr-accent', t.primary.main);
      s.setProperty('--obr-accent-text', t.primary.contrastText);
    };
    void OBR.theme.getTheme().then(set);
    return OBR.theme.onChange(set);
  }, []);
}

function Player() {
  const [room, setRoom] = useState<{ origin: string; worldId: string; worldName: string } | null>(null);
  useEffect(() => {
    const read = (m: Record<string, unknown>) => setRoom((m[ROOM] as any) ?? null);
    void OBR.room.getMetadata().then(read);
    return OBR.room.onMetadataChange(read);
  }, []);
  if (!room) return <p className="muted">This room is not linked to an Alexandria world yet. The GM links it.</p>;
  return (
    <>
      <p>This table plays in <b>{room.worldName}</b>.</p>
      <p className="muted">Your sheet, the party chat and the information broker are in Alexandria.</p>
      <a className="btn primary" href={`${room.origin}/w/${encodeURIComponent(room.worldId)}`} target="_blank" rel="noreferrer">Open Alexandria</a>
    </>
  );
}

function KeyForm({ onSaved }: { onSaved: () => void }) {
  const [k, setK] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api<Hello>('GET', '/hello', undefined, k.trim());
      setKey(k.trim());
      onSaved();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p>Link this room to your Alexandria world.</p>
      <ol className="muted">
        <li>In Alexandria, open <b>GM → Setup → Owlbear Rodeo</b>.</li>
        <li>Press <b>Make a link key</b> and copy it.</li>
        <li>Paste it here. It stays in this browser only.</li>
      </ol>
      <label>Link key <input data-testid="obr-key" value={k} onChange={(e) => setK(e.target.value)} placeholder="alx_obr_…" autoComplete="off" spellCheck={false} /></label>
      {err && <p className="err" role="alert">{err}</p>}
      <button className="btn primary" type="submit" disabled={busy || !k.trim()}>{busy ? 'Checking…' : 'Link'}</button>
    </form>
  );
}

function GM() {
  const [key, setK] = useState(getKey());
  const [hello, setHello] = useState<Hello | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [note, setNote] = useState<WorkerNote | null>(null);
  const [err, setErr] = useState('');
  const [cells, setCells] = useState('');

  const load = useCallback(async () => {
    if (!getKey()) { setHello(null); return; }
    try {
      const h = await api<Hello>('GET', '/hello');
      setHello(h); setSt(h); setCells(String(h.link.cells || '')); setErr('');
    } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { void load(); }, [load, key]);
  useEffect(() => listen((m) => { if (m.type === 'note') setNote(m.note); if (m.type === 'key') setK(getKey()); }), []);
  useEffect(() => { tell({ type: 'ask' }); }, []);

  const change = async (body: Record<string, unknown>) => {
    try { setSt(await api<Status>('PUT', '/link', body)); setErr(''); tell({ type: 'kick' }); } catch (e: any) { setErr(e.message); }
  };
  const clearOwlbearFog = async () => {
    const items = await OBR.scene.items.getItems((it) => it.layer === 'FOG' && !it.metadata?.[FOG]);
    if (items.length) await OBR.scene.items.deleteItems(items.map((i) => i.id));
    void OBR.notification.show(items.length ? `Cleared ${items.length} Owlbear fog shape${items.length === 1 ? '' : 's'}` : 'No Owlbear fog shapes to clear');
  };

  if (!key) return <KeyForm onSaved={() => setK(getKey())} />;
  if (!hello || !st) return <>{err ? <><p className="err" role="alert">{err}</p><button className="btn" onClick={() => setKey('')}>Use another key</button></> : <p className="muted">Connecting…</p>}</>;

  const showing = st.link.follow ? FOLLOW : st.link.pic ?? '';
  return (
    <>
      <p className="world">Linked to <b data-testid="obr-world">{hello.world.name}</b></p>
      {note && <p className={`note ${note.state}`} data-testid="obr-note" role="status">{note.text}</p>}
      {err && <p className="err" role="alert">{err}</p>}

      <label>Map picture
        <select data-testid="obr-pic" value={showing} onChange={(e) => void change(e.target.value === FOLLOW ? { follow: true } : { follow: false, pic: e.target.value || null })}>
          <option value={FOLLOW}>What the table screen shows{st.link.follow && st.target.label ? ` (${st.target.label})` : ''}</option>
          {!hello.pictures.length && <option value="" disabled>No map pictures the players may see</option>}
          {hello.pictures.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>
      <p className="muted small">Only pictures the players may see are listed: Owlbear shows the picture to everyone in the room.</p>

      <fieldset>
        <legend>Fog of war</legend>
        <label className="row"><input type="radio" name="lead" data-testid="obr-lead-alexandria" checked={st.link.lead === 'alexandria'} onChange={() => void change({ lead: 'alexandria' })} />
          <span><b>Alexandria leads.</b> Reveal on Alexandria's Map page or table screen; Owlbear follows.</span></label>
        <label className="row"><input type="radio" name="lead" data-testid="obr-lead-owlbear" checked={st.link.lead === 'owlbear'} onChange={() => void change({ lead: 'owlbear' })} />
          <span><b>Owlbear leads.</b> Fog and reveal with Owlbear's fog tools; Alexandria follows.</span></label>
      </fieldset>

      <label>Map width in grid squares
        <input inputMode="numeric" data-testid="obr-cells" value={cells} placeholder="picture's own size" onChange={(e) => setCells(e.target.value.replace(/\D/g, ''))}
          onBlur={() => { const n = Number(cells || 0); if (n !== st.link.cells) void change({ cells: n }); }} />
      </label>
      <p className="muted small">Used when the picture is next placed. You can also scale the map in Owlbear; the fog stays on it.</p>

      <div className="buttons">
        <button className="btn" onClick={() => { tell({ type: 'kick' }); void load(); }}>Sync now</button>
        <button className="btn" onClick={() => void clearOwlbearFog()} title="Owlbear's own fog shapes (not Alexandria's)">Clear Owlbear's fog</button>
        <button className="btn quiet" onClick={() => setKey('')}>Unlink</button>
      </div>
    </>
  );
}

function App() {
  useTheme();
  const [role, setRole] = useState<'GM' | 'PLAYER' | null>(null);
  useEffect(() => {
    void OBR.player.getRole().then(setRole);
    return OBR.player.onChange((p) => setRole(p.role));
  }, []);
  return <main>{role === null ? <p className="muted">Loading…</p> : role === 'GM' ? <GM /> : <Player />}</main>;
}

OBR.onReady(() => {
  // If the background page is not running in this browser, the popover keeps the scene in step while it is open.
  startWorkerOnce();
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
});
