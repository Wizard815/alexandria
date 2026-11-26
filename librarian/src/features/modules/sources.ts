// Free, keyless content sources a DM can pull a module from in one step:
//   open5e    https://api.open5e.com (v2): pick books (Tome of Beasts, Deep
//             Magic, Vault of Magic, A5e, Black Flag, the SRDs ...)
//   dnd5eapi  the 5e SRD API's database (what https://www.dnd5eapi.co
//             serves), SRD 5.1 or SRD 5.2, fetched fresh
// Both return the raw module that readModule() then normalises. A preview
// and the save that follows it ask for the same thing, so the last few
// results are kept for a quarter of an hour instead of downloading twice.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deps } from '../../app.ts';
import { HttpError } from '../../core/util.ts';
import { KINDS, slug, type Kind, type Term } from './format.ts';
import { checkRemote } from './importers.ts';
import { OPEN5E_BASE, OPEN5E_CONVERT, OPEN5E_ENDPOINTS, open5eAttribution, open5eLicense } from './open5e.ts';
import { SRD_ATTRIBUTION, SRD_FILES_BY_KIND, buildSrd } from './srd5e.ts';

export const DND5EAPI_BASE = 'https://raw.githubusercontent.com/5e-bits/5e-srd-api/main/packages/5e-database/src';
const here = path.dirname(fileURLToPath(import.meta.url));
const LIMITS = { documents: 12, pages: 120, bytes: 80_000_000, pageSize: 500 };
const TTL = 15 * 60_000;

type Raw = { raw: any; warnings: string[] };
const cache = new Map<string, { at: number; value: Raw }>();
async function cached(key: string, make: () => Promise<Raw>): Promise<Raw> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await make();
  cache.set(key, { at: Date.now(), value });
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  return value;
}
/** Tests: forget what was fetched. */
export function clearSourceCache() { cache.clear(); }

function baseOf(b: any, def: string, d: Deps): string {
  const raw = typeof b?.base === 'string' && b.base.trim() ? b.base.trim().replace(/\/+$/, '') : def;
  checkRemote(raw, d.env.ALX_ALLOW_LOCAL_URLS === '1', ['https:', 'http:']);
  return raw;
}

function kindsOf(v: unknown): Set<Kind> | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, `kinds must be a list of: ${KINDS.join(', ')}`);
  const out = new Set<Kind>();
  for (const k of v) { if (!(KINDS as readonly string[]).includes(String(k))) throw new HttpError(400, `Unknown kind ${String(k).slice(0, 20)}`); out.add(k as Kind); }
  return out;
}

async function getJson(d: Deps, url: string, state: { bytes: number }, allowLocal: boolean): Promise<any> {
  checkRemote(url, allowLocal, ['https:', 'http:']);
  let r: Response;
  try { r = await d.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) }); }
  catch (e: any) { throw new HttpError(502, `${new URL(url).host} could not be reached (${String(e?.message ?? e).slice(0, 120)})`); }
  if (r.status === 404) return null;
  if (r.status === 429) throw new HttpError(429, `${new URL(url).host} asks us to slow down; try again in a minute`);
  if (!r.ok) throw new HttpError(502, `${new URL(url).host} answered ${r.status}`);
  const text = await r.text();
  state.bytes += text.length;
  if (state.bytes > LIMITS.bytes) throw new HttpError(413, 'The source sent too much data; pick fewer books or kinds');
  try { return JSON.parse(text); } catch { throw new HttpError(502, `${new URL(url).host} did not answer with JSON`); }
}

// ---- Open5e ----------------------------------------------------------------
export interface Open5eDoc { key: string; name: string; publisher: string; gamesystem: string; license: string; permalink: string; desc: string }

async function open5eDocsRaw(d: Deps, base: string): Promise<any[]> {
  const state = { bytes: 0 };
  const allowLocal = d.env.ALX_ALLOW_LOCAL_URLS === '1';
  const out: any[] = [];
  let next: string | null = `${base}/v2/documents/?limit=100&format=json`;
  for (let i = 0; next && i < 10; i++) {
    const j: any = await getJson(d, next, state, allowLocal);
    if (!j || !Array.isArray(j.results)) throw new HttpError(502, 'Open5e did not send a list of books');
    out.push(...j.results);
    next = j.next ? sameOrigin(String(j.next), base) : null;
  }
  return out;
}

const docCache = new Map<string, { at: number; docs: any[] }>();
async function open5eDocsCached(d: Deps, base: string) {
  const hit = docCache.get(base);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.docs;
  const docs = await open5eDocsRaw(d, base);
  docCache.set(base, { at: Date.now(), docs });
  return docs;
}

/** The books Open5e carries, for the import picker. */
export async function open5eDocuments(d: Deps, b: any = {}): Promise<{ base: string; documents: Open5eDoc[] }> {
  const base = baseOf(b, OPEN5E_BASE, d);
  const docs = await open5eDocsCached(d, base);
  return {
    base,
    documents: docs.filter((x) => x && typeof x.key === 'string').map((x) => ({
      key: x.key,
      name: String(x.display_name && x.display_name !== x.name && !/rules$/i.test(x.display_name) ? x.display_name : x.name ?? x.key),
      publisher: String(x.publisher?.name ?? ''),
      gamesystem: String(x.gamesystem?.name ?? ''),
      license: open5eLicense([x]),
      permalink: String(x.permalink ?? ''),
      desc: String(x.desc ?? '').replace(/[*_#>\r]/g, '').split(/\n\s*\n/).map((p) => p.trim()).find((p) => p.length > 30)?.slice(0, 240) ?? '',
    })),
  };
}

/** Open5e's "next" links name its own host; keep the paging on the base the DM chose. */
function sameOrigin(next: string, base: string): string {
  const n = new URL(next);
  const b = new URL(base);
  n.protocol = b.protocol; n.host = b.host;
  return n.toString();
}

const SRD_SPELL_SOURCE: Record<string, string> = { 'srd-2024': 'SRD 5.2.1' };

export async function readOpen5e(b: any, d: Deps): Promise<Raw> {
  const base = baseOf(b, OPEN5E_BASE, d);
  const keys: string[] = Array.isArray(b.documents) ? [...new Set(b.documents.map((k: unknown) => String(k).trim().toLowerCase()).filter(Boolean))] as string[] : [];
  if (!keys.length) throw new HttpError(400, 'Choose one or more Open5e books (documents)');
  if (keys.length > LIMITS.documents) throw new HttpError(400, `At most ${LIMITS.documents} books at a time`);
  if (keys.some((k) => !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(k))) throw new HttpError(400, 'A book key is not valid');
  const kinds = kindsOf(b.kinds);
  const endpoints = OPEN5E_ENDPOINTS.filter((e) => !kinds || kinds.has(e.kind));
  if (!endpoints.length) throw new HttpError(400, 'Open5e has nothing of those kinds');
  return cached(JSON.stringify(['open5e', base, [...keys].sort(), endpoints.map((e) => e.path)]), async () => {
    const all = await open5eDocsCached(d, base);
    const docs = keys.map((k) => all.find((x) => x?.key === k)).filter(Boolean);
    const warnings: string[] = keys.filter((k) => !all.some((x) => x?.key === k)).map((k) => `Open5e has no book "${k}"; skipped`);
    if (!docs.length) throw new HttpError(400, 'None of those books are on Open5e');
    const want = docs.map((x) => x.key).join(',');
    const docName = new Map<string, string>(docs.map((x) => [x.key, String(x.name)]));
    const state = { bytes: 0 };
    const allowLocal = d.env.ALX_ALLOW_LOCAL_URLS === '1';
    const terms: Term[] = [];
    const counts: Record<string, number> = {};
    let pages = 0;
    for (const ep of endpoints) {
      let next: string | null = `${base}/v2/${ep.path}/?document__key__in=${encodeURIComponent(want)}&limit=${LIMITS.pageSize}&format=json`;
      while (next) {
        if (++pages > LIMITS.pages) throw new HttpError(413, 'Open5e sent too many pages; pick fewer books');
        const j: any = await getJson(d, next, state, allowLocal);
        if (!j) break; // an older Open5e without this list
        if (!Array.isArray(j.results)) throw new HttpError(502, `Open5e's ${ep.path} answer has no results list`);
        for (const x of j.results) {
          // The filter is ours to trust: anything from another book is dropped.
          const key = String(x?.document?.key ?? '');
          if (!docName.has(key) || !x?.name) continue;
          try {
            const t = OPEN5E_CONVERT[ep.path](x);
            if (!t.text.trim()) continue;
            if (t.data && typeof t.data === 'object') (t.data as any).source = t.kind === 'spell' ? SRD_SPELL_SOURCE[key] ?? docName.get(key)! : docName.get(key)!;
            if (docs.length > 1) t.id = `${slug(key)}-${t.kind}-${slug(t.term)}`;
            terms.push(t);
            counts[ep.label] = (counts[ep.label] ?? 0) + 1;
          } catch (e: any) { if (warnings.length < 40) warnings.push(`${String(x.name).slice(0, 60)}: ${String(e?.message ?? e).slice(0, 120)}`); }
        }
        next = j.next ? sameOrigin(String(j.next), base) : null;
      }
    }
    if (!terms.length) throw new HttpError(400, `Open5e has no ${kinds ? [...kinds].join(', ') : ''} content in ${docs.map((x) => x.name).join(', ')}`.replace(/\s+/g, ' '));
    const names = docs.map((x) => String(x.name));
    return {
      raw: {
        id: `open5e-${docs.map((x) => slug(x.key)).join('-')}`.slice(0, 80),
        name: docs.length === 1 ? `${names[0]} (Open5e)` : `Open5e: ${names.join(' + ')}`.slice(0, 120),
        version: new Date().toISOString().slice(0, 10),
        license: open5eLicense(docs),
        attribution: open5eAttribution(docs),
        terms,
      },
      warnings: [`From Open5e: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`, ...warnings],
    };
  });
}

// ---- the 5e SRD API --------------------------------------------------------
export async function readDnd5eApi(b: any, d: Deps): Promise<Raw> {
  const base = baseOf(b, DND5EAPI_BASE, d);
  const year = String(b.edition ?? '2024');
  if (year !== '2014' && year !== '2024') throw new HttpError(400, 'edition must be 2014 (SRD 5.1) or 2024 (SRD 5.2)');
  const kinds = kindsOf(b.kinds);
  const files = new Set(Object.entries(SRD_FILES_BY_KIND).filter(([k]) => !kinds || kinds.has(k as Kind)).flatMap(([, f]) => f));
  return cached(JSON.stringify(['dnd5eapi', base, year, [...files].sort()]), async () => {
    const state = { bytes: 0 };
    const allowLocal = d.env.ALX_ALLOW_LOCAL_URLS === '1';
    let found = 0;
    const load = async (name: string) => {
      if (!files.has(name)) return [];
      const j = await getJson(d, `${base}/${year}/en/5e-SRD-${name}.json`, state, allowLocal);
      if (j === null) return [];
      if (!Array.isArray(j)) throw new HttpError(502, `5e-SRD-${name}.json is not a list`);
      found++;
      return j;
    };
    const hand = year === '2024' && files.has('Rules') ? JSON.parse(fs.readFileSync(path.join(here, 'data', 'rules-2024.handwritten.json'), 'utf8')) as Term[] : [];
    const terms = (await buildSrd(year as '2014' | '2024', load, hand)).filter((t) => !kinds || kinds.has(t.kind));
    if (!found) throw new HttpError(502, 'The 5e SRD API database had none of those files');
    const ed = year === '2014' ? 'SRD 5.1' : 'SRD 5.2';
    return {
      raw: {
        id: `dnd5eapi-${year}`,
        name: `5e SRD API (${ed})`,
        version: new Date().toISOString().slice(0, 10),
        license: 'CC-BY-4.0',
        attribution: `${SRD_ATTRIBUTION[year]} Data from the 5e SRD API (https://www.dnd5eapi.co, 5e-bits).`,
        terms,
      },
      warnings: [],
    };
  });
}
