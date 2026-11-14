// The DM's stage: a staging column (prepared, not shown), the live board
// (what the table sees) and an "add a card" panel.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { PageHead, Field, ErrorBox, Loading, Empty, useAction } from '../../ui/index.tsx';
import { LIB_CSS } from '../../pages/library/Blocks.tsx';
import { when } from '../../lib/format.ts';
import { CardView, cardTitle } from './CardView.tsx';
import { StageCards, useStage, CSS } from './StageBoard.tsx';
import type { Kind, StageCard, StageView } from './types.ts';

const MAX = 4 * 1024 * 1024;
const KIND_LABEL: Record<Kind, string> = { image: 'Picture (handout or map)', combat: 'Combat', person: 'Person', shop: 'Shop', place: 'Place', event: 'Event', text: 'Text handout', drawing: 'Drawing board' };

interface Pickers { pages: { id: string; title: string; path: string; visibility: string }[]; people: { id: string; name: string; role: string; visibility: string }[]; players: { id: string; name: string }[] }

function AddCard({ onDone }: { onDone: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [kind, setKind] = useState<Kind>('image');
  const [q, setQ] = useState('');
  const [ref, setRef] = useState('');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [caption, setCaption] = useState('');
  const [secs, setSecs] = useState('');
  const [showNow, setShowNow] = useState(false);
  const [buy, setBuy] = useState(true);
  const pick = useLoad(() => w.call<Pickers>('GET', `/stage/pickers?q=${encodeURIComponent(q)}`), [w, q]);
  const needsPage = kind === 'shop' || kind === 'place';

  const upload = async (f: File) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) throw new Error('Pick a PNG, JPEG, GIF or WebP picture');
    if (f.size > MAX) throw new Error('Pictures can be at most 4 MB');
    const b64 = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(new Error('Could not read the file')); r.readAsDataURL(f); });
    return (await w.call<{ id: string }>('POST', '/stage/images', { dataBase64: b64 })).id;
  };
  const submit = (file?: File) => act.run(async () => {
    let r = ref;
    if ((kind === 'image' || kind === 'event') && file) r = await upload(file);
    else if (kind === 'image' || kind === 'event') r = url.trim();
    const body: Record<string, unknown> = { kind, show: showNow, title, text, caption };
    if (kind !== 'combat' && kind !== 'drawing' && kind !== 'text') body.ref = r || undefined;
    if (kind === 'event' && secs) body.countdownSec = Number(secs);
    if (kind === 'shop') body.buy = buy;
    await w.call('POST', '/stage/cards', body);
    setRef(''); setUrl(''); setTitle(''); setText(''); setCaption(''); setSecs('');
    onDone();
  });
  const fileInput = (label: string) => (
    <label className="btn small">
      {act.busy ? 'Uploading…' : label}
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" disabled={act.busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void submit(f); e.target.value = ''; }} />
    </label>
  );

  return (
    <section className="card" aria-labelledby="stg-add">
      <h2 id="stg-add">Add a card</h2>
      <Field label="What">
        <select className="input" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setRef(''); }}>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </Field>
      {(kind === 'image' || kind === 'event') && (
        <div className="stack tight">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            {kind === 'image' ? fileInput('Upload a picture and add') : <span className="small muted">Optional picture:</span>}
            <input className="grow" style={{ minWidth: 180 }} value={url} maxLength={500} placeholder="…or an https:// link" aria-label="Picture link" onChange={(e) => setUrl(e.target.value)} />
          </div>
          {kind === 'image' && <Field label="Caption (optional)"><input value={caption} maxLength={300} onChange={(e) => setCaption(e.target.value)} /></Field>}
        </div>
      )}
      {kind === 'person' && (
        <Field label="Person from People" help="Players see the player view; the person must be shared with the party to be shown.">
          <select className="input" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">Choose…</option>
            {pick.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.role ? ` (${p.role})` : ''}{p.visibility !== 'party' ? ' – DM only' : ''}</option>)}
          </select>
        </Field>
      )}
      {needsPage && (
        <div className="stack tight">
          <Field label={kind === 'shop' ? 'Shop page (a Sculpted shop, or any page with an item list)' : 'Library page'}><input value={q} placeholder="Search pages…" onChange={(e) => setQ(e.target.value)} /></Field>
          <select className="input" size={5} value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Pages">
            {pick.data?.pages.map((p) => <option key={p.id} value={p.id}>{p.title}{p.visibility !== 'party' ? ' – DM only' : ''}</option>)}
          </select>
          {kind === 'shop' && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={buy} onChange={(e) => setBuy(e.target.checked)} /> Players can send a buy request</label>}
        </div>
      )}
      {(kind === 'event' || kind === 'text') && (
        <div className="stack tight">
          <Field label={kind === 'event' ? 'Title' : 'Heading (optional)'}><input value={title} maxLength={160} placeholder={kind === 'event' ? 'The bridge collapses!' : ''} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Text (Markdown)"><textarea rows={4} value={text} maxLength={20000} onChange={(e) => setText(e.target.value)} /></Field>
          {kind === 'event' && <Field label="Countdown in seconds (optional)"><input inputMode="numeric" value={secs} onChange={(e) => setSecs(e.target.value.replace(/\D/g, ''))} /></Field>}
        </div>
      )}
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={showNow} onChange={(e) => setShowNow(e.target.checked)} /> Show to the table right away</label>
      <div className="row"><button type="button" className="btn primary" disabled={act.busy || (needsPage && !ref) || (kind === 'person' && !ref) || (kind === 'image' && !url.trim())} onClick={() => void submit()}>Add card</button></div>
      <ErrorBox error={act.error} />
    </section>
  );
}

function ShowTo({ card, players, reload }: { card: StageCard; players: { id: string; name: string }[]; reload: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [some, setSome] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const go = (to: 'all' | string[], spotlight = false) => act.run(async () => { await w.call('POST', `/stage/cards/${card.id}/show`, { to, spotlight }); reload(); });
  return (
    <div className="stack tight">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void go('all')}>Show to all</button>
        <button type="button" className="btn small" disabled={act.busy} onClick={() => void go('all', true)}>Spotlight</button>
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>Show to…</button>
        <Remove card={card} reload={reload} />
      </div>
      {open && (
        <fieldset className="stack tight" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, margin: 0 }}>
          <legend className="small muted">Only these players</legend>
          {players.map((p) => <label key={p.id} className="row small" style={{ gap: 6 }}><input type="checkbox" checked={some.includes(p.id)} onChange={(e) => setSome(e.target.checked ? [...some, p.id] : some.filter((x) => x !== p.id))} /> {p.name}</label>)}
          <button type="button" className="btn small primary" disabled={act.busy || !some.length} onClick={() => void go(some)}>Show</button>
        </fieldset>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

function Remove({ card, reload }: { card: StageCard; reload: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  return <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('DELETE', `/stage/cards/${card.id}`); reload(); })}>Delete</button>;
}

function LiveControls({ card, view, reload }: { card: StageCard; view: StageView; reload: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const go = (fn: () => Promise<unknown>) => act.run(async () => { await fn(); reload(); });
  const who = card.visibility === 'players' ? `${card.audience?.length ?? 0} player(s)` : 'everyone';
  return (
    <div className="stack tight">
      <div className="tiny muted">Shown to {who}{card.shownAt ? ` · ${when(card.shownAt)}` : ''}</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button type="button" className="btn small" disabled={act.busy} onClick={() => void go(() => w.call('POST', `/stage/cards/${card.id}/hide`))}>Hide</button>
        <button type="button" className={`btn small${view.spotlightId === card.id && view.layout === 'spotlight' ? ' on' : ''}`} disabled={act.busy} onClick={() => void go(() => w.call('PUT', '/stage/layout', { layout: 'spotlight', spotlightId: card.id }))}>Spotlight</button>
        <button type="button" className="btn small" disabled={act.busy} onClick={() => void go(() => w.call('PATCH', `/stage/cards/${card.id}`, { raise: true }))}>To front</button>
        <select className="input" style={{ width: 'auto', minHeight: 30 }} aria-label="Width" value={Math.min(3, Math.round(card.w))} onChange={(e) => void go(() => w.call('PATCH', `/stage/cards/${card.id}`, { w: Number(e.target.value) }))}>
          <option value={1}>Narrow</option><option value={2}>Wide</option><option value={3}>Full row</option>
        </select>
        <Remove card={card} reload={reload} />
      </div>
      <ErrorBox error={act.error} />
    </div>
  );
}

export default function StagePage() {
  const { w } = useWorld();
  const s = useStage();
  const hist = useLoad(() => w.call<{ id: number; at: string; action: string; kind: string | null; label: string; detail: string }[]>('GET', '/stage/history'), [w], ['stage']);
  const pick = useLoad(() => w.call<Pickers>('GET', '/stage/pickers'), [w]);
  const act = useAction();
  const [showHist, setShowHist] = useState(false);
  const reload = () => { void s.reload(); void hist.reload(); };
  if (s.loading && !s.data) return <div className="page"><Loading what="the stage" /></div>;
  const v = s.data;
  const staged = v?.cards.filter((c) => c.visibility === 'dm') ?? [];
  const live: StageView | null = v ? { ...v, cards: v.cards.filter((c) => c.visibility !== 'dm') } : null;
  const setLayout = (layout: string) => act.run(async () => { await w.call('PUT', '/stage/layout', { layout }); reload(); });

  return (
    <div className="page">
      <style>{LIB_CSS + CSS}</style>
      <PageHead title="Stage" lead="Prepare cards on the left, show them to the table on the right. Players only ever see what is on the board.">
        <div className="row" role="group" aria-label="Layout" style={{ gap: 6 }}>
          {(['spotlight', 'grid', 'free'] as const).map((l) => <button key={l} type="button" className={`btn small${v?.layout === l ? ' on' : ''}`} aria-pressed={v?.layout === l} disabled={act.busy} onClick={() => void setLayout(l)}>{l[0].toUpperCase() + l.slice(1)}</button>)}
        </div>
      </PageHead>
      <ErrorBox error={s.error ?? act.error} />
      <div className="cols">
        <aside className="col-1 stack loose" aria-label="Staging area">
          <section className="card" aria-labelledby="stg-h"><h2 id="stg-h">Staging ({staged.length})</h2><p className="small muted" style={{ margin: 0 }}>Only you see these.</p></section>
          {staged.length === 0 && <Empty>Nothing staged. Add a card below.</Empty>}
          {staged.map((c) => <CardView key={c.id} card={c} controls={<ShowTo card={c} players={pick.data?.players ?? []} reload={reload} />} />)}
          <AddCard onDone={reload} />
        </aside>
        <div className="col-3 stack loose" aria-label="Live board">
          <section className="card gold"><div className="card-head"><h2>On the board ({live?.cards.length ?? 0})</h2></div></section>
          {live && (live.cards.length ? <StageCards view={live} controls={(c) => <LiveControls card={c} view={live} reload={reload} />} /> : <Empty>The board is empty. Show a staged card to put it in front of the players.</Empty>)}
          <section className="card">
            <button type="button" className="btn small" aria-expanded={showHist} onClick={() => setShowHist(!showHist)}>{showHist ? 'Hide' : 'Show'} board history</button>
            {showHist && (hist.data?.length ? (
              <ul className="stack tight small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {hist.data.map((h) => <li key={h.id} className="row between"><span>{h.action} {h.kind ?? ''} {h.label && `“${h.label}”`} <span className="faint">{h.detail}</span></span><span className="tiny muted">{when(h.at)}</span></li>)}
              </ul>
            ) : <p className="muted small">Nothing yet.</p>)}
          </section>
        </div>
      </div>
    </div>
  );
}
export { cardTitle };
