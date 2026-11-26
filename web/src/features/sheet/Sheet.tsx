// One player's sheet. The owner arranges it (add, move, widen, hide, rename,
// remove modules) and fills it in; the DM reads it (without the private
// modules) and can change health and mana from it. Built-in modules show
// live data: health, mana, the pack, and recently seen people and places.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, Modal, useAction, useToast } from '../../ui/index.tsx';
import { AskModal, FromDm, PeopleMod, PersonModal, useCanAsk, type Person, type Subject } from './people.tsx';
import { CAN_BE_PRIVATE, CONDITIONS, ChangeLog, HpBar, KINDS, ManaMeter, SINGLE, type Module, type ModuleType, type Sheet as SheetT } from './shared.tsx';

const uid = () => Math.random().toString(36).slice(2, 10);
const EVENTS = ['sheet', 'spells-char', 'combat', 'settings'];

export default function Sheet({ account }: { account: string }) {
  const { w, info, isDM, me } = useWorld();
  const sheet = useLoad<SheetT>(() => w.call('GET', `/sheet/${account}`), [w, account], EVENTS);
  const [mods, setMods] = useState<Module[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [asking, setAsking] = useState<Subject | null>(null);
  const [adding1, setAdding1] = useState<Partial<Person> | null>(null);
  const canAsk = useCanAsk();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const own = account === 'me' || account === me;

  // Local copy of the modules: edits show at once and save a moment later. The owner's copy is the truth once loaded
  // (a reload racing a save must not bring back an older layout); the DM's follows the server.
  useEffect(() => { if (sheet.data && (!own || mods === null)) setMods(sheet.data.modules); }, [sheet.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const persist = (next: Module[], wait = 600) => {
    setMods(next);
    if (!own) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      void act.run(async () => { await w.call('PUT', '/sheet/me/modules', { modules: next }); });
    }, wait);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  if (sheet.loading && !sheet.data) return <Loading />;
  if (!sheet.data || !mods) return <ErrorBox error={sheet.error ?? 'No sheet'} />;
  const s = sheet.data;
  const update = (id: string, patch: Partial<Module>, wait?: number) => persist(mods.map((m) => (m.id === id ? { ...m, ...patch } : m)), wait);
  const move = (i: number, by: number) => { const j = i + by; if (j < 0 || j >= mods.length) return; const next = [...mods]; [next[i], next[j]] = [next[j], next[i]]; persist(next, 0); };
  const remove = (m: Module) => { if (window.confirm(`Remove “${m.title}” from your sheet?`)) persist(mods.filter((x) => x.id !== m.id), 0); };
  const add = (type: ModuleType) => {
    const k = KINDS.find((x) => x.type === type)!;
    const data = type === 'notes' || type === 'text' ? { text: '' } : ['contacts', 'counters', 'list'].includes(type) ? { entries: [] } : undefined;
    persist([...mods, { id: `${type}-${uid()}`, type, title: k.label, wide: false, private: false, collapsed: false, ...(data ? { data } : {}) }], 0);
    setAdding(false);
  };
  const vitals = (body: Record<string, unknown>) => act.run(async () => {
    const out = await w.call<any>('POST', `/sheet/${account}/vitals`, body);
    await sheet.reload();
    if (out?.notes?.length) toast(out.notes.join('; '));
  });
  const mana = (body: Record<string, unknown>) => act.run(async () => { await w.call('POST', `/sheet/${account}/mana`, body); await sheet.reload(); });
  const firstContacts = mods.find((m) => m.type === 'contacts');
  /** From Recently: add someone to the first People module (made if there is none). */
  const saveContact = (p: Omit<Person, 'id'>) => {
    const entry = { ...p, id: uid() };
    if (!firstContacts) { persist([...mods, { id: `contacts-${uid()}`, type: 'contacts', title: 'People', wide: false, private: false, collapsed: false, data: { entries: [entry] } }], 0); }
    else {
      const entries: Person[] = firstContacts.data?.entries ?? [];
      if (entries.some((e) => e.name.toLowerCase() === p.name.toLowerCase())) return toast(`${p.name} is already on your list`);
      update(firstContacts.id, { data: { entries: [...entries, entry] } }, 0);
    }
    toast(`${p.name} added`);
  };
  const manaOn = (info.settings as any).spellMana === true;

  return (
    <div className="stack" data-testid="sheet">
      <div className="row between" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="row" style={{ gap: 8 }}>
          <strong style={{ fontSize: 18 }}>{s.name}</strong>
          {isDM && !own && <span className="tiny faint">played by {s.player}</span>}
        </span>
        <span className="row" style={{ gap: 6 }}>
          <button type="button" className={`btn small${showLog ? ' on' : ''}`} onClick={() => setShowLog((v) => !v)}><i className="fa-solid fa-clock-rotate-left" aria-hidden="true" /> Log</button>
          {own && <button type="button" className={`btn small${editing ? ' on' : ''}`} data-testid="sheet-edit" onClick={() => { setEditing((v) => !v); setAdding(false); }}>{editing ? 'Done' : 'Arrange'}</button>}
        </span>
      </div>
      <ErrorBox error={act.error} />
      <FromDm account={own ? me : account} notes={s.fromDm ?? []} dm={isDM && !own} onChanged={() => void sheet.reload()} />
      {showLog && <section className="card sht-mod"><h3 style={{ margin: 0, fontSize: 15 }}>HP and mana changes</h3><ChangeLog account={own ? me : account} /></section>}
      <div className="sht-grid">
        {mods.map((m, i) => (
          <section key={m.id} className={`card sht-mod${m.wide ? ' wide' : ''}${editing ? ' editing' : ''}`} data-testid={`mod-${m.type}`}>
            <div className="card-head">
              {editing
                ? <input className="sht-in" aria-label="Module title" value={m.title} maxLength={60} onChange={(e) => update(m.id, { title: e.target.value })} style={{ flex: 1 }} />
                : <h3><i className={`fa-solid ${KINDS.find((k) => k.type === m.type)?.icon}`} aria-hidden="true" />{m.title}{m.private && <i className="fa-solid fa-lock faint" title="Only you see this" aria-label="Private" />}</h3>}
              <span className="row" style={{ gap: 2 }}>
                {editing ? <>
                  <button type="button" className="btn small ghost" aria-label={`Move ${m.title} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn small ghost" aria-label={`Move ${m.title} down`} disabled={i === mods.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className={`btn small ghost${m.wide ? ' on' : ''}`} aria-pressed={m.wide} title="Wide" onClick={() => update(m.id, { wide: !m.wide }, 0)}><i className="fa-solid fa-left-right" aria-hidden="true" /><span className="sr-only">Wide</span></button>
                  {CAN_BE_PRIVATE.includes(m.type) && <button type="button" className={`btn small ghost${m.private ? ' on' : ''}`} aria-pressed={m.private} title="Only me (hidden from the DM too)" onClick={() => update(m.id, { private: !m.private }, 0)}><i className="fa-solid fa-lock" aria-hidden="true" /><span className="sr-only">Private</span></button>}
                  <button type="button" className="btn small ghost" aria-label={`Remove ${m.title}`} onClick={() => remove(m)}>✕</button>
                </> : <button type="button" className="btn small ghost" aria-expanded={!m.collapsed} aria-label={m.collapsed ? `Show ${m.title}` : `Fold ${m.title}`} onClick={() => update(m.id, { collapsed: !m.collapsed }, 0)}>{m.collapsed ? '▸' : '▾'}</button>}
              </span>
            </div>
            {!m.collapsed && (
              m.type === 'vitals' ? <Vitals s={s} onChange={vitals} busy={act.busy} />
              : m.type === 'mana' ? (manaOn ? <ManaMod s={s} onChange={mana} busy={act.busy} /> : <p className="tiny muted">Mana is off in this world.</p>)
              : m.type === 'inventory' ? <Inventory account={account} own={own} />
              : m.type === 'recent' ? <RecentMod account={account} onAdd={own ? (x) => setAdding1(x) : undefined} onAsk={own && canAsk ? setAsking : undefined} />
              : m.type === 'contacts' ? <PeopleMod entries={m.data?.entries ?? []} readOnly={!own} onChange={(entries) => update(m.id, { data: { entries } }, 0)} onAsk={own && canAsk ? setAsking : undefined} />
              : <Editable m={m} readOnly={!own} onData={(data, wait) => update(m.id, { data }, wait)} />
            )}
          </section>
        ))}
      </div>
      {own && editing && (adding
        ? <section className="card sht-mod"><div className="card-head"><h3>Add a module</h3><button type="button" className="btn small ghost" onClick={() => setAdding(false)}>Cancel</button></div>
            <div className="sht-add">{KINDS.filter((k) => !SINGLE.includes(k.type) || !mods.some((m) => m.type === k.type)).map((k) => (
              <button key={k.type} type="button" className="btn" onClick={() => add(k.type)} data-testid={`add-${k.type}`}><strong><i className={`fa-solid ${k.icon}`} aria-hidden="true" /> {k.label}</strong><span className="tiny muted">{k.desc}</span></button>
            ))}</div></section>
        : <button type="button" className="btn" onClick={() => setAdding(true)} data-testid="sheet-add">＋ Add a module</button>)}
      {asking && <AskModal subject={asking} onClose={() => setAsking(null)} />}
      {adding1 && <PersonModal person={adding1} onClose={() => setAdding1(null)} onSave={(p) => { saveContact(p); setAdding1(null); }} />}
      {!mods.length && <Empty>This sheet has no modules. {own ? 'Tap Arrange to add some.' : ''}</Empty>}
      {toastNode}
    </div>
  );
}

// ---- health ----

function Vitals({ s, onChange, busy }: { s: SheetT; onChange: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [n, setN] = useState('');
  const [setup, setSetup] = useState(false);
  const [cond, setCond] = useState('');
  const amt = Number(n);
  const okAmt = n !== '' && Number.isInteger(amt) && amt > 0;
  const go = (k: 'damage' | 'heal' | 'tempHp') => { if (okAmt) { onChange({ [k]: amt }); setN(''); } };
  const addCond = (c: string) => { const v = c.trim(); if (v && !s.conditions.some((x) => x.toLowerCase() === v.toLowerCase())) onChange({ conditions: [...s.conditions, v] }); setCond(''); };
  return (
    <div className="stack tight">
      {s.hp === null && s.maxHp === null && !setup
        ? <button type="button" className="btn small" onClick={() => setSetup(true)}>Set your HP</button>
        : <>
          <div className="row between">
            <span className="sht-big" data-testid="hp">{s.hp ?? '—'}<span className="muted" style={{ fontSize: 15 }}> / {s.maxHp ?? '—'}</span></span>
            <span className="row" style={{ gap: 6 }}>
              {s.tempHp > 0 && <span className="chip teal" title="Temporary HP">+{s.tempHp} temp</span>}
              <button type="button" className="btn small ghost" onClick={() => setSetup((v) => !v)} aria-label="Set HP and max HP"><i className="fa-solid fa-sliders" aria-hidden="true" /></button>
            </span>
          </div>
          <HpBar hp={s.hp} maxHp={s.maxHp} tempHp={s.tempHp} />
          {s.hp === 0 && <span className="small" style={{ color: 'var(--danger-text)' }}>Down at 0 HP: death saves.</span>}
        </>}
      {setup && <SetHp s={s} onSave={(b) => { onChange(b); setSetup(false); }} />}
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <input className="sht-num" inputMode="numeric" aria-label="Amount" placeholder="0" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter') go('damage'); }} />
        <button type="button" className="btn small danger" disabled={busy || !okAmt} onClick={() => go('damage')}>Damage</button>
        <button type="button" className="btn small" disabled={busy || !okAmt} onClick={() => go('heal')}>Heal</button>
        <button type="button" className="btn small" disabled={busy || !okAmt} onClick={() => go('tempHp')} title="Temporary HP do not stack: the higher amount stays">Temp</button>
      </div>
      <div className="sht-chips" aria-label="Conditions">
        {s.conditions.map((c) => <span key={c} className="chip gold">{c}<button type="button" aria-label={`Remove ${c}`} onClick={() => onChange({ conditions: s.conditions.filter((x) => x !== c) })}>✕</button></span>)}
        <input className="sht-in" list="sht-conditions" placeholder="+ condition" aria-label="Add a condition" value={cond} maxLength={40} style={{ width: 120, minHeight: 26, fontSize: 13 }}
          onChange={(e) => { const v = e.target.value; if (CONDITIONS.includes(v)) addCond(v); else setCond(v); }} onKeyDown={(e) => { if (e.key === 'Enter') addCond(cond); }} />
        <datalist id="sht-conditions">{CONDITIONS.filter((c) => !s.conditions.includes(c)).map((c) => <option key={c} value={c} />)}</datalist>
      </div>
    </div>
  );
}

function SetHp({ s, onSave }: { s: SheetT; onSave: (b: Record<string, unknown>) => void }) {
  const [hp, setHp] = useState(s.hp === null ? '' : String(s.hp));
  const [max, setMax] = useState(s.maxHp === null ? '' : String(s.maxHp));
  const [temp, setTemp] = useState(String(s.tempHp));
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label className="tiny muted stack tight">HP<input className="sht-tiny-num" inputMode="numeric" value={hp} onChange={(e) => setHp(e.target.value.replace(/[^\d-]/g, ''))} /></label>
      <label className="tiny muted stack tight">Max<input className="sht-tiny-num" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/[^\d]/g, ''))} /></label>
      <label className="tiny muted stack tight">Temp<input className="sht-tiny-num" inputMode="numeric" value={temp} onChange={(e) => setTemp(e.target.value.replace(/[^\d]/g, ''))} /></label>
      <button type="button" className="btn small primary" onClick={() => onSave({ maxHp: num(max), hp: num(hp) ?? num(max), setTempHp: Number(temp) || 0, note: 'Set on the sheet' })}>Save</button>
    </div>
  );
}

// ---- mana (the spells feature keeps the numbers) ----

function ManaMod({ s, onChange, busy }: { s: SheetT; onChange: (b: Record<string, unknown>) => void; busy: boolean }) {
  const [n, setN] = useState('');
  const [note, setNote] = useState('');
  if (!s.mana.on) return <p className="tiny muted">Mana is off in this world.</p>;
  if (s.mana.max === null || s.mana.max === undefined) return <p className="tiny muted">Set your level in the <Link to="../codex">Codex</Link> to get a mana pool.</p>;
  const amt = Number(n);
  const okAmt = n !== '' && Number.isInteger(amt) && amt > 0;
  const go = (sign: 1 | -1) => { if (okAmt) { onChange({ delta: sign * amt, ...(note.trim() ? { note: note.trim() } : {}) }); setN(''); setNote(''); } };
  return (
    <div className="stack tight">
      <span className="sht-big" data-testid="mana-now">{s.mana.now ?? s.mana.max}<span className="muted" style={{ fontSize: 15 }}> / {s.mana.max}</span></span>
      <ManaMeter mana={s.mana} />
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        <input className="sht-num" inputMode="numeric" aria-label="Mana amount" placeholder="0" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))} />
        <button type="button" className="btn small" disabled={busy || !okAmt} onClick={() => go(-1)}>Spend</button>
        <button type="button" className="btn small" disabled={busy || !okAmt} onClick={() => go(1)}>Restore</button>
      </div>
      {n && <input className="sht-in" placeholder="Why (a potion, a scroll…)" aria-label="Why" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />}
      <span className="tiny faint">Casting from the <Link to="../codex">Codex</Link> spends mana on its own.</span>
    </div>
  );
}

// ---- inventory (read from the pack) ----

function Inventory({ account, own }: { account: string; own: boolean }) {
  const { w } = useWorld();
  const inv = useLoad<any>(() => w.call('GET', '/inventory', undefined, { owner: own ? 'me' : account }), [w, account, own], ['item', 'item-moved', 'item-removed', 'approval', 'transfer']);
  if (inv.loading && !inv.data) return <Loading />;
  const items = (inv.data?.items ?? []).filter((it: any) => it.status !== 'pending');
  return (
    <div className="stack tight">
      {items.length ? <ul className="sht-list">{items.slice(0, 30).map((it: any) => <li key={it.id}><span className="grow small">{it.name}</span>{it.qty !== 1 && <span className="tiny muted">×{it.qty}</span>}</li>)}</ul> : <span className="tiny muted">Nothing in the pack.</span>}
      {items.length > 30 && <span className="tiny faint">and {items.length - 30} more</span>}
      {own && <Link className="tiny" to="../inventory">Open inventory</Link>}
    </div>
  );
}

// ---- recently seen people and places ----

function RecentMod({ account, onAdd, onAsk }: { account: string; onAdd?: (p: Partial<Person>) => void; onAsk?: (s: Subject) => void }) {
  const { w } = useWorld();
  const rec = useLoad<any>(() => w.call('GET', `/sheet/${account}/recent`), [w, account], ['sessionlog', 'person']);
  if (rec.loading && !rec.data) return <Loading />;
  const people = rec.data?.people ?? [], places = rec.data?.places ?? [], factions = rec.data?.factions ?? [];
  if (!people.length && !places.length && !factions.length) return <span className="tiny muted">Names show up here after the DM publishes a session summary.</span>;
  const part = (title: string, icon: string, list: any[], what: Subject['what']): ReactNode => list.length > 0 && (
    <div className="stack tight">
      <span className="tiny faint"><i className={`fa-solid ${icon}`} aria-hidden="true" /> {title}</span>
      <ul className="sht-list">{list.map((x: any) => (
        <li key={x.name}>
          <span className="grow small" title={`Session ${x.session}: ${x.sessionTitle}`}>{x.pageId ? <Link to={`../library?page=${encodeURIComponent(x.pageId)}`}>{x.name}</Link> : x.name}</span>
          <span className="tiny faint" title={x.sessionTitle}>#{x.session}</span>
          {onAsk && <button type="button" className="btn small ghost" title="Ask the broker" aria-label={`Ask the broker about ${x.name}`} onClick={() => onAsk({ name: x.name, what, pageId: x.pageId })}><i className="fa-solid fa-comment-dots" aria-hidden="true" /></button>}
          {what === 'person' && onAdd && <button type="button" className="btn small ghost" title="Add to my people" aria-label={`Add ${x.name} to my people`} onClick={() => onAdd({ name: x.name, kind: 'ally', note: '', pageId: x.pageId, personId: x.personId })}><i className="fa-solid fa-user-plus" aria-hidden="true" /></button>}
        </li>
      ))}</ul>
    </div>
  );
  return <div className="stack tight">{part('People', 'fa-user', people, 'person')}{part('Places', 'fa-location-dot', places, 'place')}{part('Factions', 'fa-flag', factions, 'faction')}</div>;
}

// ---- the modules a player fills in ----

function Editable({ m, readOnly, onData }: { m: Module; readOnly: boolean; onData: (data: any, wait?: number) => void }) {
  const entries: any[] = m.data?.entries ?? [];
  const setEntries = (next: any[], wait = 0) => onData({ entries: next }, wait);
  const [draft, setDraft] = useState('');

  if (m.type === 'notes' || m.type === 'text') {
    return readOnly
      ? <p className="small" style={{ whiteSpace: 'pre-line', margin: 0 }}>{m.data?.text || <span className="faint">Empty</span>}</p>
      : <textarea aria-label={m.title} value={m.data?.text ?? ''} maxLength={10_000} placeholder={m.type === 'notes' ? 'Names, clues, the innkeeper’s riddle…' : ''} onChange={(e) => onData({ text: e.target.value })} />;
  }

  if (m.type === 'counters') {
    const bump = (e: any, by: number) => setEntries(entries.map((x) => (x.id === e.id ? { ...x, value: Math.max(-9999, Math.min(x.max ?? 99999, x.value + by)) } : x)), 400);
    const addOne = () => { const n = draft.trim(); if (!n) return; setEntries([...entries, { id: uid(), label: n, value: 0, max: null }]); setDraft(''); };
    return (
      <div className="stack tight">
        {!entries.length && <span className="tiny muted">No counters yet.</span>}
        <ul className="sht-list">{entries.map((e) => (
          <li key={e.id}>
            <span className="grow small">{e.label}</span>
            {!readOnly && <button type="button" className="btn small ghost" aria-label={`${e.label} minus one`} onClick={() => bump(e, -1)}>−</button>}
            <strong style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28, textAlign: 'center' }}>{e.value}{e.max !== null && <span className="muted tiny">/{e.max}</span>}</strong>
            {!readOnly && <button type="button" className="btn small ghost" aria-label={`${e.label} plus one`} onClick={() => bump(e, 1)}>＋</button>}
            {!readOnly && <button type="button" className="btn small ghost" aria-label={`Set a maximum for ${e.label}`} onClick={() => { const v = window.prompt(`Maximum for ${e.label} (empty for none)`, e.max === null ? '' : String(e.max)); if (v === null) return; const n = v.trim() === '' ? null : Math.max(0, parseInt(v, 10) || 0); setEntries(entries.map((x) => (x.id === e.id ? { ...x, max: n, value: n !== null ? Math.min(x.value, n) : x.value } : x))); }}>max</button>}
            {!readOnly && <button type="button" className="btn small ghost" aria-label={`Remove ${e.label}`} onClick={() => setEntries(entries.filter((x) => x.id !== e.id))}>✕</button>}
          </li>
        ))}</ul>
        {!readOnly && <div className="row" style={{ gap: 4 }}><input className="sht-in" style={{ flex: 1 }} placeholder="Inspiration, hit dice, arrows…" aria-label="New counter" value={draft} maxLength={40} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addOne(); }} /><button type="button" className="btn small" disabled={!draft.trim()} onClick={addOne}>Add</button></div>}
      </div>
    );
  }

  // checklist
  const addOne = () => { const n = draft.trim(); if (!n) return; setEntries([...entries, { id: uid(), text: n, done: false }]); setDraft(''); };
  return (
    <div className="stack tight">
      {!entries.length && <span className="tiny muted">Nothing on the list.</span>}
      <ul className="sht-list">{entries.map((e) => (
        <li key={e.id}>
          <input type="checkbox" checked={e.done} disabled={readOnly} aria-label={e.text} onChange={() => setEntries(entries.map((x) => (x.id === e.id ? { ...x, done: !x.done } : x)))} />
          <span className="grow small" style={e.done ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{e.text}</span>
          {!readOnly && <button type="button" className="btn small ghost" aria-label={`Remove ${e.text}`} onClick={() => setEntries(entries.filter((x) => x.id !== e.id))}>✕</button>}
        </li>
      ))}</ul>
      {!readOnly && <div className="row" style={{ gap: 4 }}><input className="sht-in" style={{ flex: 1 }} placeholder="Add an item" aria-label="New item" value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addOne(); }} /><button type="button" className="btn small" disabled={!draft.trim()} onClick={addOne}>Add</button></div>}
    </div>
  );
}
