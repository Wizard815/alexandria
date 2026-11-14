// Records a source gives besides pages: relations, timelines, calendars and
// map markers. Stored in the intake_* tables (features/intake) and read back
// per viewer. Everything is fail closed:
// - a record is shared only when its source said "party" exactly
// - a relation or marker also needs every page it points at to be shared
// - a timeline event is shared only on its own say-so, inside a shared timeline
// - a record's text goes through the same block leak guard as a page
import type { DB } from '../core/db.ts';
import { all, one, run, tx } from '../core/db.ts';
import type { Block, Mention } from './model.ts';
import { blocksFor, playerBlocks } from './player.ts';
import type { CalendarDefinition, Capability, SyncRecord, TimelineGroup } from './connector.ts';

/** The tables for records (the `intake` feature owns them and adds this to its schema). Safe to run again. */
export const RECORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS intake_calendars (world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, source_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, definition TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'dm', current TEXT, PRIMARY KEY (world_id, source_id, external_id));

CREATE TABLE IF NOT EXISTS intake_relations (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  label TEXT NOT NULL,
  attitude INTEGER,
  visibility TEXT NOT NULL DEFAULT 'dm',
  PRIMARY KEY (world_id, source_id, external_id)
);

CREATE TABLE IF NOT EXISTS intake_timelines (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'dm',
  data TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (world_id, source_id, external_id)
);

CREATE TABLE IF NOT EXISTS intake_markers (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  map_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  shape TEXT,
  color TEXT,
  ref TEXT,
  visibility TEXT NOT NULL DEFAULT 'dm',
  PRIMARY KEY (world_id, source_id, external_id)
);

-- intake_calendars has no foreign key on source_id (its shape is shared with the clock), so clean up here.
CREATE TRIGGER IF NOT EXISTS intake_calendars_source_gone AFTER DELETE ON sources BEGIN
  DELETE FROM intake_calendars WHERE source_id = old.id;
END;
`;
const ready = new WeakSet<object>();

export interface RecordViewer { role: string; audience?: 'ai' | 'broker' }

/** Which capability a record kind needs a connector to have declared. */
export const RECORD_CAPABILITY: Record<SyncRecord['kind'], Capability> = { relation: 'relations', timeline: 'timelines', calendar: 'calendars', mapMarker: 'maps' };

const vis = (v: unknown): 'dm' | 'party' => (v === 'party' ? 'party' : 'dm');
const text = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const num = (v: unknown, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** The calendar shape the world clock reads. Anything missing gets a safe default. */
export function normCalendar(name: string, d: Partial<CalendarDefinition> | undefined): CalendarDefinition {
  const months = (Array.isArray(d?.months) ? d!.months : []).slice(0, 100).map((m) => ({
    name: text(m?.name, 100), days: Math.max(1, Math.round(num(m?.days, 30))), ...(m?.intercalary ? { intercalary: true } : {}),
  }));
  const out: CalendarDefinition = {
    name: text(d?.name || name, 200),
    epochYear: Math.round(num(d?.epochYear, 0)),
    ...(d?.yearSuffix ? { yearSuffix: text(d.yearSuffix, 40) } : {}),
    months: months.length ? months : [{ name: 'Month', days: 30 }],
    weekdays: (Array.isArray(d?.weekdays) ? d!.weekdays : []).slice(0, 60).map((w) => text(w, 60)).filter(Boolean),
  };
  if (!out.weekdays.length) out.weekdays = ['Day'];
  const moons = (Array.isArray(d?.moons) ? d!.moons : []).slice(0, 20).filter((m) => m?.name).map((m) => ({ name: text(m.name, 100), cycleDays: num(m.cycleDays, 28), offsetDays: num(m.offsetDays, 0) }));
  if (moons.length) out.moons = moons;
  const seasons = (Array.isArray(d?.seasons) ? d!.seasons : []).slice(0, 20).filter((s) => s?.name).map((s) => ({ name: text(s.name, 100), month: Math.max(1, Math.round(num(s.month, 1))), day: Math.max(1, Math.round(num(s.day, 1))) }));
  if (seasons.length) out.seasons = seasons;
  return out;
}

const cleanGroups = (groups: TimelineGroup[] | undefined): TimelineGroup[] => (Array.isArray(groups) ? groups : []).slice(0, 200).map((g) => ({
  name: text(g?.name, 200),
  ...(g?.abbreviation ? { abbreviation: text(g.abbreviation, 40) } : {}),
  ...(Array.isArray(g?.description) ? { description: g.description } : {}),
  events: (Array.isArray(g?.events) ? g.events : []).slice(0, 5000).filter((e) => e && e.id != null).map((e) => ({
    id: text(e.id, 200), name: text(e.name, 300), ...(e.date ? { date: text(e.date, 200) } : {}),
    ...(Array.isArray(e.description) ? { description: e.description } : {}), ...(e.color ? { color: text(e.color, 40) } : {}), ...(e.ref ? { ref: text(e.ref, 200) } : {}),
    visibility: vis(e.visibility),
  })),
}));

/**
 * Replace a source's records with the ones from a complete sync. Records the
 * source no longer has are removed, except kinds it could not list (`incomplete`).
 * Returns counts per kind.
 */
export function saveRecords(db: DB, worldId: string, sourceId: string, records: SyncRecord[], incomplete: Set<SyncRecord['kind']> = new Set()) {
  if (!ready.has(db)) { db.exec(RECORDS_SCHEMA); ready.add(db); }
  const counts = { relations: 0, timelines: 0, calendars: 0, markers: 0 };
  const keep = { relation: new Set<string>(), timeline: new Set<string>(), calendar: new Set<string>(), mapMarker: new Set<string>() };
  tx(db, () => {
    for (const r of records) {
      if (!r?.externalId || typeof r.externalId !== 'string') continue;
      const ext = text(r.externalId, 300);
      if (keep[r.kind]?.has(ext)) continue;
      switch (r.kind) {
        case 'relation':
          if (!r.from || !r.to) continue;
          run(db, `INSERT INTO intake_relations (world_id, source_id, external_id, from_ref, to_ref, label, attitude, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (world_id, source_id, external_id) DO UPDATE SET from_ref = excluded.from_ref, to_ref = excluded.to_ref, label = excluded.label, attitude = excluded.attitude, visibility = excluded.visibility`,
            worldId, sourceId, ext, text(r.from, 300), text(r.to, 300), text(r.label, 255), r.attitude == null ? null : Math.max(-100, Math.min(100, Math.round(num(r.attitude)))), vis(r.visibility));
          counts.relations++;
          break;
        case 'timeline':
          run(db, `INSERT INTO intake_timelines (world_id, source_id, external_id, name, visibility, data) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (world_id, source_id, external_id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility, data = excluded.data`,
            worldId, sourceId, ext, text(r.name, 300), vis(r.visibility), JSON.stringify(cleanGroups(r.groups)));
          counts.timelines++;
          break;
        case 'calendar': {
          const def = normCalendar(r.name, r.definition);
          const cur = r.current && Number.isFinite(Number(r.current.year)) && Number.isFinite(Number(r.current.month)) && Number.isFinite(Number(r.current.day))
            ? JSON.stringify({ year: Math.round(Number(r.current.year)), month: Math.round(Number(r.current.month)), day: Math.round(Number(r.current.day)) }) : null;
          run(db, `INSERT INTO intake_calendars (world_id, source_id, external_id, name, definition, visibility, current) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (world_id, source_id, external_id) DO UPDATE SET name = excluded.name, definition = excluded.definition, visibility = excluded.visibility, current = excluded.current`,
            worldId, sourceId, ext, text(r.name || def.name, 300), JSON.stringify(def), vis(r.visibility), cur);
          counts.calendars++;
          break;
        }
        case 'mapMarker':
          if (!r.mapRef || !Number.isFinite(Number(r.latitude)) || !Number.isFinite(Number(r.longitude))) continue;
          run(db, `INSERT INTO intake_markers (world_id, source_id, external_id, map_ref, name, latitude, longitude, shape, color, ref, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (world_id, source_id, external_id) DO UPDATE SET map_ref = excluded.map_ref, name = excluded.name, latitude = excluded.latitude, longitude = excluded.longitude,
              shape = excluded.shape, color = excluded.color, ref = excluded.ref, visibility = excluded.visibility`,
            worldId, sourceId, ext, text(r.mapRef, 300), text(r.name, 300), Number(r.latitude), Number(r.longitude), r.shape ? text(r.shape, 40) : null, r.color ? text(r.color, 40) : null, r.ref ? text(r.ref, 300) : null, vis(r.visibility));
          counts.markers++;
          break;
        default:
          continue;
      }
      keep[r.kind].add(ext);
    }
    const prune = (table: string, kind: keyof typeof keep) => {
      if (incomplete.has(kind)) return;
      for (const row of all<{ external_id: string }>(db, `SELECT external_id FROM ${table} WHERE world_id = ? AND source_id = ?`, worldId, sourceId)) {
        if (!keep[kind].has(row.external_id)) run(db, `DELETE FROM ${table} WHERE world_id = ? AND source_id = ? AND external_id = ?`, worldId, sourceId, row.external_id);
      }
    };
    prune('intake_relations', 'relation');
    prune('intake_timelines', 'timeline');
    prune('intake_calendars', 'calendar');
    prune('intake_markers', 'mapMarker');
  });
  return counts;
}

// ---- reading, per viewer -------------------------------------------------------

const isDm = (v: RecordViewer) => v.role === 'dm';

interface PageRef { id: string; title: string; party: boolean; classified: boolean }
/** A model-facing read of the DM's records must not see a page that is classified, or its title. */
const modelBlind = (v: RecordViewer, p: PageRef | null | undefined) => v.role === 'dm' && v.audience !== undefined && !!p?.classified;
/** Looks up a source's page by its own id. A page not found counts as not shared. */
function pageLookup(db: DB, worldId: string) {
  const cache = new Map<string, PageRef | null>();
  return (sourceId: string, ext: string | null | undefined): PageRef | null => {
    if (!ext) return null;
    const k = `${sourceId}\u0000${ext}`;
    if (!cache.has(k)) {
      const p = one<any>(db, 'SELECT id, title, visibility, player_body FROM pages WHERE world_id = ? AND source_id = ? AND external_id = ?', worldId, sourceId, ext);
      cache.set(k, p ? { id: p.id, title: p.title, party: p.visibility === 'party' && p.player_body !== null, classified: p.visibility === 'classified' } : null);
    }
    return cache.get(k)!;
  };
}

/** Relations a source gave, with page titles. Players: shared, and both pages shared. */
export function importedRelations(db: DB, worldId: string, viewer: RecordViewer) {
  const find = pageLookup(db, worldId);
  const out: { id: string; from_title: string; to_title: string; kind: string; visibility: string; attitude: number | null; source_id: string }[] = [];
  for (const r of all<any>(db, 'SELECT * FROM intake_relations WHERE world_id = ? ORDER BY external_id', worldId)) {
    const a = find(r.source_id, r.from_ref);
    const b = find(r.source_id, r.to_ref);
    if (!a || !b || modelBlind(viewer, a) || modelBlind(viewer, b)) continue;
    const shared = r.visibility === 'party' && a.party && b.party;
    if (!isDm(viewer) && !shared) continue;
    out.push({ id: `${r.source_id}:${r.external_id}`, from_title: a.title, to_title: b.title, kind: r.label, visibility: shared ? 'party' : 'dm', attitude: r.attitude, source_id: r.source_id });
  }
  return out.sort((x, y) => x.from_title.localeCompare(y.from_title));
}

export function calendarsFor(db: DB, worldId: string, viewer: RecordViewer) {
  return all<any>(db, `SELECT c.* FROM intake_calendars c JOIN sources s ON s.id = c.source_id WHERE c.world_id = ? ${isDm(viewer) ? '' : "AND c.visibility = 'party'"} ORDER BY c.name`, worldId)
    .map((c) => ({ id: c.external_id, source_id: c.source_id, name: c.name, definition: JSON.parse(c.definition), visibility: c.visibility, current: c.current ? JSON.parse(c.current) : null }));
}

export function timelinesFor(db: DB, worldId: string, viewer: RecordViewer) {
  const find = pageLookup(db, worldId);
  const out: any[] = [];
  for (const t of all<any>(db, `SELECT t.* FROM intake_timelines t JOIN sources s ON s.id = t.source_id WHERE t.world_id = ? ${isDm(viewer) ? '' : "AND t.visibility = 'party'"} ORDER BY t.name`, worldId)) {
    const dm = isDm(viewer);
    const model = dm && viewer.audience !== undefined;
    const hidden = (m: Mention) => !m.ref || !find(t.source_id, m.ref)?.party;
    // Descriptions for the DM's models: no link to a classified page, and a link that resolves to nothing is hidden too.
    const blind = (m: Mention) => !m.ref || !find(t.source_id, m.ref) || find(t.source_id, m.ref)!.classified;
    const desc = (b: Block[]): Block[] => (!dm ? playerBlocks(b, hidden) : model ? blocksFor(b, 'ai', blind) : b);
    const groups = (JSON.parse(t.data || '[]') as TimelineGroup[]).map((g) => ({
      name: g.name, abbreviation: g.abbreviation ?? null,
      description: g.description ? desc(g.description) : [] as Block[],
      events: g.events.filter((e) => dm || e.visibility === 'party').map((e) => {
        const page = find(t.source_id, e.ref);
        return {
          id: e.id, name: e.name, date: e.date ?? null, color: e.color ?? null, visibility: e.visibility,
          description: e.description ? desc(e.description) : [] as Block[],
          page: page && (dm || page.party) && !modelBlind(viewer, page) ? { id: page.id, title: page.title } : null,
        };
      }),
    }));
    out.push({ id: `${t.source_id}:${t.external_id}`, source_id: t.source_id, name: t.name, visibility: t.visibility, groups });
  }
  return out;
}

/** Map pins. Players: a shared pin on a shared map, that points at a shared page or none. */
export function markersFor(db: DB, worldId: string, viewer: RecordViewer) {
  const find = pageLookup(db, worldId);
  const out: any[] = [];
  for (const m of all<any>(db, 'SELECT m.* FROM intake_markers m JOIN sources s ON s.id = m.source_id WHERE m.world_id = ? ORDER BY m.name', worldId)) {
    const map = find(m.source_id, m.map_ref);
    if (!map || modelBlind(viewer, map)) continue;
    const page = find(m.source_id, m.ref);
    if (modelBlind(viewer, page)) continue;
    const shared = m.visibility === 'party' && map.party && (!m.ref || !!page?.party);
    if (!isDm(viewer) && !shared) continue;
    out.push({
      id: `${m.source_id}:${m.external_id}`, source_id: m.source_id, name: m.name, latitude: m.latitude, longitude: m.longitude, shape: m.shape, color: m.color,
      visibility: shared ? 'party' : 'dm', map: { id: map.id, title: map.title }, page: page && (isDm(viewer) || page.party) ? { id: page.id, title: page.title } : null,
    });
  }
  return out;
}
