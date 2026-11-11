// Suggest an edit, ask about a page, or suggest a new page. Becomes a
// request the DM answers; the player picks who else can see it.
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { Modal, Field, VisibilityPicker, ErrorBox, useAction } from '../../ui/index.tsx';

interface Page { id: string; title: string }

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
