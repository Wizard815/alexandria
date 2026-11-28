// A player's questions that needed more than their own view: only "the broker will look into it" and, later, the answer.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, useAction } from '../../ui/index.tsx';

interface Q { id: string; question: string; status: string; message: string; answer: string | null; costCp: number | null }

export function Questions() {
  const { w } = useWorld();
  const data = useLoad<{ escalations: Q[] }>(() => w.call('GET', '/source-keys/escalations'), [w], ['sourcekeys', 'broker']);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const act = useAction();
  const ask = () => act.run(async () => {
    const r = await w.call('POST', '/source-keys/escalations', { question: text });
    setNote(r.message ?? '');
    if (r.escalated) setText('');
    await data.reload();
  });
  return (
    <div className="stack">
      <ErrorBox error={act.error ?? data.error} />
      <Field label="Ask for more than you know" help="If your own view cannot answer it, the broker takes it to the GM."><input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="row"><button type="button" className="btn" disabled={act.busy || !text.trim()} onClick={() => void ask()}>Ask</button></div>
      {note && <p className="small" role="status">{note}</p>}
      {data.data?.escalations.length === 0 && <Empty>Nothing asked yet.</Empty>}
      {data.data?.escalations.map((q) => (
        <div key={q.id} className="card stack tight">
          <strong style={{ fontWeight: 500 }}>{q.question}</strong>
          {q.answer ? <p style={{ margin: 0 }}>{q.answer}</p> : <p className="small muted" style={{ margin: 0 }}>{q.message}{q.costCp !== null ? ` (${q.costCp} cp)` : ''}</p>}
        </div>
      ))}
    </div>
  );
}
