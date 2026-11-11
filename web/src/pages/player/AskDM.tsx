// Ask the DM: my questions and suggestions, plus ones the party shared,
// with the DM's answers.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { PageHead, Loading, ErrorBox, Empty, Tabs, VisChip, useToast } from '../../ui/index.tsx';
import { AskModal } from '../library/AskModal.tsx';

interface Req { id: string; author_id: string; kind: 'edit' | 'new' | 'question'; title: string; body: string; visibility: 'dm' | 'party'; status: 'open' | 'accepted' | 'rejected'; reply: string | null; created_at: string; decided_at: string | null }

const KIND = { edit: 'Edit', new: 'New page', question: 'Question' };
const STATUS = { open: ['Waiting', 'gold'], accepted: ['Accepted', 'green'], rejected: ['Declined', 'red'] } as const;

export default function PlayerAskDM() {
  const { w, me, nameOf } = useWorld();
  const reqs = useLoad(() => w.requests() as Promise<Req[]>, [w], ['request']);
  const [tab, setTab] = useState<'mine' | 'party'>('mine');
  const [ask, setAsk] = useState<null | 'question' | 'new'>(null);
  const { toast, toastNode } = useToast();
  const rows = (reqs.data ?? []).filter((r) => (tab === 'mine' ? r.author_id === me : r.author_id !== me));

  return (
    <div className="page">
      <PageHead title="Ask the DM" lead="Questions, suggested changes and new pages. Choose whether only the DM or the whole party can see each one.">
        <button type="button" className="btn" onClick={() => setAsk('new')}>Suggest a page</button>
        <button type="button" className="btn primary" onClick={() => setAsk('question')}>Ask a question</button>
      </PageHead>
      <Tabs label="Whose" value={tab} onChange={setTab} items={[['mine', 'Mine'], ['party', 'Shared by the party']]} />
      <ErrorBox error={reqs.error} />
      {reqs.loading && !reqs.data ? <Loading /> : rows.length ? (
        <div className="stack">
          {rows.map((r) => (
            <article key={r.id} className="card">
              <div className="card-head">
                <h3>{r.title}</h3>
                <span className="row" style={{ gap: 6 }}>
                  <span className="chip">{KIND[r.kind]}</span>
                  <VisChip v={r.visibility} />
                  <span className={`chip ${STATUS[r.status][1]}`}>{STATUS[r.status][0]}</span>
                </span>
              </div>
              <span className="tiny faint">{r.author_id === me ? 'You' : nameOf(r.author_id)} · {when(r.created_at)}</span>
              <p className="read" style={{ whiteSpace: 'pre-line', fontSize: 16 }}>{r.body}</p>
              {r.reply && (
                <div style={{ padding: '8px 12px', borderLeft: '2px solid var(--accent)', background: 'var(--panel-2)', borderRadius: '0 6px 6px 0' }}>
                  <span className="tiny faint">DM{r.decided_at ? ` · ${when(r.decided_at)}` : ''}</span>
                  <p className="read" style={{ whiteSpace: 'pre-line', fontSize: 16 }}>{r.reply}</p>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : <Empty>{tab === 'mine' ? 'You have not asked anything yet.' : 'Nothing shared by the party yet.'}</Empty>}
      {ask && <AskModal kind={ask} page={null} onClose={() => setAsk(null)} onSent={() => { setAsk(null); void reqs.reload(); toast('Sent to the DM'); }} />}
      {toastNode}
    </div>
  );
}
