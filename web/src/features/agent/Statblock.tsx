// "Statblock": copy a module monster (no model needed), or have the chat
// model write one from a prompt or the library page on screen. It is saved
// as a DM-only page in Statblocks; "Add to combat" puts it in initiative.
import { useState } from 'react';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';

export default function Statblock({ page }: { page?: string }) {
  const { w } = useWorld();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [prompt, setPrompt] = useState('');
  const [toCombat, setToCombat] = useState(true);
  const [done, setDone] = useState<any>(null);
  const { busy, error, run } = useAction();

  const search = () => run(async () => {
    const r = await w.call<any>('GET', `/modules/terms?kind=monster&limit=8&q=${encodeURIComponent(q)}`);
    setHits(r.terms ?? []);
  });
  const make = (body: Record<string, unknown>) => run(async () => { setDone(await w.call('POST', '/agent/statblock', { ...body, addToCombat: toCombat })); });

  return (
    <div className="stack" style={{ overflowY: 'auto' }}>
      <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={toCombat} onChange={(e) => setToCombat(e.target.checked)} /> Add to combat</label>
      <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="grow" style={{ flex: 1 }}><span className="sr-only">Find a module monster</span><input type="search" style={{ width: '100%' }} placeholder="Copy a module monster…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <button type="submit" className="btn small" disabled={busy}>Find</button>
      </form>
      {hits.map((t) => (
        <div key={t.id} className="row between" style={{ flexWrap: 'nowrap' }}>
          <span className="stack tight"><strong>{t.term}</strong><span className="tiny muted">{t.summary}</span></span>
          <button type="button" className="btn small" disabled={busy} onClick={() => void make({ moduleTermId: t.id })}>Copy</button>
        </div>
      ))}
      <label className="field"><span className="tiny muted">Or describe one for the chat model to write</span>
        <textarea rows={2} style={{ width: '100%' }} value={prompt} placeholder="A cave troll that hides in a flooded cellar" onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" className="btn small primary" disabled={busy || !prompt.trim()} onClick={() => void make({ prompt })}>Write it</button>
        {page && <button type="button" className="btn small" disabled={busy} onClick={() => void make({ pageId: page })}>From this page</button>}
      </div>
      <ErrorBox error={error} />
      {done && <p className="small" role="status">Saved <strong>{done.page.title}</strong> in Statblocks (AC {done.statblock.ac}, HP {done.statblock.hp}){done.combatant ? ' and added to combat.' : '.'}</p>}
    </div>
  );
}
