// What a DM template is: its kind, the shape of each kind's spec, and how a spec is cleaned (every write goes through
// cleanTemplate, so the store only ever holds a valid template). Pure: no database, no model.
import { HttpError } from '../../core/util.ts';

export const KINDS = ['guide', 'generator', 'macro', 'assist', 'shop', 'library'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  guide: 'Agent guide',
  generator: 'Generator template',
  macro: 'Macro template',
  assist: 'Assist panel template',
  shop: 'Shop generation template',
  library: 'Library template',
};

/** Kinds the assistant reads when a request matches their triggers. */
export const GUIDE_KINDS: readonly Kind[] = ['guide', 'generator', 'library', 'shop'];

export const STEP_KINDS = ['library', 'neighbours', 'exemplars', 'web', 'instruction'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export interface Step { kind: StepKind; text: string; query?: string }

export interface GuideSpec {
  /** The task this is for, in a few words ("Make a town"). */
  task: string;
  /** Free instructions the assistant follows. */
  instructions: string;
  steps: Step[];
  /** Headings every result should have, in order. */
  sections: string[];
  tone: string;
  /** Library folder new pages go in. */
  folder: string;
  /** Library page ids of good examples. */
  exemplars: string[];
  /** Match on a trigger word alone, without a "make / create / write ..." verb. */
  always: boolean;
}
export interface GeneratorSpec { generator: string; fields: { name: string; hint: string }[]; sections: string[]; instructions: string; folder: string }
export interface MacroSpec { prompt: string; params: { name: string; label: string; default: string }[]; mode: 'do' | 'propose'; tools: string }
export interface AssistSpec { layout: 'one' | 'cols' | 'rows' | 'grid' | 'side'; panes: string[]; prompt: string }
export interface ShopSpec { guide: string; stock: string[]; priceNotes: string; shopType: string }
export interface LibrarySpec { folder: string; titlePattern: string; sections: string[]; tags: string[]; body: string }
export type Spec = GuideSpec | GeneratorSpec | MacroSpec | AssistSpec | ShopSpec | LibrarySpec;

export interface TemplateInput { kind: Kind; name: string; description: string; triggers: string[]; enabled: boolean; spec: Spec }

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const list = (v: unknown, max: number, each: number): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\n]/) : [];
  const out: string[] = [];
  for (const x of raw) { const t = s(x, each); if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t); }
  return out.slice(0, max);
};
const oneOf = <T extends string>(v: unknown, all: readonly T[], def: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : def);

export function cleanStep(v: any): Step | null {
  if (!v || typeof v !== 'object') return null;
  const kind = oneOf<StepKind>(v.kind, STEP_KINDS, 'instruction');
  const text = s(v.text, 400);
  const query = s(v.query, 200);
  if (!text && !query) return null;
  return { kind, text: text || defaultStepText(kind), ...(query ? { query } : {}) };
}

export const defaultStepText = (k: StepKind): string => ({
  library: 'Search the world library for lore about the place and what the request names.',
  neighbours: 'Find the neighbouring places (map, location links, relations) and keep the new page consistent with them.',
  exemplars: 'Read the exemplar pages and follow how they are structured.',
  web: 'Research the real-world reference on the web.',
  instruction: 'Follow the guide.',
}[k]);

export function cleanSpec(kind: Kind, v: any): Spec {
  const o = v && typeof v === 'object' ? v : {};
  switch (kind) {
    case 'guide': return {
      task: s(o.task, 120), instructions: s(o.instructions, 4000),
      steps: (Array.isArray(o.steps) ? o.steps : []).map(cleanStep).filter((x: Step | null): x is Step => !!x).slice(0, 12),
      sections: list(o.sections, 20, 80), tone: s(o.tone, 300), folder: s(o.folder, 120).replace(/^\/+|\/+$/g, ''),
      exemplars: list(o.exemplars, 6, 80), always: o.always === true,
    };
    case 'generator': return {
      generator: s(o.generator, 40) || 'town',
      fields: (Array.isArray(o.fields) ? o.fields : []).map((f: any) => ({ name: s(f?.name ?? f, 60), hint: s(f?.hint, 200) })).filter((f: any) => f.name).slice(0, 30),
      sections: list(o.sections, 20, 80), instructions: s(o.instructions, 3000), folder: s(o.folder, 120).replace(/^\/+|\/+$/g, ''),
    };
    case 'macro': {
      const params = (Array.isArray(o.params) ? o.params : []).map((p: any) => ({ name: s(p?.name ?? p, 40).replace(/[^A-Za-z0-9_]/g, '_'), label: s(p?.label, 80), default: s(p?.default, 300) })).filter((p: any) => /^[A-Za-z_]\w*$/.test(p.name)).slice(0, 10);
      return { prompt: s(o.prompt, 3000), params, mode: oneOf(o.mode, ['do', 'propose'] as const, 'propose'), tools: list(o.tools, 40, 60).join(',') };
    }
    case 'assist': return {
      layout: oneOf(o.layout, ['one', 'cols', 'rows', 'grid', 'side'] as const, 'cols'),
      panes: list(o.panes, 4, 40).filter((p) => /^[a-z0-9-]*$/.test(p)), prompt: s(o.prompt, 2000),
    };
    case 'shop': return { guide: s(o.guide, 4000), stock: list(o.stock, 30, 80), priceNotes: s(o.priceNotes, 500), shopType: s(o.shopType, 60) };
    case 'library': return {
      folder: s(o.folder, 120).replace(/^\/+|\/+$/g, ''), titlePattern: s(o.titlePattern, 120), sections: list(o.sections, 20, 80),
      tags: list(o.tags, 12, 40), body: s(o.body, 8000),
    };
  }
}

export function cleanTemplate(v: any, partialOf?: TemplateInput): TemplateInput {
  const o = v && typeof v === 'object' ? v : {};
  const kind: Kind | null = partialOf ? partialOf.kind : (KINDS as readonly string[]).includes(o.kind) ? o.kind as Kind : null;
  if (!kind) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
  const name = s(o.name ?? partialOf?.name, 80);
  if (!name) throw new HttpError(400, 'name is required');
  return {
    kind,
    name,
    description: s(o.description ?? partialOf?.description, 500),
    triggers: list(o.triggers ?? partialOf?.triggers, 20, 40).map((t) => t.toLowerCase()),
    enabled: typeof o.enabled === 'boolean' ? o.enabled : partialOf?.enabled ?? true,
    spec: cleanSpec(kind, o.spec ?? partialOf?.spec),
  };
}

/** Every piece of text in a template, for the classified check before it is saved (it later goes into model requests). */
export const templateText = (t: TemplateInput): string[] => {
  const out: string[] = [t.name, t.description, ...t.triggers];
  const walk = (v: unknown) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(t.spec);
  return out.filter(Boolean);
};

/** The guide as the assistant reads it (context for the model). */
export function guideText(t: { name: string; kind: Kind; description: string; spec: Spec }): string {
  const L: string[] = [`Guide "${t.name}" (${KIND_LABEL[t.kind]}). The DM wrote it for this kind of request: follow it.`];
  if (t.description) L.push(t.description);
  const sp: any = t.spec;
  if (t.kind === 'guide') {
    if (sp.task) L.push(`Task: ${sp.task}.`);
    if (sp.instructions) L.push(`Instructions: ${sp.instructions}`);
    if (sp.steps.length) L.push(`Steps:\n${sp.steps.map((x: Step, i: number) => `${i + 1}. ${x.text}`).join('\n')}`);
    if (sp.sections.length) L.push(`Every result has these sections, in this order: ${sp.sections.join(' · ')}.`);
    if (sp.tone) L.push(`Tone: ${sp.tone}`);
    if (sp.folder) L.push(`Save new pages in the folder ${sp.folder}/.`);
  } else if (t.kind === 'generator') {
    L.push(`Output for a ${sp.generator}.`);
    if (sp.fields.length) L.push(`Fields: ${sp.fields.map((f: any) => (f.hint ? `${f.name} (${f.hint})` : f.name)).join('; ')}.`);
    if (sp.sections.length) L.push(`Sections: ${sp.sections.join(' · ')}.`);
    if (sp.instructions) L.push(sp.instructions);
    if (sp.folder) L.push(`Save in ${sp.folder}/.`);
  } else if (t.kind === 'library') {
    if (sp.folder) L.push(`New pages go in ${sp.folder}/${sp.titlePattern ? ` titled like "${sp.titlePattern}"` : ''}.`);
    if (sp.sections.length) L.push(`Sections: ${sp.sections.join(' · ')}.`);
    if (sp.tags.length) L.push(`Tags: ${sp.tags.join(', ')}.`);
    if (sp.body) L.push(`Page skeleton:\n${sp.body.slice(0, 2000)}`);
  } else if (t.kind === 'shop') {
    if (sp.shopType) L.push(`Shop type: ${sp.shopType}.`);
    if (sp.guide) L.push(sp.guide);
    if (sp.stock.length) L.push(`Typical stock: ${sp.stock.join(', ')}.`);
    if (sp.priceNotes) L.push(`Prices: ${sp.priceNotes}`);
  }
  return L.join('\n');
}
