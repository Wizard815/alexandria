// Shared parts of the player sheet: types, the HP and mana bars, the log list
// and the sheet's styles.
import { timeShort, dateLong } from '../../lib/format.ts';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, Loading } from '../../ui/index.tsx';

export type ModuleType = 'vitals' | 'mana' | 'rerolls' | 'inventory' | 'dm' | 'contacts' | 'notes' | 'recent' | 'text' | 'counters' | 'list';
export interface Module { id: string; type: ModuleType; title: string; wide: boolean; private: boolean; collapsed: boolean; data?: any }
export interface Mana { on: boolean; now?: number | null; max?: number | null }
export interface Sheet {
  accountId: string; name: string; player: string; mine: boolean;
  hp: number | null; maxHp: number | null; tempHp: number; conditions: string[];
  mana: Mana; modules: Module[]; rerolls?: import('./rerolls.tsx').Rerolls;
  fromDm?: { id: string; kind: 'note' | 'goal'; text: string; done: boolean; createdAt: string; updatedAt: string }[];
}
export interface PartyRow { accountId: string; name: string; player: string; hp: number | null; maxHp: number | null; tempHp: number; conditions: string[]; mana: Mana; rerolls?: import('./rerolls.tsx').Rerolls; inCombat: boolean; deathSaves: { successes: number; failures: number; stable: boolean; dead: boolean } | null }
export interface LogLine { id: string; accountId: string; kind: string; before: number | null; after: number | null; amount: number | null; note: string; source: string; by: string | null; at: string }

/** The kinds of module a player can add, with what each is for. */
export const KINDS: { type: ModuleType; label: string; desc: string; icon: string }[] = [
  { type: 'vitals', label: 'Health', desc: 'HP, temporary HP and conditions', icon: 'fa-heart-pulse' },
  { type: 'mana', label: 'Mana', desc: 'Your mana pool, when the world uses it', icon: 'fa-droplet' },
  { type: 'rerolls', label: 'Re-rolls', desc: 'Re-roll tokens the DM gives for good role play (house rule)', icon: 'fa-dice' },
  { type: 'inventory', label: 'Inventory', desc: 'What you carry, from your pack', icon: 'fa-sack-dollar' },
  { type: 'dm', label: 'From the DM', desc: 'Secret notes and goals the DM leaves for you', icon: 'fa-scroll' },
  { type: 'contacts', label: 'People', desc: 'Allies, enemies and everyone in between, linked to their pages', icon: 'fa-user-group' },
  { type: 'notes', label: 'Quick notes', desc: 'Jot things down during play', icon: 'fa-pen' },
  { type: 'recent', label: 'Recently', desc: 'People, places and factions from the latest session summaries; ask the broker about them', icon: 'fa-clock-rotate-left' },
  { type: 'text', label: 'Text', desc: 'Any notes with your own title', icon: 'fa-align-left' },
  { type: 'counters', label: 'Counters', desc: 'Inspiration, hit dice, ammo, anything you count', icon: 'fa-hashtag' },
  { type: 'list', label: 'Checklist', desc: 'Goals, errands, things to remember', icon: 'fa-list-check' },
];
export const SINGLE: ModuleType[] = ['vitals', 'mana', 'rerolls', 'inventory', 'dm', 'recent'];
export const CAN_BE_PRIVATE: ModuleType[] = ['contacts', 'notes', 'text', 'counters', 'list'];
export const CONDITIONS = ['Blinded', 'Charmed', 'Deafened', 'Exhaustion', 'Frightened', 'Grappled', 'Incapacitated', 'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious', 'Concentrating', 'Blessed', 'Hasted'];

export const pct = (now: number | null | undefined, max: number | null | undefined) => (max && max > 0 && typeof now === 'number' ? Math.max(0, Math.min(100, (now / max) * 100)) : 0);

/** HP as a bar: red when low, temporary HP as a band after it. */
export function HpBar({ hp, maxHp, tempHp, small = false }: { hp: number | null; maxHp: number | null; tempHp: number; small?: boolean }) {
  const p = pct(hp, maxHp);
  const tp = maxHp ? Math.min(100 - p, (tempHp / maxHp) * 100) : 0;
  const low = p > 0 && p <= 25;
  const label = hp === null ? 'HP not set' : `HP ${hp}${maxHp !== null ? ` of ${maxHp}` : ''}${tempHp ? `, ${tempHp} temporary` : ''}`;
  return (
    <div className={`sht-bar hp${small ? ' small' : ''}${low ? ' low' : ''}${hp === 0 ? ' down' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={maxHp ?? 0} aria-valuenow={hp ?? 0}>
      <span className="fill" style={{ width: `${p}%` }} />
      {tempHp > 0 && <span className="temp" style={{ width: `${tp}%` }} />}
    </div>
  );
}

export function ManaMeter({ mana, small = false }: { mana: Mana; small?: boolean }) {
  if (!mana.on || mana.max === null || mana.max === undefined) return null;
  const now = mana.now ?? mana.max;
  return <div className={`sht-bar mana${small ? ' small' : ''}`} role="meter" aria-label={`Mana ${now} of ${mana.max}`} aria-valuemin={0} aria-valuemax={mana.max} aria-valuenow={now}><span className="fill" style={{ width: `${pct(now, mana.max)}%` }} /></div>;
}

const KIND_LABEL: Record<string, string> = { hp: 'HP', temp: 'Temp HP', max: 'Max HP', conditions: 'Conditions', mana: 'Mana', reroll: 'Re-roll' };
const SOURCE_LABEL: Record<string, string> = { sheet: 'sheet', combat: 'combat tracker', dm: 'DM', foundry: 'Foundry', cast: 'cast', adjust: 'adjusted', rest: 'rest', learn: 'learned' };

/** Every HP and mana change, newest first. `account` null: the whole party (DM). */
export function ChangeLog({ account, limit = 40 }: { account: string | null; limit?: number }) {
  const { w, nameOf, isDM } = useWorld();
  const log = useLoad<{ log: LogLine[] }>(() => w.call('GET', '/sheet/log', undefined, account && isDM ? { account } : undefined), [w, account], ['sheet', 'spells-char', 'combat']);
  if (log.loading && !log.data) return <Loading />;
  const rows = (log.data?.log ?? []).slice(0, limit);
  if (!rows.length) return <Empty>No changes yet.</Empty>;
  let day = '';
  return (
    <ol className="sht-log" data-testid="sheet-log">
      {rows.map((x) => {
        const d = dateLong(x.at);
        const head = d !== day ? (day = d) : null;
        const sign = x.amount === null ? '' : x.amount > 0 ? `+${x.amount}` : String(x.amount);
        return (
          <li key={x.id}>
            {head && <span className="tiny faint sht-day">{head}</span>}
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="tiny faint">{timeShort(x.at)}</span>
              {!account && <strong className="small">{nameOf(x.accountId)}</strong>}
              <span className={`chip${x.kind === 'mana' ? ' teal' : x.amount !== null && x.amount < 0 ? ' red' : x.amount ? ' green' : ''}`}>{KIND_LABEL[x.kind] ?? x.kind} {sign}</span>
              {x.after !== null && <span className="small">{x.before ?? '—'} → {x.after}</span>}
              {x.note && <span className="small muted">{x.note}</span>}
              <span className="tiny faint">· {SOURCE_LABEL[x.source] ?? x.source}{x.by && x.by !== x.accountId ? ` by ${nameOf(x.by)}` : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export const CSS = `
/* Rows of columns (see layout() in Sheet.tsx): read left to right, and a short card leaves no hole under it. */
.sht-grid { display: flex; flex-direction: column; gap: 10px; }
.sht-cols { display: flex; gap: 10px; align-items: flex-start; }
.sht-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.sht-row > .sht-mod, .sht-col > .sht-mod { width: 100%; box-sizing: border-box; margin: 0; }
.sht-mod { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.sht-mod .card-head { margin: 0; gap: 6px; }
.sht-mod .card-head h3 { font-size: 15px; margin: 0; display: flex; align-items: center; gap: 6px; }
.sht-mod.editing { outline: 1px dashed var(--accent); }
.sht-bar { position: relative; height: 12px; border-radius: 999px; background: var(--line); overflow: hidden; display: flex; }
.sht-bar.small { height: 6px; }
.sht-bar .fill { display: block; height: 100%; background: var(--ok); transition: width .3s; }
.sht-bar.low .fill { background: var(--danger); }
.sht-bar .temp { display: block; height: 100%; background: var(--teal); opacity: .8; }
.sht-bar.mana .fill { background: linear-gradient(90deg, var(--teal), var(--accent)); }
.sht-big { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sht-num { width: 68px; min-height: 34px; text-align: center; border: 1px solid var(--line); border-radius: 6px; background: var(--input); color: var(--text); font: inherit; }
.sht-tiny-num { width: 56px; min-height: 30px; text-align: center; border: 1px solid var(--line); border-radius: 6px; background: var(--input); color: var(--text); font: inherit; }
.sht-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.sht-ctl { display: flex; flex-wrap: wrap; gap: 6px; }
.sht-ctl .btn { min-height: 40px; min-width: 44px; }
.sht-ctl .btn.danger { margin-left: auto; }
.sht-rr { align-items: center; }
.sht-tokens { display: inline-flex; gap: 3px; }
.sht-tokens span { width: 10px; height: 10px; border-radius: 50%; border: 1px solid var(--accent); }
.sht-tokens span.on { background: var(--accent); }
.sht-cond { position: relative; }
.sht-cond .sht-cond-name { padding: 0; text-decoration: underline dotted; text-underline-offset: 3px; }
.sht-tip { display: none; position: absolute; left: 0; top: calc(100% + 6px); z-index: 30; width: 260px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font-size: 12px; line-height: 1.4; box-shadow: 0 6px 20px rgb(0 0 0 / 35%); white-space: normal; }
.sht-tip strong { display: block; margin-bottom: 2px; }
.sht-cond:hover .sht-tip, .sht-cond:focus-within .sht-tip { display: block; }
.sht-quick { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.sht-chips .chip button { background: none; border: 0; color: inherit; padding: 0 0 0 2px; cursor: pointer; font: inherit; }
.sht-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.sht-list li { display: flex; align-items: center; gap: 6px; min-height: 30px; }
.sht-list li .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sht-mod textarea { width: 100%; min-height: 90px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--input); color: var(--text); font: inherit; resize: vertical; line-height: 1.45; }
.sht-mod input.sht-in, .sht-mod select.sht-in { min-height: 32px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--input); color: var(--text); font: inherit; min-width: 0; }
.sht-add { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; }
.sht-add button { text-align: left; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; min-height: 0; height: auto; }
.sht-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sht-day { display: block; margin-top: 6px; }
.sht-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel-2); align-self: flex-start; }
.sht-seg button { border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; min-height: 26px; }
.sht-seg button.on { background: var(--accent-bg); color: var(--accent-strong); }
.sht-people { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.sht-people li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--panel-2); border-left: 3px solid var(--line); }
.sht-people li.tap { cursor: pointer; } .sht-people li.tap:hover { background: color-mix(in srgb, var(--accent) 8%, var(--panel-2)); }
.sht-people button.sht-av { cursor: pointer; font: inherit; }
.sht-people li.rel-ok { border-left-color: var(--ok); } .sht-people li.rel-bad { border-left-color: var(--danger); }
.sht-av { flex: 0 0 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 14px; background: var(--bg); border: 1px solid var(--line); }
.rel-ok .sht-av { color: var(--ok-text); border-color: var(--ok); } .rel-bad .sht-av { color: var(--danger-text); border-color: var(--danger); }
.sht-pname { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sht-pnote { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A long list scrolls inside its card instead of stretching the column. */
.sht-scroll { max-height: 330px; overflow-y: auto; padding-right: 4px; }
.sht-dm { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--panel)); }
.sht-status { display: flex; gap: 8px; overflow-x: auto; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--panel); scrollbar-width: thin; }
.sht-pc { font: inherit; text-align: left; cursor: pointer; flex: 0 0 auto; min-width: 150px; max-width: 220px; display: flex; flex-direction: column; gap: 3px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 8px; color: inherit; text-decoration: none; background: var(--panel-2); }
.sht-pc:hover, .sht-pc:focus-visible { border-color: var(--accent); }
.sht-pc.down { border-color: var(--danger); }
.sht-pc .row { gap: 6px; }
.sht-pc .row > .sht-bar { flex: 1; }
.sht-pc .nm { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sht-pc .nums { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
`;
