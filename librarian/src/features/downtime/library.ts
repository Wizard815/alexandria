// The ready-made event library: data/events.json, keyed by activity id ("pre-cellar": [events]), with "_general"
// for activities that have none of their own (a player's new activity, the DM's one-off). It ships with DownTime
// rather than in the rule file, which has a size cap. A ready-made activity with no `events` of its own uses its
// library list; the DM's edit of the activity (Activities tab) makes its own copy. A bad entry is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from '../../core/db.ts';
import { checkEvents, MAX_EVENTS, type EventDef } from './catalog.ts';
import { enabledMods } from '../mods/store.ts';
import { registerModContent } from '../mods/format.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
let lib: Map<string, EventDef[]> | null = null;

export function eventLibrary(): Map<string, EventDef[]> {
  if (lib) return lib;
  lib = new Map();
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(here, 'data', 'events.json'), 'utf8')); } catch { /* no library */ }
  for (const [k, list] of Object.entries(raw)) {
    const ok: EventDef[] = [];
    for (const e of Array.isArray(list) ? list : []) { try { ok.push(...checkEvents([e])); } catch { /* skipped */ } }
    // Ids stay unique within a list.
    const seen = new Set<string>();
    lib.set(k, ok.map((e, i) => { let id = e.id; while (seen.has(id)) id = `${e.id.slice(0, 34)}-${i}`; seen.add(id); return { ...e, id }; }));
  }
  return lib;
}
export const libraryEvents = (activityId: string): EventDef[] => eventLibrary().get(activityId) ?? [];
export const generalEvents = (): EventDef[] => eventLibrary().get('_general') ?? [];
/** For tests: read the file again. */
export const reloadLibrary = () => { lib = null; };

// ---- event packs: a house rule (mod) with content.downtimeEvents, { "pre-cellar": [events], "_general": [...] }.
// While the pack is on, its events join the ready-made activity's list (and the general one); turned off, they go.
// A DM's edited copy of an activity keeps its own list, and the pack's events still join it. Each one carries
// `pack` (the rule's id) so the editor shows where it came from and does not save it into the copy.

export const PACK_KEY = 'downtimeEvents';
const KEY = /^(_general|pre-[a-z0-9-]{1,40})$/;

/** The problems with a pack's content, as sentences (empty: it's good). */
export function checkPack(v: unknown): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['must be an object of activity id: [events], like { "pre-cellar": [ ... ], "_general": [ ... ] }'];
  const out: string[] = [];
  const ent = Object.entries(v as Record<string, unknown>);
  if (ent.length > 40) out.push('holds at most 40 activities');
  for (const [k, list] of ent.slice(0, 40)) {
    if (!KEY.test(k)) { out.push(`"${k}" is not a ready-made activity id (pre-...) or _general`); continue; }
    if (!Array.isArray(list)) { out.push(`${k} must be a list of events`); continue; }
    if (list.length > MAX_EVENTS) { out.push(`${k} has more than ${MAX_EVENTS} events`); continue; }
    try { checkEvents(list); } catch (e: any) { out.push(`${k}: ${e.message}`); }
  }
  return out;
}
registerModContent(PACK_KEY, checkPack);

/** The world's turned-on packs' events, by activity id. */
export function packEvents(db: DB, worldId: string): Map<string, EventDef[]> {
  const out = new Map<string, EventDef[]>();
  let mods: ReturnType<typeof enabledMods> = [];
  try { mods = enabledMods(db, worldId); } catch { return out; }
  for (const m of mods) {
    const c = m.mod.content?.[PACK_KEY];
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    for (const [k, list] of Object.entries(c as Record<string, unknown>)) {
      if (!KEY.test(k) || !Array.isArray(list)) continue;
      let evs: EventDef[] = [];
      try { evs = checkEvents(list.slice(0, MAX_EVENTS)); } catch { continue; }
      out.set(k, [...(out.get(k) ?? []), ...evs.map((e) => ({ ...e, pack: m.mod.id }))]);
    }
  }
  return out;
}

/** A list with a pack's events added; ids stay unique. */
export function withPack(base: EventDef[], extra: EventDef[] | undefined): EventDef[] {
  if (!extra?.length) return base;
  const seen = new Set(base.map((e) => e.id));
  return [...base, ...extra.map((e) => { let id = e.id; if (seen.has(id)) id = `${e.id.slice(0, 30)}-${e.pack}`.slice(0, 60); seen.add(id); return { ...e, id }; })];
}
