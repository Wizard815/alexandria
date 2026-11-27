// Sharing library pages with players: one dialog, opened from a page, from the library tree, or from the Share button in the GM's top bar.
// The recipient gets the same player copy; secret parts and anything above the player level stay hidden (the server decides).
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Modal, Switch, useAction } from '../../ui/index.tsx';
import { useNet } from '../../lib/net.ts';
import { CopyButton } from '../../lib/copy.tsx';
import { SHARE_CSS, ShareDialog as GMShareDialog } from '../libshare/Share.tsx';
import { mergeCopies, type PageRow } from '../../pages/library/treeModel.ts';

interface Share { from?: string; to: string; toName: string; fromName: string; kind: string; mine?: boolean }
interface State { everyone: boolean; locked: boolean; shares: Share[] }
const EVENT = 'alx-share-open';
const path = (id: string) => `/library/pages/${encodeURIComponent(id)}/share`;

/** Open the share dialog (ShareHost must be on the page). No page: it starts with the page search. One page: the same dialog the library opens. */
export const openShare = (page?: { id: string; title: string }) => window.dispatchEvent(new CustomEvent(EVENT, { detail: page ?? null }));

export function ShareButton({ pageId, primary }: { pageId: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const online = useNet().online;
  return (
    <>
      <button type="button" className={`btn small${primary ? ' primary' : ''}`} disabled={!online} title={online ? undefined : 'Offline: this needs the server'} onClick={() => setOpen(true)}><i className="fa-solid fa-share-nodes" aria-hidden="true" /> Share…</button>
      {open && <ShareDialog start={[pageId]} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ShareHost() {
  const [start, setStart] = useState<string[] | null>(null);
  const [one, setOne] = useState<{ id: string; title: string } | null>(null);
  const loc = useLocation();
  const [params] = useSearchParams();
  useEffect(() => {
    const f = (e: Event) => {
      const page = (e as CustomEvent).detail as { id: string; title: string } | null;
      if (page) { setOne(page); return; }
      const here = /\/library\/?$/.test(loc.pathname) ? params.get('page') : null;
      setStart(here ? [here] : []);
    };
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, [loc.pathname, params]);
  if (one) return <><style>{SHARE_CSS}</style><GMShareDialog key={one.id} target={{ kind: 'page', ...one }} onClose={() => setOne(null)} /></>;
  return start ? <ShareDialog key={start.join()} start={start} pick onClose={() => setStart(null)} /> : null;
}

function ShareDialog({ start, pick = false, onClose }: { start: string[]; pick?: boolean; onClose: () => void }) {
  const { w, members, me, isGM, info } = useWorld();
  const [ids, setIds] = useState(start);
  const [q, setQ] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const act = useAction();
  const pages = useLoad<PageRow[]>(() => (pick ? w.pages() : Promise.resolve([])), [w, pick]);
  const rows = useMemo(() => mergeCopies(pages.data ?? []).rows, [pages.data]);
  const byId = useMemo(() => new Map((pages.data ?? []).map((r) => [r.id, r])), [pages.data]);
  const single = ids.length === 1 ? ids[0] : null;
  const state = useLoad<State | null>(() => (single ? w.call('GET', path(single)) : Promise.resolve(null)), [w, single]);
  const players = members.filter((m) => m.role === 'player' && m.id !== me);
  const needle = q.trim().toLowerCase();
  const found = needle ? rows.filter((r) => !ids.includes(r.id) && r.title.toLowerCase().includes(needle)).slice(0, 30) : [];
  // An imported or second copy of this page that the party can read already.
  const otherCopy = single ? rows.find((r) => r.copies?.some((c) => c.id === single))?.copies?.some((c) => c.id !== single && c.visibility === 'party') : false;
  const s = single ? state.data : null;
  const mineTo = (id: string) => s?.shares.find((x) => x.to === id && (isGM || x.mine));
  const set = (id: string, on: boolean) => act.run(async () => {
    if (on) await w.call('POST', path(single!), { to: id === 'party' ? 'party' : [id] });
    else await w.call('DELETE', `${path(single!)}?to=${encodeURIComponent(id)}`);
    await state.reload();
  });
  const shareMany = (target: 'party' | string[]) => act.run(async () => {
    let ok = 0;
    const skipped: string[] = [];
    for (const id of ids) { try { await w.call('POST', path(id), { to: target }); ok++; } catch (e: any) { skipped.push(`${byId.get(id)?.title ?? 'A page'}: ${e.message}`); } }
    setTo([]);
    setDone(`Shared ${ok} of ${ids.length}.${skipped.length ? ` Not shared: ${skipped.join('; ')}` : ''}`);
  });
  const link = single ? `${window.location.origin}/w/${info.slug}/library?page=${encodeURIComponent(single)}` : '';
  const who = (m: (typeof players)[number]) => m.character_name || m.display_name;

  return (
    <Modal title={ids.length > 1 ? `Share ${ids.length} pages` : pick && single ? `Share “${byId.get(single)?.title ?? 'this page'}”` : 'Share with players'} onClose={onClose}>
      <ErrorBox error={act.error ?? state.error ?? pages.error} />
      {pick && (
        <div className="stack tight">
          {ids.length > 0 && <div className="share-chips">{ids.map((id) => <span key={id} className="chip gold">{byId.get(id)?.title ?? '…'} <button type="button" className="btn ghost small" style={{ minHeight: 0, padding: '0 2px' }} aria-label={`Remove ${byId.get(id)?.title ?? 'page'}`} onClick={() => { setDone(null); setIds(ids.filter((x) => x !== id)); }}>✕</button></span>)}</div>}
          <input className="input" type="search" autoFocus={!ids.length} placeholder={ids.length ? 'Add another page…' : 'Which page? Type its title…'} aria-label="Find a page to share" value={q} onChange={(e) => setQ(e.target.value)} />
          {needle && <div className="share-list" aria-label="Pages">{found.map((r) => <button key={r.id} type="button" className="list-item" onClick={() => { setDone(null); setIds([...ids, r.id]); setQ(''); }}><span className="stack tight grow"><strong>{r.title}</strong><span className="tiny faint">{(r.folder ?? []).join(' / ')}</span></span>{r.playersSee && <span className="chip teal">players see</span>}</button>)}{pages.data && !found.length && <p className="small muted" style={{ padding: 10 }}>No page has that title.</p>}</div>}
        </div>
      )}
      {single && s && (s.everyone
        ? <p className="ok-box small">Everyone in the party can already read this page.</p>
        : s.locked ? <p className="error-box small">This page is marked GM-only in its own title, tags or text. Remove that mark at its source to share it.</p>
        : <div className="stack tight">
          {otherCopy && <p className="note small">Players can already read another copy of this page. Sharing this one adds your version’s player copy.</p>}
          {[{ id: 'party', label: 'Everyone' }, ...players.map((m) => ({ id: m.id, label: who(m) }))].map((p) => {
            const on = !!mineTo(p.id);
            return <label key={p.id} className="row between"><span>{p.label}</span><Switch checked={on} onChange={(v) => void set(p.id, v)} label={`Share with ${p.label}`} /></label>;
          })}
          {!players.length && <span className="small muted">No players in this world yet.</span>}
          {s.shares.filter((x) => !isGM && !x.mine).map((x) => <span key={`${x.from}-${x.to}`} className="tiny muted">{x.toName}: shared by {x.fromName}, who can stop it</span>)}
        </div>)}
      {ids.length > 1 && (
        <div className="stack tight">
          <button type="button" className="btn primary" disabled={act.busy} onClick={() => void shareMany('party')}>Share with everyone</button>
          <div className="share-chips">{players.map((m) => <button key={m.id} type="button" className={`btn small${to.includes(m.id) ? ' on' : ''}`} aria-pressed={to.includes(m.id)} onClick={() => setTo(to.includes(m.id) ? to.filter((x) => x !== m.id) : [...to, m.id])}>{who(m)}</button>)}</div>
          <button type="button" className="btn" disabled={act.busy || !to.length} onClick={() => void shareMany(to)}>Share with the chosen</button>
        </div>
      )}
      {done && <p className="ok-box small" role="status">{done}</p>}
      {ids.length > 0 && <p className="tiny muted">They get the player copy: secret parts and anything above the player level stay hidden.</p>}
      {single && <div className="row between"><CopyButton text={link} label="Copy link" /><button type="button" className="btn primary small" onClick={onClose}>Done</button></div>}
    </Modal>
  );
}
