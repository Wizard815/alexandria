// NPCs the party has met: what they said, who recalled what. Players see
// shared people and shared quotes; their own notes stay private to them.
import { useState, type FormEvent } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, VisChip, VisibilityPicker, Tabs, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { usePlayers } from './shared.tsx';

const KINDS: [string, string][] = [['ally', 'Ally'], ['neutral', 'Neutral'], ['rival', 'Rival']];

export default function DMPeople() {
  const { w } = useWorld();
  const people = useLoad<any[]>(() => w.people(), [w], ['person', 'quote', 'recall']);
  const [filter, setFilter] = useState<'all' | 'ally' | 'neutral' | 'rival' | 'dm'>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = (people.data ?? [])
    .filter((p) => (filter === 'all' ? true : filter === 'dm' ? p.visibility === 'dm' : p.kind === filter))
    .filter((p) => !q.trim() || `${p.name} ${p.role}`.toLowerCase().includes(q.toLowerCase()));
  const cur = (people.data ?? []).find((p) => p.id === sel);

  return (
    <div className="page wide">
      <PageHead title="People" lead="Everyone the party has met. Hidden people and DM-only quotes never reach players.">
        <button type="button" className="btn primary" onClick={() => { setAdding(true); setSel(null); }}>＋ Add a person</button>
      </PageHead>
      <ErrorBox error={people.error} />
      <div className="cols">
        <aside className="col-1 card" style={{ maxWidth: 400 }}>
          <label className="field"><span className="sr-only">Find a person</span><input type="search" placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <Tabs label="Filter" value={filter} onChange={setFilter} items={[['all', 'All'], ['ally', 'Allies'], ['neutral', 'Neutral'], ['rival', 'Rivals'], ['dm', 'Hidden']]} />
          <div className="list" style={{ margin: '0 -18px' }}>
            {people.loading ? <div style={{ padding: 14 }}><Loading /></div> : rows.length ? rows.map((p) => (
              <button key={p.id} type="button" className={`list-item${sel === p.id ? ' active' : ''}`} onClick={() => { setSel(p.id); setAdding(false); }}>
                <span className="stack tight grow"><strong>{p.name}</strong><span className="tiny muted">{[p.role, p.attitude].filter(Boolean).join(' · ') || '—'}</span></span>
                <VisChip v={p.visibility} />
              </button>
            )) : <Empty>No one here yet.</Empty>}
          </div>
        </aside>
        <section className="col-3">
          {adding ? <PersonForm onDone={(id) => { setAdding(false); setSel(id ?? null); void people.reload(); }} />
            : cur ? <PersonView key={cur.id} p={cur} onChanged={() => void people.reload()} />
            : <div className="card"><Empty>Pick someone, or add a person.</Empty></div>}
        </section>
      </div>
    </div>
  );
}

function PersonForm({ p, onDone }: { p?: any; onDone: (id?: string) => void }) {
  const { w } = useWorld();
  const pages = useLoad<any[]>(() => w.pages(), [w]);
  const act = useAction();
  const [name, setName] = useState(p?.name ?? '');
  const [role, setRole] = useState(p?.role ?? '');
  const [attitude, setAttitude] = useState(p?.attitude ?? '');
  const [kind, setKind] = useState(p?.kind ?? 'neutral');
  const [met, setMet] = useState(p?.met ?? '');
  const [vis, setVis] = useState(p?.visibility ?? 'party');
  const [pageId, setPageId] = useState(p?.page_id ?? '');

  const submit = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    const body = { name: name.trim(), role, attitude, kind, met, visibility: vis };
    if (p) {
      await w.call('PATCH', `/people/${p.id}`, body);
      onDone(p.id);
    } else {
      const created: any = await w.call('POST', '/people', { ...body, ...(pageId ? { pageId } : {}) });
      onDone(created.id);
    }
  });

  return (
    <form className="card gold" onSubmit={(e) => void submit(e)}>
      <h2>{p ? `Edit ${p.name}` : 'Add a person'}</h2>
      <div className="grid">
        <Field label="Name"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Role"><input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Harbourmaster of Old Kesh" /></Field>
        <Field label="Attitude"><input value={attitude} onChange={(e) => setAttitude(e.target.value)} placeholder="Wary" /></Field>
        <Field label="First met"><input value={met} onChange={(e) => setMet(e.target.value)} placeholder="Session 12" /></Field>
      </div>
      <div className="row"><span className="small muted">Stance</span>
        <div className="tabs" role="radiogroup" aria-label="Stance">{KINDS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={`btn small${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{label}</button>)}</div>
      </div>
      <div className="row"><span className="small muted">Who can see this person</span><VisibilityPicker value={vis} onChange={setVis} labels={{ dm: 'Only me (not met yet)', party: 'The party' }} /></div>
      {!p && (
        <Field label="Library page" help="Optional link to their page">
          <select value={pageId} onChange={(e) => setPageId(e.target.value)}>
            <option value="">— none —</option>
            {(pages.data ?? []).map((pg) => <option key={pg.id} value={pg.id}>{pg.title}{pg.visibility !== 'party' ? ' (DM only)' : ''}</option>)}
          </select>
        </Field>
      )}
      <ErrorBox error={act.error} />
      <div className="row end"><button type="button" className="btn" onClick={() => onDone(p?.id)}>Cancel</button><button type="submit" className="btn primary" disabled={act.busy || !name.trim()}>Save</button></div>
    </form>
  );
}

function PersonView({ p, onChanged }: { p: any; onChanged: () => void }) {
  const { w, nameOf } = useWorld();
  const players = usePlayers();
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const [quote, setQuote] = useState('');
  const [said, setSaid] = useState('');
  const [qVis, setQVis] = useState('party');
  const [rText, setRText] = useState('');
  const [rWho, setRWho] = useState('');
  const [rOk, setROk] = useState(true);

  if (editing) return <PersonForm p={p} onDone={() => { setEditing(false); onChanged(); }} />;

  const addQuote = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    await w.call('POST', `/people/${p.id}/quotes`, { text: quote.trim(), said: said.trim(), visibility: qVis });
    setQuote(''); setSaid(''); onChanged();
  });
  const addRecall = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    if (!rWho) throw new Error('Pick who recalled it');
    await w.call('POST', `/people/${p.id}/recalls`, { accountId: rWho, text: rText.trim(), success: rOk });
    setRText(''); onChanged();
  });

  return (
    <article className="card gold">
      <div className="card-head">
        <div className="stack tight"><h2 style={{ fontSize: 24 }}>{p.name}</h2><span className="muted">{[p.role, p.attitude, p.met && `met ${p.met}`].filter(Boolean).join(' · ')}</span></div>
        <div className="row"><span className="chip">{KINDS.find((k) => k[0] === p.kind)?.[1]}</span><VisChip v={p.visibility} /><button type="button" className="btn small" onClick={() => setEditing(true)}>Edit</button></div>
      </div>

      <h3>Things they said</h3>
      {p.quotes.length ? p.quotes.map((q: any) => (
        <div key={q.id} className="row between top" style={{ padding: '6px 10px', borderLeft: '2px solid var(--accent)', background: 'var(--panel-2)', borderRadius: '0 6px 6px 0' }}>
          <span className="read">“{q.text}”{q.said && <span className="tiny faint"> — {q.said}</span>}</span><VisChip v={q.visibility} />
        </div>
      )) : <span className="small faint">Nothing recorded yet.</span>}
      <form className="row top" onSubmit={(e) => void addQuote(e)}>
        <Field label="Quote"><input value={quote} onChange={(e) => setQuote(e.target.value)} placeholder="Forty gold, or a favour." /></Field>
        <Field label="When"><input value={said} onChange={(e) => setSaid(e.target.value)} placeholder="Session 13" /></Field>
        <div className="stack tight"><span className="small muted">Who sees it</span><VisibilityPicker value={qVis} onChange={setQVis} /></div>
        <button type="submit" className="btn small" style={{ alignSelf: 'flex-end' }} disabled={act.busy || !quote.trim()}>Add quote</button>
      </form>

      <h3>Recalls</h3>
      {p.recalls.length ? p.recalls.map((r: any) => (
        <div key={r.id} className={r.success ? 'ok-box small' : 'note small'}>{r.text} · <strong>{nameOf(r.account_id)}</strong> {r.success ? 'remembered' : 'did not remember'} · {when(r.at)}</div>
      )) : <span className="small faint">No recalls yet.</span>}
      <form className="row top" onSubmit={(e) => void addRecall(e)}>
        <Field label="What was recalled"><input value={rText} onChange={(e) => setRText(e.target.value)} placeholder="She is afraid, not lying" /></Field>
        <Field label="Who">
          <select value={rWho} onChange={(e) => setRWho(e.target.value)}>
            <option value="">—</option>
            {players.map((pl) => <option key={pl.id} value={pl.id}>{pl.character_name || pl.display_name}</option>)}
          </select>
        </Field>
        <div className="stack tight"><span className="small muted">Result</span>
          <div className="tabs" role="radiogroup" aria-label="Result">
            <button type="button" role="radio" aria-checked={rOk} className={`btn small${rOk ? ' on' : ''}`} onClick={() => setROk(true)}>Remembered</button>
            <button type="button" role="radio" aria-checked={!rOk} className={`btn small${!rOk ? ' on' : ''}`} onClick={() => setROk(false)}>Failed</button>
          </div>
        </div>
        <button type="submit" className="btn small" style={{ alignSelf: 'flex-end' }} disabled={act.busy || !rText.trim()}>Add recall</button>
      </form>
      {p.visibility === 'party' && <span className="tiny faint">Recalls on shared people are seen by the party.</span>}
      <ErrorBox error={act.error} />
    </article>
  );
}
