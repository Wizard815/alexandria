// Combat tracker. HP changes by typing an amount (Enter applies damage,
// Shift+Enter heals) or by scrolling the wheel over the HP box.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Field, Switch, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { healthPreview, usePlayers } from './shared.tsx';

type Effect = { name: string; rounds?: number };

export default function DMCombat() {
  const { w, info } = useWorld();
  const combat = useLoad<any>(() => w.combat(), [w], ['combat']);
  const act = useAction();
  const c = combat.data;
  const list: any[] = c?.combatants ?? [];
  const turnIdx = list.length ? c.turn % list.length : -1;
  const setState = (patch: Record<string, unknown>) => act.run(async () => { combat.setData(await w.call('PUT', '/live/combat', patch)); });

  return (
    <div className="page wide">
      <PageHead title="Combat" lead={`Players see the order and effects. Monster health shows as ${info.settings.monsterHealth === 'none' ? 'nothing' : info.settings.monsterHealth}; the party's health is never shown. Hidden foes stay hidden.`}>
        {c?.active ? (
          <>
            <span className="chip gold" style={{ fontSize: 15, padding: '4px 12px' }}>Round {c.round}</span>
            <button type="button" className="btn primary" disabled={act.busy || !list.length} onClick={() => act.run(async () => { combat.setData(await w.nextTurn()); })}>Next turn ▸</button>
            <button type="button" className="btn" disabled={act.busy} onClick={() => void setState({ active: false })}>End combat</button>
          </>
        ) : (
          <button type="button" className="btn primary" disabled={act.busy || !list.length} onClick={() => void setState({ active: true, round: 1, turn: 0 })}>Start combat</button>
        )}
      </PageHead>
      <ErrorBox error={combat.error || act.error} />
      <div className="cols">
        <section className="col-3 stack" aria-label="Initiative order">
          {combat.loading ? <Loading /> : list.length ? list.map((x, i) => <Row key={x.id} x={x} current={!!c.active && i === turnIdx} mode={info.settings.monsterHealth} />) : (
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

function Row({ x, current, mode }: { x: any; current: boolean; mode: string }) {
  const { w, nameOf } = useWorld();
  const act = useAction();
  const [amount, setAmount] = useState('');
  const [effect, setEffect] = useState('');
  const [rounds, setRounds] = useState('');
  const effects: Effect[] = x.effects ?? [];
  const patch = (p: Record<string, unknown>) => act.run(() => w.updateCombatant(x.id, p));

  const applyAmount = (heal: boolean) => {
    const n = Math.abs(parseInt(amount, 10));
    if (!n) return;
    void patch(heal ? { heal: n } : { damage: n });
    setAmount('');
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
    void patch({ effects: [...effects, r > 0 ? { name: effect.trim(), rounds: r } : { name: effect.trim() }] });
    setEffect('');
    setRounds('');
  };
  const pct = x.hp !== null && x.max_hp ? Math.max(0, Math.min(100, (x.hp / x.max_hp) * 100)) : null;

  return (
    <article className="card" style={current ? { borderColor: 'var(--accent)', background: 'var(--accent-bg)' } : x.hidden ? { borderStyle: 'dashed' } : undefined} aria-current={current ? 'step' : undefined}>
      <div className="row between">
        <div className="row">
          <span className="chip gold" title="Initiative" style={{ fontSize: 14 }}>{x.initiative}</span>
          <strong style={{ fontSize: 18 }}>{x.name}</strong>
          {x.is_pc && <span className="chip teal">{nameOf(x.account_id)}'s PC</span>}
          {x.hidden && <span className="chip red">Hidden from players</span>}
          {current && <span className="chip gold">Their turn</span>}
        </div>
        <div className="row">
          <label className="row small muted" style={{ gap: 6 }}>Hidden <Switch checked={!!x.hidden} onChange={(v) => void patch({ hidden: v })} label={`Hide ${x.name}`} /></label>
          <button type="button" className="btn small ghost" aria-label={`Remove ${x.name}`} disabled={act.busy} onClick={() => void act.run(() => w.call('DELETE', `/live/combatants/${x.id}`))}>✕</button>
        </div>
      </div>
      <div className="row">
        {x.hp !== null && (
           <span ref={hpRef} title="Scroll to change by 1" className="stat" style={{ minWidth: 120, cursor: 'ns-resize' }}>
            <b>{x.hp}<span className="muted" style={{ fontSize: 15 }}> / {x.max_hp}</span></b>
            {pct !== null && <span style={{ height: 4, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct > 50 ? 'var(--ok-text)' : pct > 25 ? 'var(--accent)' : 'var(--danger)' }} /></span>}
          </span>
        )}
        <form className="row" onSubmit={(e) => { e.preventDefault(); applyAmount(false); }}>
          <label className="sr-only" htmlFor={`amt-${x.id}`}>Amount for {x.name}</label>
          <input id={`amt-${x.id}`} className="input" style={{ width: 90 }} inputMode="numeric" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); applyAmount(true); } }} />
          <button type="submit" className="btn small danger" disabled={!amount}>Damage</button>
          <button type="button" className="btn small" disabled={!amount} onClick={() => applyAmount(true)}>Heal</button>
        </form>
      </div>
      <div className="row">
        {effects.map((ef, i) => (
          <span key={i} className="chip gold">{ef.name}{ef.rounds ? ` · ${ef.rounds} rd` : ''}
            <button type="button" className="btn ghost small" style={{ minHeight: 20, padding: '0 4px' }} aria-label={`Remove ${ef.name}`} onClick={() => void patch({ effects: effects.filter((_, j) => j !== i) })}>×</button>
          </span>
        ))}
        <form className="row" onSubmit={addEffect}>
          <label className="sr-only" htmlFor={`ef-${x.id}`}>New effect on {x.name}</label>
          <input id={`ef-${x.id}`} className="input" style={{ width: 150 }} placeholder="Effect (Prone…)" value={effect} onChange={(e) => setEffect(e.target.value)} />
          <label className="sr-only" htmlFor={`efr-${x.id}`}>Rounds</label>
          <input id={`efr-${x.id}`} className="input" style={{ width: 70 }} inputMode="numeric" placeholder="Rounds" value={rounds} onChange={(e) => setRounds(e.target.value.replace(/[^\d]/g, ''))} />
          <button type="submit" className="btn small" disabled={!effect.trim()}>Add effect</button>
        </form>
      </div>
      <span className="tiny faint">Players see: {x.hidden ? 'nothing (hidden)' : x.is_pc ? 'name and effects, no health' : `name, effects and ${healthPreview(x.hp, x.max_hp, mode)}`}</span>
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
        initiative: init ? parseInt(init, 10) : Math.floor(Math.random() * 20) + 1,
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
        <Field label="Initiative" help="Empty rolls a d20"><input inputMode="numeric" value={init} onChange={(e) => setInit(e.target.value.replace(/[^\d-]/g, ''))} /></Field>
        <Field label="HP" help={acc ? 'Optional for PCs' : 'Max HP'}><input inputMode="numeric" value={hp} onChange={(e) => setHp(e.target.value.replace(/[^\d]/g, ''))} /></Field>
        {!acc && <Field label="How many"><input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ''))} /></Field>}
      </div>
      <label className="row small"><Switch checked={hidden} onChange={setHidden} label="Hidden from players" /> Hidden from players (ambushers, the sniper on the roof)</label>
      <ErrorBox error={act.error} />
      <button type="submit" className="btn primary" disabled={act.busy}>Add</button>
    </form>
  );
}
