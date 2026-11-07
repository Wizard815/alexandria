// The DM's library: every page, search, view, edit, and the leak check.
import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHead, ErrorBox, Empty, Loading, Markdown, VisChip, VisibilityPicker, Tabs, Field, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';

type PageRow = { id: string; path: string; title: string; visibility: string; updated_at: string };

export default function DMLibrary() {
  const { w, info } = useWorld();
  const [params, setParams] = useSearchParams();
  const pages = useLoad<PageRow[]>(() => w.pages(), [w], ['page']);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'party' | 'dm'>('all');
  const [side, setSide] = useState<'pages' | 'lint'>('pages');
  const lint = useLoad<any[]>(() => w.call('GET', '/library/lint'), [w], ['page']);
  const { toast, toastNode } = useToast();

  // ?title=Name (from a wiki link) opens that page, or offers to make it.
  const titleParam = params.get('title');
  useEffect(() => {
    if (!titleParam || !pages.data) return;
    const hit = pages.data.find((p) => p.title.toLowerCase() === titleParam.toLowerCase());
    setParams(hit ? { page: hit.id } : { new: titleParam }, { replace: true });
  }, [titleParam, pages.data, setParams]);

  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const t = setTimeout(() => { w.search(q).then(setHits).catch(() => setHits([])); }, 250);
    return () => clearTimeout(t);
  }, [q, w]);

  const selected = params.get('page');
  const creating = params.get('new');
  const list = useMemo(() => (pages.data ?? []).filter((p) => filter === 'all' || p.visibility === filter), [pages.data, filter]);
  const counts = useMemo(() => ({ party: (pages.data ?? []).filter((p) => p.visibility === 'party').length, all: pages.data?.length ?? 0 }), [pages.data]);
  const open = (id: string) => setParams({ page: id });

  return (
    <div className="page wide">
      <PageHead title="Library" lead={`Every page in ${info.name}. Players only ever get the player copy of shared pages, made when you save.`}>
        <button type="button" className="btn primary" onClick={() => setParams({ new: '' })}>＋ New page</button>
      </PageHead>
      <ErrorBox error={pages.error} />
      <div className="cols">
        <aside className="col-1 card" style={{ maxWidth: 420 }}>
          <Tabs label="Library side panel" value={side} onChange={setSide} items={[['pages', `Pages (${counts.all})`], ['lint', `Leak check${lint.data?.length ? ` (${lint.data.length})` : ''}`]]} />
          {side === 'pages' ? (
            <>
              <label className="field"><span className="sr-only">Search the library</span><input type="search" placeholder="Search pages and text…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
              {!hits && (
                <div className="tabs" role="radiogroup" aria-label="Show">
                  {([['all', 'All'], ['party', `Shared (${counts.party})`], ['dm', 'DM only']] as const).map(([k, label]) => (
                    <button key={k} type="button" role="radio" aria-checked={filter === k} className={`btn small${filter === k ? ' on' : ''}`} onClick={() => setFilter(k)}>{label}</button>
                  ))}
                </div>
              )}
              {pages.loading && <Loading what="pages" />}
              <div className="list" style={{ maxHeight: '62vh', overflowY: 'auto', margin: '0 -18px' }}>
                {hits ? (
                  hits.length ? hits.map((h) => (
                    <button key={h.id} type="button" className={`list-item${selected === h.id ? ' active' : ''}`} onClick={() => open(h.id)}>
                      <span className="stack tight grow"><strong>{h.title}</strong><span className="tiny muted">{h.snippet}</span></span>
                    </button>
                  )) : <Empty>No matches.</Empty>
                ) : list.length ? list.map((p) => (
                  <button key={p.id} type="button" className={`list-item${selected === p.id ? ' active' : ''}`} onClick={() => open(p.id)}>
                    <span className="stack tight grow" style={{ minWidth: 0 }}><strong>{p.title}</strong><span className="tiny faint" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</span></span>
                    <VisChip v={p.visibility} />
                  </button>
                )) : !pages.loading && <Empty>No pages yet. Add one, or sync a source in Library admin.</Empty>}
              </div>
            </>
          ) : (
            <LintPanel rows={lint.data} error={lint.error} onOpen={open} />
          )}
        </aside>
        <section className="col-3" style={{ minWidth: 0 }}>
          {creating !== null ? (
            <Editor key="new" initial={{ path: creating ? `${creating}` : '', title: creating ?? '', body: '', visibility: 'dm', frontmatter: {} }} isNew
              onSaved={(p) => { toast(`Saved ${p.title}`); setParams({ page: p.id }); }} onCancel={() => setParams({})} />
          ) : selected ? (
            <PageView key={selected} id={selected} onDeleted={() => { toast('Page deleted'); setParams({}); }} onSaved={(t) => toast(`Saved ${t}`)} />
          ) : (
            <div className="card"><Empty>Pick a page on the left, or make a new one.</Empty><SecretHint /></div>
          )}
        </section>
      </div>
      {toastNode}
    </div>
  );
}

function LintPanel({ rows, error, onOpen }: { rows: any[] | null; error: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="stack">
      <p className="small muted">Shared pages that still read like DM notes ("The secret:", "DM note:", "GM only"). The leak guard can't tell plain prose is secret: hide the page or move the text into a secret block.</p>
      <ErrorBox error={error} />
      {rows === null ? <Loading /> : rows.length ? (
        <div className="list" style={{ margin: '0 -18px' }}>
          {rows.map((r) => (
            <button key={r.id} type="button" className="list-item" onClick={() => onOpen(r.id)}>
              <span className="stack tight grow"><strong>{r.title}</strong><span className="tiny muted">{r.hints.join(', ')}</span></span>
              <span className="chip red">Check</span>
            </button>
          ))}
        </div>
      ) : <div className="ok-box small">Nothing flagged. Shared pages don't read like DM notes.</div>}
    </div>
  );
}

function SecretHint() {
  return (
    <details className="note small">
      <summary>How to keep parts of a shared page secret</summary>
      <div className="stack tight" style={{ marginTop: 8 }}>
        <span><code className="mono">{'> [!secret]'}</code> callouts (also <code className="mono">[!dm]</code>, <code className="mono">[!gm]</code>) are removed, with every <code className="mono">&gt;</code> line under them.</span>
        <span><code className="mono">%% comment %%</code> and <code className="mono">{'<!-- dm --> … <!-- /dm -->'}</code> are removed.</span>
        <span>A heading marked <code className="mono">(DM)</code>, <code className="mono">[DM]</code> or "DM only", or titled Secrets / DM notes, is removed with everything under it.</span>
        <span>Frontmatter under <code className="mono">secret:</code>, and keys like <code className="mono">dm_notes</code>, never reach players.</span>
        <span>Pages are DM-only unless set to Party.</span>
      </div>
    </details>
  );
}

function PageView({ id, onDeleted, onSaved }: { id: string; onDeleted: () => void; onSaved: (title: string) => void }) {
  const { w, info } = useWorld();
  const page = useLoad<any>(() => w.page(id), [w, id], ['page']);
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const navigate = useNavigate();
  const linkTo = useMemo(() => (t: string) => `/w/${info.slug}/dm/library?title=${encodeURIComponent(t)}`, [info.slug]);
  // Wiki links are plain <a> in rendered Markdown; route them in-app.
  const onBodyClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
    if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(a.getAttribute('href')!); }
  };

  if (page.error) return <ErrorBox error={page.error} />;
  if (!page.data) return <Loading what="page" />;
  const p = page.data;
  if (editing) return <Editor initial={p} onSaved={(s) => { setEditing(false); onSaved(s.title); void page.reload(); }} onCancel={() => setEditing(false)} />;

  const fmKeys = Object.keys(p.frontmatter ?? {});
  return (
    <article className="card gold">
      <div className="card-head">
        <div className="stack tight"><h2 style={{ fontSize: 24 }}>{p.title}</h2><span className="tiny faint mono">{p.path} · updated {when(p.updated_at)}</span></div>
        <div className="row">
          <VisChip v={p.visibility} />
          <button type="button" className="btn small" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="btn small danger" disabled={act.busy} onClick={() => { if (confirm(`Delete “${p.title}”? This can't be undone.`)) void act.run(async () => { await w.deletePage(p.id); onDeleted(); }); }}>Delete</button>
        </div>
      </div>
      <ErrorBox error={act.error} />
      {fmKeys.length > 0 && (
        <details className="small"><summary className="muted">Frontmatter ({fmKeys.join(', ')})</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{JSON.stringify(p.frontmatter, null, 2)}</pre></details>
      )}
      {p.body.trim() ? <div onClick={onBodyClick}><Markdown text={p.body} linkTo={linkTo} /></div> : <Empty>This page is empty.</Empty>}
      {p.visibility === 'party' && <SecretHint />}
    </article>
  );
}

function Editor({ initial, isNew, onSaved, onCancel }: { initial: any; isNew?: boolean; onSaved: (p: { id: string; title: string }) => void; onCancel: () => void }) {
  const { w } = useWorld();
  const [path, setPath] = useState<string>(initial.path ?? '');
  const [title, setTitle] = useState<string>(initial.title ?? '');
  const [body, setBody] = useState<string>(initial.body ?? '');
  const [vis, setVis] = useState<string>(initial.visibility ?? 'dm');
  const [fm, setFm] = useState<string>(JSON.stringify(initial.frontmatter ?? {}, null, 2));
  const act = useAction();

  const save = () => act.run(async () => {
    let frontmatter: Record<string, unknown>;
    try { frontmatter = JSON.parse(fm || '{}'); } catch { throw new Error('Frontmatter must be valid JSON'); }
    const p = path.trim() || title.trim();
    if (!p) throw new Error('Give the page a title or path');
    const saved: any = await w.savePage({ path: p, title: title.trim() || undefined, body, frontmatter, visibility: vis as 'dm' | 'party' });
    onSaved(saved);
  });

  return (
    <form className="card gold" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{isNew ? 'New page' : `Edit ${initial.title}`}</h2>
      <div className="grid">
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Old Kesh" /></Field>
        <Field label="Path" help={isNew ? 'Folder/name. Leave empty to use the title.' : 'Changing the path makes a new page.'}><input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="places/Old Kesh" /></Field>
      </div>
      <div className="row"><span className="small muted">Who can read it</span><VisibilityPicker value={vis} onChange={setVis} labels={{ dm: 'DM only', party: 'Shared with the party' }} /></div>
      <Field label="Page (Markdown)" help="Use [[Page name]] to link. Secret blocks are removed from the player copy.">
        <textarea className="code" rows={18} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <details><summary className="small muted">Frontmatter (JSON): relations, tags, secret:</summary>
        <Field label="Frontmatter" help='e.g. {"parents": ["[[Old Lord Varn]]"], "secret": {"lovers": ["[[Brother Tamsin]]"]}}'><textarea className="code" rows={6} value={fm} onChange={(e) => setFm(e.target.value)} /></Field>
      </details>
      <ErrorBox error={act.error} />
      <div className="row end"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button type="submit" className="btn primary" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save page'}</button></div>
    </form>
  );
}
