// The sheet's people: who the character knows (allies, enemies, everyone in
// between), each optionally linked to a library page (LegendKeeper, Kanka
// and the rest import into the library), "Ask the broker" about a person,
// place or faction with a question the player can rewrite, and the notes and
// goals the GM leaves for one player.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWorld } from '../../lib/world.tsx';
import { isOff } from '../../lib/playerNav.ts';
import { PagePicker } from '../itemcards/PagePicker.tsx';
import { ErrorBox, Modal, useAction } from '../../ui/index.tsx';

export type Relation = 'ally' | 'enemy' | 'neutral';
export interface Person { id: string; name: string; kind: Relation; note: string; pageId?: string; personId?: string }
export type Subject = { name: string; what: 'person' | 'place' | 'faction'; pageId?: string };

const REL: Record<Relation, { label: string; icon: string; tone: string }> = {
  ally: { label: 'Ally', icon: 'fa-handshake', tone: 'ok' },
  enemy: { label: 'Enemy', icon: 'fa-skull', tone: 'bad' },
  neutral: { label: 'Other', icon: 'fa-circle-question', tone: 'mid' },
};
const uid = () => Math.random().toString(36).slice(2, 10);
const libraryHref = (pageId: string) => `../library?page=${encodeURIComponent(pageId)}`;

/** Whether this viewer can ask the broker here (players only, and only when the world uses it). */
export function useCanAsk() {
  const { isDM, info } = useWorld();
  return !isDM && !isOff('broker', info.settings);
}

// ---- the people module ----

export function PeopleMod({ entries, readOnly, onChange, onAsk }: { entries: Person[]; readOnly: boolean; onChange: (next: Person[]) => void; onAsk?: (s: Subject) => void }) {
  const [filter, setFilter] = useState<'all' | Relation>('all');
  const [edit, setEdit] = useState<Partial<Person> | null>(null);
  const [q, setQ] = useState('');
  const count = (k: Relation) => entries.filter((e) => e.kind === k).length;
  const needle = q.trim().toLowerCase();
  const shown = entries.filter((e) => (filter === 'all' || e.kind === filter) && (!needle || `${e.name} ${e.note}`.toLowerCase().includes(needle)))
    .sort((a, b) => (['ally', 'enemy', 'neutral'].indexOf(a.kind) - ['ally', 'enemy', 'neutral'].indexOf(b.kind)) || a.name.localeCompare(b.name));
  return (
    <div className="stack tight">
      {entries.length > 0 && (
        <div className="sht-seg" role="tablist" aria-label="Show">
          {([['all', `All ${entries.length}`], ['ally', `Allies ${count('ally')}`], ['enemy', `Enemies ${count('enemy')}`], ['neutral', `Others ${count('neutral')}`]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      )}
      {entries.length > 6 && <input className="sht-in" type="search" placeholder={`Find among ${entries.length} people`} aria-label="Find a person" value={q} onChange={(e) => setQ(e.target.value)} />}
      {needle && !shown.length && <span className="tiny muted">Nobody matches.</span>}
      {!entries.length && <span className="tiny muted">Nobody yet. Add the people your character knows, or add them from Recently.</span>}
      <ul className={`sht-people${shown.length > 5 ? ' sht-scroll' : ''}`}>
        {shown.map((p) => (
          // Tap a person to edit them (the name link and Ask keep their own job).
          <li key={p.id} className={`rel-${REL[p.kind].tone}${readOnly ? '' : ' tap'}`} onClick={readOnly ? undefined : (e) => { if (!(e.target as HTMLElement).closest('a, button')) setEdit(p); }}>
            {readOnly ? <span className="sht-av" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
              : <button type="button" className="sht-av" aria-label={`Edit ${p.name}`} title="Edit" onClick={() => setEdit(p)}>{p.name.slice(0, 1).toUpperCase()}</button>}
            <span className="grow stack" style={{ gap: 0, minWidth: 0 }}>
              <span className="row" style={{ gap: 6, minWidth: 0 }}>
                {p.pageId ? <Link className="sht-pname" to={libraryHref(p.pageId)} title="Open their page">{p.name} <i className="fa-solid fa-book-open tiny" aria-hidden="true" /></Link> : <strong className="sht-pname">{p.name}</strong>}
              </span>
              <span className="tiny muted sht-pnote"><i className={`fa-solid ${REL[p.kind].icon}`} aria-hidden="true" /> {REL[p.kind].label}{p.note ? ` · ${p.note}` : ''}</span>
            </span>
            {onAsk && <button type="button" className="btn small" title="Ask the broker about them" aria-label={`Ask the broker about ${p.name}`} onClick={() => onAsk({ name: p.name, what: 'person', pageId: p.pageId })}>Ask</button>}
          </li>
        ))}
      </ul>
      {!readOnly && <button type="button" className="btn small" data-testid="person-add" onClick={() => setEdit({ kind: filter === 'all' ? 'ally' : filter, name: '', note: '' })}>＋ Add someone</button>}
      {edit && (
        <PersonModal person={edit} onClose={() => setEdit(null)}
          onRemove={edit.id ? () => { onChange(entries.filter((x) => x.id !== edit.id)); setEdit(null); } : undefined}
          onSave={(p) => { onChange(edit.id ? entries.map((x) => (x.id === edit.id ? { ...x, ...p } : x)) : [...entries, { ...p, id: uid() }]); setEdit(null); }} />
      )}
    </div>
  );
}

/** Add or edit one person: name, who they are to you, a linked library page, a note. */
export function PersonModal({ person, onClose, onSave, onRemove }: { person: Partial<Person>; onClose: () => void; onSave: (p: Omit<Person, 'id'>) => void; onRemove?: () => void }) {
  const [p, setP] = useState<Partial<Person>>(person);
  const name = (p.name ?? '').trim();
  return (
    <Modal title={person.id ? `Edit ${person.name}` : 'Add someone'} onClose={onClose}>
      <label className="field"><span className="label">Name</span><input value={p.name ?? ''} maxLength={80} autoFocus onChange={(e) => setP({ ...p, name: e.target.value })} /></label>
      <div className="stack tight">
        <span className="small" style={{ fontWeight: 500 }}>Who they are to you</span>
        <div className="sht-seg" role="radiogroup" aria-label="Who they are to you">
          {(Object.keys(REL) as Relation[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={p.kind === k} className={p.kind === k ? 'on' : ''} onClick={() => setP({ ...p, kind: k })}><i className={`fa-solid ${REL[k].icon}`} aria-hidden="true" /> {REL[k].label}</button>
          ))}
        </div>
      </div>
      <PagePicker value={p.pageId ?? null} label="Their page (optional)" help="A library page you can open, including pages imported from LegendKeeper or Kanka"
        onChange={(id) => setP((cur) => ({ ...cur, pageId: id ?? undefined }))} onPick={(h) => setP((cur) => ({ ...cur, pageId: h.id, name: (cur.name ?? '').trim() ? cur.name : h.title }))} />
      <label className="field"><span className="label">Note</span><input value={p.note ?? ''} maxLength={300} placeholder="Owes us a favour, met at the docks…" onChange={(e) => setP({ ...p, note: e.target.value })} /></label>
      <div className="row between">
        {onRemove ? <button type="button" className="btn danger" onClick={onRemove}>Remove</button> : <span />}
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!name} onClick={() => onSave({ name, kind: (p.kind ?? 'ally') as Relation, note: (p.note ?? '').trim(), ...(p.pageId ? { pageId: p.pageId } : {}), ...(p.personId ? { personId: p.personId } : {}) })}>Save</button>
        </span>
      </div>
    </Modal>
  );
}

// ---- asking the broker ----

const SUGGEST: Record<Subject['what'], ((n: string) => string)[]> = {
  person: [(n) => `Who is ${n}, really?`, (n) => `Who does ${n} work for?`, (n) => `What does ${n} want?`, (n) => `Where can I find ${n}?`],
  place: [(n) => `What is ${n} known for?`, (n) => `Who runs ${n}?`, (n) => `What shops are in ${n}, and what do they sell?`, (n) => `Is ${n} dangerous?`],
  faction: [(n) => `What is ${n} after?`, (n) => `Who leads ${n}?`, (n) => `Is ${n} friend or foe to us?`, (n) => `How do I join ${n}?`],
};

/** A question about someone or somewhere, ready to edit, then on to the broker (who names the price as usual). */
export function AskModal({ subject, onClose }: { subject: Subject; onClose: () => void }) {
  const nav = useNavigate();
  const { info } = useWorld();
  const ideas = SUGGEST[subject.what].map((f) => f(subject.name));
  const [q, setQ] = useState(ideas[0]);
  return (
    <Modal title={`Ask the broker about ${subject.name}`} onClose={onClose}>
      <div className="stack tight">
        <span className="small" style={{ fontWeight: 500 }}>Start from an idea</span>
        <div className="sht-chips">{ideas.map((x) => <button key={x} type="button" className={`btn small${q === x ? ' on' : ''}`} onClick={() => setQ(x)}>{x}</button>)}</div>
      </div>
      <label className="field"><span className="label">Your question</span><textarea rows={3} maxLength={500} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <p className="tiny muted" style={{ margin: 0 }}>The broker names a price before anything is spent.{subject.pageId ? <> You can also <Link to={libraryHref(subject.pageId)} onClick={onClose}>read their page</Link> first.</> : null}</p>
      <div className="row end" style={{ gap: 6 }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={!q.trim()} data-testid="ask-go" onClick={() => nav(`/w/${info.slug}/broker?ask=${encodeURIComponent(q.trim())}`)}>Ask the broker</button>
      </div>
    </Modal>
  );
}

// ---- from the GM ----

export interface DmNote { id: string; kind: 'note' | 'goal'; text: string; done: boolean; createdAt: string; updatedAt: string }

/** Notes and goals the GM set for this player. Only that player and the GM see them; the player ticks goals. */
/** The body of the "From the GM" module. Notes the player has not seen yet carry a New tag. */
export function FromDm({ account, notes, dm, onChanged }: { account: string; notes: DmNote[]; dm: boolean; onChanged: () => void }) {
  const { w, info } = useWorld();
  const slug = info.slug;
  const act = useAction();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'note' | 'goal'>('goal');
  const [editing, setEditing] = useState<DmNote | null>(null);
  const seenKey = `sht-dm-seen:${slug ?? ''}:${account}`;
  const [seenAt] = useState(() => { try { return localStorage.getItem(seenKey) ?? ''; } catch { return ''; } });
  useEffect(() => { if (!dm) try { localStorage.setItem(seenKey, new Date().toISOString()); } catch { /* private mode */ } }, [dm, seenKey, notes]);
  const isNew = (n: DmNote) => !dm && !!seenAt && n.updatedAt > seenAt && !n.done;
  const call = (m: string, p: string, b?: unknown) => act.run(async () => { await w.call(m, `/sheet/${account}/dm-notes${p}`, b); onChanged(); });
  const goals = notes.filter((n) => n.kind === 'goal'), plain = notes.filter((n) => n.kind === 'note');
  const tag = (n: DmNote) => isNew(n) && <span className="chip gold" style={{ fontSize: 11 }}>New</span>;
  return (
    <div className="stack tight" data-testid="from-dm">
      <span className="tiny faint"><i className="fa-solid fa-eye-slash" aria-hidden="true" /> {dm ? 'Only this player sees these.' : 'Only you see these. The GM can add more at any time.'}</span>
      <ErrorBox error={act.error} />
      {!dm && !notes.length && <span className="tiny muted">Nothing yet. Secret notes and goals from the GM show up here.</span>}
      {goals.length > 0 && <div className="stack tight">
        <span className="tiny faint">Goals</span>
        <ul className="sht-list">{goals.map((g) => (
          <li key={g.id}>
            <input type="checkbox" checked={g.done} aria-label={g.text} onChange={() => void call('PATCH', `/${g.id}`, { done: !g.done })} />
            <span className="grow small" style={g.done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{g.text}</span>{tag(g)}
            {dm && <><button type="button" className="btn small ghost" aria-label="Edit" onClick={() => setEditing(g)}><i className="fa-solid fa-pen" aria-hidden="true" /></button><button type="button" className="btn small ghost" aria-label="Delete" onClick={() => void call('DELETE', `/${g.id}`)}>✕</button></>}
          </li>
        ))}</ul>
      </div>}
      {plain.length > 0 && <div className="stack tight">
        <span className="tiny faint">Notes</span>
        <ul className="sht-list">{plain.map((n) => (
          <li key={n.id} style={{ alignItems: 'flex-start' }}>
            <span className="grow small" style={{ whiteSpace: 'pre-line' }}>{n.text}</span>{tag(n)}
            {dm && <><button type="button" className="btn small ghost" aria-label="Edit" onClick={() => setEditing(n)}><i className="fa-solid fa-pen" aria-hidden="true" /></button><button type="button" className="btn small ghost" aria-label="Delete" onClick={() => void call('DELETE', `/${n.id}`)}>✕</button></>}
          </li>
        ))}</ul>
      </div>}
      {dm && (
        <div className="stack tight">
          {!notes.length && <span className="tiny muted">Leave this player a secret note or a goal. Nobody else sees it.</span>}
          <div className="row" style={{ gap: 4 }}>
            <select className="sht-in" aria-label="Note or goal" value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="goal">Goal</option><option value="note">Note</option></select>
            <input className="sht-in" style={{ flex: 1 }} aria-label="Text for the player" placeholder={kind === 'goal' ? 'Find out who lights the lamp' : 'You dream of a drowned bell…'} value={text} maxLength={2000}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { void call('POST', '', { kind, text: text.trim() }); setText(''); } }} />
            <button type="button" className="btn small primary" disabled={!text.trim() || act.busy} data-testid="dm-note-add" onClick={() => { void call('POST', '', { kind, text: text.trim() }); setText(''); }}>Add</button>
          </div>
        </div>
      )}
      {editing && (
        <Modal title={editing.kind === 'goal' ? 'Edit goal' : 'Edit note'} onClose={() => setEditing(null)}>
          <label className="field"><span className="label">Text</span><textarea rows={4} maxLength={2000} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} /></label>
          <div className="row end" style={{ gap: 6 }}>
            <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!editing.text.trim()} onClick={() => { void call('PATCH', `/${editing.id}`, { text: editing.text.trim() }); setEditing(null); }}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
