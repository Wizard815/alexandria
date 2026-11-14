// World settings tab: which part of the world is the AI's own wiki.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { ErrorBox, Field, Loading, useAction, useToast } from '../../ui/index.tsx';
import { LEVEL_LABEL, type LoreOptions, type LoreRoot, type LoreState } from './shared.ts';

export default function WorldLoreSettings() {
  const { w } = useWorld();
  const st = useLoad<LoreState>(() => w.call('GET', '/worldlore'), [w], ['settings']);
  const opts = useLoad<LoreOptions>(() => w.call('GET', '/worldlore/options'), [w], []);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [pick, setPick] = useState('');
  const [level, setLevel] = useState<'dm' | 'broker' | 'party'>('dm');
  const [url, setUrl] = useState('');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ source: string; roots: LoreRoot[] } | null>(null);

  if (!st.data) return <Loading />;
  const cur = st.data;
  const save = (body: unknown, msg: string) => act.run(async () => { await w.call('PUT', '/worldlore/config', body); await st.reload(); toast(msg); });
  const [kind, sid, root] = pick.split('|');
  const choose = () => {
    if (!pick) return;
    void save(kind === 'library' ? { kind: 'library', root: 'WorldLore', defaultLevel: level } : { kind: 'source', sourceId: sid, root, defaultLevel: level, ...(url.trim() ? { url: url.trim() } : {}) }, 'WorldLore is on');
  };

  const kanka = opts.data?.sources.find((s) => s.kind.startsWith('kanka'));
  const search = () => kanka && q.trim() && act.run(async () => {
    const r = await w.call('GET', `/worldlore/options/search?source=${encodeURIComponent(kanka.id)}&q=${encodeURIComponent(q.trim())}`) as { roots: LoreRoot[] };
    setFound({ source: kanka.id, roots: r.roots });
  });
  const rootLabel = (r: LoreRoot) => `${r.title}${r.folder ? ' (folder)' : r.kind ? ` (${r.kind})` : ''}`;

  return (
    <section className="card stack">
      <p className="small muted" style={{ margin: 0 }}>
        One part of this world is the AI's own wiki. There it can read, write, move and delete pages with no confirmation. Everywhere else your sources stay read-only and library changes still wait for you.
      </p>
      <ErrorBox error={act.error ?? st.error} />
      {cur.enabled && cur.config ? (
        <div className="stack tight" data-testid="worldlore-on">
          <strong>On: {cur.links?.sourceName ?? 'Library'} / {cur.config.root}</strong>
          <span className="small muted">New pages are {LEVEL_LABEL[cur.config.defaultLevel].toLowerCase()} unless the AI picks another level.</span>
          {cur.links?.url ? <a href={cur.links.url} target="_blank" rel="noreferrer">Open in the source{cur.links.guess ? ' (best guess link)' : ''}</a> : cur.links?.libraryFolder ? <span className="small">Pages live in the library folder {cur.links.libraryFolder}/.</span> : <span className="small muted">No link known for this source.</span>}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" disabled={act.busy} onClick={() => void save({ enabled: false }, 'WorldLore is off')}>Turn off</button>
          </div>
        </div>
      ) : <p className="small" data-testid="worldlore-off">Off.</p>}

      <h3 style={{ margin: 0 }}>{cur.enabled ? 'Change the workspace' : 'Choose the workspace'}</h3>
      {!opts.data ? <Loading /> : (
        <>
          <Field label="Where" help="A LegendKeeper folder or page, a Kanka note or journal, a Markdown folder, or the WorldLore folder of the library.">
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Workspace">
              <option value="">Pick one…</option>
              <option value={`library|-|${opts.data.library.root}`}>Library: {opts.data.library.root}/ folder</option>
              {opts.data.sources.map((s) => (
                <optgroup key={s.id} label={`${s.name} (${s.label})${s.error ? ` – ${s.error}` : ''}`}>
                  {s.roots.map((r) => <option key={r.id} value={`source|${s.id}|${r.id}`}>{rootLabel(r)}</option>)}
                  {found?.source === s.id && found.roots.filter((r) => !s.roots.some((x) => x.id === r.id)).map((r) => <option key={r.id} value={`source|${s.id}|${r.id}`}>{rootLabel(r)}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          {kanka && (
            <Field label={`Find a ${kanka.label.split(' ')[0]} note or journal`} help="The home page is one Kanka note or journal; the AI makes its pages under it, of the same type. Search by name for one that is not at the top.">
              <div className="row" style={{ gap: 8 }}>
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} placeholder="Name…" aria-label="Search Kanka" />
                <button type="button" className="btn" disabled={act.busy || !q.trim()} onClick={() => void search()}>Search</button>
              </div>
              {found && !found.roots.length && <span className="small muted">Nothing found.</span>}
            </Field>
          )}
          <Field label="New pages are">
            <select value={level} onChange={(e) => setLevel(e.target.value as 'dm' | 'broker' | 'party')} aria-label="Default level">
              {(['dm', 'broker', 'party'] as const).map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
            </select>
          </Field>
          {kind === 'source' && <Field label="Link to open it (optional)" help="Paste the address of the folder in the source if you want a link here."><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" /></Field>}
          <div className="row"><button type="button" className="btn primary" disabled={act.busy || !pick} onClick={choose}>{cur.enabled ? 'Change' : 'Turn on'}</button></div>
        </>
      )}
      {toastNode}
    </section>
  );
}
