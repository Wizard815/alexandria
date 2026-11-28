// GM home: Session prep. The assistant drafts a short note for each player from what that player knows (last time,
// where they stand, their threads, one thing to think about); the GM adds a line for everyone, reads and edits each
// draft, and sends them. Each player gets theirs as a private message (Messages), kept so it does not expire.
import { useEffect, useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { ErrorBox, useAction, useToast } from '../../ui/index.tsx';

interface Prep { id: string; accountId: string; name: string; title: string; text: string; status: 'draft' | 'sent'; byModel: boolean; sentAt: string | null; updatedAt: string }

function Draft({ p, onSent }: { p: Prep; onSent: (n: number) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [text, setText] = useState(p.text);
  useEffect(() => setText(p.text), [p.text]);
  const dirty = text.trim() !== p.text;
  const save = () => act.run(() => w.call('PATCH', `/prep/${encodeURIComponent(p.id)}`, { text }));
  const send = () => act.run(async () => {
    if (dirty) await save();
    const r = await w.call<{ sent: Prep[] }>('POST', '/prep/send', { ids: [p.id] });
    onSent(r.sent.length);
  });
  const drop = () => act.run(() => w.call('DELETE', `/prep/${encodeURIComponent(p.id)}`));
  return (
    <div className="stack" style={{ gap: 4 }} data-testid="prep-draft">
      <div className="row between"><strong>{p.name}</strong><span className="tiny faint">{p.byModel ? 'Drafted by the assistant' : 'From their notes (no model answered)'}</span></div>
      <textarea aria-label={`Session prep for ${p.name}`} rows={7} value={text} onChange={(e) => setText(e.target.value)} />
      <ErrorBox error={act.error} />
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary small" disabled={act.busy || !text.trim()} onClick={send}>Send to {p.name}</button>
        <button className="btn small" disabled={act.busy || !dirty} onClick={save}>Save</button>
        <button className="btn ghost small" disabled={act.busy} onClick={drop}>Discard</button>
      </div>
    </div>
  );
}

export function PrepCard() {
  const { w, isGM } = useWorld();
  const list = useLoad<{ preps: Prep[]; model: boolean }>(() => (isGM ? w.call('GET', '/prep') : Promise.resolve({ preps: [], model: false })), [w, isGM], ['prep']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  if (!isGM) return null;
  const preps = list.data?.preps ?? [];
  const drafts = preps.filter((p) => p.status === 'draft');
  const sent = preps.filter((p) => p.status === 'sent');
  const draft = () => act.run(async () => {
    const r = await w.call<{ preps: Prep[] }>('POST', '/prep', { note: note.trim() || undefined });
    setOpen(true);
    toast(`Drafted ${r.preps.length} session prep${r.preps.length === 1 ? '' : 's'}. Read them, then send.`);
  });
  const sendAll = () => act.run(async () => {
    const r = await w.call<{ sent: Prep[] }>('POST', '/prep/send', {});
    toast(`Sent to ${r.sent.length} player${r.sent.length === 1 ? '' : 's'}.`);
  });
  return (
    <section className="card" aria-labelledby="prep-h" data-testid="prep-card">
      <div className="card-head">
        <h2 id="prep-h"><i className="fa-solid fa-scroll" aria-hidden="true" /> Session prep</h2>
        {drafts.length > 0 && <button className="btn ghost small" onClick={() => setOpen(!open)}>{open ? 'Hide drafts' : `${drafts.length} draft${drafts.length === 1 ? '' : 's'}`}</button>}
      </div>
      <p className="small muted">Before game night, the assistant writes each player a short note from what their character knows: last time, where they stand, their threads. You read each one before it goes out.</p>
      <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
        <input aria-label="A line from you for every player" placeholder="A line for everyone, e.g. We start in the crypt. Bring your sheets." value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
        <button className="btn small" disabled={act.busy} onClick={draft}>{act.busy ? 'Writing…' : drafts.length ? 'Draft again' : 'Draft for every player'}</button>
      </div>
      {!list.data?.model && <p className="tiny faint">No Players model is attached, so drafts are built from each player's notes for you to edit.</p>}
      <ErrorBox error={act.error ?? list.error} />
      {open && drafts.map((p) => <Draft key={p.id} p={p} onSent={(n) => toast(`Sent to ${p.name}${n ? '' : ' (already sent)'}.`)} />)}
      {drafts.length > 1 && <button className="btn primary small" disabled={act.busy} onClick={sendAll}>Send all {drafts.length}</button>}
      {sent.length > 0 && <p className="tiny faint">Sent: {sent.slice(0, 6).map((p) => `${p.name} (${when(p.sentAt ?? p.updatedAt)})`).join(', ')}</p>}
      {toastNode}
    </section>
  );
}
