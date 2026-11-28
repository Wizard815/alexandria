// The GM's Codex: every spell (SRD, homebrew, imports) with who may read it,
// its mana cost and notes; the characters (sheet, known spells, mana, rests);
// the spell crafting recipes (by tier, drafts from the assistant, import and
// export); and requests to learn.
import { useMemo, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { RecipeCard, SheetButton } from './PlayerCodex.tsx';
import { ABILITIES, ManaBar, SpellCard, SpellSearch, levelText, useSpell, type Character, type RecipeView, type Spell } from './shared.tsx';

type Tab = 'spells' | 'characters' | 'recipes' | 'requests';

export default function GMCodex() {
  const { w, info } = useWorld();
  const [tab, setTab] = useState<Tab>('spells');
  const reqs = useLoad<any>(() => w.call('GET', '/spells/learn?status=pending'), [w], ['spells-learn']);
  const pending = (reqs.data?.requests ?? []).length;
  return (
    <div className="page wide">
      <PageHead title="Codex" lead={`Every spell in ${info.name}: the SRD 5.2.1 list, your homebrew and imports. Players read the ones they know or you make public.`} />
      <Tabs label="Codex" value={tab} onChange={setTab} items={[['spells', 'Spells'], ['characters', 'Characters'], ['recipes', 'Recipes'], ['requests', `Requests${pending ? ` (${pending})` : ''}`]]} />
      {tab === 'spells' && <SpellsTab />}
      {tab === 'characters' && <CharactersTab />}
      {tab === 'recipes' && <RecipesTab />}
      {tab === 'requests' && <RequestsTab />}
    </div>
  );
}

/** Every spell name, for the pickers. */
function useNames() {
  const { w } = useWorld();
  const all = useLoad<{ spells: Spell[] }>(() => w.call('GET', '/spells/list?limit=5000'), [w], ['spells']);
  return all.data?.spells ?? [];
}
function SpellNames({ id }: { id: string }) {
  const names = useNames();
  return <datalist id={id}>{names.map((s) => <option key={s.id} value={s.name}>{`${levelText(s.level)} · ${s.source}`}</option>)}</datalist>;
}

// ---- spells -----------------------------------------------------------------------------------------------

function SpellsTab() {
  const { w } = useWorld();
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<Spell | 'new' | null>(null);
  const [imp, setImp] = useState(false);
  const spell = useSpell(open);
  const overview = useLoad<any>(() => w.call('GET', '/spells'), [w], ['spells', 'settings']);
  const mana = { on: !!overview.data?.mana?.on };
  return (
    <div className="cols">
      <aside className="col-1 card stack" style={{ maxWidth: 460 }}>
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn small primary" onClick={() => setEdit('new')}>New homebrew spell</button>
          <button type="button" className="btn small" onClick={() => setImp(true)}>Import spells</button>
          <button type="button" className="btn small ghost" onClick={() => void download(w)}>Export my spells</button>
        </div>
        <SpellSearch onPick={(s) => setOpen(s.id)} picked={open} badge={(s) => <span className="row" style={{ gap: 4 }}>{s.public && <span className="chip teal">Public</span>}{!s.builtin && <span className="chip">{s.kind === 'homebrew' ? 'Homebrew' : 'Imported'}</span>}</span>} />
      </aside>
      <section className="col-2 card">
        {open && spell.data ? (
          <SpellCard s={spell.data} mana={mana} actions={<MetaEditor s={spell.data} onEdit={() => setEdit(spell.data!)} onGone={() => setOpen(null)} />} />
        ) : open && spell.error ? <ErrorBox error={spell.error} /> : <Empty>Pick a spell to read it, open it to the players or set its mana cost.</Empty>}
        {overview.data && <p className="tiny faint" style={{ marginTop: 12 }}>{overview.data.srd.attribution}</p>}
      </section>
      {edit && <SpellEditor spell={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={(s) => { setEdit(null); setOpen(s.id); }} />}
      {imp && <ImportModal onClose={() => setImp(false)} />}
    </div>
  );
}

async function download(w: any) {
  const data = await w.call('GET', '/spells/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = 'spells.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function MetaEditor({ s, onEdit, onGone }: { s: Spell; onEdit: () => void; onGone: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [notes, setNotes] = useState(s.gmNotes ?? '');
  const [cost, setCost] = useState(s.manaOverride === null || s.manaOverride === undefined ? '' : String(s.manaOverride));
  const save = (patch: any) => act.run(async () => { await w.call('PUT', `/spells/s/${encodeURIComponent(s.id)}/meta`, patch); toast('Saved'); });
  return (
    <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
      <ErrorBox error={act.error} />
      <div className="row between"><span>Players may read it <span className="tiny muted">(they always read the spells they know)</span></span><Switch checked={!!s.public} label={`Players may read ${s.name}`} onChange={(v) => void save({ public: v })} /></div>
      <div className="row" style={{ gap: 10, alignItems: 'flex-end' }}>
        <Field label="Mana cost" help="Empty: the world's cost table."><input type="number" min={0} max={999} value={cost} onChange={(e) => setCost(e.target.value)} style={{ width: 100 }} /></Field>
        <Field label="GM notes (never shown to players)"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <button type="button" className="btn small" disabled={act.busy} onClick={() => void save({ manaOverride: cost === '' ? null : Number(cost), gmNotes: notes })}>Save</button>
      </div>
      {!s.builtin && (
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn small" onClick={onEdit}>Edit spell</button>
          <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { if (confirm(`Delete ${s.name}?`)) void act.run(async () => { await w.call('DELETE', `/spells/s/${encodeURIComponent(s.id)}`); onGone(); }); }}>Delete spell</button>
        </div>
      )}
      {toastNode}
    </div>
  );
}

const SCHOOLS = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];

function SpellEditor({ spell, onClose, onSaved }: { spell: Spell | null; onClose: () => void; onSaved: (s: Spell) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const full = useSpell(spell?.id ?? null);
  const s0 = full.data ?? spell;
  const [f, setF] = useState<any>(() => ({
    name: s0?.name ?? '', level: s0?.level ?? 1, school: s0?.school ?? 'Evocation', classes: (s0?.classes ?? []).join(', '), castingTime: s0?.castingTime ?? 'Action', ritual: !!s0?.ritual,
    range: s0?.range ?? '', v: s0?.components.v ?? true, s: s0?.components.s ?? true, m: s0?.components.m ?? false, material: s0?.material ?? '', duration: s0?.duration ?? 'Instantaneous',
    concentration: !!s0?.concentration, text: s0?.text ?? '', source: s0?.source ?? 'Homebrew', public: !!s0?.public, manaOverride: s0?.manaOverride ?? '', gmNotes: s0?.gmNotes ?? '',
  }));
  const set = (k: string, v: unknown) => setF((o: any) => ({ ...o, [k]: v }));
  const save = () => act.run(async () => {
    const body = { name: f.name, level: Number(f.level), school: f.school, classes: f.classes, castingTime: f.castingTime, ritual: f.ritual, range: f.range,
      components: { v: f.v, s: f.s, m: f.m, material: f.material }, material: f.material, duration: f.concentration && !/^concentration/i.test(f.duration) ? `Concentration, ${f.duration}` : f.duration,
      concentration: f.concentration, text: f.text, source: f.source || 'Homebrew', public: f.public, manaOverride: f.manaOverride === '' ? null : Number(f.manaOverride), gmNotes: f.gmNotes };
    const out: Spell = spell ? await w.call('PUT', `/spells/s/${encodeURIComponent(spell.id)}`, body) : await w.call('POST', '/spells/s', body);
    onSaved(out);
  });
  return (
    <Modal title={spell ? `Edit ${spell.name}` : 'New homebrew spell'} onClose={onClose}>
      <div className="stack">
        <ErrorBox error={act.error} />
        <Field label="Name"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Level"><select value={f.level} onChange={(e) => set('level', e.target.value)}>{[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>{levelText(n)}</option>)}</select></Field>
          <Field label="School"><select value={f.school} onChange={(e) => set('school', e.target.value)}>{SCHOOLS.map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Classes"><input value={f.classes} onChange={(e) => set('classes', e.target.value)} placeholder="Wizard, Sorcerer" /></Field>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Casting time"><input value={f.castingTime} onChange={(e) => set('castingTime', e.target.value)} /></Field>
          <Field label="Range"><input value={f.range} onChange={(e) => set('range', e.target.value)} placeholder="60 feet" /></Field>
          <Field label="Duration"><input value={f.duration} onChange={(e) => set('duration', e.target.value)} /></Field>
        </div>
        <div className="row" style={{ gap: 14 }}>
          {(['v', 's', 'm'] as const).map((k) => <label key={k} className="row" style={{ gap: 4 }}><input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} /> {k.toUpperCase()}</label>)}
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.concentration} onChange={(e) => set('concentration', e.target.checked)} /> Concentration</label>
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.ritual} onChange={(e) => set('ritual', e.target.checked)} /> Ritual</label>
        </div>
        {f.m && <Field label="Material" help='Say "worth 50 GP" for a costly component and "which the spell consumes" when it is used up.'><input value={f.material} onChange={(e) => set('material', e.target.value)} /></Field>}
        <Field label="Description (Markdown)" help="Damage types and saving throws are read from the text (e.g. 3d6 Fire damage, a Dexterity saving throw)."><textarea rows={6} value={f.text} onChange={(e) => set('text', e.target.value)} /></Field>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Source"><input value={f.source} onChange={(e) => set('source', e.target.value)} /></Field>
          <Field label="Mana cost (empty: table)"><input type="number" min={0} value={f.manaOverride} onChange={(e) => set('manaOverride', e.target.value)} style={{ width: 100 }} /></Field>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.public} onChange={(e) => set('public', e.target.checked)} /> Players may read it</label>
        </div>
        <Field label="GM notes (never shown to players)"><textarea rows={2} value={f.gmNotes} onChange={(e) => set('gmNotes', e.target.value)} /></Field>
        <div className="row end"><button type="button" className="btn primary" disabled={act.busy || !f.name.trim()} onClick={() => void save()}>Save spell</button></div>
      </div>
    </Modal>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [type, setType] = useState<'json' | 'csv' | 'module' | 'library'>('json');
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [moduleId, setModuleId] = useState('');
  const [folder, setFolder] = useState('');
  const [replace, setReplace] = useState(false);
  const [makePublic, setMakePublic] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const mods = useLoad<any>(() => w.call('GET', '/modules'), [w]);
  const body = () => ({ type, ...(type === 'json' ? { json: text } : type === 'csv' ? { csv: text } : type === 'module' ? { moduleId } : { folder }), ...(source.trim() ? { source: source.trim() } : {}), replace, public: makePublic });
  // Nothing to read yet (no text, module or folder): Preview waits instead of asking the server for an error.
  const ready = type === 'json' || type === 'csv' ? text.trim() !== '' : type === 'module' ? moduleId !== '' : folder.trim() !== '';
  const file = async (fl: File | undefined) => { if (fl) { setText(await fl.text()); if (!source) setSource(fl.name.replace(/\.(json|csv)$/i, '')); setPreview(null); } };
  return (
    <Modal title="Import spells" onClose={onClose}>
      <div className="stack">
        <p className="tiny muted">Spells are kept in this world only and marked with their source. A spell with the same name and source as one already here is skipped (or replaced). Only import what you may use: the SRD is already in.</p>
        <Tabs label="Import from" value={type} onChange={(v) => { setType(v); setPreview(null); setDone(null); }} items={[['json', 'JSON'], ['csv', 'CSV'], ['module', 'Game module'], ['library', 'Library pages']]} />
        <ErrorBox error={act.error} />
        {(type === 'json' || type === 'csv') && (
          <>
            <input type="file" accept={type === 'json' ? '.json,application/json' : '.csv,text/csv'} aria-label="File" onChange={(e) => void file(e.target.files?.[0])} />
            <textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder={type === 'json' ? '[{"name": "…", "level": 1, "school": "…", "castingTime": "Action", …}]' : 'name,level,school,casting time,range,components,duration,concentration,text'} aria-label="Spells" />
          </>
        )}
        {type === 'module' && (
          <Field label="Module"><select value={moduleId} onChange={(e) => { setModuleId(e.target.value); setPreview(null); }}><option value="">Choose…</option>{(mods.data?.available ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        )}
        {type === 'library' && (
          <Field label="Folder" help='Pages with a level in their frontmatter or a "spell" tag. Classified pages and GM-only parts of a page are left out.'><input value={folder} onChange={(e) => { setFolder(e.target.value); setPreview(null); }} placeholder="Spells" /></Field>
        )}
        <Field label="Source (shown on every spell)"><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Our house rules" /></Field>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace spells with the same name and source</label>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={makePublic} onChange={(e) => setMakePublic(e.target.checked)} /> Players may read them</label>
        <div className="row end">
          <button type="button" className="btn" disabled={act.busy || !ready} onClick={() => void act.run(async () => setPreview(await w.call('POST', '/spells/import/preview', body())))}>Preview</button>
          <button type="button" className="btn primary" disabled={act.busy || !preview} onClick={() => void act.run(async () => setDone(await w.call('POST', '/spells/import', body())))}>Import</button>
        </div>
        {preview && <div className="note"><strong>{preview.count} spells</strong> from {preview.source}{preview.duplicates ? `, ${preview.duplicates} already here` : ''}. {preview.sample.map((s: any) => s.name).join(', ')}{preview.warnings.length ? <ul>{preview.warnings.slice(0, 8).map((x: string, i: number) => <li key={i} className="tiny">{x}</li>)}</ul> : null}</div>}
        {done && <div className="note" role="status">Added {done.added.length}, replaced {done.replaced.length}, skipped {done.skipped.length}.</div>}
      </div>
    </Modal>
  );
}

// ---- characters -------------------------------------------------------------------------------------------

function CharactersTab() {
  const { w } = useWorld();
  const chars = useLoad<{ characters: Character[] }>(() => w.call('GET', '/spells/characters'), [w], ['spells-char', 'settings']);
  const overview = useLoad<any>(() => w.call('GET', '/spells'), [w], ['settings']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const manaOn = !!overview.data?.mana?.on;
  const rest = (kind: 'short' | 'long') => act.run(async () => { await w.call('POST', '/spells/rest', { kind }); toast(kind === 'long' ? 'Long rest: mana back' : 'Short rest: mana back'); await chars.reload(); });
  return (
    <div className="stack">
      <ErrorBox error={chars.error ?? act.error} />
      {manaOn && (
        <div className="row">
          <span className="tiny muted">Rests on the Clock page give mana back too.</span>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void rest('short')}>Short rest (mana)</button>
          <button type="button" className="btn small" disabled={act.busy} onClick={() => void rest('long')}>Long rest (mana)</button>
        </div>
      )}
      {chars.loading && !chars.data ? <Loading /> : (chars.data?.characters ?? []).length === 0 ? <Empty>No players in this world yet.</Empty> : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {chars.data!.characters.map((c) => <CharacterCard key={c.accountId} c={c} onChange={() => void chars.reload()} />)}
        </div>
      )}
      {toastNode}
    </div>
  );
}

function CharacterCard({ c, onChange }: { c: Character; onChange: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [show, setShow] = useState(false);
  const [add, setAdd] = useState(false);
  const [delta, setDelta] = useState('');
  const full = useLoad<any>(() => (show ? w.call('GET', `/spells/characters/${c.accountId}`) : Promise.resolve(null)), [w, show, c.accountId], ['spells-char']);
  const adjust = (body: any) => act.run(async () => { await w.call('POST', `/spells/characters/${c.accountId}/mana`, body); setDelta(''); onChange(); });
  return (
    <div className="card stack" aria-label={`Character ${c.name}`}>
      <div className="row between"><strong>{c.name}</strong><SheetButton c={c} accountId={c.accountId} gm onSaved={onChange} /></div>
      <span className="tiny muted">{[c.class, c.level ? `level ${c.level}` : 'level not set', ABILITIES.filter(([k]) => c.abilities[k]).map(([k, l]) => `${l} ${c.abilities[k]}`).join(' ')].filter(Boolean).join(' · ')}</span>
      <ErrorBox error={act.error} />
      {c.mana.on && (
        <>
          <ManaBar mana={c.mana} />
          <div className="row" style={{ gap: 6 }}>
            <input type="number" aria-label={`Change ${c.name}'s mana by`} placeholder="±" value={delta} onChange={(e) => setDelta(e.target.value)} style={{ width: 80 }} />
            <button type="button" className="btn small" disabled={act.busy || !delta} onClick={() => void adjust({ delta: Number(delta) })}>Adjust</button>
            <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void adjust({ full: true })}>Fill</button>
          </div>
        </>
      )}
      <div className="row between">
        <button type="button" className="btn small ghost" onClick={() => setShow(!show)} aria-expanded={show}>Known spells ({typeof c.known === 'number' ? c.known : 0})</button>
        <button type="button" className="btn small" onClick={() => setAdd(true)}>Add a spell</button>
      </div>
      {show && (full.data?.known ?? []).map((s: Spell) => (
        <div key={s.id} className="row between"><span>{s.name} <span className="tiny muted">{levelText(s.level)}{s.how === 'crafted' ? ' · crafted' : ''}</span></span>
          <button type="button" className="btn small ghost" disabled={act.busy} aria-label={`Remove ${s.name} from ${c.name}`} onClick={() => void act.run(async () => { await w.call('DELETE', `/spells/characters/${c.accountId}/known/${encodeURIComponent(s.id)}`); await full.reload(); onChange(); })}>✕</button></div>
      ))}
      {add && (
        <Modal title={`Add a spell to ${c.name}`} onClose={() => setAdd(false)}>
          <SpellSearch label={`Spell to add to ${c.name}`} onPick={(s) => void act.run(async () => { await w.call('POST', `/spells/characters/${c.accountId}/known`, { spellId: s.id }); setAdd(false); await full.reload(); onChange(); })} />
        </Modal>
      )}
    </div>
  );
}

// ---- recipes ----------------------------------------------------------------------------------------------

function RecipesTab() {
  const { w } = useWorld();
  const list = useLoad<{ recipes: RecipeView[] }>(() => w.call('GET', '/spells/recipes'), [w], ['spells-recipes', 'spells']);
  const overview = useLoad<any>(() => w.call('GET', '/spells'), [w], ['settings']);
  const act = useAction();
  const [view, setView] = useState<'tree' | 'list'>('tree');
  const [edit, setEdit] = useState<RecipeView | 'new' | null>(null);
  const [io, setIo] = useState(false);
  const rs = list.data?.recipes ?? [];
  const drafts = rs.filter((r) => r.draft);
  const byTier = useMemo(() => {
    const m = new Map<number, RecipeView[]>();
    for (const r of rs.filter((x) => !x.draft)) m.set(r.tier, [...(m.get(r.tier) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [rs]);
  const card = (r: RecipeView) => (
    <RecipeCard key={r.id} r={r}>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn small" onClick={() => setEdit(r)} aria-label={`Edit the recipe for ${r.result.name}`}>Edit</button>
        {r.draft && <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void act.run(async () => { await w.call('POST', `/spells/recipes/${r.id}/approve`); await list.reload(); })}>Approve</button>}
        <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { if (confirm(`Delete the recipe for ${r.result.name}?`)) void act.run(async () => { await w.call('DELETE', `/spells/recipes/${r.id}`); await list.reload(); }); }}>Delete</button>
      </div>
    </RecipeCard>
  );
  return (
    <div className="stack">
      {overview.data && !overview.data.crafting.on && <div className="note">Spell crafting is off: players do not see recipes. Turn it on in World settings → Spells &amp; mana.</div>}
      <ErrorBox error={list.error ?? act.error} />
      <div className="row between">
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn small primary" onClick={() => setEdit('new')}>New recipe</button>
          <button type="button" className="btn small" onClick={() => setIo(true)}>Import or export</button>
        </div>
        <Tabs label="View" value={view} onChange={setView} items={[['tree', 'By tier'], ['list', 'List']]} />
      </div>
      {drafts.length > 0 && (
        <section className="card stack">
          <h3>Drafts to review</h3>
          <p className="tiny muted">Suggested by the assistant (or saved as drafts). Players never see a draft.</p>
          {drafts.map(card)}
        </section>
      )}
      {list.loading && !list.data ? <Loading /> : rs.filter((r) => !r.draft).length === 0 ? <Empty>No recipes yet. A recipe teaches a spell to a character who knows 1 to 5 other spells, e.g. Fire Bolt + Burning Hands → Scorching Ray.</Empty> : view === 'tree' ? (
        <div className="spl-tiers" aria-label="Recipes by tier">
          {byTier.map(([t, xs]) => <div key={t} className="spl-tier"><h3>Tier {t}</h3>{xs.map(card)}</div>)}
        </div>
      ) : <div className="stack">{rs.filter((r) => !r.draft).map(card)}</div>}
      {edit && <RecipeEditor recipe={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void list.reload(); }} />}
      {io && <RecipeIO onClose={() => { setIo(false); void list.reload(); }} />}
    </div>
  );
}

function RecipeEditor({ recipe, onClose, onSaved }: { recipe: RecipeView | null; onClose: () => void; onSaved: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [f, setF] = useState<any>(() => ({
    result: recipe?.result.name ?? '', prereqs: recipe ? recipe.prereqs.map((p) => p.name) : ['', ''],
    items: recipe?.items.map((i) => ({ name: i.name, qty: i.qty, consumed: i.consumed })) ?? [], stats: { ...(recipe?.stats ?? {}) },
    minLevel: recipe?.minLevel ?? '', manaCost: recipe?.manaCost ?? '', visibility: recipe?.visibility ?? 'visible', gmNotes: recipe?.gmNotes ?? '',
  }));
  const set = (k: string, v: unknown) => setF((o: any) => ({ ...o, [k]: v }));
  const save = () => act.run(async () => {
    const body = { result: f.result, prereqs: f.prereqs.filter((x: string) => x.trim()), items: f.items.filter((i: any) => i.name.trim()).map((i: any) => ({ ...i, qty: Number(i.qty) || 1 })),
      stats: Object.fromEntries(Object.entries(f.stats).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, Number(v)])),
      minLevel: f.minLevel === '' ? null : Number(f.minLevel), manaCost: f.manaCost === '' ? null : Number(f.manaCost), visibility: f.visibility, gmNotes: f.gmNotes };
    if (recipe) await w.call('PUT', `/spells/recipes/${recipe.id}`, body); else await w.call('POST', '/spells/recipes', body);
    onSaved();
  });
  return (
    <Modal title={recipe ? `Recipe for ${recipe.result.name}` : 'New recipe'} onClose={onClose}>
      <div className="stack">
        <SpellNames id="spl-names" />
        <ErrorBox error={act.error} />
        <Field label="Spell learned"><input list="spl-names" value={f.result} onChange={(e) => set('result', e.target.value)} placeholder="Scorching Ray" /></Field>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Spells the character must know (1 to 5)</legend>
          {f.prereqs.map((p: string, i: number) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input list="spl-names" aria-label={`Prerequisite ${i + 1}`} value={p} onChange={(e) => set('prereqs', f.prereqs.map((x: string, j: number) => (j === i ? e.target.value : x)))} style={{ flex: 1 }} />
              {f.prereqs.length > 1 && <button type="button" className="btn small ghost" aria-label={`Remove prerequisite ${i + 1}`} onClick={() => set('prereqs', f.prereqs.filter((_: string, j: number) => j !== i))}>✕</button>}
            </div>
          ))}
          {f.prereqs.length < 5 && <button type="button" className="btn small" onClick={() => set('prereqs', [...f.prereqs, ''])}>Add a prerequisite</button>}
        </fieldset>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Items needed (matched by name in the character's pack)</legend>
          {f.items.map((it: any, i: number) => (
            <div key={i} className="row" style={{ gap: 6 }}>
              <input aria-label={`Item ${i + 1}`} value={it.name} onChange={(e) => set('items', f.items.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Ruby dust" style={{ flex: 1 }} />
              <input type="number" min={1} max={99} aria-label={`Quantity of item ${i + 1}`} value={it.qty} onChange={(e) => set('items', f.items.map((x: any, j: number) => (j === i ? { ...x, qty: e.target.value } : x)))} style={{ width: 64 }} />
              <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={it.consumed} onChange={(e) => set('items', f.items.map((x: any, j: number) => (j === i ? { ...x, consumed: e.target.checked } : x)))} /> used up</label>
              <button type="button" className="btn small ghost" aria-label={`Remove item ${i + 1}`} onClick={() => set('items', f.items.filter((_: any, j: number) => j !== i))}>✕</button>
            </div>
          ))}
          {f.items.length < 5 && <button type="button" className="btn small" onClick={() => set('items', [...f.items, { name: '', qty: 1, consumed: false }])}>Add an item</button>}
        </fieldset>
        <div>
          <span className="label">Minimum ability scores</span>
          <div className="spl-abil">
            {ABILITIES.map(([k, l]) => <label key={k} className="field"><span className="tiny">{l}</span><input type="number" min={1} max={30} aria-label={`Minimum ${l}`} value={f.stats[k] ?? ''} onChange={(e) => set('stats', { ...f.stats, [k]: e.target.value })} /></label>)}
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <Field label="Minimum level"><input type="number" min={1} max={20} value={f.minLevel} onChange={(e) => set('minLevel', e.target.value)} style={{ width: 90 }} /></Field>
          <Field label="Mana to learn"><input type="number" min={0} value={f.manaCost} onChange={(e) => set('manaCost', e.target.value)} style={{ width: 90 }} /></Field>
          <Field label="Players see it"><select value={f.visibility} onChange={(e) => set('visibility', e.target.value)}><option value="visible">Yes</option><option value="hidden">No (??? or nothing, per the world setting)</option></select></Field>
        </div>
        <Field label="GM notes (never shown to players)"><textarea rows={2} value={f.gmNotes} onChange={(e) => set('gmNotes', e.target.value)} /></Field>
        <div className="row end"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save recipe</button></div>
      </div>
    </Modal>
  );
}

function RecipeIO({ onClose }: { onClose: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [text, setText] = useState('');
  const [replace, setReplace] = useState(false);
  const [done, setDone] = useState<any>(null);
  const exportAll = () => act.run(async () => {
    const data = await w.call('GET', '/spells/recipes/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = 'spell-recipes.json';
    a.click();
  });
  return (
    <Modal title="Import or export recipes" onClose={onClose}>
      <div className="stack">
        <ErrorBox error={act.error} />
        <button type="button" className="btn" disabled={act.busy} onClick={() => void exportAll()}>Export every recipe (JSON)</button>
        <p className="tiny muted">Import: a list like {'[{"result": "Scorching Ray", "prereqs": ["Fire Bolt", "Burning Hands"], "stats": {"int": 13}, "items": [{"name": "Ruby dust", "qty": 1, "consumed": true}]}]'}. Spells by name; the same recipe twice is skipped.</p>
        <input type="file" accept=".json,application/json" aria-label="Recipe file" onChange={(e) => void e.target.files?.[0]?.text().then(setText)} />
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Recipes (JSON)" />
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace every recipe in this world</label>
        <div className="row end"><button type="button" className="btn primary" disabled={act.busy || !text.trim()} onClick={() => void act.run(async () => setDone(await w.call('POST', '/spells/recipes/import', { json: text, replace })))}>Import recipes</button></div>
        {done && <div className="note" role="status">Added {done.added}. {done.skipped.length ? `Skipped: ${done.skipped.slice(0, 6).join('; ')}` : ''}</div>}
      </div>
    </Modal>
  );
}

// ---- requests ---------------------------------------------------------------------------------------------

function RequestsTab() {
  const { w, nameOf } = useWorld();
  const list = useLoad<any>(() => w.call('GET', '/spells/learn'), [w], ['spells-learn']);
  const act = useAction();
  const [force, setForce] = useState<string | null>(null);
  const decide = (id: string, what: 'approve' | 'reject', body: any = {}) => act.run(async () => {
    try { await w.call('POST', `/spells/learn/${id}/${what}`, body); setForce(null); } catch (e: any) { if (what === 'approve' && /Not ready/.test(e.message)) setForce(id); throw e; }
    await list.reload();
  });
  const rows: any[] = list.data?.requests ?? [];
  return (
    <div className="stack">
      <ErrorBox error={list.error ?? act.error} />
      {rows.length === 0 ? <Empty>No requests to learn a spell yet.</Empty> : rows.map((x) => (
        <div key={x.id} className="card row between" aria-label={`Request from ${nameOf(x.accountId)} for ${x.spell}`}>
          <div className="stack tight">
            <strong>{nameOf(x.accountId)} wants to learn {x.spell}</strong>
            <span className="tiny muted">{new Date(x.at).toLocaleString()}{x.note ? ` · “${x.note}”` : ''} · {x.status}{x.consumed?.length ? ` · used ${x.consumed.map((c: any) => `${c.qty} × ${c.name}`).join(', ')}` : ''}{x.reason ? ` · ${x.reason}` : ''}</span>
          </div>
          {x.status === 'pending' && (
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void decide(x.id, 'approve')}>Approve</button>
              {force === x.id && <button type="button" className="btn small" disabled={act.busy} onClick={() => void decide(x.id, 'approve', { force: true })}>Approve anyway</button>}
              <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => { const reason = prompt('Why not? (the player sees this)') ?? ''; void decide(x.id, 'reject', { reason }); }}>Reject</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
