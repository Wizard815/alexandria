// /w/:world/screen/table: the screen lying face up on the table, which the players gather around. It is the battle map and
// the initiative order, big, with large touch targets and a rotate control for whichever side someone is sitting.
//
// THE PLAYERS SEE THIS, even when the DM's login opened it. So it never trusts itself to hide things: every read below asks
// the server for the players' copy (?view=players), and nothing here branches on isDM. A DM-only pin, a hidden foe, a monster's
// AC or a map picture only the DM may see is never in the page to begin with.
import { useEffect, useMemo, useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { MarkLayer, RouteLayer, ICONS, type Mark } from '../../pages/player/mapParts.tsx';
import type { CombatView } from '../../pages/player/Live.tsx';
import './screens.css';

const PLAYERS = { view: 'players' };
type Rot = 0 | 90 | 180 | 270;
type View = 'map' | 'board';
const ZOOMS = [1, 1.5, 2, 3];
const ROT_KEY = 'alx.screens.table.rot';
const PIC_KEY = 'alx.screens.table.pic.';
const MAP_KEY = 'alx.screens.table.map.';

function stored<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}
function keep(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ } }

interface Pic { value: string; label: string; url: string }

export default function TableScreen() {
  const { w, isDM, info } = useWorld();
  const [rot, setRot] = useState<Rot>(() => { const r = stored<number>(ROT_KEY, 0); return ([0, 90, 180, 270].includes(r) ? r : 0) as Rot; });
  const [view, setView] = useState<View>('map');
  const [zoom, setZoom] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { document.title = `Table · ${info?.name ?? 'Alexandria'}`; }, [info?.name]);

  // Which map (the DM's own choice on the Map page to begin with) and which picture of it.
  const maps = stored<string[]>(`alx.maps.${info.id}`, ['world']);
  const [mapId, setMapId] = useState<string>(() => stored<string>(MAP_KEY + info.id, '') || stored<string>(`alx.map.${info.id}`, maps[0] ?? 'world'));
  const [pics, setPics] = useState<Record<string, string>>(() => stored<Record<string, string>>(PIC_KEY + info.id, {}));

  const combat = useLoad<CombatView>(() => w.call('GET', '/live/combat', undefined, PLAYERS), [w], ['combat']);
  const marks = useLoad<Mark[]>(() => w.call('GET', `/map/${encodeURIComponent(mapId)}/marks`, undefined, PLAYERS), [w, mapId], ['map-mark', 'map-mark-removed']);
  const libMaps = useLoad<{ id: string; name: string; url: string }[]>(() => w.call<any[]>('GET', '/files/maps', undefined, PLAYERS).catch(() => []), [w], ['libfile']);
  const imported = useLoad<{ id: string; name: string; url: string }[]>(() => w.call<any[]>('GET', '/intake/map-images', undefined, PLAYERS).catch(() => []), [w], ['page']);
  const board = useLoad<{ doc: { shapes?: any[] } }>(() => w.whiteboard() as Promise<any>, [w], ['whiteboard']);

  const options = useMemo<Pic[]>(() => [
    ...(imported.data ?? []).map((m) => ({ value: `imp:${m.id}`, label: m.name || 'Map', url: m.url })),
    ...(libMaps.data ?? []).map((f) => ({ value: `lib:${f.id}`, label: f.name, url: f.url })),
  ], [imported.data, libMaps.data]);
  // Only a picture the players may see is ever drawn: an address typed on the DM's Map page is not carried over.
  const dmChoice = stored<Record<string, string>>(`alx.mapbg.${info.id}`, {})[mapId] ?? '';
  const want = pics[mapId] ?? dmChoice;
  const pic = want === 'none' ? null : options.find((o) => o.value === want) ?? options[0] ?? null;

  const rotate = (by: number) => { const r = ((((rot + by) % 360) + 360) % 360) as Rot; setRot(r); keep(ROT_KEY, r); };
  const pickMap = (id: string) => { setMapId(id); setSel(null); keep(MAP_KEY + info.id, id); };
  const pickPic = (v: string) => { const n = { ...pics, [mapId]: v }; setPics(n); keep(PIC_KEY + info.id, n); };

  const c = combat.data;
  const active = !!c?.active;
  const selected = (marks.data ?? []).find((m) => m.id === sel) ?? null;
  const swap = rot === 90 || rot === 270;
  // A quarter turn swaps the box's sides, so it is sized to the screen turned the other way and then rotated into place.
  const frame: React.CSSProperties = swap
    ? { width: '100vh', height: '100vw', left: '50%', top: '50%', transform: `translate(-50%, -50%) rotate(${rot}deg)` }
    : { inset: 0, transform: rot ? 'rotate(180deg)' : undefined };

  if (!isDM) return <div className="t-fantasy"><div className="page"><p className="muted">The table screen is opened by the DM.</p></div></div>;
  return (
    <div className="t-fantasy ts-root" data-testid="table-screen" data-view="players">
      <div className="ts-stage" style={frame}>
        <header className="ts-bar">
          <strong className="ts-title">{info.name}</strong>
          {active && <span className="ts-round" data-testid="table-round">Round {c!.round}</span>}
          <span className="ts-sp" />
          <div className="ts-group" role="group" aria-label="What to show">
            <button type="button" className={`ts-btn${view === 'map' ? ' on' : ''}`} aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button>
            <button type="button" className={`ts-btn${view === 'board' ? ' on' : ''}`} aria-pressed={view === 'board'} onClick={() => setView('board')}>Whiteboard</button>
          </div>
          {view === 'map' && (
            <div className="ts-group" role="group" aria-label="Zoom">
              <button type="button" className="ts-btn" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>−</button>
              <span className="ts-zoom" aria-live="polite">{Math.round(ZOOMS[zoom] * 100)}%</span>
              <button type="button" className="ts-btn" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>+</button>
            </div>
          )}
          <div className="ts-group" role="group" aria-label="Rotate the screen">
            <button type="button" className="ts-btn" aria-label="Rotate a quarter turn left" data-testid="table-rot-left" onClick={() => rotate(-90)}>⟲</button>
            <span className="ts-zoom" data-testid="table-rot" aria-live="polite">{rot}°</span>
            <button type="button" className="ts-btn" aria-label="Rotate a quarter turn right" data-testid="table-rot-right" onClick={() => rotate(90)}>⟳</button>
          </div>
          <button type="button" className="ts-btn" aria-label="Full screen" onClick={() => { void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.()); }}>⛶</button>
        </header>

        <div className={`ts-main${active ? ' fight' : ''}`}>
          <section className="ts-canvas" aria-label={view === 'map' ? `Map ${mapId}` : 'Whiteboard'}>
            {view === 'map' ? (
              <>
                <div className="ts-scroll">
                  <div className="ts-map" data-testid="table-map" style={{ width: `${ZOOMS[zoom] * 100}%`, background: pic ? `center / 100% 100% no-repeat url("${pic.url.replace(/"/g, '%22')}"), #15212D` : undefined }}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-mark]')) setSel(null); }}>
                    <RouteLayer marks={marks.data ?? []} draft={[]} selected={sel} onPick={(m) => setSel(m.id)} />
                    <MarkLayer marks={marks.data ?? []} selected={sel} onPick={(m) => setSel(m.id)} />
                  </div>
                </div>
                <div className="ts-pickers">
                  {maps.length > 1 && (
                    <div className="ts-group" role="group" aria-label="Which map">
                      {maps.map((m) => <button key={m} type="button" className={`ts-btn${m === mapId ? ' on' : ''}`} aria-pressed={m === mapId} onClick={() => pickMap(m)}>{m}</button>)}
                    </div>
                  )}
                  {options.length > 0 && (
                    <select className="ts-select" aria-label="Map picture" value={pic?.value ?? 'none'} onChange={(e) => pickPic(e.target.value)}>
                      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      <option value="none">Blank map</option>
                    </select>
                  )}
                </div>
                {selected && <MarkCard m={selected} onClose={() => setSel(null)} />}
              </>
            ) : <BoardView shapes={board.data?.doc?.shapes ?? []} />}
          </section>

          {active && (
            <aside className="ts-order" aria-label="Initiative order" data-testid="table-order">
              <h2>Initiative</h2>
              {c?.combatants ? (
                c.combatants.length ? (
                  <ol>
                    {c.combatants.map((x) => (
                      <li key={x.id} className={x.id === c.currentId ? 'current' : ''} aria-current={x.id === c.currentId ? 'step' : undefined} ref={(el) => { if (el && x.id === c.currentId) el.scrollIntoView?.({ block: 'nearest' }); }}>
                        <span className="ts-arrow" aria-hidden="true">{x.id === c.currentId ? '▶' : ''}</span>
                        <span className="ts-who"><strong>{x.name}</strong>
                          {x.effects.length > 0 && <span className="ts-fx">{x.effects.map((e) => (e.rounds ? `${e.name} (${e.rounds})` : e.name)).join(', ')}</span>}
                        </span>
                        {x.health && (/^\d+$/.test(x.health) ? <Bar pct={Number(x.health)} /> : <span className="ts-health">{x.health}</span>)}
                      </li>
                    ))}
                  </ol>
                ) : <p className="muted">No one in the order yet.</p>
              ) : <p className="muted">The DM is keeping the order hidden.</p>}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return (
    <span role="img" aria-label={`${pct}% health`} className="ts-bar-health">
      <span style={{ width: `${pct}%`, background: pct > 50 ? 'var(--ok)' : pct > 25 ? 'var(--accent)' : 'var(--danger)' }} />
    </span>
  );
}

/** What a tapped mark says, large enough to read from across the table. */
function MarkCard({ m, onClose }: { m: Mark; onClose: () => void }) {
  const kind = m.kind === 'stop' ? `Stop ${m.data.n ?? ''}` : m.kind === 'icon' ? (ICONS.find((i) => i[0] === m.data.icon)?.[2] ?? 'Icon') : m.kind[0].toUpperCase() + m.kind.slice(1);
  return (
    <div className="ts-card" role="dialog" aria-label="Selected mark">
      <strong>{kind}</strong>
      {m.data.label && <span>{m.data.label}</span>}
      {m.data.text && <p>{m.data.text}</p>}
      <button type="button" className="ts-btn" onClick={onClose}>Close</button>
    </div>
  );
}

/** The shared whiteboard, to look at. (Everyone already sees all of it.) */
function BoardView({ shapes }: { shapes: any[] }) {
  return (
    <div className="ts-scroll">
      <svg viewBox="0 0 1600 1000" role="img" aria-label="Shared whiteboard" className="ts-board">
        {shapes.map((s) => (s.t === 'path'
          ? <polyline key={s.id} points={(s.pts ?? []).map((p: number[]) => p.join(',')).join(' ')} fill="none" stroke={s.color} strokeWidth={s.w ?? 4} strokeLinecap="round" strokeLinejoin="round" />
          : <text key={s.id} x={s.x} y={s.y} fill={s.color} fontSize={32} fontFamily="Alegreya, serif">{s.text}</text>))}
      </svg>
    </div>
  );
}
