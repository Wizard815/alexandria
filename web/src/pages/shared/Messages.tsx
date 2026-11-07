// Chats between people in a world. Only people in a chat can read it; the
// DM is not in a chat unless added. Chats auto-delete unless the starter keeps them.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Loading, Modal, PageHead, useAction } from '../../ui/index.tsx';

export default function Messages() {
  const { w, me, members, nameOf, info } = useWorld();
  const threads = useLoad(() => w.threads(), [w], ['thread', 'message']);
  const [sel, setSel] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const list = threads.data ?? [];
  const cur = sel ?? list[0]?.id ?? null;
  const title = (t: any) => t.title || t.members.filter((m: string) => m !== me).map(nameOf).join(', ') || 'Just you';
  const days = info.settings.messageDays;

  return (
    <div className="page">
      <PageHead title="Messages" lead={`Only the people in a chat can read it. ${days ? `Chats delete themselves after ${days} days unless the person who started one keeps it.` : 'Chats are kept.'}`}>
        <button type="button" className="btn primary" onClick={() => setStarting(true)}>New chat</button>
      </PageHead>
      <ErrorBox error={threads.error} />
      <div className="cols">
        <div className="col-1 card flush">
          {threads.loading && !threads.data ? <div style={{ padding: 16 }}><Loading /></div> : (
            <div className="list">
              {list.map((t: any) => (
                <button key={t.id} type="button" className={`list-item${t.id === cur ? ' active' : ''}`} onClick={() => setSel(t.id)} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <strong>{title(t)}</strong>
                  <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{t.last ?? 'No messages yet'}</span>
                  <span className="tiny faint">{t.kept ? 'Kept' : t.expiresAt ? `Deletes ${when(t.expiresAt)}` : ''}</span>
                </button>
              ))}
              {!list.length && <Empty>No chats yet.</Empty>}
            </div>
          )}
        </div>
        <div className="col-2">{cur ? <Thread id={cur} title={title} /> : <div className="card"><p className="muted">Start a chat with someone at the table.</p></div>}</div>
      </div>
      {starting && <NewChat members={members.filter((m) => m.id !== me)} onClose={() => setStarting(false)} onDone={(id) => { setStarting(false); setSel(id); void threads.reload(); }} />}
    </div>
  );
}

function Thread({ id, title }: { id: string; title: (t: any) => string }) {
  const { w, me, nameOf } = useWorld();
  const t = useLoad(() => w.thread(id), [w, id], ['message', 'thread']);
  const [text, setText] = useState('');
  const a = useAction();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [t.data?.messages?.length]);
  if (t.error) return <ErrorBox error={t.error} />;
  if (!t.data) return <Loading />;
  const th = t.data;
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void a.run(async () => { await w.send(id, text.trim()); setText(''); await t.reload(); });
  };
  const keep = () => void a.run(async () => { await w.keepThread(id, !th.kept); await t.reload(); });
  return (
    <div className="card gold" style={{ minHeight: 420 }}>
      <div className="card-head">
        <div className="stack tight"><h2>{title(th)}</h2><span className="tiny muted">{th.members.map(nameOf).join(', ')}</span></div>
        {th.starter_id === me ? <button type="button" className={`btn small${th.kept ? ' on' : ''}`} aria-pressed={!!th.kept} onClick={keep}>{th.kept ? 'Kept ✓' : 'Keep this chat'}</button> : <span className="tiny faint">Only the starter can keep it</span>}
      </div>
      <div className="stack" style={{ flex: 1, maxHeight: '55vh', overflowY: 'auto', padding: '4px 2px' }}>
        {th.messages.map((m: any) => {
          const mine = m.author_id === me;
          return (
            <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%', display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', gap: 2 }}>
              <span className="tiny faint">{mine ? 'You' : nameOf(m.author_id)} · {when(m.at)}</span>
              <span className="read" style={{ padding: '6px 12px', borderRadius: 10, background: mine ? 'var(--accent-bg)' : 'var(--panel-2)', border: `1px solid ${mine ? 'var(--line-strong)' : 'var(--line)'}`, whiteSpace: 'pre-wrap' }}>{m.body}</span>
            </div>
          );
        })}
        {!th.messages.length && <p className="muted">No messages yet.</p>}
        <div ref={end} />
      </div>
      <form className="row" onSubmit={send}>
        <label htmlFor="msg" className="sr-only">Message</label>
        <input id="msg" className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message…" maxLength={4000} />
        <button className="btn primary" disabled={a.busy || !text.trim()}>Send</button>
      </form>
      <ErrorBox error={a.error} />
    </div>
  );
}

function NewChat({ members, onClose, onDone }: { members: { id: string; display_name: string; character_name: string | null; role: string }[]; onClose: () => void; onDone: (id: string) => void }) {
  const { w } = useWorld();
  const [pick, setPick] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const a = useAction();
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <Modal title="New chat" onClose={onClose}>
      <p className="small muted">Who is in it? You can add people later.</p>
      <div className="row">
        {members.map((m) => (
          <button key={m.id} type="button" role="checkbox" aria-checked={pick.includes(m.id)} className={`btn small${pick.includes(m.id) ? ' on' : ''}`} onClick={() => toggle(m.id)}>
            {m.character_name || m.display_name}{m.role === 'dm' ? ' (DM)' : ''}
          </button>
        ))}
      </div>
      <label className="field"><span className="label">Name (optional)</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} /></label>
      <ErrorBox error={a.error} />
      <button type="button" className="btn primary" disabled={!pick.length || a.busy} onClick={() => void a.run(async () => onDone(((await w.startThread(pick, title || undefined)) as any).id))}>Start chat</button>
    </Modal>
  );
}
