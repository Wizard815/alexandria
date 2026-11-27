// /w/:world/screen/table: the screen lying face up on the table, which the players gather around. It is the battle map and
// the initiative order, big, with large touch targets and a rotate control for whichever side someone is sitting.
//
// THE PLAYERS SEE THIS, even when the GM's login opened it. So it never trusts itself to hide things: every read below asks
// the server for the players' copy (?view=players), and nothing here branches on isDM. A GM-only pin, a hidden foe, a monster's
// AC or a map picture only the GM may see is never in the page to begin with.
import { useEffect, useState } from 'react';
import { useLoad, useWorld } from '../../lib/world.tsx';
import { MarkLayer, RouteLayer, ICONS, type Mark } from '../../pages/player/mapParts.tsx';
import type { CombatView } from '../../pages/player/Live.tsx';
import { FogCanvas, pickPicture, pictureStyle, useFog, useMapPictures, useTableDisplay } from './fog.tsx';
import './screens.css';

const PLAYERS = { view: 'players' };
type Rot = 0 | 90 | 180 | 270;
type View = 'map' | 'board';
const ZOOMS = [1, 1.5, 2, 3];
const ROT_KEY = 'alx.screens.table.rot';

function stored<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}
function keep(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private window */ } }

export default function TableScreen() {
  const { w, isDM, info } = useWorld();
  const [rot, setRot] = useState<Rot>(() => { const r = stored<number>(ROT_KEY, 0); return ([0, 90, 180, 270].includes(r) ? r : 0) as Rot; });
  const [view, setView] = useState<View>('map');
  const [zoom, setZoom] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { document.title = `Table · ${info?.name ?? 'Alexandria'}`; }, [info?.name]);

  // Which map and which picture of it is the GM's choice (set from the GM's map page or the fog panel, followed live). Until the
  // GM has chosen, the first map and picture the players may see.
  const { display } = useTableDisplay();
  const maps = stored<string[]>(`alx.maps.${info.id}`, ['world']);
  const mapId = display?.mapId ?? stored<string>(`alx.map.${info.id}`, maps[0] ?? 'world');

  const combat = useLoad<CombatView>(() => w.call('GET', '/live/combat', undefined, PLAYERS), [w], ['combat']);
  const marks = useLoad<Mark[]>(() => w.call('GET', `/map/${encodeURIComponent(mapId)}/marks`, undefined, PLAYERS), [w, mapId], ['map-mark', 'map-mark-removed', 'fog']);
  const { options } = useMapPictures('players');
  const board = useLoad<{ doc: { shapes?: any[] } }>(() => w.whiteboard() as Promise<any>, [w], ['whiteboard']);

  // Only a picture the players may see is ever drawn: an address typed on the GM's Map page is not carried over.
  const want = display?.pic ?? stored<Record<string, string>>(`alx.mapbg.${info.id}`, {})[mapId] ?? '';
  const pic = pickPicture(options, want);
  const fog = useFog(mapId, pic?.value ?? 'none', 'players');

  const rotate = (by: number) => { const r = ((((rot + by) % 360) + 360) % 360) as Rot; setRot(r); keep(ROT_KEY, r); };

  const c = combat.data;
  const active = !!c?.active;
  const selected = (marks.data ?? []).find((m) => m.id === sel) ?? null;
  const swap = rot === 90 || rot === 270;
  // A quarter turn swaps the box's sides, so it is sized to the screen turned the other way and then rotated into place.
  const frame: React.CSSProperties = swap
    ? { width: '100vh', height: '100vw', left: '50%', top: '50%', transform: `translate(-50%, -50%) rotate(${rot}deg)` }
    : { inset: 0, transform: rot ? 'rotate(180deg)' : undefined };

  if (!isDM) return <div className="t-fantasy"><div className="page"><p className="muted">The table screen is opened by the GM.</p></div></div>;
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
                  <div className="ts-map" data-testid="table-map" style={{ width: `${ZOOMS[zoom] * 100}%`, ...pictureStyle(pic, fog.ready) }}
                    onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-mark]')) setSel(null); }}>
                    {fog.ready && fog.state && <FogCanvas state={fog.state} />}
                    <RouteLayer marks={marks.data ?? []} draft={[]} selected={sel} onPick={(m) => setSel(m.id)} />
                    <MarkLayer marks={marks.data ?? []} selected={sel} onPick={(m) => setSel(m.id)} />
                  </div>
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
              ) : <p className="muted">The GM is keeping the order hidden.</p>}
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
