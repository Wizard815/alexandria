// DM: World settings → Source keys. Every key of the world with its users, uses and trust, the probe result and revoke;
// how questions beyond a player's view are escalated; and the queue of those questions with the hidden context (DM only).
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { Empty, ErrorBox, Field, Modal, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';

interface Key {
  id: string; sourceName: string; label: string; ownerName: string; trust: string; claimed: string; treatedAs: string; users: string[]; userNames: string[]; uses: string[];
  verified: { matchedWorld: boolean; checkedAt: string | null }; revoked: boolean; probe: { verdict?: string; note?: string }; pagesSeen: number; refreshNote: string;
}
interface Esc { id: string; askerName: string; question: string; status: string; origin: string; hidden: { reason?: string; via?: string; items?: { title: string; source: string; text: string }[] }; costCp: number | null }
const USES = ['library', 'agent', 'broker'] as const;

export default function KeysAdmin() {
  const { w, info, reloadInfo } = useWorld();
  const keys = useLoad<{ keys: Key[]; sources: { id: string; name: string }[]; members: { id: string; name: string }[] }>(() => w.call('GET', '/source-keys'), [w], ['sourcekeys']);
  const [tab, setTab] = useState<'keys' | 'queue'>('keys');
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const s = info.settings as unknown as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await reloadInfo(); toast('Saved'); });
  const patch = (k: Key, body: Record<string, unknown>) => act.run(async () => {
    await w.call('PATCH', `/source-keys/${k.id}`, body);
    if (body.trust === 'per-user' && k.uses.includes('library')) { try { await w.call('POST', `/source-keys/${k.id}/refresh`); } catch { /* shown on the key */ } }
    await keys.reload();
  });
  const revoke = (k: Key) => { if (window.confirm(`Revoke "${k.label}"? It stops working at once.`)) void act.run(async () => { await w.call('DELETE', `/source-keys/${k.id}`); await keys.reload(); }); };
  const probe = (k: Key) => act.run(async () => { await w.call('POST', `/source-keys/${k.id}/probe`); await keys.reload(); });
  const live = (keys.data?.keys ?? []).filter((k) => !k.revoked);

  return (
    <section className="card stack">
      <ErrorBox error={act.error ?? keys.error} />
      <div className="row between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <Field label="When a player needs more than their own view"><select value={String(s.escalation ?? 'broker-deal')} onChange={(e) => void set({ escalation: e.target.value })}><option value="broker-deal">A broker deal: I price it and it waits</option><option value="dm-question">A question for me to answer</option></select></Field>
        {String(s.escalation ?? 'broker-deal') === 'broker-deal' && <Field label="Sessions to wait"><input type="number" min={0} max={50} value={Number(s.escalationSessions ?? 2)} onChange={(e) => void set({ escalationSessions: Number(e.target.value) })} style={{ width: 90 }} /></Field>}
        <Switch label="Players may add their own keys" checked={s.sourceKeysPlayers !== false} onChange={(v) => void set({ sourceKeysPlayers: v })} />
      </div>
      <Tabs label="Source keys" value={tab} onChange={setTab} items={[['keys', `Keys (${live.length})`], ['queue', 'Escalated questions']]} />
      {tab === 'keys' && (
        <div className="stack">
          <div className="row"><button type="button" className="btn small" onClick={() => setAdding(true)}>Add a key</button></div>
          {!live.length && <Empty>No keys yet.</Empty>}
          {live.map((k) => (
            <div key={k.id} className="card stack tight">
              <div className="row between"><strong>{k.label}</strong><span className="tiny muted">{k.sourceName} · added by {k.ownerName}</span></div>
              <div className="tiny muted">{k.verified.matchedWorld ? 'Verified for this world' : 'Not verified'}{k.probe?.note ? ` · ${k.probe.note}` : ''}{k.claimed !== 'unsure' ? ` · the owner says: ${k.claimed}` : ''}</div>
              <Field label="Does this source give each key only what that user may see?">
                <select value={k.trust} onChange={(e) => void patch(k, { trust: e.target.value })}>
                  <option value="per-user">Per-user: it is that person's own view</option>
                  <option value="blanket">Blanket: it sees everything</option>
                  <option value="unsure">Not sure (treated as blanket)</option>
                </select>
              </Field>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                {USES.map((u) => <label key={u} className="row" style={{ gap: 4 }}><input type="checkbox" checked={k.uses.includes(u)} onChange={(e) => { const next = e.target.checked ? [...k.uses, u] : k.uses.filter((x) => x !== u); if (next.length) void patch(k, { uses: next }); }} /> {u === 'library' ? 'Library view' : u === 'agent' ? 'Agent lookups' : 'Broker'}</label>)}
              </div>
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <span className="tiny muted">Who may use it:</span>
                {(keys.data?.members ?? []).map((m) => <label key={m.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={k.users.includes(m.id)} onChange={(e) => void patch(k, { users: e.target.checked ? [...k.users, m.id] : k.users.filter((x) => x !== m.id) })} /> {m.name}</label>)}
              </div>
              <div className="tiny muted">{k.treatedAs === 'per-user' ? `Feeds the library view: ${k.pagesSeen} pages seen. ${k.refreshNote}` : 'Treated as a blanket key: it never feeds a player\'s view, and what it finds goes to you.'}</div>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn small" disabled={act.busy} onClick={() => void probe(k)}>Probe</button>
                {k.treatedAs === 'per-user' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/source-keys/${k.id}/refresh`); await keys.reload(); })}>Refresh view</button>}
                <button type="button" className="btn small danger" disabled={act.busy} onClick={() => revoke(k)}>Revoke</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === 'queue' && <Queue />}
      {adding && keys.data && <AddKey sources={keys.data.sources} members={keys.data.members} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void keys.reload(); }} />}
      {toastNode}
    </section>
  );
}

function Queue() {
  const { w } = useWorld();
  const data = useLoad<{ escalations: Esc[] }>(() => w.call('GET', '/source-keys/escalations'), [w], ['sourcekeys', 'broker']);
  const act = useAction();
  const [text, setText] = useState<Record<string, string>>({});
  const [cost, setCost] = useState<Record<string, string>>({});
  const go = (e: Esc, what: 'answer' | 'price' | 'refuse') => act.run(async () => {
    const body = what === 'answer' ? { answer: text[e.id] } : what === 'price' ? { answer: text[e.id], costCp: Number(cost[e.id] ?? 0) } : {};
    await w.call('POST', `/source-keys/escalations/${e.id}/${what}`, body);
    await data.reload();
  });
  const open = (data.data?.escalations ?? []).filter((e) => e.status === 'open');
  return (
    <div className="stack">
      <ErrorBox error={act.error ?? data.error} />
      {!open.length && <Empty>Nothing is waiting for you.</Empty>}
      {open.map((e) => (
        <div key={e.id} className="card stack tight">
          <strong style={{ fontWeight: 500 }}>{e.askerName}: {e.question}</strong>
          <p className="tiny muted" style={{ margin: 0 }}>For you only. {e.hidden?.reason}{e.hidden?.via ? ` Through ${e.hidden.via}.` : ''}</p>
          {(e.hidden?.items ?? []).map((i, n) => <div key={n} className="note small"><strong>{i.title}</strong> <span className="muted">({i.source})</span><br />{i.text}</div>)}
          <Field label="Your answer"><textarea rows={3} value={text[e.id] ?? ''} onChange={(ev) => setText({ ...text, [e.id]: ev.target.value })} /></Field>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn small primary" disabled={act.busy || !(text[e.id] ?? '').trim()} onClick={() => void go(e, 'answer')}>Answer</button>
            <input type="number" min={0} placeholder="Price (cp)" aria-label="Price in copper" value={cost[e.id] ?? ''} onChange={(ev) => setCost({ ...cost, [e.id]: ev.target.value })} style={{ width: 110 }} />
            <button type="button" className="btn small" disabled={act.busy || !(text[e.id] ?? '').trim() || (cost[e.id] ?? '') === ''} onClick={() => void go(e, 'price')}>Price as a deal</button>
            <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void go(e, 'refuse')}>Refuse</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function AddKey({ sources, members, onClose, onDone }: { sources: { id: string; name: string }[]; members: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const { w, me } = useWorld();
  const act = useAction();
  const [f, setF] = useState({ sourceId: sources[0]?.id ?? '', secret: '', label: '', trust: 'unsure' });
  const [users, setUsers] = useState<string[]>([me]);
  const [uses, setUses] = useState<string[]>(['agent']);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Modal title="Add a key" onClose={onClose}>
      <ErrorBox error={act.error} />
      <div className="stack">
        <Field label="Source"><select value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })}>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Key" help="Checked against this world, stored on the server, never shown again."><input type="password" autoComplete="off" value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} /></Field>
        <Field label="Name"><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Trust"><select value={f.trust} onChange={(e) => setF({ ...f, trust: e.target.value })}><option value="per-user">Per-user</option><option value="blanket">Blanket</option><option value="unsure">Not sure (treated as blanket)</option></select></Field>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{USES.map((u) => <label key={u} className="row" style={{ gap: 4 }}><input type="checkbox" checked={uses.includes(u)} onChange={() => toggle(uses, setUses, u)} /> {u}</label>)}</div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>{members.map((m) => <label key={m.id} className="row" style={{ gap: 4 }}><input type="checkbox" checked={users.includes(m.id)} onChange={() => toggle(users, setUsers, m.id)} /> {m.name}</label>)}</div>
        <div className="row"><button type="button" className="btn primary" disabled={act.busy || f.secret.length < 8 || !uses.length} onClick={() => void act.run(async () => { await w.call('POST', '/source-keys', { ...f, users, uses }); onDone(); })}>Check and save</button></div>
      </div>
    </Modal>
  );
}
