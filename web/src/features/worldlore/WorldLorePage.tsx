// DM page: the pages in the AI's wiki, who wrote them, and where to open them.
import { Link, useParams } from 'react-router-dom';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import { LEVEL_LABEL, type LorePage, type LoreState } from './shared.ts';

export default function WorldLorePage() {
  const { w } = useWorld();
  const { world = '' } = useParams();
  const st = useLoad<LoreState>(() => w.call('GET', '/worldlore'), [w], ['settings']);
  const pages = useLoad<LorePage[]>(() => (st.data?.enabled ? w.call('GET', '/worldlore/pages') : Promise.resolve([])), [w, st.data?.enabled], ['page']);
  const l = st.data?.links;
  return (
    <div className="page wide">
      <PageHead title="WorldLore" lead="The AI's own wiki for this world.">
        {l?.url && <a className="btn" href={l.url} target="_blank" rel="noreferrer">Open in {l.sourceName ?? 'the source'}</a>}
      </PageHead>
      <ErrorBox error={st.error ?? pages.error} />
      {!st.data ? <Loading /> : !st.data.enabled ? (
        <Empty>WorldLore is off. Turn it on in <Link to={`/w/${world}/dm/settings`}>World settings</Link>.</Empty>
      ) : !pages.data ? <Loading /> : !pages.data.length ? (
        <Empty>Nothing here yet. Ask the assistant to write something to the WorldLore wiki.</Empty>
      ) : (
        <div className="card flush" role="table" aria-label="WorldLore pages">
          {pages.data.map((p) => (
            <div key={p.id} role="row" className="row between" style={{ padding: '10px 16px', gap: 8, flexWrap: 'wrap' }}>
              <div className="stack tight" style={{ flex: '1 1 220px' }}>
                <strong style={{ fontWeight: 500 }}>{p.title}</strong>
                <span className="tiny muted">{LEVEL_LABEL[p.level] ?? p.level} · {p.writtenBy === 'agent' ? 'written by the AI' : 'written by the DM'} · {new Date(p.updatedAt).toLocaleString()}</span>
              </div>
              <Link className="btn small" to={`/w/${world}/dm/library?page=${encodeURIComponent(p.id)}`}>Open in library</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
