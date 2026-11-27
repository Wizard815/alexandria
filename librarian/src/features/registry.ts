// Finds every feature (src/features/<id>/index.ts, default export Feature)
// and wires it in. See types.ts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DB } from '../core/db.ts';
import { registerSettings } from '../core/policy.ts';
import type { Feature } from './types.ts';
import { addHouseRules, setFeatureIds } from './mods/catalog.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function load(): Promise<Feature[]> {
  const dirs = fs.readdirSync(here, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((n) => fs.existsSync(path.join(here, n, 'index.ts')))
    .sort();
  const out: Feature[] = [];
  for (const n of dirs) {
    const mod = await import(pathToFileURL(path.join(here, n, 'index.ts')).href);
    const f: Feature = mod.default;
    if (!f || typeof f !== 'object' || !f.id) throw new Error(`features/${n}/index.ts must default-export a Feature with an id`);
    out.push(f);
  }
  return out;
}

export const FEATURES: Feature[] = await load();

// Settings are registered once, at load, so DEFAULT_SETTINGS includes them everywhere.
for (const f of FEATURES) if (f.settings) registerSettings(f.id, f.settings);
// House rules the features ship (spell points, spell crafting, ...), checked once; a bad one stops the start like a bad feature.
for (const f of FEATURES) if (f.houseRules?.length) addHouseRules(f.id, f.houseRules);
// The parts of Alexandria a house rule can be built for (targets.builtFor).
setFeatureIds(FEATURES.map((f) => f.id));

/** Tables and columns for every feature. Called by createApp after openDb. */
export function applyFeatureSchemas(db: DB) {
  for (const f of FEATURES) {
    if (f.schema) db.exec(f.schema);
    f.migrate?.(db);
  }
}

export const featureMcpTools = () => FEATURES.flatMap((f) => f.mcpTools ?? []);
export const featureDataDirs = () => [...new Set(FEATURES.flatMap((f) => f.dataDirs ?? []))];
