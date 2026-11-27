// The DM's side of DownTime: the Downtime button (on the Table, the home page
// and the Downtime page), every player's tasks with time added or taken away,
// pause, stop, edit, approve and Give reward, assigning an activity, the log,
// and the activity list (also the DownTime tab of the House rules page).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, Modal, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { EventCard, LogList, PickModal, TaskLine } from './Player.tsx';
import { CSS, GroupChip, NO_OUTCOME, TierChip, splitScope, useDowntime, type EventDef, type Outcome, type Activity, type LogLine, type Reward, type Task, type Tier } from './shared.tsx';

const PARTY = 'party';
const TIERS: [Tier, string][] = [['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['very-rare', 'Very rare'], ['legendary', 'Legendary']];

/** Press Downtime, or follow the open round: who picked what, Close or Take back. */
export function DowntimeButton({ compact = false }: { compact?: boolean }) {
  const { w, info } = useWorld();
  const o = useDowntime();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [days, setDays] = useState(1);
  const [note, setNote] = useState('');
  const [travel, setTravel] = useState(false);
  const travelH = Number((info.settings as any).downtimeTravelHours ?? 2);
  const [forPlayer, setForPlayer] = useState<string | null>(null);
  if ((info.settings as any).downtimeOn !== true) return compact ? null : <p className="small muted">DownTime is off. Turn it on under <Link to={`/w/${info.slug}/dm/house-rules`}>House rules</Link>.</p>;
  if (!o.data) return <Loading />;
  const r = o.data.round;
  const start = () => act.run(async () => { await w.call('POST', '/downtime/rounds', { days, note: note.trim() || undefined, ...(travel ? { travel: true } : {}) }); setNote(''); toast(`${travel ? 'Travel' : 'Downtime'}: ${days} day${days === 1 ? '' : 's'}. Each player has a popup.`); });
  const close = (how: 'close' | 'cancel') => act.run(async () => { const x = await w.call<any>('POST', `/downtime/rounds/current/${how}`, {}); toast(how === 'close' ? 'Downtime closed' : `Taken back${x?.clockBack ? ', the clock too' : ''}${x?.eventsUndone ? `, and ${x.eventsUndone} event${x.eventsUndone === 1 ? '' : 's'}` : ''}${x?.note ? `. ${x.note}` : ''}`); });
  return (
    <div className="stack tight" data-testid="downtime-button">
      <style>{CSS}</style>
      {!r ? (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="dt-step">
            <button type="button" className="btn small" aria-label="One day less" onClick={() => setDays((n) => Math.max(1, n - 1))}>−</button>
            <input className="input" type="number" min={1} max={365} value={days} aria-label="Days of downtime" onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))} />
            <button type="button" className="btn small" aria-label="One day more" onClick={() => setDays((n) => Math.min(365, n + 1))}>＋</button>
            <span className="small">day{days === 1 ? '' : 's'}</span>
          </span>
          {travelH > 0 && <label className="small" title={`On the road only ${travelH} hour${travelH === 1 ? '' : 's'} a day go to downtime`}><input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} data-testid="downtime-travel" /> Travel ({travelH}h a day)</label>}
          {!compact && <input className="input grow" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Where, e.g. Resting in Saltmarsh" aria-label="Note" />}
          <button type="button" className="btn primary" disabled={act.busy} onClick={() => void start()} data-testid="downtime-start"><i className="fa-solid fa-hourglass-half" aria-hidden="true" /> {travel ? 'Travel days' : 'Downtime'}</button>
        </div>
      ) : (
        <>
          <div className="row between" style={{ gap: 6, flexWrap: 'wrap' }}>
            <strong>{r.kind === 'travel' ? `Travel: ${r.days} day${r.days === 1 ? '' : 's'}, ${r.hoursPerDay}h a day` : `Downtime: ${r.days} day${r.days === 1 ? '' : 's'}`}{r.note ? ` · ${r.note}` : ''}</strong>
            <span className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void close('close')}>Close</button>
              <button type="button" className="btn small" disabled={act.busy} onClick={() => void close('cancel')} title="Undo every pick and move the clock back">Take back</button>
            </span>
          </div>
          {(r.answers ?? []).map((a) => (
            <div key={a.accountId} className="row between small" style={{ gap: 6 }}>
              <span>{a.name}</span>
              <span className="row" style={{ gap: 6 }}>
                <span className="muted">{a.waiting ? 'deciding…' : a.skipped ? 'skipped' : a.picks?.map((p) => `${p.name} (${p.days}d)`).join(', ')}</span>
                <button type="button" className="btn small ghost" onClick={() => setForPlayer(a.accountId)}>{a.waiting ? 'Pick for them' : 'Change'}</button>
              </span>
            </div>
          ))}
        </>
      )}
      {(o.data.events ?? []).length > 0 && (
        <div className="stack tight" data-testid="downtime-dm-events">
          <strong className="small"><i className="fa-solid fa-dice-d20" aria-hidden="true" /> Events waiting for a roll</strong>
          {o.data.events!.map((e) => <EventCard key={e.id} e={e} dm onDone={() => void o.reload()} />)}
        </div>
      )}
      <ErrorBox error={act.error} />
      {forPlayer && r && <ForPlayer player={forPlayer} onClose={() => setForPlayer(null)} />}
      {toastNode}
    </div>
  );
}

function ForPlayer({ player, onClose }: { player: string; onClose: () => void }) {
  const o = useDowntime(player);
  if (!o.data?.round) return null;
  return <PickModal o={o.data} player={player} onClose={onClose} onDone={onClose} />;
}

/** On the DM's home and Table: the button, and what waits for the DM. */
export function DowntimeCard() {
  const { info } = useWorld();
  const o = useDowntime();
  if ((info.settings as any).downtimeOn !== true) return null;
  const waiting = (o.data?.waitingRewards ?? 0) + (o.data?.proposals ?? 0);
  return (
    <section className="card stack tight" aria-labelledby="dt-card">
      <div className="card-head"><h2 id="dt-card">Downtime</h2><Link className="small" to={`/w/${info.slug}/dm/downtime`}>All tasks{waiting ? ` · ${waiting} waiting for you` : ''}</Link></div>
      <DowntimeButton compact />
    </section>
  );
}

/** The DM's Downtime page. */
export function DMDowntime() {
  const { info } = useWorld();
  const [tab, setTab] = useState<'party' | 'log' | 'activities'>('party');
  return (
    <div className="page stack">
      <style>{CSS}</style>
      <PageHead title="Downtime" lead="What every character does between adventures: press Downtime when days pass, add or take away time, and give rewards." />
      {(info.settings as any).downtimeOn !== true ? <Empty>DownTime is off. Turn it on under <Link to={`/w/${info.slug}/dm/house-rules`}>House rules</Link>.</Empty> : <>
        <section className="card"><DowntimeButton /></section>
        <Tabs label="Downtime" value={tab} onChange={setTab} items={[['party', 'Party'], ['log', 'Log'], ['activities', 'Activities']]} />
        {tab === 'party' && <Party />}
        {tab === 'log' && <DMLog />}
        {tab === 'activities' && <Activities />}
      </>}
    </div>
  );
}

function Party() {
  const { w, members } = useWorld();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [all, setAll] = useState(false);
  const tasks = useLoad<{ tasks: Task[] }>(() => w.call('GET', '/downtime/tasks', undefined, all ? { all: '1' } : undefined), [w, all], ['downtime', 'downtime-done']);
  const [editing, setEditing] = useState<Task | null>(null);
  const [assign, setAssign] = useState(false);
  const players = members.filter((m) => m.role === 'player');
  const run = (fn: () => Promise<unknown>, msg: string) => act.run(async () => { await fn(); toast(msg); });
  const time = (t: Task, days: number) => run(() => w.call('POST', `/downtime/tasks/${t.id}/time`, { days, note: days > 0 ? 'Time added by the DM' : 'Time lost' }), `${t.name}: ${days > 0 ? '+' : ''}${days} day`);
  return (
    <section className="card stack">
      <div className="card-head">
        <h2>Party</h2>
        <span className="row" style={{ gap: 8 }}>
          <label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Finished and stopped</label>
          <button type="button" className="btn small" onClick={() => setAssign(true)}>＋ Assign</button>
        </span>
      </div>
      <ErrorBox error={act.error ?? tasks.error} />
      {!tasks.data ? <Loading /> : <>
        <div className="stack tight" data-testid="downtime-dm-group">
          <h3 style={{ margin: '6px 0 0', fontSize: 15 }}><i className="fa-solid fa-people-group" aria-hidden="true" /> Group tasks <span className="tiny muted">the whole party's</span></h3>
          {!splitScope(tasks.data.tasks).group.length && <p className="tiny muted">No group tasks.</p>}
          {splitScope(tasks.data.tasks).group.map((t) => line(t, 'the party'))}
        </div>
        {players.map((p) => {
        const mine = splitScope(tasks.data!.tasks).personal.filter((t) => t.accountId === p.id);
        return (
          <div key={p.id} className="stack tight">
            <h3 style={{ margin: '6px 0 0', fontSize: 15 }}>{p.character_name || p.display_name}</h3>
            {!mine.length && <p className="tiny muted">No personal tasks.</p>}
            {mine.map((t) => line(t, p.character_name || p.display_name))}
          </div>
        );
      })}
      </>}
      {editing && <EditTask t={editing} onClose={() => setEditing(null)} />}
      {assign && <Assign onClose={() => setAssign(false)} />}
      {toastNode}
    </section>
  );
  function line(t: Task, who: string) {
    return (
              <TaskLine key={t.id} t={t}>
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {t.status !== 'removed' && t.status !== 'done' && <>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => void time(t, -1)} title="Time lost">− day</button>
                    <button type="button" className="btn small" disabled={act.busy} onClick={() => void time(t, 1)} title="Time added">＋ day</button>
                    {t.status !== 'proposed' && <button type="button" className="btn small" disabled={act.busy} onClick={() => void run(() => w.call('PATCH', `/downtime/tasks/${t.id}`, { status: t.status === 'paused' ? 'active' : 'paused' }), t.status === 'paused' ? 'Resumed' : 'Paused')}>{t.status === 'paused' ? 'Resume' : 'Pause'}</button>}
                  </>}
                  {t.status === 'proposed' && <button type="button" className="btn small primary" onClick={() => setEditing(t)}>Approve…</button>}
                  {t.rewardWaiting && <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void run(() => w.call('POST', `/downtime/tasks/${t.id}/reward`, {}), `Reward given to ${who}`)}>Give reward</button>}
                  {t.status !== 'removed' && <button type="button" className="btn small ghost" onClick={() => setEditing(t)}>Edit</button>}
                  {t.status !== 'removed' && t.status !== 'done' && <button type="button" className="btn small danger" disabled={act.busy} onClick={() => void run(() => w.call('DELETE', `/downtime/tasks/${t.id}`), `Stopped ${t.name}`)}>Stop</button>}
                </span>
                {t.dmNote && <span className="tiny faint">Your note: {t.dmNote}</span>}
              </TaskLine>
    );
  }
}

function RewardFields({ r, onChange }: { r: Reward; onChange: (r: Reward) => void }) {
  return (
    <div className="stack tight">
      <input className="input" value={r.text} maxLength={400} onChange={(e) => onChange({ ...r, text: e.target.value })} placeholder="Reward, e.g. The sage's answer" aria-label="Reward" />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="small">gp <input className="input" type="number" min={0} style={{ width: 80 }} value={r.cp / 100} onChange={(e) => onChange({ ...r, cp: Math.max(0, Math.round(Number(e.target.value) * 100) || 0) })} /></label>
        <input className="input grow" value={r.item} maxLength={120} onChange={(e) => onChange({ ...r, item: e.target.value })} placeholder="Item" aria-label="Item" />
        <label className="small">× <input className="input" type="number" min={1} max={999} style={{ width: 60 }} value={r.qty} onChange={(e) => onChange({ ...r, qty: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label className="small"><input type="checkbox" checked={r.hidden} onChange={(e) => onChange({ ...r, hidden: e.target.checked })} /> Keep it a surprise</label>
      </div>
    </div>
  );
}
const asReward = (r: Task['reward'] | undefined): Reward => (r && 'text' in r ? r : { text: '', cp: 0, item: '', qty: 1, hidden: false });

function EditTask({ t, onClose }: { t: Task; onClose: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [name, setName] = useState(t.name);
  const [tier, setTier] = useState<Tier>(t.tier);
  const [days, setDays] = useState(Math.max(1, Math.round(t.needMin / t.perDayMin)));
  const [hours, setHours] = useState(t.perDayMin / 60);
  const [reward, setReward] = useState<Reward>(asReward(t.reward));
  const [dmNote, setDmNote] = useState(t.dmNote ?? '');
  const save = (approve: boolean) => act.run(async () => { await w.call('PATCH', `/downtime/tasks/${t.id}`, { name, tier, days, hoursPerDay: hours, reward, dmNote, ...(approve ? { approve: true } : {}) }); onClose(); });
  return (
    <Modal title={t.status === 'proposed' ? `Approve: ${t.name}` : `Edit: ${t.name}`} onClose={onClose}>
      <div className="stack tight">
        <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        {t.summary && <p className="small muted" style={{ margin: 0 }}>{t.summary}</p>}
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {TIERS.map(([id, label]) => <button key={id} type="button" className={`btn small${tier === id ? ' on' : ''}`} aria-pressed={tier === id} onClick={() => setTier(id)}><TierChip tier={id} label={label} /></button>)}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <label className="small">Days <input className="input" type="number" min={1} max={3650} style={{ width: 80 }} value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))} /></label>
          <label className="small">Hours a day <input className="input" type="number" min={1} max={24} style={{ width: 60 }} value={hours} onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))} /></label>
          <span className="tiny muted">{t.doneLabel} done</span>
        </div>
        <RewardFields r={reward} onChange={setReward} />
        <textarea className="input" rows={2} value={dmNote} maxLength={1000} onChange={(e) => setDmNote(e.target.value)} placeholder="A note only you see" aria-label="Private note" />
        <ErrorBox error={act.error} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {t.status === 'proposed' ? <button type="button" className="btn primary" disabled={act.busy} onClick={() => void save(true)}>Approve</button> : <button type="button" className="btn primary" disabled={act.busy} onClick={() => void save(false)}>Save</button>}
        </div>
      </div>
    </Modal>
  );
}

function Assign({ onClose }: { onClose: () => void }) {
  const { w, members } = useWorld();
  const act = useAction();
  const players = members.filter((m) => m.role === 'player');
  const [player, setPlayer] = useState(players[0]?.id ?? '');
  const party = player === PARTY;
  const list = useLoad<{ activities: Activity[] }>(() => w.call('GET', '/downtime/activities', undefined, player && !party ? { player } : undefined), [w, player]);
  const [aid, setAid] = useState('');
  const [custom, setCustom] = useState({ name: '', summary: '', tier: 'common' as Tier });
  const [reward, setReward] = useState<Reward>({ text: '', cp: 0, item: '', qty: 1, hidden: false });
  const chosen = list.data?.activities.find((a) => a.id === aid);
  const go = () => act.run(async () => {
    await w.call('POST', '/downtime/tasks', { ...(party ? { group: true } : { player }), ...(aid ? { activityId: aid } : { activity: custom }), ...(reward.text || reward.cp || reward.item ? { reward } : {}) });
    onClose();
  });
  return (
    <Modal title="Assign downtime" onClose={onClose}>
      <div className="stack tight">
        <select className="input" value={player} onChange={(e) => setPlayer(e.target.value)} aria-label="Player"><option value={PARTY}>The whole party (a group task)</option>{players.map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}</select>
        {(party || chosen?.group) && <p className="tiny muted" style={{ margin: 0 }}><GroupChip /> Shared by the party: anyone can put days in, and the reward goes to the party pouch.</p>}
        <select className="input" value={aid} onChange={(e) => { setAid(e.target.value); const a = list.data?.activities.find((x) => x.id === e.target.value); if (a && 'text' in a.reward) setReward(a.reward); }} aria-label="Activity">
          <option value="">A new one…</option>
          {TIERS.map(([t, label]) => <optgroup key={t} label={label}>{(list.data?.activities ?? []).filter((a) => a.tier === t && a.status !== 'hidden').map((a) => <option key={a.id} value={a.id}>{a.name} ({a.daysNeeded}d{a.group ? ', group' : ''})</option>)}</optgroup>)}
        </select>
        {chosen ? <p className="small muted" style={{ margin: 0 }}>{chosen.summary}</p> : <>
          <input className="input" value={custom.name} maxLength={80} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Name" aria-label="Name" />
          <input className="input" value={custom.summary} maxLength={600} onChange={(e) => setCustom({ ...custom, summary: e.target.value })} placeholder="What it is" aria-label="What it is" />
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{TIERS.map(([id, label]) => <button key={id} type="button" className={`btn small${custom.tier === id ? ' on' : ''}`} onClick={() => setCustom({ ...custom, tier: id })}><TierChip tier={id} label={label} /></button>)}</div>
        </>}
        <RewardFields r={reward} onChange={setReward} />
        <ErrorBox error={act.error} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={act.busy || !player || (!aid && !custom.name.trim())} onClick={() => void go()}>Assign</button>
        </div>
      </div>
    </Modal>
  );
}

function DMLog() {
  const { w, members } = useWorld();
  const [player, setPlayer] = useState('');
  const log = useLoad<{ log: LogLine[] }>(() => w.call('GET', '/downtime/log', undefined, { limit: 200, ...(player ? { player } : {}) }), [w, player], ['downtime', 'downtime-round', 'downtime-done']);
  return (
    <section className="card stack tight">
      <div className="card-head"><h2>Log</h2>
        <select className="input" value={player} onChange={(e) => setPlayer(e.target.value)} aria-label="Player"><option value="">Everyone</option>{members.filter((m) => m.role === 'player').map((p) => <option key={p.id} value={p.id}>{p.character_name || p.display_name}</option>)}</select>
      </div>
      {!log.data ? <Loading /> : <LogList log={log.data.log} />}
    </section>
  );
}

/** The world's activities: change, hide or add; the tier lengths. Also the DownTime tab on the House rules page. */
export function Activities() {
  const { w, info } = useWorld();
  const act = useAction();
  const list = useLoad<{ activities: Activity[] }>(() => w.call('GET', '/downtime/activities'), [w], ['downtime']);
  const o = useDowntime();
  const [edit, setEdit] = useState<Partial<Activity> | null>(null);
  const [tierDays, setTierDays] = useState<Record<string, number> | null>(null);
  const td = tierDays ?? Object.fromEntries((o.data?.tiers ?? []).map((t) => [t.id, t.days]));
  const saveTiers = () => act.run(async () => { await w.call('PATCH', '/settings', { downtimeTierDays: td }); setTierDays(null); });
  const save = () => act.run(async () => {
    const body = { name: edit!.name, summary: edit!.summary, tier: edit!.tier, days: edit!.days || null, hoursPerDay: edit!.hoursPerDay || 8, repeatable: !!edit!.repeatable, group: !!edit!.group, reward: edit!.reward, events: edit!.events ?? [], eventChance: edit!.eventChance ?? null };
    if (edit!.id) await w.call('PATCH', `/downtime/activities/${edit!.id}`, body); else await w.call('POST', '/downtime/activities', body);
    setEdit(null);
  });
  const hide = (a: Activity) => act.run(() => (a.status === 'hidden' ? w.call('PATCH', `/downtime/activities/${a.id}`, { status: 'ok' }) : w.call('DELETE', `/downtime/activities/${a.id}`)));
  if ((info.settings as any).downtimeOn !== true) return <p className="small muted">Turn DownTime on to manage its activities.</p>;
  return (
    <div className="stack">
      <style>{CSS}</style>
      <section className="card stack tight">
        <h2 style={{ margin: 0 }}>How long each tier takes</h2>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {TIERS.map(([id, label]) => <label key={id} className="small"><TierChip tier={id} label={label} /> <input className="input" type="number" min={1} max={3650} style={{ width: 70 }} value={td[id] ?? ''} onChange={(e) => setTierDays({ ...td, [id]: Math.max(1, Number(e.target.value) || 1) })} /> days</label>)}
          {tierDays && <button type="button" className="btn small primary" disabled={act.busy} onClick={() => void saveTiers()}>Save</button>}
        </div>
      </section>
      <section className="card stack tight">
        <div className="card-head"><h2>Activities</h2><button type="button" className="btn small" onClick={() => setEdit({ tier: 'common', hoursPerDay: 8, reward: { text: '', cp: 0, item: '', qty: 1, hidden: false } })}>＋ New activity</button></div>
        <ErrorBox error={act.error ?? list.error} />
        {!list.data ? <Loading /> : TIERS.map(([t, label]) => {
          const rows = list.data!.activities.filter((a) => a.tier === t);
          if (!rows.length) return null;
          return (
            <div key={t} className="stack tight">
              <h3 style={{ margin: '6px 0 0', fontSize: 14 }}><TierChip tier={t} label={label} /></h3>
              {rows.map((a) => (
                <div key={a.id} className="row between" style={{ gap: 8, opacity: a.status === 'hidden' ? 0.5 : 1 }}>
                  <span><strong>{a.name}</strong> {a.group && <GroupChip />} <span className="tiny muted">{a.events?.length ? `${a.events.length} event${a.events.length === 1 ? '' : 's'} · ` : ''}{a.daysNeeded}d{a.hoursPerDay < 8 ? ` × ${a.hoursPerDay}h` : ''}{a.repeatable ? ' · repeatable' : ''}{a.source === 'player' ? ' · a player\'s' : a.source === 'premade' ? '' : ' · yours'}{a.status === 'proposed' ? ' · waiting for you' : ''}</span></span>
                  <span className="row" style={{ gap: 4 }}>
                    {!a.link && <button type="button" className="btn small ghost" onClick={() => setEdit(a)}>Edit</button>}
                    {!a.link && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => void hide(a)}>{a.status === 'hidden' ? 'Show' : a.id.startsWith('pre-') ? 'Hide' : 'Remove'}</button>}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </section>
      {edit && (
        <Modal title={edit.id ? `Edit: ${edit.name}` : 'New activity'} onClose={() => setEdit(null)}>
          <div className="stack tight">
            <input className="input" value={edit.name ?? ''} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Name" aria-label="Name" />
            <textarea className="input" rows={2} value={edit.summary ?? ''} maxLength={600} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} placeholder="What it is" aria-label="What it is" />
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>{TIERS.map(([id, label]) => <button key={id} type="button" className={`btn small${edit.tier === id ? ' on' : ''}`} onClick={() => setEdit({ ...edit, tier: id })}><TierChip tier={id} label={label} /></button>)}</div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <label className="small">Days <input className="input" type="number" min={1} style={{ width: 80 }} value={edit.days ?? ''} placeholder="tier" onChange={(e) => setEdit({ ...edit, days: Number(e.target.value) || null })} /></label>
              <label className="small">Hours a day <input className="input" type="number" min={1} max={24} style={{ width: 60 }} value={edit.hoursPerDay ?? 8} onChange={(e) => setEdit({ ...edit, hoursPerDay: Number(e.target.value) || 8 })} /></label>
              <label className="small"><input type="checkbox" checked={!!edit.repeatable} onChange={(e) => setEdit({ ...edit, repeatable: e.target.checked })} /> Repeatable</label>
              <label className="small"><input type="checkbox" checked={!!edit.group} onChange={(e) => setEdit({ ...edit, group: e.target.checked })} /> Group activity (the party shares it)</label>
            </div>
            <RewardFields r={asReward(edit.reward as any)} onChange={(r) => setEdit({ ...edit, reward: r })} />
            <EventsEditor events={edit.events ?? []} chance={edit.eventChance ?? null} onChange={(events, eventChance) => setEdit({ ...edit, events, eventChance })} />
            <ErrorBox error={act.error} />
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={act.busy || !edit.name?.trim()} onClick={() => void save()}>Save</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const blankEvent = (): EventDef => ({ title: '', text: '', check: '', dc: 12, success: { ...NO_OUTCOME }, failure: { ...NO_OUTCOME } });

/** Random events on an activity: what happens, the check and DC, what success and failure do. */
function EventsEditor({ events, chance, onChange }: { events: EventDef[]; chance: number | null; onChange: (e: EventDef[], chance: number | null) => void }) {
  const set = (i: number, e: EventDef) => onChange(events.map((x, j) => (j === i ? e : x)), chance);
  const out = (o: Outcome, f: (o: Outcome) => void, label: string, bad = false) => (
    <div className="row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="tiny" style={{ width: 56 }}>{label}</span>
      <input className="input grow" value={o.text} maxLength={300} onChange={(ev) => f({ ...o, text: ev.target.value })} placeholder={bad ? 'Bitten and chased off' : 'You clear them out'} aria-label={`${label} text`} />
      <label className="tiny">gp <input className="input" type="number" style={{ width: 64 }} value={o.cp / 100} onChange={(ev) => f({ ...o, cp: Math.round(Number(ev.target.value) * 100) || 0 })} aria-label={`${label} gp`} /></label>
      <label className="tiny">days <input className="input" type="number" style={{ width: 56 }} value={o.days} onChange={(ev) => f({ ...o, days: Math.round(Number(ev.target.value)) || 0 })} aria-label={`${label} days`} /></label>
      {bad && <label className="tiny">damage <input className="input" type="number" min={0} style={{ width: 56 }} value={o.damage} onChange={(ev) => f({ ...o, damage: Math.max(0, Math.round(Number(ev.target.value)) || 0) })} aria-label={`${label} damage`} /></label>}
      {bad && <label className="tiny">exhaustion <input className="input" type="number" min={0} max={6} style={{ width: 48 }} value={o.exhaustion} onChange={(ev) => f({ ...o, exhaustion: Math.max(0, Math.min(6, Math.round(Number(ev.target.value)) || 0)) })} aria-label={`${label} exhaustion`} /></label>}
      <input className="input" style={{ width: 120 }} value={o.item} maxLength={120} onChange={(ev) => f({ ...o, item: ev.target.value })} placeholder="Item" aria-label={`${label} item`} />
      {bad && <label className="tiny"><input type="checkbox" checked={!!o.noReward} onChange={(ev) => f({ ...o, noReward: ev.target.checked })} /> Job fails, no reward</label>}
    </div>
  );
  return (
    <details className="stack tight" open={events.length > 0}>
      <summary className="small"><strong>Random events</strong> ({events.length}) · things that can happen on a downtime day</summary>
      <label className="small">Chance per day <input className="input" type="number" min={0} max={100} style={{ width: 64 }} value={chance ?? ''} placeholder="world" onChange={(ev) => onChange(events, ev.target.value === '' ? null : Math.max(0, Math.min(100, Number(ev.target.value) || 0)))} aria-label="Event chance per day" /> % <span className="tiny muted">(empty: the world's default)</span></label>
      {events.map((e, i) => (
        <div key={i} className="card stack tight" style={{ padding: 8 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input className="input grow" value={e.title} maxLength={80} onChange={(ev) => set(i, { ...e, title: ev.target.value })} placeholder="Rats in the cellar!" aria-label="Event title" />
            <input className="input" style={{ width: 120 }} value={e.check} maxLength={40} onChange={(ev) => set(i, { ...e, check: ev.target.value })} placeholder="Check (Athletics)" aria-label="Check" />
            <label className="small">DC <input className="input" type="number" min={1} max={40} style={{ width: 56 }} value={e.dc} onChange={(ev) => set(i, { ...e, dc: Math.max(1, Number(ev.target.value) || 12) })} /></label>
            <button type="button" className="btn small ghost" onClick={() => onChange(events.filter((_, j) => j !== i), chance)} aria-label={`Remove ${e.title || 'event'}`}>✕</button>
          </div>
          <input className="input" value={e.text} maxLength={400} onChange={(ev) => set(i, { ...e, text: ev.target.value })} placeholder="A swarm of rats boils out of a broken barrel." aria-label="What happens" />
          {out(e.success, (o) => set(i, { ...e, success: o }), e.check ? 'Success' : 'Result')}
          {e.check && out(e.failure, (o) => set(i, { ...e, failure: o }), 'Failure', true)}
        </div>
      ))}
      <button type="button" className="btn small" onClick={() => onChange([...events, blankEvent()], chance)}>＋ Event</button>
    </details>
  );
}
