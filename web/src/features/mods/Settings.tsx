// World settings → House rules: every rule that comes with Alexandria and the
// world's own, on or off, their options, what a rule switches in the world's
// settings, and import / export of rule files (.alxmod.json).
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, Loading, Switch, useAction, useToast } from '../../ui/index.tsx';
import { GROUP_LABEL, useHouseRules, type HouseRule, type OptionSpec } from './shared.tsx';

export default function HouseRulesSettings() {
  const { isDM } = useWorld();
  const { rules, list } = useHouseRules();
  const { toastNode, toast } = useToast();
  if (rules.loading && !rules.data) return <Loading />;
  const groups = [...new Set(list.map((r) => r.group).filter(Boolean))] as string[];
  const loose = list.filter((r) => !r.group);
  return (
    <div className="stack">
      <p className="small muted">
        House rules are your table’s own rules. Each one is a small file: turn it on and it adds what it needs, such as counters on the
        players’ sheets, a chat word like <code>/reroll</code>, rule text for hover cards and the assistant, or a whole system like spell points.
      </p>
      <ErrorBox error={rules.error} />
      {groups.map((g) => (
        <section key={g} className="card stack">
          <h3>{GROUP_LABEL[g] ?? g}</h3>
          <p className="tiny muted">Only one of these is on at a time. With none on, spells use slots as written.</p>
          {list.filter((r) => r.group === g).map((r) => <RuleCard key={r.id} r={r} dm={isDM} onDone={(t) => { toast(t); void rules.reload(); }} />)}
        </section>
      ))}
      <section className="card stack">
        <h3>Table rules</h3>
        {loose.map((r) => <RuleCard key={r.id} r={r} dm={isDM} onDone={(t) => { toast(t); void rules.reload(); }} />)}
      </section>
      {isDM && <ImportBox onDone={(t) => { toast(t); void rules.reload(); }} />}
      {toastNode}
    </div>
  );
}

function RuleCard({ r, dm, onDone }: { r: HouseRule; dm: boolean; onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [open, setOpen] = useState(false);
  const blocked = (r.missing ?? []).length > 0;
  const toggle = (on: boolean) => act.run(async () => {
    const sets = Object.keys(r.presets ?? {}).filter((k) => !(r.waiting ?? []).includes(k));
    if (sets.length && !window.confirm(`${on ? 'Turn on' : 'Turn off'} ${r.name}? This ${on ? 'changes' : 'puts back'} these world settings: ${sets.join(', ')}.`)) return;
    const out = await w.call<any>('PUT', `/mods/${r.id}/enabled`, { on });
    onDone(on ? `${r.name} is on${out.turnedOff?.length ? ` (turned off ${out.turnedOff.join(', ')})` : ''}` : `${r.name} is off`);
  });
  const remove = () => act.run(async () => {
    if (!window.confirm(`Remove ${r.name} from this world? Its counters go too.`)) return;
    await w.call('DELETE', `/mods/${r.id}`);
    onDone(`${r.name} removed`);
  });
  const download = () => act.run(async () => {
    const file = await w.call<any>('GET', `/mods/${r.id}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${r.id}.alxmod.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return (
    <div className="stack tight" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span>
          <strong>{r.name}</strong>{' '}
          <span className="tiny muted">v{r.version}{r.author ? ` · ${r.author}` : ''}{r.source === 'imported' ? ' · this world’s own' : ''}</span>
        </span>
        {dm && <Switch checked={r.enabled} label={`${r.name} on`} onChange={(v) => { if (!act.busy && !(v && blocked)) void toggle(v); }} />}
      </div>
      <div className="small">{r.summary}</div>
      {blocked && <div className="tiny muted">Needs a part of Alexandria this server does not have yet ({r.missing!.join(', ')}).</div>}
      {r.commands.length > 0 && <div className="tiny muted">Chat: {r.commands.map((c) => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}</div>}
      <ErrorBox error={act.error} />
      {dm && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(r.optionSpecs).length > 0 || Object.keys(r.presets ?? {}).length > 0 || r.rules.length > 0) && <button type="button" className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide details' : 'Options and details'}</button>}
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void download()}>Export</button>
          {r.source === 'imported' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void remove()}>Remove</button>}
        </div>
      )}
      {open && dm && <Details r={r} onDone={onDone} />}
    </div>
  );
}

function Details({ r, onDone }: { r: HouseRule; onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [vals, setVals] = useState<Record<string, unknown>>(r.options);
  const save = () => act.run(async () => { await w.call('PUT', `/mods/${r.id}/options`, { options: vals }); onDone(`${r.name}: options saved`); });
  const presets = Object.entries(r.presets ?? {});
  return (
    <div className="stack tight">
      {Object.entries(r.optionSpecs).map(([k, s]) => <OptionField key={k} name={k} spec={s} value={vals[k]} onChange={(v) => setVals({ ...vals, [k]: v })} />)}
      {Object.keys(r.optionSpecs).length > 0 && <div><button type="button" className="btn small primary" disabled={act.busy} onClick={() => void save()}>Save options</button></div>}
      <ErrorBox error={act.error} />
      {presets.length > 0 && (
        <details>
          <summary className="small">World settings this rule sets</summary>
          <ul className="tiny" style={{ margin: 0 }}>
            {presets.map(([k, v]) => <li key={k}><code>{k}</code>: {JSON.stringify(v).slice(0, 120)}{(r.waiting ?? []).includes(k) ? ' (not in this Alexandria yet, skipped)' : ''}</li>)}
          </ul>
        </details>
      )}
      {r.rules.map((x) => <div key={x.term} className="small"><strong>{x.term}.</strong> {x.text}</div>)}
    </div>
  );
}

function OptionField({ name, spec, value, onChange }: { name: string; spec: OptionSpec; value: unknown; onChange: (v: unknown) => void }) {
  const id = `opt-${name}`;
  return (
    <label className="stack tight" htmlFor={id}>
      <span className="small">{spec.label}{spec.help && <span className="tiny muted"> · {spec.help}</span>}</span>
      {spec.type === 'boolean' ? <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        : spec.type === 'int' ? <input id={id} className="input" type="number" min={spec.min} max={spec.max} value={Number(value ?? spec.default)} onChange={(e) => onChange(Math.trunc(Number(e.target.value)))} style={{ maxWidth: 120 }} />
          : spec.type === 'enum' ? <select id={id} className="input" value={String(value ?? spec.default)} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 220 }}>{spec.values.map((v) => <option key={v} value={v}>{v}</option>)}</select>
            : <input id={id} className="input" maxLength={spec.max} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

function ImportBox({ onDone }: { onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; errors: string[]; notes?: string[]; mod?: any } | null>(null);
  const parse = () => { try { return JSON.parse(text); } catch { return text; } };
  const run = () => act.run(async () => setCheck(await w.call<any>('POST', '/mods/check', { mod: parse() })));
  const save = () => act.run(async () => { await w.call('POST', '/mods/import', { mod: parse() }); setText(''); setCheck(null); onDone('House rule saved. Turn it on above.'); });
  const file = async (f: File | undefined) => { if (f) { setText(await f.text()); setCheck(null); } };
  return (
    <section className="card stack">
      <h3>Add a house rule</h3>
      <p className="tiny muted">Paste a rule file (.alxmod.json) someone shared, or one the assistant wrote for you. It is checked first and starts off. The format is in docs/MODS.md.</p>
      <textarea className="input" rows={6} aria-label="House rule file" value={text} onChange={(e) => { setText(e.target.value); setCheck(null); }} placeholder='{ "kit": 1, "id": "hero-points", "name": "Hero points", ... }' style={{ fontFamily: 'monospace', fontSize: 12 }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <label className="btn small">Open a file<input type="file" accept=".json,application/json" hidden onChange={(e) => void file(e.target.files?.[0])} /></label>
        <button type="button" className="btn small" disabled={act.busy || !text.trim()} onClick={() => void run()}>Check</button>
        <button type="button" className="btn small primary" disabled={act.busy || !check?.ok} onClick={() => void save()}>Save to this world</button>
      </div>
      <ErrorBox error={act.error} />
      {check && !check.ok && <ul className="small" role="alert">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {check?.ok && <div className="small">Looks good: <strong>{check.mod?.name}</strong>{check.notes?.length ? <ul className="tiny">{check.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}</div>}
    </section>
  );
}
