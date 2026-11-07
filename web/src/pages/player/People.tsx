// People we've met: what they said, who remembered what, and my own
// private notes on each (nobody else reads them, the DM included).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { PageHead, Loading, ErrorBox, Empty, Tabs, useAction } from '../../ui/index.tsx';

interface Person {
  id: string; name: string; role: string; attitude: string; kind: 'ally' | 'neutral' | 'rival'; met: string;
  quotes: { id: string; text: string; said: string }[];
  recalls: { id: string; account_id: string; text: string; success: number; at: string }[];
  myNote: string;
}

type Filter = 'all' | 'ally' | 'neutral' | 'rival';

export default function PlayerPeople() {
  const { w } = useWorld();
  const people = useLoad(() => w.people() as Promise<Person[]>, [w], ['person', 'quote', 'recall']);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const shown = useMemo(() => (people.data ?? []).filter((p) => (filter === 'all' || p.kind === filter) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))), [people.data, filter, q]);
  const cur = (people.data ?? []).find((p) => p.id === sel) ?? shown[0] ?? null;

  return (
    <div className="page">
      <PageHead title="People we've met" lead="Built from sessions and the people your DM shares. Your notes are private to you." />
      <ErrorBox error={people.error} />
      <div className="row">
        <Tabs label="Filter" value={filter} onChange={setFilter} items={[['all', 'Everyone'], ['ally', 'Allies'], ['neutral', 'Neutral'], ['rival', 'Rivals']]} />
        <label className="sr-only" htmlFor="ppl-q">Find a person</label>
        <input id="ppl-q" type="search" className="input" style={{ maxWidth: 240 }} placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {people.loading && !people.data ? <Loading /> : !people.data?.length ? <Empty>No one yet. People appear here once your DM adds them.</Empty> : (
        <div className="cols">
          <div className="col-1 card flush" role="list" aria-label="People">
            <div className="list">
              {shown.map((p) => (
                <button key={p.id} type="button" role="listitem" className={`list-item${cur?.id === p.id ? ' active' : ''}`} onClick={() => setSel(p.id)}>
                  <span aria-hidden="true" style={{ width: 38, height: 38, borderRadius: '50%', flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--panel-2)', border: '1px solid var(--line-strong)', fontFamily: 'var(--font-head)', color: 'var(--accent-strong)' }}>
                    {initial(p.name)}
                  </span>
                  <span className="stack tight grow"><strong>{p.name}</strong><span className="tiny muted">{[p.role, p.attitude].filter(Boolean).join(' · ')}</span></span>
                </button>
              ))}
              {!shown.length && <Empty>No one matches.</Empty>}
            </div>
          </div>
          {cur && <PersonView key={cur.id} p={cur} />}
        </div>
      )}
    </div>
  );
}

function initial(name: string) {
  return name.replace(/^(the|lady|lord|brother|sister|sir|madam)\s+/i, '').charAt(0).toUpperCase() || '?';
}

function PersonView({ p }: { p: Person }) {
  const { w, nameOf, me } = useWorld();
  return (
    <article className="col-2 card gold" style={{ padding: '18px 22px' }}>
      <div className="row">
        <h2 style={{ fontSize: 24 }}>{p.name}</h2>
        <span className={`chip ${p.kind === 'ally' ? 'teal' : p.kind === 'rival' ? 'red' : ''}`}>{p.attitude || p.kind}</span>
      </div>
      <span className="muted">{[p.role, p.met && `first met ${p.met}`].filter(Boolean).join(' · ')}</span>

      <section className="stack tight" aria-label="Things they said">
        <span className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>Things they said</span>
        {p.quotes.length ? p.quotes.map((q) => (
          <blockquote key={q.id} style={{ margin: 0, padding: '8px 12px', borderLeft: '2px solid var(--accent)', background: 'var(--panel-2)', borderRadius: '0 6px 6px 0' }}>
            <span className="read">“{q.text}”</span>{q.said && <div className="tiny faint">{q.said}</div>}
          </blockquote>
        )) : <span className="muted small">Nothing recorded yet.</span>}
      </section>

      <section className="stack tight" aria-label="Recalls">
        <span className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recalls</span>
        {p.recalls.length ? p.recalls.map((r) => (
          <div key={r.id} className="row between" style={{ padding: '8px 12px', borderRadius: 6, background: r.success ? 'var(--ok-bg)' : 'var(--bg)', border: `1px ${r.success ? 'solid var(--ok)' : 'dashed var(--line)'}` }}>
            <span className="grow">{r.text}</span>
            <span className="tiny">{r.account_id === me ? 'You' : nameOf(r.account_id)} · {r.success ? 'remembered' : 'missed it'}</span>
          </div>
        )) : <span className="muted small">No recalls yet.</span>}
      </section>

      <NoteBox personId={p.id} initial={p.myNote} save={(body) => w.notePerson(p.id, body)} />
    </article>
  );
}

function NoteBox({ personId, initial, save }: { personId: string; initial: string; save: (b: string) => Promise<unknown> }) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const act = useAction();
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (state !== 'dirty') return;
    const t = setTimeout(() => {
      setState('saving');
      void act.run(() => save(latest.current)).then(() => setState((s) => (s === 'saving' ? 'saved' : s)));
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, state]);
  const id = `note-${personId}`;
  return (
    <div className="stack tight">
      <div className="row between">
        <label htmlFor={id} className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.1em' }}>My notes (only you)</label>
        <span className="tiny faint" role="status">{state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Unsaved' : 'Saved'}</span>
      </div>
      <textarea id={id} className="input read" rows={4} style={{ padding: '8px 10px', minHeight: 90 }} value={text}
        onChange={(e) => { setText(e.target.value); setState('dirty'); }} />
      <ErrorBox error={act.error} />
    </div>
  );
}
