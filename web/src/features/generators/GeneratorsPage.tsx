// DM page: the Generators hub. Pick a category and a preset, set a few options,
// then Generate, Reroll (a new seed, locked fields kept), lock what you like,
// and Save, Send to table or Copy. Everything is made by the server from tables
// and code; a chat model, when set, can improve the wording. Nothing reaches
// players until the DM saves at party level or sends it to the table.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Field, Loading, Markdown, PageHead, Tabs, VisibilityPicker, useAction, useToast } from '../../ui/index.tsx';
import { useLoad, useWorld } from '../../lib/world.tsx';
import './generators.css';

type Cat = 'npc' | 'monster' | 'map' | 'tavern' | 'names' | 'library';
const CATS: [Cat, string][] = [['npc', 'NPCs'], ['monster', 'Monsters'], ['map', 'Maps'], ['tavern', 'Taverns'], ['names', 'Names'], ['library', 'Libraries']];
const KIND_OF: Record<Exclude<Cat, 'library'>, string> = { npc: 'npc', monster: 'monster', map: 'map', tavern: 'tavern', names: 'names' };

interface Entry { id: string; label: string; blurb: string }
const ENTRIES: Record<Exclude<Cat, 'library'>, Entry[]> = {
  npc: [
    { id: 'tavern-keeper', label: 'Tavern keeper', blurb: 'Behind the bar, hears everything.' }, { id: 'villain', label: 'Villain', blurb: 'A plan, a mask and a weakness.' },
    { id: 'shopkeeper', label: 'Shopkeeper / merchant', blurb: 'Has a price for everything.' }, { id: 'noble', label: 'Noble', blurb: 'Titles, debts and a secret.' },
    { id: 'wizard', label: 'Wizard', blurb: 'Scorched cuffs, odd requests.' }, { id: 'rogue', label: 'Rogue', blurb: 'Quick hands, quicker excuses.' },
    { id: 'cleric', label: 'Cleric / priest', blurb: 'Faith, doubt and a ledger.' }, { id: 'quest-giver', label: 'Quest giver', blurb: 'Needs help, tells half of it.' },
    { id: 'town-guard', label: 'Town guard', blurb: 'The law, as far as it goes.' }, { id: 'dwarf', label: 'Dwarf', blurb: 'Stone, beer and long grudges.' },
    { id: 'elf', label: 'Elf', blurb: 'Old eyes, longer memory.' }, { id: 'random', label: 'Random', blurb: 'Anyone at all.' },
  ],
  monster: [
    { id: 'dragon', label: 'Dragon', blurb: 'Breath weapon, wings, pride.' }, { id: 'undead', label: 'Undead', blurb: 'Drains, chills and returns.' },
    { id: 'demon', label: 'Demon / fiend', blurb: 'Bargains and hellfire.' }, { id: 'aberration', label: 'Aberration', blurb: 'Wrong in every way.' },
    { id: 'beast', label: 'Beast', blurb: 'Tooth, claw, hunger.' }, { id: 'construct', label: 'Construct', blurb: 'Follows orders to the letter.' },
    { id: 'elemental', label: 'Elemental', blurb: 'A storm with an opinion.' }, { id: 'fey', label: 'Fey', blurb: 'Charm, trick, vanish.' },
    { id: 'boss', label: 'Boss / legendary', blurb: 'Legendary actions and a lair.' }, { id: 'low-cr', label: 'Low CR (1/8 to 4)', blurb: 'Quick fights.' },
    { id: 'random', label: 'Random', blurb: 'Whatever turns up.' }, { id: 'homebrew', label: 'Homebrew', blurb: 'From a sentence of concept.' },
  ],
  map: [
    { id: 'dungeon', label: 'Dungeon', blurb: 'Rooms, corridors, doors, secrets.' }, { id: 'cave', label: 'Cave', blurb: 'Winding caverns and pools.' },
    { id: 'castle', label: 'Castle / keep', blurb: 'Walls, towers, courtyard, keep.' }, { id: 'tavern', label: 'Tavern floor plan', blurb: 'Bar, tables, rooms upstairs.' },
    { id: 'battlemap', label: 'Battlemap', blurb: 'A 5 ft grid with terrain.' }, { id: 'city', label: 'City / town', blurb: 'Streets, districts, landmarks.' },
    { id: 'region', label: 'World / region', blurb: 'Land, sea, rivers, towns.' }, { id: 'forest', label: 'Forest & wilderness', blurb: 'Clearings and paths.' },
  ],
  tavern: [
    { id: 'common', label: 'Common', blurb: 'A warm, ordinary house.' }, { id: 'dwarven', label: 'Dwarven', blurb: 'Stone halls and stout.' },
    { id: 'elven', label: 'Elven', blurb: 'A tree-hall of lanterns.' }, { id: 'pirate', label: 'Pirate', blurb: 'Rum, rope and bad ideas.' },
    { id: 'haunted', label: 'Haunted', blurb: 'The cold chair, the slow clock.' },
  ],
  names: [
    { id: 'person', label: 'People', blurb: 'By race and gender.' }, { id: 'dark', label: 'Dark fantasy people', blurb: 'Grimmer names, every race.' },
    { id: 'tavern', label: 'Taverns', blurb: 'The Gilded Anchor and kin.' }, { id: 'inn', label: 'Inns', blurb: 'Rooms for the night.' },
    { id: 'town', label: 'Towns', blurb: 'Places on the map.' }, { id: 'guild', label: 'Guilds', blurb: 'Orders and companies.' },
    { id: 'magic shop', label: 'Magic shops', blurb: 'Curios and cabinets.' },
  ],
};

interface Options {
  npc: { presets: string[]; races: string[]; genders: string[]; nameStyles: string[] };
  monster: { types: string[]; crs: { value: number; label: string }[]; bestiary: number };
  tavern: { sizes: string[] };
  map: { kinds: string[]; sizes: string[]; dungeon: string[]; tavern: string[]; battlemap: string[]; forest: string[] };
  names: { kinds: string[]; flavours: string[]; styles: string[]; races: string[]; genders: string[] };
  model: boolean; coins: string; partyLevel: number; world: { places: number; factions: number };
}
interface Section { key: string; label: string; text: string; dm?: boolean }
interface MapKey { n: string; name: string; text: string; dm?: string }
interface Result {
  kind: string; preset: string; seed: string; title: string; subtitle: string; fields: Record<string, string>; lockable: string[]; sections: Section[];
  statblock?: any; statblockMd?: string; tie?: { id: string; title: string; kind: string } | null; names?: string[]; enriched: boolean; notes: string[]; attribution?: string;
  md: string; publicText: string;
  map?: { kind: string; size: string; flavour: string; title: string; seed: string; key: MapKey[]; legend: string[]; stats: Record<string, any>; svg: string; width: number; height: number };
}

const newSeed = () => Math.random().toString(36).slice(2, 8);
const copy = (t: string) => { try { void navigator.clipboard?.writeText(t); } catch { /* not allowed */ } };

export default function GeneratorsPage() {
  const { w } = useWorld();
  const [params, setParams] = useSearchParams();
  const cat = (params.get('cat') as Cat | null) ?? 'npc';
  const entry = params.get('entry');
  const opts = useLoad<Options>(() => w.call('GET', '/generators/options'), [w]);
  const go = (c: Cat, e?: string) => { const p = new URLSearchParams(); p.set('cat', c); if (e) p.set('entry', e); setParams(p); };
  const e = cat !== 'library' ? ENTRIES[cat]?.find((x) => x.id === entry) : undefined;

  return (
    <div className="page wide gen">
      <PageHead title="Generators" lead="NPCs, monsters, maps, taverns and names, made to fit this world. They work without a model; nothing reaches the players until you save it at party level or send it to the table.">
        {e && <button type="button" className="btn small ghost" onClick={() => go(cat)}>All {CATS.find(([k]) => k === cat)?.[1]}</button>}
      </PageHead>
      <Tabs value={cat} onChange={(c) => go(c)} label="Generator categories" items={CATS.map(([k, t]) => [k, t])} />
      <ErrorBox error={opts.error} />
      {!opts.data ? <Loading /> : cat === 'library' ? <Libraries opts={opts.data} onOpen={go} />
        : e ? <Workshop key={`${cat}:${e.id}`} cat={cat} entry={e} opts={opts.data} />
        : <Hub cat={cat} opts={opts.data} onPick={(id) => go(cat, id)} />}
    </div>
  );
}

function Hub({ cat, opts, onPick }: { cat: Exclude<Cat, 'library'>; opts: Options; onPick: (id: string) => void }) {
  return (
    <>
      <p className="tiny muted">
        {opts.model ? 'A chat model is set: you can ask it to improve the wording of any result.' : 'No chat model needed: every field is filled from tables.'}
        {' '}This world has {opts.world.places} place{opts.world.places === 1 ? '' : 's'} and {opts.world.factions} faction{opts.world.factions === 1 ? '' : 's'} an NPC can be tied to.
      </p>
      <div className="gen-cards">
        {ENTRIES[cat].map((x) => (
          <button key={x.id} type="button" className="card gen-card" onClick={() => onPick(x.id)}>
            <strong>{x.label}</strong><span className="tiny muted">{x.blurb}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---- one generator at work -------------------------------------------------

function Sel({ label, value, onChange, items, help }: { label: string; value: string; onChange: (v: string) => void; items: [string, string][]; help?: string }) {
  return (
    <Field label={label} help={help}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>{items.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
    </Field>
  );
}
const pairs = (a: string[], first?: [string, string]): [string, string][] => [...(first ? [first] : []), ...a.map((x) => [x, x[0].toUpperCase() + x.slice(1)] as [string, string])];

function Workshop({ cat, entry, opts }: { cat: Exclude<Cat, 'library'>; entry: Entry; opts: Options }) {
  const { w, info } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const kind = KIND_OF[cat];
  const [params] = useSearchParams();
  const [seed, setSeed] = useState(() => params.get('seed') || newSeed());
  const [o, setO] = useState<Record<string, any>>(() => ({ size: 'medium', race: 'any', gender: 'any', nameKind: entry.id === 'dark' ? 'person' : cat === 'names' ? entry.id : 'person', style: entry.id === 'dark' ? 'dark' : 'default', count: 12, level: opts.partyLevel, partySize: 4, cr: '', type: '', concept: '', statblock: false, flavour: '', theme: '', useParty: false }));
  const [locks, setLocks] = useState<Set<string>>(new Set());
  const [res, setRes] = useState<Result | null>(null);
  const [enrich, setEnrich] = useState(false);
  const [level, setLevel] = useState<'dm' | 'party'>('dm');
  const [show, setShow] = useState(false);
  const [saved, setSaved] = useState<{ id: string; path: string; title: string; level: string } | null>(null);
  const set = (p: Record<string, any>) => setO((x) => ({ ...x, ...p }));

  const preset = cat === 'names' ? undefined : entry.id;
  const body = (sd: string, lockKeys: Set<string>, allFields = false) => {
    const options: Record<string, any> = { size: o.size };
    if (cat === 'npc') Object.assign(options, { race: o.race === 'any' ? '' : o.race, gender: o.gender === 'any' ? '' : o.gender, statblock: o.statblock, cr: o.cr, partyLevel: o.level, nameStyle: o.style === 'dark' ? 'dark' : '' });
    if (cat === 'monster') Object.assign(options, { type: o.type, cr: o.cr, partyLevel: o.useParty ? o.level : '', partySize: o.partySize, concept: o.concept });
    if (cat === 'map') Object.assign(options, { flavour: o.flavour, theme: o.theme });
    if (cat === 'names') Object.assign(options, { nameKind: o.nameKind, race: o.race === 'any' ? '' : o.race, gender: o.gender === 'any' ? '' : o.gender, style: o.style === 'default' ? '' : o.style, flavour: o.flavour, count: o.count });
    const lk: Record<string, string> = {};
    if (res) for (const k of res.lockable) if ((allFields || lockKeys.has(k)) && res.fields[k]) lk[k] = res.fields[k];
    return { kind, preset, seed: sd, options, locks: lk, enrich };
  };

  const generate = (sd: string, keep: Set<string>) => act.run(async () => {
    const r = await w.call<Result>('POST', '/generators/generate', body(sd, keep));
    setRes(r); setSeed(r.seed); setSaved(null);
  });
  // Opening a generator makes the first result.
  const first = useRef(false);
  useEffect(() => { if (first.current) return; first.current = true; void generate(seed, new Set()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k: string) => setLocks((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const save = () => act.run(async () => {
    const r = await w.call<any>('POST', '/generators/save', { ...body(res!.seed, locks, true), level });
    setSaved({ ...r.page, level: r.page.level }); toast(`Saved “${r.page.title}” as ${r.page.level === 'party' ? 'a party page' : 'a DM-only page'}`);
    return r;
  });
  const stage = () => act.run(async () => { await w.call('POST', '/generators/stage', { ...body(res!.seed, locks, true), show }); toast(show ? 'Shown to the table' : 'Staged: it is on the stage, not shown yet'); });
  const toCombat = () => act.run(async () => {
    let id = saved?.level === 'dm' ? saved.id : '';
    if (!id) { const r = await w.call<any>('POST', '/generators/save', { ...body(res!.seed, locks, true), level: 'dm' }); id = r.page.id; setSaved({ ...r.page, level: 'dm' }); }
    const c = await w.call<any>('POST', `/agent/statblock/${encodeURIComponent(id)}/combat`, {});
    toast(`${c.combatant?.name ?? 'Added'} is in combat (HP ${c.combatant?.hp ?? '?'}, AC ${c.combatant?.ac ?? '?'})`);
  });

  const lockBtn = (k: string, label = '') => res?.lockable.includes(k) ? (
    <button type="button" className={`btn small ghost gen-lock${locks.has(k) ? ' on' : ''}`} aria-pressed={locks.has(k)} onClick={() => toggle(k)} title={locks.has(k) ? 'Locked: Reroll keeps this' : 'Lock this so Reroll keeps it'}>{locks.has(k) ? 'Locked' : 'Lock'}{label}</button>
  ) : null;

  return (
    <div className="gen-work">
      <section className="card gen-opts" aria-label="Options">
        <h2 className="gen-h">{entry.label}</h2>
        <div className="gen-form">
          {cat === 'npc' && <>
            <Sel label="Race" value={o.race} onChange={(v) => set({ race: v })} items={pairs(opts.npc.races, ['any', 'Any'])} />
            <Sel label="Gender" value={o.gender} onChange={(v) => set({ gender: v })} items={pairs(opts.npc.genders, ['any', 'Any'])} />
            <Sel label="Name style" value={o.style} onChange={(v) => set({ style: v })} items={[['default', 'Default'], ['dark', 'Dark fantasy']]} />
            <label className="gen-check"><input type="checkbox" checked={o.statblock} onChange={(e) => set({ statblock: e.target.checked })} /> Include a quick statblock</label>
            {o.statblock && <Sel label="CR" value={String(o.cr)} onChange={(v) => set({ cr: v })} items={[['', 'By role'], ...opts.monster.crs.slice(0, 14).map((c) => [String(c.value), c.label] as [string, string])]} />}
          </>}
          {cat === 'monster' && <>
            {['random', 'boss', 'low-cr', 'homebrew'].includes(entry.id) && <Sel label="Type" value={o.type} onChange={(v) => set({ type: v })} items={[['', entry.id === 'homebrew' ? 'From the concept' : 'Any'], ...opts.monster.types.map((t) => [t, t[0].toUpperCase() + t.slice(1)] as [string, string])]} />}
            {entry.id === 'homebrew' && <Field label="Concept" help="A sentence: what it is, where it lives, what it does."><textarea rows={3} value={o.concept} onChange={(e) => set({ concept: e.target.value })} placeholder="A fire-breathing spider that lurks in webs" /></Field>}
            <Sel label="Target CR" value={String(o.cr)} onChange={(v) => set({ cr: v })} items={[['', o.useParty ? 'From party level' : 'Random for the preset'], ...opts.monster.crs.map((c) => [String(c.value), c.label] as [string, string])]} />
            <label className="gen-check"><input type="checkbox" checked={o.useParty} onChange={(e) => set({ useParty: e.target.checked })} /> Fit to the party</label>
            {o.useParty && <div className="row"><Field label="Party level"><input type="number" min={1} max={20} value={o.level} onChange={(e) => set({ level: Number(e.target.value) })} style={{ width: 80 }} /></Field><Field label="Party size"><input type="number" min={1} max={10} value={o.partySize} onChange={(e) => set({ partySize: Number(e.target.value) })} style={{ width: 80 }} /></Field></div>}
          </>}
          {cat === 'tavern' && <Sel label="Size" value={o.size} onChange={(v) => set({ size: v })} items={pairs(opts.tavern.sizes)} />}
          {cat === 'map' && <>
            <Sel label="Size" value={o.size} onChange={(v) => set({ size: v })} items={pairs(opts.map.sizes)} />
            {entry.id === 'dungeon' && <Sel label="Style" value={o.flavour} onChange={(v) => set({ flavour: v })} items={[['', 'Ruin'], ...opts.map.dungeon.map((x) => [x, x[0].toUpperCase() + x.slice(1)] as [string, string])]} />}
            {entry.id === 'tavern' && <Sel label="Style" value={o.flavour} onChange={(v) => set({ flavour: v })} items={pairs(opts.map.tavern)} />}
            {entry.id === 'battlemap' && <Sel label="Terrain" value={o.theme} onChange={(v) => set({ theme: v })} items={[['', 'Forest'], ...opts.map.battlemap.map((x) => [x, x[0].toUpperCase() + x.slice(1)] as [string, string])]} />}
            {entry.id === 'forest' && <Sel label="Terrain" value={o.theme} onChange={(v) => set({ theme: v })} items={[['', 'Forest'], ...opts.map.forest.map((x) => [x, x[0].toUpperCase() + x.slice(1)] as [string, string])]} />}
          </>}
          {cat === 'names' && <>
            <Sel label="What to name" value={o.nameKind} onChange={(v) => set({ nameKind: v })} items={opts.names.kinds.map((k) => [k, k[0].toUpperCase() + k.slice(1)] as [string, string])} />
            {o.nameKind === 'person' ? <>
              <Sel label="Race" value={o.race} onChange={(v) => set({ race: v })} items={pairs(opts.names.races, ['any', 'Any'])} />
              <Sel label="Gender" value={o.gender} onChange={(v) => set({ gender: v })} items={pairs(opts.names.genders, ['any', 'Any'])} />
              <Sel label="Style" value={o.style} onChange={(v) => set({ style: v })} items={opts.names.styles.map((s) => [s, s[0].toUpperCase() + s.slice(1)] as [string, string])} />
            </> : <Sel label="Flavour" value={o.flavour || 'common'} onChange={(v) => set({ flavour: v })} items={pairs(opts.names.flavours)} />}
            <Field label="How many"><input type="number" min={1} max={60} value={o.count} onChange={(e) => set({ count: Number(e.target.value) })} style={{ width: 80 }} /></Field>
          </>}
          {opts.model && cat !== 'names' && <label className="gen-check"><input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} /> Improve the wording with the chat model (slower)</label>}
          <Field label="Seed" help="The same seed and options give the same result."><input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} spellCheck={false} /></Field>
        </div>
        <div className="row">
          <button type="button" className="btn primary" disabled={act.busy} onClick={() => void generate(seed.trim() || newSeed(), locks)}>Generate</button>
          <button type="button" className="btn" disabled={act.busy} onClick={() => void generate(newSeed(), locks)}>Reroll{locks.size ? ` (keep ${locks.size} locked)` : ''}</button>
          {locks.size > 0 && <button type="button" className="btn small ghost" onClick={() => setLocks(new Set())}>Unlock all</button>}
        </div>
        <ErrorBox error={act.error} />
      </section>

      <section className="gen-result" aria-label="Result" aria-live="polite">
        {!res ? <Loading what="a result" /> : (
          <div className="stack loose">
            <div className="card gen-head">
              <div className="row between">
                <div className="stack tight"><h2 className="gen-h" data-testid="gen-title">{res.title}</h2><span className="muted">{res.subtitle}</span></div>
                <div className="row">{lockBtn('name', ' name')}{lockBtn('race', ' race')}</div>
              </div>
              {res.enriched && <span className="chip teal">Wording improved by the chat model</span>}
              {res.attribution && <span className="tiny muted">{res.attribution}</span>}
              {res.notes.map((n, i) => <span key={i} className="tiny muted">{n}</span>)}
            </div>

            {res.map && <MapView map={res.map} />}
            {res.names && <div className="card"><ul className="gen-names">{res.names.map((n) => <li key={n}>{n}</li>)}</ul></div>}

            {res.sections.filter((s) => s.key !== 'statblock' && !(res.names && s.key === 'names') && !(res.map && (s.key === 'key' || s.key === 'legend'))).map((s) => (
              <div key={s.key} className={`card gen-sec${s.dm ? ' gen-dm' : ''}`}>
                <div className="row between"><h3 className="gen-h3">{s.label}{s.dm && <span className="chip red gen-chip">DM only</span>}</h3>{lockBtn(s.key)}</div>
                <Markdown text={s.text} />
              </div>
            ))}
            {res.statblockMd && <div className="card gen-dm gen-stat"><h3 className="gen-h3">Statblock <span className="chip red gen-chip">DM only</span></h3><Markdown text={res.statblockMd} /></div>}

            <section className="card gen-actions" aria-label="Use this result">
              <div className="row">
                <button type="button" className="btn" disabled={act.busy} onClick={() => copy(res.md)}>Copy</button>
                {res.statblock && <button type="button" className="btn" disabled={act.busy} onClick={() => void toCombat()}>Add to combat</button>}
              </div>
              <div className="stack tight">
                <span className="label">Save to the library</span>
                <div className="row">
                  <VisibilityPicker value={level} onChange={setLevel} options={['dm', 'party']} labels={{ dm: 'DM only', party: 'Party can see it' }} />
                  <button type="button" className="btn primary" disabled={act.busy} onClick={() => void save()}>Save</button>
                </div>
                {level === 'party' && <span className="tiny muted">Players will see the public parts only. Secrets, hooks and the statblock stay in DM-only blocks. {res.map ? 'The map picture will have no secret doors or traps.' : ''}</span>}
                {saved && <span className="tiny" role="status">Saved <Link to={`../library?page=${encodeURIComponent(saved.id)}`}>{saved.path}</Link>{res.map ? ' with its map picture (the Map page can use it).' : '.'}</span>}
              </div>
              <div className="stack tight">
                <span className="label">Send to table</span>
                <div className="row">
                  <label className="gen-check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show it to the players now</label>
                  <button type="button" className="btn" disabled={act.busy} onClick={() => void stage()}>{show ? 'Show on the stage' : 'Stage a card'}</button>
                </div>
                <span className="tiny muted">Players only get the public text{res.map ? ' and the map picture without the DM marks' : ''}. <Link to="../stage">Open the stage</Link></span>
              </div>
            </section>
          </div>
        )}
      </section>
      {toastNode}
      <span className="sr-only">{info.name}</span>
    </div>
  );
}

function MapView({ map }: { map: NonNullable<Result['map']> }) {
  const svg: string = map.svg;
  const url = useMemo(() => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), [svg]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [zoom, setZoom] = useState(false);
  return (
    <div className="card gen-mapcard">
      <div className="row between">
        <span className="tiny muted">{map.kind}, {map.size} · seed {map.seed} · secret doors, traps and hazards show in this DM view only</span>
        <button type="button" className="btn small" aria-pressed={zoom} onClick={() => setZoom((z) => !z)}>{zoom ? 'Fit to screen' : 'Full size'}</button>
      </div>
      <div className={`gen-map${zoom ? ' zoom' : ''}`}><img src={url} alt={`${map.title} map`} width={map.width} height={map.height} /></div>
      <div className="gen-legend">{map.legend.map((l: string) => <span key={l} className="chip">{l}</span>)}</div>
      <h3 className="gen-h3">Key</h3>
      <ol className="gen-key">
        {map.key.map((k: MapKey) => (
          <li key={k.n}><strong><span className="gen-n">{k.n}</span> {k.name}.</strong> <span>{k.text}</span>{k.dm && <span className="gen-dmnote"> DM: {k.dm}</span>}</li>
        ))}
      </ol>
    </div>
  );
}

// ---- libraries: the bestiary and "my generated" -------------------------------

function Libraries({ opts, onOpen }: { opts: Options; onOpen: (c: Cat, e?: string) => void }) {
  const [tab, setTab] = useState<'bestiary' | 'mine'>('bestiary');
  return (
    <div className="stack loose">
      <Tabs value={tab} onChange={setTab} label="Libraries" items={[['bestiary', 'Bestiary'], ['mine', 'My generated']]} />
      {tab === 'bestiary' ? <Bestiary opts={opts} onOpen={onOpen} /> : <Mine />}
    </div>
  );
}

function Bestiary({ opts, onOpen }: { opts: Options; onOpen: (c: Cat, e?: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [lo, setLo] = useState('');
  const [hi, setHi] = useState('');
  const [limit, setLimit] = useState(40);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const qs = `q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&crMin=${lo}&crMax=${hi}&limit=${limit}`;
  const list = useLoad<{ total: number; monsters: any[]; types: string[]; modules: { id: string; name: string; attribution: string }[] }>(() => w.call('GET', `/generators/bestiary?${qs}`), [w, q, type, lo, hi, limit]);
  const view = (id: string) => act.run(async () => {
    if (open === id) { setOpen(null); return; }
    if (!text[id]) { const t = await w.call<any>('GET', `/modules/terms/${encodeURIComponent(id)}`); setText((x) => ({ ...x, [id]: t.text })); }
    setOpen(id);
  });
  const add = (id: string) => act.run(async () => {
    const r = await w.call<any>('POST', '/agent/statblock', { moduleTermId: id, addToCombat: true });
    toast(`${r.statblock.name} is in combat (HP ${r.statblock.hp}, AC ${r.statblock.ac})`);
  });
  const crs = opts.monster.crs;
  return (
    <div className="stack">
      <div className="gen-filters">
        <Field label="Search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="goblin, wyrm…" /></Field>
        <Sel label="Type" value={type} onChange={setType} items={[['', 'Any type'], ...(list.data?.types ?? []).map((t) => [t, t[0].toUpperCase() + t.slice(1)] as [string, string])]} />
        <Sel label="CR from" value={lo} onChange={setLo} items={[['', 'Any'], ...crs.map((c) => [String(c.value), c.label] as [string, string])]} />
        <Sel label="CR to" value={hi} onChange={setHi} items={[['', 'Any'], ...crs.map((c) => [String(c.value), c.label] as [string, string])]} />
      </div>
      <ErrorBox error={list.error ?? act.error} />
      {!list.data ? <Loading /> : list.data.monsters.length === 0 ? <Empty>No monsters match. {opts.monster.bestiary === 0 ? 'Import a game module under Rules to fill the bestiary.' : 'Try fewer filters.'}</Empty> : (
        <ul className="gen-bestiary">
          {list.data.monsters.map((m) => (
            <li key={m.id} className="card">
              <div className="row between">
                <div className="stack tight"><strong>{m.name}</strong><span className="tiny muted">{m.size} {m.type} · CR {m.crLabel} · AC {m.ac ?? '?'} · HP {m.hp ?? '?'} · {m.module}</span></div>
                <div className="row">
                  <button type="button" className="btn small" aria-expanded={open === m.id} disabled={act.busy} onClick={() => void view(m.id)}>{open === m.id ? 'Hide' : 'Statblock'}</button>
                  <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void add(m.id)}>Add to combat</button>
                  <button type="button" className="btn small ghost" onClick={() => onOpen('monster', 'random')}>Make a variant</button>
                </div>
              </div>
              {open === m.id && text[m.id] && <div className="gen-stat"><Markdown text={text[m.id]} /></div>}
            </li>
          ))}
        </ul>
      )}
      {list.data && list.data.total > list.data.monsters.length && <button type="button" className="btn" onClick={() => setLimit((l) => l + 40)}>Show more ({list.data.total - list.data.monsters.length} left)</button>}
      {list.data?.modules.map((m) => <p key={m.id} className="tiny muted">{m.attribution}</p>)}
      {toastNode}
    </div>
  );
}

function Mine() {
  const { w } = useWorld();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const list = useLoad<{ total: number; pages: { id: string; path: string; title: string; kind: string; preset: string; level: string }[] }>(() => w.call('GET', `/generators/library?q=${encodeURIComponent(q)}&kind=${kind}`), [w, q, kind], ['page']);
  return (
    <div className="stack">
      <div className="gen-filters">
        <Field label="Search saved results"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, place, preset…" /></Field>
        <Sel label="Kind" value={kind} onChange={setKind} items={[['', 'All'], ['npc', 'NPCs'], ['monster', 'Monsters'], ['tavern', 'Taverns'], ['map', 'Maps'], ['names', 'Names']]} />
      </div>
      <ErrorBox error={list.error} />
      {!list.data ? <Loading /> : list.data.pages.length === 0 ? <Empty>Nothing saved yet. Generate something and press Save.</Empty> : (
        <ul className="gen-bestiary">
          {list.data.pages.map((p) => (
            <li key={p.id} className="card row between">
              <div className="stack tight"><Link to={`../library?page=${encodeURIComponent(p.id)}`}><strong>{p.title}</strong></Link><span className="tiny muted">{p.kind}{p.preset ? ` · ${p.preset}` : ''} · {p.path}</span></div>
              <span className={`chip ${p.level === 'party' ? 'teal' : 'red'}`}>{p.level === 'party' ? 'Party' : 'DM only'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
