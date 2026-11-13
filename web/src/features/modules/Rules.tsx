// The Rules page: search and read terms from the world's game modules.
// Everyone in the world sees the same thing; modules hold no secrets.
import { useState } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Markdown } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';

const KINDS: [string, string][] = [['', 'All'], ['rule', 'Rules'], ['action', 'Actions'], ['condition', 'Conditions'], ['spell', 'Spells'], ['monster', 'Monsters'], ['item', 'Items'], ['class', 'Classes'], ['other', 'Other']];

export default function RulesPage() {
  const { w } = useWorld();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const mods = useLoad<any>(() => w.call('GET', '/modules'), [w], ['modules']);
  const list = useLoad<any>(() => w.call('GET', `/modules/terms?limit=100&q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`), [w, q, kind], ['modules']);
  const term = useLoad<any>(() => (sel ? w.call('GET', `/modules/terms/${encodeURIComponent(sel)}`) : Promise.resolve(null)), [w, sel]);
  const attributions: string[] = [...new Set<string>((mods.data?.modules ?? []).map((m: any) => m.attribution).filter(Boolean))];

  return (
    <div className="page wide">
      <PageHead title="Rules" lead="Spells, conditions, monsters and rules from this world’s game module." />
      <ErrorBox error={list.error ?? mods.error} />
      <div className="cols">
        <aside className="col-1 card" style={{ maxWidth: 420 }}>
          <label className="field"><span className="sr-only">Find a term</span><input type="search" placeholder="Find a spell, rule, monster…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }} role="group" aria-label="Kind">
            {KINDS.map(([k, label]) => <button key={k} type="button" className="btn small" aria-pressed={kind === k} style={kind === k ? { fontWeight: 700 } : undefined} onClick={() => setKind(k)}>{label}</button>)}
          </div>
          <div className="list" style={{ margin: '0 -18px' }}>
            {list.loading && !list.data ? <div style={{ padding: 14 }}><Loading /></div> : (list.data?.terms ?? []).length ? list.data.terms.map((t: any) => (
              <button key={t.id} type="button" className={`list-item${sel === t.id ? ' active' : ''}`} onClick={() => setSel(t.id)}>
                <span className="stack tight grow"><strong>{t.term}</strong><span className="tiny muted">{t.summary}</span></span>
                <span className="chip">{t.kind}</span>
              </button>
            )) : <Empty>Nothing matches.</Empty>}
          </div>
          {list.data && list.data.total > list.data.terms.length && <p className="tiny muted">Showing {list.data.terms.length} of {list.data.total}. Type to narrow it down.</p>}
        </aside>
        <section className="col-2 card">
          {term.data ? (
            <article>
              <div className="row between"><h2>{term.data.term}</h2><span className="chip">{term.data.kind}</span></div>
              {term.data.aliases?.length > 0 && <p className="tiny muted">Also: {term.data.aliases.join(', ')}</p>}
              <Markdown text={term.data.text} />
              <p className="tiny faint">{term.data.module}</p>
            </article>
          ) : <Empty>Pick a term to read it.</Empty>}
        </section>
      </div>
      {attributions.map((a) => <p key={a} className="tiny faint">{a}</p>)}
    </div>
  );
}
