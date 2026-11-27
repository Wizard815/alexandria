// The random-event editor as blocks, like block coding, on the shared block kit
// (ui/blocks.tsx, also used by story events): each event is a block with its
// name and what happens, and a check block (skill and DC, or "no roll") whose
// pass and fail slots hold a line of text and effect pieces (coin, progress,
// damage, heal, exhaustion, an item, job fails) from the "+ Effect" palette.
// Folded, an event reads as one line of chips.
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { download } from '../../lib/offline.ts';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { Block, CheckBlock, Chip, PieceChips, Pieces, type PieceKind } from '../../ui/blocks.tsx';
import { NO_OUTCOME, type EventDef, type Outcome } from './shared.tsx';

type Piece =
  | { kind: 'coin'; cp: number } | { kind: 'progress'; days: number } | { kind: 'damage'; damage: number } | { kind: 'heal'; heal: number }
  | { kind: 'exhaustion'; exhaustion: number } | { kind: 'item'; item: string; qty: number } | { kind: 'nofail' };

const n = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || 0));
const numIn = (label: string, value: number, set: (v: string) => void, lo: number, hi: number, unit: string) => (
  <span className="row" style={{ gap: 4, alignItems: 'center' }}><input className="input blk-num-in" type="number" min={lo} max={hi} value={value} onChange={(e) => set(e.target.value)} aria-label={label} /> <span className="small">{unit}</span></span>
);
const KINDS: PieceKind<Piece>[] = [
  { kind: 'coin', label: 'Coin', icon: 'fa-coins', tone: 'gold', make: () => ({ kind: 'coin', cp: 500 }),
    edit: (p, set) => p.kind === 'coin' && <span className="row" style={{ gap: 4, alignItems: 'center' }}><input className="input blk-num-in" type="number" value={p.cp / 100} onChange={(e) => set({ ...p, cp: Math.round(Number(e.target.value) * 100) || 0 })} aria-label="Coin" /> <span className="small">gp (minus takes it)</span></span>,
    chip: (p) => p.kind === 'coin' && <Chip tone="gold" icon="fa-coins">{p.cp > 0 ? '+' : '−'}{Math.abs(p.cp) / 100} gp</Chip> },
  { kind: 'progress', label: 'Progress', icon: 'fa-hourglass-half', tone: 'teal', make: () => ({ kind: 'progress', days: 1 }),
    edit: (p, set) => p.kind === 'progress' && numIn('Progress days', p.days, (v) => set({ ...p, days: n(v, -3650, 3650) }), -3650, 3650, 'days (minus loses work)'),
    chip: (p) => p.kind === 'progress' && <Chip tone="teal" icon="fa-hourglass-half">{p.days > 0 ? '+' : '−'}{Math.abs(p.days)}d</Chip> },
  { kind: 'damage', label: 'Damage', icon: 'fa-burst', tone: 'red', make: () => ({ kind: 'damage', damage: 3 }),
    edit: (p, set) => p.kind === 'damage' && numIn('Damage', p.damage, (v) => set({ ...p, damage: n(v, 0, 500) }), 0, 500, 'damage'),
    chip: (p) => p.kind === 'damage' && <Chip tone="red" icon="fa-burst">{p.damage} dmg</Chip> },
  { kind: 'heal', label: 'Heal', icon: 'fa-heart', tone: 'green', make: () => ({ kind: 'heal', heal: 3 }),
    edit: (p, set) => p.kind === 'heal' && numIn('Heal', p.heal, (v) => set({ ...p, heal: n(v, 0, 500) }), 0, 500, 'HP back'),
    chip: (p) => p.kind === 'heal' && <Chip tone="green" icon="fa-heart">+{p.heal} HP</Chip> },
  { kind: 'exhaustion', label: 'Exhaustion', icon: 'fa-bed', tone: 'red', make: () => ({ kind: 'exhaustion', exhaustion: 1 }),
    edit: (p, set) => p.kind === 'exhaustion' && numIn('Exhaustion', p.exhaustion, (v) => set({ ...p, exhaustion: n(v, -6, 6) }), -6, 6, 'exhaustion levels'),
    chip: (p) => p.kind === 'exhaustion' && <Chip tone="red" icon="fa-bed">{p.exhaustion > 0 ? '+' : ''}{p.exhaustion} exh</Chip> },
  { kind: 'item', label: 'Item', icon: 'fa-gift', tone: 'gold', make: () => ({ kind: 'item', item: '', qty: 1 }),
    edit: (p, set) => p.kind === 'item' && <span className="row" style={{ gap: 4, alignItems: 'center', flex: '1 1 200px' }}><input className="input blk-grow" value={p.item} maxLength={120} placeholder="Item name" onChange={(e) => set({ ...p, item: e.target.value })} aria-label="Item" /> ×<input className="input blk-num-in" type="number" min={1} max={999} value={p.qty} onChange={(e) => set({ ...p, qty: Math.max(1, n(e.target.value, 1, 999)) })} aria-label="How many" /></span>,
    chip: (p) => p.kind === 'item' && <Chip tone="gold" icon="fa-gift">{p.qty > 1 ? `${p.qty} × ` : ''}{p.item || 'item'}</Chip> },
];
const NOFAIL: PieceKind<Piece> = { kind: 'nofail', label: 'Job fails', icon: 'fa-ban', tone: 'red', make: () => ({ kind: 'nofail' }),
  edit: () => <span className="small">The job fails: no reward for the task</span>, chip: () => <Chip tone="red" icon="fa-ban">no pay</Chip> };

/** An outcome object as pieces, and back. */
const toPieces = (o: Outcome): Piece[] => [
  ...(o.cp ? [{ kind: 'coin', cp: o.cp } as Piece] : []), ...(o.days ? [{ kind: 'progress', days: o.days } as Piece] : []),
  ...(o.damage ? [{ kind: 'damage', damage: o.damage } as Piece] : []), ...(o.heal ? [{ kind: 'heal', heal: o.heal } as Piece] : []),
  ...(o.exhaustion ? [{ kind: 'exhaustion', exhaustion: o.exhaustion } as Piece] : []), ...(o.item ? [{ kind: 'item', item: o.item, qty: o.qty } as Piece] : []),
  ...(o.noReward ? [{ kind: 'nofail' } as Piece] : []),
];
const fromPieces = (text: string, ps: Piece[]): Outcome => ps.reduce<Outcome>((o, p) => {
  switch (p.kind) {
    case 'coin': return { ...o, cp: p.cp };
    case 'progress': return { ...o, days: p.days };
    case 'damage': return { ...o, damage: p.damage };
    case 'heal': return { ...o, heal: p.heal };
    case 'exhaustion': return { ...o, exhaustion: p.exhaustion };
    case 'item': return { ...o, item: p.item || 'Item', qty: p.qty };
    case 'nofail': return { ...o, noReward: true };
  }
}, { ...NO_OUTCOME, text });

/** What a pass or a fail does: a line of text and effect pieces (each kind once). */
function OutcomeSlot({ o, set, fail, label }: { o: Outcome; set: (o: Outcome) => void; fail: boolean; label: string }) {
  const pieces = toPieces(o);
  const kinds = fail ? [...KINDS, NOFAIL] : KINDS;
  const free = kinds.filter((k) => !pieces.some((p) => p.kind === k.kind));
  return (
    <>
      <input className="input" value={o.text} maxLength={300} onChange={(e) => set({ ...o, text: e.target.value })} placeholder={fail ? 'Bitten and chased off' : 'You clear them out'} aria-label={`${label} text`} />
      <Pieces<Piece> pieces={pieces} kinds={kinds} max={pieces.length + free.length} addLabel={`+ Effect`} onChange={(ps) => {
        // One of each kind: picking a kind again replaces it.
        const one = ps.filter((p, i) => ps.map((q) => q.kind).lastIndexOf(p.kind) === i);
        set(fromPieces(o.text, one));
      }} />
    </>
  );
}

const STARTERS: { label: string; icon: string; make: () => EventDef }[] = [
  { label: 'A fight', icon: 'fa-hand-fist', make: () => ({ title: 'Trouble!', text: '', check: 'Athletics', dc: 12, success: { ...NO_OUTCOME, text: 'You win', cp: 300 }, failure: { ...NO_OUTCOME, text: 'You get hurt', damage: 3 } }) },
  { label: 'Spot something', icon: 'fa-eye', make: () => ({ title: 'Something hidden', text: '', check: 'Perception', dc: 13, success: { ...NO_OUTCOME, text: 'You find it', cp: 500 }, failure: { ...NO_OUTCOME, text: 'You miss it' } }) },
  { label: 'A talk', icon: 'fa-comments', make: () => ({ title: 'A stranger', text: '', check: 'Persuasion', dc: 12, success: { ...NO_OUTCOME, text: 'A friend made' }, failure: { ...NO_OUTCOME, text: 'It goes badly', cp: -200 } }) },
  { label: 'It just happens', icon: 'fa-clover', make: () => ({ title: 'A lucky day', text: '', check: '', dc: 12, success: { ...NO_OUTCOME, text: 'Something good', cp: 200 }, failure: { ...NO_OUTCOME } }) },
  { label: 'Blank', icon: 'fa-plus', make: () => ({ title: '', text: '', check: '', dc: 12, success: { ...NO_OUTCOME }, failure: { ...NO_OUTCOME } }) },
];

/** One event as blocks: its name and what happens, then the check with what a pass and a fail do. Folded, one line. */
function EventStack({ e, open, toggle, set, remove, move, first, last }: { e: EventDef; open: boolean; toggle: () => void; set: (e: EventDef) => void; remove: () => void; move: (by: number) => void; first: boolean; last: boolean }) {
  const roll = !!e.check;
  return (
    <Block tone="gold" edit testid="dt-event-block">
      <i className="fa-solid fa-bolt blk-ico" aria-hidden="true" />
      <button type="button" className="btn ghost small" onClick={toggle} aria-expanded={open} aria-label={open ? 'Fold' : 'Open'}>{open ? '▾' : '▸'}</button>
      <input className="input blk-grow" value={e.title} maxLength={80} onChange={(ev) => set({ ...e, title: ev.target.value })} placeholder="Rats in the cellar!" aria-label="Event title" />
      <button type="button" className="btn ghost small" disabled={first} onClick={() => move(-1)} aria-label="Move up">↑</button>
      <button type="button" className="btn ghost small" disabled={last} onClick={() => move(1)} aria-label="Move down">↓</button>
      <button type="button" className="btn ghost small" onClick={remove} aria-label={`Remove ${e.title || 'event'}`}>✕</button>
      {!open && (
        <span className="blk-outcomes" style={{ flexBasis: '100%' }}>
          {roll ? <Chip tone="teal" icon="fa-dice-d20">{e.check} DC {e.dc}</Chip> : <Chip icon="fa-bolt">just happens</Chip>}
          <span className="blk-ok">✓</span> <PieceChips pieces={toPieces(e.success)} kinds={KINDS} />{!toPieces(e.success).length && <span className="small muted">{e.success.text || 'nothing'}</span>}
          {roll && <><span className="blk-bad">✗</span> <PieceChips pieces={toPieces(e.failure)} kinds={[...KINDS, NOFAIL]} />{!toPieces(e.failure).length && <span className="small muted">{e.failure.text || 'nothing'}</span>}</>}
        </span>
      )}
      {open && (
        <div className="stack tight" style={{ flexBasis: '100%' }}>
          <input className="input" value={e.text} maxLength={400} onChange={(ev) => set({ ...e, text: ev.target.value })} placeholder="What happens: a swarm of rats boils out of a broken barrel." aria-label="What happens" />
          <CheckBlock skill={e.check || null} dc={e.dc} dcMax={null} range={false} noRoll={!roll}
            onNoRoll={(v) => set({ ...e, check: v ? '' : e.check || 'Athletics' })}
            onChange={(v) => set({ ...e, check: v.skill ?? '', dc: Math.max(1, Math.min(40, v.dc ?? 12)) })}
            pass={<OutcomeSlot o={e.success} set={(o) => set({ ...e, success: o })} fail={false} label={roll ? 'Success' : 'Result'} />}
            fail={roll ? <OutcomeSlot o={e.failure} set={(o) => set({ ...e, failure: o })} fail label="Failure" /> : undefined} />
        </div>
      )}
    </Block>
  );
}

/** Random events on an activity, as blocks; import, export and the events packs add. */
export function EventsEditor({ activity, name, events, packed, chance, onChange }: { activity: string; name: string; events: EventDef[]; packed: EventDef[]; chance: number | null; onChange: (e: EventDef[], chance: number | null) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [paste, setPaste] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const set = (i: number, e: EventDef) => onChange(events.map((x, j) => (j === i ? e : x)), chance);
  const move = (i: number, by: number) => { const l = [...events]; const [x] = l.splice(i, 1); l.splice(i + by, 0, x); onChange(l, chance); setOpen(open === i ? i + by : open); };
  const add = (e: EventDef) => { onChange([...events, e].slice(0, 40), chance); setOpen(Math.min(events.length, 39)); };
  const take = (how: 'add' | 'replace', data: string) => act.run(async () => {
    const x = await w.call<{ events: EventDef[]; from: string }>('POST', '/downtime/event-import', { activity, data });
    onChange(how === 'add' ? [...events, ...x.events].slice(0, 40) : x.events, chance);
    setPaste(null);
    setSaid(`${how === 'add' ? 'Added' : 'Now'} ${x.events.length} event${x.events.length === 1 ? '' : 's'}${x.from === 'pack-general' ? " (the pack's general list)" : x.from === 'pack' ? ' from the pack' : ''}. Save to keep ${how === 'add' ? 'them' : 'it'}.`);
  });
  const exportList = () => download(`${(name || 'activity').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'activity'}-events.json`, JSON.stringify({ type: 'alexandria-downtime-events', activity, name, events: events.map(({ id: _i, pack: _p, ...e }) => e) }, null, 2), 'application/json');
  return (
    <details className="stack tight" open={events.length > 0 && events.length <= 3}>
      <summary className="small"><strong>Random events</strong> ({events.length}{packed.length ? ` + ${packed.length} from packs` : ''}) · things that can happen on a downtime day</summary>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="small">Chance per day <input className="input" type="number" min={0} max={100} style={{ width: 64 }} value={chance ?? ''} placeholder="world" onChange={(ev) => onChange(events, ev.target.value === '' ? null : Math.max(0, Math.min(100, Number(ev.target.value) || 0)))} aria-label="Event chance per day" /> %</label>
        <button type="button" className="btn small ghost" onClick={() => setPaste(paste === null ? '' : null)} aria-expanded={paste !== null}>Import events</button>
        <button type="button" className="btn small ghost" disabled={!events.length} onClick={exportList}>Export events</button>
        {said && <span className="tiny muted" role="status">{said}</span>}
      </div>
      {paste !== null && (
        <div className="card stack tight" style={{ padding: 8 }} data-testid="dt-event-import">
          <span className="tiny muted">Paste a list of events, an exported events file, or an event pack (its list for this activity is used), or choose a file.</span>
          <textarea className="input" rows={5} value={paste} onChange={(ev) => setPaste(ev.target.value)} placeholder='[{ "title": "Rats!", "check": "Athletics", "dc": 12, "success": { "gp": 5 }, "failure": { "damage": 3 } }]' aria-label="Events to import" />
          <input type="file" accept=".json,application/json" aria-label="Events file" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) void f.text().then(setPaste); }} />
          <ErrorBox error={act.error} />
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="btn small" disabled={act.busy || !paste.trim()} onClick={() => void take('replace', paste)}>Replace the list</button>
            <button type="button" className="btn small primary" disabled={act.busy || !paste.trim()} onClick={() => void take('add', paste)}>Add to the list</button>
          </div>
        </div>
      )}
      <div className="stack tight">
        {events.map((e, i) => (
          <EventStack key={i} e={e} open={open === i} toggle={() => setOpen(open === i ? null : i)} set={(x) => set(i, x)} remove={() => { onChange(events.filter((_, j) => j !== i), chance); setOpen(null); }} move={(by) => move(i, by)} first={i === 0} last={i === events.length - 1} />
        ))}
      </div>
      <div className="blk-add" role="group" aria-label="Add an event">
        <span className="tiny muted" style={{ alignSelf: 'center' }}>Add an event:</span>
        {STARTERS.map((s) => <button key={s.label} type="button" className="btn small" disabled={events.length >= 40} onClick={() => add(s.make())}><i className={`fa-solid ${s.icon}`} aria-hidden="true" /> {s.label}</button>)}
      </div>
      {packed.length > 0 && (
        <div className="stack tight">
          <span className="tiny muted">From event packs (turn a pack off under House rules to remove its events):</span>
          {packed.map((e, i) => <div key={i} className="tiny"><strong>{e.title}</strong>{e.check ? ` · ${e.check} DC ${e.dc}` : ''} <span className="muted">({e.pack})</span></div>)}
        </div>
      )}
    </details>
  );
}
