// Sharing the library, for the GM: who can see each page, file and folder, one small dialog to change it,
// the "Shared with players" list, and (for players) what is new from the GM.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Empty, Loading, Modal, useAction } from '../../ui/index.tsx';
import { useNet } from '../../lib/net.ts';
import { LevelChip, levelOf } from '../../pages/library/Levels.tsx';
import { when } from '../../lib/format.ts';

export type Mode = 'party' | 'players' | 'dm';
export interface AudEntry { mode: string; to: string[]; via: string[] }
export interface FolderRule { sourceId: string; path: string; mode: 'party' | 'players'; to: string[]; source: string; at: string }
export interface SharedItem { kind: 'page' | 'file'; id: string; pageId: string; title: string; mode: string; to: string[]; via: string[]; where: string }
export interface Overview { players: { id: string; name: string }[]; pages: Record<string, AudEntry>; files: Record<string, AudEntry>; folders: FolderRule[]; shared: SharedItem[] }

/** The GM's picture of who can see what. Players get nothing here. */
export function useSharing() {
  const { w, isDM } = useWorld();
  return useLoad<Overview | null>(() => (isDM ? w.call<Overview>('GET', '/libshare/overview') : Promise.resolve(null)), [w, isDM], ['libshare', 'page', 'libfile']);
}

const names = (o: Overview | null | undefined, ids: string[]) => ids.map((id) => o?.players.find((p) => p.id === id)?.name ?? 'Someone').join(', ');

/** A chip saying who can see something: Party, N players, GM, Broker or Classified. */
export function AudBadge({ level, entry, o, kind }: { level: unknown; entry?: AudEntry; o?: Overview | null; kind?: 'folder' }) {
  const l = levelOf(level);
  if (l === 'classified' || l === 'broker') return <LevelChip level={l} />;
  const mode = entry?.mode ?? (l === 'party' ? 'party' : 'dm');
  if (mode === 'party') return <span className="shr-chip shr-party" title={kind === 'folder' ? 'Shared with everyone, including what is added later' : 'Everyone in the party can see this'}><i className="fa-solid fa-users" aria-hidden="true" /> Party</span>;
  if (mode === 'players') return <span className="shr-chip shr-some" title={`Shared with ${names(o, entry?.to ?? [])}`}><i className="fa-solid fa-user-group" aria-hidden="true" /> {entry?.to.length} player{entry?.to.length === 1 ? '' : 's'}</span>;
  return <LevelChip level="dm" />;
}

export const ShareBtn = ({ onClick, label = 'Share…', primary }: { onClick: () => void; label?: string; primary?: boolean }) => {
  const online = useNet().online;
  return <button type="button" className={`btn small${primary ? ' primary' : ''}`} disabled={!online} title={online ? undefined : 'Offline: this needs the server'} onClick={onClick}><i className="fa-solid fa-share-nodes" aria-hidden="true" /> {label}</button>;
};

export interface Target { kind: 'page' | 'file' | 'folder'; id?: string; title: string; sourceId?: string; path?: string }

/** One small dialog: Everyone, only these players, or GM only (and for a folder, a rule that also covers what is added later). */
export function ShareDialog({ target, onClose, onDone }: { target: Target; onClose: () => void; onDone?: (msg: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const sharing = useSharing();
  const o = sharing.data;
  // A folder with no path is a whole source: said by name (whole), never implied by a missing path.
  const whole = target.kind === 'folder' && !target.path;
  const q = target.kind === 'folder' ? { kind: 'folder', sourceId: target.sourceId ?? '', path: target.path ?? '' } : { kind: target.kind, id: target.id! };
  const prev = useLoad<any>(() => w.call('GET', '/libshare/preview', undefined, (whole ? { ...q, whole: '1' } : q) as any), [w, target.kind, target.id, target.path, target.sourceId]);
  const current: AudEntry | undefined = useMemo(() => {
    if (!o) return undefined;
    if (target.kind === 'page') return o.pages[target.id!];
    if (target.kind === 'file') return o.files[target.id!];
    const r = o.folders.find((x) => x.sourceId === (target.sourceId ?? '') && x.path === target.path);
    return r ? { mode: r.mode, to: r.to, via: ['folder'] } : undefined;
  }, [o, target]);
  const pageLevel = target.kind === 'page' ? prev.data?.level : target.kind === 'file' ? prev.data?.page?.level : null;
  const startMode: Mode = (current?.mode === 'party' || current?.mode === 'players' ? current.mode : target.kind === 'page' && pageLevel === 'party' ? 'party' : 'dm') as Mode;
  const [mode, setMode] = useState<Mode | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [notify, setNotify] = useState(true);
  const [withPage, setWithPage] = useState<boolean | null>(null);
  const [withFiles, setWithFiles] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const m = mode ?? startMode;
  const ids = picked ?? current?.to ?? [];
  const players = o?.players ?? [];
  const lvl: string | undefined = target.kind === 'file' ? prev.data?.level : prev.data?.level;
  const pg = target.kind === 'file' ? prev.data?.page : prev.data;
  const hidden = lvl === 'classified' ? 'classified' : lvl === 'broker' ? 'broker' : target.kind === 'file' && (pg?.level === 'classified' || pg?.level === 'broker') ? `page-${pg.level}` : null;
  const pageHint = target.kind === 'file' && pg ? (pg.hiddenParts || pg.classifiedText ? 'Its page holds text players will not see. Only the shared parts of the page are shown.' : pg.level === 'dm' ? 'Its page is GM only.' : '') : '';
  const wp = withPage ?? false;

  // Sent with fetch because the confirm question comes back as a 409 with needsConfirm, not as an error.
  const go = async (confirmed: boolean) => {
    const body: any = { ...q, ...(whole ? { whole: true } : {}), mode: m === 'dm' && target.kind === 'folder' ? 'off' : m, players: m === 'players' ? ids : undefined, notify: notify && m !== 'dm', confirm: confirmed, withPage: target.kind === 'file' ? wp : undefined, withFiles: target.kind === 'page' ? withFiles : undefined };
    await act.run(async () => {
      const res = await fetch(`${w.client.baseUrl}${w.path('/libshare/share')}`, { method: 'PUT', headers: { Authorization: `Bearer ${w.client.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.needsConfirm) { setConfirm(j.error); return; }
      if (!res.ok) throw new Error(j.error ?? `Could not share (${res.status})`);
      await sharing.reload();
      onDone?.(m === 'dm' ? `“${target.title}” is GM only again` : m === 'party' ? `Shared “${target.title}” with everyone` : `Shared “${target.title}” with ${ids.length} player${ids.length === 1 ? '' : 's'}`);
      onClose();
    });
  };

  const needsAsk = target.kind === 'folder' && m !== 'dm';
  const choose = (v: Mode) => { setMode(v); setConfirm(null); };
  const blocked = hidden !== null && m !== 'dm' ? hidden : null;
  const canSend = !blocked && (m !== 'players' || ids.length > 0) && !act.busy && !!o && !prev.loading;

  return (
    <Modal title={`Share “${target.title}”`} onClose={onClose}>
      <div className="stack shr-dialog">
        <ErrorBox error={act.error ?? prev.error} />
        {(!o || prev.loading) && <Loading what="sharing" />}
        {hidden && (
          <div className="error-box" role="note">
            {hidden === 'classified' && <><i className="fa-solid fa-lock" aria-hidden="true" /> This is classified and can never be shared. Classified content stays with the GM.</>}
            {hidden === 'broker' && 'This is at the broker level. Change its level to GM only or Party first, then share it.'}
            {hidden.startsWith('page-') && `The page this file is on is ${hidden.slice(5)}, so the file cannot be shared.`}
          </div>
        )}
        {o && !hidden && (
          <>
            <div role="radiogroup" aria-label="Who can see it" className="shr-choices">
              <label className={`shr-choice${m === 'party' ? ' on' : ''}`}><input type="radio" name="shr" checked={m === 'party'} onChange={() => choose('party')} /><span><strong>Everyone</strong><span className="tiny muted">The whole party{target.kind === 'folder' ? `, including pages and files added to this ${whole ? 'source' : 'folder'} later` : ''}.</span></span></label>
              <label className={`shr-choice${m === 'players' ? ' on' : ''}`}><input type="radio" name="shr" checked={m === 'players'} onChange={() => choose('players')} /><span><strong>Only these players</strong><span className="tiny muted">Chosen below. Nobody else can open it.</span></span></label>
              {m === 'players' && (
                <div className="shr-players">
                  {players.map((p) => <label key={p.id} className="row" style={{ gap: 6 }}><input type="checkbox" checked={ids.includes(p.id)} onChange={() => setPicked(ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id])} /> {p.name}</label>)}
                  {!players.length && <span className="small muted">No players have joined yet.</span>}
                </div>
              )}
              <label className={`shr-choice${m === 'dm' ? ' on' : ''}`}><input type="radio" name="shr" checked={m === 'dm'} onChange={() => choose('dm')} /><span><strong>GM only</strong><span className="tiny muted">{target.kind === 'folder' ? 'Remove the folder rule. Items keep their own sharing.' : 'Nobody but you.'}</span></span></label>
            </div>
            {target.kind === 'folder' && prev.data && (
              <p className="small muted">{prev.data.shareable} page{prev.data.shareable === 1 ? '' : 's'} and {prev.data.files} file{prev.data.files === 1 ? '' : 's'} in this {whole ? 'source' : 'folder'}.
                {(prev.data.skippedClassified > 0 || prev.data.skippedBroker > 0) && ` Skipped, never shared: ${prev.data.skippedClassified} classified, ${prev.data.skippedBroker} broker.`}
                {' '}The rule applies to everything added or moved in later too.</p>
            )}
            {target.kind === 'file' && m !== 'dm' && (
              <label className="row shr-opt"><input type="checkbox" checked={wp} onChange={(e) => setWithPage(e.target.checked)} /><span>Also let them open its page “{pg?.title ?? 'page'}”{pageHint && <span className="tiny muted"> {pageHint}</span>}{!pageHint && <span className="tiny muted"> {pg?.level === 'party' ? 'Already shared.' : 'They see the party parts of it.'}</span>}</span></label>
            )}
            {target.kind === 'file' && m !== 'dm' && !wp && pg?.level !== 'party' && <p className="tiny muted">Without the page, they get just the file.</p>}
            {target.kind === 'page' && m !== 'dm' && prev.data?.files > 0 && (
              <label className="row shr-opt"><input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /><span>Also share its {prev.data.files} file{prev.data.files === 1 ? '' : 's'}</span></label>
            )}
            {target.kind === 'page' && m !== 'dm' && prev.data?.hiddenParts && <p className="tiny muted"><i className="fa-solid fa-eye-slash" aria-hidden="true" /> This page has parts players will not see (secret blocks and GM facts stay hidden).</p>}
            {m !== 'dm' && <label className="row shr-opt"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>Tell the players now <span className="tiny muted">(“New from the GM” on their Home and Library)</span></span></label>}
            {(confirm || needsAsk) && m !== 'dm' && (
              <div className="shr-confirm" role="alert">{confirm ?? `Share everything in “${target.title}”, including pages and files added later? Classified and broker pages are skipped.`}</div>
            )}
          </>
        )}
        <div className="row end">
          <button type="button" className="btn small" onClick={onClose}>Cancel</button>
          <button type="button" className="btn small primary" disabled={!canSend} onClick={() => void go(!!confirm || needsAsk)}>
            {m === 'dm' ? 'Make GM only' : confirm ? 'Share anyway' : needsAsk ? 'Yes, share the folder' : notify ? 'Share and tell them' : 'Share'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** "Share…" for one page or file, with its dialog. */
export function ShareControl({ target, label, primary, onDone }: { target: Target; label?: string; primary?: boolean; onDone?: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  return (<><ShareBtn onClick={() => setOpen(true)} label={label} primary={primary} />{open && <ShareDialog target={target} onClose={() => setOpen(false)} onDone={onDone} />}</>);
}

/** The "Shared with players" view: everything players can see right now, and the folder rules. */
export function SharedPanel({ onOpen }: { onOpen: (pageId: string) => void }) {
  const sharing = useSharing();
  const { w } = useWorld();
  const act = useAction();
  const [q, setQ] = useState('');
  const [dlg, setDlg] = useState<Target | null>(null);
  const o = sharing.data;
  if (!o) return sharing.error ? <ErrorBox error={sharing.error} /> : <Loading what="sharing" />;
  const needle = q.trim().toLowerCase();
  const list = o.shared.filter((s) => !needle || s.title.toLowerCase().includes(needle) || s.where.toLowerCase().includes(needle));
  const stop = (s: SharedItem) => act.run(async () => { await w.call('PUT', '/libshare/share', { kind: s.kind, id: s.id, mode: 'dm' }); await sharing.reload(); });
  const stopFolder = (f: FolderRule) => act.run(async () => { await w.call('PUT', '/libshare/share', { kind: 'folder', sourceId: f.sourceId, path: f.path, whole: !f.path, mode: 'off' }); await sharing.reload(); });
  return (
    <div className="stack" aria-label="Shared with players">
      <p className="small muted">Everything players can open right now: shared pages and files, and folder rules.</p>
      <ErrorBox error={act.error} />
      {o.folders.length > 0 && (
        <div className="stack tight">
          <div className="tiny faint">Folder rules</div>
          {o.folders.map((f) => (
            <div key={`${f.sourceId}|${f.path}`} className="list-item shr-row">
              <i className="fa-solid fa-folder-open lib-ico" aria-hidden="true" />
              <span className="stack tight grow" style={{ minWidth: 0 }}><strong className="lib-ellipsis">{f.path || `${f.source} (whole source)`}</strong><span className="tiny faint lib-ellipsis">{f.source} · {f.mode === 'party' ? 'Everyone' : names(o, f.to)} · includes what is added later</span></span>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void stopFolder(f)}>Stop sharing</button>
            </div>
          ))}
        </div>
      )}
      <label className="field"><span className="sr-only">Search what is shared</span><input type="search" placeholder="Search what is shared…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      {list.length ? (
        <div className="lib-flat">
          {list.map((s) => (
            <div key={`${s.kind}:${s.id}`} className="list-item shr-row">
              <i className={`${s.kind === 'file' ? 'fa-regular fa-file' : 'fa-regular fa-file-lines'} lib-ico`} aria-hidden="true" />
              <button type="button" className="lib-link-btn grow" onClick={() => onOpen(s.pageId)}>
                <strong className="lib-ellipsis">{s.title}</strong>
                <span className="tiny faint lib-ellipsis">{s.where}{s.via.includes('folder') ? ' · by folder rule' : ''}</span>
              </button>
              <AudBadge level={s.mode === 'party' ? 'party' : 'dm'} entry={{ mode: s.mode, to: s.to, via: s.via }} o={o} />
              <button type="button" className="btn small" aria-label={`Change sharing of ${s.title}`} onClick={() => setDlg({ kind: s.kind, id: s.id, title: s.title })}><i className="fa-solid fa-share-nodes" aria-hidden="true" /></button>
              {!s.via.includes('level') && !s.via.includes('folder') && <button type="button" className="btn small" disabled={act.busy} onClick={() => void stop(s)}>Stop sharing</button>}
            </div>
          ))}
        </div>
      ) : <Empty>{o.shared.length ? 'Nothing matches.' : 'Nothing is shared with players yet.'}</Empty>}
      {dlg && <ShareDialog target={dlg} onClose={() => setDlg(null)} />}
    </div>
  );
}

interface NewItem { id: string; kind: 'page' | 'file' | 'folder'; itemId: string; title: string; at: string; isNew: boolean; from: string; pageId?: string | null; url?: string; family?: string; pages?: { id: string; title: string }[] }

/** What the GM sent or shared with this player, newest first: "From the GM" in the Library, and a card on Home. */
export function useNewFromDM() {
  const { w, isDM } = useWorld();
  return useLoad<{ items: NewItem[]; newCount: number }>(() => (isDM ? Promise.resolve({ items: [], newCount: 0 }) : w.call('GET', '/libshare/new')), [w, isDM], ['libshare-new', 'libshare', 'page', 'libfile']);
}

export function FromDM({ onOpen, compact, autoSeen }: { onOpen?: (pageId: string) => void; compact?: boolean; autoSeen?: boolean }) {
  const { w, on } = useWorld();
  const data = useNewFromDM();
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => on(['libshare-new'], (e: any) => { setToast(`New from the GM: ${e.data?.title ?? 'something'}`); }), [on]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  const n = data.data?.newCount ?? 0;
  useEffect(() => {
    if (!autoSeen || !n) return;
    const t = setTimeout(() => { void w.call('POST', '/libshare/seen', {}).then(() => data.reload()).catch(() => {}); }, 4000);
    return () => clearTimeout(t);
  }, [autoSeen, n, w, data]);
  const items = (data.data?.items ?? []).slice(0, compact ? 4 : 30);
  if (!items.length) return toast ? <div className="toast" role="status">{toast}</div> : null;
  return (
    <section className="card shr-from" aria-labelledby="shr-from-h">
      <style>{SHARE_CSS}</style>
      <div className="card-head"><h2 id="shr-from-h"><i className="fa-solid fa-scroll" aria-hidden="true" /> From the GM</h2>{n > 0 && <span className="shr-new" aria-label={`${n} new`}>{n} new</span>}</div>
      <div className="stack tight">
        {items.map((it) => (
          <div key={it.id} className="shr-item">
            {it.kind === 'file' ? (
              <a className="shr-link" href={it.url} target="_blank" rel="noopener noreferrer"><i className={`fa-regular ${it.family === 'image' ? 'fa-image' : 'fa-file'}`} aria-hidden="true" /> {it.title}</a>
            ) : it.kind === 'page' ? (
              <PageLink id={it.pageId!} onOpen={onOpen}>{it.title}</PageLink>
            ) : (
              <span className="stack tight"><strong><i className="fa-solid fa-folder-open" aria-hidden="true" /> {it.title}</strong>{it.pages?.map((p) => <PageLink key={p.id} id={p.id} onOpen={onOpen}>{p.title}</PageLink>)}</span>
            )}
            {it.kind === 'file' && it.pageId && <PageLink id={it.pageId} onOpen={onOpen} small>its page</PageLink>}
            {it.isNew && <span className="shr-new">New</span>}
            <span className="tiny faint">{when(it.at)}</span>
          </div>
        ))}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </section>
  );
}

function PageLink({ id, onOpen, children, small }: { id: string; onOpen?: (id: string) => void; children: ReactNode; small?: boolean }) {
  const { info } = useWorld();
  const href = `/w/${info.slug}/library?page=${encodeURIComponent(id)}`;
  return onOpen
    ? <button type="button" className={`lib-link-btn inline${small ? ' tiny' : ''}`} onClick={() => onOpen(id)}>{children}</button>
    : <a className={`shr-link${small ? ' tiny' : ''}`} href={href}>{children}</a>;
}

export const SHARE_CSS = `
.shr-chip { display: inline-flex; gap: 4px; align-items: center; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; border: 1px solid transparent; white-space: nowrap; }
.shr-party { background: var(--ok-bg, #e4f4e6); color: var(--ok-text, #1b6b2c); border-color: var(--ok, #3aa655); }
.shr-some { background: var(--accent-bg); color: var(--accent-strong, var(--accent)); border-color: var(--accent); }
.shr-dialog { min-width: min(420px, 100%); }
.shr-choices { display: flex; flex-direction: column; gap: 8px; }
.shr-choice { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.shr-choice.on { border-color: var(--accent); background: var(--accent-bg); }
.shr-choice > span { display: flex; flex-direction: column; gap: 2px; }
.shr-choice input { margin-top: 3px; }
.shr-players { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px 12px; padding: 4px 10px 4px 36px; }
.shr-opt { gap: 8px; align-items: flex-start; }
.shr-confirm { padding: 10px 12px; border: 2px solid var(--danger, #b3261e); border-radius: 8px; background: var(--danger-bg); color: var(--danger-text); }
.shr-row { gap: 8px; }
.shr-from .shr-item { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.shr-link { color: var(--accent-strong, var(--accent)); text-decoration: underline dotted; text-underline-offset: 3px; }
.shr-new { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; background: var(--accent); color: var(--on-accent, #fff); }
@media (max-width: 760px) { .shr-choice { padding: 12px; } .shr-players { padding-left: 12px; } }
`;
