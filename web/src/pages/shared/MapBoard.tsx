// The map, for players and the DM: pins, sticky notes, routes with arrows,
// numbered stops and icons, drawn over an optional map image.
// Players' tools follow World settings; the DM can hide or erase any mark.
// Coordinates are 0–100 on both axes, so marks stay put at any size.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useWorld, useLoad } from '../../lib/world.tsx';
import { when } from '../../lib/format.ts';
import { PageHead, ErrorBox, Field, VisChip, useAction, useToast } from '../../ui/index.tsx';
import { ICONS, MarkLayer, RouteLayer, type Mark, type Pt } from '../player/mapParts.tsx';

type Tool = 'select' | 'pin' | 'note' | 'route' | 'stop' | 'icon' | 'erase';
const TOOLS: [Tool, string, string][] = [
  ['select', '➤', 'Select'], ['pin', '📍', 'Pin'], ['note', '🗒', 'Note'], ['route', '✎', 'Route'],
  ['stop', '①', 'Stop'], ['icon', '⛺', 'Icon'], ['erase', '⌫', 'Erase'],
];
const HINT: Record<Tool, string> = {
  select: 'Click a mark to see it.',
  pin: 'Click the map to drop a pin.',
  note: 'Click the map to stick a note.',
  route: 'Click to add points. Double-click or press Enter to finish, Esc to cancel.',
  stop: 'Click to place the next numbered stop.',
  icon: 'Pick an icon, then click the map.',
  erase: 'Click a mark to erase it.',
};

function store<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
  });
  return [v, (x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* ignore */ } }];
}

export default function MapBoard() {
  const { w, info, isDM, me, nameOf } = useWorld();
  const s = info.settings;
  const [maps, setMaps] = store<string[]>(`alx.maps.${info.id}`, ['world']);
  const [mapId, setMapId] = store<string>(`alx.map.${info.id}`, maps[0] ?? 'world');
  const [bgs, setBgs] = store<Record<string, string>>(`alx.mapbg.${info.id}`, {});
  const bg = bgs[mapId] ?? '';
  const setBg = (url: string) => setBgs({ ...bgs, [mapId]: url });
  const marks = useLoad(() => w.marks(mapId) as Promise<Mark[]>, [w, mapId], ['map-mark', 'map-mark-removed']);
  const [tool, setTool] = useState<Tool>('select');
  const [icon, setIcon] = useState(ICONS[0][0]);
  const [vis, setVis] = useState<'party' | 'me' | 'dm'>('party');
  const [plan, setPlan] = useState('route');
  const [layers, setLayers] = useState({ party: true, mine: true, dm: true, hidden: true });
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [pending, setPending] = useState<{ kind: 'pin' | 'note' | 'icon'; x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<Pt>({ x: 50, y: 50 });
  const [focused, setFocused] = useState(false);
  const act = useAction();
  const { toast, toastNode } = useToast();
  const area = useRef<HTMLDivElement>(null);

  const allowed: Record<Tool, boolean> = {
    select: true, erase: true,
    pin: isDM || s.mapPins, note: isDM || s.mapPins, icon: isDM || s.mapPins,
    route: isDM || s.mapDraw, stop: isDM || s.mapStops,
  };
  useEffect(() => { if (!allowed[tool]) setTool('select'); }, [allowed, tool]);
  useEffect(() => { setDraft([]); setPending(null); }, [tool, mapId]);

  const shown = useMemo(() => (marks.data ?? []).filter((m) => {
    if (m.hidden_by_dm && !layers.hidden) return false;
    if (m.visibility === 'me') return layers.mine;
    if (m.visibility === 'dm') return layers.dm;
    return layers.party;
  }), [marks.data, layers]);
  const selected = (marks.data ?? []).find((m) => m.id === sel) ?? null;

  const point = (e: { clientX: number; clientY: number }): Pt => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)), y: Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)) };
  };

  const create = (body: Record<string, unknown>) => act.run(async () => {
    const m = await w.addMark(mapId, { visibility: vis, ...body }) as Mark;
    await marks.reload();
    setSel(m.id);
    return m;
  });

  const placeAt = (p: Pt) => {
    if (tool === 'pin' || tool === 'note' || tool === 'icon') setPending({ kind: tool, ...p });
    else if (tool === 'stop') void create({ kind: 'stop', x: p.x, y: p.y, plan });
    else if (tool === 'route') setDraft((d) => [...d, p]);
  };
  const finishRoute = () => {
    if (draft.length >= 2) void create({ kind: 'route', points: draft, arrow: true }).then(() => setDraft([]));
    else setDraft([]);
  };

  const onAreaClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-mark]')) return;
    if (tool === 'select' || tool === 'erase') { setSel(null); return; }
    placeAt(point(e));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const mv: Record<string, Pt> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    if (mv[e.key]) {
      e.preventDefault();
      setCursor((c) => ({ x: Math.min(100, Math.max(0, c.x + mv[e.key].x)), y: Math.min(100, Math.max(0, c.y + mv[e.key].y)) }));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (tool === 'route' && e.key === 'Enter' && draft.length >= 2 && !e.shiftKey) finishRoute();
      else if (tool !== 'select' && tool !== 'erase') placeAt(cursor);
    } else if (e.key === 'Escape') { setDraft([]); setPending(null); }
  };

  const canErase = (m: Mark) => isDM || m.author_id === me;
  const onMark = (m: Mark) => {
    if (tool === 'erase') {
      if (!canErase(m)) { toast('You can only erase your own marks'); return; }
      void act.run(async () => { await w.removeMark(mapId, m.id); await marks.reload(); if (sel === m.id) setSel(null); });
    } else setSel(m.id);
  };

  const switchMap = (id: string) => {
    const clean = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!clean) return;
    if (!maps.includes(clean)) setMaps([...maps, clean]);
    setMapId(clean);
    setSel(null);
  };

  return (
    <div className="page wide">
      <PageHead title="Map" lead={isDM ? 'Everyone\'s marks. Hide any mark from players, or erase it.' : 'Leave pins, notes and routes for the party, or private marks just for you.'} />
      <ErrorBox error={marks.error ?? act.error} />

      <div className="row" role="toolbar" aria-label="Map tools" style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--side)', border: '1px solid var(--line)' }}>
        {TOOLS.map(([k, glyph, label]) => (
          <button key={k} type="button" className={`btn small${tool === k ? ' on' : ''}`} aria-pressed={tool === k} disabled={!allowed[k]}
            title={allowed[k] ? HINT[k] : 'Turned off by the DM in World settings'} onClick={() => setTool(k)}>
            <span aria-hidden="true">{glyph}</span> {label}
          </button>
        ))}
        {tool === 'icon' && (
          <span className="row" role="radiogroup" aria-label="Icon" style={{ gap: 2 }}>
            {ICONS.map(([k, g, l]) => <button key={k} type="button" role="radio" aria-checked={icon === k} aria-label={l} title={l} className={`btn small${icon === k ? ' on' : ''}`} onClick={() => setIcon(k)}>{g}</button>)}
          </span>
        )}
        {tool === 'stop' && (
          <label className="row small" style={{ gap: 6 }}>Plan <input className="input" style={{ width: 120, minHeight: 30 }} value={plan} onChange={(e) => setPlan(e.target.value.slice(0, 60))} /></label>
        )}
        <span className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <span className="small muted">New marks:</span>
          <select className="input" style={{ width: 'auto', minHeight: 30 }} value={vis} onChange={(e) => setVis(e.target.value as any)} aria-label="Who sees new marks">
            <option value="party">Party</option><option value="me">Only me</option>{isDM && <option value="dm">DM only</option>}
          </select>
        </span>
      </div>

      <div className="cols">
        <div className="col-3 stack">
          <div ref={area} role="application" aria-label={`Map ${mapId}. ${HINT[tool]} Arrow keys move the cursor, Enter places.`} tabIndex={0}
            onClick={onAreaClick} onDoubleClick={(e) => { if (tool === 'route') { e.preventDefault(); finishRoute(); } }} onKeyDown={onKey}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            style={{
              position: 'relative', width: '100%', aspectRatio: '16 / 10', borderRadius: 10, border: '1px solid var(--line-strong)', overflow: 'hidden',
              cursor: tool === 'select' ? 'default' : tool === 'erase' ? 'not-allowed' : 'crosshair', userSelect: 'none',
              background: bg ? `center / 100% 100% no-repeat url("${bg.replace(/"/g, '%22')}"), #15212D` : 'radial-gradient(ellipse 40% 32% at 30% 42%, #4B4632 0 60%, transparent 61%), radial-gradient(ellipse 30% 40% at 64% 56%, #47432F 0 62%, transparent 63%), linear-gradient(160deg, #1A2A38, #15212D)',
            }}>
            <RouteLayer marks={shown} draft={draft} selected={sel} onPick={onMark} />
            <MarkLayer marks={shown} selected={sel} onPick={onMark} me={me} />
            {pending && <span aria-hidden="true" style={{ position: 'absolute', left: `${pending.x}%`, top: `${pending.y}%`, transform: 'translate(-50%,-50%)', width: 16, height: 16, borderRadius: '50%', border: '2px dashed var(--accent)' }} />}
            {focused && tool !== 'select' && <span aria-hidden="true" style={{ position: 'absolute', left: `${cursor.x}%`, top: `${cursor.y}%`, transform: 'translate(-50%,-50%)', width: 22, height: 22, borderRadius: '50%', border: '2px solid var(--teal)', boxShadow: '0 0 0 3px rgba(0,0,0,0.4)' }} />}
            <span style={{ position: 'absolute', left: 10, bottom: 8, padding: '3px 9px', borderRadius: 6, background: 'rgba(18,22,31,0.85)', fontSize: 13, color: '#D8CFB9', pointerEvents: 'none' }}>{HINT[tool]}</span>
          </div>
          {!marks.loading && !(marks.data ?? []).length && <p className="muted small">No marks on this map yet.</p>}
        </div>

        <aside className="col-1 stack loose">
          {pending && <PendingForm key={`${pending.x},${pending.y}`} p={pending} icon={icon} busy={act.busy} onCancel={() => setPending(null)}
            onPlace={async (label, text) => { const m = await create({ kind: pending.kind, x: pending.x, y: pending.y, label, ...(pending.kind === 'note' ? { text } : {}), ...(pending.kind === 'icon' ? { icon } : {}) }); if (m) setPending(null); }} />}

          {selected ? (
            <MarkPanel m={selected} author={selected.author_id === me ? 'You' : nameOf(selected.author_id)} canEdit={selected.author_id === me} canErase={canErase(selected)} isDM={isDM}
              onSave={(patch) => act.run(async () => { await w.call('PATCH', `/map/${encodeURIComponent(mapId)}/marks/${selected.id}`, patch); await marks.reload(); toast('Saved'); })}
              onErase={() => act.run(async () => { await w.removeMark(mapId, selected.id); setSel(null); await marks.reload(); })} />
          ) : !pending && <div className="note small">{HINT[tool]}</div>}

          <section className="card" aria-labelledby="layers-h">
            <h3 id="layers-h">Layers</h3>
            {([['party', 'Party marks'], ['mine', 'Only-me marks'], ...(isDM ? [['dm', 'DM marks'], ['hidden', 'Marks hidden from players']] : [])] as [keyof typeof layers, string][]).map(([k, l]) => (
              <label key={k} className="row small" style={{ gap: 8 }}><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {l}</label>
            ))}
          </section>

          <section className="card" aria-labelledby="maps-h">
            <h3 id="maps-h">Which map</h3>
            <div className="row" style={{ gap: 4 }}>
              {maps.map((m) => <button key={m} type="button" className={`btn small${m === mapId ? ' on' : ''}`} aria-pressed={m === mapId} onClick={() => switchMap(m)}>{m}</button>)}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); switchMap(String(f.get('map') ?? '')); e.currentTarget.reset(); }}>
              <label className="sr-only" htmlFor="map-new">New map name</label>
              <input id="map-new" name="map" className="input grow" placeholder="Another map, e.g. old-kesh" style={{ minHeight: 32 }} />
              <button type="submit" className="btn small">Open</button>
            </form>
            <Field label="Map image (this browser only)" help="Paste an image URL to draw over. Marks are shared; the image is not.">
              <input value={bg} onChange={(e) => setBg(e.target.value.trim())} placeholder="https://…/map.jpg" />
            </Field>
          </section>
        </aside>
      </div>
      {toastNode}
    </div>
  );
}

function PendingForm({ p, icon, busy, onPlace, onCancel }: { p: { kind: 'pin' | 'note' | 'icon' }; icon: string; busy: boolean; onPlace: (label: string, text: string) => void; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const title = p.kind === 'note' ? 'New sticky note' : p.kind === 'icon' ? `New ${ICONS.find((i) => i[0] === icon)?.[2] ?? 'icon'}` : 'New pin';
  return (
    <form className="card gold" onSubmit={(e) => { e.preventDefault(); if (p.kind !== 'note' || text.trim()) onPlace(label.trim(), text.trim()); }}>
      <h3>{title}</h3>
      {p.kind === 'note' ? (
        <Field label="Note"><textarea ref={ref as any} rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      ) : (
        <Field label="Label (optional)"><input ref={ref as any} maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      )}
      <div className="row end">
        <button type="button" className="btn small" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn small primary" disabled={busy || (p.kind === 'note' && !text.trim())}>Place</button>
      </div>
    </form>
  );
}

function MarkPanel({ m, author, canEdit, canErase, isDM, onSave, onErase }: { m: Mark; author: string; canEdit: boolean; canErase: boolean; isDM: boolean; onSave: (p: Record<string, unknown>) => void; onErase: () => void }) {
  const [label, setLabel] = useState(m.data.label ?? '');
  const [text, setText] = useState(m.data.text ?? '');
  useEffect(() => { setLabel(m.data.label ?? ''); setText(m.data.text ?? ''); }, [m.id, m.data.label, m.data.text]);
  const kind = m.kind === 'stop' ? `Stop ${m.data.n ?? ''}` : m.kind === 'icon' ? (ICONS.find((i) => i[0] === m.data.icon)?.[2] ?? 'Icon') : m.kind[0].toUpperCase() + m.kind.slice(1);
  return (
    <section className="card" aria-label="Selected mark">
      <div className="card-head"><h3>{kind}</h3><span className="row" style={{ gap: 4 }}><VisChip v={m.visibility} />{m.hidden_by_dm && <span className="chip red">Hidden</span>}</span></div>
      <span className="tiny faint">{author} · {when(m.created_at)}{m.kind === 'stop' && m.data.plan ? ` · plan “${m.data.plan}”` : ''}</span>
      {canEdit && m.kind !== 'route' ? (
        <>
          {m.kind === 'note' && <Field label="Note"><textarea rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
          <Field label="Label"><input maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <button type="button" className="btn small" onClick={() => onSave(m.kind === 'note' ? { label, text } : { label })}>Save</button>
        </>
      ) : (
        <>
          {m.data.text && <p className="read" style={{ fontSize: 16, whiteSpace: 'pre-line' }}>{m.data.text}</p>}
          {m.data.label && <p className="small">{m.data.label}</p>}
          {m.kind === 'route' && <p className="small muted">{m.data.points?.length ?? 0} points</p>}
        </>
      )}
      <div className="row">
        {isDM && m.visibility !== 'me' && <button type="button" className="btn small" onClick={() => onSave({ hidden: !m.hidden_by_dm })}>{m.hidden_by_dm ? 'Show to players' : 'Hide from players'}</button>}
        {canErase && <button type="button" className="btn small danger" onClick={onErase}>Erase</button>}
      </div>
    </section>
  );
}
