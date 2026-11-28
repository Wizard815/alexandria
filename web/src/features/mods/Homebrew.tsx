// Homebrew rules: the Game Master's quick form (a name and a sentence, optionally a roll button on the players'
// sheets), the list of this world's homebrew rules, and the players' roll buttons. A homebrew rule is an ordinary
// house rule underneath; every assistant keeps it in mind while it is on. See docs/MODS.md.
import { useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Switch, useAction, useToast } from '../../ui/index.tsx';
import { useHouseRules, type HomebrewForm, type HouseRule, type RollMode } from './shared.tsx';

const MODES: [RollMode, string][] = [
  ['disadvantage', 'at disadvantage'], ['advantage', 'with advantage'], ['normal', 'a plain d20'],
];
const EMPTY: HomebrewForm = { name: '', text: '', gm: '', words: [], roll: null };
const EXAMPLES: [string, HomebrewForm][] = [
  ['Bonus action strike', { name: 'Bonus action strike', text: 'You can make one weapon attack with your bonus action, at disadvantage. You don\'t add your ability modifier to its damage.', gm: '', words: [], roll: { label: 'Bonus action attack', kind: 'attack', mode: 'disadvantage' } }],
  ['Potions as a bonus action', { name: 'Quick potions', text: 'Drinking a potion yourself is a bonus action. Giving one to someone else is still an action.', gm: '', words: ['potion'], roll: null }],
  ['Climb on a big foe', { name: 'Climbing foes', text: 'You can climb onto a creature two sizes larger than you with an Athletics or Acrobatics check against its Athletics. While on it, you have advantage on attacks against it.', gm: '', words: ['climb'], roll: null }],
];

/** The Game Master's Homebrew tab: the quick form and every homebrew rule of this world. */
export function HomebrewRules() {
  const { w, isDM } = useWorld();
  const { list, rules } = useHouseRules();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState<HomebrewForm>(EMPTY);
  if (!isDM) return null;
  const mine = list.filter((r) => r.homebrew && r.source === 'imported');
  const set = (p: Partial<HomebrewForm>) => setF({ ...f, ...p });
  const save = () => act.run(async () => {
    const out = await w.call<HouseRule>('POST', '/mods/homebrew', { ...(editing ? { id: editing } : {}), ...f, words: f.words.map((x) => x.trim()).filter(Boolean) });
    toast(editing ? `${out.name} saved` : `${out.name} is on. Players see it, and the assistants follow it.`);
    setF(EMPTY); setEditing(null);
    void rules.reload();
  });
  const edit = (r: HouseRule) => { setEditing(r.id); setF(r.form ?? { ...EMPTY, name: r.name, text: r.rules[0]?.text ?? '' }); window.scrollTo?.({ top: 0, behavior: 'smooth' }); };
  const toggle = (r: HouseRule, on: boolean) => act.run(async () => { await w.call('PUT', `/mods/${r.id}/enabled`, { on }); toast(`${r.name} is ${on ? 'on' : 'off'}`); void rules.reload(); });
  const remove = (r: HouseRule) => act.run(async () => {
    if (!window.confirm(`Remove ${r.name} from this world?`)) return;
    await w.call('DELETE', `/mods/${r.id}`);
    if (editing === r.id) { setEditing(null); setF(EMPTY); }
    toast(`${r.name} removed`); void rules.reload();
  });
  return (
    <div className="stack">
      <section className="card stack" aria-label={editing ? 'Edit homebrew rule' : 'Add a homebrew rule'}>
        <h3>{editing ? `Edit ${f.name || 'homebrew rule'}` : 'Add a homebrew rule'}</h3>
        <p className="tiny muted">A small change to the 5e rules at your table. It is on as soon as you save it: players see it on their House rules page, and Minerva, Squire and the Broker follow it in every answer.</p>
        {!editing && (
          <div className="row tiny" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="muted">Start from:</span>
            {EXAMPLES.map(([label, x]) => <button key={label} type="button" className="btn small" onClick={() => setF(x)}>{label}</button>)}
          </div>
        )}
        <label className="stack tight"><span className="small">Name</span>
          <input className="input" value={f.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Bonus action strike" />
        </label>
        <label className="stack tight"><span className="small">The rule, as players read it</span>
          <textarea className="input" rows={3} maxLength={4000} value={f.text} onChange={(e) => set({ text: e.target.value })} placeholder="You can make one weapon attack with your bonus action, at disadvantage." />
        </label>
        <details>
          <summary className="small">For the assistants (optional)</summary>
          <div className="stack tight" style={{ marginTop: 6 }}>
            <label className="stack tight"><span className="small">A note only your assistant sees</span>
              <input className="input" value={f.gm} maxLength={600} onChange={(e) => set({ gm: e.target.value })} placeholder="Only with a light weapon; remind players it uses their bonus action." />
            </label>
            <label className="stack tight"><span className="small">Words that bring it up, comma separated (5e terms in the rule, like bonus action, are found for you)</span>
              <input className="input" value={f.words.join(', ')} onChange={(e) => set({ words: e.target.value.split(',').map((x) => x.trimStart()) })} placeholder="off-hand, extra attack" />
            </label>
          </div>
        </details>
        <label className="row small" style={{ gap: 8 }}>
          <Switch label="Add a roll button to the players' sheets" checked={!!f.roll} onChange={(v) => set({ roll: v ? { label: f.name ? `${f.name}` : 'Bonus action attack', kind: 'attack', mode: 'disadvantage' } : null })} />
          Add a roll button to the players’ sheets
        </label>
        {f.roll && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label className="stack tight"><span className="tiny">Button</span>
              <input className="input" value={f.roll.label} maxLength={40} onChange={(e) => set({ roll: { ...f.roll!, label: e.target.value } })} />
            </label>
            <label className="stack tight"><span className="tiny">Roll</span>
              <select className="input" value={f.roll.kind} onChange={(e) => set({ roll: { ...f.roll!, kind: e.target.value as 'attack' | 'd20' } })}>
                <option value="attack">A weapon attack</option>
                <option value="d20">A check or save (d20 + a bonus)</option>
              </select>
            </label>
            <label className="stack tight"><span className="tiny">Dice</span>
              <select className="input" value={f.roll.mode} onChange={(e) => set({ roll: { ...f.roll!, mode: e.target.value as RollMode } })}>
                {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
        )}
        {f.roll && <p className="tiny muted">Players press it on their sheet. Alexandria rolls it ({f.roll.mode === 'disadvantage' ? 'two d20s, keeps the lower' : f.roll.mode === 'advantage' ? 'two d20s, keeps the higher' : 'one d20'}{f.roll.kind === 'attack' ? ', plus the weapon’s attack bonus from their Character module, or a bonus they type' : ', plus a bonus they type'}) and posts it in table chat with the rule’s name.</p>}
        <div className="row" style={{ gap: 6 }}>
          <button type="button" className="btn small primary" disabled={act.busy || !f.name.trim() || !f.text.trim()} onClick={() => void save()}>{editing ? 'Save changes' : 'Save and turn on'}</button>
          {editing && <button type="button" className="btn small" onClick={() => { setEditing(null); setF(EMPTY); }}>Cancel</button>}
        </div>
        <ErrorBox error={act.error} />
      </section>
      <section className="card stack" aria-label="Your homebrew rules">
        <h3>Your homebrew rules</h3>
        {mine.length === 0 ? <Empty>None yet. Add one above.</Empty> : mine.map((r) => (
          <div key={r.id} className="stack tight" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
              <span><strong>{r.name}</strong> <span className="tiny muted">v{r.version}</span></span>
              <Switch checked={r.enabled} label={`${r.name} on`} onChange={(v) => { if (!act.busy) void toggle(r, v); }} />
            </div>
            <div className="small">{r.rules[0]?.text}</div>
            {r.rolls.length > 0 && <div className="tiny muted">Sheet button: {r.rolls.map((x) => `${x.label} (${x.mode === 'normal' ? 'd20' : x.mode})`).join(', ')}</div>}
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small" onClick={() => edit(r)}>Edit</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void remove(r)}>Remove</button>
            </div>
          </div>
        ))}
      </section>
      {toastNode}
    </div>
  );
}

/** The player's roll buttons from the homebrew rules that are on (a bonus action attack at disadvantage, say). */
export function HomebrewRollsCard() {
  const { w, isDM } = useWorld();
  const { list } = useHouseRules();
  const rolls = list.filter((r) => r.enabled && r.rolls?.length).flatMap((r) => r.rolls.map((x) => ({ r, x })));
  const attacks = useLoad(() => (rolls.length && !isDM ? w.call<{ attacks: { name: string; hit: number }[] }>('GET', '/mods/attacks') : Promise.resolve({ attacks: [] })), [w, rolls.length, isDM], ['sheet']);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [bonus, setBonus] = useState<Record<string, string>>({});
  if (isDM || !rolls.length) return null;
  const atk = attacks.data?.attacks ?? [];
  const roll = (modId: string, rollId: string, key: string, kind: string) => act.run(async () => {
    const p = pick[key] ?? (atk.length ? '0' : '');
    const body = kind === 'attack' && p !== '' && p !== 'typed' ? { attack: Number(p) } : { bonus: bonus[key] ? Number(bonus[key]) : 0 };
    const out = await w.call<{ total: number | null; expr: string }>('POST', `/mods/${modId}/rolls/${rollId}`, body);
    toast(`Rolled ${out.expr}: ${out.total ?? '?'} (posted in table chat)`);
  });
  return (
    <section className="card stack" aria-label="Homebrew rolls">
      <div className="card-head"><h2>Homebrew rolls</h2></div>
      {rolls.map(({ r, x }) => {
        const key = `${r.id}:${x.id}`;
        const p = pick[key] ?? (atk.length ? '0' : 'typed');
        const typed = x.kind !== 'attack' || !atk.length || p === 'typed';
        return (
          <div key={key} className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="small grow" title={r.rules[0]?.text}><strong>{x.label}</strong> <span className="tiny muted">{x.mode === 'normal' ? '' : x.mode} · {r.name}</span></span>
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
    </section>
  );
}
