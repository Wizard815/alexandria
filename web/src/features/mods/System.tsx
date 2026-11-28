// House rules data systems on the web (kit 2): a rule's views (its own lists as
// tables with their actions), the forms its record actions ask for, the GM's
// prompt buttons and the popup each player gets when the GM opens a prompt.
// All of it is drawn from the rule file, so a new rule needs no new screen.
import { useMemo, useState } from 'react';
import { timeShort } from '../../lib/format.ts';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, Modal, useAction, useToast } from '../../ui/index.tsx';
import { useHouseRules, type FieldSpec, type HouseRule, type Rec, type RecordActionView, type ViewSpec } from './shared.tsx';

type Records = Record<string, Rec[]>;

function useRecords(rule: HouseRule) {
  const { w } = useWorld();
  return useLoad(() => w.call<{ records: Records }>('GET', `/mods/${rule.id}/records`), [w, rule.id], ['mods', 'mods-records']);
}

const fits = (r: Rec, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => r[k] === v || (typeof v === 'string' && v.startsWith('$')));

/** Can I run this action (on this record, or create one)? The server checks again. */
function mayRun(a: RecordActionView, isGM: boolean, me: string, rec?: Rec) {
  if (a.by === 'gm') return isGM;
  if (a.by === 'player') return !isGM;
  const mine = !rec || rec.player === null || rec.player === me;
  if (a.by === 'owner') return !isGM && mine;
  return isGM || mine;
}

/** A field's value as words: a ref shows the title of the record it points at. */
function show(rule: HouseRule, recs: Records, f: FieldSpec | undefined, v: unknown, nameOf: (id: string) => string, col: string): string {
  if (col === 'player') return v ? nameOf(String(v)) : '';
  if (col === 'createdAt' || col === 'updatedAt') return v ? timeShort(String(v)) : '';
  if (v === undefined || v === null) return '';
  if (f?.type === 'ref') {
    const kind = rule.system!.records.find((k) => k.id === f.ref);
    const target = (recs[f.ref ?? ''] ?? []).find((x) => x.id === v);
    return target && kind ? String(target[kind.title] ?? '') : '(gone)';
  }
  if (f?.type === 'bool') return v ? 'Yes' : 'No';
  return String(v);
}

/** One view of a rule: its records as a table, its actions per row, and its create buttons. */
export function RecordsView({ rule, view }: { rule: HouseRule; view: ViewSpec }) {
  const { isGM, me, nameOf } = useWorld();
  const recs = useRecords(rule);
  const [form, setForm] = useState<{ a: RecordActionView; rec?: Rec } | null>(null);
  const sys = rule.system!;
  const kind = sys.records.find((k) => k.id === view.record)!;
  const all = recs.data?.records ?? {};
  const rows = (all[view.record] ?? []).filter((r) => fits(r, view.where) && (isGM || view.place === 'gm' || r.player === null || r.player === me));
  const rowActions = view.actions.map((id) => sys.recordActions.find((a) => a.id === id)!).filter(Boolean);
  const creates = sys.recordActions.filter((a) => a.record === view.record && a.do === 'create' && mayRun(a, isGM, me));
  const label = (c: string) => (c === 'player' ? 'Player' : c === 'createdAt' ? 'Started' : c === 'updatedAt' ? 'Changed' : kind.fields[c]?.label || c[0].toUpperCase() + c.slice(1));
  const groups = view.groupByPlayer ? [...new Set(rows.map((r) => r.player ?? ''))] : [''];
  return (
    <section className="card stack" aria-label={view.title}>
      <div className="card-head row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{view.title}</h2>
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {creates.map((a) => <button key={a.id} type="button" className="btn small" onClick={() => setForm({ a })}>{a.label}</button>)}
        </span>
      </div>
      <ErrorBox error={recs.error} />
      {!recs.data ? <Loading /> : rows.length === 0 ? <p className="small muted">No {kind.plural.toLowerCase()} yet.</p> : groups.map((g) => (
        <div key={g} className="stack tight">
          {view.groupByPlayer && <h3 style={{ margin: 0 }}>{g ? nameOf(g) : 'Everyone'}</h3>}
          <div style={{ overflowX: 'auto' }}>
            <table className="table small" style={{ width: '100%' }}>
              <thead><tr>{view.columns.filter((c) => !(view.groupByPlayer && c === 'player')).map((c) => <th key={c} style={{ textAlign: 'left' }}>{label(c)}</th>)}{rowActions.length > 0 && <th />}</tr></thead>
              <tbody>
                {rows.filter((r) => !view.groupByPlayer || (r.player ?? '') === g).map((r) => (
                  <tr key={r.id}>
                    {view.columns.filter((c) => !(view.groupByPlayer && c === 'player')).map((c) => <td key={c}>{show(rule, all, kind.fields[c], c === 'player' ? r.player : r[c], nameOf, c)}</td>)}
                    {rowActions.length > 0 && (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {rowActions.filter((a) => mayRun(a, isGM, me, r) && fits(r, a.where)).map((a) => (
                          <button key={a.id} type="button" className="btn small" aria-label={`${a.label}: ${String(r[kind.title] ?? '')}`} onClick={() => setForm({ a, rec: r })}>{a.label}</button>
                        ))}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {form && <ActionForm rule={rule} a={form.a} rec={form.rec} records={all} onClose={() => setForm(null)} />}
    </section>
  );
}

/** The form a record action asks for: its fields, how much, whose (the GM making a player's record) and a note. */
export function ActionForm({ rule, a, rec, records, onClose, submit }: { rule: HouseRule; a: RecordActionView; rec?: Rec; records: Records; onClose: () => void; submit?: (body: Record<string, unknown>) => Promise<void> }) {
  const { w, isGM, members } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const kind = rule.system!.records.find((k) => k.id === a.record)!;
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(a.ask.map((f) => [f, kind.fields[f].default ?? (kind.fields[f].type === 'bool' ? false : '')])));
  const [player, setPlayer] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const players = members.filter((m) => m.role === 'player');
  const needsPlayer = isGM && a.do === 'create' && kind.owned;
  const run = () => act.run(async () => {
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '').map(([k, v]) => [k, kind.fields[k].type === 'int' ? Math.trunc(Number(v)) : v]));
    const body: Record<string, unknown> = { values: clean, ...(rec ? { recordId: rec.id } : {}), ...(needsPlayer ? { player } : {}), ...(a.amount === 'ask' ? { amount: Math.trunc(Number(amount)) } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    if (submit) await submit(body);
    else await w.call('POST', `/mods/${rule.id}/records/${a.id}`, body);
    toast(`${a.label}: done`);
    onClose();
  });
  const simple = a.do === 'remove' || (a.do === 'set' && !a.ask.length);
  return (
    <Modal title={`${a.label}${rec ? `: ${String(rec[kind.title] ?? '')}` : ''}`} onClose={onClose}>
      <div className="stack">
        {needsPlayer && (
          <label className="stack tight"><span className="small">For</span>
            <select className="input" value={player} onChange={(e) => setPlayer(e.target.value)} aria-label="For which player">
              <option value="">Pick a player</option>
              {players.map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}
            </select>
          </label>
        )}
        {a.ask.map((f) => <FieldInput key={f} name={f} spec={kind.fields[f]} value={values[f]} records={records} rule={rule} onChange={(v) => setValues({ ...values, [f]: v })} />)}
        {a.amount === 'ask' && (
          <label className="stack tight"><span className="small">How much ({kind.fields[a.field!]?.label || a.field}; negative takes away)</span>
            <input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="How much" style={{ maxWidth: 140 }} />
          </label>
        )}
        {simple && <p className="small">{a.do === 'remove' ? 'This takes it off the list. The log keeps it.' : 'Confirm.'}</p>}
        <label className="stack tight"><span className="small">Note (optional, in the log)</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} aria-label="Note" /></label>
        <ErrorBox error={act.error} />
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn primary" disabled={act.busy || (needsPlayer && !player) || (a.amount === 'ask' && !/^-?\d+$/.test(amount.trim()))} onClick={() => void run()}>{a.label}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
      {toastNode}
    </Modal>
  );
}

function FieldInput({ name, spec, value, onChange, records, rule }: { name: string; spec: FieldSpec; value: unknown; onChange: (v: unknown) => void; records: Records; rule: HouseRule }) {
  const label = spec.label || name[0].toUpperCase() + name.slice(1);
  const id = `fld-${name}`;
  if (spec.type === 'bool') return <label className="row" style={{ gap: 6 }}><input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> <span className="small">{label}</span></label>;
  let input;
  if (spec.type === 'enum') input = <select id={id} className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">{spec.optional ? '(none)' : 'Pick one'}</option>{spec.values!.map((v) => <option key={v} value={v}>{v}</option>)}</select>;
  else if (spec.type === 'ref') {
    const kind = rule.system!.records.find((k) => k.id === spec.ref);
    input = <select id={id} className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}><option value="">Pick one</option>{(records[spec.ref ?? ''] ?? []).map((r) => <option key={r.id} value={r.id}>{String(r[kind?.title ?? ''] ?? r.id)}</option>)}</select>;
  } else if (spec.type === 'int') input = <input id={id} className="input" type="number" min={spec.min} max={spec.max} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 140 }} />;
  else input = <input id={id} className="input" value={String(value ?? '')} maxLength={2000} onChange={(e) => onChange(e.target.value)} />;
  return <label className="stack tight" htmlFor={id}><span className="small">{label}{spec.optional ? ' (optional)' : ''}</span>{input}</label>;
}

/** The GM's buttons for a rule's prompts (Downtime), with how many players answered the open one. */
export function PromptButtons({ rule }: { rule: HouseRule }) {
  const { w, members } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const open = useLoad(() => w.call<{ rounds: Round[] }>('GET', '/mods/prompts/open'), [w], ['mods-prompt']);
  const players = members.filter((m) => m.role === 'player').length;
  if (!rule.system?.prompts.length) return null;
  return (
    <section className="card row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }} aria-label={`${rule.name} prompts`}>
      {rule.system.prompts.map((p) => {
        const round = (open.data?.rounds ?? []).find((r) => r.modId === rule.id && r.prompt === p.id);
        return round ? (
          <span key={p.id} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span className="small"><strong>{p.button}</strong> is open: {Object.keys(round.answers).length} of {players} answered</span>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/mods/${rule.id}/prompts/round/${round.id}/close`, {}); toast(`${p.button} closed`); })}>Close</button>
          </span>
        ) : (
          <button key={p.id} type="button" className="btn primary small" disabled={act.busy} title={`Ask every player: ${p.title}`} onClick={() => void act.run(async () => { await w.call('POST', `/mods/${rule.id}/prompts/${p.id}`, {}); toast(`${p.button}: every player is asked`); })}>{p.button}</button>
        );
      })}
      <ErrorBox error={act.error} />
      {toastNode}
    </section>
  );
}

interface Round { id: string; modId: string; prompt: string; openedAt: string; closedAt: string | null; answers: Record<string, { choice: number; recordId?: string }> }

/** For a player: the GM's open prompts I have not answered, as a popup. */
export function PromptOverlay() {
  const { w, isGM, me } = useWorld();
  const { list } = useHouseRules();
  const open = useLoad(() => w.call<{ rounds: Round[] }>('GET', '/mods/prompts/open'), [w], ['mods-prompt']);
  const [later, setLater] = useState<string[]>([]);
  if (isGM) return null;
  const round = (open.data?.rounds ?? []).find((r) => !r.answers[me] && !later.includes(r.id));
  const rule = round && list.find((r) => r.id === round.modId);
  const prompt = rule?.system?.prompts.find((p) => p.id === round!.prompt);
  if (!round || !rule || !prompt) return null;
  return <PromptDialog rule={rule} round={round} onLater={() => setLater([...later, round.id])} />;
}

function PromptDialog({ rule, round, onLater }: { rule: HouseRule; round: Round; onLater: () => void }) {
  const { w, me } = useWorld();
  const recs = useRecords(rule);
  const act = useAction();
  const [pick, setPick] = useState<{ choice: number; a: RecordActionView } | null>(null);
  const [recordId, setRecordId] = useState('');
  const prompt = rule.system!.prompts.find((p) => p.id === round.prompt)!;
  const all = recs.data?.records ?? {};
  const answer = (choice: number, body: Record<string, unknown> = {}) => act.run(async () => { await w.call('POST', `/mods/${rule.id}/prompts/round/${round.id}/answer`, { choice, ...body }); });
  // A choice that works on one of my records needs one that fits; a create opens its form.
  const options = useMemo(() => prompt.choices.map((c, i) => {
    const a = c.action ? rule.system!.recordActions.find((x) => x.id === c.action) : undefined;
    const mine = a && a.do !== 'create' ? (all[a.record] ?? []).filter((r) => (r.player === me || r.player === null) && fits(r, a.where)) : [];
    return { c, i, a, mine, usable: !a || a.do === 'create' || mine.length > 0 };
  }), [prompt, rule, all, me]);
  if (pick && pick.a.do === 'create') return <ActionForm rule={rule} a={pick.a} records={all} onClose={() => setPick(null)} submit={(body) => answer(pick.choice, body)} />;
  return (
    <Modal title={prompt.title} onClose={onLater}>
      <div className="stack">
        {prompt.text && <p className="small">{prompt.text}</p>}
        {!recs.data ? <Loading /> : options.filter((o) => o.usable).map((o) => (
          <div key={o.i} className="stack tight">
            {o.a && o.a.do !== 'create' ? (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <select className="input" aria-label={`${o.c.label}: which one`} value={pick?.choice === o.i ? recordId : ''} onChange={(e) => { setPick({ choice: o.i, a: o.a! }); setRecordId(e.target.value); }} style={{ maxWidth: 260 }}>
                  <option value="">{o.c.label}…</option>
                  {o.mine.map((r) => { const k = rule.system!.records.find((x) => x.id === r.kind)!; const f = k.fields[k.title]; return <option key={r.id} value={r.id}>{show(rule, all, f, r[k.title], () => '', k.title)}</option>; })}
                </select>
                <button type="button" className="btn primary small" disabled={act.busy || pick?.choice !== o.i || !recordId} onClick={() => void answer(o.i, { recordId })}>{o.c.label}</button>
              </div>
            ) : (
              <button type="button" className={`btn ${o.c.skip ? '' : 'primary'}`} disabled={act.busy} onClick={() => (o.a ? setPick({ choice: o.i, a: o.a }) : void answer(o.i))}>{o.c.label}</button>
            )}
          </div>
        ))}
        <ErrorBox error={act.error ?? recs.error} />
        <button type="button" className="btn small" onClick={onLater}>Later</button>
      </div>
    </Modal>
  );
}

/** Every view of the rules that are on, for one place (the player's card, the player's page). */
export function ViewsFor({ place }: { place: ViewSpec['place'] }) {
  const { list } = useHouseRules();
  const shown = list.filter((r) => r.enabled && r.system).flatMap((r) => r.system!.views.filter((v) => v.place === place).map((v) => ({ r, v })));
  if (!shown.length) return null;
  return <>{shown.map(({ r, v }) => <RecordsView key={`${r.id}-${v.id}`} rule={r} view={v} />)}</>;
}

/** The GM's tab for a rule's gm views: its prompt buttons, then each view. */
export function GMSystemTab({ rule }: { rule: HouseRule }) {
  const views = rule.system?.views.filter((v) => v.place === 'gm') ?? [];
  return (
    <div className="stack">
      <PromptButtons rule={rule} />
      {views.length ? views.map((v) => <RecordsView key={v.id} rule={rule} view={v} />) : <Empty>This rule shows nothing here.</Empty>}
    </div>
  );
}
