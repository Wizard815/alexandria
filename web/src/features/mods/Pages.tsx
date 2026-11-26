// The DM's House rules page (each player's counters with Grant and Take back,
// and the change log), the player's card (my counters with Use buttons) and
// the player's page (the rules in play and what I hold).
import { useState } from 'react';
import { timeShort } from '../../lib/format.ts';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { Empty, ErrorBox, Loading, PageHead, Tabs, useAction, useToast } from '../../ui/index.tsx';
import { MakeHouseRule, RulesList } from './Settings.tsx';
import { houseRuleTabs } from '../registry.ts';
import { Chip, useHouseRules, type HouseRule, type LogLine } from './shared.tsx';

const withCounters = (list: HouseRule[]) => list.filter((r) => r.enabled && r.resources.length);

type Tab = string; // 'play' | 'rules' | 'make' | `x:<mod>:<title>` for a system rule's own tab

/** The DM's house rules hub: counters in play, every rule with its switch, and making or adding one. */
export function DMHouseRules() {
  const { list, rules } = useHouseRules();
  const [tab, setTab] = useState<Tab | null>(null);
  const on = list.filter((r) => r.enabled).length;
  const extra = houseRuleTabs.filter((t) => list.some((r) => r.id === t.mod && r.enabled)).map((t) => ({ key: `x:${t.mod}:${t.title}`, ...t }));
  const fallback = withCounters(list).length ? 'play' : 'rules';
  const shown: Tab = tab && (!tab.startsWith('x:') || extra.some((t) => t.key === tab)) ? tab : fallback;
  const Extra = extra.find((t) => t.key === shown)?.component;
  return (
    <div className="stack">
      <PageHead title="House rules" lead="Your table’s own rules, from a reroll token to a whole spell system. Turn them on, reward players, or make your own." />
      <Tabs<Tab> label="House rules" value={shown} onChange={setTab} items={[
        ['play', 'In play'],
        ['rules', rules.data ? `Rules (${on} on of ${list.length})` : 'Rules'],
        ...extra.map((t) => [t.key, t.title] as [Tab, string]),
        ['make', 'Make or add one'],
      ]} />
      {Extra && <Extra />}
      {shown === 'play' && <InPlay onRules={() => setTab('rules')} />}
      {shown === 'rules' && <RulesList />}
      {shown === 'make' && <MakeHouseRule />}
    </div>
  );
}

function InPlay({ onRules }: { onRules: () => void }) {
  const { w, nameOf } = useWorld();
  const { list, players, counts } = useHouseRules();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const [reason, setReason] = useState('');
  const log = useLoad(() => w.call<{ log: LogLine[] }>('GET', '/mods/log', undefined, { limit: 40 }), [w], ['mods', 'mods-counts']);
  const rules = withCounters(list);
  const run = (r: HouseRule, action: string, accountId: string, resource: string) => act.run(async () => {
    await w.call('POST', `/mods/${r.id}/act`, { action, player: accountId, resource, note: reason.trim() || undefined });
    toast(`${nameOf(accountId)}: done`);
  });
  const labelOf = (modId: string, rid: string) => list.find((r) => r.id === modId)?.resources.find((x) => x.id === rid)?.label ?? rid;
  const actionOf = (modId: string, aid: string) => (aid.startsWith('trigger:') ? { longRest: 'long rest', shortRest: 'short rest', sessionStart: 'session start', sessionEnd: 'session end' }[aid.slice(8)] ?? aid.slice(8) : list.find((r) => r.id === modId)?.actions.find((x) => x.id === aid)?.label ?? aid);
  return (
    <div className="stack">
      <p className="small muted">Grant and take back tokens and points. Every change is logged with its reason. Systems like spell points have no counters here; they change the sheets and the Codex.</p>
      <ErrorBox error={counts.error ?? act.error} />
      {!counts.data ? <Loading /> : rules.length === 0 ? (
        <Empty>No house rule with counters is on. <button type="button" className="btn small" onClick={onRules}>See all rules</button></Empty>
      ) : (
        <>
          <label className="stack tight">
            <span className="small">Reason (shown in the log and to the player)</span>
            <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Stayed in character through the interrogation" />
          </label>
          {rules.map((r) => {
            const grant = r.actions.find((a) => a.by === 'dm' && a.id === 'grant') ?? r.actions.find((a) => a.by === 'dm');
            const take = r.actions.find((a) => a.by === 'dm' && a.id !== grant?.id);
            return (
              <section key={r.id} className="card stack">
                <h2 style={{ margin: 0 }}>{r.name}</h2>
                <div className="tiny muted">{r.summary}</div>
                {players.length === 0 && <p className="small muted">No players yet.</p>}
                {players.map((p) => (
                  <div key={p.accountId} className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <strong>{p.name || nameOf(p.accountId)}</strong>
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {(p.mods[r.id] ?? []).map((c) => (
                        <span key={c.id} className="row" style={{ gap: 2 }}>
                          <Chip c={c} />
                          {grant && (grant.resource === '*' || grant.resource === c.id) && <button type="button" className="btn small" disabled={act.busy || (c.max !== null && c.value >= c.max)} aria-label={`${grant.label} ${c.label} to ${p.name}`} onClick={() => void run(r, grant.id, p.accountId, c.id)}>+</button>}
                          {take && (take.resource === '*' || take.resource === c.id) && <button type="button" className="btn small" disabled={act.busy || c.value <= 0} aria-label={`${take.label} ${c.label} from ${p.name}`} onClick={() => void run(r, take.id, p.accountId, c.id)}>−</button>}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
          <section className="card stack">
            <h2 style={{ margin: 0 }}>Changes</h2>
            {!log.data ? <Loading /> : log.data.log.length === 0 ? <p className="small muted">Nothing yet.</p> : (
              <ul className="stack tight small" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {log.data.log.map((l) => (
                  <li key={l.id}>
                    <span className="tiny muted">{timeShort(l.at)}</span> <strong>{nameOf(l.accountId)}</strong> {labelOf(l.modId, l.resource)} {l.before} → {l.after}
                    <span className="tiny muted"> · {actionOf(l.modId, l.action)}{l.by ? ` by ${nameOf(l.by)}` : ''}{l.note && !l.note.startsWith('reroll of ') ? ` · ${l.note}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {toastNode}
    </div>
  );
}

/** My counters with their Use buttons. A reroll used here is for a roll made with real dice; in chat, press Reroll under the roll. */
export function MyHouseRulesCard() {
  const { w, me } = useWorld();
  const { list, players } = useHouseRules();
  const act = useAction();
  const { toast, toastNode } = useToast();
  const mine = players.find((p) => p.accountId === me);
  const rules = withCounters(list).filter((r) => r.sheet);
  if (!mine || !rules.length) return null;
  const use = (r: HouseRule, action: string, reroll: boolean) => act.run(async () => {
    await w.call('POST', `/mods/${r.id}/act`, { action, ...(reroll ? { atTable: true } : {}) });
    toast('Used');
  });
  return (
    <section className="card stack" aria-label="House rules">
      {rules.map((r) => (
        <div key={r.id} className="stack tight">
          <div className="card-head"><h2>{r.sheet!.title}</h2></div>
          {(mine.mods[r.id] ?? []).filter((c) => r.sheet!.resources.includes(c.id)).map((c) => {
            const a = r.actions.find((x) => (x.by === 'owner' || x.by === 'any') && x.resource === c.id);
            return (
              <div key={c.id} className="row between" style={{ gap: 8 }}>
                <span><Chip c={c} /> <span className="small">{c.label}</span></span>
                {a && <button type="button" className="btn small" disabled={act.busy || c.value <= 0} title={a.reroll ? 'For a roll made with real dice. For a chat roll, press Reroll under it.' : undefined} onClick={() => void use(r, a.id, !!a.reroll)}>{a.reroll ? 'Used at the table' : a.label}</button>}
              </div>
            );
          })}
        </div>
      ))}
      <ErrorBox error={act.error} />
      {toastNode}
    </section>
  );
}

export function PlayerHouseRules() {
  const { list, rules } = useHouseRules();
  return (
    <div className="stack">
      <PageHead title="House rules" lead="The rules your table plays with on top of the game module." />
      <ErrorBox error={rules.error} />
      <MyHouseRulesCard />
      {!rules.data ? <Loading /> : list.length === 0 ? <Empty>Your DM has no house rules on.</Empty> : list.map((r) => (
        <section key={r.id} className="card stack">
          <h2 style={{ margin: 0 }}>{r.name}</h2>
          <div className="small">{r.summary}</div>
          {r.rules.map((x) => <div key={x.term} className="small"><strong>{x.term}.</strong> {x.text}</div>)}
          {r.commands.length > 0 && <div className="tiny muted">In chat: {r.commands.map((c) => <code key={c} style={{ marginRight: 6 }}>{c}</code>)}</div>}
        </section>
      ))}
    </div>
  );
}
