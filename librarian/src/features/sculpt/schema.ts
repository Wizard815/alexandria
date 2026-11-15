// Validating a template, and the export/import envelope.
import { HttpError } from '../../core/util.ts';
import { gensKnown } from './gens.ts';
import { parseCall } from './lang.ts';
import { CATEGORIES, FIELD_TYPES, type Category, type Field, type Outputs, type Target } from './templates.ts';

const bad = (m: string) => new HttpError(422, m);
export const text = (v: unknown, field: string, max: number, required = false): string => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${field} is required`); return ''; }
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  if (v.length > max) throw bad(`${field} is too long`);
  return v.trim();
};

export const EXPORT_FORMAT = 'alexandria-sculpt-template';
export const CTX_VARS = ['world.date', 'world.time', 'world.season', 'world.weekday', 'world.year', 'world.name', 'party.level', 'party.names', 'party.size', 'location'];
const CTX = new Set(CTX_VARS);

export interface TemplateIn {
  name: string; description: string; perspective: 'dm' | 'player'; category: Category;
  fields: Field[]; body: string; target: Target; outputs: Outputs;
}

function checkExpr(label: string, expr: string, field = false) {
  const call = parseCall(expr);
  if (!call) throw bad(`${label}: "${expr.slice(0, 40)}" is not gen:, dice: or pick:`);
  if (call.kind === 'gen' && !gensKnown(call.name)) throw bad(`${label}: there is no generator "${call.name}"`);
  if (call.kind === 'pick' && !call.name.includes('|') && !field) throw bad(`${label}: pick needs options separated by |`);
}

export function readTemplate(b: any): TemplateIn {
  if (!b || typeof b !== 'object') throw bad('A template is needed');
  const name = text(b.name, 'name', 80, true);
  const perspective = b.perspective === 'player' ? 'player' : 'dm';
  const category: Category = (CATEGORIES as readonly string[]).includes(b.category) ? b.category : 'Story';
  if (!Array.isArray(b.fields) || !b.fields.length || b.fields.length > 40) throw bad('A template needs 1 to 40 fields');
  const seen = new Set<string>();
  const fields: Field[] = b.fields.map((f: any, i: number) => {
    const key = text(f?.key, `fields[${i}].key`, 32, true);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw bad(`Field key "${key}" must be lowercase letters, digits and underscores`);
    if (seen.has(key)) throw bad(`Field key "${key}" is used twice`);
    seen.add(key);
    if (!FIELD_TYPES.includes(f.type)) throw bad(`Field "${key}" has an unknown type`);
    const out: Field = { key, label: text(f.label, `fields[${i}].label`, 80) || key, type: f.type };
    if (f.type === 'select') {
      const o = Array.isArray(f.options) ? f.options.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 40) : [];
      if (!o.length) throw bad(`Field "${key}" needs options`);
      out.options = o;
    }
    const hint = text(f.hint, `fields[${i}].hint`, 300);
    if (hint) out.hint = hint;
    if (f.required) out.required = true;
    if (f.dmOnly) out.dmOnly = true;
    if (f.optional) out.optional = true;
    if (f.gen === 'clock' || f.gen === 'stock') out.gen = f.gen;
    else if (f.gen) { const g = text(f.gen, `fields[${i}].gen`, 300); checkExpr(`Field "${key}" gen`, g, true); out.gen = g; }
    if (f.fallback) { const g = text(f.fallback, `fields[${i}].fallback`, 300); checkExpr(`Field "${key}" fallback`, g, true); out.fallback = g; }
    if (f.default) out.default = text(f.default, `fields[${i}].default`, 2000);
    if (f.type === 'table' && Array.isArray(f.columns)) out.columns = f.columns.map((c: unknown) => String(c).trim().slice(0, 40)).filter(Boolean).slice(0, 8);
    if (f.type === 'rollTable') {
      if (f.dieField) out.dieField = text(f.dieField, `fields[${i}].dieField`, 32);
      if (f.die !== undefined) { const n = Math.floor(Number(f.die)); if (!(n >= 2 && n <= 30)) throw bad(`Field "${key}": die must be 2 to 30`); out.die = n; }
    }
    return out;
  });
  if (fields.some((f) => f.dieField && !seen.has(f.dieField))) throw bad('A roll table names a die field that does not exist');
  const body = text(b.body, 'body', 20000, true);

  // Every {{...}} must be something the language knows, and blocks must balance.
  let ifs = 0; let eachs = 0;
  for (const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const t = m[1].trim();
    if (t === '#dm' || t === '/dm' || t === 'else' || t === 'this' || /^this\.\d+$/.test(t) || t === '@index' || t === '@n') continue;
    if (/^[a-z][a-z0-9_]*$/.test(t)) { if (!seen.has(t) && !CTX.has(t)) throw bad(`The body uses {{${t}}}, which is not a field`); continue; }
    if (CTX.has(t)) continue;
    if (/^page:\s*\S/.test(t)) continue;
    if (/^(gen|dice|pick):/.test(t)) { checkExpr('The body', t); continue; }
    const blk = /^#(if|each)\s+!?\s*([a-z][a-z0-9_.]*)$/.exec(t);
    if (blk) {
      if (!seen.has(blk[2]) && !CTX.has(blk[2])) throw bad(`The body uses {{${t}}}, which is not a field`);
      if (blk[1] === 'if') ifs++; else eachs++;
      continue;
    }
    if (t === '/if') { ifs--; continue; }
    if (t === '/each') { eachs--; continue; }
    throw bad(`The body uses {{${t.slice(0, 40)}}}, which this language does not know`);
  }
  if (ifs !== 0 || eachs !== 0) throw bad('Every {{#if}} and {{#each}} needs its {{/if}} or {{/each}}');
  for (const m of body.matchAll(/\{\{\s*(?:gen|dice|pick):[^{}]*\$([a-z_][a-z0-9_.]*)/gi)) if (!seen.has(m[1]) && !CTX.has(m[1])) throw bad(`The body refers to $${m[1]}, which is not a field`);
  for (const f of fields) for (const e of [f.gen, f.fallback]) for (const m of (e ?? '').matchAll(/\$([a-z_][a-z0-9_.]*)/gi)) if (!seen.has(m[1]) && !CTX.has(m[1].replace(/\.$/, ''))) throw bad(`Field "${f.key}" refers to $${m[1]}, which is not a field`);
  if (perspective === 'player' && (fields.some((f) => f.dmOnly) || /\{\{#dm\}\}/.test(body))) throw bad('A player-perspective template cannot have DM-only fields or {{#dm}} sections');

  const t = b.target && typeof b.target === 'object' ? b.target : { kind: 'none' };
  const vis = t.visibility === 'party' ? 'party' : 'dm';
  const path = text(t.path, 'target.path', 200);
  let target: Target;
  switch (t.kind) {
    case 'page': target = { kind: 'page', path: path || 'Sculpted/{{' + fields[0].key + '}}', visibility: vis }; break;
    case 'person': target = { kind: 'person', path: path || 'People/{{' + fields[0].key + '}}', visibility: vis, alsoPage: t.alsoPage !== false }; break;
    case 'shop': target = { kind: 'shop', path: path || 'Shops/{{' + fields[0].key + '}}', visibility: vis, listField: typeof t.listField === 'string' && seen.has(t.listField) ? t.listField : undefined }; break;
    case 'combat':
      if (!fields.some((f) => f.type === 'statblock')) throw bad('A combat target needs a statblock field');
      target = { kind: 'combat' }; break;
    case 'none': target = { kind: 'none' }; break;
    default: throw bad('The save target must be page, person, combat, shop or none');
  }

  const o = b.outputs && typeof b.outputs === 'object' ? b.outputs : {};
  const outputs: Outputs = {};
  for (const k of ['page', 'stage', 'combat', 'send', 'broker'] as const) if (o[k] !== undefined) outputs[k] = !!o[k];
  if (o.stageKind === 'event' || o.stageKind === 'text') outputs.stageKind = o.stageKind;
  if (o.stageShow !== undefined) outputs.stageShow = !!o.stageShow;
  if (o.combatField) {
    const cf = fields.find((f) => f.key === o.combatField);
    if (!cf || (cf.type !== 'statblock' && cf.type !== 'list')) throw bad('The combat field must be a statblock or list field');
    outputs.combatField = cf.key;
  }
  if (outputs.combat && !outputs.combatField) { const sb = fields.find((f) => f.type === 'statblock'); if (sb) outputs.combatField = sb.key; else throw bad('Adding to combat needs a combat field'); }
  if (outputs.send && perspective !== 'player') throw bad('Only a player-perspective template can be sent to players');
  if (outputs.page && target.kind === 'none') throw bad('Saving a page needs a save target');
  return { name, description: text(b.description, 'description', 400), perspective, category, fields, body, target, outputs };
}

/** The shareable form of a template. */
export function exportTemplate(t: { name: string; description: string; perspective: string; category: string; fields: Field[]; body: string; target: Target; outputs: Outputs }) {
  return {
    format: EXPORT_FORMAT, version: 1,
    template: { name: t.name, description: t.description, perspective: t.perspective, category: t.category, fields: t.fields, body: t.body, target: t.target, outputs: t.outputs },
  };
}

/** Parse and validate an import. Throws 422 with a plain reason. */
export function readImport(raw: unknown): { template: TemplateIn; summary: { name: string; category: string; perspective: string; fields: { key: string; label: string; type: string }[]; generators: string[]; outputs: string[]; bodyPreview: string } } {
  let data: any = raw;
  if (typeof raw === 'string') { try { data = JSON.parse(raw); } catch { throw bad('That is not valid JSON'); } }
  if (!data || typeof data !== 'object') throw bad('A template export is needed');
  if (data.format !== EXPORT_FORMAT) throw bad(`This is not a Sculpting template export (format should be "${EXPORT_FORMAT}")`);
  if (data.version !== 1) throw bad('This template export has a version this Alexandria does not know');
  const template = readTemplate(data.template);
  const generators = [...new Set([...template.body.matchAll(/\{\{\s*((?:gen|dice|pick):[a-z0-9_]*)/gi)].map((m) => m[1]).concat(template.fields.flatMap((f) => [f.gen, f.fallback]).filter((x): x is string => !!x && /^(gen|dice|pick):/.test(x)).map((x) => x.split(/[\s]/)[0])))];
  return {
    template,
    summary: {
      name: template.name, category: template.category, perspective: template.perspective,
      fields: template.fields.map((f) => ({ key: f.key, label: f.label, type: f.type })), generators,
      outputs: Object.entries(template.outputs).filter(([, v]) => v === true).map(([k]) => k), bodyPreview: template.body.slice(0, 400),
    },
  };
}
