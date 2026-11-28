// The GM's article editor: template, level, place in the tree, the infobox
// fields of the template, and the text in Markdown with a preview.
import { useMemo, useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, Field, Markdown, useAction } from '../../ui/index.tsx';
import { LEVELS, LEVEL_NAME, type Article, type Template, type TemplateField, type TreeItem } from './types.ts';

export interface Draft { title?: string; parentId?: string | null; template?: string }

export function Editor({ initial, draft, templates, tree, onSaved, onCancel }: {
  initial?: Article; draft?: Draft; templates: Template[]; tree: TreeItem[]; onSaved: (id: string) => void; onCancel: () => void;
}) {
  const { w } = useWorld();
  const act = useAction();
  const [title, setTitle] = useState(initial?.title ?? draft?.title ?? '');
  const [template, setTemplate] = useState(initial?.template ?? draft?.template ?? 'page');
  const [level, setLevel] = useState(initial?.level ?? 'dm');
  const [parentId, setParentId] = useState<string>(initial?.parentId ?? draft?.parentId ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? '');
  const [cover, setCover] = useState(initial?.cover ?? '');
  const [summary, setSummary] = useState(initial?.summary ?? '');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(', '));
  const [knowledge, setKnowledge] = useState(initial?.knowledge ?? '');
  const [fields, setFields] = useState<Record<string, string>>(initial?.fields ?? {});
  const [body, setBody] = useState(initial?.body ?? '');
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const tpl = templates.find((t) => t.id === template) ?? templates[0];
  const titles = useMemo(() => tree.map((a) => a.title).sort((a, b) => a.localeCompare(b)), [tree]);

  // An article cannot go under itself or anything under it.
  const blocked = useMemo(() => {
    const out = new Set<string>();
    if (!initial) return out;
    out.add(initial.id);
    let grew = true;
    while (grew) { grew = false; for (const a of tree) if (a.parentId && out.has(a.parentId) && !out.has(a.id)) { out.add(a.id); grew = true; } }
    return out;
  }, [initial, tree]);
  const parents = useMemo(() => {
    const byParent = new Map<string | null, TreeItem[]>();
    for (const a of tree) { const k = a.parentId ?? null; byParent.set(k, [...(byParent.get(k) ?? []), a]); }
    const out: { id: string; label: string }[] = [];
    const walk = (p: string | null, depth: number) => {
      for (const a of (byParent.get(p) ?? []).sort((x, y) => (x.position ?? 1e9) - (y.position ?? 1e9) || x.title.localeCompare(y.title))) {
        if (blocked.has(a.id)) continue;
        out.push({ id: a.id, label: `${'— '.repeat(depth)}${a.title}` });
        if (depth < 12) walk(a.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [tree, blocked]);

  const save = () => act.run(async () => {
    if (!title.trim()) throw new Error('Give the article a title');
    const payload = {
      title: title.trim(), template, level, parentId: parentId || null, icon: icon.trim() || null, cover: cover.trim() || null, summary,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean), aliases: aliases.split(',').map((t) => t.trim()).filter(Boolean),
      knowledge: knowledge || null, fields: Object.fromEntries([...Object.keys(initial?.fields ?? {}), ...Object.keys(fields)].map((k) => [k, fields[k] ?? ''])), body,
      ...(initial ? { rev: initial.rev } : {}),
    };
    try {
      const out: any = initial ? await w.call('PATCH', `/biblio/articles/${encodeURIComponent(initial.id)}`, payload) : await w.call('POST', '/biblio/articles', payload);
      onSaved(out.id);
    } catch (e: any) {
      if (/changed since you opened it/i.test(String(e?.message))) setConflict(true);
      throw e;
    }
  });

  const setField = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  return (
    <form className="card gold bib-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <datalist id="bib-titles">{titles.map((t) => <option key={t} value={t} />)}</datalist>
      <h2>{initial ? `Edit ${initial.title}` : 'New article'}</h2>
      <div className="grid">
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Old Kesh" required /></Field>
        <Field label="Template" help={tpl?.description}>
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.builtin ? '' : ' (yours)'}</option>)}
          </select>
        </Field>
        <Field label="Who can read it">
          <select value={level} onChange={(e) => setLevel(e.target.value as any)}>{LEVELS.map((l) => <option key={l} value={l}>{LEVEL_NAME[l]}</option>)}</select>
        </Field>
        <Field label="Inside">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">(the top of Biblio)</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>
      </div>
      {level === 'classified' && <div className="note small"><i className="fa-solid fa-lock" aria-hidden="true" /> Classified articles are never sent to any AI or MCP client, never embedded, and never shown to players or the broker.</div>}
      <Field label="Summary" help="One line, shown in lists and to the assistants first."><input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500} placeholder="A river town on the old trade road." /></Field>

      {tpl && tpl.fields.length > 0 && (
        <fieldset className="bib-fields">
          <legend className="small">{tpl.name} details</legend>
          <div className="grid">
            {tpl.fields.map((f) => <FieldInput key={f.key} f={f} value={fields[f.key] ?? ''} onChange={(v) => setField(f.key, v)} />)}
          </div>
        </fieldset>
      )}

      <div className="row between">
        <span className="small muted">Text (Markdown)</span>
        <button type="button" className="btn small" onClick={() => setPreview((p) => !p)} aria-pressed={preview}><i className={`fa-solid ${preview ? 'fa-pen' : 'fa-eye'}`} aria-hidden="true" /> {preview ? 'Write' : 'Preview'}</button>
      </div>
      {preview
        ? <div className="bib-preview"><Markdown text={body || '*Nothing written yet.*'} /></div>
        : <textarea className="code" rows={16} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Article text" placeholder={'Write [[Article name]] to link.\n\n> [!secret]\n> Only the GM sees this part.'} />}
      <p className="tiny muted">[[Name]] links an article (or makes a red link to create it). &gt; [!secret] is GM only; &gt; [!broker] the broker may sell; &gt; [!classified] no AI ever sees.</p>

      <details>
        <summary className="small muted">More: tags, other names, icon, cover picture, broker tier</summary>
        <div className="grid" style={{ marginTop: 8 }}>
          <Field label="Tags" help="Comma separated."><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="town, river" /></Field>
          <Field label="Also called" help="Other names links can use, comma separated."><input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Kesh" /></Field>
          <Field label="Icon" help={<>A Font Awesome name, e.g. fa-castle. Empty: the template’s{tpl ? <> (<i className={`fa-solid ${tpl.icon}`} aria-hidden="true" />)</> : null}.</>}><input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder={tpl?.icon} /></Field>
          <Field label="Cover picture" help="An https address, or a picture from the library's files."><input value={cover} onChange={(e) => setCover(e.target.value)} placeholder="https://…" /></Field>
          <Field label="How hard to learn" help="For the information broker's prices.">
            <select value={knowledge} onChange={(e) => setKnowledge(e.target.value as any)}><option value="">Not set</option><option value="common">Common</option><option value="local">Local</option><option value="deep">Deep</option></select>
          </Field>
        </div>
      </details>

      {conflict && <div className="note small" role="alert">Someone (or the assistant) saved this article after you opened it. Copy your text, reload the article and make your change again.</div>}
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn primary" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save article'}</button>
      </div>
    </form>
  );
}

function FieldInput({ f, value, onChange }: { f: TemplateField; value: string; onChange: (v: string) => void }) {
  const label = `${f.label}${f.gm ? ' (GM only)' : ''}`;
  const help = f.help ?? (f.type === 'link' ? 'An article name.' : f.type === 'links' ? 'Article names, comma separated.' : f.type === 'date' ? 'As written in your world, e.g. 3 Frostfall 1042 AR.' : undefined);
  if (f.type === 'long') return <div className="bib-wide"><Field label={label} help={help}><textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} /></Field></div>;
  if (f.type === 'yesno') return <Field label={label}><select value={value} onChange={(e) => onChange(e.target.value)}><option value="">Not set</option><option value="yes">Yes</option><option value="no">No</option></select></Field>;
  return (
    <Field label={label} help={help}>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode={f.type === 'number' ? 'decimal' : undefined} list={f.type === 'link' ? 'bib-titles' : undefined} />
    </Field>
  );
}
