// The Table's own blocks (pages/dm/Table.tsx). Features add theirs through the registry (dmTable).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ErrorBox, useAction } from '../../ui/index.tsx';
import { TableCard } from '../../ui/TableCard.tsx';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { coins, dateLong, timeShort, when } from '../../lib/format.ts';
import { mergeCopies, type PageRow } from '../library/treeModel.ts';
import { FogCanvas, FOG_ASPECT, pickPicture, pictureStyle, useFog, useMapPictures, useTableDisplay } from '../../features/screens/fog.tsx';
import { MarkLayer, RouteLayer, type Mark } from '../player/mapParts.tsx';
import { lsGet, lsSet } from './shared.tsx';

const since = (iso: string) => { const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

// ---- Right now ----

/** The session: running or not, for how long, recording or not, and the next game night with its answers. */
export function SessionBlock() {
  const { w } = useWorld();
  const chat = useLoad<any>(() => w.call('GET', '/sessionchat/current'), [w], ['chat-session']);
  const audio = useLoad<any>(() => w.call('GET', '/audio/status'), [w], ['recording']);
  const cal = useLoad(() => w.calendar(), [w], ['calendar', 'rsvp', 'reschedule']);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  const session = chat.data?.session ?? null;
  const rec = audio.data?.recording ? audio.data.session : null;
  const running = !!session || !!rec;
  const started = session?.startedAt ?? session?.started_at ?? rec?.startedAt ?? rec?.started_at ?? null;
  const next = (cal.data ?? []).find((s: any) => s.status === 'scheduled' && s.ends_at >= new Date().toISOString());
  const title = session?.title || rec?.title || '';
  return (
    <TableCard id="session" title="Session" icon="fa-dice-d20" link={['calendar', 'Game nights']} tone={running ? 'live' : undefined}>
      {running ? (
        <div className="tb-big" data-testid="tb-session-live">
          <div className="tb-live"><span className={rec ? 'au-rec-dot' : 'live-dot'} /><b>{rec ? 'Recording' : 'In session'}</b>{started && <span className="muted">for {since(started)}</span>}</div>
          {title && <div className="small muted tb-ellipsis">{title}</div>}
        </div>
      ) : (
        <div className="tb-big">
          <b>No session running</b>
          <div className="small muted">Start one with <i className="fa-solid fa-play" aria-hidden="true" /> <b>Start session</b> at the top: it opens the table chat and the recording.</div>
        </div>
      )}
      {next ? (
        <div className="tb-next">
          <span className="tiny faint">Next game night</span>
          <strong className="tb-ellipsis">{next.title}</strong>
          <span className="small muted">{dateLong(next.starts_at)} · {timeShort(next.starts_at)}–{timeShort(next.ends_at)}{next.location ? ` · ${next.location}` : ''}</span>
          <div className="row small">
            {(['yes', 'maybe', 'no'] as const).map((a) => (
              <span key={a} className={`chip ${a === 'yes' ? 'green' : a === 'no' ? 'red' : 'gold'}`}>{next.rsvps.filter((r: any) => r.answer === a).length} {a === 'yes' ? 'going' : a}</span>
            ))}
            {next.reschedules.length > 0 && <span className="chip red">{next.reschedules.length} reschedule ask</span>}
          </div>
        </div>
      ) : cal.data && <span className="small faint">No game night on the calendar.</span>}
    </TableCard>
  );
}

/** Who has checked in, with where they are. */
export function HereBlock() {
  const { w } = useWorld();
  const act = useAction();
  const live = useLoad<any>(() => w.live(), [w], ['presence']);
  const L = live.data;
  return (
    <TableCard id="here" title="At the table" icon="fa-users" badge={L ? `${L.here.length} of ${L.members}` : undefined} link={['party', 'Players']}>
      <ErrorBox error={live.error || act.error} />
      {L?.here.length ? (
        <ul className="tb-here">
          {L.here.map((h: any) => {
            const name = h.character_name || h.display_name;
            return (
              <li key={h.account_id} title={h.location || undefined}>
                <span className={`tb-avatar${h.role === 'dm' ? ' dm' : ''}`} aria-hidden="true">{initials(name)}</span>
                <span className="tb-here-name"><b>{name}</b>{h.role === 'dm' ? <span className="tiny faint">GM</span> : h.location ? <span className="tiny faint tb-ellipsis">{h.location}</span> : null}</span>
              </li>
            );
          })}
        </ul>
      ) : <span className="small muted">Nobody has checked in yet.</span>}
      <div className="row">
        <button type="button" className="btn small" disabled={act.busy} onClick={() => act.run(() => w.here('At the table'))}>I'm here</button>
        {!!L?.here.length && <button type="button" className="btn small ghost" disabled={act.busy} onClick={() => act.run(() => w.call('DELETE', '/live/presence/all'))}>Clear everyone</button>}
      </div>
    </TableCard>
  );
}

// ---- Play ----

/** A map: either what the table screen shows (fog as the GM's tint, marks, and a picker that changes the table), or any map
 * just for the GM to look at, which changes nothing on the table. */
export function MapBlock() {
  const { w, info, me } = useWorld();
  const act = useAction();
  const { display, set } = useTableDisplay();
  const { options, loading } = useMapPictures();
  const modeKey = `alx.dm.table.mapmode.${info.id}`, lookKey = `alx.dm.table.lookmap.${info.id}`;
  const [mode, setMode] = useState<'table' | 'look'>(() => lsGet<'table' | 'look'>(modeKey, 'table'));
  const [look, setLook] = useState<string>(() => lsGet<string>(lookKey, ''));
  const maps = lsGet<string[]>(`alx.maps.${info.id}`, ['world']);
  const tableMap = display?.mapId ?? lsGet<string>(`alx.map.${info.id}`, maps[0] ?? 'world');
  const mapId = mode === 'table' ? tableMap : 'world';
  const want = mode === 'table' ? display?.pic ?? lsGet<Record<string, string>>(`alx.mapbg.${info.id}`, {})[tableMap] ?? '' : look;
  const pic = pickPicture(options, want);
  const fog = useFog(mapId, pic?.value ?? 'none');
  const marks = useLoad<Mark[]>(() => w.call('GET', `/map/${encodeURIComponent(mapId)}/marks`), [w, mapId], ['map-mark', 'map-mark-removed']);
  const shown = (marks.data ?? []).filter((m) => !m.hidden_by_dm);
  const onTable = mode === 'table';
  const pickMode = (m: 'table' | 'look') => { setMode(m); lsSet(modeKey, m); };
  if (!loading && !options.length) {
    return <TableCard id="map" title="Map" icon="fa-map" link={['map', 'Map']} quiet="No map pictures yet: upload one on the Map page or import maps from Kanka or LegendKeeper." />;
  }
  return (
    <TableCard id="map" title={onTable ? 'Map on the table' : 'Map'} icon="fa-map" link={['map', 'Open the map']}
      badge={<span className="tb-seg" role="radiogroup" aria-label="Which map">
        <button type="button" role="radio" aria-checked={onTable} className={onTable ? 'on' : ''} onClick={() => pickMode('table')} data-testid="tb-map-mode-table">On the table</button>
        <button type="button" role="radio" aria-checked={!onTable} className={!onTable ? 'on' : ''} onClick={() => pickMode('look')} data-testid="tb-map-mode-look">Just for me</button>
      </span>}>
      <div className="tb-map" style={{ aspectRatio: String(FOG_ASPECT), ...pictureStyle(pic, fog.ready) }} data-testid="tb-map-view">
        {fog.ready && fog.state && <FogCanvas state={fog.state} tint />}
        <RouteLayer marks={shown} draft={[]} selected={null} onPick={() => {}} />
        <MarkLayer marks={shown} selected={null} onPick={() => {}} me={me} />
        {!pic && <span className="tb-map-empty muted">Pick a map</span>}
      </div>
      <div className="row">
        <label className="small muted tb-map-pick">{onTable ? 'On the table' : 'Looking at'}
          <select value={pic?.value ?? ''} disabled={act.busy || loading}
            onChange={(e) => { const v = e.target.value; if (onTable) void act.run(() => set({ mapId, pic: v })); else { setLook(v); lsSet(lookKey, v); } }} data-testid="tb-map-pick">
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {fog.state?.enabled && <span className="chip"><i className="fa-solid fa-cloud" aria-hidden="true" /> fog on</span>}
        <span className="grow" />
        <span className="small faint">{onTable ? `${shown.length} mark${shown.length === 1 ? '' : 's'}` : 'Players do not see this'}</span>
        {onTable
          ? <a className="btn small" href={`/w/${info.slug}/screen/table`} target="_blank" rel="noreferrer"><i className="fa-solid fa-up-right-from-square" aria-hidden="true" /> Table screen</a>
          : pic && <button type="button" className="btn small" disabled={act.busy} onClick={() => void act.run(() => set({ mapId: tableMap, pic: pic.value }))} title="Show this map on the table screen">Put on the table</button>}
      </div>
      <ErrorBox error={act.error} />
    </TableCard>
  );
}

interface FxChip { text: string; title: string; tone: string; icon?: string }

/** What is on a combatant, as chips: conditions and effects (with rounds left or when they end), concentration, death saves. */
function effectChips(c: any): FxChip[] {
  const out: FxChip[] = [];
  for (const e of Array.isArray(c.effects) ? c.effects : []) {
    const name = typeof e === 'string' ? e : e?.name;
    if (!name) continue;
    const left = typeof e === 'object' && e.rounds ? ` · ${e.rounds} rd` : '';
    const until = typeof e === 'object' && e.until ? ` · until ${e.until.at} of turn` : '';
    const down = /^(dead|stable|dying|unconscious)$/i.test(name);
    out.push({ text: `${name}${left}`, title: `${name}${left}${until}`, tone: down ? 'red' : 'gold' });
  }
  if (c.concentration?.spell) out.push({ text: c.concentration.spell, title: `Concentrating on ${c.concentration.spell}${c.concentration.dc ? ` (save DC ${c.concentration.dc} due)` : ''}`, tone: c.concentration.dc ? 'red' : 'teal', icon: 'fa-brain' });
  const ds = c.death_saves;
  if (ds && (ds.success || ds.fail || ds.successes || ds.failures)) {
    const ok = ds.success ?? ds.successes ?? 0, bad = ds.fail ?? ds.failures ?? 0;
    out.push({ text: `${'●'.repeat(ok)}${'○'.repeat(Math.max(0, 3 - ok))} / ${'✕'.repeat(bad)}`, title: `Death saves: ${ok} passed, ${bad} failed`, tone: 'red', icon: 'fa-skull' });
  }
  return out;
}

/** The fight: round, whose turn, and everyone in initiative order with their health. */
export function CombatBlock() {
  const { w } = useWorld();
  const act = useAction();
  const live = useLoad<any>(() => w.live(), [w], ['combat']);
  const combat = live.data?.combat;
  if (!live.data) return null;
  if (!combat?.active) return <TableCard id="combat" title="Combat" icon="fa-khanda" link={['combat', 'Set one up']} quiet="No fight running." />;
  const list: any[] = combat.combatants ?? [];
  const turn = list.length ? combat.turn % list.length : 0;
  return (
    <TableCard id="combat" title="Combat" icon="fa-khanda" tone="red" badge={`Round ${combat.round}`} link={['combat', 'Tracker']}>
      <div className="row between">
        <span>Turn: <b className="tb-accent">{list[turn]?.name ?? '—'}</b>{list.length > 1 && <span className="small muted"> · then {list[(turn + 1) % list.length]?.name}</span>}</span>
        <button type="button" className="btn primary small" disabled={act.busy} onClick={() => act.run(() => w.nextTurn())} data-testid="tb-next-turn">Next turn <i className="fa-solid fa-forward-step" aria-hidden="true" /></button>
      </div>
      <ol className="tb-init" aria-label="Initiative order">
        {list.map((c, i) => {
          const pct = c.hp !== null && c.max_hp ? Math.max(0, Math.min(100, Math.round((c.hp / c.max_hp) * 100))) : null;
          const fx = effectChips(c);
          return (
            <li key={c.id} className={`${i === turn ? 'now' : ''}${c.is_pc ? ' pc' : ''}${c.hidden ? ' hidden' : ''}${c.hp === 0 ? ' down' : ''}`} aria-current={i === turn ? 'step' : undefined} data-testid="tb-combatant">
              <span className="tb-init-n">{c.initiative}</span>
              <span className="tb-init-who">
                <span className="tb-init-name tb-ellipsis">{c.name}{c.hidden && <i className="fa-solid fa-eye-slash" title="Hidden from players" aria-label="hidden" />}</span>
                {fx.length > 0 && <span className="tb-fx" aria-label={`Effects on ${c.name}`}>{fx.map((f, j) => <span key={j} className={`tb-fx-chip ${f.tone}`} title={f.title}>{f.icon && <i className={`fa-solid ${f.icon}`} aria-hidden="true" />}{f.text}</span>)}</span>}
              </span>
              {pct !== null ? <span className="tb-hp" title={`${c.hp}/${c.max_hp} HP`}><span style={{ width: `${pct}%` }} className={pct <= 25 ? 'low' : pct <= 50 ? 'mid' : ''} /></span> : <span />}
              <span className="tiny muted">{c.hp !== null ? `${c.hp}/${c.max_hp}` : ''}{c.temp_hp > 0 && <span className="tb-temp"> +{c.temp_hp}</span>}</span>
              <span className="tiny faint tb-ac" title="Armour class">{c.ac !== null && c.ac !== undefined ? <><i className="fa-solid fa-shield-halved" aria-hidden="true" /> {c.ac}</> : ''}</span>
            </li>
          );
        })}
      </ol>
      <ErrorBox error={act.error} />
    </TableCard>
  );
}

// ---- Waiting on you ----

/** Everything waiting on the GM: approvals, disputes, requests and the assistant's proposed changes. */
export function NeedsBlock() {
  const { w, info, nameOf } = useWorld();
  const base = `/w/${info.slug}/gm`;
  const requests = useLoad(() => w.requests(), [w], ['request']);
  const approvals = useLoad<any>(() => w.call('GET', '/approvals'), [w], ['approval', 'coin', 'item', 'item-removed']);
  const agent = useLoad<{ actions: unknown[] }>(() => w.call<{ actions: unknown[] }>('GET', '/agent/actions?status=pending').catch(() => ({ actions: [] })), [w], ['agent']);
  const openReq = (requests.data ?? []).filter((r: any) => r.status === 'open');
  const c = approvals.data?.counts;
  const toApprove = c ? c.coin + c.items : 0;
  const proposals = agent.data?.actions?.length ?? 0;
  const total = openReq.length + toApprove + (c?.disputes ?? 0) + proposals;
  if (!requests.data) return null;
  if (!total) return <TableCard id="needs" title="Waiting on you" icon="fa-inbox" link={['inbox', 'Inbox']} quiet="Nothing. All quiet." />;
  return (
    <TableCard id="needs" title="Waiting on you" icon="fa-inbox" tone="gold" badge={total} link={['inbox', 'Inbox']}>
      <ul className="tb-list">
        {toApprove > 0 && <li><Link to={`${base}/inbox?tab=approvals`}><i className="fa-solid fa-scale-balanced" aria-hidden="true" /> {toApprove} coin or item change{toApprove === 1 ? '' : 's'} to approve</Link></li>}
        {(c?.disputes ?? 0) > 0 && <li><Link to={`${base}/inbox?tab=approvals`} className="tb-danger"><i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> {c.disputes} dispute{c.disputes === 1 ? '' : 's'}</Link></li>}
        {proposals > 0 && <li><Link to={`${base}/minerva`}><i className="fa-solid fa-wand-magic-sparkles" aria-hidden="true" /> {proposals} change{proposals === 1 ? '' : 's'} the assistant proposed</Link></li>}
        {openReq.slice(0, 4).map((r: any) => (
          <li key={r.id} className="row between"><Link to={`${base}/inbox?tab=requests`} className="tb-ellipsis"><i className="fa-solid fa-hand" aria-hidden="true" /> {r.title}</Link><span className="tiny muted">{nameOf(r.author_id)}</span></li>
        ))}
        {openReq.length > 4 && <li className="small muted">and {openReq.length - 4} more requests</li>}
      </ul>
    </TableCard>
  );
}

export function MessagesBlock() {
  const { w, me, nameOf } = useWorld();
  const threads = useLoad(() => w.threads(), [w], ['thread', 'message']);
  if (!threads.data) return null;
  const recent = threads.data.slice(0, 4);
  if (!recent.length) return <TableCard id="messages" title="Messages" icon="fa-envelope" link={['messages', 'Open']} quiet="No chats you're in." />;
  return (
    <TableCard id="messages" title="Messages" icon="fa-envelope" link={['messages', 'Open']}>
      <ul className="tb-list">
        {recent.map((t: any) => (
          <li key={t.id} className="row between">
            <span className="grow tb-ellipsis"><b>{t.title || t.members.filter((m: string) => m !== me).map(nameOf).join(', ')}</b>{t.last ? <span className="muted"> · {t.last}</span> : ''}</span>
            <span className="tiny faint">{when(t.last_at)}</span>
          </li>
        ))}
      </ul>
    </TableCard>
  );
}

// ---- The world ----

export function PurseBlock() {
  const { w, info } = useWorld();
  const live = useLoad<any>(() => w.live(), [w], ['coin']);
  const purse = live.data?.purse;
  if (!live.data) return null;
  if (!purse) return <TableCard id="purse" title="Party pouch" icon="fa-sack-dollar" link={['settings', 'Settings']} quiet="The party pouch is off." />;
  return (
    <TableCard id="purse" title="Party pouch" icon="fa-sack-dollar" tone="gold" link={['party', 'Players']}>
      <b className="tb-coin">{coins(purse.cp, info.settings.coins)}</b>
      <ul className="tb-list">
        {purse.recent.slice(0, 4).map((e: any) => (
          <li key={e.id} className="row between small"><span className="muted tb-ellipsis">{e.note || 'Coin'}</span><span className={e.amount_cp < 0 ? 'tb-danger' : 'tb-ok'}>{e.amount_cp > 0 ? '+' : ''}{coins(e.amount_cp, info.settings.coins)}</span></li>
        ))}
        {!purse.recent.length && <li className="small faint">No coin moved yet.</li>}
      </ul>
    </TableCard>
  );
}

export function LibraryBlock() {
  const { w, info } = useWorld();
  const pages = useLoad<PageRow[]>(() => w.pages(), [w], ['page']);
  if (!pages.data) return null;
  const lib = mergeCopies(pages.data).rows;
  if (!lib.length) return <TableCard id="library" title="Library" icon="fa-book" link={['library', 'Library']} quiet="No pages yet." />;
  const kinds = [...lib.reduce((m, r) => m.set(r.kind, (m.get(r.kind) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const recent = [...lib].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  return (
    <TableCard id="library" title="Library" icon="fa-book" badge={`${lib.length} pages`} link={['library', 'Library']}>
      <div className="kind-grid">{kinds.map(([k, n]) => <Link key={k} className="kind-tile" to={`/w/${info.slug}/gm/library?kind=${encodeURIComponent(k)}`}><b>{n}</b>{k}</Link>)}</div>
      <span className="tiny faint">Changed lately</span>
      <ul className="tb-list">{recent.map((r) => <li key={r.id}><Link className="tb-ellipsis" to={`/w/${info.slug}/gm/library?page=${encodeURIComponent(r.id)}`}>{r.title}</Link></li>)}</ul>
    </TableCard>
  );
}
