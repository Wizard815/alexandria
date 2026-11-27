// Sharing templates between worlds and tables: a package file (.alxtemplates.json) holds one or more templates. Export
// leaves out what only means something in this world (example library pages); import takes a package or one bare
// template, checks every one before saving any, and updates a template of the same kind and name (a new version, the
// old one stays in its history) instead of making a copy. See docs/TEMPLATES.md, "Sharing templates".
import type { DB } from '../../core/db.ts';
import { tx } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { cleanTemplate, type GuideSpec, type TemplateInput } from './spec.ts';
import { createTemplate, listTemplates, MAX_TEMPLATES, updateTemplate, type Template } from './store.ts';

export const PACKAGE_TYPE = 'alexandria-templates';
export const MAX_IMPORT = 100;

export interface TemplatePackage { type: typeof PACKAGE_TYPE; version: 1; name: string; exported: string; alexandria: string; templates: TemplateInput[] }

/** A template as it travels: no ids, no world, no example pages (those are this world's library). */
export function portable(t: Template | TemplateInput): TemplateInput {
  const spec = t.kind === 'guide' ? { ...(t.spec as GuideSpec), exemplars: [] } : t.spec;
  return { kind: t.kind, name: t.name, description: t.description, triggers: t.triggers, enabled: t.enabled, spec };
}

export function makePackage(list: (Template | TemplateInput)[], o: { name?: string; alexandria: string }): TemplatePackage {
  return { type: PACKAGE_TYPE, version: 1, name: o.name || (list.length === 1 ? list[0].name : `${list.length} templates`), exported: now(), alexandria: o.alexandria, templates: list.map(portable) };
}

/** The templates in a file: a package, or one bare template. Each is checked; a bad one names its place. */
export function readPackage(raw: unknown): TemplateInput[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'That is not a templates file');
  const r = raw as any;
  const items: unknown[] = r.type === PACKAGE_TYPE ? (Array.isArray(r.templates) ? r.templates : []) : r.type === 'alexandria-house-rules' ? (() => { throw new HttpError(400, 'That is a house rules file: import it under House rules'); })() : [r];
  if (!items.length) throw new HttpError(400, 'The package holds no templates');
  if (items.length > MAX_IMPORT) throw new HttpError(400, `A package holds at most ${MAX_IMPORT} templates`);
  const out: TemplateInput[] = [];
  items.forEach((x, i) => {
    if (!x || typeof x !== 'object' || typeof (x as any).kind !== 'string') throw new HttpError(400, `Template ${i + 1}: it needs a kind (guide, generator, macro, assist, shop or library)`);
    try { out.push(portable(cleanTemplate(x))); } catch (e: any) { throw new HttpError(400, `Template ${i + 1}${(x as any).name ? ` (${String((x as any).name).slice(0, 60)})` : ''}: ${e?.message ?? e}`); }
  });
  const seen = new Set<string>();
  for (const t of out) { const k = `${t.kind}:${t.name.toLowerCase()}`; if (seen.has(k)) throw new HttpError(400, `The package has two ${t.kind} templates called "${t.name}"`); seen.add(k); }
  return out;
}

export interface ImportResult { created: string[]; updated: string[]; unchanged: string[] }

/** Save them all or none. `check` runs on each before anything is written (the classified-text check). */
export function importTemplates(db: DB, worldId: string, list: TemplateInput[], by: string | null, check: (t: TemplateInput) => void): ImportResult {
  for (const t of list) check(t);
  const have = listTemplates(db, worldId);
  const find = (t: TemplateInput) => have.find((h) => h.kind === t.kind && h.name.toLowerCase() === t.name.toLowerCase());
  const fresh = list.filter((t) => !find(t)).length;
  if (have.length + fresh > MAX_TEMPLATES) throw new HttpError(409, `That would make ${have.length + fresh} templates; a world keeps at most ${MAX_TEMPLATES}`);
  const out: ImportResult = { created: [], updated: [], unchanged: [] };
  tx(db, () => {
    for (const t of list) {
      const cur = find(t);
      if (!cur) { createTemplate(db, worldId, t, by); out.created.push(t.name); continue; }
      // Keep this world's example pages and on/off choice; take the rest from the file.
      const spec = t.kind === 'guide' ? { ...(t.spec as GuideSpec), exemplars: (cur.spec as GuideSpec).exemplars } : t.spec;
      const next = updateTemplate(db, worldId, cur.id, { ...t, enabled: cur.enabled, spec }, by);
      (next.version === cur.version ? out.unchanged : out.updated).push(t.name);
    }
  });
  return out;
}
