// Connections: the account-level half of a source. A connection holds a
// connector's account settings and secrets (a Kanka token, a LegendKeeper API
// key, an MCP URL and token, a generic API's auth and field mapping). A
// source is a connection plus what is specific to one world (the campaign id,
// the project, a folder, the audience, the schedule). Many sources, in many
// worlds, can use one connection.
//
// This file has no routes: the sync, the WorldLore workspace and the admin
// routes all ask `effectiveConfig` for the settings a source really runs with.
import type { DB } from '../core/db.ts';
import { all, one, run } from '../core/db.ts';
import { id, now } from '../core/util.ts';
import type { Connector, ConfigField } from './connector.ts';
import { connectorFor } from './registry.ts';

export const SECRET_MASK = '••••';

export const AUDIENCES = ['auto', 'gm', 'party'] as const;
export type SourceAudience = (typeof AUDIENCES)[number];
export const normAudience = (v: unknown): SourceAudience => (v === 'gm' || v === 'party' ? v : 'auto');
export const AUDIENCE_LABEL: Record<SourceAudience, string> = { auto: 'Follows the source', gm: 'GM only', party: 'Shared with players' };

const parse = (s: unknown): Record<string, any> => { try { const v = JSON.parse(String(s || '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

export const isConnectionField = (f: ConfigField) => f.scope === 'connection';
export const connectionKeys = (c: Connector): Set<string> => new Set(c.fields.filter(isConnectionField).map((f) => f.key));
/** Does this connector have anything to keep on a connection? (A folder or a push source does not.) */
export const hasConnection = (c: Connector) => c.fields.some(isConnectionField);

/** Split settings into the connection's and the source's. A key the connector does not list stays with the source. */
export function splitConfig(c: Connector, cfg: Record<string, any>) {
  const keys = connectionKeys(c);
  const connection: Record<string, any> = {};
  const source: Record<string, any> = {};
  for (const [k, v] of Object.entries(cfg)) (keys.has(k) ? connection : source)[k] = v;
  return { connection, source };
}

const stable = (o: Record<string, any>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));

export interface ConnectionRow { id: string; name: string; kind: string; config: string; notes: string; created_at: string; updated_at: string }

export function getConnection(db: DB, connectionId: string | null | undefined): ConnectionRow | null {
  return connectionId ? one<ConnectionRow>(db, 'SELECT * FROM connections WHERE id = ?', connectionId) ?? null : null;
}

/**
 * The settings a source runs with: the connection's settings for the
 * connection fields, the source's own for everything else. A source with no
 * connection (an older one, or a folder) is just its own config.
 */
export function effectiveConfig(db: DB, src: { kind: string; config?: string | null; connection_id?: string | null }): Record<string, any> {
  const own = parse(src.config);
  const conn = getConnection(db, src.connection_id);
  if (!conn) return own;
  const c = connectorFor(src.kind, own);
  const keys = c ? connectionKeys(c) : new Set<string>();
  const cc = parse(conn.config);
  const out: Record<string, any> = { ...own };
  for (const k of keys) { if (cc[k] !== undefined) out[k] = cc[k]; else delete out[k]; }
  return out;
}

/** Settings for the admin panel: secrets are never sent, only a mask when one is set. */
export function maskedConfig(c: Connector | null, cfg: Record<string, any>) {
  const secret = new Set((c?.fields ?? []).filter((f) => f.secret).map((f) => f.key).concat(['token', 'apiKey', 'password', 'mcpToken']));
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, secret.has(k) ? (v ? SECRET_MASK : '') : v]));
}

/** Keep stored secrets where the panel sent the mask (or nothing). */
export function keepSecrets(c: Connector, next: Record<string, any>, prev: Record<string, any>) {
  const out = { ...next };
  for (const f of c.fields) if (f.secret && (out[f.key] === SECRET_MASK || out[f.key] === undefined)) { if (prev[f.key] !== undefined) out[f.key] = prev[f.key]; else delete out[f.key]; }
  return out;
}

/** A plain-language name for a connection made from a source. */
function nameFor(db: DB, c: Connector) {
  const base = c.label.replace(/\s*\(.*\)\s*$/, '').trim() || c.id;
  const taken = new Set(all<{ name: string }>(db, 'SELECT name FROM connections').map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return `${base} ${id('')}`;
}

export function createConnection(db: DB, a: { name: string; kind: string; config: Record<string, any>; notes?: string }): ConnectionRow {
  const cid = id('con_');
  run(db, 'INSERT INTO connections (id, name, kind, config, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', cid, a.name, a.kind, stable(a.config), a.notes ?? '', now(), now());
  return one<ConnectionRow>(db, 'SELECT * FROM connections WHERE id = ?', cid)!;
}

/**
 * Point a source that has its own full config at a connection: reuse a
 * connection with the same connector and the same account settings, or make
 * one. Idempotent. Returns the connection id, or null when the connector has
 * nothing to keep on a connection.
 */
export function adoptSource(db: DB, src: { id: string; kind: string; config?: string | null; connection_id?: string | null; name?: string }): string | null {
  if (src.connection_id) return src.connection_id;
  const own = parse(src.config);
  const c = connectorFor(src.kind, own);
  if (!c || !hasConnection(c)) return null;
  const { connection, source } = splitConfig(c, own);
  if (!Object.values(connection).some((v) => v !== '' && v !== undefined && v !== null)) return null;
  const want = stable(connection);
  const same = all<ConnectionRow>(db, 'SELECT * FROM connections WHERE kind = ?', c.id).find((r) => stable(parse(r.config)) === want);
  const row = same ?? createConnection(db, { name: nameFor(db, c), kind: c.id, config: connection, notes: `Made from the source "${src.name ?? src.id}" when connections were introduced.` });
  run(db, 'UPDATE sources SET connection_id = ?, config = ?, kind = ? WHERE id = ?', row.id, JSON.stringify(source), c.id, src.id);
  return row.id;
}

/** Make connections for every source that has account settings of its own. Safe to run again. */
export function migrateSources(db: DB): number {
  let n = 0;
  for (const s of all<any>(db, 'SELECT id, kind, config, connection_id, name FROM sources WHERE connection_id IS NULL')) if (adoptSource(db, s)) n++;
  return n;
}

/** Records (relations, timelines, calendars, markers) a source gave: `gm` forces them GM-only. */
export function forceRecordsGm(db: DB, sourceId: string) {
  for (const t of ['intake_relations', 'intake_timelines', 'intake_calendars', 'intake_markers']) {
    try { run(db, `UPDATE ${t} SET visibility = 'gm' WHERE source_id = ?`, sourceId); } catch { /* the intake tables are made by the intake feature */ }
  }
  try {
    for (const t of all<any>(db, 'SELECT world_id, external_id, data FROM intake_timelines WHERE source_id = ?', sourceId)) {
      const groups = JSON.parse(t.data || '[]');
      for (const g of groups) for (const e of g.events ?? []) e.visibility = 'gm';
      run(db, 'UPDATE intake_timelines SET data = ? WHERE source_id = ? AND world_id = ? AND external_id = ?', JSON.stringify(groups), sourceId, t.world_id, t.external_id);
    }
  } catch { /* nothing to rewrite */ }
}
