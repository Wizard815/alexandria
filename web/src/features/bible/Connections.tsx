// "Connections" on a library page: pages that read like this one, with a
// similarity percent and the passage that matched. Everything comes from the
// viewer's own copy of the library (GET /library/pages/:id/related).
import { useEffect, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import './bible.css';

interface Related { id: string; title: string; percent: number; reason: string; matchedWith: string }

export function Connections({ pageId, onOpen }: { pageId: string; onOpen: (id: string) => void }) {
  const { w, on } = useWorld();
  const [data, setData] = useState<{ indexed: boolean; related: Related[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => on(['page'], () => setTick((n) => n + 1)), [on]);
  useEffect(() => {
    let live = true;
    w.call<{ indexed: boolean; related: Related[] }>('GET', `/library/pages/${encodeURIComponent(pageId)}/related?limit=8`)
      .then((d) => { if (live) setData(d); }).catch(() => { if (live) setData({ indexed: false, related: [] }); });
    return () => { live = false; };
  }, [w, pageId, tick]);
  // Nothing to show (no embeddings model, or this page is not read yet): stay out of the way.
  if (!data || !data.related.length) return null;
  return (
    <details className="conn" open>
      <summary><i className="fa-solid fa-diagram-project" aria-hidden="true" /> Connections <span className="chip">{data.related.length}</span></summary>
      <ul className="conn-list">
        {data.related.map((r) => (
          <li key={r.id} className="conn-item">
            <button type="button" className="conn-title" onClick={() => onOpen(r.id)}>{r.title}</button>
            <span className="conn-pct" aria-label={`${r.percent} percent similar`}>{r.percent}%</span>
            <div className="conn-bar" aria-hidden="true"><span style={{ width: `${r.percent}%` }} /></div>
            <div className="conn-why">{r.reason}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}
