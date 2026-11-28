// A compact fog-of-war panel for the side screen and the pop-out window: the same map picture the table screen shows (the GM's
// choice, kept on the server), with the fog tools over it, so rooms are uncovered from the side monitor while the players
// watch the table. Choosing a map or picture here is choosing what the table shows.
import { useLoad, useWorld } from '../../lib/world.tsx';
import { MarkLayer, RouteLayer, type Mark } from '../../pages/player/mapParts.tsx';
import { FogCanvas, FogDraw, FogToolbar, pickPicture, pictureStyle, useFog, useFogEditor, useMapPictures, useTableDisplay } from './fog.tsx';

function stored<T>(key: string, fallback: T): T {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
}

export default function FogPanel() {
  const { w, info } = useWorld();
  const { display, set } = useTableDisplay();
  const { options, loading } = useMapPictures();
  const maps = stored<string[]>(`alx.maps.${info.id}`, ['world']);
  const mapId = display?.mapId ?? stored<string>(`alx.map.${info.id}`, maps[0] ?? 'world');
  const mapList = maps.includes(mapId) ? maps : [mapId, ...maps];
  const want = display?.pic ?? stored<Record<string, string>>(`alx.mapbg.${info.id}`, {})[mapId] ?? '';
  const pic = pickPicture(options, want);
  const key = pic?.value ?? 'none';
  const fog = useFog(mapId, key);
  const marks = useLoad<Mark[]>(() => w.marks(mapId) as Promise<Mark[]>, [w, mapId], ['map-mark', 'map-mark-removed', 'fog']);
  // Using the fog tools pins the display to what the GM is looking at, so the table cannot be showing a different picture.
  const ed = useFogEditor(mapId, key, fog, () => { if (display?.pic == null || display?.mapId == null) void set({ mapId, pic: key }); });

  return (
    <div className="fog-panel" data-testid="fog-panel">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="row small" style={{ gap: 6 }}>Map
          <select className="input" aria-label="Map the table shows" data-testid="fog-map-select" value={mapId} onChange={(e) => void set({ mapId: e.target.value, pic: null })}>
            {mapList.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="row small grow" style={{ gap: 6 }}>Picture
          <select className="input grow" aria-label="Map picture the table shows" data-testid="fog-pic-select" value={options.some((o) => o.value === key) ? key : 'none'} onChange={(e) => void set({ mapId, pic: e.target.value })}>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            <option value="none">Blank map</option>
          </select>
        </label>
      </div>
      {!options.length && <p className="small muted">{loading ? 'Looking for maps…' : 'No map pictures yet; the table shows a blank map.'}</p>}
      <FogToolbar ed={ed} />
      <div className="fog-map" data-testid="fog-map" style={pictureStyle(pic, fog.ready)}>
        {fog.ready && fog.state && <FogCanvas state={fog.state} extra={ed.pending} tint />}
        <RouteLayer marks={marks.data ?? []} draft={[]} selected={null} onPick={() => {}} />
        <MarkLayer marks={marks.data ?? []} selected={null} onPick={() => {}} />
        <FogDraw ed={ed} active={ed.enabled} />
      </div>
      <p className="tiny faint">{ed.enabled ? 'Drag on the map to uncover (or cover) it. The table sees the fog solid; you see it as a tint.' : 'Fog is off for this picture: the table shows the whole map. Turn it on to start fully fogged.'}</p>
    </div>
  );
}
