// World settings (this world only), invite codes, and the world's audit log.
import { useState } from 'react';
import { PageHead, ErrorBox, Empty, Loading, Tabs, Switch, useAction, useToast } from '../../ui/index.tsx';
import { useWorld, useLoad, type WorldSettings } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { type ApprovalSettings, extra } from '../broker/shared.tsx';

type K = keyof WorldSettings | keyof ApprovalSettings;
type Row =
  | { k: K; label: string; help: string; type: 'toggle' }
  | { k: K; label: string; help: string; type: 'choice'; choices: [any, string][] };

const T = (k: K, label: string, help: string): Row => ({ k, label, help, type: 'toggle' });
const C = (k: K, label: string, help: string, choices: [any, string][]): Row => ({ k, label, help, type: 'choice', choices });

const GROUPS: [string, string, Row[]][] = [
  ['coin', 'Inventory & coin', [
    T('trackWeight', 'Track item weight', 'Off: no weight column or carried total on inventories.'),
    C('coins', 'Coin types', 'Which coins the purse shows.', [['gsc', 'Gold · silver · copper'], ['all', 'All five (pp gp ep sp cp)'], ['gold', 'Gold only']]),
    T('partyPurse', 'Shared party purse', 'A group purse beside each player’s own coin.'),
    T('dmEditsInventory', 'DM can edit player inventories', 'Every change is logged and the player sees it.'),
  ]],
  ['approvals', 'Approvals & broker', [
    T('playerChangesNeedApproval', 'Player coin and item changes need your approval', 'On: what players add, spend, move or remove waits in Approvals and shows as “Waiting for the DM”. Broker payments are never held.'),
    T('dmChangeReason', 'Ask me why when I change a player’s things', 'Your reason shows to the owner, who can confirm or dispute it.'),
    T('brokerEnabled', 'Information broker', 'Players can buy what their characters could learn, at prices you set on the broker page.'),
    C('brokerPayer', 'Who pays the broker', 'The party purse needs “Shared party purse” on.', [['self', 'The player who asks'], ['party', 'The party purse']]),
  ]],
  ['combat', 'Combat & quick events', [
    C('monsterHealth', 'Monster health shown to players', 'The party’s own health is never shown.', [['none', 'Hidden'], ['words', 'Words (Bloodied…)'], ['bar', 'Bar'], ['exact', 'Exact numbers']]),
    T('initiativeVisible', 'Players see the initiative order', 'Hidden foes stay hidden either way.'),
    C('quickEventTimer', 'Default quick-event timer', 'Seconds before a quick event closes.', [[10, '10 s'], [20, '20 s'], [30, '30 s'], [60, '60 s'], [null, 'No timer']]),
  ]],
  ['map', 'Map & whiteboard', [
    T('mapPins', 'Players can drop pins, notes and icons', 'You can hide or remove any mark.'),
    T('mapDraw', 'Players can draw routes', 'Lines and arrows on the map.'),
    T('mapStops', 'Numbered stops (1, 2, 3…)', 'Plan a route as ordered stops.'),
    C('whiteboardWipe', 'Who can wipe the whiteboard', 'A wipe asks to confirm and keeps history.', [['dm', 'Only me'], ['all', 'Anyone']]),
  ]],
  ['session', 'Sessions & messages', [
    C('calendar', 'Session calendar', 'Real-life game days with RSVP and day chat.', [['builtin', 'On'], ['off', 'Off']]),
    C('messageDays', 'Chats delete themselves after', 'The person who starts a chat can press Keep.', [[7, '7 days'], [14, '14 days'], [30, '30 days'], [null, 'Never']]),
    T('captions', 'Live captions for players', 'Players see the transcript in Live.'),
  ]],
  ['rules', 'Rules & look', [
    C('rules', 'Rules system', 'Used for terms in recaps and recalls.', [['dnd55', 'D&D 5.5'], ['dnd5', 'D&D 5e'], ['lancer', 'Lancer'], ['pokemon', 'Pokémon'], ['other', 'Other']]),
    C('requestDefault', 'New requests default to', 'Players can change it on each request.', [['dm', 'Only the DM'], ['party', 'Party can see']]),
    T('themeEffects', 'Allow theme effects', 'Embers, mist and other effects on players’ screens.'),
  ]],
];

export default function DMSettings() {
  const { info } = useWorld();
  const [tab, setTab] = useState<'settings' | 'invites' | 'audit'>('settings');
  return (
    <div className="page">
      <PageHead title="World settings" lead={`These apply to ${info.name} only. Nothing here can make DM-only content visible.`} />
      <Tabs label="Settings section" value={tab} onChange={setTab} items={[['settings', 'Settings'], ['invites', 'Invite players'], ['audit', 'Audit log']]} />
      {tab === 'settings' ? <SettingsForm /> : tab === 'invites' ? <Invites /> : <Audit />}
    </div>
  );
}

function SettingsForm() {
  const { w, info, reloadInfo } = useWorld();
  const [group, setGroup] = useState('coin');
  const act = useAction();
  const { toast, toastNode } = useToast();
  const s: Record<string, unknown> = { ...info.settings, ...extra(info.settings) };
  const set = (k: K, v: unknown) => act.run(async () => {
    await w.updateSettings({ [k]: v });
    await reloadInfo();
    toast('Saved');
  });
  const rows = GROUPS.find((g) => g[0] === group)![2];

  return (
    <div className="stack">
      <Tabs label="Settings group" value={group} onChange={setGroup} items={GROUPS.map(([k, label]) => [k, label] as [string, string])} />
      <ErrorBox error={act.error} />
      <section className="card flush">
        {rows.map((r) => (
          <div key={r.k} className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
            <div className="stack tight" style={{ flex: '1 1 300px' }}><strong style={{ fontWeight: 500 }}>{r.label}</strong><span className="small muted">{r.help}</span></div>
            {r.type === 'toggle' ? (
              <Switch checked={!!s[r.k]} onChange={(v) => void set(r.k, v)} label={r.label} />
            ) : (
              <div className="tabs" role="radiogroup" aria-label={r.label}>
                {r.choices.map(([v, label]) => (
                  <button key={String(v)} type="button" role="radio" aria-checked={s[r.k] === v} disabled={act.busy} className={`btn small${s[r.k] === v ? ' on' : ''}`} onClick={() => void set(r.k, v)}>{label}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
      {toastNode}
    </div>
  );
}

function Invites() {
  const { w, members } = useWorld();
  const act = useAction();
  const [role, setRole] = useState<'player' | 'guest'>('player');
  const [days, setDays] = useState(7);
  const [made, setMade] = useState<{ code: string; role: string; days: number } | null>(null);
  const link = made ? `${window.location.origin}/join?code=${encodeURIComponent(made.code)}` : '';

  return (
    <div className="cols">
      <section className="card gold col-2">
        <h2>Invite someone</h2>
        <p className="small muted">An invite code works once. The person picks a username and password on the Join page.</p>
        <div className="row">
          <span className="small muted">As</span>
          <div className="tabs" role="radiogroup" aria-label="Role">
            <button type="button" role="radio" aria-checked={role === 'player'} className={`btn small${role === 'player' ? ' on' : ''}`} onClick={() => setRole('player')}>Player</button>
            <button type="button" role="radio" aria-checked={role === 'guest'} className={`btn small${role === 'guest' ? ' on' : ''}`} onClick={() => setRole('guest')}>Guest (read only)</button>
          </div>
          <label className="row small muted">Expires in
            <select className="input" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
          </label>
        </div>
        <ErrorBox error={act.error} />
        <div className="row"><button type="button" className="btn primary" disabled={act.busy} onClick={() => void act.run(async () => { const r = await w.invite(role, days); setMade({ code: r.code, role, days }); })}>Make an invite code</button></div>
        {made && (
          <div className="ok-box stack tight">
            <strong>Copy this now. It won’t be shown again.</strong>
            <span className="mono" style={{ fontSize: 18, userSelect: 'all' }}>{made.code}</span>
            <span className="small">Or send this link: <span className="mono" style={{ userSelect: 'all', overflowWrap: 'anywhere' }}>{link}</span></span>
            <span className="tiny">{made.role} · expires in {made.days} days</span>
            <div className="row"><button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button></div>
          </div>
        )}
      </section>
      <section className="card col-1">
        <h3>In this world</h3>
        {members.map((m) => (
          <div key={m.id} className="row between small"><span>{m.character_name || m.display_name}{m.character_name && <span className="faint"> · {m.display_name}</span>}</span><span className={`chip ${m.role === 'dm' ? 'red' : m.role === 'player' ? 'teal' : ''}`}>{m.role}</span></div>
        ))}
        <span className="tiny faint">Roles and removals are in Library admin.</span>
      </section>
    </div>
  );
}

function Audit() {
  const { w, nameOf } = useWorld();
  const log = useLoad<any[]>(() => w.call('GET', '/audit', undefined, { limit: 200 }), [w]);
  if (log.error) return <ErrorBox error={log.error} />;
  if (!log.data) return <Loading what="audit log" />;
  return (
    <section className="card flush scroll-x">
      {log.data.length ? (
        <table className="table">
          <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Detail</th></tr></thead>
          <tbody>{log.data.map((a) => (
            <tr key={a.id}><td className="small">{when(a.at)}</td><td className="small">{nameOf(a.account_id)}</td><td className="mono">{a.action}</td><td className="small muted" style={{ overflowWrap: 'anywhere' }}>{a.detail}</td></tr>
          ))}</tbody>
        </table>
      ) : <Empty>Nothing logged yet.</Empty>}
    </section>
  );
}
