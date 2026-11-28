// Biblio's side panels: the timeline, suggestions, the GM's own templates,
// moving pages in from other sources (and Biblio out), the trash, and an
// article's history.
import { useMemo, useRef, useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, useAction } from '../../ui/index.tsx';
import { lineDiff, trimDiff } from './diff.ts';
import type { Article, FieldType, Template, TemplateField, TreeItem } from './types.ts';

const enc = encodeURIComponent;

export function Timeline({ open }: { open: (id: string) => void }) {
  const { w } = useWorld();
  const t = useLoad<any[]>(() => w.call('GET', '/biblio/timeline'), [w], ['biblio', 'page']);
  if (t.loading && !t.data) return <Loading what="the timeline" />;
  if (t.error) return <ErrorBox error={t.error} />;
  if (!t.data?.length) return <Empty>Nothing is dated yet. Events, characters and places get dates from their When, Born or Founded fields.</Empty>;
  return (
    <ol className="bib-timeline">
      {t.data.map((e, i) => (
        <li key={`${e.articleId}-${e.label}-${i}`}>
          <span className="bib-when">{e.when}</span>
          <button type="button" className="lib-link-btn" onClick={() => open(e.articleId)}>{e.title}</button>
          <span className="tiny muted"> · {e.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function Suggestions({ gm, tree, open, nameOf }: { gm: boolean; tree: TreeItem[]; open: (id: string) => void; nameOf: (id: string) => string }) {
  const { w } = useWorld();
  const s = useLoad<any[]>(() => w.call('GET', '/biblio/suggestions'), [w], ['request', 'biblio']);
  const act = useAction();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const decide = (id: string, how: 'accept' | 'reject', body?: any) => act.run(async () => { await w.call('POST', `/biblio/suggestions/${enc(id)}/${how}`, body ?? {}); await s.reload(); });
  const suggestNew = () => act.run(async () => { await w.call('POST', '/biblio/suggestions', { title, body: text }); setTitle(''); setText(''); await s.reload(); });
  const open_ = (s.data ?? []).filter((x) => x.status === 'open');
  const done = (s.data ?? []).filter((x) => x.status !== 'open');
  return (
    <div className="stack">
      {!gm && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); void suggestNew(); }}>
          <h3>Suggest a new article</h3>
          <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></Field>
          <Field label="What you know"><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} required /></Field>
          <div className="row end"><button className="btn primary small" disabled={act.busy}>Send to the GM</button></div>
        </form>
      )}
      <ErrorBox error={act.error ?? s.error} />
      {gm && !open_.length && <Empty>No suggestions waiting. Players suggest edits from an article, or new articles from here.</Empty>}
      {open_.map((x) => (
        <div key={x.id} className="card">
          <div className="row between wrap">
            <strong>{x.kind === 'edit' ? <>Edit to <button type="button" className="lib-link-btn inline" onClick={() => x.articleId && open(x.articleId)}>{x.articleTitle ?? x.title}</button></> : <>New article: {x.title}</>}</strong>
            <span className="tiny muted">{gm ? `${nameOf(x.author)} · ` : ''}{when(x.at)}</span>
          </div>
          <p style={{ whiteSpace: 'pre-wrap' }}>{x.body}</p>
          {gm ? (
            <div className="row end wrap">
              <button type="button" className="btn small" onClick={() => void decide(x.id, 'reject')} disabled={act.busy}>Turn down</button>
              {x.kind === 'edit'
                ? <button type="button" className="btn small primary" onClick={() => void decide(x.id, 'accept')} disabled={act.busy}>Add it to the article</button>
                : <button type="button" className="btn small primary" onClick={() => void decide(x.id, 'accept', { level: 'dm' })} disabled={act.busy}>Make the article (GM only)</button>}
            </div>
          ) : <span className="chip">Waiting for the GM</span>}
        </div>
      ))}
      {done.length > 0 && (
        <details><summary className="small muted">Decided ({done.length})</summary>
          <ul className="bib-plain">{done.map((x) => <li key={x.id} className="small">{x.status === 'accepted' ? '✓' : '✗'} {x.articleTitle ?? x.title}{x.reply ? ` · ${x.reply}` : ''}</li>)}</ul>
        </details>
      )}
      {!gm && tree.length === 0 && <Empty>The GM has not shared any articles yet.</Empty>}
    </div>
  );
}

const TYPES: [FieldType, string][] = [['text', 'Words'], ['long', 'Paragraph'], ['number', 'Number'], ['date', 'In-world date'], ['link', 'Link to an article'], ['links', 'Links to articles'], ['yesno', 'Yes or no']];
const RELS = ['', 'member_of', 'allies', 'enemies', 'rivals', 'parents', 'children', 'spouse', 'partner', 'siblings', 'lovers'];

export function Templates({ templates, onChanged }: { templates: Template[]; onChanged: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [edit, setEdit] = useState<Template | 'new' | null>(null);
  const del = (t: Template) => act.run(async () => { await w.call('DELETE', `/biblio/templates/${enc(t.id)}`); onChanged(); });
  if (edit) return <TemplateForm initial={edit === 'new' ? null : edit} onDone={() => { setEdit(null); onChanged(); }} onCancel={() => setEdit(null)} />;
  return (
    <div className="stack">
      <div className="row between"><p className="small muted" style={{ margin: 0 }}>A template is the kind of article and its infobox. Changing one updates every article that uses it.</p><button type="button" className="btn small primary" onClick={() => setEdit('new')}><i className="fa-solid fa-plus" aria-hidden="true" /> New template</button></div>
      <ErrorBox error={act.error} />
      <div className="list card flush">
        {templates.map((t) => (
          <div key={t.id} className="list-item">
            <i className={`fa-solid ${t.icon}`} aria-hidden="true" style={{ width: 22 }} />
            <span className="grow"><strong>{t.name}</strong> <span className="tiny muted">{t.fields.length} field{t.fields.length === 1 ? '' : 's'}{t.fields.some((f) => f.gm) ? `, ${t.fields.filter((f) => f.gm).length} GM only` : ''}</span>{t.description && <div className="tiny muted">{t.description}</div>}</span>
            {t.builtin ? <span className="chip">Built in</span> : <>
              <button type="button" className="btn small" onClick={() => setEdit(t)}>Edit</button>
              <button type="button" className="btn small" onClick={() => void del(t)} disabled={act.busy}>Delete</button>
            </>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TemplateForm({ initial, onDone, onCancel }: { initial: Template | null; onDone: () => void; onCancel: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? 'fa-file-lines');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [fields, setFields] = useState<TemplateField[]>(initial?.fields ?? [{ key: '', label: '', type: 'text' }]);
  const up = (i: number, patch: Partial<TemplateField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const save = () => act.run(async () => {
    const body = { name, icon, description, fields: fields.filter((f) => f.label.trim()).map((f) => ({ ...f, key: f.key || undefined, rel: f.rel || undefined })) };
    if (initial) await w.call('PUT', `/biblio/templates/${enc(initial.id)}`, body); else await w.call('POST', '/biblio/templates', body);
    onDone();
  });
  return (
    <form className="card gold" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3>{initial ? `Edit ${initial.name}` : 'New template'}</h3>
      <div className="grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ship" /></Field>
        <Field label="Icon" help="A Font Awesome name."><input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="fa-ship" /></Field>
      </div>
      <Field label="What it is for"><input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></Field>
      <h4>Fields</h4>
      <div className="stack tight">
        {fields.map((f, i) => (
          <div key={i} className="row wrap bib-tfield">
            <input className="input" aria-label="Field name" value={f.label} onChange={(e) => up(i, { label: e.target.value })} placeholder="Captain" />
            <select className="input" aria-label="Kind of field" value={f.type} onChange={(e) => up(i, { type: e.target.value as FieldType })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            {(f.type === 'link' || f.type === 'links') && <select className="input" aria-label="Relation" value={f.rel ?? ''} onChange={(e) => up(i, { rel: e.target.value })}>{RELS.map((r) => <option key={r} value={r}>{r ? `Relation: ${r.replace('_', ' ')}` : 'No relation'}</option>)}</select>}
            <label className="small row"><input type="checkbox" checked={!!f.gm} onChange={(e) => up(i, { gm: e.target.checked })} /> GM only</label>
            <button type="button" className="btn small" aria-label={`Remove ${f.label || 'field'}`} onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}><i className="fa-solid fa-xmark" aria-hidden="true" /></button>
          </div>
        ))}
        <div><button type="button" className="btn small" onClick={() => setFields((fs) => [...fs, { key: '', label: '', type: 'text' }])}><i className="fa-solid fa-plus" aria-hidden="true" /> Add a field</button></div>
      </div>
      <ErrorBox error={act.error} />
      <div className="row end"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={act.busy}>Save template</button></div>
    </form>
  );
}

export function MoveInOut({ onChanged, open }: { onChanged: () => void; open: (id: string) => void }) {
  const { w, info } = useWorld();
  const pages = useLoad<any[]>(() => w.pages(), [w], ['page']);
  const act = useAction();
  const [result, setResult] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const sources = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const p of pages.data ?? []) if (p.sourceId && p.sourceKind !== 'biblio') { const x = m.get(p.sourceId) ?? { id: p.sourceId, name: p.source ?? 'A source', count: 0 }; x.count++; m.set(p.sourceId, x); }
    return [...m.values()];
  }, [pages.data]);
  const candidates = (pages.data ?? []).filter((p) => p.sourceKind !== 'biblio' && (!q || String(p.title).toLowerCase().includes(q.toLowerCase()))).slice(0, 60);
  const report = (out: any) => setResult(`Copied ${out.imported.length} page${out.imported.length === 1 ? '' : 's'} into Biblio${out.skipped.length ? `; ${out.skipped.length} skipped (${[...new Set(out.skipped.map((s: any) => s.why))].join(', ')})` : ''}.`);
  const copySource = (id: string) => act.run(async () => { const out: any = await w.call('POST', '/biblio/import', { sourceId: id }); report(out); onChanged(); if (out.imported[0]) open(out.imported[0].articleId); });
  const copyPicked = () => act.run(async () => { const out: any = await w.call('POST', '/biblio/import', { pageIds: [...pick] }); report(out); setPick(new Set()); onChanged(); });
  const download = () => act.run(async () => {
    const data = await w.call('GET', '/biblio/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `biblio-${info.slug ?? 'world'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  const load = (f: File) => act.run(async () => { const out: any = await w.call('POST', '/biblio/export', JSON.parse(await f.text())); setResult(`Loaded ${out.articles} articles and ${out.templates} templates.`); onChanged(); });
  return (
    <div className="stack">
      <div className="card">
        <h3>Move a world into Biblio</h3>
        <p className="small muted">Copies pages from LegendKeeper, Kanka, World Anvil, Notion, Obsidian or any other source into Biblio, with their places in the tree, levels, tags and secrets. The originals are left alone, so you can keep both until you are ready to switch the source off.</p>
        {pages.loading && !pages.data ? <Loading what="sources" /> : !sources.length ? <p className="small muted">No other sources in this world.</p> : (
          <div className="list">{sources.map((s) => (
            <div key={s.id} className="list-item"><span className="grow">{s.name} <span className="tiny muted">{s.count} page{s.count === 1 ? '' : 's'}</span></span>
              <button type="button" className="btn small" onClick={() => void copySource(s.id)} disabled={act.busy}>Copy all into Biblio</button></div>
          ))}</div>
        )}
        <details><summary className="small muted">Or pick pages</summary>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page" aria-label="Find a page" style={{ margin: '8px 0' }} />
          <div className="bib-pick">{candidates.map((p) => (
            <label key={p.id} className="row small"><input type="checkbox" checked={pick.has(p.id)} onChange={(e) => setPick((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} /> {p.title} <span className="tiny muted">{p.source ?? 'Library'}</span></label>
          ))}</div>
          <button type="button" className="btn small primary" disabled={!pick.size || act.busy} onClick={() => void copyPicked()}>Copy {pick.size || ''} into Biblio</button>
        </details>
      </div>
      <div className="card">
        <h3>Back up or move Biblio</h3>
        <p className="small muted">One JSON file with every article and your own templates. Load it into another world (or another Alexandria) to bring them all.</p>
        <div className="row wrap">
          <button type="button" className="btn small" onClick={() => void download()} disabled={act.busy}><i className="fa-solid fa-file-export" aria-hidden="true" /> Download Biblio</button>
          <button type="button" className="btn small" onClick={() => file.current?.click()} disabled={act.busy}><i className="fa-solid fa-file-import" aria-hidden="true" /> Load a Biblio file…</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); e.target.value = ''; }} />
        </div>
      </div>
      {result && <div className="note small" role="status">{result}</div>}
      <ErrorBox error={act.error ?? pages.error} />
    </div>
  );
}

export function Trash({ onChanged }: { onChanged: () => void }) {
  const { w } = useWorld();
  const t = useLoad<any[]>(() => w.call('GET', '/biblio/trash'), [w], ['biblio']);
  const act = useAction();
  const restore = (id: string) => act.run(async () => { await w.call('POST', `/biblio/articles/${enc(id)}/restore`); await t.reload(); onChanged(); });
  const purge = (id: string, title: string) => act.run(async () => { if (!window.confirm(`Delete “${title}” and its history for good?`)) return; await w.call('DELETE', `/biblio/trash/${enc(id)}`); await t.reload(); });
  if (t.loading && !t.data) return <Loading what="the trash" />;
  if (!t.data?.length) return <Empty>The trash is empty.</Empty>;
  return (
    <div className="list card flush">
      <ErrorBox error={act.error} />
      {t.data.map((a) => (
        <div key={a.id} className="list-item">
          <span className="grow">{a.title} <span className="tiny muted">trashed {when(a.deletedAt)}</span></span>
          <button type="button" className="btn small" onClick={() => void restore(a.id)} disabled={act.busy}>Restore</button>
          <button type="button" className="btn small" onClick={() => void purge(a.id, a.title)} disabled={act.busy}>Delete for good</button>
        </div>
      ))}
    </div>
  );
}

export function History({ article, nameOf, onClose, onRestored }: { article: Article; nameOf: (id: string) => string; onClose: () => void; onRestored: () => void }) {
  const { w } = useWorld();
  const list = useLoad<any[]>(() => w.call('GET', `/biblio/articles/${enc(article.id)}/revisions`), [w, article.id, article.rev]);
  const [rev, setRev] = useState<number | null>(null);
  const old = useLoad<any>(() => (rev ? w.call('GET', `/biblio/articles/${enc(article.id)}/revisions/${rev}`) : Promise.resolve(null)), [w, article.id, rev]);
  const act = useAction();
  const restore = () => act.run(async () => { await w.call('POST', `/biblio/articles/${enc(article.id)}/revisions/${rev}/restore`); onRestored(); });
  const diff = useMemo(() => {
    if (!old.data?.article) return null;
    const o = old.data.article;
    const asText = (a: any) => [`# ${a.title}`, a.summary, ...Object.entries(a.fields ?? {}).map(([k, v]) => `${k}: ${v}`), '', a.body].join('\n');
    return trimDiff(lineDiff(asText(o), asText(article)));
  }, [old.data, article]);
  return (
    <Modal title={`History of ${article.title}`} onClose={onClose}>
      {list.loading && !list.data ? <Loading what="the history" /> : (
        <div className="bib-history">
          <ol className="bib-plain">
            {(list.data ?? []).map((r) => (
              <li key={r.rev}>
                <button type="button" className={`lib-link-btn${rev === r.rev ? ' on' : ''}`} onClick={() => setRev(r.rev)} disabled={r.rev === article.rev} aria-current={rev === r.rev || undefined}>
                  Version {r.rev}{r.rev === article.rev ? ' (now)' : ''}
                </button>
                <span className="tiny muted"> {when(r.at)} · {r.byKind === 'ai' ? 'the assistant' : r.by ? nameOf(r.by) : 'GM'}{r.note ? ` · ${r.note}` : ''}</span>
              </li>
            ))}
          </ol>
          {rev && diff && (
            <div>
              <p className="small muted">What changed from version {rev} to now (<span className="bib-del">removed</span>, <span className="bib-add">added</span>):</p>
              <pre className="bib-diff">{diff.map((l, i) => <div key={i} className={`bib-${l.kind}`}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : l.kind === 'gap' ? '… ' : '  '}{l.text}</div>)}</pre>
              <div className="row end"><button type="button" className="btn primary small" onClick={() => void restore()} disabled={act.busy}>Bring back version {rev}</button></div>
            </div>
          )}
          <ErrorBox error={act.error ?? old.error} />
        </div>
      )}
    </Modal>
  );
}
