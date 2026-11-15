// Notes: the live transcript as the DM sees it (asides marked, one tap to make
// a line DM-only), quick prep notes saved to the library as DM-only, and the
// quick generators.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAction } from '../../ui/index.tsx';
import { Err } from './Sheet.tsx';
import { buzz, useFlash } from './hooks.ts';

type Part = 'live' | 'prep' | 'gen';
const PARTS: [Part, string][] = [['live', 'Transcript'], ['prep', 'Prep note'], ['gen', 'Quick gen']];

export default function NotesTab() {
  const [part, setPart] = useState<Part>('live');
  const [draft, setDraft] = useState('');
  return (
    <>
      <div className="grid g3" role="tablist" aria-label="Notes">
        {PARTS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={part === k} className={`b${part === k ? ' on' : ''}`} onClick={() => setPart(k)}>{l}</button>)}
      </div>
      {part === 'live' && <Live />}
      {part === 'prep' && <Prep draft={draft} setDraft={setDraft} />}
      {part === 'gen' && <Gen add={(t) => { setDraft((d) => (d ? `${d}\n${t}` : t)); setPart('prep'); }} />}
    </>
  );
}

function Live() {
  const { w } = useWorld();
  const act = useAction();
  const t = useLoad<any>(() => w.call('GET', '/dmphone/transcript?limit=60'), [w], ['transcript-line', 'recording']);
  const lines: any[] = t.data?.lines ?? [];
  const setAud = (id: string, audience: 'dm' | 'auto') => act.run(async () => { buzz(12); await w.call('PATCH', `/audio/lines/${id}`, { audience }); await t.reload(); });
  return (
    <>
      <Err error={t.error || act.error} />
      {t.data?.session && <div className="row between"><b className="tx">{t.data.session.name}</b><span className={`pill ${t.data.session.live ? 'red' : ''}`}>{t.data.session.live ? 'Live' : 'Ended'}</span></div>}
      {!lines.length && <div className="c"><div className="empty">No transcript yet. Start recording from the desktop or the app.</div></div>}
      {lines.map((l) => (
        <div key={l.id} className={`line${l.audience === 'dm' ? ' aside' : ''}`} data-aside={l.audience === 'dm' ? '1' : undefined}>
          <div className="row between"><span className="sub"><b>{l.speaker}</b></span>{l.audience === 'dm' && <span className="pill red">DM only</span>}</div>
          <div className="tx">{l.text}</div>
          <button type="button" className="b" style={{ marginTop: 6 }} disabled={act.busy} onClick={() => void setAud(l.id, l.audience === 'dm' ? 'auto' : 'dm')}>{l.audience === 'dm' ? 'Let players see it' : 'Make DM-only'}</button>
        </div>
      ))}
    </>
  );
}

function Prep({ draft, setDraft }: { draft: string; setDraft: (s: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { msg, flash } = useFlash();
  const [title, setTitle] = useState('');
  const save = () => act.run(async () => {
    const name = (title.trim() || `Phone note ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`).replace(/[\\/]/g, '-').slice(0, 80);
    // visibility 'dm': players never see this page.
    await w.call('PUT', '/library/pages', { path: `DM/Phone notes/${name}`, title: name, body: draft.trim(), visibility: 'dm' });
    buzz(15);
    flash(`Saved "${name}" as DM-only`);
    setDraft(''); setTitle('');
  });
  return (
    <div className="c">
      <Err error={act.error} />
      {msg && <div className="pill green" role="status">{msg}</div>}
      <label className="f">Title (optional)<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Next session hooks" /></label>
      <label className="f">Note<textarea style={{ minHeight: 160 }} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Jot it down. It is saved to the library for the DM only." /></label>
      <button type="button" className="b primary big full" disabled={act.busy || !draft.trim()} onClick={() => void save()}>Save as DM-only</button>
    </div>
  );
}

function Gen({ add }: { add: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [what, setWhat] = useState<'names' | 'items' | 'gold'>('names');
  const [out, setOut] = useState<string[]>([]);
  const roll = (k: 'names' | 'items' | 'gold') => act.run(async () => {
    buzz(10);
    setWhat(k);
    if (k === 'names') setOut(((await w.call<any>('GET', '/quickgen/names?count=6')).names ?? []).map((n: any) => `${n.name} (${n.race})`));
    else if (k === 'items') setOut(((await w.call<any>('GET', '/quickgen/items?count=3')).items ?? []).map((i: any) => `${i.name} (${i.rarity} ${i.type})`));
    else setOut([(await w.call<any>('GET', '/quickgen/coins?mode=individual&level=3')).text]);
  });
  return (
    <div className="c">
      <Err error={act.error} />
      <div className="grid g3">
        <button type="button" className="b big" style={{ fontSize: 16 }} disabled={act.busy} onClick={() => void roll('names')}>Names</button>
        <button type="button" className="b big" style={{ fontSize: 16 }} disabled={act.busy} onClick={() => void roll('items')}>Items</button>
        <button type="button" className="b big" style={{ fontSize: 16 }} disabled={act.busy} onClick={() => void roll('gold')}>Gold</button>
      </div>
      {out.length > 0 && (
        <>
          <ul data-testid="gen-out" style={{ margin: 0, padding: '0 0 0 18px', display: 'flex', flexDirection: 'column', gap: 6 }}>{out.map((o, i) => <li key={i} className="tx">{o}</li>)}</ul>
          <div className="grid g2">
            <button type="button" className="b" disabled={act.busy} onClick={() => void roll(what)}>Roll again</button>
            <button type="button" className="b" onClick={() => add(out.join('\n'))}>Add to note</button>
          </div>
        </>
      )}
    </div>
  );
}
