// Mini-mods: the Game Master's homebrew rules. Start with a name and the rule; then pick where it shows up (the
// House rules page and the assistants always; a roll button on the sheet's Mini-mods module, a home page card, a
// chat word) with a live preview of what players see, and ask the assistant to suggest extras. A mini-mod is an
// ordinary house rule underneath, so it exports and shares like any other. See docs/MODS.md.
import { useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Switch, useAction, useToast } from '../../ui/index.tsx';
import { useHouseRules, type HomebrewForm, type HouseRule, type RollMode, type SheetRoll } from './shared.tsx';

type Roll = NonNullable<HomebrewForm['roll']>;
interface Suggestions { source: 'model' | 'rules'; roll: (Roll & { why: string }) | null; gm: { text: string; why: string } | null; words: { list: string[]; why: string } | null }

const MODES: [RollMode, string][] = [['disadvantage', 'at disadvantage'], ['advantage', 'with advantage'], ['normal', 'a plain d20']];
const EMPTY: HomebrewForm = { name: '', text: '', gm: '', words: [], roll: null };
const STARTERS: [string, string][] = [
  ['Bonus action strike', 'You can make one weapon attack with your bonus action, at disadvantage. You don\'t add your ability modifier to its damage.'],
  ['Quick potions', 'Drinking a potion yourself is a bonus action. Giving one to someone else is still an action.'],
  ['Climbing foes', 'You can climb onto a creature two sizes larger than you with an Athletics or Acrobatics check against its Athletics. While on it, you have advantage on attacks against it.'],
];
const diceText = (r: Roll | SheetRoll) => (r.mode === 'disadvantage' ? '2d20kl1' : r.mode === 'advantage' ? '2d20kh1' : '1d20');

/** The Game Master's Mini-mods tab: a new one in two fields, then each one's places, preview and suggested extras. */
export function HomebrewRules() {
  const { w, isDM } = useWorld();
  const { list, rules } = useHouseRules();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  if (!isDM) return null;
  const mine = list.filter((r) => r.homebrew && r.source === 'imported');
  const create = () => act.run(async () => {
    const out = await w.call<HouseRule>('POST', '/mods/homebrew', { name, text });
    setName(''); setText('');
    await rules.reload();
    setOpen(out.id);
    toast(`${out.name} is on. Choose where else it shows up below.`);
  });
  return (
    <div className="stack">
      <section className="card stack" aria-label="New mini-mod">
        <h3>New mini-mod</h3>
        <p className="tiny muted">A small change to the 5e rules at your table. Write it the way players should read it. Once it is saved you choose where it shows up, and the assistant can suggest what to add.</p>
        <div className="row tiny" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="muted">Start from:</span>
          {STARTERS.map(([n, t]) => <button key={n} type="button" className="btn small" onClick={() => { setName(n); setText(t); }}>{n}</button>)}
        </div>
        <label className="stack tight"><span className="small">Name</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Bonus action strike" />
        </label>
        <label className="stack tight"><span className="small">The rule</span>
          <textarea className="input" rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="You can make one weapon attack with your bonus action, at disadvantage." />
        </label>
        <div><button type="button" className="btn small primary" disabled={act.busy || !name.trim() || !text.trim()} onClick={() => void create()}>Save and turn on</button></div>
        <ErrorBox error={act.error} />
      </section>
      <section className="stack" aria-label="Your mini-mods">
        <h3 style={{ margin: 0 }}>Your mini-mods</h3>
        {mine.length === 0 ? <Empty>None yet. Make one above.</Empty> : mine.map((r) => (
          <MiniModCard key={r.id} r={r} open={open === r.id} onOpen={() => setOpen(open === r.id ? null : r.id)} onDone={(t) => { toast(t); void rules.reload(); }} />
        ))}
      </section>
      {toastNode}
    </div>
  );
}

function MiniModCard({ r, open, onOpen, onDone }: { r: HouseRule; open: boolean; onOpen: () => void; onDone: (t: string) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const base: HomebrewForm = r.form ?? { ...EMPTY, name: r.name, text: r.rules[0]?.text ?? '' };
  const [f, setF] = useState<HomebrewForm>(base);
  const [ideas, setIdeas] = useState<Suggestions | null>(null);
  const set = (p: Partial<HomebrewForm>) => setF({ ...f, ...p });
  const setRoll = (p: Partial<Roll>) => set({ roll: { ...f.roll!, ...p } });
  const changed = JSON.stringify(f) !== JSON.stringify(base);
  const save = (next = f, msg = `${f.name} saved`) => act.run(async () => {
    await w.call('POST', '/mods/homebrew', { id: r.id, ...next, words: next.words.map((x) => x.trim()).filter(Boolean) });
    onDone(msg);
  });
  const suggest = () => act.run(async () => setIdeas(await w.call<Suggestions>('POST', `/mods/homebrew/${r.id}/suggest`)));
  const take = (p: Partial<HomebrewForm>, what: string) => { const next = { ...f, ...p }; setF(next); void save(next, `${what} added to ${f.name}`); };
  const toggle = (on: boolean) => act.run(async () => { await w.call('PUT', `/mods/${r.id}/enabled`, { on }); onDone(`${r.name} is ${on ? 'on' : 'off'}`); });
  const remove = () => act.run(async () => { if (!window.confirm(`Remove ${r.name} from this world?`)) return; await w.call('DELETE', `/mods/${r.id}`); onDone(`${r.name} removed`); });
  const places = f.roll?.places ?? [];
  const place = (p: 'sheet' | 'home', on: boolean) => setRoll({ places: on ? [...new Set([...places, p])] : places.filter((x) => x !== p) });
  const shows = ['House rules page', 'Assistants', ...(r.rolls[0]?.places.includes('sheet') ? ['Sheet'] : []), ...(r.rolls[0]?.places.includes('home') ? ['Home page'] : []), ...(r.rolls[0]?.word ? [`/${r.rolls[0].word}`] : [])];
  return (
    <section className="card stack" aria-label={`Mini-mod ${r.name}`}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost small" aria-expanded={open} onClick={onOpen} style={{ padding: 0 }}>
          <strong>{r.name}</strong> <span className="tiny muted">v{r.version} · shows in {shows.join(', ')}</span>
        </button>
        <Switch checked={r.enabled} label={`${r.name} on`} onChange={(v) => { if (!act.busy) void toggle(v); }} />
      </div>
      {!open && <div className="small">{r.rules[0]?.text}</div>}
      {open && (
        <div className="mm-edit" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <div className="stack tight">
            <label className="stack tight"><span className="small">Name</span><input className="input" value={f.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="stack tight"><span className="small">The rule</span><textarea className="input" rows={3} maxLength={4000} value={f.text} onChange={(e) => set({ text: e.target.value })} /></label>
            <h4 style={{ margin: '8px 0 0' }}>Shows up in</h4>
            <ul className="stack tight small" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              <li><i className="fa-solid fa-check" aria-hidden="true" /> The players’ House rules page <span className="tiny muted">(always)</span></li>
              <li><i className="fa-solid fa-check" aria-hidden="true" /> Minerva, Squire and the Broker, on every question <span className="tiny muted">(always)</span></li>
            </ul>
            <label className="row small" style={{ gap: 8 }}>
              <Switch label="A roll button" checked={!!f.roll} onChange={(v) => set({ roll: v ? { label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage', places: ['sheet'], word: '' } : null })} /> A roll button
            </label>
            {f.roll && (
              <div className="stack tight" style={{ paddingLeft: 12, borderLeft: '2px solid var(--line, #8883)' }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                  <label className="stack tight"><span className="tiny">Button</span><input className="input" value={f.roll.label} maxLength={40} onChange={(e) => setRoll({ label: e.target.value })} /></label>
                  <label className="stack tight"><span className="tiny">Roll</span>
                    <select className="input" value={f.roll.kind} onChange={(e) => setRoll({ kind: e.target.value as Roll['kind'] })}>
                      <option value="attack">A weapon attack</option><option value="d20">A check or save</option>
                    </select>
                  </label>
                  <label className="stack tight"><span className="tiny">Dice</span>
                    <select className="input" value={f.roll.mode} onChange={(e) => setRoll({ mode: e.target.value as RollMode })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  </label>
                </div>
                <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={places.includes('sheet')} onChange={(e) => place('sheet', e.target.checked)} /> On the player sheet (a Mini-mods module)</label>
                <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={places.includes('home')} onChange={(e) => place('home', e.target.checked)} /> On the player’s home page</label>
                <label className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>A chat word <span className="muted">/</span>
                  <input className="input" aria-label="Chat word" value={f.roll.word} maxLength={20} onChange={(e) => setRoll({ word: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })} placeholder="bastrike" style={{ width: 140 }} />
                </label>
              </div>
            )}
            <details open={!!f.gm}>
              <summary className="small">A note only Minerva sees</summary>
              <input className="input" value={f.gm} maxLength={600} onChange={(e) => set({ gm: e.target.value })} placeholder="Only with a light weapon." style={{ marginTop: 6 }} />
            </details>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn small primary" disabled={act.busy || !changed || !f.name.trim() || !f.text.trim()} onClick={() => void save()}>Save changes</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void suggest()}><i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /> Suggest extras</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void remove()}>Remove</button>
            </div>
            <ErrorBox error={act.error} />
            {ideas && <Ideas s={ideas} f={f} onTake={(p, what) => { take(p, what); setIdeas({ ...ideas, ...(p.roll ? { roll: null } : {}), ...(p.gm ? { gm: null } : {}), ...(p.words ? { words: null } : {}) }); }} />}
          </div>
          <Preview f={f} />
        </div>
      )}
    </section>
  );
}

function Ideas({ s, f, onTake }: { s: Suggestions; f: HomebrewForm; onTake: (p: Partial<HomebrewForm>, what: string) => void }) {
  const none = !(s.roll && !f.roll) && !s.gm && !s.words;
  return (
    <div className="card stack tight" aria-label="Suggested extras" style={{ background: 'var(--panel-2, transparent)' }}>
      <span className="tiny muted">{s.source === 'model' ? 'The assistant suggests' : 'Suggested from the rule’s words (no assistant model is set up)'}</span>
      {none && <span className="small">Nothing to add: the rule works as it is.</span>}
      {s.roll && !f.roll && (
        <div className="row between" style={{ gap: 8 }}>
          <span className="small grow"><strong>A “{s.roll.label}” button</strong> ({s.roll.kind === 'attack' ? 'weapon attack' : 'check or save'}, {s.roll.mode}). <span className="muted">{s.roll.why}</span></span>
          <button type="button" className="btn small" onClick={() => onTake({ roll: { label: s.roll!.label, kind: s.roll!.kind, mode: s.roll!.mode, places: ['sheet'], word: '' } }, 'A roll button')}>Add</button>
        </div>
      )}
      {s.gm && (
        <div className="row between" style={{ gap: 8 }}>
          <span className="small grow"><strong>Note for Minerva:</strong> “{s.gm.text}” <span className="muted">{s.gm.why}</span></span>
          <button type="button" className="btn small" onClick={() => onTake({ gm: s.gm!.text }, 'The note')}>Add</button>
        </div>
      )}
      {s.words && (
        <div className="row between" style={{ gap: 8 }}>
          <span className="small grow"><strong>Words:</strong> {s.words.list.join(', ')} <span className="muted">{s.words.why}</span></span>
          <button type="button" className="btn small" onClick={() => onTake({ words: [...new Set([...f.words, ...s.words!.list])] }, 'The words')}>Add</button>
        </div>
      )}
    </div>
  );
}

/** What players see, live as the Game Master edits. */
function Preview({ f }: { f: HomebrewForm }) {
  const r = f.roll;
  return (
    <div className="stack tight" aria-label="Preview">
      <h4 style={{ margin: 0 }}>What players see</h4>
      <div className="tiny muted">House rules page</div>
      <div className="card stack tight">
        <strong>{f.name || 'Name'} <span className="chip teal tiny">Mini-mod</span></strong>
        <div className="small">{f.text || 'The rule'}</div>
      </div>
      {r && (r.places.length > 0) && (
        <>
          <div className="tiny muted">{r.places.map((p) => (p === 'sheet' ? 'Sheet (Mini-mods module)' : 'Home page')).join(' and ')}</div>
          <div className="card" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="small grow"><strong>{r.label || 'Button'}</strong> <span className="tiny muted">{r.mode === 'normal' ? '' : r.mode}</span></span>
            {r.kind === 'attack' && <span className="input tiny" style={{ width: 'auto' }}>Longsword (+5)</span>}
            <span className="btn small primary" aria-hidden="true"><i className="fa-solid fa-dice-d20" /> Roll</span>
          </div>
        </>
      )}
      {r && (
        <>
          <div className="tiny muted">Table chat{r.word ? <> (also <code>/{r.word}{r.kind === 'attack' ? ' longsword' : ' 3'}</code>)</> : ''}</div>
          <div className="card small" style={{ display: 'block' }}><strong>Jessamine</strong> rolls <span style={{ fontFamily: 'monospace' }}>{diceText(r)}{r.kind === 'attack' ? '+5' : '+3'}</span> · {r.kind === 'attack' ? 'Longsword: ' : ''}{r.label || 'Button'}{r.mode === 'normal' ? '' : ` at ${r.mode}`} ({f.name || 'Name'})</div>
        </>
      )}
      <div className="tiny muted">The assistants are told</div>
      <div className="card tiny">Homebrew rule at this table: {f.name || 'Name'}: {f.text || 'The rule'}{f.gm ? <><br /><span className="muted">Minerva only: {f.gm}</span></> : null}</div>
    </div>
  );
}

/** The roll buttons of the mini-mods that are on, for one place: a card on the home page or the sheet's Mini-mods module. */
export function MiniModRolls({ place, framed = true }: { place: 'sheet' | 'home'; framed?: boolean }) {
  const { w, isDM } = useWorld();
  const { list } = useHouseRules();
  const rolls = list.filter((r) => r.enabled && r.rolls?.length).flatMap((r) => r.rolls.filter((x) => (x.places ?? ['sheet']).includes(place)).map((x) => ({ r, x })));
  const attacks = useLoad(() => (rolls.length && !isDM ? w.call<{ attacks: { name: string; hit: number }[] }>('GET', '/mods/attacks') : Promise.resolve({ attacks: [] })), [w, rolls.length, isDM], ['sheet']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [bonus, setBonus] = useState<Record<string, string>>({});
  if (isDM || !rolls.length) return framed ? null : <p className="tiny muted">No mini-mod roll is on.</p>;
  const atk = attacks.data?.attacks ?? [];
  const roll = (modId: string, rollId: string, key: string, kind: string) => act.run(async () => {
    const p = pick[key] ?? (atk.length ? '0' : '');
    const body = kind === 'attack' && p !== '' && p !== 'typed' ? { attack: Number(p) } : { bonus: bonus[key] ? Number(bonus[key]) : 0 };
    const out = await w.call<{ total: number | null; expr: string }>('POST', `/mods/${modId}/rolls/${rollId}`, body);
    toast(`Rolled ${out.expr}: ${out.total ?? '?'} (posted in table chat)`);
  });
  const body = (
    <>
      {rolls.map(({ r, x }) => {
        const key = `${r.id}:${x.id}`;
        const p = pick[key] ?? (atk.length ? '0' : 'typed');
        const typed = x.kind !== 'attack' || !atk.length || p === 'typed';
        return (
          <div key={key} className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="small grow" title={r.rules[0]?.text}><strong>{x.label}</strong> <span className="tiny muted">{x.mode === 'normal' ? '' : x.mode} · {r.name}{x.word ? ` · /${x.word}` : ''}</span></span>
            {x.kind === 'attack' && atk.length > 0 && (
              <select className="input" aria-label={`Weapon for ${x.label}`} value={p} onChange={(e) => setPick({ ...pick, [key]: e.target.value })} style={{ maxWidth: 180 }}>
                {atk.map((a, i) => <option key={i} value={String(i)}>{a.name} ({a.hit >= 0 ? '+' : ''}{a.hit})</option>)}
                <option value="typed">Type a bonus</option>
              </select>
            )}
            {typed && <input className="input" type="number" min={-30} max={30} aria-label={`Bonus for ${x.label}`} placeholder="+0" value={bonus[key] ?? ''} onChange={(e) => setBonus({ ...bonus, [key]: e.target.value })} style={{ width: 70 }} />}
            <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void roll(r.id, x.id, key, x.kind)}><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Roll</button>
          </div>
        );
      })}
      <ErrorBox error={act.error} />
      {toastNode}
    </>
  );
  return framed ? <section className="card stack" aria-label="Mini-mod rolls"><div className="card-head"><h2>Mini-mods</h2></div>{body}</section> : <div className="stack tight">{body}</div>;
}

/** The home page card. */
export const HomebrewRollsCard = () => <MiniModRolls place="home" />;
