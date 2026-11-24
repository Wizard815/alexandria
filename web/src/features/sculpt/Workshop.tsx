// One template at work: fill a few blanks, Sculpt, preview, then choose what to
// do with the result (save a page, show on the stage, add to combat, send to
// players, make a broker note). Used by the Sculpting page and the side sheet.
import { uploadPicture } from '../../lib/upload.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBox, Empty, Loading, Field, Markdown, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import type { OutputKey, Part, SculptContext, Tpl, Values } from './types.ts';
import './sculpt.css';

interface Check { ok: boolean; leaks: { key: string; match: string }[]; parts: Part[]; text: string; md: string; publicOk?: boolean }
interface Res { values: Values; md: string; parts: Part[] }
interface OutDone { done: Record<string, any>; errors: Record<string, string> }

const OUT_LABEL: Record<OutputKey, string> = { page: 'Save as a page', stage: 'Show on the stage', combat: 'Add to combat', send: 'Send to players', broker: 'Make a broker note' };
const OUT_HELP: Record<OutputKey, string> = {
  page: 'Into the library, DM-only parts as secret blocks',
  stage: 'Players see only the parts meant for them',
  combat: 'Everything lands in initiative',
  send: 'A message to every player',
  broker: 'The broker may sell the player-safe text',
};

export default function Workshop({ tpl, initial, context, autoSculpt, preset, onDone }: { tpl: Tpl; initial?: Values; context?: SculptContext; autoSculpt?: boolean; preset?: Partial<Record<OutputKey, boolean>>; onDone?: (what: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [values, setValues] = useState<Values>(initial ?? {});
  const [locked, setLocked] = useState<Set<string>>(() => new Set(Object.entries(initial ?? {}).filter(([, v]) => v).map(([k]) => k)));
  const [notes, setNotes] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [count, setCount] = useState(1);
  const [batch, setBatch] = useState<Res[] | null>(null);
  const [pick, setPick] = useState(0);
  const [sel, setSel] = useState<Record<OutputKey, boolean>>(() => ({ page: !!tpl.outputs?.page, stage: !!tpl.outputs?.stage, combat: !!tpl.outputs?.combat, send: !!tpl.outputs?.send, broker: !!tpl.outputs?.broker, ...preset }));
  const [out, setOut] = useState<OutDone | null>(null);
  const pages = useLoad<any[]>(() => w.call('GET', '/library/pages'), [w]);
  const player = tpl.perspective === 'player';
  const ctxKey = JSON.stringify(context ?? {});

  // Which outputs this template can do.
  const avail: OutputKey[] = useMemo(() => {
    const a: OutputKey[] = [];
    if (tpl.target.kind !== 'none') a.push('page');
    a.push('stage');
    if (tpl.outputs?.combatField || tpl.fields.some((f) => f.type === 'statblock')) a.push('combat');
    if (player) a.push('send');
    a.push('broker');
    return a;
  }, [tpl, player]);

  // Live preview: the server renders it, so DM-only parts and leak checks match what is saved.
  const seq = useRef(0);
  useEffect(() => {
    if (batch) return;
    const n = ++seq.current;
    const t = setTimeout(() => { w.call<Check>('POST', '/sculpt/check', { templateId: tpl.id, values, context, public: true }).then((c) => { if (n === seq.current) setCheck(c); }).catch(() => {}); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, tpl, values, batch, ctxKey]);

  const set = (k: string, v: string) => { setValues((o) => ({ ...o, [k]: v })); setBatch(null); setOut(null); setLocked((s) => { const n = new Set(s); if (v.trim()) n.add(k); else n.delete(k); return n; }); };
  const toggle = (k: string) => setLocked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const run = async (only?: string) => {
    setBusyKey(only ?? '*');
    try {
      const r = await act.run(() => w.call<any>('POST', '/sculpt/run', { templateId: tpl.id, values, lock: [...locked], only: only ? [only] : undefined, count: only ? 1 : count, context }));
      if (r) {
        setValues(r.values); setNotes(r.notes ?? []); setOut(null);
        setBatch(r.batch ? (r.results as Res[]) : null); setPick(0);
      }
    } finally { setBusyKey(null); }
  };
  const started = useRef(false);
  useEffect(() => { if (autoSculpt && !started.current) { started.current = true; void run(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const outputs = (which: Partial<Record<OutputKey, boolean>>) => act.run(async () => {
    const r = await w.call<OutDone>('POST', '/sculpt/outputs', { templateId: tpl.id, ...(batch ? { results: batch.map((x) => x.values) } : { values }), outputs: which, context });
    setOut(r);
    const did = Object.keys(r.done);
    if (did.length) { toast(`Done: ${did.map((k) => OUT_LABEL[k as OutputKey].toLowerCase()).join(', ')}`); onDone?.(did.join(',')); }
  });
  const readAloud = () => act.run(async () => {
    const c = await w.call<Check>('POST', '/sculpt/check', { templateId: tpl.id, values, context });
    if (!c.ok) throw new Error('Blocked: the text repeats DM-only notes.');
    const presets = await w.call<any[]>('GET', '/voice/presets');
    if (!presets.length) throw new Error('No voice yet. Add one in Settings → Voice.');
    await w.call('POST', '/voice/speak', { text: c.text.slice(0, 2000), presetId: presets[0].id });
    toast('Reading aloud');
  });
  const upload = async (key: string, f: File) => act.run(async () => {
    const r = await uploadPicture(w, '/stage/images', f);
    set(key, r.id);
  });

  const missing = tpl.fields.some((f) => f.required && !values[f.key]?.trim());
  const pageOptions = useMemo(() => (pages.data ?? []).filter((p) => !player || p.visibility === 'party').map((p) => p.title as string), [pages.data, player]);
  const chosen = (Object.keys(sel) as OutputKey[]).filter((k) => sel[k] && avail.includes(k));
  const hasStatblock = tpl.fields.some((f) => f.type === 'statblock');
  const noBlock = hasStatblock && !tpl.fields.some((f) => f.type === 'statblock' && values[f.key]?.trim()) && !batch;
  const hasCombatList = !!tpl.outputs?.combatField && tpl.fields.find((f) => f.key === tpl.outputs.combatField)?.type === 'list';
  const combatReady = batch ? true : hasCombatList ? !!values[tpl.outputs.combatField!]?.trim() : !!Object.entries(values).find(([k, v]) => v && tpl.fields.find((f) => f.key === k)?.type === 'statblock');
  const shown: Res | null = batch ? batch[pick] ?? null : check ? { values, md: check.md, parts: check.parts } : null;

  return (
    <div className="cols sculpt-work">
      <section className="col-1 stack" style={{ minWidth: 0 }}>
        <div className="card stack">
          <h2 style={{ margin: 0 }}>{tpl.name}</h2>
          {tpl.fields.map((f) => {
            const id = `sc_${tpl.id}_${f.key}`;
            const v = values[f.key] ?? '';
            const common = { id, value: v, 'aria-label': f.label };
            const area = (rows: number, ph?: string) => <textarea {...common} rows={rows} placeholder={ph} onChange={(e) => set(f.key, e.target.value)} />;
            const input = f.type === 'longtext' ? area(3)
              : f.type === 'list' ? area(5)
              : f.type === 'table' ? area(4, f.columns?.length ? `${f.columns.join(' | ')}` : 'cell | cell')
              : f.type === 'rollTable' ? area(6, '1 | first row')
              : f.type === 'statblock' ? <textarea {...common} rows={3} readOnly placeholder="Filled by Sculpt" style={{ fontFamily: 'monospace', fontSize: 12 }} />
              : f.type === 'select' ? <select {...common} onChange={(e) => set(f.key, e.target.value)}><option value="">(fill for me)</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
              : f.type === 'page' || f.type === 'pageLink' ? <><input {...common} list={`${id}_l`} onChange={(e) => set(f.key, e.target.value)} placeholder="A library page" /><datalist id={`${id}_l`}>{pageOptions.map((o) => <option key={o} value={o} />)}</datalist></>
              : f.type === 'image' ? (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <input {...common} style={{ flex: 1, minWidth: 120 }} placeholder="https:// link, or upload" onChange={(e) => set(f.key, e.target.value)} />
                  <label className="btn small">Upload<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(f.key, file); e.target.value = ''; }} /></label>
                </div>
              )
              : <input {...common} type={f.type === 'number' ? 'number' : 'text'} placeholder={f.type === 'dice' ? '2d6+3' : undefined} onChange={(e) => set(f.key, e.target.value)} />;
            return (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}${f.dmOnly ? ' (DM only)' : ''}`} help={f.hint}>
                <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>{input}</div>
                  <button type="button" className="btn small ghost" aria-pressed={locked.has(f.key)} title={locked.has(f.key) ? 'Locked: Sculpt keeps this' : 'Unlocked: Sculpt may change this'} aria-label={`${locked.has(f.key) ? 'Unlock' : 'Lock'} ${f.label}`} onClick={(e) => { e.preventDefault(); toggle(f.key); }}>{locked.has(f.key) ? '🔒' : '🔓'}</button>
                  <button type="button" className="btn small ghost" title="Re-roll this field" aria-label={`Re-roll ${f.label}`} disabled={act.busy || f.type === 'page' || f.type === 'pageLink' || f.type === 'image'} onClick={(e) => { e.preventDefault(); void run(f.key); }}>{busyKey === f.key ? '…' : '🎲'}</button>
                </div>
              </Field>
            );
          })}
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void run()}>{busyKey === '*' ? 'Sculpting…' : count > 1 ? `Sculpt ${count}` : 'Sculpt'}</button>
            <label className="row tiny" style={{ gap: 4 }} title="Make several results at once, with one model call">Make <input aria-label="How many to make" className="sculpt-count" inputMode="numeric" value={count} onChange={(e) => setCount(Math.max(1, Math.min(20, parseInt(e.target.value.replace(/\D/g, ''), 10) || 1)))} /></label>
            <span className="tiny muted">Fills every empty, unlocked field.</span>
          </div>
          <ErrorBox error={act.error} />
          {notes.map((n, i) => <div key={i} className="small muted" role="status">{n}</div>)}
        </div>
      </section>
      <section className="col-2 stack" style={{ minWidth: 0 }}>
        <div className="card stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{batch ? `Result ${pick + 1} of ${batch.length}` : 'Preview'}</h3>
            <span className="tiny faint">{player ? 'What the players get' : 'Grey boxes are DM-only and become secret blocks'}</span>
          </div>
          {batch && (
            <div className="row" style={{ flexWrap: 'wrap', gap: 4 }} role="tablist" aria-label="Results">
              {batch.map((_x, i) => <button key={i} type="button" role="tab" aria-selected={i === pick} className={`btn small ${i === pick ? '' : 'ghost'}`} onClick={() => setPick(i)}>{i + 1}</button>)}
            </div>
          )}
          {!batch && check && !check.ok && <div className="error-box" role="alert">Blocked by the leak check: {check.leaks.map((l) => l.key).join(', ')} repeats DM-only notes and was left out.</div>}
          {!shown ? <Loading /> : shown.parts.length === 0 ? <Empty>Nothing yet. Fill a field or press Sculpt.</Empty> : shown.parts.map((p, i) => (
            <div key={i} className={p.dm ? 'sculpt-dm' : undefined}>
              {p.dm && <div className="tiny faint">DM only</div>}
              <Markdown text={p.md} />
            </div>
          ))}

          <fieldset className="sculpt-outs" aria-label="What to do with it">
            <legend className="small">Do this with it</legend>
            {avail.map((k) => (
              <label key={k} className="row sculpt-out" style={{ gap: 6 }}>
                <input type="checkbox" checked={!!sel[k]} onChange={(e) => setSel({ ...sel, [k]: e.target.checked })} />
                <span>{OUT_LABEL[k]}</span><span className="tiny faint">{OUT_HELP[k]}</span>
              </label>
            ))}
          </fieldset>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={act.busy || missing || !chosen.length || noBlock} onClick={() => void outputs(Object.fromEntries(chosen.map((k) => [k, true])))}>Do selected{chosen.length ? ` (${chosen.length})` : ''}</button>
            {avail.includes('combat') && <button type="button" className="btn" disabled={act.busy || !combatReady} onClick={() => void outputs({ combat: true })}>Run it</button>}
            <button type="button" className="btn" disabled={act.busy || (!batch && !check?.text && !check?.md)} onClick={() => void outputs({ broker: true })}>Turn into broker note</button>
            {player && <button type="button" className="btn" disabled={act.busy || !check?.text} onClick={() => void readAloud()}>Read aloud</button>}
          </div>
          {missing ? <span className="tiny muted">Fill the fields marked * to save.</span> : noBlock && <span className="tiny muted">Press Sculpt to make the statblock first.</span>}
          {check?.publicOk === false && <span className="tiny muted" role="status">The player-visible text repeats DM-only notes, so the stage, messages and broker will refuse it until you change it.</span>}
          {out && (
            <div className="stack tight" role="status">
              {Object.entries(out.done).map(([k, v]) => <div key={k} className="small">✔ {OUT_LABEL[k as OutputKey]}{k === 'combat' ? `: ${v.count} in initiative` : k === 'page' && v.path ? `: ${v.path}` : ''}</div>)}
              {Object.entries(out.errors).map(([k, m]) => <div key={k} className="small error-box">✖ {OUT_LABEL[k as OutputKey]}: {m}</div>)}
            </div>
          )}
        </div>
      </section>
      {toastNode}
    </div>
  );
}
