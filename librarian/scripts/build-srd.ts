// Regenerates the bundled game modules under src/features/modules/data/.
//
//   node --experimental-strip-types librarian/scripts/build-srd.ts [--from <dir>] [--save-raw <dir>]
//
// The SRD 5.1 (2014) and SRD 5.2 (2024) data comes from the 5e SRD API's
// seed database (packages/5e-database of the 5e-bits/5e-srd-api repository,
// files src/{2014,2024}/en/5e-SRD-*.json). With --from <dir> it reads files
// named <year>-<Name>.json from a folder instead (for offline builds); with
// --save-raw <dir> it keeps the downloaded files there. Behind a proxy run it
// with NODE_USE_ENV_PROXY=1.
//
// The 2024 database has no "rules" file, so the core rules for SRD 5.2 come
// from data/rules-2024.handwritten.json (short paraphrases written for this
// app, same attribution). Edit that file, then run this script again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeModule, type Term } from '../src/features/modules/format.ts';
import { SRD_ATTRIBUTION, SRD_FILES, buildSrd } from '../src/features/modules/srd5e.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'src', 'features', 'modules', 'data');
const SOURCE = 'https://raw.githubusercontent.com/5e-bits/5e-srd-api/main/packages/5e-database/src';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fromDir = opt('--from');
const saveRaw = opt('--save-raw');

async function load(year: string, name: string): Promise<any[]> {
  const file = `${year}-${name}.json`;
  if (fromDir) {
    const p = path.join(fromDir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : [];
  }
  const r = await fetch(`${SOURCE}/${year}/en/5e-SRD-${name}.json`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  const t = await r.text();
  if (saveRaw) { fs.mkdirSync(saveRaw, { recursive: true }); fs.writeFileSync(path.join(saveRaw, file), t); }
  return JSON.parse(t);
}

const NAMES = SRD_FILES;

async function build(year: '2014' | '2024'): Promise<Term[]> {
  const hand = year === '2024' ? (JSON.parse(fs.readFileSync(path.join(dataDir, 'rules-2024.handwritten.json'), 'utf8')) as Term[]) : [];
  return buildSrd(year, (n) => load(year, n), hand);
}

const ATTRIBUTION = SRD_ATTRIBUTION;

const META = {
  '2024': { id: 'dnd-2024', name: 'D&D 2024 (SRD 5.2)', version: '5.2.1', file: 'srd-2024.json' },
  '2014': { id: 'dnd-2014', name: 'D&D 5e 2014 (SRD 5.1)', version: '5.1', file: 'srd-2014.json' },
} as const;

void NAMES;
fs.mkdirSync(dataDir, { recursive: true });
for (const year of ['2024', '2014'] as const) {
  const m = META[year];
  const terms = await build(year);
  const { module, warnings } = normalizeModule({ id: m.id, name: m.name, version: m.version, license: 'CC-BY-4.0', attribution: ATTRIBUTION[year], terms });
  for (const w of warnings) console.warn(`${year}: ${w}`);
  const out = path.join(dataDir, m.file);
  fs.writeFileSync(out, JSON.stringify(module));
  const kinds: Record<string, number> = {};
  for (const t of module.terms) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
  console.log(`${m.file}: ${module.terms.length} terms, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`, kinds);
}
