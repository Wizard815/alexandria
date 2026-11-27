// Gateway admin → Search: the same ranked page search players and scribes use, across the worlds an admin may read.
// An admin reads each world's party copy; only the GM of a world sees its GM copy. Hidden pages are simply not found.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { Pill, Section } from '../../pages/admin/kit.tsx';
import SearchInsights from '../gwstatus/SearchInsights.tsx';

interface Result { world: { id: string; name: string }; id: string; path: string; title: string; titleHtml: string; snippetHtml: string; source: string | null }
interface Found { q: string; worlds: { id: string; name: string; copy: 'dm' | 'party'; count: number }[]; sources: { name: string; count: number }[]; results: Result[] }

export default function AdminSearch() {
  const { client } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const world = params.get('world') ?? '';
  const [text, setText] = useState(q);
  const [source, setSource] = useState('');
  useEffect(() => setText(q), [q]);
  const worlds = useLoad(() => client.request<any[]>('GET', '/api/admin/worlds'), []);
  const found = useLoad(async () => (q.trim().length >= 2 ? client.request<Found>('GET', `/api/admin/gateway/search?q=${encodeURIComponent(q)}${world ? `&world=${encodeURIComponent(world)}` : ''}`) : null), [q, world]);
  const go = (e: FormEvent) => { e.preventDefault(); setParams({ q: text, ...(world ? { world } : {}) }); setSource(''); };
  const d = found.data;
  const shown = (d?.results ?? []).filter((r) => !source || (r.source ?? 'Written here') === source);
  return (
    <div className="page">
      <PageHead title="Search" lead="Look across every world and source at once, or narrow to one world. It is the search players and the AI use. You read each world's party copy; only a world's own GM sees its hidden pages." />
      <form className="row wrap adm-searchbar" onSubmit={go}>
        <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search…" aria-label="Search words" />
        <select className="input" value={world} aria-label="World" onChange={(e) => setParams({ q: text || q, ...(e.target.value ? { world: e.target.value } : {}) })}>
          <option value="">All worlds</option>
          {(worlds.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button className="btn primary" disabled={text.trim().length < 2}>Search</button>
      </form>
      <ErrorBox error={found.error} />
      {found.loading && !d ? <Loading /> : d ? (
        <Section title={`${d.results.length} result${d.results.length === 1 ? '' : 's'} for “${d.q}”`} lead={d.worlds.map((w) => `${w.name}: ${w.copy === 'dm' ? 'GM copy (you are its GM)' : 'party copy'}`).join(' · ')}
          actions={d.sources.length > 1 ? (
            <span className="row wrap">
              <button type="button" className={`btn small${source ? '' : ' primary'}`} onClick={() => setSource('')}>All</button>
              {d.sources.map((s) => <button key={s.name} type="button" className={`btn small${source === s.name ? ' primary' : ''}`} onClick={() => setSource(s.name)}>{s.name} {s.count}</button>)}
            </span>
          ) : undefined}>
          {shown.length ? (
            <ul className="adm-feed adm-results">{shown.map((r) => (
              <li key={`${r.world.id}${r.id}`}>
                <span className="stack tight">
                  <span><strong dangerouslySetInnerHTML={{ __html: r.titleHtml }} /> <Pill>{r.world.name}</Pill> {r.source && <Pill tone="teal">{r.source}</Pill>}</span>
                  <span className="small muted" dangerouslySetInnerHTML={{ __html: r.snippetHtml }} />
                  <span className="tiny faint mono">{r.path}</span>
                </span>
              </li>
            ))}</ul>
          ) : <Empty>Nothing found. Pages only a world's GM may read are not searched from here. <Link to="/admin/worlds">Worlds</Link></Empty>}
        </Section>
      ) : <p className="muted">Type at least two letters.</p>}
      <SearchInsights />
    </div>
  );
}
