// /share: what someone shared to Alexandria from another Android app (a photo, a link, some
// text). The app hands it to this page (desktop/.../MainActivity.kt, shareIntoPage); the person
// picks the world and where it goes. Players: the table or party chat. The DM also: the
// library's files, or the stage.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { uploadPicture } from '../../lib/upload.ts';
import { ErrorBox, useAction } from '../../ui/index.tsx';

interface Shared { text?: string; subject?: string; files?: { name: string; type: string; data: string }[] }
type Dest = 'table' | 'party' | 'files' | 'stage';

const fromB64 = (f: { name: string; type: string; data: string }) => {
  const bin = atob(f.data);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return new File([b], f.name || 'shared', { type: f.type || 'application/octet-stream' });
};

export default function SharePage() {
  const { client, me } = useAuth();
  const nav = useNavigate();
  const act = useAction();
  const [got, setGot] = useState<Shared | null>(null);
  const worlds = (me?.worlds ?? []).filter((w) => w.role !== 'guest');
  const [world, setWorld] = useState('');
  const [text, setText] = useState('');
  const [dest, setDest] = useState<Dest>('table');
  const [done, setDone] = useState('');

  // The app polls for this flag, then sets window.__alxShare (or a page test sends the event).
  useEffect(() => {
    const take = (s: Shared) => { setGot(s); setText([s.subject, s.text].filter(Boolean).join('\n')); };
    const w = window as any;
    if (w.__alxShare) take(w.__alxShare);
    w.__alxShareReady = true;
    const t = setInterval(() => { if (w.__alxShare) { take(w.__alxShare); w.__alxShare = null; } }, 300);
    return () => { clearInterval(t); w.__alxShareReady = false; };
  }, []);
  useEffect(() => { if (!world && worlds[0]) setWorld(worlds[0].slug); }, [worlds, world]);

  const files = useMemo(() => (got?.files ?? []).map(fromB64), [got]);
  const pics = files.filter((f) => f.type.startsWith('image/'));
  const isDM = worlds.find((w) => w.slug === world)?.role === 'dm';
  const dests: [Dest, string][] = [['table', 'Table chat'], ['party', 'Party chat'], ...(isDM && files.length ? [['files', 'Library files'], ...(pics.length ? [['stage', 'The stage']] : [])] as [Dest, string][] : [])];
  useEffect(() => { if (!dests.some(([d]) => d === dest)) setDest('table'); }, [dests.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return <div className="page"><h1>Share to Alexandria</h1><p>Sign in first, then share again.</p><Link className="btn" to="/login">Sign in</Link></div>;

  const send = () => act.run(async () => {
    const w = client.world(world);
    if (dest === 'table' || dest === 'party') {
      if (!text.trim()) throw new Error(files.length ? 'Pictures go to the library or the stage; the chat takes text.' : 'Nothing to send');
      await w.call('POST', `/sessionchat/chat/${dest}`, { body: text.trim().slice(0, 4000) });
      setDone(`Sent to the ${dest} chat.`);
    } else if (dest === 'stage') {
      for (const f of pics) await uploadPicture(w, '/stage/images', f);
      setDone(`${pics.length} picture${pics.length === 1 ? '' : 's'} added to the stage's pictures.`);
    } else {
      for (const f of files) {
        const q = new URLSearchParams({ name: f.name, kind: f.type.startsWith('image/') ? 'handout' : 'other', level: 'dm', folder: 'Shared', title: f.name });
        const r = await fetch(`${client.baseUrl}${w.path('/files')}?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/octet-stream' }, body: f });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Upload failed (${r.status})`);
      }
      setDone(`${files.length} file${files.length === 1 ? '' : 's'} added to the library (folder "Shared", DM only).`);
    }
  });

  return (
    <div className="page stack" style={{ maxWidth: 640 }} data-testid="share-page">
      <h1>Share to Alexandria</h1>
      {!got ? <p className="muted">Waiting for what you shared…</p> : (
        <>
          {pics.length > 0 && <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>{pics.map((f, i) => <img key={i} src={URL.createObjectURL(f)} alt={f.name} style={{ maxWidth: 140, maxHeight: 140, borderRadius: 6 }} />)}</div>}
          {files.length > pics.length && <p className="small">{files.filter((f) => !f.type.startsWith('image/')).map((f) => f.name).join(', ')}</p>}
          <label className="stack tight small">Text
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} data-testid="share-text" />
          </label>
          <label className="stack tight small">World
            <select value={world} onChange={(e) => setWorld(e.target.value)} aria-label="World">{worlds.map((w) => <option key={w.id} value={w.slug}>{w.name}</option>)}</select>
          </label>
          <div className="tabs" role="radiogroup" aria-label="Where to">
            {dests.map(([d, l]) => <button key={d} type="button" role="radio" aria-checked={dest === d} className={`btn small${dest === d ? ' on' : ''}`} onClick={() => setDest(d)}>{l}</button>)}
          </div>
          <ErrorBox error={act.error} />
          {done ? (
            <div className="ok-box stack tight" role="status" data-testid="share-done"><span>{done}</span><button type="button" className="btn small" onClick={() => nav(`/w/${world}${isDM ? '/dm' : ''}`)}>Open {worlds.find((w) => w.slug === world)?.name}</button></div>
          ) : (
            <div className="row"><button type="button" className="btn primary" disabled={act.busy || !world} onClick={() => void send()} data-testid="share-send">Send</button></div>
          )}
        </>
      )}
    </div>
  );
}
