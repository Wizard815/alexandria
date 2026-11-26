// Server rules (scope "server"): mods that switch a whole feature on or off for the server, such as a content source
// or an admin page, rather than a table's rule. They come only from the mods/ folder (what the server admin
// installs), and the admin turns them on under Admin → Mods. A feature that is such a mod says so with
// `serverMod: '<rule id>'`: its API answers 404, its assistant tools are left out and its web pages hide while the
// rule is off. Other code asks serverModOn(db, id). See docs/MODS.md.
import { type DB, all, one, run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import type { RequestHandler } from 'express';
import { shippedMod, shippedMods } from './catalog.ts';
import type { ModFile } from './format.ts';

export const SERVER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS server_mods (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
`;

export interface ServerMod { mod: ModFile; feature: string; enabled: boolean; updatedAt: string | null }

const rules = (): { mod: ModFile; feature: string }[] => shippedMods().filter((s) => s.mod.scope === 'server');

export function listServerMods(db: DB): ServerMod[] {
  const rows = new Map(all<any>(db, 'SELECT * FROM server_mods').map((r) => [r.id, r]));
  return rules().map((s) => {
    const r = rows.get(s.mod.id);
    return { mod: s.mod, feature: s.feature, enabled: r ? r.enabled === 1 : s.mod.onByDefault, updatedAt: r?.updated_at ?? null };
  });
}

/** Is this server rule on? A rule this server does not have is off. */
export function serverModOn(db: DB, id: string): boolean {
  const s = rules().find((x) => x.mod.id === id);
  if (!s) return false;
  const r = one<any>(db, 'SELECT enabled FROM server_mods WHERE id = ?', id);
  return r ? r.enabled === 1 : s.mod.onByDefault;
}

/** Every server rule that is on (the web hides the pages of the rest). */
export const serverModsOn = (db: DB): string[] => listServerMods(db).filter((m) => m.enabled).map((m) => m.mod.id);

/**
 * Turn a server rule on or off. On turns on the server rules it needs and turns off the ones it conflicts with (or
 * shares a group with); off turns off the server rules that need it. Returns what else changed.
 */
export function setServerMod(db: DB, id: string, on: boolean, by: string | null, chain = new Set<string>()): { turnedOn: string[]; turnedOff: string[] } {
  const all_ = listServerMods(db);
  const m = all_.find((x) => x.mod.id === id);
  if (!m) throw new HttpError(404, `No server rule ${id.slice(0, 40)}`);
  const out = { turnedOn: [] as string[], turnedOff: [] as string[] };
  chain.add(id);
  const write = (rid: string, v: boolean) => run(db, 'INSERT INTO server_mods (id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by', rid, v ? 1 : 0, now(), by);
  if (on) {
    for (const rid of Object.keys(m.mod.requires.mods)) {
      if (chain.has(rid)) continue;
      const r = all_.find((x) => x.mod.id === rid);
      if (!r) throw new HttpError(409, `${m.mod.name} needs the server rule ${rid}, which this server does not have`);
      if (!r.enabled) { const o = setServerMod(db, rid, true, by, chain); out.turnedOn.push(rid, ...o.turnedOn); out.turnedOff.push(...o.turnedOff); }
    }
    for (const o of all_) {
      if (o.mod.id === id || !o.enabled || chain.has(o.mod.id)) continue;
      if ((m.mod.group && o.mod.group === m.mod.group) || m.mod.conflicts.includes(o.mod.id) || o.mod.conflicts.includes(id)) {
        const r = setServerMod(db, o.mod.id, false, by, chain);
        out.turnedOff.push(o.mod.id, ...r.turnedOff);
      }
    }
  } else {
    for (const d of all_.filter((x) => x.enabled && x.mod.requires.mods[id] && !chain.has(x.mod.id))) {
      const r = setServerMod(db, d.mod.id, false, by, chain);
      out.turnedOff.push(d.mod.id, ...r.turnedOff);
    }
  }
  write(id, on);
  return { turnedOn: [...new Set(out.turnedOn)], turnedOff: [...new Set(out.turnedOff)] };
}

/** Express middleware for a feature that is a server mod: 404 with a plain reason while the rule is off. No id: always on. */
export function serverModGate(db: DB, id: string | undefined): RequestHandler {
  return (_req, res, next) => {
    if (id && !serverModOn(db, id)) { res.status(404).json({ error: `${shippedMod(id)?.mod.name ?? id} is turned off on this server (Admin → Mods)` }); return; }
    next();
  };
}
