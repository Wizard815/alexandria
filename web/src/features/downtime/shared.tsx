// DownTime in the app: types, the tier chip, the progress bar and the data
// hooks the DM page, the player page, the popup and the sheet module share.
import { useLoad, useWorld } from '../../lib/world.tsx';

export type Tier = 'common' | 'uncommon' | 'rare' | 'very-rare' | 'legendary';
export interface Reward { text: string; cp: number; item: string; qty: number; hidden: boolean }
export interface Activity {
  id: string; name: string; summary: string; tier: Tier; tierLabel: string; days: number | null; daysNeeded: number; hoursPerDay: number;
  repeatable: boolean; group: boolean; events: EventDef[]; eventChance: number | null; reward: Reward | { hidden: true }; link: { kind: string; ref?: string } | null; tags: string[];
  source: 'premade' | 'dm' | 'player'; status: 'ok' | 'proposed' | 'hidden'; createdBy: string | null; changed: boolean;
}
export interface Task {
  id: string; accountId: string; player?: string; activityId: string | null; name: string; summary: string; tier: Tier; tierLabel: string;
  needMin: number; doneMin: number; perDayMin: number; status: 'active' | 'paused' | 'proposed' | 'done' | 'removed'; percent: number;
  needLabel: string; doneLabel: string; leftLabel: string; daysLeft: number;
  reward: Reward | { hidden: true }; rewardGivenAt: string | null; rewardWaiting: boolean; link: { kind: string; ref?: string } | null;
  createdAt: string; finishedAt: string | null; dmNote?: string;
  /** personal: one character's. group: the party's, shared; members joined it, contributions are what each put in. */
  scope: 'personal' | 'group'; members: string[]; memberNames?: string[];
  contributions: { accountId: string; name?: string; minutes: number; label: string }[];
}
export interface Outcome { text: string; cp: number; item: string; qty: number; days: number; damage: number; heal: number; exhaustion: number }
export interface EventDef { id?: string; title: string; text: string; check: string; dc: number; success: Outcome; failure: Outcome; weight?: number }
export interface DtEvent extends EventDef {
  id: string; roundId: string | null; taskId: string; task: string; accountId: string; player?: string;
  status: 'pending' | 'success' | 'failure' | 'cancelled'; roll: number | null; total: number | null; note: string; createdAt: string;
}
export const NO_OUTCOME: Outcome = { text: '', cp: 0, item: '', qty: 1, days: 0, damage: 0, heal: 0, exhaustion: 0 };
export const outcomeText = (o: Outcome | undefined): string => (!o ? '' : [
  o.text.replace(/[.!]+$/, ''), o.cp ? `${o.cp > 0 ? '+' : '−'}${Math.abs(o.cp) / 100} gp` : '', o.item ? `${o.qty > 1 ? `${o.qty} × ` : ''}${o.item}` : '',
  o.days ? `${o.days > 0 ? '+' : '−'}${Math.abs(o.days)} day${Math.abs(o.days) === 1 ? '' : 's'} of progress` : '',
  o.damage ? `${o.damage} damage` : '', o.heal ? `${o.heal} HP back` : '', o.exhaustion ? `${o.exhaustion > 0 ? '+' : '−'}${Math.abs(o.exhaustion)} exhaustion` : '',
].filter(Boolean).join(', '));

export interface Answer { accountId: string; name: string; waiting?: boolean; skipped?: boolean; picks?: { taskId: string; days: number; name: string }[]; at?: string }
export interface Round { id: string; days: number; hours: number; status: 'open' | 'closed' | 'cancelled'; note: string; worldLabel: string; createdAt: string; answers?: Answer[]; mine?: Answer | null }
export interface Overview {
  on: boolean; dayHours: number; playerNew: 'approve' | 'free' | 'off'; advanceClock: boolean; now: string;
  tiers: { id: Tier; label: string; days: number }[]; round: Round | null; tasks: Task[]; events?: DtEvent[]; waitingRewards?: number; proposals?: number;
}
export interface LogLine { id: string; at: string; worldDate: string; accountId: string; player: string; taskId: string | null; task: string; kind: string; minutes: number; time: string; by: string; note: string; undone: boolean }
export interface Ranked { id: string; name: string; tier: Tier; tierLabel: string; days: number; hoursPerDay: number; why: string }

const OPEN = ['active', 'paused', 'proposed'];
/** Personal tasks (one character's) and group tasks (the party's), kept apart everywhere. */
export const splitScope = <T extends { scope?: string }>(list: T[]) => ({ personal: list.filter((t) => t.scope !== 'group'), group: list.filter((t) => t.scope === 'group') });
export const isOpen = (t: Pick<Task, 'status'>) => OPEN.includes(t.status);

/** The marker on group activities and tasks. */
export function GroupChip() {
  return <span className="dt-group" title="A group activity: the whole party shares it"><i className="fa-solid fa-people-group" aria-hidden="true" /> Group</span>;
}

export const EVENTS = ['downtime', 'downtime-round', 'downtime-done', 'downtime-event', 'settings', 'clock'];

export function useDowntime(player?: string | null) {
  const { w } = useWorld();
  return useLoad<Overview>(() => w.call('GET', '/downtime', undefined, player ? { player } : undefined), [w, player], EVENTS);
}

export const TIER_COLOR: Record<Tier, string> = { common: '#8a8f98', uncommon: '#3f9d5a', rare: '#3b7dd8', 'very-rare': '#9a52d6', legendary: '#e08a1e' };

export function TierChip({ tier, label }: { tier: Tier; label?: string }) {
  return <span className="dt-tier" style={{ borderColor: TIER_COLOR[tier], color: TIER_COLOR[tier] }}>{label ?? tier.replace('-', ' ')}</span>;
}

export function Progress({ t }: { t: Pick<Task, 'percent' | 'tier' | 'doneLabel' | 'needLabel'> }) {
  return (
    <div className="dt-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.percent} aria-label={`${t.doneLabel} of ${t.needLabel}`}>
      <span style={{ width: `${t.percent}%`, background: TIER_COLOR[t.tier] }} />
    </div>
  );
}

export const rewardText = (r: Task['reward']): string => ('text' in r ? [r.text, r.cp ? `${r.cp / 100} gp` : '', r.item ? `${r.qty > 1 ? `${r.qty} × ` : ''}${r.item}` : ''].filter(Boolean).join(', ') : 'A reward waits at the end');

export const KIND_LABEL: Record<string, string> = {
  start: 'Started', work: 'Worked', time: 'Time changed', skip: 'Skipped', missed: 'No pick', pause: 'Paused', resume: 'Back to it',
  remove: 'Stopped', edit: 'Changed', approve: 'Approved', complete: 'Finished', reward: 'Reward given', join: 'Joined', leave: 'Left', event: 'Event',
};

export const CSS = `
.dt-tier { display: inline-block; border: 1px solid; border-radius: 999px; padding: 0 8px; font-size: 11px; text-transform: capitalize; white-space: nowrap; }
.dt-bar { height: 8px; border-radius: 4px; background: var(--line, rgba(127,127,127,.25)); overflow: hidden; }
.dt-bar > span { display: block; height: 100%; border-radius: 4px; transition: width .3s; }
.dt-task { display: grid; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--line, rgba(127,127,127,.2)); }
.dt-task:last-child { border-bottom: 0; }
.dt-acts { display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); }
.dt-act { text-align: left; display: grid; gap: 2px; padding: 8px 10px; white-space: normal; min-width: 0; overflow-wrap: anywhere; justify-content: stretch; }
.dt-act.on { outline: 2px solid var(--accent, #3b7dd8); }
.dt-step { display: inline-flex; align-items: center; gap: 4px; }
.dt-step input { width: 3.5em; text-align: center; }
.dt-log { display: grid; gap: 2px; font-size: 13px; }
.dt-log .undone { text-decoration: line-through; opacity: .6; }
.dt-group { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 0 8px; font-size: 11px; background: var(--accent-soft, rgba(59,125,216,.15)); color: var(--accent, #3b7dd8); white-space: nowrap; }
.dt-scope { margin: 8px 0 0; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted, #888); display: flex; align-items: center; gap: 6px; }
.dt-event { border: 1px solid var(--accent, #3b7dd8); border-radius: 10px; padding: 12px; display: grid; gap: 6px; }
.dt-event.success { border-color: #3f9d5a; }
.dt-event.failure { border-color: var(--danger, #c33); }
.dt-stakes { display: grid; gap: 2px; font-size: 13px; }
.dt-chip { position: fixed; right: 16px; bottom: 76px; z-index: 40; }
`;
