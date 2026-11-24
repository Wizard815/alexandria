// Everything the DM hands out, in one place: shared pages, invites, players' source keys and AI keys.
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, PageHead, Tabs, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { CopyButton } from '../../lib/copy.tsx';
import KeysAdmin from '../../features/sourcekeys/KeysAdmin.tsx';
import { openShare } from '../../features/sourcekeys/ShareButton.tsx';
import ConnectAI from '../shared/ConnectAI.tsx';
import { Invites } from './Settings.tsx';

type Tab = 'pages' | 'invite' | 'keys' | 'ai';
export default function Sharing() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: Tab = raw === 'invite' || raw === 'keys' || raw === 'ai' ? raw : 'pages';
  return (
    <div className="page">
      <PageHead title="Sharing & keys" lead="What players can open, who is invited, and the keys you give out." />
      <Tabs label="Sharing" value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} items={[['pages', 'Shared pages'], ['invite', 'Invite players'], ['keys', 'Players’ source keys'], ['ai', 'AI keys']]} />
      {tab === 'pages' && <SharedPages />}
      {tab === 'invite' && <Invites />}
      {tab === 'keys' && <KeysAdmin />}
      {tab === 'ai' && <AIKeys />}
    </div>
  );
}

function SharedPages() {
  const { w, info } = useWorld();
  const data = useLoad<{ shares: any[] }>(() => w.call('GET', '/library/shares'), [w], ['page']);
  const act = useAction();
  const list = data.data?.shares ?? [];
  const pages = new Map<string, { title: string; rows: any[] }>();
  for (const s of list) { const p: { title: string; rows: any[] } = pages.get(s.pageId) ?? { title: s.title, rows: [] }; p.rows.push(s); pages.set(s.pageId, p); }
  return (
    <section className="card flush">
      <div className="row between" style={{ padding: 12 }}><span className="small muted">Pages you or a player shared one by one. Pages open to the whole party are not listed here.</span><button type="button" className="btn primary small" onClick={() => openShare()}><i className="fa-solid fa-share-nodes" aria-hidden="true" /> Share pages</button></div>
      <ErrorBox error={data.error ?? act.error} />
      {data.data && !list.length && <Empty>Nothing is shared one by one yet.</Empty>}
      {[...pages].map(([id, p]) => (
        <div key={id} className="list-item">
          <span className="stack tight grow"><Link to={`/w/${info.slug}/dm/library?page=${encodeURIComponent(id)}`}>{p.title}</Link>
            <span className="share-chips">{p.rows.map((s) => <span key={`${s.from}-${s.to}`} className="chip teal" title={`By ${s.fromName}, ${when(s.createdAt)}`}>{s.toName} <button type="button" className="btn ghost small" style={{ minHeight: 0, padding: '0 2px' }} aria-label={`Stop sharing ${p.title} with ${s.toName}`} disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', `/library/pages/${encodeURIComponent(id)}/share?to=${encodeURIComponent(s.to)}`); await data.reload(); })}>✕</button></span>)}</span>
          </span>
          <button type="button" className="btn small" onClick={() => openShare([id])}>Change</button>
        </div>
      ))}
    </section>
  );
}

function AIKeys() {
  const { info } = useWorld();
  const link = `${window.location.origin}/w/${info.slug}/connect`;
  return (
    <div className="stack">
      <section className="card">
        <h2>For a player</h2>
        <p className="small muted">Send this link. They sign in and make their own read-only key, so it sees only what they can see. You can’t make one for them: it would open their private chat.</p>
        <div className="row"><span className="mono" style={{ overflowWrap: 'anywhere' }}>{link}</span><CopyButton text={link} label="Copy link" /></div>
      </section>
      <div className="sharing-ai"><ConnectAI /></div>
    </div>
  );
}
