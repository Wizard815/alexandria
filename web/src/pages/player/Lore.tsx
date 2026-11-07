// Lore: the player's view of the synced library. Only pages the DM shares,
// already redacted by the librarian. Suggestions and questions become
// requests the DM answers.
import { useMemo, useState, type MouseEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Markdown, Modal, Field, VisibilityPicker, useAction, useToast } from '../../ui/index.tsx';

interface PageRow { id: string; path: string; title: string; updated_at: string }
interface Page extends PageRow { frontmatter: Record<string, unknown>; body: string }

function folderOf(path: string) {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Pages';
}

export default function PlayerLore() {
  const { w, info } = useWorld();
  const [params, setParams] = useSearchParams();
  const pageId = params.get('page');
  const [q, setQ] = useState('');
  const pages = useLoad(() => w.pages() as Promise<PageRow[]>, [w], ['page']);
  const search = useLoad(() => (q.trim().length > 1 ? w.search(q.trim()) : Promise.resolve(null)), [w, q]);
  const page = useLoad(() => (pageId ? (w.page(pageId) as Promise<Page>) : Promise.resolve(null)), [w, pageId], ['page']);
  const [ask, setAsk] = useState<null | 'edit' | 'question'>(null);
  const { toast, toastNode } = useToast();

  const byFolder = useMemo(() => {
    const m = new Map<string, PageRow[]>();
    for (const p of pages.data ?? []) {
      const f = folderOf(p.path);
      m.set(f, [...(m.get(f) ?? []), p]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pages.data]);

  const open = (id: string | null) => setParams(id ? { page: id } : {});

  return (
    <div className="page">
      <PageHead title="Lore" lead={`What ${info.name}'s library holds for you: only what your DM shares. Suggest changes or ask about anything.`} />
      <ErrorBox error={pages.error} />
      <div className="cols">
        <aside className="col-1 stack" aria-label="Pages">
          <label className="sr-only" htmlFor="lore-q">Search the lore</label>
          <input id="lore-q" type="search" className="input" placeholder="Search the lore…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="card flush" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {q.trim().length > 1 ? (
              search.data?.length ? (
                <div className="list">
                  {search.data.map((r: any) => (
                    <button key={r.id} type="button" className={`list-item${r.id === pageId ? ' active' : ''}`} onClick={() => open(r.id)} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                      <strong>{r.title}</strong>
                      <span className="tiny muted">{String(r.snippet ?? '').replace(/\[|\]/g, '')}</span>
                    </button>
                  ))}
                </div>
              ) : <Empty>{search.loading ? 'Searching…' : 'Nothing found.'}</Empty>
            ) : pages.loading && !pages.data ? <div className="empty"><Loading /></div> : byFolder.length ? (
              <div className="list">
                {byFolder.map(([folder, rows]) => (
                  <div key={folder}>
                    <div className="nav-label">{folder}</div>
                    {rows.map((p) => (
                      <button key={p.id} type="button" className={`list-item${p.id === pageId ? ' active' : ''}`} onClick={() => open(p.id)}>{p.title}</button>
                    ))}
                  </div>
                ))}
              </div>
            ) : <Empty>Your DM hasn't shared any pages yet.</Empty>}
          </div>
        </aside>

        <article className="col-3 card gold" style={{ padding: '20px 24px' }}>
          {!pageId ? (
            <div className="stack">
              <h2>Pick a page</h2>
              <p className="muted">Choose a page on the left, or search. Want something added? <button type="button" className="btn small" onClick={() => setAsk('question')}>Ask the DM</button></p>
            </div>
          ) : page.loading && !page.data ? <Loading what="the page" /> : page.error ? <ErrorBox error={page.error} /> : page.data && (
            <PageView page={page.data} all={pages.data ?? []} onOpen={open} onAsk={setAsk} />
          )}
        </article>
      </div>
      {ask && <AskModal kind={ask} page={page.data && pageId ? page.data : null} onClose={() => setAsk(null)} onSent={() => { setAsk(null); toast('Sent to the DM. You will see the answer under Ask the DM.'); }} />}
      {toastNode}
    </div>
  );
}

function PageView({ page, all, onOpen, onAsk }: { page: Page; all: PageRow[]; onOpen: (id: string) => void; onAsk: (k: 'edit' | 'question') => void }) {
  const navigate = useNavigate();
  const byTitle = useMemo(() => new Map(all.map((p) => [p.title.toLowerCase(), p.id])), [all]);
  // Links to pages you can't see become plain text.
  const text = useMemo(() => page.body.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, t: string, label?: string) =>
    byTitle.has(t.trim().toLowerCase()) ? m : (label ?? t)), [page.body, byTitle]);
  const linkTo = (title: string) => `?page=${encodeURIComponent(byTitle.get(title.toLowerCase()) ?? '')}`;
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const id = new URL(a.href).searchParams.get('page');
    if (id) onOpen(id);
    else navigate('.');
  };
  const facts = Object.entries(page.frontmatter).filter(([k, v]) => !['title', 'aliases', 'kanka_id', 'kanka_type', 'lk_id', 'lk_doc'].includes(k) && v !== null && typeof v !== 'object' || Array.isArray(v) && k === 'tags');
  return (
    <div className="stack">
      <div className="row between">
        <h2 style={{ fontSize: 26 }}>{page.title}</h2>
        <div className="row">
          <button type="button" className="btn small" onClick={() => onAsk('edit')}>Suggest an edit</button>
          <button type="button" className="btn small" onClick={() => onAsk('question')}>Ask about this</button>
        </div>
      </div>
      <span className="tiny faint">{page.path} · updated {when(page.updated_at)}</span>
      {facts.length > 0 && (
        <div className="row small" style={{ gap: 6 }}>
          {facts.map(([k, v]) => <span key={k} className="chip">{k}: {Array.isArray(v) ? v.join(', ') : String(v)}</span>)}
        </div>
      )}
      <div onClick={onClick}><Markdown text={text} linkTo={linkTo} /></div>
    </div>
  );
}

export function AskModal({ kind, page, onClose, onSent }: { kind: 'edit' | 'question' | 'new'; page: Page | null; onClose: () => void; onSent: () => void }) {
  const { w, info } = useWorld();
  const act = useAction();
  const [k, setK] = useState(kind);
  const [title, setTitle] = useState(page ? (kind === 'edit' ? `Edit: ${page.title}` : `About ${page.title}`) : '');
  const [body, setBody] = useState('');
  const [vis, setVis] = useState<'dm' | 'party'>(info.settings.requestDefault);
  const canEdit = !!page;
  const submit = () => act.run(async () => {
    await w.request({ kind: k === 'edit' && !canEdit ? 'question' : k, title: title.trim(), body: body.trim(), pageId: k === 'edit' && page ? page.id : undefined, visibility: vis });
    onSent();
  });
  return (
    <Modal title={k === 'edit' ? 'Suggest an edit' : k === 'new' ? 'Suggest a new page' : 'Ask the DM'} onClose={onClose}>
      <div className="tabs" role="radiogroup" aria-label="Kind">
        {(canEdit ? (['edit', 'question'] as const) : (['question', 'new'] as const)).map((x) => (
          <button key={x} type="button" role="radio" aria-checked={k === x} className={`btn small${k === x ? ' on' : ''}`} onClick={() => setK(x)}>
            {x === 'edit' ? 'Suggest an edit' : x === 'new' ? 'New page' : 'Question'}
          </button>
        ))}
      </div>
      <Field label="Title"><input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label={k === 'edit' ? 'What should change' : k === 'new' ? 'What the page should say' : 'Your question'}>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="stack tight">
        <span className="small" style={{ fontWeight: 500 }}>Who can see this request</span>
        <VisibilityPicker value={vis} onChange={setVis} options={['dm', 'party']} labels={{ dm: 'Only the DM', party: 'The party can see it too' }} />
      </div>
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !title.trim() || !body.trim()} onClick={() => void submit()}>Send</button>
      </div>
    </Modal>
  );
}
