// Biblio: the world library Alexandria hosts itself. The GM writes and
// arranges articles here (at /biblio, which opens the GM's world); players read
// the articles they may see, follow links, look at the timeline and suggest
// changes. Every article is also a library page, so search, the assistants and
// sharing work on it like on any imported page.
import '@fortawesome/fontawesome-free/css/all.min.css';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { Blocks, Facts, Icon, LIB_CSS, type RenderCtx } from '../../pages/library/Blocks.tsx';
import { safeImageUrl } from '../../pages/library/links.ts';
import { Editor, type Draft } from './Editor.tsx';
import { History, MoveInOut, Suggestions, Templates, Timeline, Trash } from './Panels.tsx';
import { BIBLIO_CSS } from './style.ts';
import { LEVEL_SHORT, type ArticleView, type Overview, type TreeItem } from './types.ts';

type Tab = 'articles' | 'timeline' | 'suggestions' | 'templates' | 'move' | 'trash';
const enc = encodeURIComponent;

export default function BiblioPage() {
  const { w, isGM, nameOf, readOnly } = useWorld();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const ov = useLoad<Overview>(() => w.call('GET', '/biblio'), [w], ['biblio', 'page']);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  // On a phone the list folds away while an article is open.
  const [showTree, setShowTree] = useState(false);
  const { toast, toastNode } = useToast();
  const tab = (params.get('tab') as Tab) || 'articles';
  const current = params.get('a');
  const editing = params.get('edit');
  const gm = !!ov.data?.gm && !readOnly;

  const set = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v === null) next.delete(k); else next.set(k, v);
    setParams(next);
  }, [params, setParams]);
  const open = useCallback((id: string) => { setShowTree(false); set({ a: id, edit: null, tab: null, title: null, parent: null }); }, [set]);

  // Search: titles at once, the text on the server after a short pause.
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => { void w.call<any[]>('GET', '/biblio/search', undefined, { q: q.trim() }).then(setHits).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q, w]);

  const tree = ov.data?.articles ?? [];
  const tabs: [Tab, string][] = [['articles', 'Articles'], ['timeline', 'Timeline'], ['suggestions', gm ? 'Suggestions' : 'Suggest']];
  if (gm) tabs.push(['templates', 'Templates'], ['move', 'Move in & out'], ['trash', `Trash${ov.data?.trash ? ` (${ov.data.trash})` : ''}`]);

  return (
    <div className="page bib">
      <style>{LIB_CSS + BIBLIO_CSS}</style>
      <PageHead title={<><i className="fa-solid fa-book-atlas" aria-hidden="true" /> Biblio</>} lead={gm ? 'Your world’s own library, kept in Alexandria. Players read what you share; the assistants read and write here too.' : 'The world’s library: what your GM has shared.'}>
        {gm && <button type="button" className="btn primary small" onClick={() => set({ edit: 'new', a: null, tab: null })}><i className="fa-solid fa-plus" aria-hidden="true" /> New article</button>}
      </PageHead>
      <Tabs label="Biblio" value={tab} onChange={(t) => set({ tab: t === 'articles' ? null : t, edit: null })} items={tabs} />
      <ErrorBox error={ov.error} />
      {toastNode}
      {ov.loading && !ov.data ? <Loading what="Biblio" /> : (
        <div className={`bib-shell${current && !showTree ? ' bib-folded' : ''}`}>
          <aside className="bib-side" aria-label="Articles">
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an article" aria-label="Find an article" />
            {current && <button type="button" className="btn small bib-treebtn" aria-expanded={showTree} onClick={() => setShowTree((x) => !x)}><i className="fa-solid fa-list" aria-hidden="true" /> {showTree ? 'Hide the list' : `All articles (${tree.length})`}</button>}
            {hits ? <SearchHits hits={hits} q={q} open={(id) => { open(id); setQ(''); }} tree={tree} />
              : <TreeView tree={tree} current={current} open={open} />}
            {!tree.length && <p className="small muted">{gm ? 'Nothing here yet. Write the first article, or copy pages in from another source under Move in & out.' : 'Your GM has not shared any articles yet.'}</p>}
          </aside>
          <main className="bib-main">
            {tab === 'timeline' && <Timeline open={open} />}
            {tab === 'suggestions' && <Suggestions gm={gm} tree={tree} open={open} nameOf={nameOf} />}
            {tab === 'templates' && gm && <Templates templates={ov.data!.templates} onChanged={() => void ov.reload()} />}
            {tab === 'move' && gm && <MoveInOut onChanged={() => void ov.reload()} open={open} />}
            {tab === 'trash' && gm && <Trash onChanged={() => void ov.reload()} />}
            {tab === 'articles' && (editing === 'new' && gm
              ? <Editor draft={{ title: params.get('title') ?? '', parentId: params.get('parent'), template: params.get('template') ?? undefined } as Draft} templates={ov.data!.templates} tree={tree}
                onSaved={(id) => { void ov.reload(); toast('Saved'); open(id); }} onCancel={() => set({ edit: null })} />
              : current ? <ArticlePane key={current} id={current} gm={gm} isGM={isGM} tree={tree} templates={ov.data!.templates} editing={editing === '1'}
                setEditing={(on) => set({ edit: on ? '1' : null })} open={open} openPage={(pid) => nav(`../library?page=${enc(pid)}`)}
                newChild={(title, parent) => set({ edit: 'new', a: null, title, parent: parent ?? null })} onChanged={() => void ov.reload()} toast={toast} />
                : <Home tree={tree} open={open} gm={gm} />)}
          </main>
        </div>
      )}
    </div>
  );
}

function TreeView({ tree, current, open }: { tree: TreeItem[]; current: string | null; open: (id: string) => void }) {
  const kids = useMemo(() => {
    const m = new Map<string | null, TreeItem[]>();
    const ids = new Set(tree.map((a) => a.id));
    for (const a of tree) { const k = a.parentId && ids.has(a.parentId) ? a.parentId : null; m.set(k, [...(m.get(k) ?? []), a]); }
    for (const l of m.values()) l.sort((x, y) => (x.position ?? 1e9) - (y.position ?? 1e9) || x.title.localeCompare(y.title));
    return m;
  }, [tree]);
  // Open the branches above the current article.
  const [shut, setShut] = useState<Set<string>>(new Set());
  const row = (a: TreeItem, depth: number): ReactNode => {
    const sub = kids.get(a.id) ?? [];
    const closed = shut.has(a.id);
    return (
      <li key={a.id}>
        <div className={`bib-row${current === a.id ? ' on' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}>
          {sub.length ? <button type="button" className="bib-twist" aria-label={closed ? `Open ${a.title}` : `Fold ${a.title}`} aria-expanded={!closed} onClick={() => setShut((s) => { const n = new Set(s); if (closed) n.delete(a.id); else n.add(a.id); return n; })}><i className={`fa-solid ${closed ? 'fa-caret-right' : 'fa-caret-down'}`} aria-hidden="true" /></button> : <span className="bib-twist" />}
          <button type="button" className="bib-open" onClick={() => open(a.id)} aria-current={current === a.id || undefined}>
            <Icon icon={{ glyph: a.icon ?? undefined }} size={13} /> <span>{a.title}</span>
            {a.level && a.level !== 'party' && <span className={`bib-lv bib-lv-${a.level}`} title={LEVEL_SHORT[a.level]}>{LEVEL_SHORT[a.level]}</span>}
          </button>
        </div>
        {sub.length > 0 && !closed && <ul>{sub.map((k) => row(k, depth + 1))}</ul>}
      </li>
    );
  };
  return <ul className="bib-tree">{(kids.get(null) ?? []).map((a) => row(a, 0))}</ul>;
}

function SearchHits({ hits, q, open, tree }: { hits: any[]; q: string; open: (id: string) => void; tree: TreeItem[] }) {
  const titleHits = tree.filter((a) => a.title.toLowerCase().includes(q.trim().toLowerCase()));
  const seen = new Set(titleHits.map((a) => a.id));
  const textHits = hits.filter((h) => !seen.has(h.articleId));
  if (!titleHits.length && !textHits.length) return <p className="small muted">Nothing found.</p>;
  return (
    <ul className="bib-plain bib-hits">
      {titleHits.map((a) => <li key={a.id}><button type="button" className="lib-link-btn" onClick={() => open(a.id)}>{a.title}</button></li>)}
      {textHits.map((h) => <li key={h.articleId}><button type="button" className="lib-link-btn" onClick={() => open(h.articleId)}>{h.title}</button>{h.snippet && <div className="tiny muted">{String(h.snippet).replace(/<[^>]+>/g, '')}</div>}</li>)}
    </ul>
  );
}

function Home({ tree, open, gm }: { tree: TreeItem[]; open: (id: string) => void; gm: boolean }) {
  const recent = [...tree].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 8);
  const byTpl = new Map<string, number>();
  for (const a of tree) byTpl.set(a.template, (byTpl.get(a.template) ?? 0) + 1);
  if (!tree.length) return <Empty>{gm ? 'Biblio is empty. Press New article, or bring a world over from LegendKeeper, Kanka or World Anvil under Move in & out.' : 'Nothing to read yet.'}</Empty>;
  return (
    <div className="stack">
      <div className="card">
        <h3>Recently changed</h3>
        <ul className="bib-plain">{recent.map((a) => <li key={a.id}><button type="button" className="lib-link-btn" onClick={() => open(a.id)}>{a.title}</button> <span className="tiny muted">{when(a.updatedAt)}</span>{a.summary && <div className="tiny muted">{a.summary}</div>}</li>)}</ul>
      </div>
      <div className="row wrap">{[...byTpl.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => <span key={t} className="chip">{t} · {n}</span>)}</div>
    </div>
  );
}

function ArticlePane({ id, gm, isGM, tree, templates, editing, setEditing, open, openPage, newChild, onChanged, toast }: {
  id: string; gm: boolean; isGM: boolean; tree: TreeItem[]; templates: Overview['templates']; editing: boolean; setEditing: (on: boolean) => void;
  open: (id: string) => void; openPage: (pageId: string) => void; newChild: (title: string, parent?: string) => void; onChanged: () => void; toast: (m: string) => void;
}) {
  const { w, nameOf } = useWorld();
  const v = useLoad<ArticleView>(() => w.call('GET', `/biblio/articles/${enc(id)}`), [w, id], ['biblio']);
  const act = useAction();
  const [history, setHistory] = useState(false);
  const [suggest, setSuggest] = useState(false);
  const byPage = useMemo(() => new Map(tree.filter((a) => a.pageId).map((a) => [a.pageId!, a.id])), [tree]);

  if (v.loading && !v.data) return <Loading what="the article" />;
  if (v.error) return <ErrorBox error={v.error} />;
  const a = v.data!;
  const pg = a.page;
  if (editing && gm && a.article) {
    return <Editor initial={a.article} templates={templates} tree={tree} onSaved={() => { setEditing(false); void v.reload(); onChanged(); toast('Saved'); }} onCancel={() => setEditing(false)} />;
  }
  const ctx: RenderCtx = { links: pg.links ?? {}, titles: pg.linkTitles ?? {}, isGM, children: [], open: (pid) => { const art = byPage.get(pid); if (art) open(art); else openPage(pid); } };
  // Red links: [[names]] in the text that no article or page answers to. The GM can make each one.
  const missing = gm && a.article ? [...new Set([...a.article.body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim()))].filter((n) => !pg.links?.[`name:${n.toLowerCase()}`]) : [];
  const trash = () => act.run(async () => {
    if (!window.confirm(`Move “${a.title}”${a.children.length ? ' and everything under it' : ''} to the trash?`)) return;
    await w.call('DELETE', `/biblio/articles/${enc(a.id)}`);
    onChanged();
    toast('Moved to the trash');
    open(a.parent?.id ?? '');
  });
  const crumbs: { id: string; title: string }[] = [];
  for (let p = tree.find((x) => x.id === a.id)?.parentId, i = 0; p && i < 20; i++) { const t = tree.find((x) => x.id === p); if (!t) break; crumbs.unshift({ id: t.id, title: t.title }); p = t.parentId; }

  return (
    <article className="card lib-view bib-article">
      {safeImageUrl(pg.banner) && <div className="lib-banner" style={{ backgroundImage: `url("${safeImageUrl(pg.banner)}")` }} role="img" aria-label="" />}
      <header className="lib-head">
        {crumbs.length > 0 && <div className="tiny faint lib-crumbs">{crumbs.map((c, i) => <span key={c.id}>{i > 0 && ' / '}<button type="button" className="lib-link-btn inline" onClick={() => open(c.id)}>{c.title}</button></span>)}</div>}
        <h1 className="lib-title">{pg.icon?.glyph && <Icon icon={pg.icon} size={26} />}<span>{pg.title}</span></h1>
        {pg.aliases?.length > 0 && <div className="small muted">Also called {pg.aliases.join(', ')}</div>}
        <div className="row wrap lib-meta">
          <span className="chip"><i className={`fa-solid ${a.template.icon}`} aria-hidden="true" /> {a.template.name}</span>
          {gm && a.article && <span className={`chip bib-lv-${a.article.level}`}>{LEVEL_SHORT[a.article.level]}</span>}
          {pg.tags?.map((t: string) => <span key={t} className="chip"><i className="fa-solid fa-tag" aria-hidden="true" /> {t}</span>)}
          <span className="tiny faint">Updated {when(a.updatedAt)}{gm && a.article ? ` · version ${a.article.rev}` : ''}</span>
        </div>
        <div className="row wrap lib-actions">
          {gm && <button type="button" className="btn small primary" onClick={() => setEditing(true)}><i className="fa-solid fa-pen" aria-hidden="true" /> Edit</button>}
          {gm && <button type="button" className="btn small" onClick={() => newChild('', a.id)}><i className="fa-solid fa-plus" aria-hidden="true" /> Article inside</button>}
          {gm && a.article && <button type="button" className="btn small" onClick={() => setHistory(true)}><i className="fa-solid fa-clock-rotate-left" aria-hidden="true" /> History</button>}
          {!gm && !isGM && <button type="button" className="btn small" onClick={() => setSuggest(true)}><i className="fa-solid fa-pen-to-square" aria-hidden="true" /> Suggest an edit</button>}
          <button type="button" className="btn small" onClick={() => openPage(a.pageId)}><i className="fa-solid fa-book" aria-hidden="true" /> In the library</button>
          {gm && <button type="button" className="btn small" onClick={() => void trash()} disabled={act.busy}><i className="fa-solid fa-trash" aria-hidden="true" /> Trash</button>}
        </div>
        <ErrorBox error={act.error} />
      </header>
      <div className={`lib-body${pg.properties?.length ? ' with-facts' : ''}`}>
        <div className="lib-page">
          {pg.blocks?.length ? <Blocks blocks={pg.blocks} ctx={ctx} /> : <p className="muted">Nothing written yet.</p>}
          {missing.length > 0 && (
            <div className="note small bib-red">Not written yet: {missing.map((n, i) => <span key={n}>{i > 0 && ', '}<button type="button" className="lib-link-btn inline" onClick={() => newChild(n)}>{n}</button></span>)}</div>
          )}
          {a.children.length > 0 && (
            <section className="bib-section"><h3>Inside {pg.title}</h3>
              <ul className="bib-cards">{a.children.map((c) => <li key={c.id}><button type="button" className="bib-card" onClick={() => open(c.id)}><Icon icon={{ glyph: c.icon ?? undefined }} size={15} /> {c.title}</button></li>)}</ul>
            </section>
          )}
          {a.backlinks.length > 0 && (
            <section className="bib-section"><h3>Mentioned in</h3>
              <ul className="bib-plain">{a.backlinks.map((b) => <li key={b.id}><button type="button" className="lib-link-btn" onClick={() => (b.articleId ? open(b.articleId) : openPage(b.id))}>{b.title}</button>{!b.articleId && <span className="tiny muted"> (library)</span>}</li>)}</ul>
            </section>
          )}
        </div>
        {pg.properties?.length > 0 && <aside className="lib-side-facts" aria-label="Facts"><Facts groups={pg.properties} ctx={ctx} /></aside>}
      </div>
      {history && a.article && <History article={a.article} nameOf={nameOf} onClose={() => setHistory(false)} onRestored={() => { setHistory(false); void v.reload(); onChanged(); toast('Brought back'); }} />}
      {suggest && <SuggestEdit articleId={a.id} title={a.title} onClose={() => setSuggest(false)} onSent={() => { setSuggest(false); toast('Sent to your GM'); }} />}
    </article>
  );
}

function SuggestEdit({ articleId, title, onClose, onSent }: { articleId: string; title: string; onClose: () => void; onSent: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [text, setText] = useState('');
  const send = () => act.run(async () => { await w.call('POST', '/biblio/suggestions', { articleId, body: text }); onSent(); });
  return (
    <Modal title={`Suggest an edit to ${title}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Field label="What should change or be added" help="Your GM reads it and decides. Nothing changes until they accept it."><textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} required /></Field>
        <ErrorBox error={act.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={act.busy || !text.trim()}>Send</button></div>
      </form>
    </Modal>
  );
}
