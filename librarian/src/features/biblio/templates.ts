// Biblio's article templates. A template is a page type (the same type names
// the Kanka, World Anvil and LegendKeeper imports give pages, so filters and
// agents treat a Biblio character and an imported character alike) plus the
// infobox fields an article of that type has.
//
// Field types:
//   text, long  plain words (long: a paragraph; both may hold [[links]])
//   number      a number
//   date        an in-world date, as written ("3 Frostfall 1042 AR"); the first
//               whole number in it sorts the timeline
//   link, links one or more [[Article]] names
//   yesno       yes or no
// `gm: true` fields are GM only: they go into a GM-only infobox group that
// players never receive. `rel` names the relation a link field makes (the
// frontmatter keys the library reads relations from), so it shows on the
// Relations page and in the agents' who_is answers.
import { HttpError } from '../../core/util.ts';

export type FieldType = 'text' | 'long' | 'number' | 'date' | 'link' | 'links' | 'yesno';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'long', 'number', 'date', 'link', 'links', 'yesno'];

export interface TemplateField { key: string; label: string; type: FieldType; gm?: boolean; rel?: string; help?: string }
export interface Template { id: string; name: string; icon: string; fields: TemplateField[]; builtin?: boolean; description?: string }

const f = (key: string, label: string, type: FieldType = 'text', more: Partial<TemplateField> = {}): TemplateField => ({ key, label, type, ...more });
const gm = (key: string, label: string, type: FieldType = 'long'): TemplateField => f(key, label, type, { gm: true });

/** Relation words the library understands, by frontmatter key (see core/library.ts REL_KEYS). */
export const REL_FIELDS = new Set(['parents', 'children', 'spouse', 'partner', 'siblings', 'allies', 'enemies', 'rivals', 'member_of', 'lovers']);

export const BUILTIN_TEMPLATES: Template[] = [
  { id: 'page', name: 'Page', icon: 'fa-file-lines', description: 'A plain article with no infobox.', fields: [] },
  {
    id: 'character', name: 'Character', icon: 'fa-user', description: 'A person: an NPC, a player character, a figure from history.',
    fields: [
      f('title', 'Title'), f('pronouns', 'Pronouns'), f('age', 'Age'), f('race', 'People', 'link'), f('occupation', 'Occupation'),
      f('home', 'Home', 'link'), f('member_of', 'Member of', 'links', { rel: 'member_of' }), f('parents', 'Parents', 'links', { rel: 'parents' }),
      f('spouse', 'Spouse', 'link', { rel: 'spouse' }), f('allies', 'Allies', 'links', { rel: 'allies' }), f('enemies', 'Enemies', 'links', { rel: 'enemies' }),
      f('status', 'Status'), f('born', 'Born', 'date'), f('died', 'Died', 'date'),
      gm('motivation', 'What they really want'), gm('secret', 'Secret'),
    ],
  },
  {
    id: 'location', name: 'Location', icon: 'fa-location-dot', description: 'A place: a region, city, village, dungeon or building.',
    fields: [
      f('type', 'Kind of place'), f('located_in', 'Located in', 'link'), f('population', 'Population', 'number'), f('ruler', 'Ruled by', 'link'),
      f('climate', 'Climate'), f('founded', 'Founded', 'date'), f('notable', 'Notable for', 'long'), gm('hidden', 'Hidden truths'),
    ],
  },
  {
    id: 'organisation', name: 'Organisation', icon: 'fa-people-group', description: 'A faction, guild, house, church, army or company.',
    fields: [
      f('type', 'Kind'), f('leader', 'Led by', 'link'), f('headquarters', 'Headquarters', 'link'), f('allies', 'Allies', 'links', { rel: 'allies' }),
      f('enemies', 'Enemies', 'links', { rel: 'enemies' }), f('founded', 'Founded', 'date'), f('goals', 'Known goals', 'long'), gm('secret_goals', 'Secret goals'),
    ],
  },
  {
    id: 'item', name: 'Item', icon: 'fa-gem', description: 'An object: a weapon, relic, artifact or trade good.',
    fields: [
      f('type', 'Kind'), f('rarity', 'Rarity'), f('attunement', 'Needs attunement', 'yesno'), f('owner', 'Held by', 'link'), f('value', 'Value'),
      f('weight', 'Weight'), f('effects', 'What it does', 'long'), gm('true_nature', 'True nature'),
    ],
  },
  {
    id: 'creature', name: 'Creature', icon: 'fa-dragon', description: 'A monster, beast or other being.',
    fields: [
      f('type', 'Kind'), f('size', 'Size'), f('cr', 'Challenge rating'), f('habitat', 'Found in', 'links'), f('behaviour', 'Behaviour', 'long'),
      gm('weakness', 'Weakness'), gm('tactics', 'Tactics'),
    ],
  },
  {
    id: 'race', name: 'People', icon: 'fa-users', description: 'A people, species, ancestry or culture.',
    fields: [f('lifespan', 'Lifespan'), f('homeland', 'Homeland', 'links'), f('languages', 'Languages'), f('traits', 'Traits', 'long'), gm('origin_truth', 'Their true origin')],
  },
  {
    id: 'deity', name: 'Deity', icon: 'fa-sun', description: 'A god, patron or other power that is worshipped.',
    fields: [
      f('domains', 'Domains'), f('alignment', 'Alignment'), f('symbol', 'Holy symbol'), f('worshippers', 'Worshipped by', 'links'), f('holy_site', 'Holy site', 'link'),
      gm('hidden_aim', 'Hidden aim'),
    ],
  },
  {
    id: 'event', name: 'Event', icon: 'fa-hourglass-half', description: 'Something that happened (or will): a war, a coronation, a disaster. Its date puts it on the timeline.',
    fields: [f('date', 'When', 'date'), f('ended', 'Ended', 'date'), f('where', 'Where', 'link'), f('who', 'Who took part', 'links'), f('outcome', 'Outcome', 'long'), gm('truth', 'What really happened')],
  },
  {
    id: 'quest', name: 'Quest', icon: 'fa-scroll', description: 'A job, mystery or story thread the party can follow.',
    fields: [f('status', 'Status'), f('given_by', 'Given by', 'link'), f('where', 'Where', 'link'), f('reward', 'Reward'), gm('twist', 'The twist'), gm('if_ignored', 'If they ignore it')],
  },
  {
    id: 'note', name: 'Lore', icon: 'fa-book-open', description: 'Lore, a legend, a document, a custom or a rule of the world.',
    fields: [f('category', 'Category'), f('known_by', 'Known by', 'links'), gm('truth', 'The truth of it')],
  },
  {
    id: 'session', name: 'Session notes', icon: 'fa-dice-d20', description: 'What happened at one game night.',
    fields: [f('number', 'Session', 'number'), f('played', 'Played on'), f('date', 'In-world date', 'date'), f('present', 'Who was there'), gm('next_time', 'For next time')],
  },
];

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** A GM's own template, checked. Throws a 400 on anything wrong. */
export function cleanTemplate(raw: any, takenIds: Set<string>): Template {
  const name = String(raw?.name ?? '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'A template needs a name');
  const id = String(raw?.id ?? '').trim().toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!KEY.test(id)) throw new HttpError(400, 'Template id: lowercase letters, numbers and _ only, starting with a letter');
  if (BUILTIN_TEMPLATES.some((t) => t.id === id)) throw new HttpError(409, `"${id}" is a built-in template: pick another id`);
  if (takenIds.has(id)) throw new HttpError(409, `There is already a template "${id}"`);
  const fields = Array.isArray(raw?.fields) ? raw.fields : [];
  if (fields.length > 40) throw new HttpError(400, 'At most 40 fields in a template');
  const seen = new Set<string>();
  const out: TemplateField[] = fields.map((x: any) => {
    const label = String(x?.label ?? '').trim().slice(0, 60);
    const key = String(x?.key ?? '').trim().toLowerCase() || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!label || !KEY.test(key)) throw new HttpError(400, `Bad field "${label || key}": give it a label`);
    if (seen.has(key)) throw new HttpError(400, `Two fields are called "${key}"`);
    seen.add(key);
    const type = FIELD_TYPES.includes(x?.type) ? x.type : 'text';
    const rel = typeof x?.rel === 'string' && REL_FIELDS.has(x.rel) && (type === 'link' || type === 'links') ? x.rel : undefined;
    return { key, label, type, ...(x?.gm === true ? { gm: true } : {}), ...(rel ? { rel } : {}), ...(x?.help ? { help: String(x.help).slice(0, 200) } : {}) };
  });
  const icon = /^fa-[a-z0-9-]{1,40}$/.test(String(raw?.icon ?? '')) ? String(raw.icon) : 'fa-file-lines';
  return { id, name, icon, fields: out, description: String(raw?.description ?? '').slice(0, 200) };
}
