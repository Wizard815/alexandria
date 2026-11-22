// DM page: the template library (categories, search, favourites, recently used,
// import and export), and a template at work. Other screens link here with
// ?tpl=<key> and optional ?page=<page id> or ?name=<text> to pre-fill it.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead, ErrorBox, Empty, Loading, Field, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import TemplateEditor from './TemplateEditor.tsx';
import Workshop from './Workshop.tsx';
import { CATEGORIES, type Tpl, type Values } from './types.ts';
import './sculpt.css';

type View = 'all' | 'favorites' | 'recent' | (typeof CATEGORIES)[number];
interface Preview { ok: boolean; nameTaken: boolean; preview: { name: string; category: string; perspective: string; fields: { key: string; label: string; type: string }[]; generators: string[]; outputs: string[]; bodyPreview: string } }

export default function SculptPage() {
  const { w } = useWorld();
  const [params, setParams] = useSearchParams();
  const list = useLoad<{ templates: Tpl[] }>(() => w.call('GET', '/sculpt/templates'), [w]);
  const [editing, setEditing] = useState<Tpl | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const act = useAction();
  const { toast, toastNode } = useToast();
  const want = params.get('tpl');
  const tpl = list.data?.templates.find((t) => t.id === want || t.key === want) ?? null;
  const open = (id: string | null) => { const p = new URLSearchParams(); if (id) p.set('tpl', id); setParams(p); };

  const initial = useMemo<Values | undefined>(() => {
    const v: Values = {};
    for (const [k, val] of params.entries()) if (!['tpl', 'page', 'location', 'level'].includes(k) && val) v[k] = val;
    return Object.keys(v).length ? v : undefined;
  }, [params]);
  const context = useMemo(() => ({ ...(params.get('page') ? { page: params.get('page')! } : {}), ...(params.get('location') ? { location: params.get('location')! } : {}), ...(Number(params.get('level')) ? { partyLevel: Number(params.get('level')) } : {}) }), [params]);

  const shown = useMemo(() => {
    const all = list.data?.templates ?? [];
    const s = q.trim().toLowerCase();
    let r = all.filter((t) => !s || `${t.name} ${t.description} ${t.category} ${t.fields.map((f) => f.label).join(' ')}`.toLowerCase().includes(s));
    if (view === 'favorites') r = r.filter((t) => t.favorite);
    else if (view === 'recent') r = r.filter((t) => t.lastUsedAt).sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt))).slice(0, 8);
    else if (view !== 'all') r = r.filter((t) => t.category === view);
    return r;
  }, [list.data, q, view]);

  const star = (t: Tpl) => act.run(async () => { await w.call('POST', `/sculpt/templates/${t.id}/favorite`, { on: !t.favorite }); await list.reload(); });
  const duplicate = (t: Tpl) => act.run(async () => { const r = await w.call<Tpl>('POST', `/sculpt/templates/${t.id}/duplicate`); await list.reload(); toast(`Made “${r.name}”`); open(r.id); });
  const exportT = (t: Tpl) => act.run(async () => {
    const j = await w.call<unknown>('GET', `/sculpt/templates/${t.id}/export`);
    const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${t.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.sculpt.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  if (editing) return <TemplateEditor initial={editing === 'new' ? null : editing} onDone={(id) => { setEditing(null); if (id) open(id); void list.reload(); }} />;
  return (
    <div className="page wide">
      <PageHead title="Sculpting" lead="Fill in a few blanks; the rest is made to fit your world.">
        {tpl ? <button type="button" className="btn small ghost" onClick={() => open(null)}>All templates</button> : (
          <>
            <button type="button" className="btn small ghost" onClick={() => setImporting(!importing)} aria-expanded={importing}>Import</button>
            <button type="button" className="btn small" onClick={() => setEditing('new')}>New template</button>
          </>
        )}
        {tpl && (
          <>
            <button type="button" className="btn small ghost" onClick={() => setEditing(tpl)}>Edit template</button>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void duplicate(tpl)}>Duplicate</button>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void exportT(tpl)}>Export</button>
          </>
        )}
      </PageHead>
      <ErrorBox error={list.error ?? act.error} />
      {!list.data ? <Loading /> : tpl ? <Workshop key={tpl.id + JSON.stringify(initial ?? {})} tpl={tpl} initial={initial} context={context} /> : (
        <>
          {importing && <ImportPanel onDone={(id) => { setImporting(false); void list.reload(); if (id) open(id); }} />}
          <div className="sculpt-lib-tools">
            <input type="search" aria-label="Search templates" placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }} role="tablist" aria-label="Template categories">
            {([['all', 'All'], ['favorites', '★ Favourites'], ['recent', 'Recent'], ...CATEGORIES.map((c) => [c, c])] as [View, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={view === k} className={`btn small ${view === k ? '' : 'ghost'}`} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>
          {!shown.length ? <Empty>{view === 'favorites' ? 'Star a template to keep it here.' : view === 'recent' ? 'Templates you use show up here.' : 'No template matches.'}</Empty> : (
            <div className="sculpt-cards">
              {shown.map((t) => (
                <div key={t.id} className="card sculpt-card">
                  <button type="button" className="btn ghost small sculpt-star" aria-pressed={!!t.favorite} aria-label={`${t.favorite ? 'Unstar' : 'Star'} ${t.name}`} onClick={() => void star(t)}>{t.favorite ? '★' : '☆'}</button>
                  <button type="button" className="btn ghost sculpt-open" onClick={() => open(t.id)}>
                    <strong style={{ paddingRight: 28 }}>{t.name}</strong>
                    <span className="small muted">{t.description}</span>
                    <span className="tiny faint">{t.category} · {t.perspective === 'player' ? 'Players’ view' : 'DM notes'}{t.builtin ? '' : ' · yours'}{t.uses ? ` · used ${t.uses}×` : ''}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {toastNode}
    </div>
  );
}

function ImportPanel({ onDone }: { onDone: (id?: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [text, setText] = useState('');
  const [prev, setPrev] = useState<Preview | null>(null);
  const body = () => { try { return JSON.parse(text); } catch { throw new Error('That is not valid JSON.'); } };
  const preview = () => act.run(async () => { setPrev(await w.call<Preview>('POST', '/sculpt/templates/import', { json: body(), preview: true })); });
  const doImport = () => act.run(async () => { const r = await w.call<Tpl>('POST', '/sculpt/templates/import', { json: body() }); onDone(r.id); });
  return (
    <div className="card sculpt-import">
      <h3 style={{ margin: 0 }}>Import a template</h3>
      <Field label="Template JSON" help="Paste an exported template, or choose a .json file."><textarea rows={6} value={text} onChange={(e) => { setText(e.target.value); setPrev(null); }} /></Field>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="btn small">Choose a file<input type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => { setText(t); setPrev(null); }); e.target.value = ''; }} /></label>
        <button type="button" className="btn small" disabled={act.busy || !text.trim()} onClick={() => void preview()}>Preview</button>
        <button type="button" className="btn small primary" disabled={act.busy || !prev} onClick={() => void doImport()}>Import</button>
      </div>
      <ErrorBox error={act.error} />
      {prev && (
        <div className="stack tight" role="status">
          <strong>{prev.preview.name}</strong>
          <span className="small muted">{prev.preview.category} · {prev.preview.perspective === 'player' ? 'players’ view' : 'DM notes'}{prev.nameTaken ? ' · the name is taken, so it will be numbered' : ''}</span>
          <span className="small">Fields: {prev.preview.fields.map((f) => `${f.label} (${f.type})`).join(', ')}</span>
          {prev.preview.generators.length > 0 && <span className="small">Generators: {prev.preview.generators.join(', ')}</span>}
          {prev.preview.outputs.length > 0 && <span className="small">Outputs: {prev.preview.outputs.join(', ')}</span>}
          <pre className="tiny" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{prev.preview.bodyPreview}</pre>
        </div>
      )}
    </div>
  );
}
