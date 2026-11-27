// House rule "Inspiration as re-rolls" (World settings → Player sheets): the
// GM rewards good role play with re-roll tokens of three kinds. The player
// spends their own; the GM gives and takes back, from the sheet or the
// status bar's quick panel. The server keeps and logs them (features/sheet/rerolls.ts).
import { useState } from 'react';
import { useWorld } from '../../lib/world.tsx';
import { ErrorBox, Field, Switch, useAction, useToast } from '../../ui/index.tsx';

export type RerollKind = 'personal' | 'party' | 'dm';
export type Rerolls = { on: false } | { on: true; cap: number; personal: number; party: number; dm: number };
export const REROLL: Record<RerollKind, { label: string; short: string; icon: string; help: string }> = {
  personal: { label: 'Personal re-roll', short: 'Me', icon: 'fa-dice-d20', help: 'Re-roll one of your own rolls.' },
  party: { label: 'Everyone re-roll', short: 'All', icon: 'fa-people-group', help: 'Re-roll anyone’s roll at the table, yours or a friend’s.' },
  dm: { label: 'GM re-roll', short: 'GM', icon: 'fa-hat-wizard', help: 'Make the GM re-roll one of their rolls.' },
};
const KINDS: RerollKind[] = ['personal', 'party', 'dm'];

/** The re-roll module: tokens per kind, Use for the player, give and take back for the GM. */
export function RerollMod({ account, r, dm, onChanged }: { account: string; r: Rerolls; dm: boolean; onChanged: () => void }) {
  const { w } = useWorld();
  const act = useAction();
  const [why, setWhy] = useState('');
  if (!r.on) return <p className="tiny muted">Re-rolls are off in this world.</p>;
  const go = (kind: RerollKind, delta: number) => act.run(async () => { await w.call('POST', `/sheet/${account}/rerolls`, { kind, delta, ...(why.trim() ? { note: why.trim() } : {}) }); setWhy(''); onChanged(); });
  return (
    <div className="stack tight" data-testid="rerolls">
      <ErrorBox error={act.error} />
      <ul className="sht-list">{KINDS.map((k) => (
        <li key={k} className="sht-rr">
          <i className={`fa-solid ${REROLL[k].icon} faint`} aria-hidden="true" />
          <span className="grow stack" style={{ gap: 0 }}><span className="small">{REROLL[k].label}</span><span className="tiny faint">{REROLL[k].help}</span></span>
          <span className="sht-tokens" aria-label={`${r[k]} of ${r.cap}`}>{Array.from({ length: r.cap }, (_, i) => <span key={i} className={i < r[k] ? 'on' : ''} />)}</span>
          {dm ? <>
            <button type="button" className="btn small ghost" disabled={act.busy || r[k] === 0} aria-label={`Take back a ${REROLL[k].label}`} onClick={() => void go(k, -1)}>−</button>
            <button type="button" className="btn small" disabled={act.busy || r[k] >= r.cap} aria-label={`Give a ${REROLL[k].label}`} onClick={() => void go(k, 1)}>＋</button>
          </> : <button type="button" className="btn small" disabled={act.busy || r[k] === 0} aria-label={`Use a ${REROLL[k].label}`} onClick={() => void go(k, -1)}>Use</button>}
        </li>
      ))}</ul>
      {dm && <input className="sht-in" placeholder="For what? (logged, e.g. a great speech)" aria-label="Reason" value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} />}
    </div>
  );
}

/** Small token counts for the GM's status bar. */
export function RerollChips({ r }: { r: Rerolls }) {
  if (!r.on) return null;
  return (
    <span className="tiny faint row" style={{ gap: 6 }} aria-label={`Re-rolls: personal ${r.personal}, everyone ${r.party}, GM ${r.dm}`}>
      {KINDS.map((k) => <span key={k} title={REROLL[k].label}><i className={`fa-solid ${REROLL[k].icon}`} aria-hidden="true" /> {r[k]}</span>)}
    </span>
  );
}

/** World settings → Player sheets. */
export function SheetSettings() {
  const { w, info, isDM, reloadInfo } = useWorld();
  const s: any = info.settings;
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [cap, setCap] = useState(String(s.sheetRerollCap ?? 3));
  if (!isDM) return null;
  const save = (patch: Record<string, unknown>) => act.run(async () => { await w.updateSettings(patch); await reloadInfo(); toast('Saved'); });
  return (
    <div className="stack">
      <ErrorBox error={act.error} />
      <section className="card stack">
        <h3>House rule: inspiration as re-rolls</h3>
        <div className="row between" style={{ gap: 10 }}>
          <span className="stack tight"><span>Use re-roll tokens</span><span className="tiny muted">Reward good role play with re-rolls instead of plain inspiration. Three kinds: personal (re-roll your own roll), everyone (re-roll anyone’s roll) and GM (make the GM re-roll). Each player’s sheet gets a Re-rolls module; you give them from the status bar.</span></span>
          <Switch checked={s.sheetRerolls === true} label="Use re-roll tokens" onChange={(v) => void save({ sheetRerolls: v })} />
        </div>
        {s.sheetRerolls === true && (
          <Field label="Most of each kind a player can hold">
            <div className="row" style={{ gap: 6 }}>
              <input type="number" min={1} max={20} value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Most of each kind" style={{ width: 70 }} />
              <button type="button" className="btn small" disabled={act.busy || !(Number(cap) >= 1 && Number(cap) <= 20)} onClick={() => void save({ sheetRerollCap: Number(cap) })}>Save</button>
            </div>
          </Field>
        )}
      </section>
      {toastNode}
    </div>
  );
}
