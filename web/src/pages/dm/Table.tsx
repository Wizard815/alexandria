// The DM's table: live blocks for the session at a glance.
import * as F from '../../features/registry.ts';
import { useServerMods } from '../../lib/servermods.ts';
import { useState } from 'react';
import { PageHead, ErrorBox, Empty, useAction } from '../../ui/index.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, dateLong, timeShort, when } from '../../lib/format.ts';
import { Link } from 'react-router-dom';
import { mergeCopies, type PageRow } from '../library/treeModel.ts';
import { DMLink, lsGet, lsSet, QUICK_KINDS } from './shared.tsx';

const BLOCKS: [string, string][] = [
  ['here', 'Who is here'], ['purse', 'Party pouch'], ['combat', 'Combat'], ['quick', 'Quick events'],
  ['requests', 'Requests'], ['calendar', 'Next session'], ['messages', 'Messages'], ['library', 'Library'],
];

export default function DMTable() {
  const mods = useServerMods();
  const { w, info, nameOf, me } = useWorld();
  const key = `alx.dm.table.${info.id}`;
  const [shown, setShown] = useState<string[]>(() => lsGet(key, BLOCKS.map((b) => b[0])));
  const [picking, setPicking] = useState(false);
  const act = useAction();

  const live = useLoad(() => w.live(), [w], ['presence', 'coin', 'combat']);
  const quick = useLoad(() => w.quickEvents(), [w], ['quick-event', 'quick-event-cancelled']);
  const requests = useLoad(() => w.requests(), [w], ['request']);
  const cal = useLoad(() => w.calendar(), [w], ['calendar', 'rsvp', 'reschedule']);
  const threads = useLoad(() => w.threads(), [w], ['thread', 'message']);

  const pages = useLoad<PageRow[]>(() => w.pages(), [w], ['page']);
  const lib = mergeCopies(pages.data ?? []).rows;
  const kinds = [...lib.reduce((m, r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const recent = [...lib].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6);

  const toggle = (k: string) => {
    const next = shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k];
    setShown(next);
    lsSet(key, next);
  };

  const L: any = live.data;
  const combat = L?.combat;
  const current = combat?.combatants?.[combat.turn % Math.max(combat.combatants.length, 1)];
  const openQuick = (quick.data ?? []).filter((e: any) => e.status === 'open');
  const openReq = (requests.data ?? []).filter((r: any) => r.status === 'open');
  const next = (cal.data ?? []).find((s: any) => s.status === 'scheduled' && s.ends_at >= new Date().toISOString());
  // A block with nothing in it is one link on the "All quiet" line, not an empty card.
  const quietBlocks: Record<string, [boolean, string, string]> = {
    combat: [!!L && !combat?.active, 'combat', 'Combat'], quick: [!!quick.data && !openQuick.length, 'quick', 'Quick events'], requests: [!!requests.data && !openReq.length, 'inbox?tab=requests', 'Requests'],
    calendar: [!!cal.data && !next, 'calendar', 'Next session'], messages: [!!threads.data && !threads.data.length, 'messages', 'Messages'],
  };
  const quiet = Object.entries(quietBlocks).filter(([k, v]) => v[0] && shown.includes(k));
  const full = (k: string) => shown.includes(k) && !quietBlocks[k]?.[0];
  const recentThreads = (threads.data ?? []).slice(0, 4);

  return (
    <div className="page wide">
      <PageHead title="Table" lead={`Everything live in ${info.name}.`}>
        <button type="button" className={`btn small${picking ? ' on' : ''}`} aria-expanded={picking} onClick={() => setPicking(!picking)}>Choose blocks</button>
      </PageHead>
      {picking && (
        <div className="card">
          <span className="small muted">Show these blocks (remembered on this device):</span>
          <div className="row">
            {BLOCKS.map(([k, label]) => (
              <button key={k} type="button" role="checkbox" aria-checked={shown.includes(k)} className={`btn small${shown.includes(k) ? ' on' : ''}`} onClick={() => toggle(k)}>{label}</button>
            ))}
          </div>
        </div>
      )}
      <ErrorBox error={live.error || act.error} />
      {quiet.length > 0 && <p className="small muted row" data-testid="quiet">All quiet: {quiet.map(([k, v]) => <DMLink key={k} to={v[1]} className="chip">{v[2]}</DMLink>)}</p>}
      {F.onlyOn(F.dmHome, mods).length > 0 && <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{F.onlyOn(F.dmHome, mods).map((C, i) => <C key={i} />)}</div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {shown.includes('library') && lib.length > 0 && (
          <section className="card" aria-labelledby="b-lib">
            <div className="card-head"><h2 id="b-lib">Library</h2><DMLink to="library" className="small">{lib.length} pages →</DMLink></div>
            <div className="kind-grid">{kinds.map(([k, n]) => <Link key={k} className="kind-tile" to={`/w/${info.slug}/dm/library?kind=${encodeURIComponent(k)}`}><b>{n}</b>{k}</Link>)}</div>
            <div className="stack tight small">{recent.map((r) => <Link key={r.id} to={`/w/${info.slug}/dm/library?page=${encodeURIComponent(r.id)}`}>{r.title}</Link>)}</div>
          </section>
        )}
        {shown.includes('here') && (
          <section className="card" aria-labelledby="b-here">
            <div className="card-head"><h2 id="b-here">Who is here</h2><span className="chip">{L ? `${L.here.length} of ${L.members}` : '…'}</span></div>
            {L?.here.length ? (
              <div className="stack tight">
                {L.here.map((h: any) => (
                  <div key={h.account_id} className="row between small">
                    <span><span className="live-dot" /> {h.character_name || h.display_name} {h.role === 'dm' && <span className="chip red">DM</span>}</span>
                    <span className="muted">{h.location}</span>
                  </div>
                ))}
              </div>
            ) : <Empty>Nobody has joined the session yet.</Empty>}
            <div className="row">
              <button type="button" className="btn small" disabled={act.busy} onClick={() => act.run(() => w.here('At the table'))}>I'm here</button>
              <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => act.run(() => w.call('DELETE', '/live/presence/all'))}>Clear everyone</button>
            </div>
          </section>
        )}

        {shown.includes('purse') && (
          <section className="card gold" aria-labelledby="b-purse">
            <div className="card-head"><h2 id="b-purse">Party pouch</h2><DMLink to="party" className="small">Party →</DMLink></div>
            {L?.purse ? (
              <>
                <b style={{ fontSize: 24, color: 'var(--accent-strong)' }}>{coins(L.purse.cp, info.settings.coins)}</b>
                <div className="stack tight small">
                  {L.purse.recent.slice(0, 4).map((e: any) => (
                    <div key={e.id} className="row between"><span className="muted">{e.note || 'Coin'}</span><span style={{ color: e.amount_cp < 0 ? 'var(--danger-text)' : 'var(--ok-text)' }}>{e.amount_cp > 0 ? '+' : ''}{coins(e.amount_cp, info.settings.coins)}</span></div>
                  ))}
                  {!L.purse.recent.length && <span className="faint">No coin moved yet.</span>}
                </div>
              </>
            ) : <Empty>The party pouch is off in Settings.</Empty>}
          </section>
        )}

        {full('combat') && (
          <section className="card" aria-labelledby="b-combat">
            <div className="card-head"><h2 id="b-combat">Combat</h2><DMLink to="combat" className="small">Tracker →</DMLink></div>
            {combat?.active ? (
              <>
                <span>Round <b>{combat.round}</b> · turn: <b style={{ color: 'var(--accent-strong)' }}>{current?.name ?? '—'}</b></span>
                <div className="stack tight small">
                  {combat.combatants.slice(0, 6).map((c: any, i: number) => (
                    <div key={c.id} className="row between" style={i === combat.turn % combat.combatants.length ? { color: 'var(--accent-strong)' } : undefined}>
                      <span>{c.initiative} · {c.name}{c.hidden && ' (hidden)'}</span>
                      <span className="muted">{c.hp !== null ? `${c.hp}/${c.max_hp}` : ''}</span>
                    </div>
                  ))}
                </div>
                <button type="button" className="btn primary small" disabled={act.busy} onClick={() => act.run(() => w.nextTurn())}>Next turn</button>
              </>
            ) : <Empty>No fight running. <DMLink to="combat">Set one up</DMLink>.</Empty>}
          </section>
        )}

        {full('quick') && (
          <section className="card" aria-labelledby="b-quick">
            <div className="card-head"><h2 id="b-quick">Quick events</h2><DMLink to="quick" className="small">Send one →</DMLink></div>
            {openQuick.length ? openQuick.slice(0, 4).map((e: any) => (
              <div key={e.id} className="row between small">
                <span><span className="chip gold">{QUICK_KINDS.find((k) => k[0] === e.kind)?.[1] ?? e.kind}</span> {e.title}</span>
                <span className="muted">{e.responses.length}/{e.audience.length} answered</span>
              </div>
            )) : <Empty>Nothing waiting on players.</Empty>}
          </section>
        )}

        {full('requests') && (
          <section className="card" aria-labelledby="b-req">
            <div className="card-head"><h2 id="b-req">Requests</h2><DMLink to="inbox?tab=requests" className="small">Review →</DMLink></div>
            {openReq.length ? openReq.slice(0, 4).map((r: any) => (
              <div key={r.id} className="row between small"><span>{r.title}</span><span className="muted">{nameOf(r.author_id)}</span></div>
            )) : <Empty>No open requests.</Empty>}
            {openReq.length > 4 && <span className="small muted">and {openReq.length - 4} more</span>}
          </section>
        )}

        {full('calendar') && (
          <section className="card" aria-labelledby="b-cal">
            <div className="card-head"><h2 id="b-cal">Next session</h2><DMLink to="calendar" className="small">Calendar →</DMLink></div>
            {next ? (
              <>
                <strong>{next.title}</strong>
                <span className="small muted">{dateLong(next.starts_at)} · {timeShort(next.starts_at)}–{timeShort(next.ends_at)}{next.location ? ` · ${next.location}` : ''}</span>
                <div className="row small">
                  {(['yes', 'maybe', 'no'] as const).map((a) => (
                    <span key={a} className={`chip ${a === 'yes' ? 'green' : a === 'no' ? 'red' : 'gold'}`}>{next.rsvps.filter((r: any) => r.answer === a).length} {a === 'yes' ? 'going' : a}</span>
                  ))}
                  {next.reschedules.length > 0 && <span className="chip red">{next.reschedules.length} reschedule ask</span>}
                </div>
              </>
            ) : <Empty>No session on the calendar.</Empty>}
          </section>
        )}

        {full('messages') && (
          <section className="card" aria-labelledby="b-msg">
            <div className="card-head"><h2 id="b-msg">Messages</h2><DMLink to="messages" className="small">Open →</DMLink></div>
            {recentThreads.length ? recentThreads.map((t: any) => (
              <div key={t.id} className="row between small">
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title || t.members.filter((m: string) => m !== me).map(nameOf).join(', ')}{t.last ? ` · ${t.last}` : ''}</span>
                <span className="faint">{when(t.last_at)}</span>
              </div>
            )) : <Empty>No chats you're in.</Empty>}
          </section>
        )}
      </div>
    </div>
  );
}
