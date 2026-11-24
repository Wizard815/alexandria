// The story bible: facts about people, places, factions, items, events and
// lore, grouped by subject, each citing its library page. Built for the caller
// from the pages they may open (GET /bible); a DM gets the DM bible, a player
// their own.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHead, ErrorBox, Empty, Loading } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { progressText, type Progress } from './EmbeddingsCard.tsx';
import './bible.css';

interface Fact { text: string; kind: string; pages: { id: string; title: string; path: string }[] }
interface Subject { subject: string; key: string; kind: string; facts: Fact[] }
interface Bible { scope: string; total: number; kinds: Record<string, number>; subjects: Subject[]; ready: boolean }

const KINDS = ['person', 'place', 'faction', 'item', 'event', 'lore'];
const ICON: Record<string, string> = { person: 'fa-user', place: 'fa-location-dot', faction: 'fa-flag', item: 'fa-gem', event: 'fa-hourglass-half', lore: 'fa-book-open' };

export default function BiblePage() {
  const { w, info, isDM } = useWorld();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const path = useMemo(() => { const p = new URLSearchParams(); if (debounced) p.set('q', debounced); if (kind) p.set('kind', kind); p.set('limit', '400'); return `/bible?${p}`; }, [debounced, kind]);
  const data = useLoad<Bible>(() => w.call('GET', path), [w, path], ['page']);
  const href = (id: string) => `/w/${info.slug}/${isDM ? 'dm/' : ''}library?page=${encodeURIComponent(id)}`;
  const b = data.data;
  // The DM sees how far the background reading has got, so an empty bible is not a mystery.
  const status = useLoad<{ configured: boolean; progress?: Progress; reading?: boolean; runs?: string }>(() => (isDM ? w.call('GET', '/bible/status') : Promise.resolve({ configured: false })), [w, isDM], ['page']);
  const left = progressText(status.data?.progress);
  useEffect(() => {
    if (!left || status.data?.reading === false) return;
    const t = setInterval(() => { void status.reload(); void data.reload(); }, 20_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, status.data?.reading]);
  // Thousands of facts: subjects start closed unless you are searching, and come a screenful at a time.
  const [n, setN] = useState(60);
  useEffect(() => setN(60), [path]);
  return (
    <div className="page">
      <PageHead title="Story bible" lead={isDM ? 'The world as facts, from every page but classified ones.' : 'What you know about the world, as facts, from the pages you can read.'} />
      <div className="bible-filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search facts by words or meaning" aria-label="Search the story bible" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          {KINDS.map((k) => <option key={k} value={k}>{k}{b?.kinds[k] ? ` (${b.kinds[k]})` : ''}</option>)}
        </select>
      </div>
      {left && <p className="small muted" role="status" data-testid="bible-progress">{left}. {status.data?.reading === false ? (status.data.runs === 'off' ? 'Reading is off (Settings, Story bible).' : 'Paused until the next session (Settings, Story bible).') : 'Facts appear as pages are read.'}</p>}
      <ErrorBox error={data.error} />
      {!b ? <Loading /> : !b.subjects.length ? (
        <Empty>{debounced || kind ? 'No facts match.' : 'Nothing has been written into the bible yet. It fills in the background once a chat model is set and the library has been read.'}</Empty>
      ) : (
        <div className="stack tight">
          {b.subjects.slice(0, n).map((s) => (
            <details key={`${s.key}:${debounced}`} className="card bible-subject" open={!!debounced || undefined}>
              <summary><h3 style={{ display: 'inline' }}><i className={`fa-solid ${ICON[s.kind] ?? 'fa-book-open'}`} aria-hidden="true" /> {s.subject} <span className="chip">{s.kind}</span></h3> <span className="tiny faint">{s.facts.length} fact{s.facts.length === 1 ? '' : 's'}</span></summary>
              <ul className="bible-facts">
                {s.facts.map((f, i) => (
                  <li key={i} className="bible-fact">{f.text}
                    {f.pages.map((p) => <span key={p.id} className="bible-cite"><Link to={href(p.id)}>{p.title}</Link></span>)}
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {b.subjects.length > n && <button type="button" className="btn" onClick={() => setN(n + 100)}>Show more ({b.subjects.length - n} left)</button>}
        </div>
      )}
    </div>
  );
}
