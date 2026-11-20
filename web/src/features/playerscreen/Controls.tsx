// The DM's remote for the players' screen: what is playing, next/previous,
// the queue (YouTube links and pictures), slideshow settings and focus.
// PlayerScreenControls is compact so another panel (the portrait side
// monitor) can mount it; the "Players' screen" page adds the picture sources.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, useAction } from '../../ui/index.tsx';

export interface MediaItem { id: string; kind: 'youtube' | 'image' | 'video'; ref: string; title: string; hidden: boolean; thumb: string | null; dmOnly?: boolean; blocked?: boolean; sound?: boolean; loopVideo?: boolean; playSecs?: number }
export interface DmMedia { mode: 'off' | 'queue' | 'slideshow' | 'focus'; prevMode: string; playing: boolean; loop: boolean; intervalSec: number; currentId: string | null; focusId: string | null; items: MediaItem[] }
export interface Sources { folders: { folder: string; images: number; videos: number; shared: number; showable: number }[]; files: { id: string; name: string; folder: string; family: 'image' | 'video'; shared: boolean; blocked: boolean; thumb: string }[]; stage: { id: string; label: string; thumb: string }[] }

/** The media state for the DM, live. Writes answer with the new state, which is used straight away. */
export function useScreenMedia() {
  const { w } = useWorld();
  const l = useLoad(() => w.call<DmMedia>('GET', '/screen/media'), [w], ['screen']);
  const act = useAction();
  const send = (method: string, path: string, body?: unknown) => act.run(async () => { l.setData(await w.call<DmMedia>(method, `/screen/media${path}`, body ?? {})); });
  return { media: l.data, loading: l.loading, error: l.error ?? act.error, busy: act.busy, send, reload: l.reload };
}

export const CSS = `
.psc { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.psc .seg { display: flex; gap: 4px; flex-wrap: wrap; }
.psc .now { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psc .q { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.psc .q li { display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.psc .q li.cur { border-color: var(--accent); background: var(--accent-bg); }
.psc .q li.off { opacity: 0.55; }
.psc .q .opts { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; font-size: 12px; flex-basis: 100%; }
.psc .q li { flex-wrap: wrap; }
.psc .q img, .psc .q video { width: 56px; height: 36px; object-fit: cover; border-radius: 4px; flex: none; background: var(--panel-2); }
.psc .q .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.psc .q .acts { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.psc .btn.small { padding: 2px 8px; min-height: 28px; }
.psc .pick { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
.psc .pick button { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); cursor: pointer; font-size: 12px; min-width: 0; }
.psc .pick .cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.psc .pick img, .psc .pick video { width: 100%; height: 70px; object-fit: cover; border-radius: 4px; }
.psc .pick button:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const label = (i: MediaItem) => i.title || (i.kind === 'youtube' ? `YouTube ${i.ref}` : i.kind === 'video' ? 'Video' : 'Picture');

/** A picture, or the first frame of a video (a muted, paused <video> on its ticket URL). */
const Thumb = ({ url, video }: { url: string; video: boolean }) => (video ? <video src={`${url}#t=0.1`} preload="metadata" muted playsInline aria-hidden="true" /> : <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" />);

function Row({ item, idx, last, m, send, busy }: { item: MediaItem; idx: number; last: boolean; m: DmMedia; send: ReturnType<typeof useScreenMedia>['send']; busy: boolean }) {
  const { client } = useAuth();
  const thumb = item.thumb ? (item.thumb.startsWith('/') ? client.baseUrl + item.thumb : item.thumb) : null;
  const move = (to: number) => {
    const ids = m.items.map((i) => i.id);
    ids.splice(to, 0, ids.splice(idx, 1)[0]);
    void send('PUT', '/order', { ids });
  };
  const showNow = () => send('PUT', '', { mode: m.mode === 'slideshow' && item.kind !== 'youtube' ? 'slideshow' : 'queue', currentId: item.id });
  return (
    <li className={`${m.currentId === item.id ? 'cur' : ''} ${item.hidden ? 'off' : ''}`}>
      {thumb ? <Thumb url={thumb} video={item.kind === 'video'} /> : <span style={{ width: 56 }} />}
      <span className="t" title={label(item)}>{item.kind === 'video' && <i className="fa-solid fa-film" aria-hidden="true" />} {label(item)}{item.hidden && <span className="muted"> (hidden)</span>}{item.dmOnly && <span className="muted" title="Players cannot open this file in the library; it shows only while it is on the screen"> (DM-only)</span>}{item.blocked && <span className="muted"> (classified: will not show)</span>}</span>
      <span className="acts">
        <button type="button" className="btn small" disabled={busy || item.hidden} onClick={() => void showNow()}>Show</button>
        <button type="button" className={`btn small${m.focusId === item.id ? ' on' : ''}`} aria-pressed={m.focusId === item.id} disabled={busy || item.hidden} onClick={() => void send('POST', '/focus', { id: m.focusId === item.id ? null : item.id })}>Focus</button>
        <button type="button" className="btn small" disabled={busy} aria-label={item.hidden ? `Unhide ${label(item)}` : `Hide ${label(item)}`} onClick={() => void send('PATCH', `/items/${item.id}`, { hidden: !item.hidden })}>{item.hidden ? 'Unhide' : 'Hide'}</button>
        <button type="button" className="btn small" disabled={busy || idx === 0} aria-label="Move up" onClick={() => move(idx - 1)}>↑</button>
        <button type="button" className="btn small" disabled={busy || last} aria-label="Move down" onClick={() => move(idx + 1)}>↓</button>
        <button type="button" className="btn small danger" disabled={busy} aria-label={`Remove ${label(item)}`} onClick={() => void send('DELETE', `/items/${item.id}`)}>Remove</button>
      </span>
      {item.kind === 'video' && (
        <span className="opts" role="group" aria-label={`Video options for ${label(item)}`}>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={item.sound !== false} disabled={busy} onChange={(e) => void send('PATCH', `/items/${item.id}`, { sound: e.target.checked })} /> Sound</label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={!!item.loopVideo} disabled={busy} onChange={(e) => void send('PATCH', `/items/${item.id}`, { loopVideo: e.target.checked })} /> Loop video</label>
          <label className="row" style={{ gap: 4 }}>Play for
            <input style={{ width: 56 }} inputMode="numeric" aria-label={`Play ${label(item)} for seconds`} placeholder="until end" defaultValue={item.playSecs ? String(item.playSecs) : ''} key={`${item.id}:${item.playSecs ?? 0}`}
              onBlur={(e) => { const raw = e.target.value.replace(/\D/g, ''); const n = raw ? Number(raw) : 0; if (n !== (item.playSecs ?? 0) && (n === 0 || (n >= 2 && n <= 3600))) void send('PATCH', `/items/${item.id}`, { playSecs: n }); }} /> s</label>
        </span>
      )}
    </li>
  );
}

/** Compact remote for the players' screen. Mount it in any panel. */
export function PlayerScreenControls({ showQueue = true }: { showQueue?: boolean }) {
  const { w, info } = useWorld();
  const { media: m, error, busy, send } = useScreenMedia();
  const [url, setUrl] = useState('');
  const [secs, setSecs] = useState('');
  const add = useAction();
  if (!m) return <div className="psc"><style>{CSS}</style><ErrorBox error={error} /><p className="muted small">Loading…</p></div>;
  const cur = m.items.find((i) => i.id === m.currentId);
  const queueYt = (play: boolean) => add.run(async () => { await w.call('POST', '/screen/media/items', { kind: 'youtube', url: url.trim(), play }); setUrl(''); });
  const open = () => window.open(`/w/${info.slug}/screen/players`, 'alx-players-screen', 'popup');
  return (
    <div className="psc">
      <style>{CSS}</style>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div className="seg" role="group" aria-label="Screen media mode">
          {(['off', 'queue', 'slideshow'] as const).map((k) => (
            <button key={k} type="button" className={`btn small${m.mode === k ? ' on' : ''}`} aria-pressed={m.mode === k} disabled={busy} onClick={() => void send('PUT', '', { mode: k })}>{k === 'off' ? 'Off' : k === 'queue' ? 'Queue' : 'Slideshow'}</button>
          ))}
        </div>
        <button type="button" className="btn small" onClick={open}>Open players' screen</button>
      </div>
      <div className="now" aria-live="polite">
        {m.mode === 'off' ? 'Media off: the table sees the stage' : m.mode === 'focus' ? `Focused: ${cur ? label(cur) : 'nothing'}` : `Showing: ${cur ? label(cur) : 'nothing queued'}`}
      </div>
      <div className="seg" role="group" aria-label="Playback">
        <button type="button" className="btn small" disabled={busy || m.mode === 'off' || m.mode === 'focus'} onClick={() => void send('POST', '/previous')}>◀ Previous</button>
        <button type="button" className="btn small" disabled={busy || m.mode !== 'slideshow'} aria-pressed={!m.playing} onClick={() => void send('PUT', '', { playing: !m.playing })}>{m.playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="btn small" disabled={busy || m.mode === 'off' || m.mode === 'focus'} onClick={() => void send('POST', '/next')}>Next ▶</button>
        <button type="button" className={`btn small${m.loop ? ' on' : ''}`} aria-pressed={m.loop} disabled={busy} onClick={() => void send('PUT', '', { loop: !m.loop })}>Loop</button>
        {m.mode === 'focus' && <button type="button" className="btn small primary" disabled={busy} onClick={() => void send('POST', '/focus', { id: null })}>Unfocus</button>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>A video ends its own slide (the next one follows when it finishes), unless you set “Play for” seconds or Loop on it. Pictures and GIFs use the slideshow seconds.</p>
      <label className="row small" style={{ gap: 6 }}>Slideshow seconds
        <input style={{ width: 70 }} inputMode="numeric" aria-label="Slideshow seconds" value={secs || String(m.intervalSec)} onChange={(e) => setSecs(e.target.value.replace(/\D/g, ''))}
          onBlur={() => { const n = Number(secs); if (secs && n >= 2 && n <= 3600 && n !== m.intervalSec) void send('PUT', '', { intervalSec: n }); setSecs(''); }} />
      </label>
      <form className="row" style={{ gap: 6, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (url.trim()) void queueYt(false); }}>
        <input className="grow" style={{ minWidth: 140 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube link" aria-label="YouTube link" maxLength={300} />
        <button type="submit" className="btn small" disabled={add.busy || !url.trim()}>Queue</button>
        <button type="button" className="btn small primary" disabled={add.busy || !url.trim()} onClick={() => void queueYt(true)}>Play now</button>
      </form>
      <ErrorBox error={error ?? add.error} />
      {showQueue && (m.items.length ? (
        <ul className="q" aria-label="Screen queue">
          {m.items.map((i, n) => <Row key={i.id} item={i} idx={n} last={n === m.items.length - 1} m={m} send={send} busy={busy} />)}
        </ul>
      ) : <p className="muted small" style={{ margin: 0 }}>The queue is empty.</p>)}
      {m.items.length > 0 && <div><button type="button" className="btn small danger" disabled={busy} onClick={() => void send('POST', '/clear')}>Clear the queue</button></div>}
    </div>
  );
}

/** Pictures the DM can put on the screen: a folder as a slideshow, one library picture, one stage picture. */
export function PictureSources({ onDone }: { onDone?: () => void }) {
  const { w } = useWorld();
  const { client } = useAuth();
  const src = useLoad(() => w.call<Sources>('GET', '/screen/media/sources'), [w], ['libfile']);
  const act = useAction();
  const [note, setNote] = useState<string | null>(null);
  const thumb = (u: string) => (u.startsWith('/') ? client.baseUrl + u : u);
  const add = (ref: string, kind: 'image' | 'video' = 'image') => act.run(async () => { await w.call('POST', '/screen/media/items', { kind, ref }); onDone?.(); });
  const share = (f: Sources['files'][number]) => act.run(async () => {
    if (!window.confirm(`Share “${f.name}” with the party? Players will be able to open it in the library.`)) return;
    await w.call('POST', '/screen/media/share', { fileId: f.id });
    setNote(`“${f.name}” is shared with the party.`);
    src.reload();
  });
  const folder = (f: string) => act.run(async () => {
    const r = await w.call<{ loaded: number; skipped: number }>('POST', '/screen/media/folder', { folder: f });
    setNote(`Loaded ${r.loaded} file${r.loaded === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} skipped (classified)` : ''}.`);
    onDone?.();
  });
  const s = src.data;
  return (
    <div className="psc">
      <style>{CSS}</style>
      <ErrorBox error={src.error ?? act.error} />
      {note && <div role="status" className="note">{note}</div>}
      <h3 style={{ fontSize: 16 }}>Library folders</h3>
      <p className="muted small" style={{ margin: 0 }}>Loading a folder replaces the queue with its pictures, GIFs and videos (in file-name order, mixed) and starts a slideshow. Files only you can open show on the screen while they are on it, and nowhere else; classified files never show.</p>
      {s && (s.folders.length ? (
        <div className="seg">
          {s.folders.map((f) => <button key={f.folder} type="button" className="btn small" disabled={act.busy || f.showable === 0} onClick={() => void folder(f.folder)}>{f.folder || '(top level)'} · {f.images} picture{f.images === 1 ? '' : 's'}{f.videos > 0 && `, ${f.videos} video${f.videos === 1 ? '' : 's'}`}</button>)}
        </div>
      ) : <p className="muted small">No library pictures yet.</p>)}
      <h3 style={{ fontSize: 16 }}>Library pictures and videos</h3>
      {s && s.files.length > 0 && (
        <div className="pick">
          {s.files.map((f) => (
            <div className="cell" key={f.id}>
              <button type="button" disabled={act.busy || f.blocked} title={f.blocked ? 'Classified: it cannot go on the screen' : f.shared ? 'Add to the queue' : 'Only you can open this file. Add it to the queue to show it on the screen anyway'} onClick={() => void add(f.id, f.family)}>
                <Thumb url={thumb(f.thumb)} video={f.family === 'video'} /><span>{f.family === 'video' && <i className="fa-solid fa-film" aria-hidden="true" />} {f.name}{f.blocked ? ' (classified)' : !f.shared ? ' (DM-only)' : ''}</span>
              </button>
              {!f.shared && !f.blocked && <button type="button" className="btn small" disabled={act.busy} aria-label={`Share ${f.name} with the party`} onClick={() => void share(f)}>Share with party</button>}
            </div>
          ))}
        </div>
      )}
      <h3 style={{ fontSize: 16 }}>Stage pictures</h3>
      {s && (s.stage.length ? (
        <div className="pick">
          {s.stage.map((f) => <button key={f.id} type="button" disabled={act.busy} title="Add to the queue" onClick={() => void add(f.id)}><img src={thumb(f.thumb)} alt="" loading="lazy" /><span>{f.label || 'Picture'}</span></button>)}
        </div>
      ) : <p className="muted small">No stage pictures yet. Upload one on the Stage page.</p>)}
    </div>
  );
}
