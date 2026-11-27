// Admin → Content library: rules books pulled once onto this server (from
// Open5e or the 5e SRD API) and kept here, so every world can turn them on
// in World settings → Game module without downloading anything.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useLoad } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';

const KINDS: [string, string][] = [['spell', 'Spells'], ['monster', 'Monsters'], ['item', 'Items'], ['condition', 'Conditions'], ['other', 'Feats, backgrounds, species']];
const ed = (e?: string) => (e === '2024' ? '5e 2024' : e === '2014' ? '5e 2014' : '');

export default function ContentLibrary() {
  const { client } = useAuth();
  const lib = useLoad<any>(() => client.request('GET', '/api/admin/content'), [client]);
  const src = useLoad<any>(() => client.request('GET', '/api/admin/content/sources'), [client]);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [tab, setTab] = useState<'open5e' | 'dnd5eapi'>('open5e');
  const [books, setBooks] = useState<string[]>([]);
  const [edition, setEdition] = useState('2024');
  const [kinds, setKinds] = useState<string[]>([]);
  const [pre, setPre] = useState<any | null>(null);
  const mods: any[] = lib.data?.modules ?? [];
  const docs: any[] = src.data?.open5e?.documents ?? [];
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const req = () => ({ ...(tab === 'open5e' ? { type: 'open5e', documents: books } : { type: 'dnd5eapi', edition }), ...(kinds.length ? { kinds } : {}) });
  const preview = () => act.run(async () => setPre(await client.request('POST', '/api/admin/content/preview', req())));
  const save = () => act.run(async () => { const r = await client.request('POST', '/api/admin/content', { ...req(), replace: !!pre?.exists }); setPre(null); setBooks([]); await lib.reload(); toast(`${r.module.name} is in the library`); });
  const refresh = (id: string) => act.run(async () => { await client.request('POST', `/api/admin/content/${encodeURIComponent(id)}/refresh`); await lib.reload(); toast('Pulled again'); });
  const remove = (m: any) => { if (confirm(`Remove ${m.name} from the library? Worlds that have it on lose it.`)) void act.run(async () => { await client.request('DELETE', `/api/admin/content/${encodeURIComponent(m.id)}`); await lib.reload(); }); };

  return (
    <div className="stack">
      <PageHead title="Content library" lead="Rules books this server keeps for every world: pulled once, used offline. A DM turns one on in World settings → Game module." />
      <ErrorBox error={lib.error ?? act.error} />
      <section className="card stack">
        <h3>In the library</h3>
        {lib.loading && !lib.data ? <Loading /> : mods.length === 0 ? <p className="muted">Nothing yet. Every world already has the SRD 5.2 (2024) and SRD 5.1 built in; add more below.</p> : mods.map((m) => (
          <div key={m.id} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span><strong>{m.name}</strong> {m.edition && <span className="chip">{ed(m.edition)}</span>} <span className="tiny muted">{Object.entries(m.counts ?? {}).map(([k, n]) => `${n} ${k}`).join(', ')} · {m.license}{m.version ? ` · pulled ${m.version}` : ''}</span></span>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void refresh(m.id)}>Pull again</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => remove(m)}>Remove</button>
            </span>
          </div>
        ))}
      </section>

      <section className="card stack">
        <h3>Add a book</h3>
        <Tabs label="From" value={tab} onChange={(t) => { setTab(t); setPre(null); setKinds([]); }} items={[['open5e', 'Open5e'], ['dnd5eapi', '5e SRD API']]} />
        <ErrorBox error={src.error} />
        {tab === 'open5e' && (src.loading && !src.data ? <Loading /> : src.data?.open5e?.error ? <p className="error-box">Open5e could not be reached: {src.data.open5e.error}</p> : (
          <div className="stack tight">
            <p className="tiny muted">2024 books first. The Kobold Press and Level Up books are written for 2014 rules; they still work at a 2024 table.</p>
            {docs.map((d) => (
              <label key={d.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'start' }}>
                <input type="checkbox" checked={books.includes(d.key)} onChange={() => { setBooks(toggle(books, d.key)); setPre(null); }} />
                <span><strong>{d.name}</strong> {d.edition && <span className="chip">{ed(d.edition)}</span>} {mods.some((m) => m.id === `open5e-${d.key}`) && <span className="chip">in the library</span>} <span className="tiny muted">{[d.publisher, d.license].filter(Boolean).join(' · ')}</span>{d.desc && <><br /><span className="tiny muted">{d.desc}</span></>}</span>
              </label>
            ))}
            <p className="tiny muted">Tick one book at a time to keep each its own module (worlds turn them on separately).</p>
          </div>
        ))}
        {tab === 'dnd5eapi' && (
          <div className="stack tight">
            <p className="tiny muted">A fresh copy of the System Reference Document from the <a href="https://www.dnd5eapi.co" target="_blank" rel="noreferrer">5e SRD API</a>, with the fixes made since this release.</p>
            <label className="row" style={{ gap: 8 }}>Edition <select value={edition} onChange={(e) => { setEdition(e.target.value); setPre(null); }}><option value="2024">SRD 5.2 (D&amp;D 2024)</option><option value="2014">SRD 5.1 (D&amp;D 5e 2014)</option></select></label>
          </div>
        )}
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <span className="tiny muted">Only:</span>
          {KINDS.map(([k, label]) => <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" checked={kinds.includes(k)} onChange={() => { setKinds(toggle(kinds, k)); setPre(null); }} /> {label}</label>)}
        </div>
        <div className="row"><button type="button" className="btn" disabled={act.busy || (tab === 'open5e' && !books.length)} onClick={() => void preview()}>Preview</button></div>
        {pre && (
          <div className="stack tight" role="region" aria-label="Library preview">
            <p><strong>{pre.module.name}</strong> {pre.edition && <span className="chip">{ed(pre.edition)}</span>}: {pre.total} terms. {Object.entries(pre.counts).map(([k, n]) => `${n} ${k}`).join(', ')}.</p>
            <ul className="tiny">{pre.samples.map((s: any, i: number) => <li key={i}><strong>{s.term}</strong> <span className="chip">{s.kind}</span> {s.summary}</li>)}</ul>
            {pre.exists && <p className="tiny muted">The library has this one already; saving replaces it.</p>}
            <div className="row"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>{pre.exists ? 'Replace in the library' : 'Add to the library'}</button></div>
          </div>
        )}
      </section>
      {toastNode}
    </div>
  );
}
