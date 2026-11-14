// Statblocks in the game module's monster format (docs/MODULES.md): built
// from a module monster (a copy, no model), a library page or a prompt (the
// chat model), checked, and saved as a DM-only page in "Statblocks".
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, type ChatMessage } from '../../core/ai.ts';
import { one } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { HttpError } from '../../core/util.ts';
import { worldModules } from '../modules/store.ts';

export interface Feature { name: string; text: string }
export interface Statblock {
  name: string; size: string; type: string; alignment: string; cr: number | string | null; xp: number | null;
  ac: number; acType: string | null; hp: number; hitDice: string | null;
  speed: Record<string, string>;
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  savingThrows: Record<string, number>; skills: Record<string, number>;
  vulnerabilities: string[]; resistances: string[]; immunities: string[]; conditionImmunities: string[];
  senses: Record<string, string | number>; languages: string;
  traits: Feature[]; actions: Feature[]; bonusActions: Feature[]; reactions: Feature[]; legendaryActions: Feature[];
}

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const bad = (msg: string) => new HttpError(422, `The statblock is not valid: ${msg}`);
const text = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const wholeNumber = (v: unknown, field: string, min: number, max: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number from ${min} to ${max}`);
  return n;
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => text(x, 120)).filter(Boolean).slice(0, 30) : []);
const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && Number.isFinite(x)) out[text(k, 40)] = x;
  return out;
};
const features = (v: unknown, field: string, required = false): Feature[] => {
  if (v === undefined || v === null) { if (required) throw bad(`${field} is needed`); return []; }
  if (!Array.isArray(v)) throw bad(`${field} must be a list`);
  const out = v.slice(0, 40).map((x, i) => {
    const name = text((x as any)?.name, 120);
    const t = text((x as any)?.text ?? (x as any)?.desc, 4000);
    if (!name || !t) throw bad(`${field}[${i + 1}] needs a name and text`);
    return { name, text: t };
  });
  if (required && !out.length) throw bad(`${field} needs at least one entry`);
  return out;
};

/** Check and clean a statblock from any source. Throws 422 on a bad one. */
export function normalizeStatblock(raw: any, fallbackName = ''): Statblock {
  if (!raw || typeof raw !== 'object') throw bad('it is not an object');
  const name = text(raw.name ?? fallbackName, 120);
  if (!name) throw bad('it needs a name');
  const ab: any = raw.abilities;
  if (!ab || typeof ab !== 'object') throw bad('abilities are needed (str, dex, con, int, wis, cha)');
  const abilities = Object.fromEntries(ABILITIES.map((k) => [k, wholeNumber(ab[k], `abilities.${k}`, 1, 30)])) as Statblock['abilities'];
  let speed: Record<string, string> = {};
  if (typeof raw.speed === 'string' && raw.speed.trim()) speed = { walk: raw.speed.trim().slice(0, 60) };
  else if (raw.speed && typeof raw.speed === 'object') for (const [k, v] of Object.entries(raw.speed)) { const s = text(v, 60); if (s) speed[text(k, 30)] = s; }
  if (!Object.keys(speed).length) throw bad('speed is needed, e.g. { "walk": "30 ft." }');
  const cr = raw.cr === null || raw.cr === undefined || raw.cr === '' ? null : typeof raw.cr === 'number' ? raw.cr : text(raw.cr, 10) || null;
  const senses: Record<string, string | number> = {};
  if (raw.senses && typeof raw.senses === 'object' && !Array.isArray(raw.senses)) for (const [k, v] of Object.entries(raw.senses)) if (typeof v === 'string' || typeof v === 'number') senses[text(k, 40)] = v;
  return {
    name, size: text(raw.size, 20) || 'Medium', type: text(raw.type, 60) || 'monstrosity', alignment: text(raw.alignment, 60) || 'unaligned',
    cr, xp: Number.isInteger(raw.xp) && raw.xp >= 0 ? raw.xp : null,
    ac: wholeNumber(raw.ac, 'ac', 1, 40), acType: text(raw.acType, 80) || null,
    hp: wholeNumber(raw.hp, 'hp', 1, 9999), hitDice: text(raw.hitDice, 40) || null,
    speed, abilities,
    savingThrows: numMap(raw.savingThrows), skills: numMap(raw.skills),
    vulnerabilities: list(raw.vulnerabilities), resistances: list(raw.resistances), immunities: list(raw.immunities), conditionImmunities: list(raw.conditionImmunities),
    senses, languages: text(raw.languages, 200),
    traits: features(raw.traits, 'traits'), actions: features(raw.actions, 'actions', true), bonusActions: features(raw.bonusActions, 'bonusActions'),
    reactions: features(raw.reactions, 'reactions'), legendaryActions: features(raw.legendaryActions, 'legendaryActions'),
  };
}

export const mod = (score: number) => Math.floor((score - 10) / 2);
const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
export const rollInitiative = (sb: Statblock): number => 1 + Math.floor(Math.random() * 20) + mod(sb.abilities.dex);

/** The statblock as Markdown, with the data in a fenced block so "Add to combat" can read it back. */
export function statblockMarkdown(sb: Statblock): string {
  const L: string[] = [];
  L.push(`# ${sb.name}`, '', `*${sb.size} ${sb.type}, ${sb.alignment}*`, '');
  L.push(`**AC** ${sb.ac}${sb.acType ? ` (${sb.acType})` : ''} · **HP** ${sb.hp}${sb.hitDice ? ` (${sb.hitDice})` : ''} · **Speed** ${Object.entries(sb.speed).map(([k, v]) => `${k} ${v}`).join(', ')}`, '');
  L.push('| STR | DEX | CON | INT | WIS | CHA |', '|---|---|---|---|---|---|');
  L.push(`| ${ABILITIES.map((k) => `${sb.abilities[k]} (${signed(mod(sb.abilities[k]))})`).join(' | ')} |`, '');
  const kv = (k: string, v: string) => v && L.push(`**${k}** ${v}  `);
  kv('Saving throws', Object.entries(sb.savingThrows).map(([k, v]) => `${k} ${signed(v)}`).join(', '));
  kv('Skills', Object.entries(sb.skills).map(([k, v]) => `${k} ${signed(v)}`).join(', '));
  kv('Vulnerabilities', sb.vulnerabilities.join(', '));
  kv('Resistances', sb.resistances.join(', '));
  kv('Immunities', sb.immunities.join(', '));
  kv('Condition immunities', sb.conditionImmunities.join(', '));
  kv('Senses', Object.entries(sb.senses).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', '));
  kv('Languages', sb.languages);
  kv('CR', sb.cr === null ? '' : `${sb.cr}${sb.xp !== null ? ` (${sb.xp} XP)` : ''}`);
  const sect = (title: string, f: Feature[]) => { if (f.length) { L.push('', `### ${title}`, ''); for (const x of f) L.push(`**${x.name}.** ${x.text}`, ''); } };
  sect('Traits', sb.traits); sect('Actions', sb.actions); sect('Bonus Actions', sb.bonusActions); sect('Reactions', sb.reactions); sect('Legendary Actions', sb.legendaryActions);
  L.push('', '```statblock-json', JSON.stringify(sb), '```', '');
  return L.join('\n');
}

/** Read a statblock back from a page this module wrote. */
export function statblockFromBody(body: string): Statblock | null {
  const m = body.match(/```statblock-json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return normalizeStatblock(JSON.parse(m[1])); } catch { return null; }
}

export type StatblockSource = { moduleTermId: string } | { pageId: string } | { prompt: string };

const SHAPE = `{"name":"","size":"Medium","type":"humanoid","alignment":"","cr":1,"xp":200,"ac":13,"acType":"leather armor","hp":27,"hitDice":"5d8+5","speed":{"walk":"30 ft."},"abilities":{"str":10,"dex":14,"con":12,"int":10,"wis":10,"cha":10},"savingThrows":{},"skills":{"Stealth":4},"vulnerabilities":[],"resistances":[],"immunities":[],"conditionImmunities":[],"senses":{"darkvision":"60 ft.","passive_perception":10},"languages":"Common","traits":[{"name":"","text":""}],"actions":[{"name":"Scimitar","text":"Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage."}],"bonusActions":[],"reactions":[],"legendaryActions":[]}`;

/** Build a statblock. Module monsters need no model; the rest answer 503 without a chat model. */
export async function buildStatblock(d: Deps, worldId: string, viewer: Viewer, src: StatblockSource): Promise<{ statblock: Statblock; source: { kind: string; ref: string; title: string; attribution?: string } }> {
  if ('moduleTermId' in src) {
    const t = worldModules(d.db, worldId).byRef.get(src.moduleTermId);
    if (!t) throw new HttpError(404, 'That module term was not found');
    if (t.kind !== 'monster' || !t.data || typeof t.data !== 'object') throw new HttpError(422, 'That module term is not a monster with a statblock');
    const m = worldModules(d.db, worldId).enabled.find((x) => x.id === t.moduleId);
    return { statblock: normalizeStatblock({ ...(t.data as object), name: t.term }, t.term), source: { kind: 'module', ref: t.ref, title: t.term, attribution: m?.attribution } };
  }
  if (!hasJob(d, 'chat')) throw new HttpError(503, 'No chat model is set (Admin → Models), so the agent cannot write statblocks. Copying a monster from the game module still works.');
  let user: string;
  let source: { kind: string; ref: string; title: string };
  if ('pageId' in src) {
    // The page goes to a model: the AI copy, which never has classified content.
    const pg: any = d.library.get(worldId, src.pageId, viewer.role === 'dm' ? { ...viewer, audience: 'ai' } : viewer);
    user = `Library page "${pg.title}":\n\n${String(pg.body ?? '').slice(0, 8000)}\n\nBuild the creature's statblock from this page. Use any numbers the page gives; fill in what is missing to fit the creature.`;
    source = { kind: 'page', ref: pg.id, title: pg.title };
  } else {
    user = `Write a statblock for: ${src.prompt.slice(0, 2000)}`;
    source = { kind: 'prompt', ref: '', title: src.prompt.slice(0, 80) };
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: `You write D&D 5e statblocks for a game master. Answer with one JSON object only, in this shape (all fields shown; ac, hp, speed, abilities and at least one action are required):\n${SHAPE}\nAbility scores are integers 1 to 30. Keep action text short, with attack bonus and damage.` },
    { role: 'user', content: user },
  ];
  const raw = await chatJson<any>(d, 'chat', messages);
  if (!raw) throw new HttpError(502, 'The chat model did not return a usable statblock. Try again or write it by hand.');
  return { statblock: normalizeStatblock(raw, source.kind === 'page' ? source.title : ''), source };
}

/** Save a statblock as a DM-only library page in "Statblocks". */
export function saveStatblockPage(d: Deps, worldId: string, accountId: string, sb: Statblock, source: { kind: string; ref: string; title: string; attribution?: string }) {
  const base = `Statblocks/${sb.name.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || 'Creature'}`;
  let path = `${base}.md`;
  for (let n = 2; one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', worldId, path); n++) path = `${base} ${n}.md`;
  const frontmatter: Record<string, any> = { title: sb.name, kind: 'statblock', tags: ['statblock'], visibility: 'dm', source: source.kind === 'module' ? `module ${source.ref}` : source.kind };
  if (source.attribution) frontmatter.attribution = source.attribution;
  return d.library.save(worldId, { path, title: sb.name, body: statblockMarkdown(sb), frontmatter, visibility: 'dm' }, accountId);
}
