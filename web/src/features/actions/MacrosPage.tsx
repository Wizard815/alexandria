// DM → Macros: the action list, a macro builder, key bindings and trigger URLs.
import { useEffect, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { captureState, comboFromEvent } from './keys.ts';
import { CopyButton } from '../../lib/copy.tsx';

interface Arg { name: string; type: string; label?: string; required?: boolean; default?: any; values?: string[] }
interface ActionDef { id: string; title: string; group: string; description: string; roles: string[]; args: Arg[] }
interface Step { action: string; args: Record<string, any>; delayMs: number; continueOnError: boolean }
interface Param { name: string; type: string; default?: any }
interface Macro { id: string; name: string; description: string; steps: Step[]; params: Param[]; playerRun: boolean; pinned: boolean }
interface Binding { id: string; combo: string; macroId: string; macroName: string; scope: string }
interface Trigger { id: string; macroName: string; label: string; prefix: string; perMinute: number; uses: number; lastUsedAt: string | null; revoked: boolean }

const blank = (): Macro => ({ id: '', name: '', description: '', steps: [], params: [], playerRun: false, pinned: false });

export default function MacrosPage() {
  const [tab, setTab] = useState<'macros' | 'templates' | 'keys' | 'triggers' | 'actions'>('macros');
  return (
    <div className="stack loose">
      <PageHead title="Macros" lead="Named sequences of actions, run from a button, a key or a web request." />
      <Tabs label="Macros" value={tab} onChange={setTab} items={[['macros', 'Macros'], ['templates', 'Templates'], ['keys', 'Key bindings'], ['triggers', 'Trigger URLs'], ['actions', 'Actions']]} />
      {tab === 'macros' && <Builder />}
      {tab === 'templates' && <Templates />}
      {tab === 'keys' && <Keys />}
      {tab === 'triggers' && <Triggers />}
      {tab === 'actions' && <Actions />}
    </div>
  );
}

function useActions() {
  const { w } = useWorld();
  return useLoad(() => w.call<{ actions: ActionDef[] }>('GET', '/actions'), [w]);
}

function Actions() {
  const a = useActions();
  if (!a.data) return <Loading />;
  const groups = [...new Set(a.data.actions.map((x) => x.group))];
  return (
    <div className="stack">
      {groups.map((g) => (
        <div key={g} className="card">
          <h3 style={{ marginTop: 0 }}>{g}</h3>
          {a.data!.actions.filter((x) => x.group === g).map((x) => (
            <p key={x.id} className="small" style={{ margin: '4px 0' }}><strong>{x.title}</strong> <code>{x.id}</code> <span className="muted">{x.description}{x.args.length ? ` Arguments: ${x.args.map((r) => r.name + (r.required ? '*' : '')).join(', ')}.` : ''}{x.roles.includes('player') ? ' Players may run it.' : ''}</span></p>
          ))}
        </div>
      ))}
    </div>
  );
}

function ArgInput({ spec, value, onChange }: { spec: Arg; value: any; onChange: (v: any) => void }) {
  const label = `${spec.label ?? spec.name}${spec.required ? ' *' : ''}`;
  if (spec.type === 'enum') return <Field label={label}><select value={value ?? ''} onChange={(e) => onChange(e.target.value)}><option value="">(default)</option>{spec.values?.map((v) => <option key={v}>{v}</option>)}</select></Field>;
  if (spec.type === 'bool') return <Field label={label}><select value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}><option value="">(default)</option><option value="true">Yes</option><option value="false">No</option></select></Field>;
  const num = spec.type === 'int' || spec.type === 'number';
  return <Field label={label} help="Use {{name}} to fill in one of the macro's parameters."><input value={value ?? ''} onChange={(e) => { const t = e.target.value; onChange(t === '' ? undefined : num && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t); }} /></Field>;
}

function Builder() {
  const { w } = useWorld();
  const acts = useActions();
  const list = useLoad(() => w.call<Macro[]>('GET', '/actions/macros'), [w]);
  const [edit, setEdit] = useState<Macro | null>(null);
  const [report, setReport] = useState<any>(null);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const defs = acts.data?.actions ?? [];
  if (!list.data || !acts.data) return <Loading />;

  const save = () => edit && act.run(async () => {
    const body = { ...edit, steps: edit.steps.map((s) => ({ ...s, args: Object.fromEntries(Object.entries(s.args).filter(([, v]) => v !== undefined)) })) };
    if (edit.id) await w.call('PUT', `/actions/macros/${edit.id}`, body); else await w.call('POST', '/actions/macros', body);
    setEdit(null);
    await list.reload();
    toast('Saved');
  });
  const test = (id: string) => act.run(async () => { setReport(await w.call('POST', `/actions/macros/${id}/run`, {})); });
  const move = (i: number, d: number) => edit && setEdit({ ...edit, steps: edit.steps.map((_, k, a) => a[k === i ? i + d : k === i + d ? i : k]) });
  const setStep = (i: number, p: Partial<Step>) => edit && setEdit({ ...edit, steps: edit.steps.map((s, k) => (k === i ? { ...s, ...p } : s)) });

  return (
    <div className="stack">
      <ErrorBox error={list.error || act.error} />
      {list.data.length === 0 && !edit && <Empty>No macros yet.</Empty>}
      {list.data.map((m) => (
        <div key={m.id} className="card">
          <div className="row between">
            <span><strong>{m.name}</strong> <span className="tiny muted">{m.steps.length} steps{m.pinned ? ' · pinned' : ''}{m.playerRun ? ' · players may run' : ''}</span></span>
            <span className="row">
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void test(m.id)}><i className="fa-solid fa-play" aria-hidden="true" /> Test run</button>
              <button type="button" className="btn small" onClick={() => { setEdit(m); setReport(null); }}>Edit</button>
              <button type="button" className="btn small ghost" aria-label={`Delete ${m.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/actions/macros/${m.id}`); await list.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
            </span>
          </div>
        </div>
      ))}
      {report && (
        <div className="card" role="status">
          <strong>{report.macro.name}: {report.ok ? 'done' : 'a step failed'}</strong>
          {report.steps.map((s: any) => <div key={s.index} className="small">{s.index + 1}. {s.action}: {s.status}{s.error ? ` (${s.error})` : ''} <span className="muted">{s.ms} ms</span></div>)}
        </div>
      )}
      {!edit && <button type="button" className="btn" onClick={() => { setEdit(blank()); setReport(null); }}>New macro</button>}
      {edit && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>{edit.id ? 'Edit macro' : 'New macro'}</h3>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Name"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Combat starts" /></Field>
            <Field label="Note"><input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          </div>
          <div className="row">
            <label className="row"><input type="checkbox" checked={edit.pinned} onChange={(e) => setEdit({ ...edit, pinned: e.target.checked })} /> Pin to the macro bar</label>
            <label className="row"><input type="checkbox" checked={edit.playerRun} onChange={(e) => setEdit({ ...edit, playerRun: e.target.checked })} /> Players may run it (only player-safe actions)</label>
          </div>
          <h4 style={{ margin: 0 }}>Parameters</h4>
          <p className="tiny muted" style={{ margin: 0 }}>Values a trigger URL may override. Use <code>{'{{name}}'}</code> in a step's argument.</p>
          {edit.params.map((p, i) => (
            <div key={i} className="row">
              <input aria-label="Parameter name" value={p.name} placeholder="name" onChange={(e) => setEdit({ ...edit, params: edit.params.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              <select aria-label="Type" value={p.type} onChange={(e) => setEdit({ ...edit, params: edit.params.map((x, k) => (k === i ? { ...x, type: e.target.value } : x)) })}>{['string', 'int', 'number', 'bool'].map((t) => <option key={t}>{t}</option>)}</select>
              <input aria-label="Default" value={p.default ?? ''} placeholder="default" onChange={(e) => setEdit({ ...edit, params: edit.params.map((x, k) => (k === i ? { ...x, default: e.target.value === '' ? undefined : p.type === 'int' || p.type === 'number' ? Number(e.target.value) : e.target.value } : x)) })} />
              <button type="button" className="btn small ghost" aria-label="Remove parameter" onClick={() => setEdit({ ...edit, params: edit.params.filter((_, k) => k !== i) })}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => setEdit({ ...edit, params: [...edit.params, { name: '', type: 'string' }] })}>Add parameter</button>
          <h4 style={{ margin: 0 }}>Steps</h4>
          {edit.steps.map((s, i) => {
            const def = defs.find((d) => d.id === s.action);
            return (
              <div key={i} className="card stack">
                <div className="row between">
                  <select aria-label={`Step ${i + 1} action`} value={s.action} onChange={(e) => setStep(i, { action: e.target.value, args: {} })}>{defs.map((d) => <option key={d.id} value={d.id}>{d.group}: {d.title}</option>)}</select>
                  <span className="row">
                    <button type="button" className="btn small ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><i className="fa-solid fa-arrow-up" aria-hidden="true" /></button>
                    <button type="button" className="btn small ghost" aria-label="Move down" disabled={i === edit.steps.length - 1} onClick={() => move(i, 1)}><i className="fa-solid fa-arrow-down" aria-hidden="true" /></button>
                    <button type="button" className="btn small ghost" aria-label="Remove step" onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_, k) => k !== i) })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
                  </span>
                </div>
                {s.action === 'minerva.run' && <MinervaStep step={s} onChange={(args) => setStep(i, { args })} />}
                {s.action !== 'minerva.run' && <div className="row">{def?.args.map((a) => <ArgInput key={a.name} spec={a} value={s.args[a.name]} onChange={(v) => setStep(i, { args: { ...s.args, [a.name]: v } })} />)}</div>}
                <div className="row">
                  <Field label="Wait first (ms)"><input type="number" min={0} max={10000} value={s.delayMs} onChange={(e) => setStep(i, { delayMs: Number(e.target.value) || 0 })} /></Field>
                  <label className="row"><input type="checkbox" checked={s.continueOnError} onChange={(e) => setStep(i, { continueOnError: e.target.checked })} /> Carry on if this fails</label>
                </div>
              </div>
            );
          })}
          <div className="row">
            <button type="button" className="btn small" onClick={() => setEdit({ ...edit, steps: [...edit.steps, { action: defs[0]?.id ?? '', args: {}, delayMs: 0, continueOnError: false }] })}>Add step</button>
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save</button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      {toastNode}
    </div>
  );
}

function Keys() {
  const { w } = useWorld();
  const macros = useLoad(() => w.call<Macro[]>('GET', '/actions/macros'), [w]);
  const binds = useLoad(() => w.call<{ bindings: Binding[] }>('GET', '/actions/bindings'), [w]);
  const act = useAction();
  const [combo, setCombo] = useState('');
  const [macroId, setMacroId] = useState('');
  const [scope, setScope] = useState('both');
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    captureState.on = true;
    const onKey = (e: KeyboardEvent) => {
      const c = comboFromEvent(e);
      if (!c) return;
      e.preventDefault();
      setCombo(c);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { captureState.on = false; window.removeEventListener('keydown', onKey, true); };
  }, [capturing]);

  if (!macros.data || !binds.data) return <Loading />;
  const add = () => act.run(async () => {
    await w.call('POST', '/actions/bindings', { combo, macroId: macroId || macros.data![0]?.id, scope });
    setCombo('');
    await binds.reload();
  });
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>Bindings work in this web app while its tab is focused. Choose "Installed app" or "Both" for the keys the desktop app will listen for everywhere. A keyboard's F13 to F24 keys are ideal (see docs/MACROS.md).</p>
      <ErrorBox error={binds.error || act.error} />
      {binds.data.bindings.length === 0 && <Empty>No key bindings yet.</Empty>}
      {binds.data.bindings.map((b) => (
        <div key={b.id} className="card row between">
          <span><kbd>{b.combo}</kbd> runs <strong>{b.macroName}</strong> <span className="tiny muted">{b.scope === 'both' ? 'web and app' : b.scope}</span></span>
          <button type="button" className="btn small ghost" aria-label={`Remove ${b.combo}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/actions/bindings/${b.id}`); await binds.reload(); })}><i className="fa-solid fa-trash" aria-hidden="true" /></button>
        </div>
      ))}
      <div className="card row" style={{ alignItems: 'flex-end' }}>
        <Field label="Keys"><input readOnly value={capturing ? 'Press a key…' : combo} placeholder="Click Press a key" aria-label="Keys" /></Field>
        <button type="button" className="btn small" onClick={() => setCapturing(!capturing)}>{capturing ? 'Cancel' : 'Press a key'}</button>
        <Field label="Macro"><select value={macroId} onChange={(e) => setMacroId(e.target.value)}>{macros.data.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <Field label="Where"><select value={scope} onChange={(e) => setScope(e.target.value)}><option value="both">Web and installed app</option><option value="web">Web app only</option><option value="app">Installed app only</option></select></Field>
        <button type="button" className="btn primary" disabled={act.busy || !combo || !macros.data.length} onClick={() => void add()}>Bind</button>
      </div>
    </div>
  );
}

function Triggers() {
  const { w } = useWorld();
  const macros = useLoad(() => w.call<Macro[]>('GET', '/actions/macros'), [w]);
  const list = useLoad(() => w.call<Trigger[]>('GET', '/actions/triggers'), [w]);
  const act = useAction();
  const [macroId, setMacroId] = useState('');
  const [label, setLabel] = useState('');
  const [perMinute, setPerMinute] = useState(6);
  const [fresh, setFresh] = useState<{ url: string } | null>(null);
  if (!macros.data || !list.data) return <Loading />;
  const make = () => act.run(async () => {
    const t = await w.call<any>('POST', `/actions/macros/${macroId || macros.data![0].id}/triggers`, { label, perMinute });
    setFresh({ url: t.url });
    setLabel('');
    await list.reload();
  });
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>A trigger URL runs exactly one macro, as you, with no sign-in. Anyone who has the URL can run it, so treat it like a password. It is shown once.</p>
      <ErrorBox error={list.error || act.error} />
      {fresh && (
        <div className="card" role="status">
          <strong>Copy this now: it will not be shown again.</strong>
          <input readOnly value={fresh.url} aria-label="Trigger URL" onFocus={(e) => e.currentTarget.select()} style={{ width: '100%' }} />
          <div className="row"><CopyButton text={fresh.url} /><button type="button" className="btn small" onClick={() => setFresh(null)}>Done</button></div>
        </div>
      )}
      {list.data.length === 0 && <Empty>No trigger URLs yet.</Empty>}
      {list.data.map((t) => (
        <div key={t.id} className="card row between">
          <span><strong>{t.label || t.macroName}</strong> <span className="tiny muted">runs {t.macroName} · {t.prefix}… · up to {t.perMinute}/min · used {t.uses}×{t.revoked ? ' · revoked' : ''}</span></span>
          {!t.revoked && <button type="button" className="btn small" onClick={() => void act.run(async () => { await w.call('DELETE', `/actions/triggers/${t.id}`); await list.reload(); })}>Revoke</button>}
        </div>
      ))}
      <div className="card row" style={{ alignItems: 'flex-end' }}>
        <Field label="Macro"><select value={macroId} onChange={(e) => setMacroId(e.target.value)}>{macros.data.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Stream Deck key 3" /></Field>
        <Field label="Runs per minute"><input type="number" min={1} max={60} value={perMinute} onChange={(e) => setPerMinute(Number(e.target.value) || 6)} /></Field>
        <button type="button" className="btn primary" disabled={act.busy || !macros.data.length} onClick={() => void make()}>Create URL</button>
      </div>
    </div>
  );
}

const TOOL_CHOICES: [string, string][] = [['play_music', 'Music'], ['play_ambience', 'Ambience'], ['play_sfx', 'Sound effects'], ['show_on_stage', 'Stage'], ['send_quick_event', 'Quick events'], ['set_combat', 'Combat on/off'], ['add_combatant', 'Add creatures'], ['damage_combatant', 'Damage'], ['set_conditions', 'Conditions'], ['next_turn', 'Next turn'], ['add_item', 'Give items'], ['add_coin', 'Give coins'], ['advance_world_time', 'World clock'], ['send_table_chat', 'Table chat'], ['search_library', 'Search the library']];

/** A Minerva step: a prompt with {parameters}, the tools she may use, and whether she does it or proposes it. */
function MinervaStep({ step, onChange }: { step: Step; onChange: (args: Record<string, any>) => void }) {
  const a = step.args;
  const picked = new Set(String(a.tools ?? '').split(',').map((x) => x.trim()).filter(Boolean));
  const toggle = (t: string) => { const n = new Set(picked); if (n.has(t)) n.delete(t); else n.add(t); onChange({ ...a, tools: [...n].join(',') }); };
  return (
    <div className="stack" data-testid="minerva-step">
      <Field label="What Minerva should do" help="Write it as you would say it. Use {{name}} (or {name}) for the macro's parameters, e.g. Start an ambush at {{place}}: tense music, show {{map}}, start combat with {{monsters}}."><textarea rows={4} value={a.prompt ?? ''} onChange={(e) => onChange({ ...a, prompt: e.target.value })} /></Field>
      <div className="row">
        <Field label="Mode"><select value={a.mode ?? 'do'} onChange={(e) => onChange({ ...a, mode: e.target.value })}><option value="do">Do it now</option><option value="propose">Propose (I confirm each change)</option></select></Field>
      </div>
      <div><span className="small muted">Tools she may use (none ticked: the usual table tools)</span>
        <div className="row">{TOOL_CHOICES.map(([t, l]) => <label key={t} className="row small"><input type="checkbox" checked={picked.has(t)} onChange={() => toggle(t)} /> {l}</label>)}</div></div>
    </div>
  );
}

interface Template { id: string; name: string; description: string; params: { name: string; label?: string }[] }
function Templates() {
  const { w } = useWorld();
  const list = useLoad(() => w.call<Template[]>('GET', '/actions/macro-templates'), [w]);
  const act = useAction();
  const { toast, toastNode } = useToast();
  if (!list.data) return <Loading />;
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>Ready-made agent macros. Copy one, then edit its words and tools on the Macros tab. Each is a single Minerva step.</p>
      <ErrorBox error={list.error || act.error} />
      {list.data.map((t) => (
        <div key={t.id} className="card row between" data-testid="macro-template">
          <span><strong>{t.name}</strong> <span className="tiny muted">{t.description}{t.params.length ? ` Parameters: ${t.params.map((p) => p.name).join(', ')}.` : ''}</span></span>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(async () => { const m = await w.call<any>('POST', `/actions/macro-templates/${t.id}/copy`, {}); toast(`Copied as “${m.name}”`); })}>Copy to my macros</button>
        </div>
      ))}
      {toastNode}
    </div>
  );
}
