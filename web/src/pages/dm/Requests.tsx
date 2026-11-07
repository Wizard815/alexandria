// Change requests and questions from players. Accept (optionally applying
// the change to the library) or turn them down, with a reply.
import { useState } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Markdown, VisChip, VisibilityPicker, Tabs, Field, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';

const KIND: Record<string, string> = { edit: 'Edit to a page', new: 'New page', question: 'Question' };

export default function DMRequests() {
  const { w, nameOf } = useWorld();
  const all = useLoad<any[]>(() => w.requests(), [w], ['request']);
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [sel, setSel] = useState<string | null>(null);
  const rows = (all.data ?? []).filter((r) => (tab === 'open' ? r.status === 'open' : r.status !== 'open'));
  const cur = (all.data ?? []).find((r) => r.id === sel) ?? rows[0];

  return (
    <div className="page wide">
      <PageHead title="Requests" lead="What players asked for or asked about. Accepting an edit can apply it to the page for you." />
      <ErrorBox error={all.error} />
      <div className="cols">
        <aside className="col-1 card flush" style={{ maxWidth: 420 }}>
          <div style={{ padding: '12px 14px 0' }}>
            <Tabs label="Requests" value={tab} onChange={(t) => { setTab(t); setSel(null); }} items={[['open', `Open (${(all.data ?? []).filter((r) => r.status === 'open').length})`], ['done', 'Decided']]} />
          </div>
          <div className="list" style={{ marginTop: 8 }}>
            {all.loading ? <div style={{ padding: 14 }}><Loading /></div> : rows.length ? rows.map((r) => (
              <button key={r.id} type="button" className={`list-item${cur?.id === r.id ? ' active' : ''}`} onClick={() => setSel(r.id)}>
                <span className="stack tight grow" style={{ minWidth: 0 }}>
                  <strong>{r.title}</strong>
                  <span className="tiny muted">{KIND[r.kind]} · {nameOf(r.author_id)} · {when(r.created_at)}</span>
                </span>
                {r.status === 'open' ? <VisChip v={r.visibility} /> : <span className={`chip ${r.status === 'accepted' ? 'green' : 'red'}`}>{r.status}</span>}
              </button>
            )) : <Empty>{tab === 'open' ? 'Nothing waiting. Nice.' : 'Nothing decided yet.'}</Empty>}
          </div>
        </aside>
        <section className="col-3">{cur ? <Detail key={cur.id} r={cur} onDone={() => void all.reload()} /> : <div className="card"><Empty>Pick a request.</Empty></div>}</section>
      </div>
    </div>
  );
}

function Detail({ r, onDone }: { r: any; onDone: () => void }) {
  const { w, nameOf } = useWorld();
  const page = useLoad<any>(() => (r.page_id ? w.page(r.page_id) : Promise.resolve(null)), [w, r.page_id]);
  const [reply, setReply] = useState('');
  const [mode, setMode] = useState<'none' | 'append' | 'replace' | 'create'>(r.kind === 'new' ? 'create' : r.kind === 'edit' ? 'append' : 'none');
  const [text, setText] = useState<string>(r.body);
  const [path, setPath] = useState<string>(r.title);
  const [vis, setVis] = useState<'dm' | 'party'>('dm');
  const act = useAction();

  const decide = (decision: 'accepted' | 'rejected') => act.run(async () => {
    const apply = decision === 'accepted' && mode !== 'none' ? { mode, body: text, ...(mode === 'create' ? { path, visibility: vis } : {}) } : undefined;
    await w.decide(r.id, decision, { reply: reply.trim() || undefined, apply });
    onDone();
  });

  return (
    <article className="card gold">
      <div className="card-head">
        <div className="stack tight"><h2>{r.title}</h2><span className="small muted">{KIND[r.kind]} from {nameOf(r.author_id)} · {when(r.created_at)}</span></div>
        <span className="row"><VisChip v={r.visibility} />{r.visibility === 'party' && <span className="tiny muted">the party can see this request</span>}</span>
      </div>
      <div className="note" style={{ color: 'var(--text)' }}><Markdown text={r.body} /></div>

      {r.status !== 'open' ? (
        <div className={r.status === 'accepted' ? 'ok-box' : 'error-box'}>{r.status === 'accepted' ? 'Accepted' : 'Turned down'} {when(r.decided_at)}{r.reply ? ` · “${r.reply}”` : ''}</div>
      ) : (
        <>
          {r.page_id && (
            <details>
              <summary className="small muted">Current page: {page.data?.title ?? '…'}</summary>
              {page.error ? <ErrorBox error={page.error} /> : page.data && <div className="note" style={{ maxHeight: 300, overflowY: 'auto', color: 'var(--text)' }}><Markdown text={page.data.body} /></div>}
            </details>
          )}
          {r.kind !== 'question' && (
            <div className="stack">
              <span className="small muted">When accepting:</span>
              <div className="tabs" role="radiogroup" aria-label="Apply">
                {(r.kind === 'edit' ? [['append', 'Add to the end of the page'], ['replace', 'Replace the page text'], ['none', 'Just accept']] : [['create', 'Create the page'], ['none', 'Just accept']]).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={mode === k} className={`btn small${mode === k ? ' on' : ''}`} onClick={() => setMode(k as any)}>{label}</button>
                ))}
              </div>
              {mode !== 'none' && (
                <>
                  {mode === 'create' && (
                    <div className="row top">
                      <Field label="Path"><input className="mono" value={path} onChange={(e) => setPath(e.target.value)} /></Field>
                      <div className="stack tight"><span className="small muted">Who can read it</span><VisibilityPicker value={vis} onChange={setVis} /></div>
                    </div>
                  )}
                  <Field label="Text to apply" help="Edit before applying if you like. Secret blocks still apply."><textarea className="code" rows={8} value={text} onChange={(e) => setText(e.target.value)} /></Field>
                </>
              )}
            </div>
          )}
          <Field label={`Reply to ${nameOf(r.author_id)}`}><textarea rows={3} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={r.kind === 'question' ? 'Your answer' : 'Optional'} /></Field>
          <ErrorBox error={act.error} />
          <div className="row end">
            <button type="button" className="btn danger" disabled={act.busy} onClick={() => void decide('rejected')}>Turn down</button>
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void decide('accepted')}>{r.kind === 'question' ? 'Answer' : mode === 'none' ? 'Accept' : 'Accept and apply'}</button>
          </div>
        </>
      )}
    </article>
  );
}
