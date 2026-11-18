// One entry point for every generator: generate(spec) gives the same shape for
// an NPC, a monster, a tavern, a map or a list of names, so the page, the saver,
// the stage and the agent tools all work the same way. A spec (kind, preset,
// options, seed, locks) always reproduces the same result, so saving regenerates
// from the spec instead of trusting text the browser sends back.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob } from '../../core/ai.ts';
import { genNames, RACES } from '../quickgen/api.ts';
import { seedOf } from '../quickgen/rng.ts';
import { statblockMarkdown, type Statblock } from '../agent/statblock.ts';
import { genMap, MAP_KINDS, toSvg, type MapResult } from './maps/index.ts';
import { genMonster, MONSTER_PRESETS, type MonsterResult, type PoolMonster } from './monster.ts';
import { genNpc, NPC_PRESETS, npcSections, type NpcResult } from './npc.ts';
import { genPlaceNames, PLACE_FLAVOURS, PLACE_KINDS } from './names.ts';
import { genTavern, TAVERN_PRESETS, type TavernResult } from './tavern.ts';
import { worldModules } from '../modules/store.ts';
import { crLabel } from './cr.ts';
import { excerptOf, type WorldInfo } from './world.ts';

export const KINDS = ['npc', 'monster', 'tavern', 'map', 'names'] as const;
export type GenKind = (typeof KINDS)[number];

export interface Spec {
  kind: GenKind; preset?: string; seed?: string; options?: Record<string, any>; locks?: Record<string, string>; enrich?: boolean;
}
export interface Section { key: string; label: string; text: string; dm?: boolean }
export interface MapView { kind: string; size: string; flavour: string; title: string; seed: string; key: MapResult['key']; legend: string[]; stats: MapResult['stats']; ftPerCell: number | null; width: number; height: number; svg: string }
export interface Out {
  kind: GenKind; preset: string; seed: string; title: string; subtitle: string;
  fields: Record<string, string>; lockable: string[]; sections: Section[];
  statblock?: Statblock; lair?: string[]; map?: MapView; map_result?: MapResult;
  tie?: { id: string; title: string; kind: string; partyVisible: boolean } | null;
  names?: string[]; enriched: boolean; notes: string[]; attribution?: string;
  /** Not for the browser: the tavern's owner, for the saver. */
  _owner?: NpcResult;
}

const str = (v: unknown, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : v === undefined || v === null ? '' : String(v).slice(0, n));
const num = (v: unknown): number | undefined => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : undefined; };
const bool = (v: unknown) => v === true || v === 'true' || v === '1' || v === 1;
const cleanLocks = (l: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (l && typeof l === 'object' && !Array.isArray(l)) for (const [k, v] of Object.entries(l)) if (typeof v === 'string' && v.trim() && /^[a-z_]{1,24}$/.test(k)) out[k] = v.slice(0, 4000);
  return out;
};

/** Every module monster of the world, for reskinning. */
export function poolOf(d: Deps, worldId: string): PoolMonster[] {
  const wm = worldModules(d.db, worldId);
  const out: PoolMonster[] = [];
  for (const t of wm.terms) {
    if (t.kind !== 'monster' || !t.data || typeof t.data !== 'object') continue;
    const m = wm.enabled.find((x: any) => x.id === t.moduleId);
    out.push({ ref: t.ref, name: t.term, data: { ...(t.data as object), name: t.term }, moduleName: t.moduleName, attribution: m?.attribution ?? '' });
  }
  return out;
}

export interface Ctx { d: Deps; world: WorldInfo; pool: PoolMonster[]; hasModel?: boolean }

function npcOut(n: NpcResult, enriched: boolean, extra: Partial<Out> = {}): Out {
  const sections: Section[] = npcSections(n);
  const out: Out = {
    kind: 'npc', preset: n.preset, seed: n.seed, title: n.fields.name, subtitle: `${n.fields.role}, ${n.fields.race}`,
    fields: n.fields, lockable: ['name', 'race', 'look', 'voice', 'want', 'secret', 'hook', ...(n.fields.tie ? ['tie'] : [])], sections,
    tie: n.tie, enriched, notes: n.tie ? [] : ['No place or faction in the library was found to tie this person to.'], ...extra,
  };
  if (n.statblock) { out.statblock = n.statblock; out.sections = [...sections, { key: 'statblock', label: 'Statblock', text: `AC ${n.statblock.ac}, HP ${n.statblock.hp}, CR ${n.cr !== undefined ? crLabel(n.cr) : n.statblock.cr}`, dm: true }]; }
  return out;
}

function monsterOut(m: MonsterResult, enriched: boolean, locks: Record<string, string>): Out {
  const sb = m.statblock;
  const description = locks.description ?? m.description;
  const tactics = locks.tactics ?? m.tactics;
  const sections: Section[] = [
    { key: 'description', label: 'Concept', text: description },
    { key: 'tactics', label: 'Tactics', text: tactics, dm: true },
    ...(m.lair.length ? [{ key: 'lair', label: 'Lair actions (initiative count 20)', text: m.lair.map((l) => `- ${l}`).join('\n'), dm: true }] : []),
    { key: 'statblock', label: 'Statblock', text: `AC ${sb.ac}, HP ${sb.hp}, CR ${m.crLabel} (${m.table.xp.toLocaleString('en-US')} XP)`, dm: true },
  ];
  return {
    kind: 'monster', preset: m.preset, seed: m.seed, title: sb.name, subtitle: `${sb.size} ${sb.type}, CR ${m.crLabel}${m.boss ? ', boss' : ''}`,
    fields: { name: sb.name, description, tactics }, lockable: ['name', 'description', 'tactics'], sections, statblock: sb, lair: m.lair,
    enriched, notes: m.notes, attribution: m.source.attribution,
  };
}

function tavernOut(t: TavernResult, enriched: boolean): Out {
  const o = t.owner;
  const sections: Section[] = [
    { key: 'atmosphere', label: 'Atmosphere', text: t.fields.atmosphere },
    { key: 'owner', label: `Owner: ${o.fields.name}`, text: `${o.fields.role}, ${o.fields.race}. ${o.fields.look} ${o.fields.voice}` },
    { key: 'menu', label: 'Menu', text: t.fields.menu },
    { key: 'rooms', label: 'Rooms', text: t.fields.rooms },
    { key: 'patrons', label: 'Patrons', text: t.fields.patrons },
    { key: 'owner_dm', label: 'The owner, in secret', text: `${o.fields.want}\n\n${o.fields.secret}\n\n${o.fields.hook}${o.fields.tie ? `\n\n${o.fields.tie}` : ''}`, dm: true },
    { key: 'rumours', label: 'Rumours', text: t.fields.rumours.split('\n').map((l, i) => `${l} (${t.rumourTruth[i] ?? 'true'})`).join('\n'), dm: true },
  ];
  return {
    kind: 'tavern', preset: t.flavour, seed: t.seed, title: t.fields.name, subtitle: `${t.flavour} tavern, ${t.size}`,
    fields: t.fields, lockable: ['name', 'atmosphere', 'menu', 'rooms', 'patrons', 'rumours'], sections,
    map: mapView(t.map), map_result: t.map, tie: o.tie, enriched, notes: [], _owner: o,
  };
}

function mapView(m: MapResult): MapView {
  return { kind: m.kind, size: m.size, flavour: m.flavour, title: m.title, seed: m.seed, key: m.key, legend: m.legend, stats: m.stats, ftPerCell: m.ftPerCell, width: m.canvas.w, height: m.canvas.h, svg: toSvg(m.canvas, { dm: true, title: m.title }) };
}

function mapOut(m: MapResult, enriched: boolean, locks: Record<string, string>): Out {
  const sections: Section[] = [
    ...(locks.flavour ? [{ key: 'flavour', label: 'Read aloud', text: locks.flavour }] : []),
    { key: 'legend', label: 'Legend', text: m.legend.map((l) => `- ${l}`).join('\n') },
    { key: 'key', label: 'Key', text: m.key.map((k) => `${k.n}. **${k.name}.** ${k.text}${k.dm ? ` _DM: ${k.dm}_` : ''}`).join('\n'), dm: true },
  ];
  return {
    kind: 'map', preset: m.kind, seed: m.seed, title: m.title, subtitle: `${m.kind}, ${m.size}${m.flavour && m.flavour !== m.kind ? `, ${m.flavour}` : ''}${m.ftPerCell ? `, 1 square = ${m.ftPerCell} ft` : ''}`,
    fields: { title: m.title, ...(locks.flavour ? { flavour: locks.flavour } : {}) }, lockable: ['flavour'], sections, map: mapView(m), map_result: m, enriched, notes: [],
  };
}

function namesOut(o: Record<string, any>, seed: string, world: WorldInfo): Out {
  const nameKind = str(o.nameKind ?? 'person').toLowerCase();
  const count = Math.max(1, Math.min(60, Math.floor(num(o.count) ?? 12)));
  let list: string[];
  let sub: string;
  if (nameKind === 'person') {
    const g = genNames({ race: str(o.race) || 'any', gender: str(o.gender) || 'any', count, seed, style: str(o.style) || undefined });
    const used = world.titles;
    list = g.names.filter((n) => !used.has(n.name.toLowerCase())).map((n) => `${n.name} (${n.race}, ${n.gender})`);
    sub = `${str(o.style) || 'default'} style, ${g.race}, ${g.gender}`;
  } else {
    const g = genPlaceNames({ kind: nameKind, flavour: str(o.flavour) || 'common', count, seed, avoid: world.titles });
    list = g.names;
    sub = `${g.kind}, ${g.flavour}`;
  }
  return { kind: 'names', preset: nameKind, seed, title: `${nameKind === 'person' ? 'Person' : nameKind[0].toUpperCase() + nameKind.slice(1)} names`, subtitle: sub, fields: { names: list.join('\n') }, lockable: [], sections: [{ key: 'names', label: 'Names', text: list.map((l) => `- ${l}`).join('\n') }], names: list, enriched: false, notes: [] };
}

/** Run a generator offline from its spec. Throws RangeError on a bad option. */
export function generateOffline(ctx: Ctx, spec: Spec): Out {
  const o = spec.options ?? {};
  const seed = seedOf(spec.seed);
  const locks = cleanLocks(spec.locks);
  switch (spec.kind) {
    case 'npc': {
      const n = genNpc({ preset: spec.preset, race: str(o.race), gender: str(o.gender), partyLevel: num(o.partyLevel) ?? ctx.world.partyLevel, partySize: num(o.partySize), seed, statblock: bool(o.statblock), cr: o.cr, nameStyle: str(o.nameStyle) || undefined, locks, world: ctx.world });
      return npcOut(n, false);
    }
    case 'monster': {
      const m = genMonster({ preset: spec.preset, type: str(o.type) || undefined, cr: o.cr, partyLevel: num(o.partyLevel) ?? (o.useParty ? ctx.world.partyLevel : undefined), partySize: num(o.partySize), boss: bool(o.boss), concept: str(o.concept, 400), name: locks.name ?? (str(o.name) || undefined), seed, base: str(o.base) || undefined, pool: ctx.pool });
      return monsterOut(m, false, locks);
    }
    case 'tavern': {
      const t = genTavern({ flavour: spec.preset ?? str(o.flavour) ?? 'common', size: str(o.size) || 'medium', seed, locks, world: ctx.world, coins: ctx.world.coins });
      return tavernOut(t, false);
    }
    case 'map': {
      const kind = str(spec.preset ?? o.mapKind ?? 'dungeon');
      const m = genMap(kind, { seed, size: str(o.size) || 'medium', flavour: str(o.flavour) || undefined, theme: str(o.theme) || undefined, avoid: ctx.world.titles, title: locks.title });
      return mapOut(m, false, locks);
    }
    case 'names': return namesOut(o, seed, ctx.world);
    default: throw new RangeError(`kind must be one of ${KINDS.join(', ')}`);
  }
}

/** Ask the chat model to rewrite a few fields more vividly. Returns null when no model is set, it fails, or it answers badly. */
async function enrichWith(ctx: Ctx, kind: string, current: Record<string, string>, locked: Set<string>, keys: string[], hint: string): Promise<Record<string, string> | null> {
  if (!ctx.hasModel || !hasJob(ctx.d, 'chat')) return null;
  const want = keys.filter((k) => !locked.has(k) && current[k]);
  if (!want.length) return null;
  try {
    const out = await chatJson<Record<string, unknown>>(ctx.d, 'chat', [
      { role: 'system', content: `You help a D&D dungeon master. Rewrite the given fields of a generated ${kind} so they are vivid, specific and consistent with each other and with the world note, keeping each to one or two sentences. Do not add new facts about named people or places beyond the world note. Reply with JSON only, using exactly the keys given.` },
      { role: 'user', content: JSON.stringify({ fields: Object.fromEntries(want.map((k) => [k, current[k].slice(0, 500)])), world_note: hint.slice(0, 700) }) },
    ]);
    if (!out || typeof out !== 'object') return null;
    const res: Record<string, string> = {};
    for (const k of want) { const v = (out as any)[k]; if (typeof v === 'string' && v.trim() && v.length < 800) res[k] = v.trim(); }
    return Object.keys(res).length ? res : null;
  } catch { return null; }
}

/** generate(): offline first, then (when asked and a model is set) the model improves the text fields. */
export async function generate(ctx: Ctx, spec: Spec): Promise<Out> {
  const out = generateOffline(ctx, spec);
  const locks = cleanLocks(spec.locks);
  if (!spec.enrich || !ctx.hasModel) return out;
  const locked = new Set(Object.keys(locks));
  const hint = [ctx.world.worldId ? '' : '', out.tie ? `${out.tie.kind}: ${out.tie.title}. ${excerptOf(ctx.d, ctx.world.worldId, out.tie.id)}` : ''].filter(Boolean).join(' ');
  if (out.kind === 'npc') {
    const got = await enrichWith(ctx, 'NPC', out.fields, locked, ['look', 'voice', 'want', 'secret', 'hook'], hint);
    if (!got) return out;
    const n = { fields: { ...out.fields, ...got }, preset: out.preset, role: out.fields.role };
    return { ...out, fields: n.fields, sections: npcSections(n).concat(out.sections.filter((s) => s.key === 'statblock')), enriched: true };
  }
  if (out.kind === 'monster') {
    const got = await enrichWith(ctx, 'monster', out.fields, locked, ['description', 'tactics'], `${out.subtitle}. ${out.fields.description}`);
    if (!got) return out;
    return { ...out, fields: { ...out.fields, ...got }, sections: out.sections.map((s) => (s.key === 'description' || s.key === 'tactics') && got[s.key] ? { ...s, text: got[s.key] } : s), enriched: true };
  }
  if (out.kind === 'tavern') {
    const got = await enrichWith(ctx, 'tavern', out.fields, locked, ['atmosphere'], hint || `${out.subtitle}`);
    if (!got) return out;
    return { ...out, fields: { ...out.fields, ...got }, sections: out.sections.map((s) => (s.key === 'atmosphere' && got.atmosphere ? { ...s, text: got.atmosphere } : s)), enriched: true };
  }
  if (out.kind === 'map' && !locks.flavour) {
    const first = out.map?.key.slice(0, 4).map((k) => `${k.n}. ${k.name}`).join('; ') ?? '';
    const got = await enrichWith(ctx, 'map', { flavour: `${out.title}: ${out.subtitle}. ${first}` }, locked, ['flavour'], 'Write a two-sentence read-aloud introduction for a party arriving at this place.');
    if (!got?.flavour) return out;
    return { ...out, fields: { ...out.fields, flavour: got.flavour }, sections: [{ key: 'flavour', label: 'Read aloud', text: got.flavour }, ...out.sections], enriched: true };
  }
  return out;
}

// ---- Markdown -------------------------------------------------------------

const secret = (title: string, text: string) => `> [!secret] ${title}\n${text.split('\n').map((l) => `> ${l}`).join('\n')}`;

/** The page text. DM-only sections are secret callouts, so a page shared later still hides them; `level` party leaves out anything that is not meant for players at all (statblocks). */
export function renderMd(out: Out, level: 'dm' | 'party'): string {
  const L: string[] = [`# ${out.title}`, '', `*${out.subtitle}*`, ''];
  for (const s of out.sections) {
    if (s.key === 'statblock') continue;
    if (s.dm) L.push(secret(s.label, s.text), '');
    else L.push(`## ${s.label}`, '', s.text, '');
  }
  if (out.statblock && level === 'dm') L.push(statblockMarkdown(out.statblock).replace(/^# .*$/m, '## Statblock'));
  if (out.map) L.push('', `Map: see the picture attached to this page (seed \`${out.seed}\`, ${out.map.kind}, ${out.map.size}).`, '');
  if (out.attribution) L.push('', `_${out.attribution}_`, '');
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** The text players could see: public sections only. */
export function publicText(out: Out): string {
  const L: string[] = [`${out.title}`, `${out.subtitle}`, ''];
  for (const s of out.sections) if (!s.dm) L.push(`${s.label}`, s.text, '');
  return L.join('\n').trim();
}

void MAP_KINDS; void RACES; void NPC_PRESETS; void MONSTER_PRESETS; void TAVERN_PRESETS; void PLACE_FLAVOURS; void PLACE_KINDS;
