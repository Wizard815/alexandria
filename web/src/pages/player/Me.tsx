// Me: who my character is, block by block, each with its own audience.
// "Only me" blocks are hidden from the DM too; the librarian enforces it.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { PageHead, Loading, ErrorBox, Empty, Tabs, Field, VisibilityPicker, VisChip, Modal, Switch, useAction, useToast } from '../../ui/index.tsx';

type Section = 'story' | 'traits' | 'goals' | 'bonds' | 'basics';
interface Block { id: string; section: Section; title: string; body: string; visibility: 'me' | 'dm' | 'party'; sort: number }

const SECTIONS: [Section, string][] = [['story', 'Story'], ['traits', 'Traits'], ['goals', 'Goals'], ['bonds', 'Bonds'], ['basics', 'Basics']];
const VIS_LABELS = { me: 'Only me', dm: 'Me and the DM', party: 'The party can see' };
const RACES = ['human', 'elf', 'half-elf', 'dwarf', 'halfling', 'gnome', 'half-orc', 'orc', 'tiefling', 'dragonborn', 'goliath', 'aasimar'];

export default function PlayerMe() {
  const { w, me, members } = useWorld();
  const self = members.find((m) => m.id === me);
  const prof = useLoad(() => w.profile('me') as Promise<{ name: string; blocks: Block[] }>, [w]);
  const [tab, setTab] = useState<Section>('story');
  const [edit, setEdit] = useState<Partial<Block> | null>(null);
  const act = useAction();
  const { toast, toastNode } = useToast();

  const blocks = (prof.data?.blocks ?? []).filter((b) => b.section === tab).sort((a, b) => a.sort - b.sort);
  const remove = (b: Block) => act.run(async () => {
    if (!window.confirm(`Delete “${b.title}”?`)) return;
    await w.call('DELETE', `/profiles/me/blocks/${b.id}`);
    await prof.reload();
    toast('Deleted');
  });

  return (
    <div className="page">
      <PageHead title={prof.data?.name ?? self?.character_name ?? 'Me'} lead="Who your character is. Each block says who can read it." />
      <ErrorBox error={prof.error ?? act.error} />
      <div className="cols">
        <div className="col-3 stack loose">
          <div className="row between">
            <Tabs label="About me" value={tab} onChange={setTab} items={SECTIONS} />
            <button type="button" className="btn primary small" onClick={() => setEdit({ section: tab, visibility: 'me', title: '', body: '' })}>＋ Add a block</button>
          </div>
          {prof.loading && !prof.data ? <Loading /> : blocks.length ? blocks.map((b) => (
            <section key={b.id} className="card">
              <div className="card-head">
                <h3>{b.title}</h3>
                <span className="row" style={{ gap: 6 }}>
                  <VisChip v={b.visibility} />
                  <button type="button" className="btn small ghost" onClick={() => setEdit(b)}>Edit</button>
                  <button type="button" className="btn small ghost" onClick={() => void remove(b)} aria-label={`Delete ${b.title}`}>✕</button>
                </span>
              </div>
              <p className="read" style={{ whiteSpace: 'pre-line' }}>{b.body || <span className="faint">Empty</span>}</p>
            </section>
          )) : <Empty>Nothing under {SECTIONS.find((s) => s[0] === tab)?.[1]} yet.</Empty>}
        </div>
        <aside className="col-1 stack loose">
          <ThemeCard />
          <div className="note small">“Only me” blocks are hidden from everyone, the DM too. “Me and the DM” is for secrets your DM should know. Stats stay in your character sheet app.</div>
        </aside>
      </div>
      {edit && <BlockModal block={edit} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await prof.reload(); toast('Saved'); }} />}
      {toastNode}
    </div>
  );
}

function BlockModal({ block, onClose, onSaved }: { block: Partial<Block>; onClose: () => void; onSaved: () => void }) {
  const { w } = useWorld();
  const [b, setB] = useState(block);
  const act = useAction();
  const save = () => act.run(async () => {
    await w.saveBlock({ id: b.id, section: b.section ?? 'story', title: (b.title ?? '').trim(), body: b.body ?? '', visibility: b.visibility ?? 'me', sort: b.sort ?? 0 });
    onSaved();
  });
  return (
    <Modal title={b.id ? 'Edit block' : 'New block'} onClose={onClose}>
      <Field label="Section">
        <select value={b.section} onChange={(e) => setB({ ...b, section: e.target.value as Section })}>
          {SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Title"><input value={b.title ?? ''} maxLength={120} onChange={(e) => setB({ ...b, title: e.target.value })} /></Field>
      <Field label="Text"><textarea rows={6} value={b.body ?? ''} onChange={(e) => setB({ ...b, body: e.target.value })} /></Field>
      <div className="stack tight">
        <span className="small" style={{ fontWeight: 500 }}>Who can read this</span>
        <VisibilityPicker value={b.visibility ?? 'me'} onChange={(v) => setB({ ...b, visibility: v })} options={['me', 'dm', 'party']} labels={VIS_LABELS} />
      </div>
      <ErrorBox error={act.error} />
      <div className="row end">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={act.busy || !(b.title ?? '').trim()} onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

function ThemeCard() {
  const { client, me, refresh } = useAuth();
  const t = me?.theme ?? {};
  const [race, setRace] = useState(t.race ?? 'human');
  const [mode, setMode] = useState<'dark' | 'light'>(t.mode ?? 'dark');
  const [effects, setEffects] = useState(t.effects !== false);
  const { info } = useWorld();
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const save = () => act.run(async () => { await client.setTheme({ race, mode, effects }); await refresh(); setSaved(true); });
  return (
    <section className="card" aria-labelledby="theme-h">
      <h2 id="theme-h">Appearance</h2>
      <Field label="Theme"><select value={race} onChange={(e) => { setRace(e.target.value); setSaved(false); }}>{RACES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></Field>
      <div className="tabs" role="radiogroup" aria-label="Light or dark">
        {(['dark', 'light'] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn small${mode === m ? ' on' : ''}`} onClick={() => { setMode(m); setSaved(false); }}>{m === 'dark' ? 'Dark' : 'Light'}</button>)}
      </div>
      <div className="row between">
        <span className="small">Effects (embers, mist){!info.settings.themeEffects && <span className="faint"> · off in this world</span>}</span>
        <Switch checked={effects} onChange={(v) => { setEffects(v); setSaved(false); }} label="Theme effects" />
      </div>
      <ErrorBox error={act.error} />
      <div className="row between"><span className="tiny faint" role="status">{saved ? 'Saved to your account.' : ''}</span><button type="button" className="btn small" disabled={act.busy} onClick={() => void save()}>Save look</button></div>
    </section>
  );
}
