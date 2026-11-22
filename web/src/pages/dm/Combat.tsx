// Combat tracker. HP changes by typing an amount (Enter applies damage,
// Shift+Enter heals) or by scrolling the wheel over the HP box.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, Switch, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { healthPreview, usePlayers } from './shared.tsx';
import SculptButton from '../../features/sculpt/SculptButton.tsx';
import '../combat.css';

type Effect = { name: string; rounds?: number; until?: { of: string; at: 'start' | 'end' } };

export default function DMCombat() {
  const { w, info } = useWorld();
  const combat = useLoad<any>(() => w.combat(), [w], ['combat']);
  const act = useAction();
  // Conditions that ran out, and a dying PC's turn, as the last "next turn" reported them.
  const [turnNote, setTurnNote] = useState('');
  const c = combat.data;
  const list: any[] = c?.combatants ?? [];
  const turnIdx = list.length ? c.turn % list.length : -1;
  const setState = (patch: Record<string, unknown>) => act.run(async () => { combat.setData(await w.call('PUT', '/live/combat', patch)); });

  return (
    <div className="page wide">
      <PageHead title="Combat" lead={`Players see order and conditions. Monster health shows as ${info.settings.monsterHealth === 'none' ? 'nothing' : info.settings.monsterHealth}.`}>
        <SculptButton template="encounter" label="Encounter" autoSculpt onDone={() => void combat.reload()} /><SculptButton template="statblock" label="Quick statblock" onDone={() => void combat.reload()} />
      </PageHead>
      <div className="cb-bar">
        {c?.active ? (
          <>
            <span className="chip gold" style={{ fontSize: 15, padding: '4px 12px' }}>Round {c.round}</span>
            <button type="button" className="btn primary next" disabled={act.busy || !list.length} onClick={() => act.run(async () => { const r: any = await w.nextTurn(); combat.setData(r); setTurnNote([...(r.ended ?? []).map((e: any) => `${e.name} ended on ${e.combatant}`), ...(r.deathSaveDue ? [`${r.deathSaveDue} is down: death save`] : [])].join('. ')); })}>Next turn ▸</button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => void setState({ active: false })}>End combat</button>
          </>
        ) : (
          <button type="button" className="btn primary" disabled={act.busy || !list.length} onClick={() => void setState({ active: true, round: 1, turn: 0 })}>Start combat</button>
        )}
      </div>
      <ErrorBox error={combat.error || act.error} />
      {turnNote && <div role="status" className="chip gold" style={{ whiteSpace: 'normal', alignSelf: 'flex-start' }}>{turnNote}</div>}
      <div className="cols">
        <section className="col-3 stack" aria-label="Initiative order">
          {combat.loading ? <Loading /> : list.length ? list.map((x, i) => <Row key={x.id} x={x} current={!!c.active && i === turnIdx} mode={info.settings.monsterHealth} allNames={list.map((o) => ({ id: o.id, name: o.name }))} />) : (
            <div className="card"><Empty>No one in the fight yet. Add combatants on the right.</Empty></div>
          )}
          {list.length > 0 && (
            <div className="row">
              <button type="button" className="btn small danger" disabled={act.busy} onClick={() => { if (confirm('Remove everyone from the tracker?')) void act.run(async () => { for (const x of list) await w.call('DELETE', `/live/combatants/${x.id}`); await setState({ active: false, round: 1, turn: 0 }); }); }}>Clear the tracker</button>
            </div>
          )}
        </section>
        <aside className="col-1 stack"><AddForm /></aside>
      </div>
    </div>
  );
}

/** "Prone · 2 rd", "Stunned · until end of Cora's turn". */
function effectLabel(ef: Effect, names: { id: string; name: string }[]): string {
  const who = ef.until ? (names.find((n) => n.id === ef.until!.of)?.name ?? 'its source') : '';
  return `${ef.name}${ef.rounds ? ` · ${ef.rounds} rd` : ''}${ef.until ? ` · until ${ef.until.at} of ${who}'s turn` : ''}`;
}

function Row({ x, current, mode, allNames }: { x: any; current: boolean; mode: string; allNames: { id: string; name: string }[] }) {
  const { w, nameOf } = useWorld();
  const act = useAction();
  const [amount, setAmount] = useState('');
  const [effect, setEffect] = useState('');
  const [rounds, setRounds] = useState('');
  const [lasts, setLasts] = useState('none');
  const [lastsOf, setLastsOf] = useState('self');
  const [crit, setCrit] = useState(false);
  const [spell, setSpell] = useState('');
  const [roll, setRoll] = useState('');
  // What the last change did (a concentration save is due, a death save failed), until the next one.
  const [notice, setNotice] = useState('');
  const effects: Effect[] = x.effects ?? [];
  const patch = (p: Record<string, unknown>) => act.run(async () => {
    const r: any = await w.updateCombatant(x.id, p);
    setNotice(Array.isArray(r?.notes) ? r.notes.join('. ') : '');
    return r;
  });
  const conc: { spell: string; dc: number | null } | null = x.concentration ?? null;
  const ds: { successes: number; failures: number; stable: boolean; dead: boolean } | null = x.death_saves ?? null;
  const dying = !!x.is_pc && x.hp !== null && x.hp <= 0 && !ds?.stable && !ds?.dead;

  const applyAmount = (heal: boolean) => {
    const n = Math.abs(parseInt(amount, 10));
    if (!n) return;
    void patch(heal ? { heal: n } : { damage: n, ...(crit ? { crit: true } : {}) });
    setAmount('');
    setCrit(false);
  };
  // Native, non-passive wheel listener so scrolling the HP box changes HP
  // instead of the page.
  const hpRef = useRef<HTMLSpanElement>(null);
  const hpNow = useRef<number | null>(x.hp);
  hpNow.current = x.hp;
  useEffect(() => {
    const el = hpRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (hpNow.current === null) return;
      e.preventDefault();
      hpNow.current += e.deltaY < 0 ? 1 : -1;
      void w.updateCombatant(x.id, { hp: hpNow.current });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [w, x.id, x.hp === null]);
  const addEffect = (e: FormEvent) => {
    e.preventDefault();
    if (!effect.trim()) return;
    const r = parseInt(rounds, 10);
    const timer = lasts === 'rounds' ? (r > 0 ? { rounds: r } : {}) : lasts === 'end' ? { untilEndOf: lastsOf } : lasts === 'start' ? { untilStartOf: lastsOf } : {};
    void patch({ effects: [...effects, { name: effect.trim(), ...timer }] });
    setEffect('');
    setRounds('');
    setLasts('none');
  };
  const others: { id: string; name: string }[] = allNames;
  const pct = x.hp !== null && x.max_hp ? Math.max(0, Math.min(100, (x.hp / x.max_hp) * 100)) : null;

  const [fxOpen, setFxOpen] = useState(false);
  return (
    <article className={`cb-row${current ? ' current' : ''}${x.hidden ? ' hidden-foe' : ''}`} aria-current={current ? 'step' : undefined}>
      <div className="cb-head">
        <span className="chip gold" title="Initiative" style={{ fontSize: 14 }}>{x.initiative}</span>
        <span className="name">{current ? '▶ ' : ''}{x.name}</span>
        {x.is_pc && <span className="chip teal">{nameOf(x.account_id)}'s PC</span>}
        {x.hidden && <span className="chip red">Hidden from players</span>}
        {current && <span className="chip gold">Their turn</span>}
        <label className="row small muted push" style={{ gap: 6 }}>Hidden <Switch checked={!!x.hidden} onChange={(v) => void patch({ hidden: v })} label={`Hide ${x.name}`} /></label>
        <button type="button" className="btn small ghost" aria-label={`Remove ${x.name}`} disabled={act.busy} onClick={() => void act.run(() => w.call('DELETE', `/live/combatants/${x.id}`))}>✕</button>
      </div>
      <div className="cb-hit">
        {x.hp !== null && (
          <span ref={hpRef} title="Scroll to change by 1" className="cb-hp" style={{ cursor: 'ns-resize' }}>
            <b>{x.hp}<span className="muted" style={{ fontSize: 15 }}> / {x.max_hp}</span></b>
            {pct !== null && <span className="bar"><span style={{ width: `${pct}%`, background: pct > 50 ? 'var(--ok-text)' : pct > 25 ? 'var(--accent)' : 'var(--danger)' }} /></span>}
          </span>
        )}
        {x.temp_hp > 0 && (
          <span className="chip teal" title="Temporary HP: damage takes these first, and they never stack">+{x.temp_hp} temp
            <button type="button" className="btn ghost small x" aria-label={`Clear temporary HP on ${x.name}`} onClick={() => void patch({ setTempHp: 0 })}>×</button>
          </span>
        )}
        <form className="row" style={{ flex: '1 1 auto', gap: 8 }} onSubmit={(e) => { e.preventDefault(); applyAmount(false); }}>
          <label className="sr-only" htmlFor={`amt-${x.id}`}>Amount for {x.name}</label>
          <input id={`amt-${x.id}`} className="input" inputMode="numeric" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); applyAmount(true); } }} />
          <button type="submit" className="btn danger" disabled={!amount}>Damage</button>
          <button type="button" className="btn" disabled={!amount} onClick={() => applyAmount(true)}>Heal</button>
          <button type="button" className="btn" disabled={!amount} title="Temporary HP never stack: the higher number is kept" onClick={() => { void patch({ tempHp: Math.abs(parseInt(amount, 10)) }); setAmount(''); }}>Temp HP</button>
          {x.is_pc && <label className="row small" style={{ gap: 4 }}><input type="checkbox" checked={crit} onChange={(e) => setCrit(e.target.checked)} /> Crit</label>}
        </form>
      </div>
      {notice && <div role="status" className="chip gold" style={{ whiteSpace: 'normal', alignSelf: 'flex-start' }}>{notice}</div>}
      <div className="cb-fx">
        {conc ? (
          <>
            <span className="chip teal">Concentrating: {conc.spell}</span>
            {conc.dc !== null && <span className="chip red" role="status">Constitution save DC {conc.dc}</span>}
            {conc.dc !== null && <button type="button" className="btn small" onClick={() => void patch({ concentrationSave: { result: 'pass' } })}>Passed</button>}
            {conc.dc !== null && <button type="button" className="btn small danger" onClick={() => void patch({ concentrationSave: { result: 'fail' } })}>Failed: loses it</button>}
            <button type="button" className="btn small ghost" aria-label={`${x.name} stops concentrating`} onClick={() => void patch({ concentration: null })}>Drop</button>
          </>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (spell.trim()) { void patch({ concentration: spell.trim() }); setSpell(''); } }}>
            <label className="sr-only" htmlFor={`conc-${x.id}`}>Concentrating on, for {x.name}</label>
            <input id={`conc-${x.id}`} className="input" style={{ width: 170 }} placeholder="Concentrating on…" value={spell} onChange={(e) => setSpell(e.target.value)} />
            <button type="submit" className="btn small" disabled={!spell.trim()}>Concentrate</button>
          </form>
        )}
      </div>
      {x.is_pc && (ds?.dead || ds?.stable || dying) && (
        <div className="cb-fx" aria-label={`Death saves for ${x.name}`}>
          {ds?.dead ? <span className="chip red">Dead</span> : ds?.stable ? <span className="chip teal">Stable at 0 HP</span> : (
            <>
              <span className="chip red">Death saves</span>
              <span title="Successes">✓ {ds?.successes ?? 0}/3</span>
              <span title="Failures">✗ {ds?.failures ?? 0}/3</span>
              <label className="sr-only" htmlFor={`roll-${x.id}`}>Death save d20 for {x.name}</label>
              <input id={`roll-${x.id}`} className="input" style={{ width: 80 }} inputMode="numeric" placeholder="d20" value={roll} onChange={(e) => setRoll(e.target.value.replace(/[^\d]/g, ''))} />
              <button type="button" className="btn small" disabled={!(parseInt(roll, 10) >= 1 && parseInt(roll, 10) <= 20)} onClick={() => { void patch({ deathSave: { roll: parseInt(roll, 10) } }); setRoll(''); }}>Roll</button>
              <button type="button" className="btn small" onClick={() => void patch({ deathSave: { result: 'success' } })}>Success</button>
              <button type="button" className="btn small danger" onClick={() => void patch({ deathSave: { result: 'failure' } })}>Failure</button>
            </>
          )}
        </div>
      )}
      <div className="cb-fx">
        {effects.map((ef, i) => (
          <span key={i} className="chip gold">{effectLabel(ef, allNames)}
            <button type="button" className="btn ghost small x" aria-label={`Remove ${ef.name}`} onClick={() => void patch({ effects: effects.filter((_, j) => j !== i) })}>×</button>
          </span>
        ))}
        {fxOpen ? (
          <form onSubmit={(e) => { addEffect(e); setFxOpen(false); }}>
            <label className="sr-only" htmlFor={`ef-${x.id}`}>New condition on {x.name}</label>
            <input id={`ef-${x.id}`} className="input" style={{ width: 150 }} placeholder="Prone, Poisoned…" autoFocus value={effect} onChange={(e) => setEffect(e.target.value)} />
            <label className="sr-only" htmlFor={`efl-${x.id}`}>How long it lasts</label>
            <select id={`efl-${x.id}`} value={lasts} onChange={(e) => setLasts(e.target.value)}>
              <option value="none">Until removed</option>
              <option value="rounds">Rounds</option>
              <option value="end">Until end of a turn</option>
              <option value="start">Until start of a turn</option>
            </select>
            {lasts === 'rounds' && (
              <>
                <label className="sr-only" htmlFor={`efr-${x.id}`}>Rounds</label>
                <input id={`efr-${x.id}`} className="input" style={{ width: 80 }} inputMode="numeric" placeholder="Rounds" value={rounds} onChange={(e) => setRounds(e.target.value.replace(/[^\d]/g, ''))} />
              </>
            )}
            {(lasts === 'end' || lasts === 'start') && (
              <>
                <label className="sr-only" htmlFor={`efo-${x.id}`}>Whose turn</label>
                <select id={`efo-${x.id}`} value={lastsOf} onChange={(e) => setLastsOf(e.target.value)}>
                  <option value="self">{x.name}'s next turn</option>
                  {others.filter((o) => o.id !== x.id).map((o) => <option key={o.id} value={o.id}>{o.name}'s next turn</option>)}
                </select>
              </>
            )}
            <button type="submit" className="btn small" disabled={!effect.trim()}>Add</button>
            <button type="button" className="btn small ghost" onClick={() => setFxOpen(false)}>Cancel</button>
          </form>
        ) : <button type="button" className="btn small" onClick={() => setFxOpen(true)}>+ Condition</button>}
      </div>
      <span className="tiny faint">Players see: {x.hidden ? 'nothing (hidden)' : x.is_pc ? 'name and conditions, no health' : `name, conditions and ${healthPreview(x.hp, x.max_hp, mode)}`}</span>
      <ErrorBox error={act.error} />
    </article>
  );
}

function AddForm() {
  const { w } = useWorld();
  const players = usePlayers();
  const act = useAction();
  const [name, setName] = useState('');
  const [init, setInit] = useState('');
  const [hp, setHp] = useState('');
  const [acc, setAcc] = useState('');
  const [hidden, setHidden] = useState(false);
  const [count, setCount] = useState('1');

  const submit = (e: FormEvent) => act.run(async () => {
    e.preventDefault();
    const n = Math.max(1, Math.min(20, parseInt(count, 10) || 1));
    const base = name.trim() || players.find((p) => p.id === acc)?.character_name || '';
    if (!base) throw new Error('Give it a name');
    for (let i = 1; i <= n; i++) {
      await w.addCombatant({
        name: n > 1 ? `${base} ${i}` : base,
        // Blank: a monster with a rules statblock rolls d20 plus Dexterity on the server, anything else a plain d20.
        ...(init ? { initiative: parseInt(init, 10) } : acc ? { initiative: Math.floor(Math.random() * 20) + 1 } : { roll: true }),
        ...(hp ? { hp: parseInt(hp, 10), maxHp: parseInt(hp, 10) } : {}),
        ...(acc ? { accountId: acc } : {}),
        hidden,
      });
    }
    setName(''); setInit(''); setHp(''); setAcc(''); setHidden(false); setCount('1');
  });

  return (
    <form className="card" onSubmit={(e) => void submit(e)}>
      <h2>Add to the fight</h2>
      <Field label="Player character" help="Pick a player to link their PC. Leave empty for a monster or NPC.">
        <select value={acc} onChange={(e) => setAcc(e.target.value)}>
          <option value="">— Monster or NPC —</option>
          {players.map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}
        </select>
      </Field>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={acc ? 'Their character name' : 'Dock thug'} /></Field>
      <div className="grid small">
        <Field label="Initiative" help="Empty rolls a d20 (plus Dexterity for a known monster)"><input inputMode="numeric" value={init} onChange={(e) => setInit(e.target.value.replace(/[^\d-]/g, ''))} /></Field>
        <Field label="HP" help={acc ? 'Optional for PCs' : 'Max HP'}><input inputMode="numeric" value={hp} onChange={(e) => setHp(e.target.value.replace(/[^\d]/g, ''))} /></Field>
        {!acc && <Field label="How many"><input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ''))} /></Field>}
      </div>
      <label className="row small"><Switch checked={hidden} onChange={setHidden} label="Hidden from players" /> Hidden from players (ambushers, the sniper on the roof)</label>
      <ErrorBox error={act.error} />
      <button type="submit" className="btn primary" disabled={act.busy}>Add</button>
    </form>
  );
}
