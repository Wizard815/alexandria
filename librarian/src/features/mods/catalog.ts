// Every house rule that ships with Alexandria. They live as rule files in the
// repo's `mods/` folder (or ALX_MODS_DIR): each `*.alxmod.json` there, a rule
// or a package of rules, is a built-in rule. A feature claims the ones that
// switch it on by id in its `houseRules` (the spells feature: spell points,
// the simple mana pool and spell crafting) and may also declare a rule inline.
// Kept apart from index.ts so the feature registry can fill it while it loads
// without an import cycle.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMod, unpack, type ModFile } from './format.ts';

export interface Shipped { mod: ModFile; feature: string; file?: string }

const here = path.dirname(fileURLToPath(import.meta.url));
/** The folder of built-in rule files: the repo's mods/ (in the Docker image /app/mods). */
export const MODS_DIR = path.resolve(process.env.ALX_MODS_DIR || path.join(here, '../../../../mods'));

const shipped = new Map<string, Shipped>();
const files = new Map<string, { mod: ModFile; file: string }>();

/** Read every rule file in the folder. A broken file is skipped with a warning so one bad drop-in never stops the server. */
export function loadModsDir(dir = MODS_DIR): { loaded: string[]; problems: string[] } {
  const loaded: string[] = [];
  const problems: string[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.alxmod.json')).sort(); } catch { return { loaded, problems }; }
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e: any) { problems.push(`${name}: ${e.message}`); continue; }
    const { mods, errors } = unpack(text);
    if (!mods.length) { problems.push(`${name}: ${errors.join('; ')}`); continue; }
    for (const mod of mods) {
      if (files.has(mod.id) || shipped.has(mod.id)) { problems.push(`${name}: house rule ${mod.id} already exists`); continue; }
      files.set(mod.id, { mod, file: name });
      loaded.push(mod.id);
    }
  }
  for (const p of problems) console.warn(`[house rules] ${p}`);
  return { loaded, problems };
}

/** Register a feature's house rules: an id names a file in mods/, an object is a rule declared in code. */
export function addHouseRules(feature: string, raws: unknown[]) {
  for (const raw of raws) {
    if (typeof raw === 'string') {
      const f = files.get(raw);
      if (!f) throw new Error(`features/${feature}: house rule ${raw} is not in ${MODS_DIR}`);
      files.delete(raw);
      shipped.set(raw, { mod: f.mod, feature, file: f.file });
      continue;
    }
    const { mod, errors } = checkMod(raw);
    if (!mod) throw new Error(`features/${feature}: a house rule is not a valid mod: ${errors.join('; ')}`);
    if (shipped.has(mod.id) || files.has(mod.id)) throw new Error(`features/${feature}: house rule ${mod.id} already exists`);
    shipped.set(mod.id, { mod, feature });
  }
}

/** Claimed rules first, then the folder's other rules (the mod kit's own and any drop-in). */
export const shippedMods = (): Shipped[] => [...shipped.values(), ...[...files.values()].map((f) => ({ mod: f.mod, feature: 'mods', file: f.file }))];
export const shippedMod = (id: string): Shipped | undefined => shipped.get(id) ?? (files.has(id) ? { mod: files.get(id)!.mod, feature: 'mods', file: files.get(id)!.file } : undefined);

loadModsDir();
