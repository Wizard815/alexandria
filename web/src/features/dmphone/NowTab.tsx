// Now: whose turn it is and the next two, tap one for big HP buttons, a
// numeric pad and condition chips. Plus the date, the session and the counts.
import { useState } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { useAction } from '../../ui/index.tsx';
import { Sheet, Err } from './Sheet.tsx';
import { buzz, type Undo } from './hooks.ts';

export interface Combatant { id: string; name: string; initiative: number; hp: number | null; max_hp: number | null; effects: { name: string; rounds?: number; until?: unknown }[]; hidden: boolean; is_pc: boolean; ac?: number | null; temp_hp?: number; concentration?: { spell: string; dc: number | null } | null; death_saves?: { successes: number; failures: number; stable?: boolean; dead?: boolean } | null }
export interface Summary {
  date: { label: string; minutes: number };
  combat: { active: boolean; round: number; turn: number; total: number; current: Combatant | null; next: Combatant[] };
  session: { recording: boolean; recordingName: string | null; chatSession: { id: string; title: string } | null };
  models: { ready: number; total: number; loading: boolean; failed: boolean };
  counts: { approvals: number; broker: number; requests: number; all: number; coin: number; items: number; disputes: number; agent: number };
}

export const CONDITIONS = ['Prone', 'Poisoned', 'Stunned', 'Blinded', 'Frightened', 'Grappled', 'Restrained', 'Charmed', 'Paralyzed', 'Concentrating', 'Invisible', 'Unconscious'];

const hpClass = (hp: number | null, max: number | null) => {
  if (hp === null || !max) return '';
  const p = hp / max;
  return p <= 0.25 ? 'low' : p <= 0.5 ? 'mid' : '';
};

export default function NowTab({ sum, onUndo, goQueue, onAsk }: { sum: ReturnType<typeof useLoad<Summary>>; onUndo: (u: Undo) => void; goQueue: () => void; onAsk: (x: { id: string; name: string }) => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Shown HP while a change is on its way to the server.
  const [over, setOver] = useState<Record<string, number>>({});
  const full = useLoad<any>(() => (all || open ? w.combat() : Promise.resolve(null)), [w, all, !!open], ['combat']);
  const s = sum.data;
  const c = s?.combat;

  const known: Combatant[] = all && full.data?.combatants ? full.data.combatants : [...(c?.current ? [c.current] : []), ...(c?.next ?? [])];
  const byId = (id: string) => known.find((x) => x.id === id) ?? full.data?.combatants?.find((x: Combatant) => x.id === id) ?? null;
  const hpOf = (x: Combatant) => (over[x.id] !== undefined ? over[x.id] : x.hp);
  // The full record (temporary HP, concentration, death saves) when it has loaded; the summary's copy until then.
  const selected = open ? (full.data?.combatants?.find((x: Combatant) => x.id === open) ?? byId(open)) : null;

  const refresh = async () => { await Promise.all([sum.reload(), full.reload()]); };
  // Damage and healing go to the server as damage and healing, so its rules apply: temporary HP soak damage first, a
  // concentration save comes due, a downed character takes death save failures. Undo puts HP and temporary HP back.
  const change = async (x: Combatant, delta: number, crit = false, withUndo = true) => {
    const prev = hpOf(x);
    if (prev === null || !delta) return;
    const prevTemp = x.temp_hp ?? 0;
    const shown = delta < 0 ? Math.max(0, prev - Math.max(0, -delta - prevTemp)) : Math.max(0, x.max_hp ? Math.min(prev + delta, x.max_hp) : prev + delta);
    buzz(delta < 0 ? [14, 30, 14] : 14);
    setOver((o) => ({ ...o, [x.id]: shown }));
    try {
      const r: any = await w.updateCombatant(x.id, delta < 0 ? { damage: -delta, ...(crit ? { crit: true } : {}) } : { heal: delta });
      const notes: string[] = Array.isArray(r?.notes) ? r.notes : [];
      if (withUndo) onUndo({ text: `${x.name} ${delta > 0 ? '+' : '−'}${Math.abs(delta)}${crit ? ' (crit)' : ''}${notes.length ? `. ${notes.join('. ')}` : ''}`, undo: () => { void act.run(async () => { await w.updateCombatant(x.id, { hp: prev, setTempHp: prevTemp }); await refresh(); }); } });
    } catch (e: any) {
      act.setError(e.message ?? String(e));
    } finally {
      await refresh();
      setOver((o) => { const n = { ...o }; delete n[x.id]; return n; });
    }
  };
  const patch = (x: Combatant, p: Record<string, unknown>) => act.run(async () => { await w.updateCombatant(x.id, p); await refresh(); });
  const next = () => act.run(async () => { buzz(20); await (c?.active ? w.nextTurn() : w.call('PUT', '/live/combat', { active: true, round: 1, turn: 0 })); await refresh(); });

  const who = (x: Combatant, cur: boolean) => {
    const hp = hpOf(x);
    return (
      <button key={x.id} type="button" className={`who${cur ? ' cur' : ''}`} onClick={() => { buzz(8); setOpen(x.id); }} aria-label={`${x.name}, ${hp ?? 'no'} hit points`}>
        <span className="init">{x.initiative}</span>
        <span className="grow tx">
          <b style={{ fontSize: cur ? 20 : 17 }}>{x.name}</b>{x.hidden && <span className="pill red" style={{ marginLeft: 6 }}>hidden</span>}
          {(x.effects?.length > 0 || x.concentration || (x.temp_hp ?? 0) > 0 || x.death_saves) && <span className="sub" style={{ display: 'block' }}>{[
            (x.temp_hp ?? 0) > 0 ? `+${x.temp_hp} temp` : '',
            x.concentration ? `concentrating: ${x.concentration.spell}${x.concentration.dc !== null ? ` (save DC ${x.concentration.dc})` : ''}` : '',
            x.death_saves && !x.death_saves.stable && !x.death_saves.dead ? `death saves ${x.death_saves.successes}✓ ${x.death_saves.failures}✗` : '',
            ...(x.effects ?? []).map((e) => `${e.name}${e.rounds ? ` (${e.rounds})` : ''}`),
          ].filter(Boolean).join(' · ')}</span>}
          {hp !== null && x.max_hp ? <span className={`hpbar ${hpClass(hp, x.max_hp)}`} style={{ display: 'block', marginTop: 4 }}><span style={{ width: `${Math.max(0, Math.min(100, (hp / x.max_hp) * 100))}%` }} /></span> : null}
        </span>
        {hp !== null && <span style={{ fontWeight: 700, fontSize: 18 }}>{hp}<span className="sub">/{x.max_hp}</span></span>}
      </button>
    );
  };

  const n = s?.counts;
  return (
    <>
      <Err error={sum.error || act.error} />
      {s && (
        <div className="c" aria-label="Session">
          <div className="row between"><b>{s.date.label}</b></div>
          <div className="flow">
            <span className={`pill ${s.session.recording ? 'red' : ''}`}><i className={`fa-solid ${s.session.recording ? 'fa-circle' : 'fa-microphone-slash'}`} aria-hidden="true" /> {s.session.recording ? 'Recording' : 'Not recording'}</span>
            <span className={`pill ${s.models.failed ? 'red' : s.models.total && s.models.ready === s.models.total ? 'green' : ''}`}><i className="fa-solid fa-microchip" aria-hidden="true" /> {s.models.total ? (s.models.ready === s.models.total ? 'Models ready' : s.models.loading ? 'Models loading' : `Models ${s.models.ready}/${s.models.total}`) : 'Models cloud/none'}</span>
            <button type="button" className={`pill ${n && n.approvals ? 'gold' : ''}`} style={{ background: 'transparent', minHeight: 36, cursor: 'pointer' }} onClick={goQueue}>Approvals {n?.approvals ?? 0}</button>
            <button type="button" className={`pill ${n && n.broker ? 'gold' : ''}`} style={{ background: 'transparent', minHeight: 36, cursor: 'pointer' }} onClick={goQueue}>Broker {n?.broker ?? 0}</button>
          </div>
        </div>
      )}
      {c && c.total > 0 ? (
        <>
          <div className="row between"><h2>{c.active ? `Round ${c.round}` : 'Combat not started'}</h2><span className="sub">{c.total} in the fight</span></div>
          {all ? (
            <div className="grid">{(full.data?.combatants ?? []).map((x: Combatant, i: number) => who(x, !!c.active && i === c.turn % c.total))}</div>
          ) : (
            <div className="grid">
              {c.current && who(c.current, c.active)}
              {c.next.length > 0 && <span className="sub">Next up</span>}
              {c.next.map((x) => who(x, false))}
            </div>
          )}
          <button type="button" className="b" onClick={() => setAll(!all)}>{all ? 'Show next 2 only' : `Show all ${c.total}`}</button>
        </>
      ) : <div className="c"><div className="empty">No one in the fight. Add combatants on the desktop, or ask the assistant.</div></div>}

      {c && c.total > 0 && (
        <div style={{ position: 'sticky', bottom: 0, paddingTop: 8, background: 'linear-gradient(transparent, var(--bg) 30%)' }}>
          <button type="button" className="b primary big full" disabled={act.busy} onClick={() => void next()}>{c.active ? 'Next turn' : 'Start combat'} <i className="fa-solid fa-forward-step" aria-hidden="true" /></button>
        </div>
      )}

      {selected && (
        <Sheet title={selected.name} onClose={() => setOpen(null)}>
          <HpPanel x={selected} hp={hpOf(selected)} change={(dv, crit) => void change(selected, dv, crit)} patch={(p) => void patch(selected, p)} busy={act.busy} />
          {c?.active && <button type="button" className="b primary big full" disabled={act.busy} onClick={() => { void next(); }}>Next turn</button>}
          <button type="button" className="b full" onClick={() => { buzz(10); onAsk({ id: selected.id, name: selected.name }); setOpen(null); }}><i className="fa-solid fa-comments" aria-hidden="true" /> Ask the assistant about this</button>
        </Sheet>
      )}
    </>
  );
}

function HpPanel({ x, hp, change, patch, busy }: { x: Combatant; hp: number | null; change: (delta: number, crit?: boolean) => void; patch: (p: Record<string, unknown>) => void; busy: boolean }) {
  const [amt, setAmt] = useState('');
  const [crit, setCrit] = useState(false);
  const n = parseInt(amt, 10) || 0;
  const apply = (sign: 1 | -1) => { if (hp === null || !n) return; change(sign * n, sign < 0 && crit); setAmt(''); setCrit(false); };
  const on = new Set((x.effects ?? []).map((e) => e.name.toLowerCase()));
  const toggle = (name: string) => patch({ effects: on.has(name.toLowerCase()) ? x.effects.filter((e) => e.name.toLowerCase() !== name.toLowerCase()) : [...(x.effects ?? []), { name }] });
  const conc = x.concentration;
  const ds = x.death_saves;
  const downed = x.is_pc && hp === 0 && !(ds?.stable || ds?.dead);
  return (
    <>
      <div className="row between">
        <span className="hpbig" aria-live="polite" data-testid="hp-now">{hp ?? '—'}<span className="sub" style={{ fontSize: 18 }}> / {x.max_hp ?? '—'}</span></span>
        <span className="row" style={{ gap: 6 }}>
          {(x.temp_hp ?? 0) > 0 && <button type="button" className="pill" title="Temporary HP: tap to clear" onClick={() => patch({ setTempHp: 0 })} data-testid="phone-temp">+{x.temp_hp} temp ×</button>}
          {x.ac != null && <span className="pill">AC {x.ac}</span>}
        </span>
      </div>
      {conc && (
        <div className="row between" data-testid="phone-conc">
          <span>Concentrating on <strong>{conc.spell}</strong>{conc.dc !== null && <> · <strong>CON save DC {conc.dc}</strong> due</>}</span>
          <span className="row" style={{ gap: 6 }}>
            {conc.dc !== null && <button type="button" className="b ok" disabled={busy} onClick={() => patch({ concentrationSave: { result: 'pass' } })}>Passed</button>}
            {conc.dc !== null && <button type="button" className="b danger" disabled={busy} onClick={() => patch({ concentrationSave: { result: 'fail' } })}>Failed</button>}
            {conc.dc === null && <button type="button" className="b" disabled={busy} onClick={() => patch({ concentration: null })}>Drop</button>}
          </span>
        </div>
      )}
      {ds && (ds.stable || ds.dead) && <div className="pill" data-testid="phone-ds-state">{ds.dead ? 'Dead' : 'Stable'}</div>}
      {downed && (
        <div data-testid="phone-death">
          <div className="row between"><strong>Death saves</strong><span>{'✓'.repeat(ds?.successes ?? 0)}{'·'.repeat(3 - (ds?.successes ?? 0))} &nbsp; {'✗'.repeat(ds?.failures ?? 0)}{'·'.repeat(3 - (ds?.failures ?? 0))}</span></div>
          <div className="grid g2">
            <button type="button" className="b ok big" disabled={busy} onClick={() => patch({ deathSave: { result: 'success' } })}>Success</button>
            <button type="button" className="b danger big" disabled={busy} onClick={() => patch({ deathSave: { result: 'failure' } })}>Failure</button>
            <button type="button" className="b ok" disabled={busy} onClick={() => patch({ deathSave: { roll: 20 } })}>Nat 20: up at 1 HP</button>
            <button type="button" className="b danger" disabled={busy} onClick={() => patch({ deathSave: { roll: 1 } })}>Nat 1: two failures</button>
          </div>
        </div>
      )}
      {hp !== null && (
        <>
          <div className="grid g3">
            {[1, 5, 10].map((d) => <button key={`-${d}`} type="button" className="b danger big" disabled={busy} onClick={() => change(-d)}>−{d}</button>)}
            {[1, 5, 10].map((d) => <button key={`+${d}`} type="button" className="b ok big" disabled={busy} onClick={() => change(d)}>+{d}</button>)}
          </div>
          <div className="amount c" style={{ padding: 8 }} aria-label="Amount">{amt || '0'}</div>
          <div className="pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <button key={k} type="button" className="b" onClick={() => setAmt((a) => (a + k).slice(0, 4))}>{k}</button>)}
            <button type="button" className="b" onClick={() => setAmt('')} aria-label="Clear">C</button>
            <button type="button" className="b" onClick={() => setAmt((a) => (a + '0').slice(0, 4))}>0</button>
            <button type="button" className="b" onClick={() => setAmt((a) => a.slice(0, -1))} aria-label="Backspace"><i className="fa-solid fa-delete-left" aria-hidden="true" /></button>
          </div>
          <div className="grid g2">
            <button type="button" className="b danger big" disabled={busy || !n} onClick={() => apply(-1)}>Damage {n || ''}</button>
            <button type="button" className="b ok big" disabled={busy || !n} onClick={() => apply(1)}>Heal {n || ''}</button>
            <button type="button" className="b" disabled={busy || !n} title="Temporary HP never stack: the higher number is kept" onClick={() => { patch({ tempHp: n }); setAmt(''); }}>Temp HP {n || ''}</button>
            <button type="button" className={`b${crit ? ' on' : ''}`} aria-pressed={crit} onClick={() => setCrit((v) => !v)} title="A critical hit: two death save failures on a downed character">Crit {crit ? 'on' : 'off'}</button>
          </div>
        </>
      )}
      <h3 className="sub" style={{ margin: 0 }}>Conditions</h3>
      <div className="flow">{CONDITIONS.map((cn) => { const e = (x.effects ?? []).find((y) => y.name.toLowerCase() === cn.toLowerCase()); return <button key={cn} type="button" className={`b chip${e ? ' on' : ''}`} aria-pressed={!!e} disabled={busy} onClick={() => toggle(cn)}>{cn}{e?.rounds ? ` (${e.rounds})` : e?.until ? ' (timed)' : ''}</button>; })}</div>
    </>
  );
}
