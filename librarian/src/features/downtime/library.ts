// The ready-made event library: data/events.json, keyed by activity id ("pre-cellar": [events]), with "_general"
// for activities that have none of their own (a player's new activity, the DM's one-off). It ships with DownTime
// rather than in the rule file, which has a size cap. A ready-made activity with no `events` of its own uses its
// library list; the DM's edit of the activity (Activities tab) makes its own copy. A bad entry is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEvents, type EventDef } from './catalog.ts';

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
