// The player's side of DownTime: the popup when the DM presses Downtime (pick
// what to spend the days on, skip, or make a new activity), the Downtime page
// (my tasks, start one, my log) and the sheet module.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { timeShort } from '../../lib/format.ts';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, PageHead, useAction, useToast } from '../../ui/index.tsx';
import { CSS, GroupChip, KIND_LABEL, Progress, TierChip, isOpen, outcomeText, rewardText, splitScope, useDowntime, type DtEvent, type Activity, type LogLine, type Overview, type Ranked, type Task } from './shared.tsx';

const FOLD = 'alx.downtime.later';

/** Over every player page: the open Downtime round until I answer (or fold it to a chip). */
export function DowntimePopup() {
  const { info } = useWorld();
  if (info.role !== 'player' || (info.settings as any).downtimeOn !== true) return null;
  return <PopupInner />;
}

function PopupInner() {
  const o = useDowntime();
  const [later, setLater] = useState<string | null>(() => { try { return sessionStorage.getItem(FOLD); } catch { return null; } });
  const r = o.data?.round;
  const pending = o.data?.events ?? [];
  if (!o.data) return null;
  // After the pick (or with no round open): an event that happened on those days waits for a roll.
  if ((!r || r.mine) && pending.length) {
    const key = `ev:${pending[0].id}`;
    const fold = (v: string | null) => { setLater(v); try { if (v) sessionStorage.setItem(FOLD, v); else sessionStorage.removeItem(FOLD); } catch { /* private */ } };
    if (later === key) return <button type="button" className="btn dt-chip" data-testid="downtime-event-chip" onClick={() => fold(null)}><style>{CSS}</style><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Downtime event: roll</button>;
    return <EventModal events={pending} onClose={() => fold(key)} onDone={() => void o.reload()} />;
  }
  if (!r || r.mine) return null;
  const fold = (v: string | null) => { setLater(v); try { if (v) sessionStorage.setItem(FOLD, v); else sessionStorage.removeItem(FOLD); } catch { /* private */ } };
  if (later === r.id) {
    return <button type="button" className="btn dt-chip" data-testid="downtime-chip" onClick={() => fold(null)}><style>{CSS}</style><i className="fa-solid fa-hourglass-half" aria-hidden="true" /> {r.kind === 'travel' ? 'Travel' : 'Downtime'}: pick your {r.days === 1 ? 'day' : `${r.days} days`}</button>;
  }
  return <PickModal o={o.data} onClose={() => fold(r.id)} onDone={() => void o.reload()} />;
}

type NewAct = { name: string; summary: string; group?: boolean };
type Choice = { key: string; taskId?: string; activityId?: string; activity?: NewAct; days: number; label: string; perDay: number };

/** The popup: my tasks with days on each, start one from the list, make a new one, or skip. */
export function PickModal({ o, onClose, onDone, player }: { o: Overview; onClose: () => void; onDone: () => void; player?: string }) {
  const { w, me } = useWorld();
  const act = useAction();
  const r = o.round!;
  // My own tasks, and the party's group tasks (working on one joins it). The DM paused a group task: nobody works it.
  const mine = o.tasks.filter((t) => isOpen(t) && (t.scope === 'group' ? t.status !== 'paused' : !player || t.accountId === player));
  const split = splitScope(mine);
  const prev = r.mine?.picks ?? [];
  const [choices, setChoices] = useState<Choice[]>(() => prev.map((p) => { const t = mine.find((x) => x.id === p.taskId); return { key: p.taskId, taskId: p.taskId, days: p.days, label: p.name, perDay: (t?.perDayMin ?? o.dayHours * 60) / 60 }; }));
  // Open on my tasks when I have some of my own (or joined a group one); else on starting something.
  const [mode, setMode] = useState<'mine' | 'start' | 'new'>(split.personal.length || split.group.some((t) => t.members.includes(player ?? me)) ? 'mine' : 'start');
  // A travel day has only a few hours: each task gets at most that much of each day.
  const dayH = r.hoursPerDay ?? o.dayHours;
  const travel = r.kind === 'travel';
  const per = (c: { perDay: number }) => Math.min(c.perDay, dayH);
  const used = choices.reduce((n, c) => n + c.days * per(c), 0);
  const left = r.days * dayH - used;
  const toggle = (c: Choice) => setChoices((l) => (l.some((x) => x.key === c.key) ? l.filter((x) => x.key !== c.key) : [...l, { ...c, days: Math.max(1, Math.min(c.days, Math.floor((left + 0) / Math.min(c.perDay, dayH)) || 1)) }]));
  const setDays = (key: string, days: number) => setChoices((l) => l.map((x) => (x.key === key ? { ...x, days: Math.max(1, Math.min(r.days, days)) } : x)));
  const send = (skip: boolean) => act.run(async () => {
    await w.call('POST', '/downtime/rounds/current/pick', skip ? { skip: true, player } : {
      player,
      picks: choices.map((c) => (c.taskId ? { taskId: c.taskId, days: c.days } : c.activityId ? { activityId: c.activityId, days: c.days } : { activity: c.activity, days: c.days })),
    });
    onDone();
  });
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back">
      <style>{CSS}</style>
      <div className="modal stack" role="dialog" aria-modal="true" aria-labelledby="dt-pick" data-testid="downtime-popup" style={{ maxWidth: 640 }}>
        <div className="row between">
          <span className="tiny muted">{r.worldLabel}{r.note ? ` · ${r.note}` : ''}</span>
          <button type="button" className="btn ghost small" onClick={onClose}>Later</button>
        </div>
        <h2 id="dt-pick" style={{ margin: 0 }}>{travel ? 'Travel' : 'Downtime'}: {r.days === 1 ? 'one day' : `${r.days} days`}</h2>
        <p className="small muted" style={{ margin: 0 }}>{travel ? `On the road: ${dayH} hour${dayH === 1 ? '' : 's'} a day for downtime, ${r.days * dayH} in all. Every task moves at that pace.` : `${r.days * dayH} hours to spend. A daily task (an hour or two a day) fits beside a bigger one.`} {r.mine ? 'You already picked; a new pick replaces it.' : ''}</p>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }} role="tablist">
          {mine.length > 0 && <button type="button" role="tab" aria-selected={mode === 'mine'} className={`btn small${mode === 'mine' ? ' on' : ''}`} onClick={() => setMode('mine')}>My tasks ({mine.length})</button>}
          <button type="button" role="tab" aria-selected={mode === 'start'} className={`btn small${mode === 'start' ? ' on' : ''}`} onClick={() => setMode('start')}>Start something</button>
          {o.playerNew !== 'off' && <button type="button" role="tab" aria-selected={mode === 'new'} className={`btn small${mode === 'new' ? ' on' : ''}`} onClick={() => setMode('new')}>Make a new activity</button>}
        </div>
        {mode === 'mine' && (
          <div className="stack tight">
            {([['personal', 'Personal', split.personal], ['group', "Group · the party's", split.group]] as const).map(([k, title, list]) => list.length > 0 && (
              <div key={k} className="stack tight" data-testid={`downtime-pick-${k}`}>
                {split.personal.length > 0 && split.group.length > 0 && <h3 className="dt-scope">{k === 'group' && <i className="fa-solid fa-people-group" aria-hidden="true" />}{title}</h3>}
                {list.map((t) => {
              const on = choices.find((c) => c.key === t.id);
              const who = player ?? me;
              return (
                <div key={t.id} className="dt-task">
                  <label className="row between" style={{ gap: 8 }}>
                    <span className="row" style={{ gap: 8 }}>
                      <input type="checkbox" checked={!!on} onChange={() => toggle({ key: t.id, taskId: t.id, days: Math.min(r.days, t.daysLeft || 1), label: t.name, perDay: t.perDayMin / 60 })} />
                      <strong>{t.name}</strong> <TierChip tier={t.tier} label={t.tierLabel} />
                      {t.scope === 'group' && <GroupChip />}
                      {t.status === 'proposed' && <span className="tiny muted">waiting for the DM</span>}
                    </span>
                    <span className="tiny muted">{t.leftLabel} left{t.perDayMin / 60 < o.dayHours ? ` · ${t.perDayMin / 60}h a day` : ''}</span>
                  </label>
                  <Progress t={t} />
                  {t.scope === 'group' && <span className="tiny muted">{t.members.includes(who) ? `You and ${Math.max(0, t.members.length - 1)} other${t.members.length === 2 ? '' : 's'} on it` : 'Spending days on it joins you to it'}</span>}
                </div>
              );
            })}
              </div>
            ))}
          </div>
        )}
        {mode === 'start' && <StartList player={player} onPick={(a) => toggle({ key: `a:${a.id}`, activityId: a.id, days: Math.min(r.days, a.daysNeeded), label: a.name, perDay: a.hoursPerDay })} picked={choices.map((c) => c.key)} />}
        {mode === 'new' && <NewActivity playerNew={o.playerNew} onAdd={(a, perDay) => { toggle({ key: `n:${a.name}`, activity: a, days: r.days, label: a.name, perDay }); setMode(mine.length ? 'mine' : 'start'); }} />}
        {choices.length > 0 && (
          <section className="card stack tight">
            <strong className="small">Your pick</strong>
            {choices.map((c) => (
              <div key={c.key} className="row between" style={{ gap: 8 }}>
                <span>{c.label}{c.activity ? ' (new)' : c.activityId ? ' (start)' : ''}</span>
                <span className="dt-step">
                  <button type="button" className="btn small" aria-label={`One day less on ${c.label}`} onClick={() => setDays(c.key, c.days - 1)} disabled={c.days <= 1}>−</button>
                  <span className="small">{c.days} day{c.days === 1 ? '' : 's'}{per(c) < o.dayHours ? ` × ${per(c)}h` : ''}</span>
                  <button type="button" className="btn small" aria-label={`One day more on ${c.label}`} onClick={() => setDays(c.key, c.days + 1)} disabled={c.days >= r.days}>＋</button>
                  <button type="button" className="btn small ghost" aria-label={`Drop ${c.label}`} onClick={() => setChoices((l) => l.filter((x) => x.key !== c.key))}>✕</button>
                </span>
              </div>
            ))}
            <span className={`tiny ${left < 0 ? '' : 'muted'}`} style={left < 0 ? { color: 'var(--danger, #c33)' } : undefined}>{left < 0 ? `${-left} hours too many` : `${left} of ${r.days * dayH} hours left`}</span>
          </section>
        )}
        <ErrorBox error={act.error} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={act.busy} onClick={() => void send(true)} data-testid="downtime-skip">Skip</button>
          <button type="button" className="btn primary" disabled={act.busy || !choices.length || left < 0} onClick={() => void send(false)} data-testid="downtime-send">Spend the time</button>
        </div>
      </div>
    </div>
  );
}

/** Something happened during downtime: the event cards, one after another. */
function EventModal({ events, onClose, onDone }: { events: DtEvent[]; onClose: () => void; onDone: () => void }) {
  useEffect(() => {
    const k = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back">
      <style>{CSS}</style>
      <div className="modal stack" role="dialog" aria-modal="true" aria-labelledby="dt-ev" data-testid="downtime-event-popup" style={{ maxWidth: 520 }}>
        <div className="row between"><h2 id="dt-ev" style={{ margin: 0 }}><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Something happens</h2><button type="button" className="btn ghost small" onClick={onClose}>Later</button></div>
        <EventCard key={events[0].id} e={events[0]} onDone={onDone} />
        {events.length > 1 && <span className="tiny muted">{events.length - 1} more after this one</span>}
      </div>
    </div>
  );
}

/** One quick-time event: what happens, the check, the stakes, and the roll. */
export function EventCard({ e, onDone, dm = false }: { e: DtEvent; onDone?: () => void; dm?: boolean }) {
  const { w } = useWorld();
  const act = useAction();
  const [bonus, setBonus] = useState('');
  const [own, setOwn] = useState('');
  const [done, setDone] = useState<DtEvent | null>(null);
  const shown = done ?? e;
  // The player sees the result first and moves on with Continue; the DM's list just updates.
  const roll = (body: object) => act.run(async () => { setDone(await w.call<DtEvent>('POST', `/downtime/events/${e.id}/roll`, body)); if (dm) onDone?.(); });
  const decide = (result: string) => act.run(async () => { setDone(await w.call<DtEvent>('POST', `/downtime/events/${e.id}/decide`, { result })); onDone?.(); });
  return (
    <div className={`dt-event ${shown.status}`} data-testid="downtime-event">
      <span className="tiny muted">{e.player ? `${e.player} · ` : ''}During {e.task}</span>
      <strong>{e.title}</strong>
      {e.text && <span className="small">{e.text}</span>}
      {e.check && <span className="small"><strong>{e.check}</strong> check, DC {e.dc}</span>}
      <div className="dt-stakes">
        {outcomeText(e.success) && <span><span style={{ color: '#3f9d5a' }}>{e.check ? 'Success' : 'What happens'}:</span> {outcomeText(e.success)}</span>}
        {e.check && outcomeText(e.failure) && <span><span style={{ color: 'var(--danger, #c33)' }}>Failure:</span> {outcomeText(e.failure)}</span>}
      </div>
      {shown.status !== 'pending' ? (
        <div className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="small" data-testid="downtime-event-result"><strong style={{ color: shown.status === 'success' ? '#3f9d5a' : shown.status === 'failure' ? 'var(--danger, #c33)' : undefined }}>{shown.status === 'cancelled' ? 'Cancelled' : shown.status === 'success' ? 'Success' : 'Failure'}</strong>{shown.note ? <span className="muted"> · {shown.note.replace(/,? ?(success|failure)(: )?/, (_m: string, _r: string, more?: string) => (more ? ' → ' : ''))}</span> : null}</span>
          {!dm && done && <button type="button" className="btn small primary" onClick={() => onDone?.()} data-testid="downtime-event-continue">Continue</button>}
        </div>
      ) : (
        <>
          {!dm && (e.check ? (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="small">Your bonus <input className="input" type="number" min={-10} max={30} style={{ width: 64 }} value={bonus} onChange={(ev) => setBonus(ev.target.value)} aria-label={`Your ${e.check} bonus`} /></label>
              <button type="button" className="btn primary" disabled={act.busy} onClick={() => void roll({ bonus: bonus === '' ? 0 : Number(bonus) })} data-testid="downtime-event-roll"><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Roll</button>
              <span className="tiny muted">or my own dice:</span>
              <input className="input" type="number" min={-10} max={60} style={{ width: 64 }} value={own} onChange={(ev) => setOwn(ev.target.value)} aria-label="Total from my own dice" />
              <button type="button" className="btn" disabled={act.busy || own === ''} onClick={() => void roll({ total: Number(own) })}>Use it</button>
            </div>
          ) : <button type="button" className="btn primary" disabled={act.busy} onClick={() => void roll({})}>OK</button>)}
          {dm && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void decide('success')}>Success</button>
              {e.check && <button type="button" className="btn small" disabled={act.busy} onClick={() => void decide('failure')}>Failure</button>}
              <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void decide('cancel')}>Cancel it</button>
              <span className="tiny muted">or let the player roll</span>
            </div>
          )}
        </>
      )}
      <ErrorBox error={act.error} />
    </div>
  );
}

/** Activities I can start, by tier, with the helper's three suggestions on top. */
function StartList({ onPick, picked, player, scope: scope0 = 'all' }: { onPick: (a: Activity) => void; picked: string[]; player?: string; scope?: 'all' | 'personal' | 'group' }) {
  const { w } = useWorld();
  const list = useLoad<{ activities: Activity[] }>(() => w.call('GET', '/downtime/activities', undefined, player ? { player } : undefined), [w, player], ['downtime']);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState(scope0);
  const [want, setWant] = useState('');
  const [ranked, setRanked] = useState<{ picks: Ranked[]; by: string } | null>(null);
  const act = useAction();
  const shown = useMemo(() => (list.data?.activities ?? []).filter((a) => a.status !== 'hidden' && (scope === 'all' || (scope === 'group') === !!a.group)
    && (!q || `${a.name} ${a.summary} ${a.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))), [list.data, q, scope]);
  const ask = () => act.run(async () => setRanked(await w.call('POST', '/downtime/suggest', { want, player })));
  const card = (a: Activity, why?: string) => (
    <button key={a.id} type="button" className={`btn dt-act${picked.includes(`a:${a.id}`) ? ' on' : ''}`} aria-pressed={picked.includes(`a:${a.id}`)} onClick={() => onPick(a)}>
      <span className="row between" style={{ gap: 6 }}><strong>{a.name}</strong><span className="row" style={{ gap: 4 }}>{a.group && <GroupChip />}<TierChip tier={a.tier} label={a.tierLabel} /></span></span>
      <span className="tiny muted">{a.daysNeeded} day{a.daysNeeded === 1 ? '' : 's'}{a.hoursPerDay < 8 ? `, ${a.hoursPerDay}h a day` : ''}{a.link?.kind === 'spell-craft' ? ' · Codex' : ''}{a.events?.length ? ' · things can happen' : ''}{'text' in a.reward && (a.reward.text || a.reward.cp || a.reward.item) ? ` · ${rewardText(a.reward)}` : ''}</span>
      {why ? <span className="tiny">{why}</span> : <span className="tiny faint">{a.summary.slice(0, 110)}</span>}
    </button>
  );
  if (!list.data) return <Loading />;
  const byId = new Map(list.data.activities.map((a) => [a.id, a]));
  return (
    <div className="stack tight">
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <input className="input grow" value={want} onChange={(e) => setWant(e.target.value)} placeholder="What do you want from it? (earn coin, get stronger…)" aria-label="What you want from your downtime" />
        <button type="button" className="btn" disabled={act.busy} onClick={() => void ask()}><i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /> Suggest</button>
      </div>
      <ErrorBox error={act.error} />
      {ranked && (ranked.picks.length ? <div className="dt-acts">{ranked.picks.map((p) => (byId.get(p.id) ? card(byId.get(p.id)!, p.why) : null))}</div> : <p className="small muted">No suggestion this time.</p>)}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 4 }} role="group" aria-label="Personal or group">
          {([['all', 'All'], ['personal', 'Personal'], ['group', 'Group']] as const).map(([k, label]) => <button key={k} type="button" className={`btn small${scope === k ? ' on' : ''}`} aria-pressed={scope === k} onClick={() => setScope(k)} data-testid={`downtime-scope-${k}`}>{label}</button>)}
        </span>
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activities" aria-label="Search activities" />
      </div>
      {scope === 'group' && <p className="tiny muted" style={{ margin: 0 }}>Group activities belong to the whole party: everyone's days count toward one shared task, and the reward goes to the party.</p>}
      <div className="dt-acts" style={{ maxHeight: 320, overflow: 'auto' }}>{shown.map((a) => card(a))}</div>
    </div>
  );
}

/** A new activity: name and what it is; the helper rates its tier and length. */
function NewActivity({ onAdd, playerNew }: { onAdd: (a: NewAct, perDay: number) => void; playerNew: string }) {
  const { w } = useWorld();
  const act = useAction();
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [group, setGroup] = useState(false);
  const [dec, setDec] = useState<{ tierLabel: string; tier: any; days: number; hoursPerDay: number; why: string } | null>(null);
  const rate = () => act.run(async () => setDec(await w.call('POST', '/downtime/decide', { name, summary })));
  return (
    <div className="stack tight">
      <input className="input" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setDec(null); }} placeholder="Teach the orphans to read" aria-label="Activity name" />
      <textarea className="input" rows={2} value={summary} maxLength={600} onChange={(e) => { setSummary(e.target.value); setDec(null); }} placeholder="What you do, where, with whom" aria-label="What it is" />
      <label className="small"><input type="checkbox" checked={group} onChange={(e) => setGroup(e.target.checked)} data-testid="downtime-new-group" /> A group activity: the whole party can join it and shares its progress</label>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn" disabled={act.busy || !name.trim()} onClick={() => void rate()}>How big is it?</button>
        {dec && <span className="small"><TierChip tier={dec.tier} label={dec.tierLabel} /> {dec.days} day{dec.days === 1 ? '' : 's'}{dec.hoursPerDay < 8 ? `, ${dec.hoursPerDay}h a day` : ''} {dec.why && <span className="muted">· {dec.why}</span>}</span>}
        <button type="button" className="btn primary" disabled={!name.trim()} onClick={() => onAdd({ name: name.trim(), summary: summary.trim(), ...(group ? { group: true } : {}) }, dec?.hoursPerDay ?? 8)}>Add to my pick</button>
      </div>
      <ErrorBox error={act.error} />
      <span className="tiny muted">{playerNew === 'approve' ? 'The DM sets its tier and reward; the time you spend still counts.' : 'It starts right away.'}</span>
    </div>
  );
}

/** One task line: name, tier, progress, time left, reward. */
export function TaskLine({ t, children }: { t: Task; children?: React.ReactNode }) {
  return (
    <div className="dt-task" data-testid="downtime-task">
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <strong>{t.name}</strong> <TierChip tier={t.tier} label={t.tierLabel} />
          {t.scope === 'group' && <GroupChip />}
          {t.status !== 'active' && <span className="tiny muted">{t.status === 'proposed' ? 'waiting for the DM' : t.status}</span>}
          {t.player && t.scope !== 'group' && <span className="tiny faint">{t.player}</span>}
        </span>
        <span className="tiny muted">{t.status === 'done' ? `done in ${t.doneLabel}` : `${t.doneLabel} of ${t.needLabel}`}</span>
      </div>
      <Progress t={t} />
      {t.scope === 'group' && <span className="tiny muted" data-testid="downtime-members">{t.contributions.length ? t.contributions.map((c) => `${c.name || 'someone'} ${c.label}`).join(' · ') : t.memberNames?.length ? `${t.memberNames.join(', ')} joined` : 'Nobody on it yet'}</span>}
      <span className="tiny muted">{rewardText(t.reward) ? `Reward: ${rewardText(t.reward)}${t.rewardGivenAt ? ' (given)' : t.rewardWaiting ? ' (waiting for the DM)' : ''}` : ''}</span>
      {children}
    </div>
  );
}

export function LogList({ log }: { log: LogLine[] }) {
  if (!log.length) return <p className="small muted">Nothing logged yet.</p>;
  return (
    <div className="dt-log">
      {log.map((l) => (
        <div key={l.id} className={l.undone ? 'undone' : ''}>
          <span className="faint">{timeShort(l.at)} · {l.worldDate}</span> {l.player && <strong>{l.player}</strong>} {KIND_LABEL[l.kind] ?? l.kind}{l.task ? ` ${l.task}` : ''}{l.time ? ` (${l.time})` : ''}{l.note ? ` · ${l.note}` : ''}{l.by && l.by !== l.player ? <span className="faint"> · by {l.by}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** The player's Downtime page. */
export function PlayerDowntime() {
  const { w, me } = useWorld();
  const o = useDowntime();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [all, setAll] = useState(false);
  const [picking, setPicking] = useState(false);
  const tasks = useLoad<{ tasks: Task[] }>(() => w.call('GET', '/downtime/tasks', undefined, all ? { all: '1' } : undefined), [w, all], ['downtime', 'downtime-done']);
  const split = splitScope(tasks.data?.tasks ?? []);
  const log = useLoad<{ log: LogLine[] }>(() => w.call('GET', '/downtime/log', undefined, { limit: 60 }), [w], ['downtime', 'downtime-done']);
  const [starting, setStarting] = useState(false);
  if (!o.data) return <div className="page"><Loading /></div>;
  if (!o.data.on) return <div className="page"><PageHead title="Downtime" /><Empty>Downtime is off in this world.</Empty></div>;
  const run = (fn: () => Promise<unknown>, msg: string) => act.run(async () => { await fn(); toast(msg); });
  return (
    <div className="page stack">
      <style>{CSS}</style>
      <PageHead title="Downtime" lead={`What your character does between adventures. ${o.data.now}.`}>
        <button type="button" className="btn" onClick={() => setStarting((v) => !v)}>{starting ? 'Close' : '＋ Start an activity'}</button>
      </PageHead>
      {o.data.round && <section className="card row between" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span><strong>Downtime is on:</strong> {o.data.round.days} day{o.data.round.days === 1 ? '' : 's'}{o.data.round.mine ? (o.data.round.mine.skipped ? ' · you skipped' : ` · you picked ${o.data.round.mine.picks?.map((p) => p.name).join(', ')}`) : ''}</span>
        <button type="button" className="btn primary" onClick={() => setPicking(true)}>{o.data.round.mine ? 'Change my pick' : 'Pick'}</button>
      </section>}
      {picking && o.data.round && <PickModal o={o.data} onClose={() => setPicking(false)} onDone={() => { setPicking(false); void o.reload(); }} />}
      {(o.data.events ?? []).length > 0 && <section className="card stack tight" data-testid="downtime-events"><h2 style={{ margin: 0 }}><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Waiting for your roll</h2>{o.data.events!.map((e) => <EventCard key={e.id} e={e} onDone={() => void o.reload()} />)}</section>}
      {starting && <section className="card"><StartList picked={[]} onPick={(a) => void run(async () => { await w.call('POST', '/downtime/tasks', { activityId: a.id }); setStarting(false); }, `Started ${a.name}`)} /></section>}
      <ErrorBox error={act.error ?? tasks.error} />
      <section className="card" data-testid="downtime-personal">
        <div className="card-head"><h2>My tasks</h2><label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Finished and stopped too</label></div>
        {!tasks.data ? <Loading /> : !split.personal.length ? <p className="small muted">Nothing yet. Start an activity, or wait for the DM's Downtime.</p> : split.personal.map((t) => (
          <TaskLine key={t.id} t={t}>
            {['active', 'paused'].includes(t.status) && (
              <span className="row" style={{ gap: 6 }}>
                <button type="button" className="btn small" disabled={act.busy} onClick={() => void run(() => w.call('PATCH', `/downtime/tasks/${t.id}`, { status: t.status === 'paused' ? 'active' : 'paused' }), t.status === 'paused' ? 'Back to it' : 'Paused')}>{t.status === 'paused' ? 'Resume' : 'Pause'}</button>
                <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void run(() => w.call('DELETE', `/downtime/tasks/${t.id}`), `Stopped ${t.name}`)}>Stop</button>
              </span>
            )}
          </TaskLine>
        ))}
      </section>
      <section className="card" data-testid="downtime-group">
        <div className="card-head"><h2><i className="fa-solid fa-people-group" aria-hidden="true" /> Group tasks</h2><span className="tiny muted">The whole party's: everyone's days count, the reward goes to the party</span></div>
        {!tasks.data ? <Loading /> : !split.group.length ? <p className="small muted">No group tasks. Start a group activity (a stronghold, a business, party training) and the others can join.</p> : split.group.map((t) => {
          const inIt = t.members.includes(me);
          return (
            <TaskLine key={t.id} t={t}>
              {isOpen(t) && (
                <span className="row" style={{ gap: 6 }}>
                  <button type="button" className={`btn small${inIt ? '' : ' primary'}`} disabled={act.busy} onClick={() => void run(() => w.call('POST', `/downtime/tasks/${t.id}/${inIt ? 'leave' : 'join'}`, {}), inIt ? `Left ${t.name}` : `Joined ${t.name}`)}>{inIt ? 'Leave' : 'Join'}</button>
                </span>
              )}
            </TaskLine>
          );
        })}
      </section>
      <section className="card"><h2>My log</h2>{!log.data ? <Loading /> : <LogList log={log.data.log} />}</section>
      {toastNode}
    </div>
  );
}

/** The sheet's Downtime module: my unfinished tasks and their progress. */
export function DowntimeModule({ account }: { account: string }) {
  const { w, info } = useWorld();
  const dm = info.role === 'dm';
  const tasks = useLoad<{ tasks: Task[] }>(() => w.call('GET', '/downtime/tasks', undefined, dm && account !== 'me' ? { player: account } : undefined), [w, account], ['downtime', 'downtime-done']);
  if ((info.settings as any).downtimeOn !== true) return <p className="tiny muted">Downtime is off in this world.</p>;
  if (!tasks.data) return <Loading />;
  return (
    <div>
      <style>{CSS}</style>
      {(() => {
        const sp = splitScope(tasks.data.tasks);
        if (!sp.personal.length && !sp.group.length) return <p className="tiny muted">No downtime tasks.</p>;
        return <>
          {sp.personal.slice(0, 4).map((t) => <TaskLine key={t.id} t={t} />)}
          {sp.group.length > 0 && <h4 className="dt-scope"><i className="fa-solid fa-people-group" aria-hidden="true" />Group</h4>}
          {sp.group.slice(0, 3).map((t) => <TaskLine key={t.id} t={t} />)}
        </>;
      })()}
      <Link className="tiny" to={dm ? `/w/${info.slug}/dm/downtime` : `/w/${info.slug}/downtime`}>All downtime</Link>
    </div>
  );
}
