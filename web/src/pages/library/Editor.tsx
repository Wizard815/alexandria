// DM editor for pages written in Alexandria (Markdown). Imported pages are
// edited in their own app and synced, so they never open here.
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, Field, VisibilityPicker, useAction } from '../../ui/index.tsx';

export function Editor({ initial, isNew, onSaved, onCancel }: { initial: any; isNew?: boolean; onSaved: (p: { id: string; title: string }) => void; onCancel: () => void }) {
  const { w } = useWorld();
  const [path, setPath] = useState<string>(isNew ? '' : String(initial.path ?? '').replace(/\.md$/i, ''));
  const [title, setTitle] = useState<string>(initial.title ?? '');
  const [body, setBody] = useState<string>(initial.body ?? '');
  const [vis, setVis] = useState<string>(initial.visibility ?? 'dm');
  const [fm, setFm] = useState<string>(JSON.stringify(initial.frontmatter ?? {}, null, 2));
  const act = useAction();

  const save = () => act.run(async () => {
    let frontmatter: Record<string, unknown>;
    try { frontmatter = JSON.parse(fm || '{}'); } catch { throw new Error('Frontmatter must be valid JSON'); }
    const p = path.trim() || title.trim();
    if (!p) throw new Error('Give the page a title or path');
    const saved: any = await w.savePage({ path: p, title: title.trim() || undefined, body, frontmatter, visibility: vis as 'dm' | 'party' });
    onSaved(saved);
  });

  return (
    <form className="card gold" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{isNew ? 'New page' : `Edit ${initial.title}`}</h2>
      <div className="grid">
        <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Old Kesh" /></Field>
        <Field label="Path" help={isNew ? 'Folder/name. Leave empty to use the title.' : 'Changing the path makes a new page.'}><input className="mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Places/Old Kesh" /></Field>
      </div>
      <div className="row"><span className="small muted">Who can read it</span><VisibilityPicker value={vis} onChange={setVis} labels={{ dm: 'DM only', party: 'Shared with the party' }} /></div>
      <Field label="Page (Markdown)" help="Use [[Page name]] to link. > [!note] makes a callout; > [!secret] is removed from the player copy.">
        <textarea className="code" rows={18} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <details><summary className="small muted">Frontmatter (JSON): tags, aliases, facts, relations, secret:</summary>
        <Field label="Frontmatter" help='e.g. {"tags": ["town"], "population": 2400, "parents": ["[[Old Lord Varn]]"], "secret": {"lovers": ["[[Brother Tamsin]]"]}}'><textarea className="code" rows={6} value={fm} onChange={(e) => setFm(e.target.value)} /></Field>
      </details>
      <ErrorBox error={act.error} />
      <div className="row end"><button type="button" className="btn" onClick={onCancel}>Cancel</button><button type="submit" className="btn primary" disabled={act.busy}>{act.busy && !act.offline ? 'Saving…' : 'Save page'}</button></div>
    </form>
  );
}

export function SecretHint() {
  return (
    <details className="note small">
      <summary>How to keep parts of a shared page secret</summary>
      <div className="stack tight" style={{ marginTop: 8 }}>
        <span><code className="mono">{'> [!secret]'}</code> callouts (also <code className="mono">[!dm]</code>, <code className="mono">[!gm]</code>) are removed, with every <code className="mono">&gt;</code> line under them. LegendKeeper secret blocks are removed the same way.</span>
        <span><code className="mono">%% comment %%</code> and <code className="mono">{'<!-- dm --> … <!-- /dm -->'}</code> are removed.</span>
        <span>A heading marked <code className="mono">(DM)</code>, <code className="mono">[DM]</code>, "DM only" or starting "DM —", or titled Secrets / DM notes, is removed with everything under it.</span>
        <span>Frontmatter under <code className="mono">secret:</code>, and facts like <code className="mono">dm_notes</code>, never reach players.</span>
        <span>Links to DM-only pages show as “(hidden)”. Blocks the librarian doesn't know are never shown to players.</span>
      </div>
    </details>
  );
}
