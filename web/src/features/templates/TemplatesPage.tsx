// DM page: Templates & guides. Guides the assistant follows for a kind of task (towns: research steps, sources,
// sections, tone, exemplar pages), and templates for generators, macros, assist panels, shops and library pages.
// Made with the assistant: "New with the assistant" (describe it, answer a few questions, edit, save) or "From
// examples" (pick library pages; their common structure becomes a guide). Versioned, per world, each on or off.
// Web research (the assistant searching the web for a real-world reference) is turned on here, and is off by default.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { askAssistant } from '../agent/prefill.ts';
import './templates.css';

type Kind = 'guide' | 'generator' | 'macro' | 'assist' | 'shop' | 'library';
const KINDS: [Kind, string, string][] = [
  ['guide', 'Agent guide', 'How the assistant does a kind of task: research steps, sources, sections, tone, example pages.'],
  ['generator', 'Generator template', 'The structure and fields of a generated town, NPC, tavern, shop…'],
  ['macro', 'Macro template', 'A macro with blanks you fill in when you run it.'],
  ['assist', 'Assist panel', 'A saved workspace of panes and a request for the assistant.'],
  ['shop', 'Shop generation', 'A guide the shop generator follows.'],
  ['library', 'Library page', 'A page skeleton for new library pages.'],
];
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l])) as Record<Kind, string>;
const STEP_KINDS: [string, string][] = [['library', 'Search the library'], ['neighbours', 'Neighbouring places'], ['exemplars', 'Read example pages'], ['web', 'Web research'], ['instruction', 'Instruction']];
const PANES = ['assistant', 'library', 'combat', 'sound', 'inbox', 'scenes', 'clock', 'stage', 'generators', 'minerva', 'transcript'];

interface Step { kind: string; text: string; query?: string }
interface Tpl { id?: string; kind: Kind; name: string; description: string; triggers: string[]; enabled: boolean; spec: any; version?: number; updatedAt?: string }
interface Version { version: number; savedAt: string; template: Tpl }
interface WebCfg { enabled: boolean; provider: 'openrouter' | 'searxng'; searxUrl: string; providerId: string; model: string; allowTerms: string[]; maxResults: number }
interface PageLite { id: string; title: string; path: string; tags?: string[] }

const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
const blank = (kind: Kind): Tpl => ({ kind, name: '', description: '', triggers: [], enabled: true, spec: kind === 'guide' ? { steps: [], sections: [], exemplars: [] } : kind === 'macro' ? { params: [], mode: 'propose' } : kind === 'assist' ? { layout: 'cols', panes: ['library', 'assistant'] } : {} });

export default function TemplatesPage() {
  const { w } = useWorld();
  const [tab, setTab] = useState<'list' | 'new' | 'examples' | 'web'>('list');
  const [editing, setEditing] = useState<Tpl | null>(null);
  const list = useLoad(() => w.call<{ templates: Tpl[]; model: boolean }>('GET', '/templates'), [w]);
  const web = useLoad(() => w.call<{ config: WebCfg; providers: { id: string; name: string }[]; shop: boolean }>('GET', '/templates/web'), [w]);
  const open = (t: Tpl) => { setEditing(t); setTab('list'); };
  return (
    <div className="stack tpl-page">
      <PageHead title="Templates & guides" lead="Guides the assistant follows for a kind of task, and templates for generators, macros, panels, shops and pages. Make them with the assistant." />
      <Tabs label="Templates" value={tab} onChange={(v) => { setTab(v); setEditing(null); }} items={[['list', 'Templates'], ['new', 'New with the assistant'], ['examples', 'From examples'], ['web', 'Web research']]} />
      {tab === 'list' && (editing
        ? <Editor initial={editing} shop={!!web.data?.shop} onDone={() => { setEditing(null); void list.reload(); }} />
        : <TemplateList data={list.data?.templates ?? null} error={list.error} reload={list.reload} onEdit={open} onNew={(k) => open(blank(k))} shop={!!web.data?.shop} />)}
      {tab === 'new' && <MakeWithAssistant model={!!list.data?.model} onSaved={() => { void list.reload(); setTab('list'); }} />}
      {tab === 'examples' && <FromExamples onSaved={() => { void list.reload(); setTab('list'); }} />}
      {tab === 'web' && (web.data ? <WebSettings data={web.data} reload={web.reload} /> : <><ErrorBox error={web.error} />{!web.error && <Loading what="web research" />}</>)}
    </div>
  );
}

// ---- the list ----

function TemplateList({ data, error, reload, onEdit, onNew, shop }: { data: Tpl[] | null; error: string | null; reload: () => Promise<void> | void; onEdit: (t: Tpl) => void; onNew: (k: Kind) => void; shop: boolean }) {
  const { w } = useWorld();
  const { busy, error: err, run } = useAction();
  const [filter, setFilter] = useState<Kind | ''>('');
  const [newKind, setNewKind] = useState<Kind>('guide');
  if (!data) return <>{error ? <ErrorBox error={error} /> : <Loading what="templates" />}</>;
  const shown = data.filter((t) => !filter || t.kind === filter);
  return (
    <div className="stack">
      <ErrorBox error={err} />
      <div className="row">
        <label className="row tight"><span className="tiny">Show</span>
          <select value={filter} onChange={(e) => setFilter(e.target.value as Kind | '')} aria-label="Show only one kind">
            <option value="">Every kind</option>
            {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <span className="grow" />
        <label className="row tight"><span className="sr-only">Kind of new template</span>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as Kind)} aria-label="Kind of new template">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        <button type="button" className="btn small" onClick={() => onNew(newKind)}>New by hand</button>
      </div>
      {!shown.length && <Empty>No templates yet. Use <b>New with the assistant</b>: describe what you want, e.g. “Towns: always research the real Japanese town it is based on, my own world lore and the towns around it.”</Empty>}
      <ul className="tpl-list">
        {shown.map((t) => (
          <li key={t.id} className="card tpl-item" data-testid="tpl-item" data-name={t.name}>
            <div className="row between">
              <div className="stack tight" style={{ minWidth: 0 }}>
                <strong>{t.name} <span className="chip">{KIND_LABEL[t.kind]}</span> <span className="chip" title="Version">v{t.version}</span>{!t.enabled && <span className="chip red">Off</span>}</strong>
                {t.description && <span className="tiny muted">{t.description}</span>}
                {t.triggers.length > 0 && <span className="tiny">Used for: {t.triggers.join(', ')}</span>}
              </div>
              <label className="row tight tiny"><input type="checkbox" checked={t.enabled} disabled={busy} onChange={(e) => void run(async () => { await w.call('PUT', `/templates/${t.id}`, { enabled: e.target.checked }); await reload(); })} /> On</label>
            </div>
            <div className="row">
              <button type="button" className="btn small" onClick={() => onEdit(t)}>Edit</button>
              <UseButton t={t} shop={shop} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What "use" means for each kind. */
function UseButton({ t, shop }: { t: Tpl; shop: boolean }) {
  const { w, info } = useWorld();
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const { toast, toastNode } = useToast();
  const [ask, setAsk] = useState<null | 'page' | 'macro' | 'shop'>(null);
  const [name, setName] = useState('');
  const [out, setOut] = useState('');
  const slug = info.slug;
  const btn = (label: string, onClick: () => void, title?: string) => <button type="button" className="btn small" title={title} onClick={onClick} disabled={busy}>{label}</button>;
  let main: React.ReactNode = null;
  if (t.kind === 'guide' || t.kind === 'generator') main = btn('Ask the assistant', () => askAssistant(`Use guide ${t.name}: `), 'Put a request that uses this guide in the assistant');
  if (t.kind === 'library') main = <>{btn('New page from this', () => { setName(''); setAsk('page'); })}{btn('Ask the assistant', () => askAssistant(`Use guide ${t.name}: `))}</>;
  if (t.kind === 'macro') main = btn('Make a macro', () => { setName(t.name); setAsk('macro'); });
  if (t.kind === 'assist') main = btn('Open', () => {
    const panes = (t.spec.panes ?? []).filter(Boolean);
    navigate(`/w/${slug}/dm/ws?l=${encodeURIComponent(panes.length > 1 ? t.spec.layout || 'cols' : 'one')}&p=${encodeURIComponent(panes.join(','))}`);
    if (t.spec.prompt) setTimeout(() => askAssistant(t.spec.prompt), 300);
  });
  if (t.kind === 'shop') main = shop ? btn('Make a shop', () => { setOut(''); setAsk('shop'); }) : <span className="tiny muted">The shop generator is not installed yet.</span>;
  return (
    <>
      {main}
      {toastNode}
      {ask && (
        <Modal title={ask === 'page' ? 'New page from the template' : ask === 'macro' ? 'Make a macro' : 'Make a shop'} onClose={() => setAsk(null)}>
          <ErrorBox error={error} />
          {ask !== 'shop' && <Field label={ask === 'page' ? 'Page name' : 'Macro name'}><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus /></Field>}
          {ask === 'page' && <p className="tiny muted">Saved DM only in {t.spec.folder || 'the library root'}; share it when it is ready.</p>}
          {ask === 'macro' && <p className="tiny muted">The macro asks for {(t.spec.params ?? []).map((p: any) => p.label || p.name).join(', ') || 'nothing'} each time it runs, and {t.spec.mode === 'do' ? 'does it at once' : 'proposes each change for you to approve'}.</p>}
          {out && <pre className="tpl-out">{out}</pre>}
          <div className="row">
            <button type="button" className="btn primary" disabled={busy || (ask !== 'shop' && !name.trim())} onClick={() => void run(async () => {
              if (ask === 'page') {
                const title = name.trim();
                const md = String(t.spec.body || `# {name}\n\n${(t.spec.sections ?? []).map((s: string) => `## ${s}\n\n`).join('')}`).replace(/\{name\}/g, title);
                const tags = (t.spec.tags ?? []).length ? `---\ntags: [${t.spec.tags.join(', ')}]\n---\n` : '';
                const p = await w.call<any>('PUT', '/library/pages', { path: `${t.spec.folder ? `${t.spec.folder}/` : ''}${String(t.spec.titlePattern || '{name}').replace(/\{name\}/g, title)}`, visibility: 'dm', markdown: tags + md });
                setAsk(null);
                navigate(`/w/${slug}/dm/library?page=${encodeURIComponent(p.id)}`);
              } else if (ask === 'macro') {
                await w.call('POST', '/actions/macros', {
                  name: name.trim(), description: t.description,
                  params: (t.spec.params ?? []).map((p: any) => ({ name: p.name, type: 'string', label: p.label || p.name, default: p.default ?? '', maxLength: 300 })),
                  steps: [{ action: 'minerva.run', args: { prompt: t.spec.prompt, mode: t.spec.mode || 'propose', tools: t.spec.tools || '' }, delayMs: 0, continueOnError: false }],
                });
                setAsk(null);
                toast(`Macro “${name.trim()}” made: run it from Macros.`);
              } else {
                const r = await w.call<any>('POST', `/templates/${t.id}/shop`, {});
                setOut(JSON.stringify(r.result, null, 2).slice(0, 4000));
              }
            })}>{ask === 'page' ? 'Make the page' : ask === 'macro' ? 'Make the macro' : 'Generate'}</button>
            <button type="button" className="btn" onClick={() => setAsk(null)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---- the editor ----

function Editor({ initial, onDone, shop }: { initial: Tpl; onDone: () => void; shop: boolean }) {
  const { w } = useWorld();
  const { busy, error, run } = useAction();
  const { toast, toastNode } = useToast();
  const [t, setT] = useState<Tpl>(initial);
  const [versions, setVersions] = useState<Version[]>([]);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { setT(initial); }, [initial]);
  useEffect(() => {
    if (!initial.id) return;
    w.call<any>('GET', `/templates/${initial.id}`).then((r) => setVersions(r.versions ?? [])).catch(() => {});
  }, [w, initial.id, initial.version]);
  const sp = (patch: any) => setT((x) => ({ ...x, spec: { ...x.spec, ...patch } }));
  const save = () => run(async () => {
    const body = { kind: t.kind, name: t.name, description: t.description, triggers: t.triggers, enabled: t.enabled, spec: t.spec };
    const saved = t.id ? await w.call<Tpl>('PUT', `/templates/${t.id}`, body) : await w.call<Tpl>('POST', '/templates', body);
    toast(`Saved “${saved.name}” (version ${saved.version}).`);
    onDone();
  });
  return (
    <div className="card stack tpl-editor" data-testid="tpl-editor">
      {toastNode}
      <div className="row between"><h2>{t.id ? `Edit: ${t.name}` : `New ${KIND_LABEL[t.kind].toLowerCase()}`}</h2><span className="chip">{KIND_LABEL[t.kind]}{t.version ? ` · v${t.version}` : ''}</span></div>
      <ErrorBox error={error} />
      <TemplateFields t={t} setT={setT} sp={sp} />
      <label className="row tight"><input type="checkbox" checked={t.enabled} onChange={(e) => setT({ ...t, enabled: e.target.checked })} /> On (the assistant uses it)</label>
      {t.kind === 'shop' && !shop && <p className="tiny muted">The shop generator is not installed yet; this guide is kept for when it is, and the assistant reads it for shop requests.</p>}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !t.name.trim()} onClick={() => void save()} data-testid="tpl-save">Save</button>
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <span className="grow" />
        {t.id && !confirmDel && <button type="button" className="btn small ghost" onClick={() => setConfirmDel(true)}>Delete…</button>}
        {t.id && confirmDel && <><span className="tiny">Delete “{t.name}” and its versions?</span><button type="button" className="btn small danger" disabled={busy} onClick={() => void run(async () => { await w.call('DELETE', `/templates/${t.id}`); onDone(); })}>Delete</button><button type="button" className="btn small" onClick={() => setConfirmDel(false)}>Keep</button></>}
      </div>
      {versions.length > 1 && (
        <details className="tiny">
          <summary>Earlier versions ({versions.length - 1})</summary>
          <ul className="tpl-versions">
            {versions.filter((v) => v.version !== t.version).map((v) => (
              <li key={v.version} className="row">
                <span>Version {v.version} · {new Date(v.savedAt).toLocaleString()}</span>
                <button type="button" className="btn small" disabled={busy} onClick={() => void run(async () => { const r = await w.call<Tpl>('POST', `/templates/${t.id}/restore`, { version: v.version }); setT(r); toast(`Restored version ${v.version} as version ${r.version}.`); })}>Restore</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TemplateFields({ t, setT, sp }: { t: Tpl; setT: (t: Tpl) => void; sp: (patch: any) => void }) {
  const s = t.spec ?? {};
  const usesTriggers = t.kind === 'guide' || t.kind === 'generator' || t.kind === 'library' || t.kind === 'shop';
  return (
    <div className="stack">
      <div className="tpl-grid">
        <Field label="Name"><input value={t.name} maxLength={80} onChange={(e) => setT({ ...t, name: e.target.value })} data-testid="tpl-name" /></Field>
        {usesTriggers && <Field label="Used for (trigger words)" help="A request to make something with one of these words uses it; “use guide Name” always does."><input value={t.triggers.join(', ')} onChange={(e) => setT({ ...t, triggers: lines(e.target.value) })} data-testid="tpl-triggers" /></Field>}
      </div>
      <Field label="What it is for"><input value={t.description} maxLength={500} onChange={(e) => setT({ ...t, description: e.target.value })} /></Field>
      {t.kind === 'guide' && <>
        <div className="tpl-grid">
          <Field label="Task"><input value={s.task ?? ''} onChange={(e) => sp({ task: e.target.value })} placeholder="Make a town" /></Field>
          <Field label="Save new pages in"><input value={s.folder ?? ''} onChange={(e) => sp({ folder: e.target.value })} placeholder="Places/Towns" /></Field>
        </div>
        <Field label="Instructions"><textarea rows={3} value={s.instructions ?? ''} onChange={(e) => sp({ instructions: e.target.value })} /></Field>
        <StepsEditor steps={s.steps ?? []} onChange={(steps) => sp({ steps })} />
        <Field label="Sections, in order" help="One per line."><textarea rows={4} value={(s.sections ?? []).join('\n')} onChange={(e) => sp({ sections: lines(e.target.value) })} data-testid="tpl-sections" /></Field>
        <Field label="Tone"><input value={s.tone ?? ''} onChange={(e) => sp({ tone: e.target.value })} /></Field>
        <ExemplarPicker ids={s.exemplars ?? []} onChange={(exemplars) => sp({ exemplars })} />
      </>}
      {t.kind === 'generator' && <>
        <div className="tpl-grid">
          <Field label="Generator"><input value={s.generator ?? ''} onChange={(e) => sp({ generator: e.target.value })} placeholder="town, npc, tavern, shop…" /></Field>
          <Field label="Save in"><input value={s.folder ?? ''} onChange={(e) => sp({ folder: e.target.value })} /></Field>
        </div>
        <Field label="Fields" help="One per line: name: hint"><textarea rows={4} value={(s.fields ?? []).map((f: any) => (f.hint ? `${f.name}: ${f.hint}` : f.name)).join('\n')} onChange={(e) => sp({ fields: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return i > 0 ? { name: l.slice(0, i).trim(), hint: l.slice(i + 1).trim() } : { name: l, hint: '' }; }) })} /></Field>
        <Field label="Sections" help="One per line."><textarea rows={3} value={(s.sections ?? []).join('\n')} onChange={(e) => sp({ sections: lines(e.target.value) })} /></Field>
        <Field label="Instructions"><textarea rows={3} value={s.instructions ?? ''} onChange={(e) => sp({ instructions: e.target.value })} /></Field>
      </>}
      {t.kind === 'macro' && <>
        <Field label="What the assistant does" help="Use {{name}} for a blank filled in when the macro runs."><textarea rows={4} value={s.prompt ?? ''} onChange={(e) => sp({ prompt: e.target.value })} /></Field>
        <Field label="Blanks" help="One per line: name: label"><textarea rows={3} value={(s.params ?? []).map((p: any) => `${p.name}: ${p.label ?? ''}`).join('\n')} onChange={(e) => sp({ params: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(':'); return { name: (i > 0 ? l.slice(0, i) : l).trim().replace(/[^A-Za-z0-9_]/g, '_'), label: i > 0 ? l.slice(i + 1).trim() : '', default: '' }; }) })} /></Field>
        <div className="tpl-grid">
          <Field label="Mode"><select value={s.mode ?? 'propose'} onChange={(e) => sp({ mode: e.target.value })}><option value="propose">Propose (I approve each change)</option><option value="do">Do it at once</option></select></Field>
          <Field label="Tools it may use" help="Comma-separated; blank for the usual table tools."><input value={s.tools ?? ''} onChange={(e) => sp({ tools: e.target.value })} /></Field>
        </div>
      </>}
      {t.kind === 'assist' && <>
        <div className="tpl-grid">
          <Field label="Layout"><select value={s.layout ?? 'cols'} onChange={(e) => sp({ layout: e.target.value })}><option value="one">Single</option><option value="cols">Side by side</option><option value="rows">Stacked</option><option value="grid">2 × 2</option><option value="side">Main + side</option></select></Field>
          <Field label="Panes (up to 4)">
            <select multiple value={s.panes ?? []} onChange={(e) => sp({ panes: [...e.target.selectedOptions].map((o) => o.value).slice(0, 4) })} size={5}>{PANES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          </Field>
        </div>
        <Field label="Request for the assistant"><textarea rows={3} value={s.prompt ?? ''} onChange={(e) => sp({ prompt: e.target.value })} /></Field>
      </>}
      {t.kind === 'shop' && <>
        <Field label="Shop type"><input value={s.shopType ?? ''} onChange={(e) => sp({ shopType: e.target.value })} placeholder="apothecary" /></Field>
        <Field label="Guide for the shop generator"><textarea rows={4} value={s.guide ?? ''} onChange={(e) => sp({ guide: e.target.value })} /></Field>
        <Field label="Typical stock" help="One per line."><textarea rows={3} value={(s.stock ?? []).join('\n')} onChange={(e) => sp({ stock: lines(e.target.value) })} /></Field>
        <Field label="Prices"><input value={s.priceNotes ?? ''} onChange={(e) => sp({ priceNotes: e.target.value })} /></Field>
      </>}
      {t.kind === 'library' && <>
        <div className="tpl-grid">
          <Field label="Folder"><input value={s.folder ?? ''} onChange={(e) => sp({ folder: e.target.value })} /></Field>
          <Field label="Title" help="{name} is the name you give."><input value={s.titlePattern ?? ''} onChange={(e) => sp({ titlePattern: e.target.value })} placeholder="{name}" /></Field>
        </div>
        <Field label="Tags"><input value={(s.tags ?? []).join(', ')} onChange={(e) => sp({ tags: lines(e.target.value) })} /></Field>
        <Field label="Sections" help="One per line."><textarea rows={3} value={(s.sections ?? []).join('\n')} onChange={(e) => sp({ sections: lines(e.target.value) })} /></Field>
        <Field label="Page skeleton (Markdown)" help="DM-only parts go in a > [!secret] block."><textarea rows={8} className="mono" value={s.body ?? ''} onChange={(e) => sp({ body: e.target.value })} /></Field>
      </>}
    </div>
  );
}

function StepsEditor({ steps, onChange }: { steps: Step[]; onChange: (s: Step[]) => void }) {
  const set = (i: number, patch: Partial<Step>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="tpl-steps">
      <legend className="label">Steps the assistant takes first</legend>
      <ol className="stack tight" data-testid="tpl-steps">
        {steps.map((s, i) => (
          <li key={i} className="tpl-step">
            <select value={s.kind} aria-label={`Step ${i + 1} kind`} onChange={(e) => set(i, { kind: e.target.value })}>{STEP_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input value={s.text} aria-label={`Step ${i + 1}`} onChange={(e) => set(i, { text: e.target.value })} />
            {s.kind === 'web' && <input value={s.query ?? ''} aria-label={`Step ${i + 1} search words`} placeholder="{reference} Japan town history" title="Only these words go out. {reference} is the real place the request names (“based on …”)." onChange={(e) => set(i, { query: e.target.value })} />}
            <span className="row tight">
              <button type="button" className="btn small ghost" aria-label={`Move step ${i + 1} up`} disabled={!i} onClick={() => { const n = [...steps]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n); }}>↑</button>
              <button type="button" className="btn small ghost" aria-label={`Remove step ${i + 1}`} onClick={() => onChange(steps.filter((_, j) => j !== i))}>✕</button>
            </span>
          </li>
        ))}
      </ol>
      <button type="button" className="btn small" onClick={() => onChange([...steps, { kind: 'library', text: '' }])}>Add a step</button>
    </fieldset>
  );
}

function usePages() {
  const { w } = useWorld();
  return useLoad<PageLite[]>(() => w.call<PageLite[]>('GET', '/library/pages'), [w], ['page']);
}

function ExemplarPicker({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const pages = usePages();
  const [q, setQ] = useState('');
  const byId = useMemo(() => new Map((pages.data ?? []).map((p) => [p.id, p])), [pages.data]);
  const found = q.trim().length >= 2 ? (pages.data ?? []).filter((p) => !ids.includes(p.id) && `${p.title} ${p.path}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  return (
    <div className="stack tight">
      <span className="label">Example pages to follow</span>
      <div className="row">{ids.map((id) => <span key={id} className="chip">{byId.get(id)?.title ?? id}<button type="button" className="btn small ghost" aria-label={`Remove ${byId.get(id)?.title ?? id}`} onClick={() => onChange(ids.filter((x) => x !== id))}>✕</button></span>)}{!ids.length && <span className="tiny muted">None: the assistant reads pages in the guide’s folder or with its trigger words as tags.</span>}</div>
      {ids.length < 6 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page to add…" aria-label="Find an example page" />}
      {found.length > 0 && <ul className="tpl-found">{found.map((p) => <li key={p.id}><button type="button" className="btn small ghost" onClick={() => { onChange([...ids, p.id]); setQ(''); }}>+ {p.title} <span className="tiny muted">{p.path}</span></button></li>)}</ul>}
    </div>
  );
}

// ---- made with the assistant ----

interface Draft { template: Tpl; questions: string[]; notes: string[]; usedModel: boolean; skipped?: string[] }

function MakeWithAssistant({ model, onSaved }: { model: boolean; onSaved: () => void }) {
  const { w } = useWorld();
  const { busy, error, run } = useAction();
  const [kind, setKind] = useState<Kind>('guide');
  const [desc, setDesc] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const ask = (withAnswers: boolean) => run(async () => {
    const r = await w.call<Draft>('POST', '/templates/draft', { kind, description: desc, answers: withAnswers ? Object.entries(answers).map(([q, a]) => ({ q, a })) : [], current: withAnswers ? draft?.template : undefined });
    setDraft(r);
    if (!withAnswers) setAnswers({});
  });
  return (
    <div className="stack">
      <div className="card stack">
        <Field label="Kind">
          <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setDraft(null); }} data-testid="tpl-kind">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </Field>
        <p className="tiny muted">{KINDS.find(([k]) => k === kind)?.[2]}</p>
        <Field label="Describe what you want" help={model ? 'The assistant drafts it and asks a few questions; you edit it and save.' : 'No chat model is set: the draft comes from rules. You can still edit it and save.'}>
          <textarea rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} data-testid="tpl-describe"
            placeholder="Towns: for my world always research the real Japanese town it is based on, my own world lore and the towns around it. Always do that." />
        </Field>
        <ErrorBox error={error} />
        <div className="row"><button type="button" className="btn primary" disabled={busy || !desc.trim()} onClick={() => void ask(false)} data-testid="tpl-draft">{busy ? 'Drafting…' : draft ? 'Draft again' : 'Draft it'}</button></div>
      </div>
      {draft && draft.questions.length > 0 && (
        <div className="card stack" data-testid="tpl-questions">
          <strong><i className="fa-solid fa-comments" aria-hidden="true" /> The assistant asks</strong>
          {draft.questions.map((q) => <Field key={q} label={q}><input value={answers[q] ?? ''} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} /></Field>)}
          <div className="row"><button type="button" className="btn" disabled={busy || !Object.values(answers).some((a) => a.trim())} onClick={() => void ask(true)}>Redraft with my answers</button><span className="tiny muted">Or skip them: edit the draft below and save.</span></div>
        </div>
      )}
      {draft && <Editor initial={draft.template} shop={false} onDone={onSaved} />}
    </div>
  );
}

function FromExamples({ onSaved }: { onSaved: () => void }) {
  const { w } = useWorld();
  const pages = usePages();
  const { busy, error, run } = useAction();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const shown = (pages.data ?? []).filter((p) => !p.path.startsWith('Minerva/') && (!q.trim() || `${p.title} ${p.path} ${(p.tags ?? []).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 60);
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : x.length >= 8 ? x : [...x, id]));
  return (
    <div className="stack">
      <div className="card stack">
        <p className="tiny muted">Pick two or three pages made the way you like (three towns, say). The assistant reads them (never classified text) and turns what they share into a guide: sections in order, folder, tags, tone and habits.</p>
        <div className="tpl-grid">
          <Field label="Find pages"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="town, Places/…" data-testid="tpl-ex-search" /></Field>
          <Field label="Guide name (optional)"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Towns" /></Field>
        </div>
        {pages.data ? (
          <ul className="tpl-pages" aria-label="Library pages">
            {shown.map((p) => <li key={p.id}><label className="row tight"><input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} /> {p.title} <span className="tiny muted">{p.path}</span></label></li>)}
            {!shown.length && <li className="tiny muted">No pages match.</li>}
          </ul>
        ) : <Loading what="pages" />}
        <ErrorBox error={error} />
        <div className="row">
          <button type="button" className="btn primary" disabled={busy || !picked.length} onClick={() => void run(async () => setDraft(await w.call<Draft>('POST', '/templates/derive', { pageIds: picked, name })))} data-testid="tpl-derive">{busy ? 'Reading…' : `Make a guide from ${picked.length || 'these'} page${picked.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
      {draft && <div className="card stack tight">{draft.notes.map((n, i) => <span key={i} className="tiny">{n}</span>)}</div>}
      {draft && <Editor initial={draft.template} shop={false} onDone={onSaved} />}
    </div>
  );
}

// ---- web research ----

function WebSettings({ data, reload }: { data: { config: WebCfg; providers: { id: string; name: string }[] }; reload: () => Promise<void> | void }) {
  const { w } = useWorld();
  const { busy, error, run } = useAction();
  const { toast, toastNode } = useToast();
  const [c, setC] = useState<WebCfg>(data.config);
  const [allow, setAllow] = useState(data.config.allowTerms.join(', '));
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ ok: boolean; reason?: string; results?: { title: string; url: string; snippet: string }[] } | null>(null);
  useEffect(() => { setC(data.config); setAllow(data.config.allowTerms.join(', ')); }, [data.config]);
  const save = () => run(async () => { await w.call('PUT', '/templates/web', { ...c, allowTerms: lines(allow) }); await reload(); toast('Saved.'); });
  return (
    <div className="card stack" data-testid="tpl-web">
      {toastNode}
      <label className="row tight"><input type="checkbox" checked={c.enabled} onChange={(e) => setC({ ...c, enabled: e.target.checked })} data-testid="tpl-web-on" /> <strong>Let the assistant search the web</strong></label>
      <p className="tiny muted">Off by default. Only the search words leave Alexandria, never your pages. A search that holds a DM-only name of this world is refused before anything is sent, and classified words can never be searched. Without Auto each search is a card you approve, with the words on it. Results only feed a draft; nothing is published without you.</p>
      <div className="tpl-grid">
        <Field label="Search with">
          <select value={c.provider} onChange={(e) => setC({ ...c, provider: e.target.value as WebCfg['provider'] })} data-testid="tpl-web-provider"><option value="openrouter">OpenRouter web search</option><option value="searxng">A SearXNG instance</option></select>
        </Field>
        {c.provider === 'searxng'
          ? <Field label="SearXNG address" help="Its JSON output must be on (search.formats: json)."><input value={c.searxUrl} onChange={(e) => setC({ ...c, searxUrl: e.target.value })} placeholder="http://searxng:8080" data-testid="tpl-web-searx" /></Field>
          : <>
            <Field label="OpenRouter provider" help="Added by the admin in Admin → Models.">
              <select value={c.providerId} onChange={(e) => setC({ ...c, providerId: e.target.value })}><option value="">The first OpenRouter provider</option>{data.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </Field>
            <Field label="Model" help="Blank: the chat job’s model, when it is on OpenRouter."><input value={c.model} onChange={(e) => setC({ ...c, model: e.target.value })} /></Field>
          </>}
      </div>
      {c.provider === 'openrouter' && !data.providers.length && <p className="tiny muted">No OpenRouter provider is set up on this server.</p>}
      <Field label="DM-only words you allow in searches" help="Comma-separated. Classified words are never allowed."><input value={allow} onChange={(e) => setAllow(e.target.value)} /></Field>
      <ErrorBox error={error} />
      <div className="row"><button type="button" className="btn primary" disabled={busy} onClick={() => void save()} data-testid="tpl-web-save">Save</button></div>
      <hr />
      <Field label="Try a search" help="Checked first; with web research on it runs."><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tomonoura Japan history" /></Field>
      <div className="row">
        <button type="button" className="btn small" disabled={busy || !q.trim()} onClick={() => void run(async () => setRes(await w.call<any>('POST', '/templates/web/check', { queries: [q] })))}>Check the words</button>
        <button type="button" className="btn small" disabled={busy || !q.trim() || !data.config.enabled} onClick={() => void run(async () => { const r = await w.call<any>('POST', '/templates/web/search', { queries: [q] }); setRes({ ok: true, results: r.results }); })}>Search</button>
      </div>
      {res && (res.ok ? (res.results ? <ul className="tpl-results">{res.results.map((r, i) => <li key={i}>{r.url ? <a href={r.url} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}<div className="tiny muted">{r.snippet}</div></li>)}{!res.results.length && <li className="tiny muted">Nothing found.</li>}</ul> : <p className="tiny">These words may go out.</p>) : <p className="tiny" role="alert">{res.reason}</p>)}
    </div>
  );
}
