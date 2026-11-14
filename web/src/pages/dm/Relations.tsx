// Relations and family trees, read from page frontmatter. DM-only links
// (under secret:, or pointing at a DM-only page) are dashed red here and
// never shown to players.
import { useMemo, useState, type ReactElement } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Tabs, VisChip } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { DMLink } from './shared.tsx';

type Rel = { id: string; from_title: string; to_title: string; kind: string; visibility: string };

export default function DMRelations() {
  const { w } = useWorld();
  const rels = useLoad<Rel[]>(() => w.relations(), [w], ['page']);
  const [view, setView] = useState<'tree' | 'list'>('tree');
  const [kind, setKind] = useState('all');
  const [vis, setVis] = useState<'all' | 'party' | 'dm'>('all');
  const [q, setQ] = useState('');
  const kinds = useMemo(() => [...new Set((rels.data ?? []).map((r) => r.kind))].sort(), [rels.data]);
  const rows = (rels.data ?? []).filter((r) => (kind === 'all' || r.kind === kind) && (vis === 'all' || r.visibility === vis) && (!q.trim() || `${r.from_title} ${r.to_title}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="page wide">
      <PageHead title="Relations & family" lead="Built from page frontmatter: parents, children, spouse, siblings, member_of and relations. Anything listed under secret is DM-only." />
      <ErrorBox error={rels.error} />
      <div className="card">
        <div className="row between">
          <Tabs label="View" value={view} onChange={setView} items={[['tree', 'Family tree'], ['list', 'All relations']]} />
          <div className="row">
            <label className="field" style={{ minWidth: 180 }}><span className="sr-only">Find</span><input type="search" placeholder="Find a name…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <label className="field"><span className="sr-only">Kind</span><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="all">All kinds</option>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
            <Tabs label="Visibility" value={vis} onChange={setVis} items={[['all', 'All'], ['party', 'Shared'], ['dm', 'DM only']]} />
          </div>
        </div>
      </div>
      {rels.loading ? <Loading /> : !rels.data?.length ? (
        <div className="card">
          <Empty>No relations yet.</Empty>
          <div className="note small">
            Add them to a page's frontmatter in the <DMLink to="library">Library</DMLink>, for example:
            <pre className="mono" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{`parents: ["[[Old Lord Varn]]"]\nspouse: "[[Lady Ysolde]]"\nmember_of: "[[House Varn]]"\nsecret:\n  lovers: ["[[Brother Tamsin]]"]`}</pre>
          </div>
        </div>
      ) : view === 'list' ? (
        <div className="card flush scroll-x">
          <table className="table">
            <thead><tr><th scope="col">From</th><th scope="col">Relation</th><th scope="col">To</th><th scope="col">Seen by</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}><td>{r.from_title}</td><td className="muted">{r.kind}</td><td>{r.to_title}</td><td><VisChip v={r.visibility} /></td></tr>
            ))}</tbody>
          </table>
          {!rows.length && <Empty>Nothing matches.</Empty>}
        </div>
      ) : <Tree rels={rows} />}
    </div>
  );
}

/** Families: people grouped under their parents, with spouses alongside. */
function Tree({ rels }: { rels: Rel[] }) {
  const { roots, children, spouses, other } = useMemo(() => {
    const childOf = new Map<string, Map<string, Rel>>(); // parent -> child -> rel
    const spouses = new Map<string, Rel[]>();
    const other: Rel[] = [];
    const addChild = (parent: string, child: string, r: Rel) => {
      if (!childOf.has(parent)) childOf.set(parent, new Map());
      const m = childOf.get(parent)!;
      if (!m.has(child) || r.visibility === 'party') m.set(child, r);
    };
    for (const r of rels) {
      if (r.kind === 'child of') addChild(r.to_title, r.from_title, r);
      else if (r.kind === 'parent of') addChild(r.from_title, r.to_title, r);
      else if (r.kind === 'spouse of' || r.kind === 'partner of' || r.kind === 'lover of') {
        for (const [a, b] of [[r.from_title, r.to_title], [r.to_title, r.from_title]]) {
          const list = spouses.get(a) ?? [];
          if (!list.some((x) => (x.from_title === b || x.to_title === b) && x.kind === r.kind)) list.push(r);
          spouses.set(a, list);
        }
      } else other.push(r);
    }
    const isChild = new Set<string>();
    for (const m of childOf.values()) for (const c of m.keys()) isChild.add(c);
    const roots = [...childOf.keys()].filter((p) => !isChild.has(p)).sort();
    return { roots, children: childOf, spouses, other };
  }, [rels]);

  const node = (name: string, via: Rel | null, depth: number, seen: Set<string>): ReactElement => {
    const kids = [...(children.get(name)?.entries() ?? [])];
    const sp = spouses.get(name) ?? [];
    const loop = seen.has(name);
    const next = new Set(seen).add(name);
    return (
      <li key={`${name}-${depth}`} style={{ listStyle: 'none', margin: '6px 0' }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="chip gold" style={via?.visibility === 'dm' ? { borderStyle: 'dashed', borderColor: 'var(--danger)', color: 'var(--danger-text)' } : undefined} title={via?.visibility === 'dm' ? 'This link is DM-only' : undefined}>{name}</span>
          {sp.map((s) => {
            const other = s.from_title === name ? s.to_title : s.from_title;
            const dm = s.visibility === 'dm';
            return <span key={s.id} className="small" style={dm ? { color: 'var(--danger-text)' } : { color: 'var(--muted)' }}>{dm ? '⚭?' : '⚭'} {other} <span className="tiny">({s.kind.replace(' of', '')}{dm ? ', DM only' : ''})</span></span>;
          })}
        </span>
        {!loop && kids.length > 0 && depth < 12 && (
          <ul style={{ margin: '4px 0 0 18px', padding: '0 0 0 12px', borderLeft: '1px solid var(--line-strong)' }}>
            {kids.map(([child, r]) => node(child, r, depth + 1, next))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="cols">
      <section className="card col-3" aria-label="Family tree">
        {roots.length ? <ul style={{ margin: 0, padding: 0 }}>{roots.map((r) => node(r, null, 0, new Set()))}</ul> : <Empty>No parent and child links in this view.</Empty>}
        <span className="tiny faint">Dashed red = DM-only link. Players never see it.</span>
      </section>
      <section className="card col-1" aria-label="Other relations">
        <h3>Other ties</h3>
        {other.length ? other.map((r) => (
          <div key={r.id} className="small" style={r.visibility === 'dm' ? { color: 'var(--danger-text)' } : undefined}>{r.from_title} <span className="muted">{r.kind}</span> {r.to_title}{r.visibility === 'dm' && ' · DM only'}</div>
        )) : <span className="small faint">None.</span>}
      </section>
    </div>
  );
}
