// A simple template editor: fields (add, remove, reorder), the output body, the save target.
import { useState } from 'react';
import { PageHead, ErrorBox, Field, useAction } from '../../ui/index.tsx';
import { useWorld } from '../../lib/world.tsx';
import { CATEGORIES, FIELD_TYPES, type Field as F, type Outputs, type Target, type Tpl } from './types.ts';

const blank = (): Tpl => ({
  id: '', builtin: false, key: null, name: '', description: '', perspective: 'gm', category: 'Story', outputs: { page: true },
  fields: [{ key: 'name', label: 'Name', type: 'text', required: true }, { key: 'notes', label: 'Notes', type: 'longtext' }],
  body: '# {{name}}\n\n{{notes}}\n', target: { kind: 'page', path: 'Sculpted/{{name}}', visibility: 'gm' },
});

export default function TemplateEditor({ initial, onDone }: { initial: Tpl | null; onDone: (id?: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [t, setT] = useState<Tpl>(() => structuredClone(initial ?? blank()));
  const setF = (i: number, p: Partial<F>) => setT((o) => ({ ...o, fields: o.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) }));
  const move = (i: number, d: number) => setT((o) => { const a = [...o.fields]; const j = i + d; if (j < 0 || j >= a.length) return o; [a[i], a[j]] = [a[j], a[i]]; return { ...o, fields: a }; });
  const setTarget = (p: Partial<Target>) => setT((o) => ({ ...o, target: { ...o.target, ...p } }));
  const setOut = (p: Partial<Outputs>) => setT((o) => ({ ...o, outputs: { ...o.outputs, ...p } }));

  const save = () => act.run(async () => {
    const body = { ...t, fields: t.fields.map((f) => ({ ...f, options: f.type === 'select' ? f.options : undefined })) };
    const r = initial ? await w.call<Tpl>('PUT', `/sculpt/templates/${initial.id}`, body) : await w.call<Tpl>('POST', '/sculpt/templates', body);
    onDone(r.id);
  });
  const del = () => act.run(async () => { if (!initial || !window.confirm(`Delete “${initial.name}”?`)) return; await w.call('DELETE', `/sculpt/templates/${initial.id}`); onDone(); });
  const reset = () => act.run(async () => { if (!initial || !window.confirm('Restore the original built-in template?')) return; await w.call('POST', `/sculpt/templates/${initial.id}/reset`); onDone(initial.id); });
  const tk = t.target.kind;

  return (
    <div className="page wide">
      <PageHead title={initial ? `Edit “${initial.name}”` : 'New template'} lead="Use {{key}} for a field, {{gen:name race=elf}}, {{dice:2d6+3}} or {{pick:a|b|c}} for instant results, {{world.date}}, {{party.level}} or {{location}} for context, {{#if field}}…{{/if}} and {{#each list}}{{this}}{{/each}}. Wrap GM-only parts in {{#gm}} … {{/gm}}: they become secret blocks.">
        <button type="button" className="btn small ghost" onClick={() => onDone()}>Cancel</button>
      </PageHead>
      <div className="card stack">
        <Field label="Name"><input value={t.name} maxLength={80} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
        <Field label="Description"><input value={t.description} maxLength={400} onChange={(e) => setT({ ...t, description: e.target.value })} /></Field>
        <Field label="Category"><select value={t.category} onChange={(e) => setT({ ...t, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Perspective" help="A player-perspective template is built only from what players can see and has no GM-only parts."><select value={t.perspective} onChange={(e) => setT({ ...t, perspective: e.target.value as Tpl['perspective'] })}><option value="gm">GM notes</option><option value="player">Players’ view</option></select></Field>
      </div>
      <h3>Fields</h3>
      {t.fields.map((f, i) => (
        <div key={i} className="card stack">
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input aria-label="Key" style={{ width: 120 }} value={f.key} placeholder="key" onChange={(e) => setF(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} />
            <input aria-label="Label" style={{ flex: 1, minWidth: 120 }} value={f.label} placeholder="Label" onChange={(e) => setF(i, { label: e.target.value })} />
            <select aria-label="Type" value={f.type} onChange={(e) => setF(i, { type: e.target.value as F['type'] })}>{FIELD_TYPES.map((x) => <option key={x}>{x}</option>)}</select>
          </div>
          {f.type === 'select' && <input aria-label="Options" value={(f.options ?? []).join(', ')} placeholder="Options, separated by commas" onChange={(e) => setF(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />}
          {f.type === 'table' && <input aria-label="Columns" value={(f.columns ?? []).join(', ')} placeholder="Column names, separated by commas" onChange={(e) => setF(i, { columns: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />}
          {f.type === 'rollTable' && <select aria-label="Die field" value={f.dieField ?? ''} onChange={(e) => setF(i, { dieField: e.target.value || undefined })}><option value="">(d6)</option>{t.fields.filter((x) => x.type === 'select' || x.type === 'text').map((x) => <option key={x.key} value={x.key}>Die from: {x.label}</option>)}</select>}
          <details>
            <summary className="tiny">Generators and defaults</summary>
            <div className="stack tight">
              <input aria-label="Generator" value={f.gen ?? ''} placeholder="Always filled by: gen:coins level=$level, dice:2d6, pick:a|b" onChange={(e) => setF(i, { gen: e.target.value || undefined })} />
              <input aria-label="Fallback" value={f.fallback ?? ''} placeholder="When there is no model: gen:rumour tone=$tone" onChange={(e) => setF(i, { fallback: e.target.value || undefined })} />
              <input aria-label="Default" value={f.default ?? ''} placeholder="Default value" onChange={(e) => setF(i, { default: e.target.value || undefined })} />
            </div>
          </details>
          <input aria-label="Hint" value={f.hint ?? ''} placeholder="Hint for the writer (also guides the model)" onChange={(e) => setF(i, { hint: e.target.value })} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={!!f.required} onChange={(e) => setF(i, { required: e.target.checked })} /> Required</label>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={!!f.gmOnly} disabled={t.perspective === 'player'} onChange={(e) => setF(i, { gmOnly: e.target.checked })} /> GM only</label>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn small ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="btn small ghost" aria-label="Move down" disabled={i === t.fields.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="btn small ghost" aria-label="Remove field" onClick={() => setT({ ...t, fields: t.fields.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => setT({ ...t, fields: [...t.fields, { key: `field${t.fields.length + 1}`, label: 'New field', type: 'text' }] })}>Add field</button>
      <h3>Output</h3>
      <div className="card stack">
        <Field label="Markdown body"><textarea rows={12} style={{ fontFamily: 'monospace' }} value={t.body} onChange={(e) => setT({ ...t, body: e.target.value })} /></Field>
        <Field label="Save to">
          <select value={tk} onChange={(e) => setTarget({ kind: e.target.value as Target['kind'], path: t.target.path || `Sculpted/{{${t.fields[0]?.key ?? 'name'}}}`, visibility: t.target.visibility ?? 'gm' })}>
            <option value="page">A library page</option><option value="person">People (and a page)</option><option value="combat">Combat statblock page</option><option value="shop">Shop (page and item list)</option><option value="none">Nowhere</option>
          </select>
        </Field>
        {(tk === 'page' || tk === 'person' || tk === 'shop') && (
          <>
            <Field label="Path pattern"><input value={t.target.path ?? ''} onChange={(e) => setTarget({ path: e.target.value })} /></Field>
            <Field label="Visibility" help="Secret blocks are always hidden from players, whatever this says."><select value={t.target.visibility ?? 'gm'} onChange={(e) => setTarget({ visibility: e.target.value as 'gm' | 'party' })}><option value="gm">GM only</option><option value="party">Shared with the party</option></select></Field>
          </>
        )}
        {tk === 'shop' && <Field label="Item list field"><select value={t.target.listField ?? ''} onChange={(e) => setTarget({ listField: e.target.value || undefined })}><option value="">(none)</option>{t.fields.filter((f) => f.type === 'list').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></Field>}
      </div>
      <h3>Outputs</h3>
      <div className="card stack">
        <span className="small muted">What is ticked by default when you use this template. You can untick each one every time.</span>
        {([['page', 'Save as a page'], ['stage', 'Show on the stage (player-safe parts only)'], ['combat', 'Add to combat'], ['send', 'Send to players (players’ view only)'], ['broker', 'Make a broker note']] as [keyof Outputs, string][]).map(([k, label]) => (
          <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!t.outputs?.[k]} disabled={k === 'send' && t.perspective !== 'player'} onChange={(e) => setOut({ [k]: e.target.checked })} /> {label}</label>
        ))}
        {(t.outputs?.combat || t.outputs?.combatField) && <Field label="Combat field" help="A statblock field, or a list of lines like “3× Goblin (CR 1/4, AC 15, HP 7)”."><select value={t.outputs?.combatField ?? ''} onChange={(e) => setOut({ combatField: e.target.value || undefined })}><option value="">(the statblock)</option>{t.fields.filter((f) => f.type === 'list' || f.type === 'statblock').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></Field>}
      </div>
      <ErrorBox error={act.error} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={act.busy || !t.name.trim()} onClick={() => void save()}>Save template</button>
        {initial?.builtin ? <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void reset()}>Reset to original</button> : initial && <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void del()}>Delete</button>}
      </div>
    </div>
  );
}
