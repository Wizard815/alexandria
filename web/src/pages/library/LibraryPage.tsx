// The Library, for the DM and for players. A file browser for thousands of
// pages, a page view that keeps the layout of the app a page came from
// (LegendKeeper infoboxes, callouts, secrets, mentions), and offline copies.
// Players only ever receive the player copy from the server, so what they
// save offline is that copy too.
import '@fortawesome/fontawesome-free/css/all.min.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { zipSync, strToU8 } from 'fflate';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { PageHead, ErrorBox, Empty, Loading, VisChip, Tabs, useToast, useAction } from '../../ui/index.tsx';
import * as off from '../../lib/offline.ts';
import { useNet } from '../../lib/net.ts';
import { Blocks, Facts, Icon, LIB_CSS, type RenderCtx } from './Blocks.tsx';
import { Tree, TREE_CSS, type PageRow } from './Tree.tsx';
import { Editor, SecretHint } from './Editor.tsx';
import { AskModal } from './AskModal.tsx';
import { escapeHtml, safeMarks, snippetOf } from '../../features/search/marks.ts';
import '../../features/search/search.css';

type Side = 'pages' | 'saved' | 'lint';
type Sort = 'tree' | 'recent' | 'title';

export default function LibraryPage() {
  const { w, info, isDM, me } = useWorld();
  const [params, setParams] = useSearchParams();
  const pages = useLoad<PageRow[]>(() => w.pages(), [w], ['page']);
  const lint = useLoad<any[]>(() => (isDM ? w.call('GET', '/library/lint') : Promise.resolve([])), [w, isDM], ['page']);
  const [saved, setSaved] = useState<off.SavedPage[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [tag, setTag] = useState('');
  const [kind, setKind] = useState('');
  const [vis, setVis] = useState<'all' | 'party' | 'dm'>('all');
  const [savedOnly, setSavedOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('tree');
  const [side, setSide] = useState<Side>('pages');
  const [busy, setBusy] = useState<string | null>(null);
  const { toast, toastNode } = useToast();
  const world = info.id;

  const refreshSaved = useCallback(() => off.listSaved(world, me).then(setSaved), [world, me]);
  useEffect(() => { void refreshSaved(); }, [refreshSaved]);
  const savedIds = useMemo(() => new Set(saved.map((s) => s.pageId)), [saved]);

  // With the server out of reach, browse what was saved.
  const offline = !!pages.error && !pages.data;
  // Text search runs on the server; offline, the box filters saved titles only.
  const netOnline = useNet().online;
  const rows: PageRow[] = useMemo(() => {
    if (pages.data) return pages.data;
    if (!offline) return [];
    return saved.map((s) => ({ id: s.pageId, path: s.page.path ?? s.title, title: s.title, kind: s.page.kind ?? 'page', tags: s.page.tags ?? [], folder: s.folder, icon: s.page.icon ?? null, parentId: null, source: s.source, updated_at: s.page.updated_at ?? s.savedAt, visibility: s.page.visibility }));
  }, [pages.data, offline, saved]);

  // ?title=Name (from a wiki link) opens that page, or offers to make it.
  const titleParam = params.get('title');
  useEffect(() => {
    if (!titleParam || !pages.data) return;
    const t = titleParam.toLowerCase();
    const hit = pages.data.find((p) => p.title.toLowerCase() === t);
    setParams(hit ? { page: hit.id } : isDM ? { new: titleParam } : {}, { replace: true });
  }, [titleParam, pages.data, setParams, isDM]);

  useEffect(() => {
    if (!q.trim() || offline || !netOnline) { setHits(null); return; }
    const t = setTimeout(() => { w.search(q).then(setHits).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q, w, offline, netOnline]);

  const tags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags ?? []))].sort((a, b) => a.localeCompare(b)), [rows]);
  const kinds = useMemo(() => [...new Set(rows.map((r) => r.kind).filter(Boolean))].sort(), [rows]);
  const needle = q.trim().toLowerCase();
  const list = useMemo(() => rows.filter((r) =>
    (!tag || r.tags?.includes(tag)) && (!kind || r.kind === kind) && (!savedOnly || savedIds.has(r.id)) &&
    (vis === 'all' || (vis === 'party' ? r.visibility === 'party' : r.visibility !== 'party')) &&
    (!needle || r.title.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle))), [rows, tag, kind, savedOnly, savedIds, vis, needle]);
  const flat = useMemo(() => (sort === 'tree' && !needle ? null : [...list].sort((a, b) => (sort === 'recent' ? b.updated_at.localeCompare(a.updated_at) : a.title.localeCompare(b.title, undefined, { numeric: true })))), [list, sort, needle]);

  const selected = params.get('page');
  const creating = isDM ? params.get('new') : null;
  const open = useCallback((id: string) => setParams({ page: id }), [setParams]);
  const filtered = !!(tag || kind || savedOnly || vis !== 'all');

  /** Fetch pages by id (100 at a time) and save them for offline. */
  const saveMany = async (ids: string[], label: string) => {
    if (!ids.length) return;
    setBusy(`Saving ${label}…`);
    let n = 0;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const got = await w.call<any[]>('POST', '/library/pages/bulk', { ids: ids.slice(i, i + 100) });
        for (const p of got) if (await off.savePage(world, me, p)) n++;
        setBusy(`Saving ${label}… ${Math.min(i + 100, ids.length)} / ${ids.length}`);
      }
      toast(n ? `Saved ${n} page${n === 1 ? '' : 's'} for offline` : 'Offline storage is blocked in this browser');
    } catch (e: any) {
      toast(`Could not save: ${e.message}`);
    } finally {
      setBusy(null);
      void refreshSaved();
    }
  };

  const updateSaved = async () => {
    const ids = saved.map((s) => s.pageId);
    await saveMany(ids, 'saved pages');
    // Pages gone or no longer visible to you are removed from this device too.
    try {
      const now = new Set((await w.pages()).map((p: any) => p.id));
      for (const s of saved) if (!now.has(s.pageId)) await off.removeSaved(world, me, s.pageId);
    } catch { /* offline: keep them */ }
    void refreshSaved();
  };

  const zipSaved = () => {
    const files: Record<string, Uint8Array> = {};
    for (const s of saved) {
      let name = [...(s.source ? [s.source] : []), ...s.folder, off.fileName(s.title)].map((x) => x.replace(/[\\/:*?"<>|]+/g, ' ').trim() || '_').join('/');
      while (files[name]) name = name.replace(/\.md$/, ' (2).md');
      files[name] = strToU8(off.pageMarkdown(s.page, s.savedAt));
    }
    off.download(`${info.name} library.zip`, zipSync(files) as BlobPart, 'application/zip');
  };

  const sideItems: [Side, string][] = [['pages', `Pages (${rows.length})`], ['saved', `Saved (${saved.length})`]];
  if (isDM) sideItems.push(['lint', `Leak check${lint.data?.length ? ` (${lint.data.length})` : ''}`]);

  return (
    <div className="page wide">
      <style>{LIB_CSS + TREE_CSS + SHELL_CSS}</style>
      <PageHead title="Library" lead={isDM ? `Every page in ${info.name}. Players get only the player copy of shared pages.` : `What your party knows about ${info.name}. Save pages to read them offline.`}>
        {isDM && <button type="button" className="btn primary" onClick={() => setParams({ new: '' })}><i className="fa-solid fa-plus" aria-hidden="true" /> New page</button>}
      </PageHead>
      {offline && <div className="lib-offline" role="status"><i className="fa-solid fa-plug-circle-xmark" aria-hidden="true" /> The library can't be reached. Showing pages saved on this device.</div>}
      {!offline && <ErrorBox error={pages.error} />}
      {busy && <div className="note small" role="status">{busy}</div>}
      <div className={`lib-shell${selected || creating !== null ? ' has-page' : ''}`}>
        <aside className="lib-side card">
          <Tabs label="Library side panel" value={side} onChange={setSide} items={sideItems} />
          {side === 'pages' && (
            <>
              <label className="field"><span className="sr-only">Search the library</span><input type="search" placeholder={offline || !netOnline ? 'Filter saved titles…' : 'Search titles and text…'} value={q} onChange={(e) => setQ(e.target.value)} /></label>
              <div className="lib-filters">
                <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}</select>
                {kinds.length > 1 && <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All kinds</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select>}
                {isDM && <select aria-label="Who can read" value={vis} onChange={(e) => setVis(e.target.value as any)}><option value="all">Everyone + DM</option><option value="party">Shared</option><option value="dm">DM only</option></select>}
                <select aria-label="Order" value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="tree">Folders</option><option value="recent">Recent</option><option value="title">A–Z</option></select>
                <label className="lib-check"><input type="checkbox" checked={savedOnly} onChange={(e) => setSavedOnly(e.target.checked)} /> Saved for offline</label>
                {filtered && <button type="button" className="btn small" onClick={() => { setTag(''); setKind(''); setVis('all'); setSavedOnly(false); }}>Clear</button>}
              </div>
              {pages.loading && !rows.length && <Loading what="pages" />}
              {hits && (
                <div className="lib-hits" aria-label="Text matches">
                  <div className="tiny faint">Text matches ({hits.length})</div>
                  {hits.length ? hits.slice(0, 50).map((h) => (
                    <button key={h.id} type="button" className={`list-item${selected === h.id ? ' active' : ''}`} onClick={() => open(h.id)}>
                      <span className="stack tight grow" style={{ minWidth: 0 }}><strong className="sx-snip" dangerouslySetInnerHTML={{ __html: h.titleHtml !== undefined ? safeMarks(h.titleHtml) : escapeHtml(h.title) }} /><span className="tiny muted sx-snip" dangerouslySetInnerHTML={{ __html: snippetOf(h) }} /></span>
                    </button>
                  )) : <span className="small muted">No text matches.</span>}
                  {list.length > 0 && <div className="tiny faint" style={{ marginTop: 6 }}>Titles</div>}
                </div>
              )}
              {hits && !list.length ? null : flat ? <FlatList rows={flat} selected={selected} onOpen={open} saved={savedIds} />
                : <Tree rows={list} selected={selected} onOpen={open} saved={savedIds} onSaveFolder={offline ? undefined : (ids, label) => void saveMany(ids, `“${label}”`)} />}
            </>
          )}
          {side === 'saved' && <SavedPanel saved={saved} offline={offline} onOpen={open} onUpdate={() => void updateSaved()} onZip={zipSaved}
            onRemove={async (id) => { await off.removeSaved(world, me, id); void refreshSaved(); }} />}
          {side === 'lint' && isDM && <LintPanel rows={lint.data} error={lint.error} onOpen={open} />}
        </aside>
        <section className="lib-main">
          {(selected || creating !== null) && <button type="button" className="btn small lib-back" onClick={() => setParams({})}><i className="fa-solid fa-arrow-left" aria-hidden="true" /> All pages</button>}
          {creating !== null ? (
            <Editor key={`new:${creating}`} initial={{ path: creating, title: creating, body: '', visibility: 'dm', frontmatter: {} }} isNew
              onSaved={(p) => { toast(`Saved ${p.title}`); setParams({ page: p.id }); }} onCancel={() => setParams({})} />
          ) : selected ? (
            <PageView key={selected} id={selected} rows={rows} savedAt={saved.find((s) => s.pageId === selected)?.savedAt ?? null} onOpen={open}
              onSavedChange={refreshSaved} toast={toast} onDeleted={() => { toast('Page deleted'); setParams({}); }} />
          ) : (
            <div className="card"><Empty>{rows.length ? 'Pick a page on the left.' : offline ? 'Nothing is saved on this device yet.' : isDM ? 'No pages yet. Make one, or add a source in Library admin.' : 'Your DM hasn\'t shared any pages yet.'}</Empty>{isDM && <SecretHint />}</div>
          )}
        </section>
      </div>
      {toastNode}
    </div>
  );
}

function FlatList({ rows, selected, onOpen, saved }: { rows: PageRow[]; selected: string | null; onOpen: (id: string) => void; saved: Set<string> }) {
  const [n, setN] = useState(200);
  if (!rows.length) return <p className="muted small" style={{ padding: 12 }}>No pages match.</p>;
  return (
    <div className="lib-flat">
      {rows.slice(0, n).map((r) => (
        <button key={r.id} type="button" className={`list-item${selected === r.id ? ' active' : ''}`} onClick={() => onOpen(r.id)}>
          {r.icon?.glyph ? <Icon icon={r.icon} size={14} /> : <i className="fa-regular fa-file-lines lib-ico" aria-hidden="true" />}
          <span className="stack tight grow" style={{ minWidth: 0 }}><strong className="lib-ellipsis">{r.title}</strong><span className="tiny faint lib-ellipsis">{[r.source, ...(r.folder ?? [])].filter(Boolean).join(' / ') || r.path} · {when(r.updated_at)}</span></span>
          {r.visibility && r.visibility !== 'party' && <span className="lib-dm-dot" title="DM only" />}
          {saved.has(r.id) && <i className="fa-solid fa-download lib-saved-ico" title="Saved for offline" />}
        </button>
      ))}
      {rows.length > n && <button type="button" className="btn small" style={{ margin: 8 }} onClick={() => setN(n + 500)}>Show more ({rows.length - n} left)</button>}
    </div>
  );
}

function SavedPanel({ saved, offline, onOpen, onRemove, onUpdate, onZip }: { saved: off.SavedPage[]; offline: boolean; onOpen: (id: string) => void; onRemove: (id: string) => void; onUpdate: () => void; onZip: () => void }) {
  const total = saved.reduce((n, s) => n + s.size, 0);
  return (
    <div className="stack">
      <p className="small muted">Pages kept on this device, to read without a connection. Save one from its page, or a whole folder with <i className="fa-solid fa-download" aria-label="the download button" /> in the tree.</p>
      {saved.length > 0 && (
        <div className="row wrap">
          <span className="small faint">{saved.length} page{saved.length === 1 ? '' : 's'} · {off.formatSize(total)}</span>
          <span className="grow" />
          {!offline && <button type="button" className="btn small" onClick={onUpdate}><i className="fa-solid fa-rotate" aria-hidden="true" /> Update saved pages</button>}
          <button type="button" className="btn small" onClick={onZip}><i className="fa-solid fa-file-zipper" aria-hidden="true" /> Download saved pages</button>
        </div>
      )}
      {saved.length ? (
        <div className="lib-flat">
          {saved.map((s) => (
            <div key={s.key} className="list-item">
              <button type="button" className="lib-link-btn grow" onClick={() => onOpen(s.pageId)}>
                <strong className="lib-ellipsis">{s.title}</strong>
                <span className="tiny faint">{off.formatSize(s.size)} · saved {when(s.savedAt)}</span>
              </button>
              <button type="button" className="btn small" aria-label={`Remove ${s.title} from this device`} title="Remove from this device" onClick={() => onRemove(s.pageId)}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
            </div>
          ))}
        </div>
      ) : <Empty>Nothing saved yet.</Empty>}
    </div>
  );
}

function LintPanel({ rows, error, onOpen }: { rows: any[] | null; error: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="stack">
      <p className="small muted">Shared pages that still read like DM notes ("The secret:", "DM note:", "GM only"). The leak guard can't tell plain prose is secret: hide the page or move the text into a secret block.</p>
      <ErrorBox error={error} />
      {rows === null ? <Loading /> : rows.length ? (
        <div className="lib-flat">
          {rows.map((r) => (
            <button key={r.id} type="button" className="list-item" onClick={() => onOpen(r.id)}>
              <span className="stack tight grow"><strong>{r.title}</strong><span className="tiny muted">{r.hints.join(', ')}</span></span>
              <span className="chip red">Check</span>
            </button>
          ))}
        </div>
      ) : <div className="ok-box small">Nothing flagged. Shared pages don't read like DM notes.</div>}
      <SecretHint />
    </div>
  );
}

function PageView({ id, rows, savedAt, onOpen, onSavedChange, toast, onDeleted }: {
  id: string; rows: PageRow[]; savedAt: string | null; onOpen: (id: string) => void; onSavedChange: () => Promise<void> | void; toast: (m: string) => void; onDeleted: () => void;
}) {
  const { w, info, isDM, me } = useWorld();
  const [pg, setPg] = useState<any>(null);
  const [offlineAt, setOfflineAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState<'edit' | 'question' | null>(null);
  const act = useAction();

  const load = useCallback(async () => {
    try {
      const p = await w.page(id);
      setPg(p); setOfflineAt(null); setError(null);
    } catch (e: any) {
      const s = await off.getSaved(info.id, me, id);
      if (s) { setPg(s.page); setOfflineAt(s.savedAt); setError(null); }
      else setError(e.status === 404 ? 'This page is gone, or not shared with you.' : e.message);
    }
  }, [w, id, info.id, me]);
  useEffect(() => { void load(); }, [load]);
  const { on } = useWorld();
  useEffect(() => on(['page'], (e: any) => { if (!e.data?.id || e.data.id === id) void load(); }), [on, id, load]);

  // Keep a saved copy current when it is opened online.
  useEffect(() => {
    if (pg && !offlineAt && savedAt && pg.updated_at && pg.updated_at > savedAt) void off.savePage(info.id, me, pg).then(() => onSavedChange());
  }, [pg, offlineAt, savedAt, info.id, me, onSavedChange]);

  const ctx: RenderCtx = useMemo(() => ({ links: pg?.links ?? {}, open: onOpen, isDM, children: pg?.children ?? [] }), [pg, onOpen, isDM]);
  if (error) return <div className="card"><ErrorBox error={error} /></div>;
  if (!pg) return <div className="card"><Loading what="page" /></div>;
  if (editing) return <Editor key={`edit:${pg.id}`} initial={pg} onSaved={(p) => { setEditing(false); toast(`Saved ${p.title}`); if (p.id !== id) onOpen(p.id); else void load(); }} onCancel={() => setEditing(false)} />;

  const editable = isDM && !pg.source;
  const toggleSave = async () => {
    if (savedAt) { await off.removeSaved(info.id, me, id); toast('Removed from this device'); }
    else toast((await off.savePage(info.id, me, pg)) ? 'Saved for offline' : 'Offline storage is blocked in this browser');
    await onSavedChange();
  };
  const del = () => act.run(async () => {
    if (!window.confirm(`Delete “${pg.title}”? This can't be undone.`)) return;
    await w.deletePage(id);
    onDeleted();
  });
  const crumbs = [pg.source, ...(pg.folder ?? [])].filter(Boolean);
  const parent = rows.find((r) => r.id === rows.find((x) => x.id === id)?.parentId);
  const facts: any[] = pg.properties ?? [];
  // A body that opens with the page title would show it twice.
  const first = pg.blocks?.[0];
  const blocks = first?.kind === 'heading' && (first.content ?? []).map((c: any) => c.text ?? '').join('').trim().toLowerCase() === String(pg.title).toLowerCase() ? pg.blocks.slice(1) : pg.blocks ?? [];

  return (
    <article className="card lib-view">
      {offlineAt && <div className="lib-offline small" role="status"><i className="fa-solid fa-cloud-arrow-down" aria-hidden="true" /> Offline copy from {when(offlineAt)}.</div>}
      {pg.banner && <div className="lib-banner" style={{ backgroundImage: `url("${String(pg.banner).replace(/["\\]/g, '')}")` }} role="img" aria-label="" />}
      <header className="lib-head">
        {crumbs.length > 0 && <div className="tiny faint lib-crumbs">{crumbs.join(' / ')}{parent && <> / <button type="button" className="lib-link-btn inline" onClick={() => onOpen(parent.id)}>{parent.title}</button></>}</div>}
        <h1 className="lib-title">{pg.icon?.glyph && <Icon icon={pg.icon} size={26} />}<span>{pg.title}</span></h1>
        {pg.aliases?.length > 0 && <div className="small muted">Also called {pg.aliases.join(', ')}</div>}
        <div className="row wrap lib-meta">
          {isDM && pg.visibility && <VisChip v={pg.visibility} />}
          {pg.tags?.map((t: string) => <span key={t} className="chip"><i className="fa-solid fa-tag" aria-hidden="true" /> {t}</span>)}
          {pg.updated_at && <span className="tiny faint">Updated {when(pg.updated_at)}</span>}
        </div>
        <div className="row wrap lib-actions">
          <button type="button" className={`btn small${savedAt ? ' on' : ''}`} onClick={() => void toggleSave()} disabled={!!offlineAt} aria-pressed={!!savedAt}>
            <i className={`fa-solid ${savedAt ? 'fa-circle-check' : 'fa-download'}`} aria-hidden="true" /> {savedAt ? 'Saved for offline' : 'Save for offline'}
          </button>
          <button type="button" className="btn small" onClick={() => off.download(off.fileName(pg.title), off.pageMarkdown(pg, offlineAt ?? undefined), 'text/markdown')}><i className="fa-solid fa-file-arrow-down" aria-hidden="true" /> Download .md</button>
          {isDM && pg.url && <a className="btn small" href={pg.url} target="_blank" rel="noreferrer noopener"><i className="fa-solid fa-arrow-up-right-from-square" aria-hidden="true" /> Open in source</a>}
          {editable && !offlineAt && <button type="button" className="btn small" onClick={() => setEditing(true)}><i className="fa-solid fa-pen" aria-hidden="true" /> Edit</button>}
          {isDM && !offlineAt && <button type="button" className="btn small danger" onClick={() => void del()} disabled={act.busy}><i className="fa-solid fa-trash" aria-hidden="true" /> Delete</button>}
          {!isDM && !offlineAt && <>
            <button type="button" className="btn small" onClick={() => setAsk('edit')}><i className="fa-solid fa-pen-to-square" aria-hidden="true" /> Suggest an edit</button>
            <button type="button" className="btn small" onClick={() => setAsk('question')}><i className="fa-solid fa-circle-question" aria-hidden="true" /> Ask about this page</button>
          </>}
        </div>
        {isDM && pg.source && <p className="tiny faint" style={{ margin: '6px 0 0' }}>Synced from {pg.source}; edit it there. Delete removes it here until the next sync brings it back.</p>}
        <ErrorBox error={act.error} />
      </header>
      <div className={`lib-body${facts.length ? ' with-facts' : ''}`}>
        <div className="lib-page">
          {blocks.length ? <Blocks blocks={blocks} ctx={ctx} /> : <p className="muted">This page is empty.</p>}
          {pg.children?.length > 0 && !hasCollection(pg.blocks) && (
            <section className="lib-collection" aria-label="Pages inside">
              <h3 className="lib-h lib-h3">Inside {pg.title}</h3>
              <ul>{pg.children.map((c: any) => <li key={c.id}><button type="button" className="lib-link-btn inline" onClick={() => onOpen(c.id)}>{c.icon?.glyph && <Icon icon={c.icon} size={13} />} {c.title}</button></li>)}</ul>
            </section>
          )}
        </div>
        {facts.length > 0 && <aside className="lib-side-facts" aria-label="Facts"><Facts groups={facts} ctx={ctx} /></aside>}
      </div>
      {ask && <AskModal kind={ask} page={{ id: pg.id, title: pg.title }} onClose={() => setAsk(null)} onSent={() => { setAsk(null); toast('Sent to your DM'); }} />}
    </article>
  );
}

const hasCollection = (bs: any[] = []): boolean => bs.some((b) => b.kind === 'collection' || hasCollection(b.children));

const SHELL_CSS = `
.lib-shell { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 16px; align-items: start; }
.lib-side { min-width: 0; position: sticky; top: 12px; display: flex; flex-direction: column; gap: 10px; }
.lib-main { min-width: 0; }
.lib-back { display: none; margin-bottom: 10px; }
.lib-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lib-filters select { width: auto; max-width: 100%; padding: 4px 8px; font-size: 13px; }
.lib-check { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); }
.lib-hits { display: flex; flex-direction: column; max-height: 34vh; overflow-y: auto; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.lib-flat { display: flex; flex-direction: column; max-height: min(70vh, calc(100vh - 260px)); overflow-y: auto; margin: 0 -8px; }
.lib-flat .list-item { gap: 8px; }
.lib-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.lib-link-btn { border: 0; background: none; padding: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; display: flex; flex-direction: column; min-width: 0; }
.lib-link-btn.inline { display: inline; color: var(--accent-strong); text-decoration: underline dotted; text-underline-offset: 3px; }
.lib-offline { padding: 8px 12px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--teal); color: var(--teal); margin-bottom: 12px; }
.lib-view { padding: 0; overflow: hidden; }
.lib-view > .lib-offline { margin: 12px 18px 0; }
.lib-banner { height: 180px; background-size: cover; background-position: center; border-bottom: 1px solid var(--line); }
.lib-head { padding: 16px 22px 8px; }
.lib-title { display: flex; align-items: center; gap: 12px; margin: 4px 0; font-family: var(--font-head); font-size: 30px; line-height: 1.15; overflow-wrap: anywhere; }
.lib-meta, .lib-actions { gap: 6px; margin-top: 8px; }
.lib-body { padding: 8px 22px 22px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }
.lib-body.with-facts { grid-template-columns: minmax(0, 1fr) minmax(200px, 280px); }
.lib-side-facts { display: flex; flex-direction: column; gap: 12px; }
@media (max-width: 1100px) { .lib-body.with-facts { grid-template-columns: minmax(0, 1fr); } .lib-side-facts { order: -1; } }
@media (max-width: 760px) {
  .lib-shell { grid-template-columns: minmax(0, 1fr); }
  .lib-side { position: static; }
  .lib-shell.has-page .lib-side { display: none; }
  .lib-shell:not(.has-page) .lib-main { display: none; }
  .lib-back { display: inline-flex; }
  .lib-head { padding: 12px 14px 6px; }
  .lib-body { padding: 6px 14px 16px; }
  .lib-title { font-size: 24px; }
  .lib-banner { height: 120px; }
}
`;
