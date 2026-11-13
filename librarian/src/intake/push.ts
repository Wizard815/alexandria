// Checks an entry a tool pushed. It is untrusted input: only known fields are
// kept, shapes are checked so the leak guard can't be crashed or confused, and
// visibility fails closed (shared only when the entry says "party" exactly and
// the source is set to share).
import { HttpError } from '../core/util.ts';
import type { Block, Entry, Inline, PropertyGroup } from './model.ts';

const MAX_ENTRY_BYTES = 400_000;
const MAX_DEPTH = 24;

const bad = (msg: string): never => { throw new HttpError(400, msg); };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strOf = (v: unknown, field: string, max: number, required = false): string | undefined => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${field} is required`); return undefined; }
  if (typeof v !== 'string') bad(`${field} must be text`);
  if ((v as string).length > max) bad(`${field} is too long`);
  return v as string;
};
const strList = (v: unknown, field: string, maxItems: number, maxLen: number): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== 'string' || x.length > maxLen)) bad(`${field} must be a list of short text`);
  return v as string[];
};

function checkInlines(c: unknown, where: string) {
  if (c === undefined) return;
  if (!Array.isArray(c)) bad(`${where} must be a list`);
  for (const x of c as unknown[]) {
    if (!isObj(x)) bad(`${where} must hold objects`);
    const o = x as Record<string, any>;
    if (o.text !== undefined && typeof o.text !== 'string') bad(`${where}: text must be text`);
    if (o.link !== undefined && typeof o.link !== 'string') bad(`${where}: link must be text`);
    if (o.mention !== undefined && !isObj(o.mention)) bad(`${where}: mention must be an object`);
  }
}

function checkGroups(g: unknown, where: string): PropertyGroup[] {
  if (!Array.isArray(g)) return bad(`${where} must be a list`);
  return (g as unknown[]).map((x) => {
    if (!isObj(x) || typeof x.title !== 'string' || !Array.isArray(x.rows)) return bad(`${where}: each group needs a title and rows`);
    const rows = (x.rows as unknown[]).map((r) => {
      if (!isObj(r) || typeof r.key !== 'string') return bad(`${where}: each row needs a key`);
      checkInlines(r.value ?? [], `${where} value`);
      return { key: r.key, value: (r.value ?? []) as Inline[] };
    });
    return { title: x.title, rows, ...(x.dm === true ? { dm: true } : {}) };
  });
}

function checkBlocks(bs: unknown, depth: number): Block[] {
  if (!Array.isArray(bs)) return bad('blocks must be a list');
  if (depth > MAX_DEPTH) return bad('blocks are nested too deeply');
  for (const b of bs as unknown[]) {
    if (!isObj(b) || typeof b.kind !== 'string') bad('every block needs a kind');
    const o = b as Record<string, any>;
    for (const f of ['content', 'title', 'caption']) if (Array.isArray(o[f])) checkInlines(o[f], `${o.kind}.${f}`);
    if (o.children !== undefined) checkBlocks(o.children, depth + 1);
    if (o.kind === 'infobox') o.groups = checkGroups(o.groups ?? [], 'infobox groups');
    if (o.kind === 'map' && !Array.isArray(o.pins)) o.pins = [];
  }
  return bs as Block[];
}

/** A clean Entry from pushed JSON, or an HttpError(400) saying what is wrong. */
export function cleanEntry(raw: unknown, sourceShares: boolean): Entry {
  if (!isObj(raw)) return bad('An entry must be an object');
  if (JSON.stringify(raw).length > MAX_ENTRY_BYTES) throw new HttpError(413, 'Entry is too large');
  const externalId = strOf(raw.externalId, 'externalId', 200, true)!;
  const title = strOf(raw.title, 'title', 200, true)!;
  const isMd = typeof raw.markdown === 'string';
  if (!isMd && raw.blocks !== undefined && !Array.isArray(raw.blocks)) bad('blocks must be a list');
  if (isMd && (raw.markdown as string).length > 300_000) throw new HttpError(413, 'markdown is too large');
  const blocks = isMd ? [] : checkBlocks(raw.blocks ?? [], 0);
  if (raw.frontmatter !== undefined && !isObj(raw.frontmatter)) bad('frontmatter must be an object');
  const icon = isObj(raw.icon) ? { ...(typeof raw.icon.glyph === 'string' ? { glyph: raw.icon.glyph.slice(0, 60) } : {}), ...(typeof raw.icon.color === 'string' ? { color: raw.icon.color.slice(0, 20) } : {}) } : null;
  const url = (v: unknown, f: string) => { const s = strOf(v, f, 2000); return s && /^https?:\/\//i.test(s) ? s : null; };
  const knowledge = raw.knowledge === 'common' || raw.knowledge === 'local' || raw.knowledge === 'deep' ? raw.knowledge : null;
  return {
    externalId,
    parentExternalId: strOf(raw.parentExternalId, 'parentExternalId', 200) ?? null,
    folder: strList(raw.folder, 'folder', 12, 120) ?? [],
    title,
    aliases: strList(raw.aliases, 'aliases', 50, 200) ?? [],
    tags: strList(raw.tags, 'tags', 60, 100) ?? [],
    type: strOf(raw.type, 'type', 60) ?? 'page',
    icon,
    banner: url(raw.banner, 'banner'),
    properties: raw.properties === undefined ? [] : checkGroups(raw.properties, 'properties'),
    blocks,
    // Fail closed: shared only on an exact "party" and a source that shares.
    visibility: raw.visibility === 'party' && sourceShares ? 'party' : 'dm',
    knowledge,
    url: url(raw.url, 'url'),
    updatedAt: strOf(raw.updatedAt, 'updatedAt', 40) ?? null,
    ...(isMd ? { markdown: raw.markdown as string } : {}),
    ...(isMd && isObj(raw.frontmatter) ? { frontmatter: raw.frontmatter } : {}),
  };
}
