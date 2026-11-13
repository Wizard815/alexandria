// "Linked page" picker for the item forms. Searches the pages the person can
// open (players never see DM-only pages), and shows the current link.
import { useEffect, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { Field } from '../../ui/index.tsx';

interface Hit { id: string; title: string; kind?: string; source?: string | null; visibility?: string }

export function PagePicker({ value, onChange }: { value: string | null | undefined; onChange: (pageId: string | null) => void }) {
  const { w } = useWorld();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [title, setTitle] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      w.call<Hit[]>('GET', `/itemcards/pages?q=${encodeURIComponent(q)}`).then((r) => { if (live) { setHits(r); setErr(null); } }).catch((e) => { if (live) setErr(e.message ?? 'Could not search'); });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [w, q]);
  // The title of the page already linked, if I can see it.
  useEffect(() => {
    if (!value) { setTitle(null); return; }
    let live = true;
    w.call<any>('GET', `/library/pages/${encodeURIComponent(value)}`).then((p) => { if (live) setTitle(p.title); }).catch(() => { if (live) setTitle(null); });
    return () => { live = false; };
  }, [w, value]);

  return (
    <Field label="Linked page (optional)" help="Its title, facts and opening show on the item's card">
      <div className="stack tight">
        {value && (
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="chip">{title ?? 'A page'}</span>
            <button type="button" className="btn small ghost" onClick={() => onChange(null)}>Unlink</button>
          </div>
        )}
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages…" aria-label="Search pages to link" />
        {err && <span className="tiny" role="alert">{err}</span>}
        {q.trim() && (
          <ul className="stack tight" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 160, overflowY: 'auto' }}>
            {hits.length === 0 && <li className="tiny faint">No pages found.</li>}
            {hits.map((h) => (
              <li key={h.id}>
                <button type="button" className="btn small ghost" style={{ textAlign: 'left', width: '100%' }} onClick={() => { onChange(h.id); setTitle(h.title); setQ(''); }}>
                  {h.title}{h.source ? <span className="tiny faint"> · {h.source}</span> : null}{h.visibility === 'dm' ? <span className="tiny faint"> · DM only</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}
