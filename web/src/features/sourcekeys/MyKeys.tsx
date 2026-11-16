// Player: "My keys". Add your own key for a world's source (Kanka, LegendKeeper, an API), see its status, refresh what it
// lets you see, revoke it. The key is checked against this world before it is saved and is never shown again.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { PageHead, Loading, ErrorBox, Empty, Field, Modal, useAction, useToast } from '../../ui/index.tsx';
import { Questions } from './Questions.tsx';

interface Key { id: string; sourceName: string; label: string; treatedAs: string; trust: string; claimed: string; verified: { matchedWorld: boolean; checkedAt: string | null }; refreshedAt: string | null; pagesSeen: number; uses: string[]; revoked: boolean }
interface Listing { keys: Key[]; sources: { id: string; name: string; kind: string }[]; canAdd: boolean }

const TRUST_NOTE: Record<string, string> = {
  'per-user': 'Confirmed by the DM: your key shows you only what you may see in the source, so your own pages open here, as your copy.',
  blanket: 'The DM treats this key as seeing everything, so nothing it finds is shown to you directly. Questions it raises go to the DM.',
  unsure: 'Waiting for the DM to confirm. Until then it is treated as seeing everything, and nothing it finds is shown to you directly.',
};

export default function MyKeys() {
  const { w } = useWorld();
  const data = useLoad<Listing>(() => w.call('GET', '/source-keys'), [w], ['sourcekeys']);
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const refresh = (k: Key) => act.run(async () => { const r = await w.call('POST', `/source-keys/${k.id}/refresh`); toast(r.note ?? 'Refreshed'); await data.reload(); });
  const revoke = (k: Key) => { if (!window.confirm(`Revoke "${k.label}"? It stops working at once and is forgotten.`)) return; void act.run(async () => { await w.call('DELETE', `/source-keys/${k.id}`); toast('Revoked'); await data.reload(); }); };

  if (data.loading && !data.data) return <Loading what="your keys" />;
  const d = data.data;
  return (
    <div className="page">
      <PageHead title="My keys" lead="Your own key for this world's source lets your assistant look things up for you, and shows you the pages that are only yours.">
        {d?.canAdd && d.sources.length > 0 && <button type="button" className="btn primary" onClick={() => setAdding(true)}><i className="fa-solid fa-plus" aria-hidden="true" /> Add a key</button>}
      </PageHead>
      <ErrorBox error={data.error ?? act.error} />
      {d && !d.canAdd && <p className="note small">Your DM has not opened keys to players in this world.</p>}
      {d && d.canAdd && !d.sources.length && <p className="note small">None of this world's sources can be read with a personal key.</p>}
      <div className="stack">
        {d?.keys.length === 0 && <Empty>No keys yet.</Empty>}
        {d?.keys.map((k) => (
          <section key={k.id} className="card stack tight">
            <div className="row between"><strong>{k.label}</strong><span className="tiny muted">{k.sourceName}</span></div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className={`chip${k.verified.matchedWorld ? '' : ' warn'}`}>{k.verified.matchedWorld ? 'Verified for this world' : 'Not verified'}</span>
              <span className="chip">{k.treatedAs === 'per-user' ? 'Per-user (confirmed)' : k.trust === 'blanket' ? 'Blanket' : 'Waiting for the DM'}</span>
              {k.treatedAs === 'per-user' && <span className="chip">{k.pagesSeen} pages seen</span>}
            </div>
            <p className="small muted" style={{ margin: 0 }}>{TRUST_NOTE[k.treatedAs === 'per-user' ? 'per-user' : k.trust] ?? TRUST_NOTE.unsure}</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {k.treatedAs === 'per-user' && k.uses.includes('library') && <button type="button" className="btn small" disabled={act.busy} onClick={() => void refresh(k)}><i className="fa-solid fa-rotate" aria-hidden="true" /> Refresh my view</button>}
              <button type="button" className="btn small danger" disabled={act.busy} onClick={() => revoke(k)}>Revoke</button>
            </div>
          </section>
        ))}
      </div>
      <h2 style={{ marginTop: 24 }}>My questions to the broker</h2>
      <Questions />
      {adding && d && <AddKey sources={d.sources} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void data.reload(); }} />}
      {toastNode}
    </div>
  );
}

function AddKey({ sources, onClose, onDone }: { sources: Listing['sources']; onClose: () => void; onDone: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState('');
  const [trust, setTrust] = useState('unsure');
  const save = () => act.run(async () => { await w.call('POST', '/source-keys', { sourceId, secret, label, trust }); onDone(); });
  return (
    <Modal title="Add a key" onClose={onClose}>
      <ErrorBox error={act.error} />
      <div className="stack">
        <Field label="Source"><select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Your key" help="It is checked against this world, stored on the server and never shown again."><input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
        <Field label="A name for it"><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></Field>
        <Field label="Does this source give each key only what that person may see?" help="Your DM confirms the answer. Until then the key is treated as seeing everything.">
          <select value={trust} onChange={(e) => setTrust(e.target.value)}>
            <option value="per-user">Yes: each key only shows what its owner may see</option>
            <option value="blanket">No: every key sees everything</option>
            <option value="unsure">I am not sure</option>
          </select>
        </Field>
        <div className="row"><button type="button" className="btn primary" disabled={act.busy || secret.length < 8 || !sourceId} onClick={() => void save()}>Check and save</button></div>
      </div>
    </Modal>
  );
}
