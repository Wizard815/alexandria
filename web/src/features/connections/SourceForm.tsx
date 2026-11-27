// The form that makes a source: pick the kind, pick or make its connection,
// fill in what is specific to this world, set the schedule and the audience.
// Used by "Add a source" on a world page and by the world setup flow.
import { Link } from 'react-router-dom';
import type { AlexandriaClient } from '@alx/client';
import { Field, Switch } from '../../ui/index.tsx';
import {
  AudiencePicker, ConfigFields, ConnectorPicker, SCHEDULES, defaultsFor, pickConfig,
  type Audience, type Connection, type Connector, type Preset, type Source,
} from './shared.tsx';

export interface Draft {
  kind: string; preset: Preset | null;
  /** The connection to use; '' means make a new one. */
  connectionId: string; newName: string; connValues: Record<string, any>;
  /** Settings specific to the world. */
  values: Record<string, any>;
  name: string; schedule: string; audience: Audience; confirm: boolean; share: boolean;
}

export function newDraft(connectors: Connector[], connections: Connection[]): Draft {
  const kind = connectors[0]?.id ?? '';
  return fresh(kind, connectors, connections);
}
function fresh(kind: string, connectors: Connector[], connections: Connection[], preset: Preset | null = null): Draft {
  const c = connectors.find((x) => x.id === kind);
  const mine = connections.filter((x) => x.kind === kind);
  return {
    kind, preset, connectionId: mine[0]?.id ?? '', newName: '', connValues: { ...defaultsFor(c, 'connection'), ...(preset?.config ?? {}) }, values: defaultsFor(c, 'source'),
    name: '', schedule: '', audience: 'auto', confirm: false, share: false,
  };
}

/** Is the draft ready to save? Returns what is missing, or null. */
export function problem(d: Draft, c: Connector | undefined): string | null {
  if (!c) return 'Pick a kind of source';
  if (!d.name.trim()) return 'Give the source a name';
  if (c.hasConnection && !d.connectionId && !d.newName.trim()) return 'Name the new connection';
  if (d.audience === 'party' && !d.confirm) return 'Tick the box to confirm sharing with players';
  return null;
}

/** Make the connection when needed, then the source. Returns the source. */
export async function saveDraft(client: AlexandriaClient, worldId: string, d: Draft, c: Connector, onConnection?: (id: string) => void): Promise<Source> {
  let connectionId = d.connectionId;
  let own = pickConfig(c, d.values, 'source');
  if (c.hasConnection && !connectionId) {
    const made = await client.request<Connection>('POST', '/api/admin/connections', { kind: c.id, name: d.newName.trim(), config: pickConfig(c, d.connValues, 'connection'), ...(d.preset ? { presetId: d.preset.id } : {}) });
    connectionId = made.id;
    onConnection?.(made.id);
  }
  if (!c.hasConnection) own = pickConfig(c, { ...d.connValues, ...d.values }, 'source');
  return client.request<Source>('POST', `/api/admin/worlds/${worldId}/sources`, {
    ...(connectionId ? { connectionId } : { kind: c.id }), name: d.name.trim(), config: own, defaultVisibility: d.audience === 'auto' && d.share ? 'party' : 'gm',
    scheduleMinutes: d.schedule ? Number(d.schedule) : null, audience: d.audience, ...(d.audience === 'party' ? { confirmParty: true } : {}),
  });
}

export function SourceFields({ d, set, connectors, connections, parts = ['kind', 'connection', 'settings', 'audience'] }: {
  d: Draft; set: (next: Draft) => void; connectors: Connector[]; connections: Connection[]; parts?: ('kind' | 'connection' | 'settings' | 'audience')[];
}) {
  const c = connectors.find((x) => x.id === d.kind);
  const mine = connections.filter((x) => x.kind === d.kind);
  const up = (patch: Partial<Draft>) => set({ ...d, ...patch });
  return (
    <>
      {parts.includes('kind') && (
        <ConnectorPicker connectors={connectors} kind={d.kind} presetId={d.preset?.id ?? ''} onPick={(k, p) => set(fresh(k, connectors, connections, p))} />
      )}
      {parts.includes('connection') && c?.hasConnection && (
        <div className="stack">
          <Field label="Connection" help={<>The account this source reads with. Manage them in <Link to="/admin/sources?tab=connections">Connections</Link>.</>}>
            <select value={d.connectionId} onChange={(e) => up({ connectionId: e.target.value })}>
              {mine.map((x) => <option key={x.id} value={x.id}>{x.name} · used by {x.sources} source{x.sources === 1 ? '' : 's'}</option>)}
              <option value="">New connection…</option>
            </select>
          </Field>
          {!d.connectionId && (
            <div className="stack card" style={{ background: 'transparent' }}>
              <Field label="Name for the new connection"><input value={d.newName} maxLength={80} placeholder={`e.g. My ${c.label.replace(/\s*\(.*\)/, '')} account`} onChange={(e) => up({ newName: e.target.value })} /></Field>
              <ConfigFields c={c} scope="connection" v={d.connValues} editing={false} onChange={(k, x) => up({ connValues: { ...d.connValues, [k]: x } })} />
            </div>
          )}
        </div>
      )}
      {parts.includes('settings') && c && (
        <div className="stack">
          <Field label="Name of this source"><input value={d.name} maxLength={80} placeholder="e.g. Saltmarsh campaign" onChange={(e) => up({ name: e.target.value })} /></Field>
          {/* A kind without a connection keeps all of its settings here. */}
          <ConfigFields c={c.hasConnection ? c : { ...c, fields: c.fields.map((f) => ({ ...f, scope: 'source' as const })) }} scope="source" v={c.hasConnection ? d.values : { ...d.connValues, ...d.values }} editing={false} onChange={(k, x) => up({ values: { ...d.values, [k]: x } })} />
          {!c.push && <Field label="Sync on its own"><select value={d.schedule} onChange={(e) => up({ schedule: e.target.value })}>{SCHEDULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>}
        </div>
      )}
      {parts.includes('audience') && c && (
        <div className="stack">
          <AudiencePicker value={d.audience} onChange={(a) => up({ audience: a, confirm: false })} confirmed={d.confirm} onConfirm={(v) => up({ confirm: v })} />
          {d.audience === 'auto' && <label className="row small"><Switch checked={d.share} onChange={(v) => up({ share: v })} label="Share what the source shares" /> Let players see what the source itself shows its players. Off: everything stays GM-only until a page is marked shared.</label>}
        </div>
      )}
    </>
  );
}
