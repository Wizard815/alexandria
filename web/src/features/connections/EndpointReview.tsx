// Generic API: "Find endpoints". Looks for the app's OpenAPI spec (or samples
// the base URL and the list URLs given), shows a table of endpoint, guessed
// role, mapping and confidence, and saves what the GM accepts. An endpoint
// left unused, or with no role, is never called.
import { useState } from 'react';
import { useAuth } from '../../lib/auth.tsx';
import { ErrorBox, Modal, useAction } from '../../ui/index.tsx';
import type { Connection } from './shared.tsx';

interface Endpoint {
  path: string; key: string; role: string; use: boolean; confidence?: number; note?: string; detailPath?: string;
  idField?: string; titleField?: string; bodyField?: string; summaryField?: string; parentField?: string; tagsField?: string; updatedField?: string; visibilityField?: string; sharedValues?: string;
  [k: string]: unknown;
}
interface Found { source: 'openapi' | 'sample'; specUrl: string | null; title: string | null; calls: number; endpoints: Endpoint[]; notes: string[] }

const ROLES: [string, string][] = [['pages', 'Pages / articles'], ['people', 'People / characters'], ['places', 'Places / locations'], ['items', 'Items'], ['organisations', 'Organisations / factions'], ['events', 'Events / timelines'], ['calendars', 'Calendars'], ['tags', 'Tags'], ['images', 'Images / files'], ['map', 'Map images'], ['unknown', 'Not sure']];
const IMPORTED = ['pages', 'people', 'places', 'items', 'organisations', 'events', 'tags', 'calendars', 'images', 'map'];
/** Roles that make library pages: at least one must be in use. */
const PAGE_ROLES = ['pages', 'people', 'places', 'items', 'organisations', 'events'];
const MAP: [keyof Endpoint, string][] = [['idField', 'id'], ['titleField', 'title'], ['bodyField', 'body'], ['summaryField', 'summary'], ['parentField', 'parent'], ['tagsField', 'tags'], ['updatedField', 'updated'], ['visibilityField', 'visibility'], ['sharedValues', 'shared when']];
/** Fields of a calendars or images endpoint. Shown only for that role. */
const CAL_MAP: [string, string][] = [['monthsField', 'months'], ['weekdaysField', 'weekdays'], ['currentDateField', 'today'], ['epochYearField', 'epoch year'], ['yearSuffixField', 'year suffix'], ['eventsField', 'events']];
const IMG_MAP: [string, string][] = [['urlField', 'address'], ['pageField', 'page it is of']];
const mapFor = (role: string): [keyof Endpoint, string][] => [
  ...MAP.filter(([k]) => !(role === 'calendars' || role === 'images' || role === 'map') || ['idField', 'titleField', 'updatedField', 'visibilityField', 'sharedValues'].includes(String(k))),
  ...((role === 'calendars' ? CAL_MAP : role === 'images' || role === 'map' ? IMG_MAP : []) as [keyof Endpoint, string][]),
];
const conf = (c?: number) => (c === undefined ? '' : c >= 0.75 ? 'green' : c >= 0.5 ? 'gold' : 'red');

export function EndpointReview({ connection, onClose, onDone }: { connection: Connection; onClose: () => void; onDone: (m: string) => void }) {
  const { client } = useAuth();
  const [baseUrl, setBaseUrl] = useState<string>(String(connection.config.baseUrl ?? ''));
  const [lists, setLists] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [eps, setEps] = useState<Endpoint[]>(() => { try { return JSON.parse(String(connection.config.endpoints || '[]')); } catch { return []; } });
  const a = useAction();

  const find = () => a.run(async () => {
    const r = await client.request<Found>('POST', '/api/admin/connections/api-discover', { baseUrl, connectionId: connection.id, listUrls: lists.split(/[\s,]+/).filter(Boolean).slice(0, 2) });
    setFound(r);
    setEps(r.endpoints);
  });
  const edit = (i: number, patch: Partial<Endpoint>) => setEps((o) => o.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const used = eps.filter((e) => e.use && PAGE_ROLES.includes(e.role)).length;
  const save = () => a.run(async () => {
    await client.request('PUT', `/api/admin/connections/${connection.id}/endpoints`, { baseUrl, endpoints: eps.map((e) => ({ ...e, use: e.use && IMPORTED.includes(e.role) })) });
    onDone(`Saved ${used} endpoint${used === 1 ? '' : 's'}. Use "Save mapping as preset" to reuse them in other worlds.`);
  });

  return (
    <Modal title={`Find endpoints · ${connection.name}`} onClose={onClose}>
      <div className="stack">
        <label className="stack tight"><span className="label">Base URL of the app's API</span><input value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label className="stack tight"><span className="label">One or two list URLs (only used when the app has no spec)</span><input value={lists} placeholder="/articles /characters" onChange={(e) => setLists(e.target.value)} /></label>
        <div className="row"><button type="button" className="btn primary" disabled={a.busy || !baseUrl.trim()} onClick={() => void find()}>{a.busy ? 'Looking…' : 'Find endpoints'}</button>
          <span className="tiny muted">Looks for an OpenAPI or Swagger spec, then makes at most a few sample calls. Nothing is imported yet.</span></div>
        {found && <div className="note small">{found.notes.map((m, i) => <div key={i}>{m}</div>)}<div>{found.calls} call{found.calls === 1 ? '' : 's'} made.</div></div>}
        {!!eps.length && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table small" style={{ width: '100%' }}>
              <thead><tr><th>Use</th><th>Endpoint</th><th>Role</th><th>Mapping</th><th>Sure</th></tr></thead>
              <tbody>
                {eps.map((e, i) => (
                  <tr key={e.key + i} style={{ opacity: e.use ? 1 : 0.6 }}>
                    <td><input type="checkbox" aria-label={`Use ${e.path}`} checked={e.use} disabled={!IMPORTED.includes(e.role)} onChange={(x) => edit(i, { use: x.target.checked })} /></td>
                    <td className="mono">{e.path}{e.detailPath ? <div className="tiny muted">{e.role === 'images' || e.role === 'map' ? 'download' : 'detail'} {e.detailPath}</div> : null}</td>
                    <td><select aria-label={`Role of ${e.path}`} value={e.role} onChange={(x) => edit(i, { role: x.target.value, use: e.use && IMPORTED.includes(x.target.value) })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                    <td>
                      <details><summary className="tiny">{mapFor(e.role).filter(([k]) => e[k]).map(([k, l]) => `${l}: ${String(e[k])}`).join(' · ') || 'no mapping'}</summary>
                        <div className="stack tight">{mapFor(e.role).map(([k, l]) => <label key={String(k)} className="row tiny" style={{ gap: 4 }}><span style={{ width: 80 }}>{l}</span><input value={String(e[k] ?? '')} onChange={(x) => edit(i, { [k]: x.target.value || undefined })} /></label>)}</div>
                        {e.note && <div className="tiny muted">{e.note}</div>}
                      </details>
                    </td>
                    <td><span className={`chip ${conf(e.confidence)}`}>{e.confidence === undefined ? '-' : `${Math.round(e.confidence * 100)}%`}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!eps.length && <p className="tiny muted" style={{ margin: 0 }}>Endpoints that are not ticked, or that have no role, are never called. Records stay GM-only unless a visibility field is mapped and holds a "shared" value. Calendars become the world's calendars; images are downloaded (PNG, JPEG, GIF or WebP, up to 4 MB, a few at a time) and shown on the page they belong to, only to people who may see that page.</p>}
        <ErrorBox error={a.error} />
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn primary" disabled={a.busy || !eps.length || !used} onClick={() => void save()}>Save endpoints</button></div>
      </div>
    </Modal>
  );
}
