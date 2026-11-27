// Starter templates: packages in the repo's top-level `templates/` folder (or ALX_TEMPLATES_DIR), 8 of each kind. The
// DM browses them on the Starters tab and adds one or all to the world, where they are ordinary templates to change.
// A broken file is skipped with a warning. See docs/TEMPLATES.md, "Starter templates".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TemplateInput } from './spec.ts';
import { readPackage } from './share.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = path.resolve(process.env.ALX_TEMPLATES_DIR || path.join(here, '../../../../templates'));

export interface StarterPack { id: string; name: string; templates: TemplateInput[] }

let cache: StarterPack[] | null = null;

export function starterPacks(dir = TEMPLATES_DIR): StarterPack[] {
  if (cache && dir === TEMPLATES_DIR) return cache;
  const out: StarterPack[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.alxtemplates.json')).sort(); } catch { /* no folder: no starters */ }
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ id: f.replace(/\.alxtemplates\.json$/, ''), name: String(raw?.name ?? f).slice(0, 80), templates: readPackage(raw) });
    } catch (e: any) { console.warn(`templates/${f} skipped: ${e?.message ?? e}`); }
  }
  if (dir === TEMPLATES_DIR) cache = out;
  return out;
}
