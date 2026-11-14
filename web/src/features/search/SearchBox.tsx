// Search everything in the world: pages, people, rules, transcript, session
// log and items, in one ranked list grouped by kind. Open it with "/" or
// Ctrl/Cmd+/ (or the Search button in the top bar). Arrow keys move, Enter
// opens, Esc closes. The same box serves the DM and players; the server only
// returns what the viewer may see.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { useNet } from '../../lib/net.ts';
import { escapeHtml, snippetOf, safeMarks } from './marks.ts';
import './search.css';

export const OPEN_EVENT = 'alx-search-open';

interface Hit { kind: string; id: string; title: string; titleHtml?: string; snippet?: string; snippetHtml?: string; link: string; score: number }
const LABEL: Record<string, string> = { page: 'Pages', person: 'People', term: 'Rules', transcript: 'Transcript', log: 'Session log', item: 'Items' };
const ORDER = ['page', 'person', 'item', 'term', 'log', 'transcript'];

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
};

/** The button in the top bar. */
export function SearchButton() {
  return (
    <button type="button" className="btn small sx-open" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))} aria-label="Search the world" title="Search (/)">
      <i className="fa-solid fa-magnifying-glass" aria-hidden="true" /> <span>Search</span>
    </button>
  );
}

/** The overlay: listens for the shortcut and shows the box. */
export default function SearchOverlay() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== '/' || e.altKey) return;
      // Ctrl/Cmd+/ works anywhere; a bare "/" only when you are not typing in a field.
      if (e.ctrlKey || e.metaKey || (!e.shiftKey && !typing(e.target))) { e.preventDefault(); setOpen(true); }
    };
    const show = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener(OPEN_EVENT, show);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener(OPEN_EVENT, show); };
  }, []);
  return open ? <Box onClose={() => setOpen(false)} /> : null;
}

function Box({ onClose }: { onClose: () => void }) {
  const { w } = useWorld();
  const { world = '' } = useParams();
  const nav = useNavigate();
  const online = useNet().online;
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState(0);
  const seq = useRef(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const text = q.trim();
    if (!text || !online) { setHits(null); setErr(null); setBusy(false); return; }
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      w.call<{ results: Hit[] }>('GET', `/search?q=${encodeURIComponent(text)}&limit=40`)
        .then((r) => { if (n === seq.current) { setHits(r.results); setErr(null); setCur(0); } })
        .catch((e) => { if (n === seq.current) { setHits(null); setErr(e?.message ?? 'Search failed'); } })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 180);
    return () => clearTimeout(t);
  }, [q, w, online]);

  // Grouped in a fixed order; `flat` is the order the arrow keys walk.
  const groups = useMemo(() => {
    const by = new Map<string, Hit[]>();
    for (const h of hits ?? []) by.set(h.kind, [...(by.get(h.kind) ?? []), h]);
    return ORDER.filter((k) => by.has(k)).concat([...by.keys()].filter((k) => !ORDER.includes(k))).map((k) => ({ kind: k, hits: by.get(k)! }));
  }, [hits]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  const go = useCallback((h: Hit) => { onClose(); nav(`/w/${world}/${h.link}`); }, [nav, onClose, world]);

  useEffect(() => { list.current?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: 'nearest' }); }, [cur, hits]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(c + 1, Math.max(flat.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && flat[cur]) { e.preventDefault(); go(flat[cur]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let index = -1;
  return (
    <div className="sx-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sx-box" role="dialog" aria-modal="true" aria-label="Search the world" onKeyDown={onKey}>
        <div className="sx-input">
          <i className="fa-solid fa-magnifying-glass faint" aria-hidden="true" />
          <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, people, rules, transcript, items…"
            aria-label="Search" aria-controls="sx-results" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" />
          <button type="button" className="btn ghost small" onClick={onClose} aria-label="Close search">✕</button>
        </div>
        <div className="sx-results" id="sx-results" role="listbox" ref={list} aria-busy={busy}>
          {!online && <div className="sx-hint">Search needs a connection.</div>}
          {online && !q.trim() && <div className="sx-hint">Type to search. Use "quotes" for an exact phrase and -word to leave a word out.</div>}
          {err && <div className="sx-hint" role="alert">{err}</div>}
          {online && q.trim() && hits && !hits.length && !busy && <div className="sx-hint">Nothing found for “{q.trim()}”.</div>}
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-label={LABEL[g.kind] ?? g.kind}>
              <div className="sx-group">{LABEL[g.kind] ?? g.kind}</div>
              {g.hits.map((h) => {
                index++;
                const i = index;
                const on = i === cur;
                return (
                  <button key={`${h.kind}:${h.id}`} type="button" role="option" aria-selected={on} data-on={on ? '1' : undefined} className={`sx-hit${on ? ' on' : ''}`}
                    onMouseMove={() => { if (cur !== i) setCur(i); }} onClick={() => go(h)}>
                    <span className="sx-title sx-snip" dangerouslySetInnerHTML={{ __html: h.titleHtml !== undefined ? safeMarks(h.titleHtml) : escapeHtml(h.title) }} />
                    {(h.snippetHtml || h.snippet) && <span className="sx-text sx-snip" dangerouslySetInnerHTML={{ __html: snippetOf(h) }} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="sx-foot"><span className="sx-keys">↑↓ move · Enter opens · Esc closes</span><span>{busy ? 'Searching…' : flat.length ? `${flat.length} results` : ''}</span></div>
      </div>
    </div>
  );
}
