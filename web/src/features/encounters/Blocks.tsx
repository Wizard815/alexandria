// Encounters and story events as blocks. A script is a list of steps; each step holds blocks: answers (with effect
// chips: coin, pay, lose, item, shop, DM note), a check or game, and a timer. EventFlow shows them read-only (the
// preview before sending); StepBlocks edits them (the Tweak screen and the Saved tab). Same cards in both, so what the
// DM edits looks like what they send. The data is the same script the server and the agent already use.
import { useEffect, useState } from 'react';
import { parseCoins } from '../../lib/format.ts';
import { AddBar, Block, BlockRow, CheckBlock, Chip, FoldChip, Palette, StepCard, dcText } from '../../ui/blocks.tsx';
import { GAME_HELP, type Effect, type Game, type GameKind, type Node, type Option, type Script } from './types.ts';

export const GAME_NAME: Record<GameKind, string> = { coin: 'Coin toss', shells: 'Shell game', dice: 'Dice duel', check: 'Skill check' };
export const dcLabel = (g: { dc: number | null; dcMax?: number | null }) => dcText(g.dc, g.dcMax);

/** The steps in reading order: the start, then breadth first along answers and outcomes, then anything unreachable. */
export function stepOrder(s: Script): Node[] {
  const by = new Map(s.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: Node[] = [];
  const queue = [s.start];
  while (queue.length) {
    const id = queue.shift()!;
    const n = by.get(id);
    if (!n || seen.has(id)) continue;
    seen.add(id);
    out.push(n);
    if (n.game) queue.push(n.game.win, n.game.lose);
    for (const o of n.options) if (o.next) queue.push(o.next);
  }
  for (const n of s.nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

/** "caught-thief" → "Caught thief". */
export const stepName = (id: string) => { const s = id.replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : id; };

const scrollTo = (id: string) => document.getElementById(`flow-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

function GoTo({ to, n }: { to: string | null; n: Map<string, number> }) {
  if (!to) return <span className="blk-goto end" title="The event ends here"><i className="fa-solid fa-flag-checkered" aria-hidden="true" /> ends</span>;
  return <button type="button" className="blk-goto" onClick={() => scrollTo(to)} title={`Go to step ${n.get(to) ?? ''}`}><i className="fa-solid fa-arrow-right" aria-hidden="true" /> {n.get(to) ?? '?'}. {stepName(to)}</button>;
}

function FxChip({ fx, money }: { fx: Effect; money: (cp: number) => string }) {
  if (fx.kind === 'gold') return <Chip tone="green" icon="fa-coins">+{money(fx.cp)}</Chip>;
  if (fx.kind === 'pay') return <Chip tone="red" icon="fa-hand-holding-dollar">pays {money(fx.cp)}</Chip>;
  if (fx.kind === 'lose') return <Chip tone="red" icon="fa-coins">−{money(fx.cp)}</Chip>;
  if (fx.kind === 'item') return <Chip tone="gold" icon="fa-sack-xmark" title={fx.note}>{fx.qty > 1 ? `${fx.qty} × ` : ''}{fx.name}</Chip>;
  if (fx.kind === 'shop') return <Chip icon="fa-store">shop</Chip>;
  return <FoldChip label="DM note" text={fx.text} />;
}

/** One step, read-only: what happens, its timer, its check or game, and its answers. */
function FlowStep({ n, i, start, nums, money }: { n: Node; i: number; start: boolean; nums: Map<string, number>; money: (cp: number) => string }) {
  const g = n.game;
  const stakes = g ? `${g.stakeCp ? ` · stake ${money(g.stakeCp)}` : ''}${g.winCp ? ` · win ${money(g.winCp)}` : ''}` : '';
  return (
    <StepCard num={i} anchor={`flow-${n.id}`} title={<strong>{start ? 'Start' : stepName(n.id)}</strong>}
      badges={n.timer && <span className="chip gold blk-timer" title="Timed"><i className="fa-solid fa-stopwatch" aria-hidden="true" /> {n.timer.secs}s</span>}>
      <p className="blk-text">{n.text}</p>
      {g && <CheckBlock skill={g.skill} dc={g.dc} dcMax={g.dcMax} head={g.kind === 'check' ? `${g.skill || 'Skill'} · ${dcLabel(g)}${stakes}` : `${GAME_NAME[g.kind]}${stakes}`}
        pass={<GoTo to={g.win} n={nums} />} fail={<GoTo to={g.lose} n={nums} />} />}
      {n.options.map((o, j) => (
        <Block key={j} tone="gold">
          <span className="blk-label">{o.label}</span>
          {o.effects.map((fx, k) => <FxChip key={k} fx={fx} money={money} />)}
          {n.timer && n.timer.fallback === j && <Chip icon="fa-hourglass-end" title="Picked when time runs out">if time runs out</Chip>}
          <GoTo to={o.next} n={nums} />
        </Block>
      ))}
      {n.timer && n.timer.fallback === -1 && g && <span className="tiny faint"><i className="fa-solid fa-hourglass-end" aria-hidden="true" /> Out of time: the {g.kind === 'check' ? 'check' : 'game'} fails.</span>}
    </StepCard>
  );
}

/** The whole event as step cards. */
export function EventFlow({ script, money }: { script: Script; money: (cp: number) => string }) {
  const order = stepOrder(script);
  const nums = new Map(order.map((n, i) => [n.id, i + 1]));
  return <ol className="blk-flow" data-testid="event-flow">{order.map((n, i) => <FlowStep key={n.id} n={n} i={i + 1} start={n.id === script.start} nums={nums} money={money} />)}</ol>;
}

// ---------------- editing ----------------

export const slug = (s: string, taken: string[]) => {
  const b = s.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'step';
  let id = b, n = 2;
  while (taken.includes(id)) id = `${b}-${n++}`;
  return id;
};

export function CoinInput({ label, cp, onChange, money }: { label: string; cp: number; onChange: (cp: number) => void; money: (cp: number) => string }) {
  const [s, setS] = useState(money(cp));
  useEffect(() => setS(money(cp)), [cp]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="field blk-coin"><span className="label">{label}</span>
      <input value={s} onChange={(e) => setS(e.target.value)} onBlur={() => { const v = parseCoins(s); onChange(v === null ? 0 : Math.max(0, Math.min(100_000, v))); }} />
    </label>
  );
}

const NEW = '__new__';
/** Where an answer or outcome goes: a step, the end, or a new step made on the spot. */
function GoPicker({ order, value, onChange, onNew, required, label = 'Goes to' }: { order: Node[]; value: string | null; onChange: (v: string | null) => void; onNew: () => void; required?: boolean; label?: string }) {
  return (
    <select className="input blk-pick" value={value ?? ''} aria-label={label} onChange={(e) => { if (e.target.value === NEW) onNew(); else onChange(e.target.value || null); }}>
      {!required && <option value="">⚑ Ends</option>}
      {order.map((n, i) => <option key={n.id} value={n.id}>→ {i + 1}. {stepName(n.id)}</option>)}
      <option value={NEW}>+ New step</option>
    </select>
  );
}

const FX_ADD: { key: Effect['kind']; label: string; icon: string; make: () => Effect }[] = [
  { key: 'gold', label: 'Coin', icon: 'fa-coins', make: () => ({ kind: 'gold', cp: 10 }) },
  { key: 'pay', label: 'They pay', icon: 'fa-hand-holding-dollar', make: () => ({ kind: 'pay', cp: 10 }) },
  { key: 'lose', label: 'They lose', icon: 'fa-coins', make: () => ({ kind: 'lose', cp: 10 }) },
  { key: 'item', label: 'Item', icon: 'fa-sack-xmark', make: () => ({ kind: 'item', name: '', qty: 1 }) },
  { key: 'dmnote', label: 'DM note', icon: 'fa-note-sticky', make: () => ({ kind: 'dmnote', text: '' }) },
  { key: 'shop', label: 'Shop', icon: 'fa-store', make: () => ({ kind: 'shop', shopId: '' }) },
];

function FxEdit({ fx, set, del, money, shops }: { fx: Effect; set: (fx: Effect) => void; del: () => void; money: (cp: number) => string; shops: { id: string; name: string }[] }) {
  return (
    <div className={`blk-fx blk-fx-${fx.kind}`}>
      {fx.kind === 'gold' && <CoinInput label="Gives coin" cp={fx.cp} money={money} onChange={(cp) => set({ kind: 'gold', cp: Math.max(1, cp) })} />}
      {(fx.kind === 'pay' || fx.kind === 'lose') && <CoinInput label={fx.kind === 'pay' ? 'They pay' : 'They lose'} cp={fx.cp} money={money} onChange={(cp) => set({ kind: fx.kind, cp: Math.max(1, cp) })} />}
      {fx.kind === 'dmnote' && <label className="field blk-grow"><span className="label">DM note (players never see it)</span><input value={fx.text} maxLength={300} placeholder="Kept the stolen purse; the thieves remember" onChange={(e) => set({ kind: 'dmnote', text: e.target.value })} /></label>}
      {fx.kind === 'item' && <>
        <label className="field blk-grow"><span className="label">Gives item</span><input value={fx.name} maxLength={120} onChange={(e) => set({ ...fx, name: e.target.value })} /></label>
        <label className="field blk-qty"><span className="label">Qty</span><input inputMode="numeric" value={fx.qty} onChange={(e) => set({ ...fx, qty: Math.max(1, Math.min(20, Number(e.target.value.replace(/\D/g, '')) || 1)) })} /></label>
        <label className="field blk-grow"><span className="label">Note on the item</span><input value={fx.note ?? ''} maxLength={200} placeholder="Worth about 10 gp to a jeweller" onChange={(e) => set({ ...fx, note: e.target.value || undefined })} /></label>
      </>}
      {fx.kind === 'shop' && (
        <label className="field blk-grow"><span className="label">Opens a shop</span>
          <select value={fx.shopId} onChange={(e) => set({ kind: 'shop', shopId: e.target.value })}>
            <option value="">Chosen when sent (or any open shop)</option>
            {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      <button type="button" className="btn ghost small blk-x" aria-label="Remove" onClick={del}>✕</button>
    </div>
  );
}

function AnswerEdit({ o, set, del, order, onNew, money, shops, timedOut }: { o: Option; set: (o: Option) => void; del: () => void; order: Node[]; onNew: () => string; money: (cp: number) => string; shops: { id: string; name: string }[]; timedOut: boolean }) {
  return (
    <div className="blk blk-tone-gold edit" data-testid="blk-answer">
      <BlockRow>
        <i className="fa-solid fa-comment blk-ico" aria-hidden="true" />
        <input className="input blk-grow" value={o.label} placeholder="What the player does" aria-label="Answer" onChange={(e) => set({ ...o, label: e.target.value })} maxLength={120} />
        <GoPicker order={order} value={o.next} onChange={(v) => set({ ...o, next: v })} onNew={onNew} />
        <button type="button" className="btn ghost small blk-x" aria-label="Remove answer" onClick={del}>✕</button>
      </BlockRow>
      {timedOut && <span className="tiny faint"><i className="fa-solid fa-hourglass-end" aria-hidden="true" /> Picked for them when time runs out</span>}
      {o.effects.map((fx, k) => <FxEdit key={k} fx={fx} money={money} shops={shops} set={(f) => set({ ...o, effects: o.effects.map((x, m) => (m === k ? f : x)) })} del={() => set({ ...o, effects: o.effects.filter((_, m) => m !== k) })} />)}
      {o.effects.length < 3 && <Palette items={FX_ADD} onAdd={(fx) => set({ ...o, effects: [...o.effects, fx] })} />}
    </div>
  );
}

function GameEdit({ g, set, del, order, onNewWin, onNewLose, money }: { g: Game; set: (g: Game) => void; del: () => void; order: Node[]; onNewWin: () => string; onNewLose: () => string; money: (cp: number) => string }) {
  const kind = (
    <select className="input blk-pick" aria-label="Kind of roll" value={g.kind} onChange={(e) => set({ ...g, kind: e.target.value as GameKind, dc: e.target.value === 'check' ? g.dc ?? 12 : null })}>
      {(Object.keys(GAME_NAME) as GameKind[]).map((k) => <option key={k} value={k}>{GAME_NAME[k]}</option>)}
    </select>
  );
  const pass = <GoPicker order={order} required value={g.win} onChange={(v) => set({ ...g, win: v ?? g.win })} onNew={onNewWin} label="On a pass go to" />;
  const fail = <GoPicker order={order} required value={g.lose} onChange={(v) => set({ ...g, lose: v ?? g.lose })} onNew={onNewLose} label="On a fail go to" />;
  const coin = (g.kind !== 'check' || g.stakeCp > 0 || g.winCp > 0) && (
    <BlockRow>
      <CoinInput label="Stake" cp={g.stakeCp} money={money} onChange={(cp) => set({ ...g, stakeCp: cp })} />
      <CoinInput label="Win pays" cp={g.winCp} money={money} onChange={(cp) => set({ ...g, winCp: cp })} />
    </BlockRow>
  );
  if (g.kind === 'check') {
    return <>
      <CheckBlock skill={g.skill} dc={g.dc} dcMax={g.dcMax} head={kind} help={GAME_HELP.check} pass={pass} fail={fail} onRemove={del}
        onChange={(v) => set({ ...g, skill: v.skill, dc: v.dc, dcMax: v.dcMax })} />
      {coin}
    </>;
  }
  // A coin toss, shell game or dice duel: no skill or DC, the same pass and fail.
  return (
    <div className="blk blk-tone-teal edit" data-testid="blk-check">
      <BlockRow>
        <i className="fa-solid fa-dice-d20 blk-ico" aria-hidden="true" />
        {kind}
        <button type="button" className="btn ghost small blk-x" aria-label="Remove the roll" onClick={del}>✕</button>
      </BlockRow>
      <span className="tiny faint">{GAME_HELP[g.kind]}</span>
      <div className="blk-outcome blk-outcome-pass"><span className="blk-ok">✓ Win</span><div className="blk-slot">{pass}</div></div>
      <div className="blk-outcome blk-outcome-fail"><span className="blk-bad">✗ Lose</span><div className="blk-slot">{fail}</div></div>
      {coin}
    </div>
  );
}

/** Every step of a script as editable block cards, in reading order. onFill adds a "Fill" button to each step. */
export function StepBlocks({ script, setScript, money, shops, eventKind, onFill, filling = null }: {
  script: Script; setScript: (s: Script) => void; money: (cp: number) => string; shops: { id: string; name: string }[]; eventKind: boolean;
  onFill?: (step: string) => void; filling?: string | null;
}) {
  const order = stepOrder(script);
  const ids = script.nodes.map((n) => n.id);
  const setNode = (id: string, n: Node) => {
    // Renaming a step renames every link to it.
    const ren = (x: string | null) => (x === id ? n.id : x);
    const nodes = script.nodes.map((x) => (x.id === id ? n : x)).map((x) => (n.id === id ? x : { ...x, options: x.options.map((o) => ({ ...o, next: ren(o.next) })), game: x.game && { ...x.game, win: ren(x.game.win)!, lose: ren(x.game.lose)! } }));
    setScript({ start: script.start === id ? n.id : script.start, nodes });
  };
  const addStep = () => setScript({ ...script, nodes: [...script.nodes, { id: slug('step', ids), text: '', options: [], game: null }] });
  // A picker that makes a new step must also set its own link in the same update, so each picker's onNew builds
  // the step and the caller sets the link from the returned id against the new script.
  const withNew = (fn: (s: Script, id: string) => Script) => () => {
    const id = slug('step', ids);
    setScript(fn({ ...script, nodes: [...script.nodes, { id, text: '', options: [], game: null }] }, id));
    return id;
  };
  const del = (id: string) => {
    const nodes = script.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, options: n.options.map((o) => (o.next === id ? { ...o, next: null } : o)), game: n.game && (n.game.win === id || n.game.lose === id) ? null : n.game }));
    setScript({ start: script.start === id ? nodes[0]?.id ?? '' : script.start, nodes });
  };
  return (
    <ol className="blk-flow edit" data-testid="step-blocks">
      {order.map((n, i) => {
        const put = (m: Node) => setNode(n.id, m);
        const patch = (s: Script, m: (x: Node) => Node) => ({ ...s, nodes: s.nodes.map((x) => (x.id === n.id ? m(x) : x)) });
        const addCheck = () => {
          // A new check comes with a step for each outcome, ready to write.
          const win = slug(`${n.id}-pass`, ids), lose = slug(`${n.id}-fail`, [...ids, win]);
          const s = patch(script, (x) => ({ ...x, game: { kind: 'check', skill: null, dc: 10, dcMax: 14, stakeCp: 0, winCp: 0, win, lose } }));
          setScript({ ...s, nodes: [...s.nodes, { id: win, text: '', options: [], game: null }, { id: lose, text: '', options: [], game: null }] });
        };
        return (
          <StepCard key={script.nodes.indexOf(n)} num={i + 1} anchor={`flow-${n.id}`} edit testid="blk-step" data={{ step: n.id }}
            title={<input className="input blk-id" aria-label="Step name" value={n.id} onChange={(e) => put({ ...n, id: e.target.value.replace(/[^\w-]/g, '').slice(0, 40) || n.id })} />}
            badges={<>
              {n.id === script.start ? <span className="chip gold">Start</span> : <button type="button" className="btn ghost small" onClick={() => setScript({ ...script, start: n.id })}>Make start</button>}
              {onFill && <button type="button" className="btn ghost small" disabled={filling !== null} onClick={() => onFill(n.id)} title="Fill this step's blanks with the assistant" data-testid="blk-fill-step">
                <i className={`fa-solid ${filling === n.id ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`} aria-hidden="true" /> Fill</button>}
              {script.nodes.length > 1 && <button type="button" className="btn ghost small blk-x" aria-label={`Remove step ${i + 1}`} onClick={() => del(n.id)}><i className="fa-solid fa-trash" aria-hidden="true" /></button>}
            </>}>
            <textarea className="input blk-text" rows={2} aria-label={eventKind ? 'What happens' : 'What the NPC says'} placeholder={eventKind ? 'What happens, in a sentence or two' : 'What the NPC says'} value={n.text} onChange={(e) => put({ ...n, text: e.target.value })} maxLength={1000} />

            {n.timer && (
              <Block tone="red" icon="fa-stopwatch" edit testid="blk-timer" removeLabel="Remove the timer" onRemove={() => put({ ...n, timer: null })}>
                <input className="input blk-num-in" inputMode="numeric" aria-label="Seconds to answer" value={n.timer.secs} onChange={(e) => put({ ...n, timer: { ...n.timer!, secs: Math.min(600, Number(e.target.value.replace(/\D/g, '')) || 0) } })} />
                <span className="small">seconds, then</span>
                <select className="input blk-pick" aria-label="If time runs out" value={n.timer.fallback} onChange={(e) => put({ ...n, timer: { ...n.timer!, fallback: Number(e.target.value) } })}>
                  {n.game && <option value={-1}>{n.game.kind === 'check' ? 'the check fails' : 'they lose the game'}</option>}
                  {n.options.map((o, j) => <option key={j} value={j}>“{o.label || `Answer ${j + 1}`}”</option>)}
                </select>
              </Block>
            )}
            {n.game && <GameEdit g={n.game} money={money} order={order} set={(g) => put({ ...n, game: g })} del={() => put({ ...n, game: null, timer: n.timer && n.timer.fallback === -1 ? null : n.timer })}
              onNewWin={withNew((s, id) => patch(s, (x) => ({ ...x, game: x.game && { ...x.game, win: id } })))}
              onNewLose={withNew((s, id) => patch(s, (x) => ({ ...x, game: x.game && { ...x.game, lose: id } })))} />}
            {n.options.map((o, j) => (
              <AnswerEdit key={j} o={o} order={order} money={money} shops={shops} timedOut={!!n.timer && n.timer.fallback === j}
                set={(m) => put({ ...n, options: n.options.map((x, k) => (k === j ? m : x)) })}
                del={() => put({ ...n, options: n.options.filter((_, k) => k !== j), timer: n.timer && n.timer.fallback >= j ? { ...n.timer, fallback: Math.max(n.game ? -1 : 0, n.timer.fallback - (n.timer.fallback === j ? 0 : 1)) } : n.timer })}
                onNew={withNew((s, id) => patch(s, (x) => ({ ...x, options: x.options.map((y, k) => (k === j ? { ...y, next: id } : y)) })))} />
            ))}

            <AddBar items={[
              { key: 'answer', label: 'Answer', icon: 'fa-comment', hidden: n.options.length >= 6, onAdd: () => put({ ...n, options: [...n.options, { label: '', next: null, effects: [] }] }) },
              { key: 'check', label: 'Check', icon: 'fa-dice-d20', hidden: !!n.game, onAdd: addCheck },
              { key: 'timer', label: 'Timer', icon: 'fa-stopwatch', hidden: !!n.timer || !(n.options.length > 0 || n.game), onAdd: () => put({ ...n, timer: { secs: 20, fallback: n.game ? -1 : Math.max(0, n.options.length - 1) } }) },
            ]} />
          </StepCard>
        );
      })}
      {script.nodes.length < 40 && <li className="blk-newstep"><button type="button" className="btn" onClick={addStep}>+ Step</button></li>}
    </ol>
  );
}
