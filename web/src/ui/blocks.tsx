// The block kit: small building blocks that event editors snap together, like block coding. Used by story events and
// NPC encounters (features/encounters/Blocks.tsx) and meant for any editor of the same shape (a DownTime random event:
// a check, then what happens on a success or a failure). Pieces are data: a feature registers its piece kinds (coin,
// item, DM note ...) with an editor and a chip each, and the kit lays them out, adds them from a palette and removes
// them. Styles in blocks.css (.blk-*).
import { useState, type ReactNode } from 'react';
import './blocks.css';

export type Tone = 'gold' | 'teal' | 'red' | 'green' | 'muted';

/** One block: a card with a coloured left edge, an icon, its content and an optional ✕. */
export function Block({ tone = 'gold', icon, onRemove, removeLabel = 'Remove', testid, edit = false, children }: {
  tone?: Tone; icon?: string; onRemove?: () => void; removeLabel?: string; testid?: string; edit?: boolean; children: ReactNode;
}) {
  return (
    <div className={`blk blk-tone-${tone}${edit ? ' edit' : ''}`} data-testid={testid}>
      {edit ? <div className="blk-row">{icon && <i className={`fa-solid ${icon} blk-ico`} aria-hidden="true" />}<div className="blk-body">{children}</div>{onRemove && <button type="button" className="btn ghost small blk-x" aria-label={removeLabel} onClick={onRemove}>✕</button>}</div>
        : <>{icon && <i className={`fa-solid ${icon} blk-ico`} aria-hidden="true" />}{children}</>}
    </div>
  );
}

/** A line of controls inside a block; wraps on a phone. */
export const BlockRow = ({ children }: { children: ReactNode }) => <div className="blk-row">{children}</div>;

/** A small pill: an effect, a timer, a tag. */
export function Chip({ tone = 'muted', icon, title, children }: { tone?: Tone; icon?: string; title?: string; children: ReactNode }) {
  return <span className={`chip blk-chip ${tone === 'muted' ? '' : tone}`} title={title}>{icon && <i className={`fa-solid ${icon}`} aria-hidden="true" />} {children}</span>;
}

/** A chip that hides its text until tapped (a DM note in a preview). */
export function FoldChip({ tone = 'teal', icon = 'fa-note-sticky', label, text }: { tone?: Tone; icon?: string; label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" className={`chip ${tone} blk-note${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)} title={open ? `Hide the ${label.toLowerCase()}` : text}>
      <i className={`fa-solid ${icon}`} aria-hidden="true" /> {open ? text : label}
    </button>
  );
}

export interface PaletteItem<T> { key: string; label: string; icon?: string; make: () => T }

/** "+ Effect": opens the choices, adds the one picked. */
export function Palette<T>({ label = '+ Effect', items, onAdd, testid }: { label?: string; items: PaletteItem<T>[]; onAdd: (v: T) => void; testid?: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn ghost small blk-palette-open" onClick={() => setOpen(true)} data-testid={testid}>{label}</button>;
  return (
    <div className="blk-add blk-palette" role="group" aria-label={label.replace(/^\+\s*/, 'Add ')}>
      {items.map((it) => <button key={it.key} type="button" className="btn ghost small" onClick={() => { onAdd(it.make()); setOpen(false); }}>{it.icon && <i className={`fa-solid ${it.icon}`} aria-hidden="true" />} {it.label}</button>)}
      <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

/** One kind of piece a feature offers (coin, item, DM note ...): how to make, edit and show it. */
export interface PieceKind<P extends { kind: string }> {
  kind: P['kind']; label: string; icon: string; tone: Tone;
  make: () => P;
  edit: (p: P, set: (p: P) => void) => ReactNode;
  chip: (p: P) => ReactNode;
}
type AnyKinds<P extends { kind: string }> = PieceKind<P>[];
const kindOf = <P extends { kind: string }>(kinds: AnyKinds<P>, p: P) => kinds.find((k) => k.kind === p.kind);

/** A list of pieces to edit, with "+ Effect" to add more (up to max). */
export function Pieces<P extends { kind: string }>({ pieces, kinds, onChange, max = 3, addLabel = '+ Effect' }: { pieces: P[]; kinds: AnyKinds<P>; onChange: (p: P[]) => void; max?: number; addLabel?: string }) {
  return (
    <div className="blk-pieces">
      {pieces.map((p, i) => {
        const k = kindOf(kinds, p);
        return (
          <div key={i} className={`blk-piece blk-piece-${p.kind}`} data-testid="blk-piece">
            {k && <i className={`fa-solid ${k.icon} blk-ico blk-tone-text-${k.tone}`} aria-hidden="true" />}
            {k ? k.edit(p, (q) => onChange(pieces.map((x, j) => (j === i ? q : x)))) : <span className="small muted">{p.kind}</span>}
            <button type="button" className="btn ghost small blk-x" aria-label={`Remove ${k?.label.toLowerCase() ?? 'piece'}`} onClick={() => onChange(pieces.filter((_, j) => j !== i))}>✕</button>
          </div>
        );
      })}
      {pieces.length < max && <Palette label={addLabel} items={kinds.map((k) => ({ key: k.kind, label: k.label, icon: k.icon, make: k.make }))} onAdd={(p) => onChange([...pieces, p])} />}
    </div>
  );
}

/** The pieces as chips, read-only. */
export function PieceChips<P extends { kind: string }>({ pieces, kinds }: { pieces: P[]; kinds: AnyKinds<P> }) {
  return <>{pieces.map((p, i) => <span key={i} className="blk-chipwrap">{kindOf(kinds, p)?.chip(p) ?? <Chip>{p.kind}</Chip>}</span>)}</>;
}

/** DC, or a DC range "from–to": the DC is picked from it when the player rolls. */
export function DcInputs({ dc, dcMax, onChange, range = true }: { dc: number | null; dcMax: number | null | undefined; onChange: (dc: number | null, dcMax: number | null) => void; range?: boolean }) {
  const num = (v: string) => Number(v.replace(/\D/g, '').slice(0, 2)) || null;
  return (
    <span className="blk-dc">
      <span className="small">DC</span>
      <input className="input blk-num-in" inputMode="numeric" aria-label={range ? 'DC from' : 'DC'} value={dc ?? ''} onChange={(e) => onChange(num(e.target.value), dcMax ?? null)} />
      {range && <>
        <span className="small">to</span>
        <input className="input blk-num-in" inputMode="numeric" aria-label="DC to" placeholder="–" value={dcMax ?? ''} onChange={(e) => onChange(dc, num(e.target.value))} />
      </>}
    </span>
  );
}

/** 5e skills and abilities, offered as suggestions for a check's skill (any text is allowed). */
export const SKILLS = ['Acrobatics', 'Animal Handling', 'Arcana', 'Athletics', 'Deception', 'History', 'Insight', 'Intimidation', 'Investigation', 'Medicine', 'Nature', 'Perception', 'Performance', 'Persuasion', 'Religion', 'Sleight of Hand', 'Stealth', 'Survival',
  'Strength', 'Dexterity', 'Constitution', 'Intelligence', 'Wisdom', 'Charisma', 'Strength save', 'Dexterity save', 'Constitution save', 'Intelligence save', 'Wisdom save', 'Charisma save'];
export function SkillList() { return <datalist id="blk-skills">{SKILLS.map((k) => <option key={k} value={k} />)}</datalist>; }

export const dcText = (dc: number | null, dcMax?: number | null) => (dc === null ? 'DC ?' : `DC ${dc}${dcMax ? `–${dcMax}` : ''}`);

/**
 * A check: skill and DC (or a range), then what happens on a pass and on a fail. pass and fail are slots: a
 * "go to step" picker in a story event, a text line and effect pieces in a DownTime event. head adds controls before
 * the skill (a game picker). Read-only when onChange is left out.
 *
 * noRoll: "no roll, it just happens": no skill or DC, and only the pass slot, shown as "What happens". onNoRoll adds
 * the switch between the two. range={false}: a single DC, with no "to" box.
 */
export function CheckBlock({ skill, dc, dcMax, onChange, onRemove, pass, fail, head, help, noRoll = false, onNoRoll, range = true, testid = 'blk-check' }: {
  skill: string | null; dc: number | null; dcMax?: number | null;
  onChange?: (v: { skill: string | null; dc: number | null; dcMax: number | null }) => void; onRemove?: () => void;
  pass: ReactNode; fail?: ReactNode; head?: ReactNode; help?: ReactNode; noRoll?: boolean; onNoRoll?: (v: boolean) => void; range?: boolean; testid?: string;
}) {
  if (!onChange && noRoll) {
    return <div className="blk blk-tone-gold" data-testid={testid}><i className="fa-solid fa-bolt blk-ico" aria-hidden="true" /><span className="blk-outcomes">{pass}</span></div>;
  }
  if (!onChange) {
    return (
      <div className="blk blk-tone-teal" data-testid={testid}>
        <i className="fa-solid fa-dice-d20 blk-ico" aria-hidden="true" />
        <span className="blk-label">{head ?? `${skill || 'Skill'} · ${dcText(dc, dcMax)}`}</span>
        <span className="blk-outcomes"><span className="blk-ok">✓</span> {pass} <span className="blk-bad">✗</span> {fail}</span>
      </div>
    );
  }
  return (
    <div className="blk blk-tone-teal edit" data-testid={testid}>
      <div className="blk-row">
        <i className="fa-solid fa-dice-d20 blk-ico" aria-hidden="true" />
        {head}
        {onNoRoll && (
          <span className="blk-mode" role="group" aria-label="Roll or not">
            <button type="button" className={`btn small${!noRoll ? ' on' : ''}`} aria-pressed={!noRoll} onClick={() => onNoRoll(false)}>Roll</button>
            <button type="button" className={`btn small${noRoll ? ' on' : ''}`} aria-pressed={noRoll} onClick={() => onNoRoll(true)}>No roll</button>
          </span>
        )}
        {!noRoll && <>
          <input className="input blk-grow" aria-label="Skill" placeholder="Skill (Athletics)" list="blk-skills" value={skill ?? ''} maxLength={40} onChange={(e) => onChange({ skill: e.target.value || null, dc, dcMax: dcMax ?? null })} />
          <SkillList />
          <DcInputs dc={dc} dcMax={dcMax} range={range} onChange={(a, b) => onChange({ skill, dc: a, dcMax: b })} />
        </>}
        {onRemove && <button type="button" className="btn ghost small blk-x" aria-label="Remove the check" onClick={onRemove}>✕</button>}
      </div>
      {help && <span className="tiny faint">{help}</span>}
      {noRoll
        ? <div className="blk-outcome blk-outcome-auto"><span className="blk-label">What happens</span><div className="blk-slot">{pass}</div></div>
        : <>
          <div className="blk-outcome blk-outcome-pass"><span className="blk-ok">✓ Pass</span><div className="blk-slot">{pass}</div></div>
          <div className="blk-outcome blk-outcome-fail"><span className="blk-bad">✗ Fail</span><div className="blk-slot">{fail}</div></div>
        </>}
    </div>
  );
}

/** A step: a numbered card with a title, badges on the right, and its blocks. */
export function StepCard({ num, anchor, title, badges, edit = false, testid = 'flow-step', data, children }: {
  num: number; anchor?: string; title: ReactNode; badges?: ReactNode; edit?: boolean; testid?: string; data?: Record<string, string>; children: ReactNode;
}) {
  const extra = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <li className={`blk-step${edit ? ' edit' : ''}`} id={anchor} data-testid={testid} {...extra}>
      <div className="blk-head"><span className="blk-num">{num}</span>{title}{badges && <span className="blk-badges">{badges}</span>}</div>
      {children}
    </li>
  );
}

/** "+ Answer  + Check  + Timer": the blocks a step can still take. */
export function AddBar({ items, label = 'Add to this step' }: { items: { key: string; label: string; icon: string; onAdd: () => void; hidden?: boolean }[]; label?: string }) {
  return <div className="blk-add" aria-label={label}>{items.filter((i) => !i.hidden).map((i) => <button key={i.key} type="button" className="btn small" onClick={i.onAdd}><i className={`fa-solid ${i.icon}`} aria-hidden="true" /> + {i.label}</button>)}</div>;
}
