// World settings → Game module: which modules are on and in what order,
// their credits, and Import (always a preview first).
import { useState } from 'react';
import { ErrorBox, Field, Loading, Markdown, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';

type Src = 'open5e' | 'dnd5eapi' | 'json' | 'zip' | 'folder' | 'git' | 'api';

// The kinds a free source can be narrowed to, in the order the picker shows them.
const KIND_LABELS: [string, string][] = [['spell', 'Spells'], ['monster', 'Monsters'], ['item', 'Items'], ['condition', 'Conditions'], ['other', 'Feats, backgrounds, species'], ['rule', 'Rules'], ['class', 'Classes']];

const b64 = (buf: ArrayBuffer) => {
  let s = '';
  const a = new Uint8Array(buf);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};

export default function ModuleSettings() {
  const { w, isDM } = useWorld();
  const mods = useLoad<any>(() => w.call('GET', '/modules'), [w], ['modules']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const enabled: any[] = mods.data?.modules ?? [];
  const off: any[] = (mods.data?.available ?? []).filter((m: any) => !enabled.some((e) => e.id === m.id));
  const [browse, setBrowse] = useState<string | null>(null);

  const save = (ids: string[]) => act.run(async () => { await w.call('PUT', '/modules/enabled', { ids }); await mods.reload(); toast('Saved'); });
  const move = (i: number, d: number) => {
    const ids = enabled.map((m) => m.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void save(ids);
  };

  return (
    <div className="stack">
      <ErrorBox error={mods.error ?? act.error} />
      {mods.loading && !mods.data ? <Loading /> : (
        <>
          <section className="card stack">
            <h3>On in this world</h3>
            <p className="tiny muted">The first module wins when two of them define the same term.</p>
            {enabled.length === 0 && <p className="muted">No module is on. Rules lookups and keyword highlights are off.</p>}
            {enabled.map((m, i) => (
              <div key={m.id} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <span><strong>{i + 1}. {m.name}</strong> <span className="tiny muted">{m.terms} terms{m.version ? ` · v${m.version}` : ''}{m.builtin ? '' : m.server ? ' · server library' : ' · imported'}</span></span>
                {isDM && (
                  <span className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn small" onClick={() => setBrowse(browse === m.id ? null : m.id)} aria-pressed={browse === m.id}>Browse</button>
                    {!m.builtin && <button type="button" className="btn small" disabled={act.busy} title="Its spells into the Codex and its items into the shop's item database" onClick={() => void act.run(async () => { const r = await w.call('POST', '/modules/feed', { id: m.id }); toast(`Codex: ${r.fed?.spells?.added ?? 0} spells added · Shop: ${r.fed?.items?.added ?? 0} items added`); })}>Add spells &amp; items</button>}
                    <button type="button" className="btn small" disabled={act.busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${m.name} up`}>↑</button>
                    <button type="button" className="btn small" disabled={act.busy || i === enabled.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${m.name} down`}>↓</button>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => void save(enabled.filter((x) => x.id !== m.id).map((x) => x.id))}>Turn off</button>
                  </span>
                )}
              </div>
            ))}
          </section>

          {off.length > 0 && (
            <section className="card stack">
              <h3>Available</h3>
              {off.map((m) => (
                <div key={m.id} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span><strong>{m.name}</strong> {m.edition && <span className="chip">5e {m.edition}</span>} <span className="tiny muted">{m.terms} terms{m.builtin ? '' : m.server ? ' · server library, no download' : ' · imported'}</span></span>
                  {isDM && (
                    <span className="row" style={{ gap: 6 }}>
                      <button type="button" className="btn small" onClick={() => setBrowse(browse === m.id ? null : m.id)} aria-pressed={browse === m.id}>Browse</button>
                      <button type="button" className="btn small" disabled={act.busy} onClick={() => void save([...enabled.map((x) => x.id), m.id])}>Turn on</button>
                      {!m.builtin && !m.server && <button type="button" className="btn small" disabled={act.busy} onClick={() => { if (confirm(`Delete ${m.name} from this world?`)) void act.run(async () => { await w.call('DELETE', `/modules/imported/${encodeURIComponent(m.id)}`); await mods.reload(); }); }}>Delete</button>}
                    </span>
                  )}
                </div>
              ))}
            </section>
          )}

          {isDM && browse && <ModuleBrowser key={browse} id={browse} onClose={() => setBrowse(null)} />}

          <section className="card stack">
            <h3>Credits</h3>
            {(mods.data?.available ?? []).filter((m: any) => m.attribution).map((m: any) => (
              <p key={m.id} className="tiny"><strong>{m.name}</strong> ({m.license || 'license not given'}). {m.attribution}</p>
            ))}
          </section>

          {isDM && <ImportBox onDone={() => void mods.reload()} />}
        </>
      )}
      {toastNode}
    </div>
  );
}

function ImportBox({ onDone }: { onDone: () => void }) {
  const { w, info } = useWorld();
  const act = useAction();
  // Open5e and the 5e SRD API are a house rule (World → House rules): while it is off their tabs are not offered.
  const o5 = (info.settings as any).open5e === true;
  const [pick, setSrc] = useState<Src>('open5e');
  const src: Src = o5 || (pick !== 'open5e' && pick !== 'dnd5eapi') ? pick : 'json';
  const sources = useLoad<any>(() => (src === 'open5e' || src === 'dnd5eapi' ? w.call('GET', '/modules/sources') : Promise.resolve(null)), [w, src === 'open5e' || src === 'dnd5eapi']);
  const [books, setBooks] = useState<string[]>([]);
  const [edition, setEdition] = useState('2024');
  const [kinds, setKinds] = useState<string[]>([]);
  const [feed, setFeed] = useState({ spells: true, items: true });
  const [fed, setFed] = useState<any | null>(null);
  const [req, setReq] = useState<any | null>(null);
  const [meta, setMeta] = useState({ name: '', version: '', license: '', attribution: '' });
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [api, setApi] = useState({ itemsPath: '', term: 'name', text: 'description', kind: '', summary: '', aliases: '', id: '', paging: 'none', token: '' });
  const [pre, setPre] = useState<any | null>(null);
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState(false);

  const body = (): any => {
    const module = Object.fromEntries(Object.entries(meta).filter(([, v]) => v.trim()));
    const only = kinds.length ? { kinds } : {};
    if (src === 'open5e') return { type: 'open5e', documents: books, ...only, module };
    if (src === 'dnd5eapi') return { type: 'dnd5eapi', edition, ...only, module };
    if (src === 'git') return { type: 'git', url, module };
    if (src === 'api') {
      const mapping = Object.fromEntries(['term', 'text', 'kind', 'summary', 'aliases', 'id'].map((k) => [k, (api as any)[k]]).filter(([, v]) => v));
      return { type: 'api', url, itemsPath: api.itemsPath || undefined, paging: api.paging, token: api.token || undefined, mapping, module };
    }
    return { ...req, module };
  };

  async function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    setPre(null); setDone(false);
    if (src === 'zip') {
      const f = files[0];
      setReq({ type: 'zip', zip: b64(await f.arrayBuffer()) });
      setMeta((m) => ({ ...m, name: m.name || f.name.replace(/\.zip$/i, '') }));
    } else if (src === 'folder') {
      const list = Array.from(files).filter((f) => /\.(md|markdown)$/i.test(f.name) || f.name === 'module.json');
      const out = await Promise.all(list.map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, text: await f.text() })));
      setReq({ type: 'folder', files: out });
    } else {
      setReq({ type: 'json', json: await files[0].text() });
    }
  }

  const free = src === 'open5e' || src === 'dnd5eapi';
  const ready = src === 'open5e' ? books.length > 0 : src === 'dnd5eapi' ? true : src === 'git' || src === 'api' ? !!url.trim() : src === 'json' ? !!(req || text.trim()) : !!req;
  const payload = () => (src === 'json' && !req ? { type: 'json', json: text, module: body().module } : body());
  const doPreview = () => act.run(async () => { setDone(false); setPre(await w.call('POST', '/modules/import/preview', payload())); });
  const doSave = () => act.run(async () => { const r = await w.call('POST', '/modules/import', { ...payload(), replace, ...(feed.spells || feed.items ? { feed } : {}) }); setFed(r?.fed ?? null); setDone(true); setPre(null); onDone(); });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const docs: any[] = sources.data?.open5e?.documents ?? [];
  const systems = [...new Set(docs.map((d) => d.gamesystem || 'Other'))]; // 2024 first: the server sorts them
  const kindChoices = src === 'open5e' ? KIND_LABELS.filter(([k]) => (sources.data?.open5e?.kinds ?? []).includes(k)) : KIND_LABELS;

  return (
    <section className="card stack">
      <h3>Import a module</h3>
      <Tabs label="Import from" value={src} onChange={(s) => { setSrc(s); setReq(null); setPre(null); setDone(false); setKinds([]); }} items={[...(o5 ? [['open5e', 'Open5e'], ['dnd5eapi', '5e SRD API']] as [Src, string][] : []), ['json', 'JSON'], ['zip', 'Zip'], ['folder', 'Folder'], ['git', 'Git repo'], ['api', 'API']]} />
      {!o5 && <p className="tiny muted">Turn on <strong>Open5e and the 5e SRD API</strong> under House rules to pull free books (Tome of Beasts, Deep Magic, the SRD ...) from here.</p>}
      <ErrorBox error={act.error ?? sources.error} />
      {src === 'open5e' && (
        <div className="stack tight">
          <p className="tiny muted">Free books from <a href="https://open5e.com" target="_blank" rel="noreferrer">Open5e</a>: monsters, spells, magic items and more, each under its own open licence (shown in Credits once saved). Pick one or more. Books your server admin already pulled are under Available above, ready to turn on.</p>
          {sources.loading && !sources.data ? <Loading /> : sources.data?.open5e?.error ? <p className="error-box">Open5e could not be reached: {sources.data.open5e.error}</p> : systems.map((sys) => (
            <fieldset key={sys} className="stack tight" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="tiny muted">{sys}</legend>
              {docs.filter((d) => (d.gamesystem || 'Other') === sys).map((d) => (
                <label key={d.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'start' }}>
                  <input type="checkbox" checked={books.includes(d.key)} onChange={() => { setBooks(toggle(books, d.key)); setPre(null); setDone(false); }} />
                  <span><strong>{d.name}</strong> {d.edition && <span className="chip">5e {d.edition}</span>} <span className="tiny muted">{[d.publisher, d.license].filter(Boolean).join(' · ')}</span>{d.desc && <><br /><span className="tiny muted">{d.desc}</span></>}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      {src === 'dnd5eapi' && (
        <div className="stack tight">
          <p className="tiny muted">A fresh copy of the System Reference Document from the <a href="https://www.dnd5eapi.co" target="_blank" rel="noreferrer">5e SRD API</a>, as its own module. The app already has both SRDs built in; use this to pick up the API's newer fixes and additions.</p>
          <Field label="Edition"><select value={edition} onChange={(e) => { setEdition(e.target.value); setPre(null); }}>{(sources.data?.dnd5eapi?.editions ?? [{ id: '2024', name: 'SRD 5.2 (D&D 2024)' }, { id: '2014', name: 'SRD 5.1 (D&D 5e 2014)' }]).map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        </div>
      )}
      {free && (
        <div className="stack tight">
          <p className="tiny muted">Only some kinds (none ticked: everything)</p>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {kindChoices.map(([k, label]) => <label key={k} className="row" style={{ gap: 6 }}><input type="checkbox" checked={kinds.includes(k)} onChange={() => { setKinds(toggle(kinds, k)); setPre(null); }} /> {label}</label>)}
          </div>
        </div>
      )}
      {src === 'json' && (
        <>
          <Field label="JSON file"><input type="file" accept=".json,application/json" onChange={(e) => void pickFiles(e.target.files)} /></Field>
          <Field label="…or paste it"><textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); setReq(null); setPre(null); }} placeholder='{ "id": "my-module", "name": "My module", "terms": [ … ] }' /></Field>
        </>
      )}
      {src === 'zip' && <Field label="Zip of Markdown files" help="One term per file. Frontmatter: kind, aliases, summary. Up to about 3 MB here."><input type="file" accept=".zip,application/zip" onChange={(e) => void pickFiles(e.target.files)} /></Field>}
      {src === 'folder' && <Field label="Folder of Markdown files" help="One term per file."><input type="file" multiple {...({ webkitdirectory: '' } as any)} onChange={(e) => void pickFiles(e.target.files)} /></Field>}
      {(src === 'git' || src === 'api') && <Field label={src === 'git' ? 'Repository address (https)' : 'API address'}><input type="url" value={url} onChange={(e) => { setUrl(e.target.value); setPre(null); }} placeholder={src === 'git' ? 'https://example.com/me/my-rules.git' : 'https://example.com/api/spells'} /></Field>}
      {src === 'api' && (
        <div className="stack tight">
          <p className="tiny muted">Say where the list is, and which field holds each part. A dotted path like <code>data.name</code> works.</p>
          {([['itemsPath', 'List at (blank: the answer is the list)'], ['term', 'Name field'], ['text', 'Text field(s), comma-separated'], ['kind', 'Kind field'], ['summary', 'Summary field'], ['aliases', 'Aliases field'], ['id', 'Id field'], ['token', 'Access token (optional)']] as const).map(([k, label]) => (
            <Field key={k} label={label}><input type={k === 'token' ? 'password' : 'text'} value={(api as any)[k]} onChange={(e) => setApi({ ...api, [k]: e.target.value })} /></Field>
          ))}
          <Field label="Paging"><select value={api.paging} onChange={(e) => setApi({ ...api, paging: e.target.value })}><option value="none">One request</option><option value="page">Page numbers</option><option value="link">Next link</option></select></Field>
        </div>
      )}
      <div className="stack tight">
        <Field label="Name"><input value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} placeholder={free ? 'Optional: taken from the source' : 'Required for zips, folders, Git and APIs'} /></Field>
        <Field label="Version"><input value={meta.version} onChange={(e) => setMeta({ ...meta, version: e.target.value })} /></Field>
        <Field label="License"><input value={meta.license} onChange={(e) => setMeta({ ...meta, license: e.target.value })} placeholder="e.g. CC-BY-4.0" /></Field>
        <Field label="Credit line (shown in the app)"><textarea rows={2} value={meta.attribution} onChange={(e) => setMeta({ ...meta, attribution: e.target.value })} /></Field>
      </div>
      <div className="row"><button type="button" className="btn" disabled={act.busy || !ready} onClick={() => void doPreview()}>Preview</button></div>

      {pre && (
        <div className="stack tight" role="region" aria-label="Import preview">
          <p><strong>{pre.module.name}</strong> ({pre.module.id}): {pre.total} terms. {Object.entries(pre.counts).map(([k, n]) => `${n} ${k}`).join(', ')}.</p>
          <ul className="tiny">{pre.samples.map((s: any, i: number) => <li key={i}><strong>{s.term}</strong> <span className="chip">{s.kind}</span> {s.summary}</li>)}</ul>
          {pre.warnings.map((m: string, i: number) => <p key={i} className="tiny muted">{m}</p>)}
          {pre.reserved && <p className="error-box">That id belongs to a built-in module. Give the module another name.</p>}
          {pre.exists && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace the module already imported with this id</label>}
          <p className="tiny muted">Monsters go straight into the encounter builder, initiative and rules cards once the module is on.</p>
          {(pre.counts.spell ?? 0) > 0 && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={feed.spells} onChange={(e) => setFeed({ ...feed, spells: e.target.checked })} /> Also add its {pre.counts.spell} spells to the Codex (spell list and spell tree)</label>}
          {(pre.counts.item ?? 0) > 0 && <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={feed.items} onChange={(e) => setFeed({ ...feed, items: e.target.checked })} /> Also add its {pre.counts.item} items to the shop's item database</label>}
          <div className="row"><button type="button" className="btn primary" disabled={act.busy || pre.reserved || (pre.exists && !replace)} onClick={() => void doSave()}>Save module</button></div>
        </div>
      )}
      {done && <p role="status">Saved. It is on at the end of the list; reorder it above to let it win clashes.{fed?.spells ? ` Codex: ${fed.spells.added} spells added${fed.spells.skipped ? `, ${fed.spells.skipped} already there` : ''}.` : ''}{fed?.items ? ` Shop: ${fed.items.added} items added${fed.items.skipped ? `, ${fed.items.skipped} already there` : ''}.` : ''}</p>}
    </section>
  );
}

const KIND_TABS: [string, string][] = [['', 'All'], ['spell', 'Spells'], ['monster', 'Monsters'], ['item', 'Items'], ['condition', 'Conditions'], ['rule', 'Rules'], ['class', 'Classes'], ['action', 'Actions'], ['other', 'Other']];

/** Everything in one module, searchable; the DM can read an entry and leave it out of this world (or put it back). */
export function ModuleBrowser({ id, onClose }: { id: string; onClose: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [onlyOut, setOnlyOut] = useState(false);
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<any | null>(null);
  const qs = new URLSearchParams({ ...(q.trim() ? { q: q.trim() } : {}), ...(kind ? { kind } : {}), ...(onlyOut ? { left: '1' } : {}), limit: String(limit) }).toString();
  const list = useLoad<any>(() => w.call('GET', `/modules/browse/${encodeURIComponent(id)}?${qs}`), [w, id, qs], ['modules']);
  const d = list.data;
  const toggle = (t: any) => act.run(async () => {
    await w.call('PUT', '/modules/left-out', { module: id, terms: [t.id], out: !t.leftOut });
    await list.reload();
    if (open?.id === t.id) setOpen({ ...open, leftOut: !t.leftOut });
  });
  const read = (t: any) => act.run(async () => setOpen(open?.id === t.id ? null : await w.call('GET', `/modules/browse/${encodeURIComponent(id)}/${encodeURIComponent(t.id)}`)));
  const kinds = KIND_TABS.filter(([k]) => !k || (d?.counts?.[k] ?? 0) > 0);

  return (
    <section className="card stack" aria-label={`Browse ${d?.module?.name ?? id}`}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <h3>{d?.module?.name ?? 'Module'}</h3>
        <button type="button" className="btn small" onClick={onClose}>Close</button>
      </div>
      <p className="tiny muted">Leave out anything you don't want in this world: it stops showing in rules lookups, cards, highlights, the encounter builder and initiative, and won't be added to the Codex or the shop. If another module that's on has an entry with the same name, that one shows instead. Copies already added to the Codex or the shop stay there; remove them in the Codex or the shop.{d?.leftOut ? ` ${d.leftOut} left out so far.` : ''}</p>
      <ErrorBox error={list.error ?? act.error} />
      <input type="search" className="input" placeholder="Find in this module" aria-label="Find in this module" value={q} onChange={(e) => { setQ(e.target.value); setLimit(50); }} />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {kinds.map(([k, label]) => <button key={k || 'all'} type="button" className={`btn small${kind === k ? ' primary' : ''}`} aria-pressed={kind === k} onClick={() => { setKind(k); setLimit(50); }}>{label}{k && d?.counts?.[k] ? ` ${d.counts[k]}` : ''}</button>)}
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} /> Only left out</label>
      </div>
      {list.loading && !d ? <Loading /> : (
        <div className="stack tight">
          {d?.terms?.length === 0 && <p className="muted">Nothing matches.</p>}
          {d?.terms?.map((t: any) => (
            <div key={t.id} className="stack tight" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 6, opacity: t.leftOut ? 0.6 : 1 }}>
              <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn ghost small" style={{ textAlign: 'left' }} aria-expanded={open?.id === t.id} onClick={() => void read(t)}>
                  <strong style={{ textDecoration: t.leftOut ? 'line-through' : undefined }}>{t.term}</strong> <span className="chip">{t.kind}</span>{t.leftOut && <> <span className="chip">left out</span></>}
                </button>
                <button type="button" className="btn small" disabled={act.busy} onClick={() => void toggle(t)}>{t.leftOut ? 'Put back' : 'Leave out'}</button>
              </div>
              {open?.id === t.id ? <div className="tiny"><Markdown text={open.text || open.summary} /></div> : <span className="tiny muted">{t.summary}</span>}
            </div>
          ))}
          {d && d.total > (d.terms?.length ?? 0) && <button type="button" className="btn small" onClick={() => setLimit(limit + 100)}>Show more ({d.total - d.terms.length} more)</button>}
        </div>
      )}
    </section>
  );
}
