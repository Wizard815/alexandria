// GM page: the item database shops stock from. It starts with the generic
// items of the SRD (CC-BY-4.0, credited on every row), and grows with the
// GM's own items and imports (a game module, JSON or CSV; duplicates by name
// are skipped). Search, filter, edit, duplicate, export. Players never see it.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { coins, parseCoins } from '../../lib/format.ts';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { rarityLabel, type Item, type ShopConfig } from './types.ts';
import './shop.css';

interface ListData { total: number; all: number; items: Item[]; sources: { id: string; label: string; n: number }[]; tags: string[] }
const PAGE = 100;

export default function ItemsDM() {
  const { w, info } = useWorld();
  const cfg = useLoad<ShopConfig>(() => w.call('GET', '/shop/config'), [w], []);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 200); return () => clearTimeout(t); }, [q]);
  const [type, setType] = useState('');
  const [rarity, setRarity] = useState('');
  const [source, setSource] = useState('');
  const [offset, setOffset] = useState(0);
  const qs = new URLSearchParams({ q: dq, type, rarity, source, limit: String(PAGE), offset: String(offset) }).toString();
  const list = useLoad<ListData>(() => w.call('GET', `/shop/items?${qs}`), [w, qs], ['shop-items']);
  const [edit, setEdit] = useState<Item | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const { toast, toastNode } = useToast();
  const act = useAction();
  useEffect(() => setOffset(0), [dq, type, rarity, source]);

  const download = (fmt: 'json' | 'csv') => act.run(async () => {
    const r = await fetch(w.client.baseUrl + w.path(`/shop/items/export?format=${fmt}`), { headers: w.client.token ? { Authorization: `Bearer ${w.client.token}` } : {} });
    if (!r.ok) throw new Error(`Export failed (${r.status})`);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${info.slug}-items.${fmt}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  const d = list.data;
  const money = (cp: number | null) => (cp === null ? '—' : coins(cp, info.settings.coins));
  const attributions = [...new Map((d?.items ?? []).filter((i) => i.attribution).map((i) => [i.sourceLabel, i.attribution])).entries()];
  return (
    <div className="page shop-page">
      <PageHead title="Items" lead={<>The item database your <Link to="../shops">shops</Link> stock from: the SRD's generic items, your own, and anything you import.</>} />
      <section className="card stack">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input type="search" placeholder="Search items…" aria-label="Search items" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '2 1 200px' }} />
          <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}><option value="">Any type</option>{(cfg.data?.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <select aria-label="Rarity" value={rarity} onChange={(e) => setRarity(e.target.value)}><option value="">Any rarity</option>{(cfg.data?.rarities ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Any source</option>{(d?.sources ?? []).map((s) => <option key={s.id} value={s.id}>{s.label} ({s.n})</option>)}</select>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" onClick={() => setEdit('new')}>New item</button>
          <button type="button" className="btn" onClick={() => setImporting(true)}>Import…</button>
          <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void download('json')}>Export JSON</button>
          <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void download('csv')}>Export CSV</button>
        </div>
        <ErrorBox error={act.error ?? list.error} />
      </section>
      <section className="card stack">
        {!d ? <Loading /> : !d.items.length ? <Empty>No item matches.</Empty> : (
          <>
            <span className="small muted">{d.total} of {d.all} items</span>
            <div className="shop-scroll">
              <table className="shop-table">
                <thead><tr><th>Name</th><th>Type</th><th className="wide">Rarity</th><th>Cost</th><th className="wide">Weight</th><th className="wide">Source</th></tr></thead>
                <tbody>
                  {d.items.map((it) => (
                    <tr key={it.id} className="item-row" data-testid="item-row" tabIndex={0} onClick={() => setEdit(it)} onKeyDown={(e) => { if (e.key === 'Enter') setEdit(it); }}>
                      <td><strong>{it.name}</strong>{it.attunement && <span className="tiny muted"> · attunement</span>}{it.dmNotes && <span className="tiny" style={{ color: 'var(--danger-text)' }}> · note</span>}</td>
                      <td className="small">{it.type}</td>
                      <td className="wide small">{rarityLabel(it.rarity) || 'mundane'}</td>
                      <td className="small">{money(it.costCp)}</td>
                      <td className="wide small">{it.weight === null ? '' : `${it.weight} lb.`}</td>
                      <td className="wide tiny muted">{it.sourceLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button type="button" className="btn small" disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
            </div>
          </>
        )}
      </section>
      {!!attributions.length && <section className="card stack tight"><h2>Credits</h2>{attributions.map(([label, text]) => <p key={label} className="tiny muted" style={{ margin: 0 }}><strong>{label}:</strong> {text}</p>)}</section>}
      {edit && <ItemModal item={edit === 'new' ? null : edit} cfg={cfg.data} onClose={() => setEdit(null)} onDone={(m) => { setEdit(null); toast(m); void list.reload(); }} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={(m) => { setImporting(false); toast(m); void list.reload(); }} />}
      {toastNode}
    </div>
  );
}

function ItemModal({ item, cfg, onClose, onDone }: { item: Item | null; cfg: ShopConfig | null; onClose: () => void; onDone: (m: string) => void }) {
  const { w } = useWorld();
  const [f, setF] = useState(() => ({
    name: item?.name ?? '', type: item?.type ?? 'gear', category: item?.category ?? '', rarity: item?.rarity ?? 'mundane', cost: item?.costCp !== null && item?.costCp !== undefined ? coins(item.costCp, 'gsc') : '',
    weight: item?.weight !== null && item?.weight !== undefined ? String(item.weight) : '', attunement: item?.attunement ?? false, description: item?.description ?? '', properties: item?.properties ?? '',
    tags: (item?.tags ?? []).join(', '), dmNotes: item?.dmNotes ?? '',
  }));
  const act = useAction();
  const body = () => {
    const cp = f.cost.trim() ? parseCoins(f.cost) : null;
    if (f.cost.trim() && cp === null) throw new Error('Cost must be a price like 15 gp or 2 sp');
    return { name: f.name, type: f.type, category: f.category, rarity: f.rarity, costCp: cp, weight: f.weight.trim() === '' ? null : Number(f.weight), attunement: f.attunement, description: f.description, properties: f.properties, tags: f.tags, dmNotes: f.dmNotes };
  };
  const save = () => act.run(async () => {
    if (item) await w.call('PATCH', `/shop/items/${item.id}`, body());
    else await w.call('POST', '/shop/items', body());
    onDone(item ? 'Saved' : 'Added to the item database');
  });
  return (
    <Modal title={item ? item.name : 'New item'} onClose={onClose}>
      <div className="stack">
        <div className="shop-grid">
          <Field label="Name"><input value={f.name} maxLength={120} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{(cfg?.types ?? [f.type]).map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          <Field label="Rarity"><select value={f.rarity} onChange={(e) => setF({ ...f, rarity: e.target.value })}>{(cfg?.rarities ?? [f.rarity]).map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          <Field label="Cost"><input value={f.cost} placeholder="15 gp" onChange={(e) => setF({ ...f, cost: e.target.value })} /></Field>
          <Field label="Weight (lb.)"><input type="number" min={0} step="any" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></Field>
          <Field label="Category"><input value={f.category} maxLength={80} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field>
        </div>
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={f.attunement} onChange={(e) => setF({ ...f, attunement: e.target.checked })} /> Requires attunement</label>
        <Field label="Properties"><input value={f.properties} maxLength={1000} placeholder="Damage: 1d8 slashing; Versatile" onChange={(e) => setF({ ...f, properties: e.target.value })} /></Field>
        <Field label="Description"><textarea rows={4} maxLength={8000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Tags" help="Separated by commas"><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <Field label="GM notes (never shown to players)"><textarea rows={2} maxLength={4000} value={f.dmNotes} onChange={(e) => setF({ ...f, dmNotes: e.target.value })} /></Field>
        {item && <span className="tiny faint">Source: {item.sourceLabel}{item.attribution ? `. ${item.attribution}` : ''}</span>}
        <ErrorBox error={act.error} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {item && <button type="button" className="btn ghost" disabled={act.busy} onClick={() => void act.run(async () => { if (!confirm(`Delete ${item.name}? Shops that stock it lose the line.`)) return; await w.call('DELETE', `/shop/items/${item.id}`); onDone('Deleted'); })}>Delete</button>}
          {item && <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/shop/items/${item.id}/duplicate`, {}); onDone('Duplicated as a custom item'); })}>Duplicate</button>}
          <button type="button" className="btn primary" disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

interface ImportResult { added: number; updated: number; skipped: number; errors: string[]; total: number; sample: string[]; duplicates: string[]; preview: boolean }

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const { w } = useWorld();
  const src = useLoad<{ modules: { id: string; name: string; builtin: boolean; license: string; attribution: string; items: number }[] }>(() => w.call('GET', '/shop/sources'), [w], []);
  const [kind, setKind] = useState<'module' | 'json' | 'csv'>('module');
  const [module, setModule] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [label, setLabel] = useState('');
  const [attribution, setAttribution] = useState('');
  const [update, setUpdate] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);
  const act = useAction();
  const body = (preview: boolean) => ({
    type: kind, preview, onDuplicate: update ? 'update' : 'skip',
    ...(kind === 'module' ? { module: module || src.data?.modules[0]?.id } : kind === 'json' ? { json: text } : { csv: text }),
    ...(kind !== 'module' ? { sourceLabel: label || undefined, source: label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) : undefined, attribution: attribution || undefined } : {}),
  });
  const go = (preview: boolean) => act.run(async () => {
    const r = await w.call<ImportResult>('POST', '/shop/items/import', body(preview));
    if (preview) setRes(r); else onDone(`Imported ${r.added} new, ${r.updated} updated, ${r.skipped} skipped`);
  });
  const read = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
    setKind(/\.csv$/i.test(file.name) ? 'csv' : 'json');
    setRes(null);
  };
  const mod = src.data?.modules.find((m) => m.id === (module || src.data?.modules[0]?.id));
  return (
    <Modal title="Import items" onClose={onClose}>
      <div className="stack">
        <Field label="From">
          <select value={kind} onChange={(e) => { setKind(e.target.value as any); setRes(null); }}><option value="module">A game module</option><option value="json">A JSON file</option><option value="csv">A CSV file</option></select>
        </Field>
        {kind === 'module' ? (
          !src.data ? <Loading /> : (
            <>
              <Field label="Module"><select value={module || src.data.modules[0]?.id || ''} onChange={(e) => { setModule(e.target.value); setRes(null); }}>{src.data.modules.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.items} items)</option>)}</select></Field>
              {mod && <span className="tiny faint">{mod.license}{mod.attribution ? `: ${mod.attribution}` : ''}</span>}
            </>
          )
        ) : (
          <>
            <Field label="File" help={kind === 'csv' ? 'A header row with at least name; also type, rarity, cost, weight, attunement, description, properties, tags, dm_notes.' : 'A list of items, or { "items": [...] }, with name, type, rarity, cost ("15 gp"), weight, description, properties, attunement, tags, dm_notes.'}>
              <input type="file" accept={kind === 'csv' ? '.csv,text/csv' : '.json,application/json'} onChange={(e) => void read(e.target.files?.[0])} />
            </Field>
            {fileName && <span className="tiny muted">{fileName}: {text.length.toLocaleString()} characters</span>}
            <div className="shop-grid">
              <Field label="Source name"><input value={label} maxLength={80} placeholder="My homebrew" onChange={(e) => setLabel(e.target.value)} /></Field>
              <Field label="Credit line (if the licence asks for one)"><input value={attribution} maxLength={1000} onChange={(e) => setAttribution(e.target.value)} /></Field>
            </div>
          </>
        )}
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={update} onChange={(e) => { setUpdate(e.target.checked); setRes(null); }} /> Refresh items already imported from the same source (otherwise duplicates are skipped)</label>
        {res && (
          <div className="stack tight" style={{ padding: 10, background: 'var(--panel-2)', borderRadius: 8 }} data-testid="import-preview">
            <span className="small">{res.added} new, {res.updated} to refresh, {res.skipped} skipped as duplicates{res.errors.length ? `, ${res.errors.length} with problems` : ''}.</span>
            {!!res.sample.length && <span className="tiny muted">New: {res.sample.join(', ')}{res.added > res.sample.length ? '…' : ''}</span>}
            {!!res.duplicates.length && <span className="tiny muted">Already there: {res.duplicates.slice(0, 8).join(', ')}{res.duplicates.length > 8 ? '…' : ''}</span>}
            {res.errors.slice(0, 5).map((e) => <span key={e} className="tiny" style={{ color: 'var(--danger-text)' }}>{e}</span>)}
          </div>
        )}
        <ErrorBox error={act.error} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" disabled={act.busy || (kind !== 'module' && !text)} onClick={() => void go(true)}>Preview</button>
          <button type="button" className="btn primary" disabled={act.busy || !res} onClick={() => void go(false)}>Import</button>
        </div>
      </div>
    </Modal>
  );
}
