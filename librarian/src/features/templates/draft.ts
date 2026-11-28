// The assistant's side of making a template: draft one from what the GM describes (asking a few questions back), and
// derive a guide from example pages (their common structure). Both work with no model: the structure comes from rules
// and the pages themselves, and a chat model, when set, only improves the wording. Nothing here is saved; the GM edits
// the draft and saves it.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, type ChatMessage } from '../../core/ai.ts';
import type { Viewer } from '../../core/policy.ts';
import { cleanSpec, cleanStep, KIND_LABEL, type Kind, type Spec, type Step, type TemplateInput } from './spec.ts';

interface Task { re: RegExp; name: string; noun: string; triggers: string[]; sections: string[]; folder: string; generator: string }
// What the GM is most likely making, from their words: a name, triggers and a sensible page structure for each.
const TASKS: Task[] = [
  { re: /\b(towns?|villages?|cit(?:y|ies)|hamlets?|settlements?|ports?)\b/i, name: 'Towns', noun: 'town', triggers: ['town', 'village', 'city', 'hamlet', 'settlement'], sections: ['Overview', 'Geography & layout', 'People & culture', 'Places of note', 'Power & factions', 'Neighbours & trade', 'Rumours & hooks', 'Secrets (GM)'], folder: 'Places', generator: 'town' },
  { re: /\b(taverns?|inns?|alehouses?)\b/i, name: 'Taverns', noun: 'tavern', triggers: ['tavern', 'inn'], sections: ['Overview', 'Owner & staff', 'Menu & prices', 'Rooms', 'Regulars', 'Rumours', 'Secrets (GM)'], folder: 'Places', generator: 'tavern' },
  { re: /\b(shops?|stores?|merchants?|markets?|smith(?:y|ies)?)\b/i, name: 'Shops', noun: 'shop', triggers: ['shop', 'store', 'merchant'], sections: ['Overview', 'Owner', 'Stock & prices', 'Haggling', 'Secrets (GM)'], folder: 'Places/Shops', generator: 'shop' },
  { re: /\b(npcs?|characters?|villains?|nobles?)\b/i, name: 'NPCs', noun: 'NPC', triggers: ['npc', 'character', 'villain'], sections: ['Look', 'Voice & manner', 'Wants', 'Ties', 'Hooks', 'Secrets (GM)'], folder: 'People', generator: 'npc' },
  { re: /\b(dungeons?|caves?|ruins?|lairs?|crypts?)\b/i, name: 'Dungeons', noun: 'dungeon', triggers: ['dungeon', 'cave', 'ruin', 'lair', 'crypt'], sections: ['Overview', 'History', 'Areas', 'Inhabitants', 'Traps & hazards', 'Treasure', 'Secrets (GM)'], folder: 'Places/Dungeons', generator: 'dungeon' },
  { re: /\b(factions?|guilds?|orders?|cults?|houses?)\b/i, name: 'Factions', noun: 'faction', triggers: ['faction', 'guild', 'order', 'cult'], sections: ['Overview', 'Leaders', 'Goals', 'Resources', 'Allies & rivals', 'Hooks', 'Secrets (GM)'], folder: 'Factions', generator: 'faction' },
  { re: /\b(regions?|kingdoms?|provinces?|countr(?:y|ies)|islands?)\b/i, name: 'Regions', noun: 'region', triggers: ['region', 'kingdom', 'province', 'island'], sections: ['Overview', 'Geography', 'Settlements', 'Peoples', 'History', 'Dangers', 'Secrets (GM)'], folder: 'Places', generator: 'region' },
  { re: /\b(quests?|adventures?|missions?)\b/i, name: 'Quests', noun: 'quest', triggers: ['quest', 'adventure', 'mission'], sections: ['Hook', 'Goal', 'Locations', 'Opposition', 'Twist', 'Rewards', 'Secrets (GM)'], folder: 'Quests', generator: 'quest' },
  { re: /\b(monsters?|creatures?|beasts?)\b/i, name: 'Monsters', noun: 'monster', triggers: ['monster', 'creature', 'beast'], sections: ['Look', 'Behaviour', 'Lair', 'Tactics', 'Lore'], folder: 'Bestiary', generator: 'monster' },
];
const GENERIC: Task = { re: /$^/, name: '', noun: 'page', triggers: [], sections: ['Overview', 'Details', 'Hooks', 'Secrets (GM)'], folder: '', generator: 'npc' };

const NATIONS: Record<string, string> = {
  japanese: 'Japan', chinese: 'China', korean: 'Korea', english: 'England', scottish: 'Scotland', irish: 'Ireland', welsh: 'Wales', french: 'France',
  german: 'Germany', italian: 'Italy', spanish: 'Spain', portuguese: 'Portugal', norwegian: 'Norway', swedish: 'Sweden', danish: 'Denmark', icelandic: 'Iceland',
  greek: 'Greece', roman: 'Italy', egyptian: 'Egypt', indian: 'India', mexican: 'Mexico', peruvian: 'Peru', dutch: 'Netherlands', polish: 'Poland',
  russian: 'Russia', turkish: 'Turkey', persian: 'Iran', moroccan: 'Morocco', vietnamese: 'Vietnam', thai: 'Thailand', mongolian: 'Mongolia', czech: 'Czech Republic',
};
const WEB_CUE = /\b(irl|real[- ]?world|real (?:life|place|town|city|village|one)s?|research|look (?:it )?up|on the (?:web|internet)|online|wikipedia|historical)\b/i;
const LORE_CUE = /\b(lore|library|my (?:own )?world|wiki|canon|world'?s)\b/i;
const NEAR_CUE = /\b(around|neighbou?r\w*|nearby|surround\w*|close by|adjacent|region|next to|the others|other (?:towns|places))\b/i;

export const taskFor = (text: string): Task => TASKS.find((t) => t.re.test(text)) ?? GENERIC;
const nationIn = (text: string): { adj: string; country: string } | null => {
  for (const m of text.toLowerCase().matchAll(/[a-z]+/g)) if (NATIONS[m[0]]) return { adj: m[0][0].toUpperCase() + m[0].slice(1), country: NATIONS[m[0]] };
  return null;
};
const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export interface Draft { template: TemplateInput; questions: string[]; notes: string[]; usedModel: boolean }

/** A draft from the GM's words alone (no model): the starting point the model improves, and the answer without one. */
export function heuristicDraft(kind: Kind, description: string): Draft {
  const text = description.trim();
  const task = taskFor(text);
  const head = /^([^:\n]{2,40}):/.exec(text)?.[1]?.trim();
  const name = head || task.name || titleCase(text.split(/\s+/).slice(0, 4).join(' ')).slice(0, 60) || KIND_LABEL[kind];
  const nation = nationIn(text);
  const questions: string[] = [];
  let spec: any;
  if (kind === 'guide') {
    const steps: Step[] = [];
    // The world's own lore is always read first.
    steps.push({ kind: 'library', text: `Search the world library for ${LORE_CUE.test(text) ? 'the world\'s own lore' : 'lore'} about the ${task.noun}, the region it is in and anything the request names.` });
    if (NEAR_CUE.test(text) || task.noun === 'town') steps.push({ kind: 'neighbours', text: `Find the ${task.noun === 'town' ? 'towns' : 'places'} around it (map, location links, relations) and keep the new ${task.noun} consistent with them: roads, trade, rivalries.` });
    if (WEB_CUE.test(text) || nation) {
      steps.push({ kind: 'web', text: `Research the real ${nation ? `${nation.adj} ` : ''}${task.noun === 'page' ? 'place' : task.noun} it is based on (the real-world reference named in the request) on the web, and borrow real details: layout, history, trades, festivals.`, query: `{reference}${nation ? ` ${nation.country}` : ''} ${task.noun === 'page' ? '' : task.noun} history geography culture`.replace(/\s+/g, ' ').trim() });
      questions.push(`Which real-world ${task.noun === 'page' ? 'place' : task.noun} should it draw on when a request names none?`);
    }
    steps.push({ kind: 'exemplars', text: `Read two existing ${task.noun} pages and follow how they are structured.` });
    steps.push({ kind: 'instruction', text: 'Draft the page with the sections below; anything the players must not read goes in a > [!secret] block; save it GM-only and cite every source.' });
    spec = { task: `Make a ${task.noun}`, instructions: text, steps, sections: task.sections, tone: '', folder: task.folder, exemplars: [], always: false };
    questions.push(`Which sections must every ${task.noun} page have, and in what order?`, 'Which existing pages are the best examples to follow?');
    if (!task.folder) questions.push('Which library folder should new pages go in?');
  } else if (kind === 'generator') {
    spec = { generator: task.generator, fields: task.sections.filter((s) => !/secret/i.test(s)).map((s) => ({ name: s, hint: '' })), sections: task.sections, instructions: text, folder: task.folder ? `Generated/${task.noun}` : '' };
    questions.push('Which fields must every result have?', 'Should results be saved for the players or GM only?');
  } else if (kind === 'macro') {
    const params = [...new Set([...text.matchAll(/\{\{?\s*([A-Za-z_]\w*)\s*\}?\}/g)].map((m) => m[1]))];
    spec = { prompt: text, params: (params.length ? params : ['details']).map((p) => ({ name: p, label: titleCase(p.replace(/_/g, ' ')), default: '' })), mode: 'propose', tools: '' };
    if (!params.length) spec.prompt = `${text}\n\nDetails from the GM: {{details}}`;
    questions.push('Should the macro do it at once, or propose each change for you to approve?', 'Which tools may it use?');
  } else if (kind === 'assist') {
    const panes = ['combat', 'sound', 'library', 'inbox', 'scenes', 'clock', 'stage', 'generators', 'minerva'].filter((p) => new RegExp(`\\b${p}`, 'i').test(text)).slice(0, 3);
    spec = { layout: panes.length ? 'cols' : 'one', panes: [...panes, 'assistant'].slice(0, 4), prompt: text };
    questions.push('Which pages should sit beside the assistant?');
  } else if (kind === 'shop') {
    spec = { shopType: task.noun === 'shop' ? 'general store' : task.noun, guide: text, stock: [], priceNotes: '' };
    questions.push('What should every shop like this stock?', 'Are prices higher or lower than the book?');
  } else if (kind === 'event') {
    const low = text.toLowerCase();
    const places = ['town', 'city', 'village', 'market', 'tavern', 'road', 'woods', 'cave', 'dungeon', 'ruins', 'coast', 'mountains', 'swamp'].filter((p) => new RegExp(`\\b${p}`, 'i').test(low) || (p === 'woods' && /\bforest/.test(low)));
    spec = { places, theme: text.split(/[.\n]/)[0].slice(0, 200), instructions: text, tone: '', choices: 3, checks: true, maxRewardCp: 100, consequences: 'Note what each choice leads to for the GM: who saw it, who might remember.' };
    questions.push('Which places should these events fit (town, road, woods, cave, dungeon...)?', 'How much coin may one event give or take?', 'Should every event have a skill check?');
    return { template: { kind, name: (head || (places.length ? `${titleCase(places[0])} events` : 'Quick events')).slice(0, 80), description: text.slice(0, 500), triggers: ['quick event', 'event', 'happens'], enabled: true, spec: cleanSpec(kind, spec) }, questions, notes: [], usedModel: false };
  } else if (kind === 'spell') {
    const lv = /\bcantrips?\b/i.test(text) ? [0, 0] : (() => { const m = text.match(/\blevel\s*(\d)(?:\s*(?:-|to)\s*(\d))?/i) ?? text.match(/\b(\d)(?:st|nd|rd|th)[- ]level/i); return m ? [Number(m[1]), Number(m[2] ?? m[1])] : [0, 9]; })();
    const schools = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'].filter((x) => new RegExp(x.slice(0, 6), 'i').test(text));
    const classes = ['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger', 'Sorcerer', 'Warlock', 'Wizard'].filter((x) => new RegExp(`\\b${x}`, 'i').test(text));
    const lines = ['Fire', 'Frost', 'Lightning', 'Healing', 'Shadow', 'Water', 'Earth', 'Air', 'Light', 'Blood'].filter((x) => new RegExp(`\\b${x}`, 'i').test(text));
    spec = { minLevel: lv[0], maxLevel: lv[1], schools, classes, lines, balance: 'Match the damage, area and duration of SRD spells of the same level; a rider costs damage.', mana: '', naming: '', instructions: text, higherLevels: true };
    questions.push('Which levels and schools should new spells be?', 'Which classes (or spell lines) get them?', 'Any rule for their mana cost?');
    return { template: { kind, name: (head || (lines[0] ? `${lines[0]} spells` : 'New spells')).slice(0, 80), description: text.slice(0, 500), triggers: ['spell', 'cantrip'], enabled: true, spec: cleanSpec(kind, spec) }, questions, notes: [], usedModel: false };
  } else {
    const body = [`# {name}`, '', ...task.sections.flatMap((s) => (/secret/i.test(s) ? [`## ${s.replace(/\s*\(GM\)/i, '')}`, '> [!secret] GM', '> ', ''] : [`## ${s}`, '', '']))].join('\n');
    spec = { folder: task.folder, titlePattern: '{name}', sections: task.sections, tags: task.noun === 'page' ? [] : [task.noun.toLowerCase()], body };
    questions.push('Which folder and tags should new pages get?');
  }
  return {
    template: { kind, name: name.slice(0, 80), description: text.slice(0, 500), triggers: kind === 'macro' || kind === 'assist' ? [] : task.triggers, enabled: true, spec: cleanSpec(kind, spec) },
    questions: questions.slice(0, 3), notes: [], usedModel: false,
  };
}

const SPEC_SHAPE: Record<Kind, string> = {
  guide: '{"task": "Make a town", "instructions": "...", "steps": [{"kind": "library|neighbours|exemplars|web|instruction", "text": "...", "query": "only for web: the search words, with {reference} for the real-world place the request names"}], "sections": ["Overview", ...], "tone": "...", "folder": "Places"}',
  generator: '{"generator": "town|npc|tavern|shop|...", "fields": [{"name": "...", "hint": "..."}], "sections": ["..."], "instructions": "...", "folder": "..."}',
  macro: '{"prompt": "what the assistant does, with {{param}} placeholders", "params": [{"name": "param", "label": "...", "default": ""}], "mode": "propose|do", "tools": "comma,separated,tool,names"}',
  assist: '{"layout": "one|cols|rows|grid|side", "panes": ["library", "assistant"], "prompt": "what to ask the assistant"}',
  shop: '{"shopType": "...", "guide": "how shops like this are stocked and run", "stock": ["..."], "priceNotes": "..."}',
  library: '{"folder": "...", "titlePattern": "{name}", "sections": ["..."], "tags": ["..."], "body": "the page skeleton in Markdown"}',
  event: '{"places": ["town|city|village|market|tavern|road|woods|cave|dungeon|ruins|coast|mountains|swamp"], "theme": "...", "instructions": "how these quick events go", "tone": "...", "choices": 3, "checks": true, "maxRewardCp": 100, "consequences": "how the GM notes what a choice leads to"}',
  spell: '{"minLevel": 0, "maxLevel": 3, "schools": ["Evocation"], "classes": ["Wizard"], "lines": ["Fire"], "balance": "how strong a spell of each level is", "mana": "a mana cost note", "naming": "...", "instructions": "...", "higherLevels": true}',
};

const SYSTEM = (kind: Kind) => [
  `You draft a GM template for the tabletop campaign app Alexandria: a ${KIND_LABEL[kind]}.`,
  'Use the GM\'s own words where you can and never invent campaign facts. Steps are things the assistant does before it writes; web steps search only for the real-world reference, never for the GM\'s own names.',
  'Return one JSON object: {"name": "...", "description": "one sentence", "triggers": ["words in a request that call for it"], "spec": ' + SPEC_SHAPE[kind] + ', "questions": ["up to 3 short questions about what is still unclear"]}.',
].join('\n');

/** Draft a template from the GM's description (and their answers to earlier questions). */
export async function draftTemplate(d: Deps, kind: Kind, description: string, answers: { q: string; a: string }[] = [], current?: TemplateInput | null): Promise<Draft> {
  const base = heuristicDraft(kind, [description, ...answers.map((x) => x.a)].join('\n'));
  if (current) base.template = { ...base.template, ...current, spec: cleanSpec(kind, { ...base.template.spec, ...(current.spec as object) }) };
  // Answered questions are not asked again.
  base.questions = base.questions.filter((q) => !answers.some((a) => a.q === q && a.a.trim()));
  if (!hasJob(d, 'chat')) return base;
  const msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM(kind) },
    { role: 'user', content: `The GM wants:\n${description.slice(0, 4000)}${answers.length ? `\n\nTheir answers:\n${answers.map((x) => `- ${x.q} ${x.a}`).join('\n').slice(0, 3000)}` : ''}\n\nStarting draft:\n${JSON.stringify({ name: base.template.name, triggers: base.template.triggers, spec: base.template.spec }).slice(0, 4000)}` },
  ];
  const j: any = await chatJson(d, 'chat', msgs).catch(() => null);
  if (!j || typeof j !== 'object') return base;
  const t = base.template;
  const spec = j.spec && typeof j.spec === 'object' ? cleanSpec(kind, mergeSpec(kind, t.spec, j.spec)) : t.spec;
  const triggers = Array.isArray(j.triggers) && j.triggers.some((x: unknown) => typeof x === 'string' && x.trim()) ? [...new Set([...j.triggers.map((x: unknown) => String(x).toLowerCase().trim()).filter(Boolean), ...t.triggers])].slice(0, 20) : t.triggers;
  return {
    template: { ...t, name: typeof j.name === 'string' && j.name.trim() && !current ? j.name.trim().slice(0, 80) : t.name, description: typeof j.description === 'string' && j.description.trim() ? j.description.trim().slice(0, 500) : t.description, triggers, spec },
    questions: Array.isArray(j.questions) && j.questions.length ? j.questions.map((q: unknown) => String(q).slice(0, 200)).filter(Boolean).slice(0, 3) : base.questions,
    notes: [], usedModel: true,
  };
}

/** The model's spec over the rules' one: lists the model left empty keep the rules' entries. */
function mergeSpec(kind: Kind, base: Spec, add: any): any {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(add ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = v;
  }
  if (kind === 'guide' && Array.isArray(add?.steps)) {
    const steps = add.steps.map(cleanStep).filter(Boolean) as Step[];
    // A web step the model dropped stays: the GM asked for research.
    for (const s of (base as any).steps as Step[]) if (s.kind === 'web' && !steps.some((x) => x.kind === 'web')) steps.splice(Math.min(steps.length, 2), 0, s);
    out.steps = steps.length ? steps : (base as any).steps;
  }
  return out;
}

// ---- a guide from example pages ----

const norm = (h: string) => h.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
export interface ExamplePage { id: string; title: string; path: string; body: string; tags: string[]; kind?: string | null }

/** The structure several pages share: headings most of them have (in their usual order), tags, folder and habits. */
export function commonStructure(pages: ExamplePage[]) {
  const n = pages.length;
  const need = Math.max(1, Math.ceil(n / 2));
  const seen = new Map<string, { label: Map<string, number>; pos: number[]; pages: Set<string> }>();
  for (const p of pages) {
    const heads = [...p.body.matchAll(/^#{2,3}\s+(.+?)\s*#*$/gm)].map((m) => m[1].trim()).filter((h) => norm(h));
    heads.forEach((h, i) => {
      const k = norm(h);
      const e = seen.get(k) ?? { label: new Map<string, number>(), pos: [] as number[], pages: new Set<string>() };
      e.label.set(h, (e.label.get(h) ?? 0) + 1);
      e.pos.push(heads.length > 1 ? i / (heads.length - 1) : 0);
      e.pages.add(p.id);
      seen.set(k, e);
    });
  }
  const sections = [...seen.values()].filter((e) => e.pages.size >= need)
    .map((e) => ({ label: [...e.label.entries()].sort((a, b) => b[1] - a[1])[0][0], at: e.pos.reduce((a, b) => a + b, 0) / e.pos.length }))
    .sort((a, b) => a.at - b.at).map((e) => e.label);
  const tagCount = new Map<string, number>();
  for (const p of pages) for (const t of new Set(p.tags.map((x) => x.toLowerCase()))) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const tags = [...tagCount.entries()].filter(([, c]) => c >= need).map(([t]) => t);
  const dirs = pages.map((p) => p.path.split('/').slice(0, -1));
  const folder: string[] = [];
  for (let i = 0; dirs.length && i < dirs[0].length; i++) { if (dirs.every((x) => x[i] === dirs[0][i])) folder.push(dirs[0][i]); else break; }
  const count = (re: RegExp) => pages.filter((p) => re.test(p.body)).length;
  const words = Math.round(pages.reduce((a, p) => a + (p.body.match(/\S+/g)?.length ?? 0), 0) / Math.max(1, n));
  return { sections, tags, folder: folder.join('/'), secrets: count(/^>\s*\[!secret\]/im) >= need, links: count(/\[\[[^\]]+\]\]/) >= need, words };
}

/** Read the pages as the assistant may (the AI copy: never classified) and derive a guide from them. */
export async function deriveGuide(d: Deps, worldId: string, viewer: Viewer, pageIds: string[], name = ''): Promise<Draft & { skipped: string[] }> {
  const ai: Viewer = { ...viewer, audience: 'ai' } as Viewer;
  const pages: ExamplePage[] = [];
  const skipped: string[] = [];
  for (const pid of [...new Set(pageIds)].slice(0, 8)) {
    try {
      const p: any = d.library.get(worldId, pid, ai);
      pages.push({ id: p.id, title: p.title, path: p.path, body: String(p.body ?? ''), tags: Array.isArray(p.tags) ? p.tags : [], kind: p.kind });
    } catch { skipped.push(pid); }
  }
  if (!pages.length) {
    const { HttpError } = await import('../../core/util.ts');
    throw new HttpError(400, 'None of those pages can be read by the assistant (a classified page never is). Pick other examples.');
  }
  const st = commonStructure(pages);
  const hay = [st.tags.join(' '), st.folder, ...pages.map((p) => `${p.title} ${p.kind ?? ''}`)].join(' ');
  const task = taskFor(`${st.tags.join(' ')} ${st.folder}`) !== GENERIC ? taskFor(`${st.tags.join(' ')} ${st.folder}`) : taskFor(hay);
  const noun = task.noun;
  const steps: Step[] = [
    { kind: 'library', text: `Search the world library for lore about the ${noun} and the region it is in.` },
    ...(st.links || noun === 'town' ? [{ kind: 'neighbours' as const, text: `Find the neighbouring places it links to (location links, relations, the map) and keep it consistent with them.` }] : []),
    { kind: 'exemplars', text: `Read the example pages (${pages.map((p) => p.title).join(', ')}) and follow their structure.` },
    { kind: 'instruction', text: `Use the sections below in this order${st.secrets ? '; GM-only details go in a > [!secret] block' : ''}${st.links ? '; link places and people with [[wikilinks]]' : ''}; about ${Math.max(100, Math.round(st.words / 50) * 50)} words.` },
  ];
  const triggers = [...new Set([...st.tags.filter((t) => task.triggers.includes(t)), ...task.triggers])].slice(0, 8);
  const notes = [`Derived from ${pages.length} page${pages.length === 1 ? '' : 's'}: ${pages.map((p) => p.title).join(', ')}.`, `Sections most of them share: ${st.sections.length ? st.sections.join(' · ') : 'none (no common headings)'}.`];
  if (skipped.length) notes.push(`Left out ${skipped.length} page${skipped.length === 1 ? '' : 's'} the assistant may not read.`);
  let tone = '';
  let instructions = `Follow the structure of ${pages.map((p) => p.title).join(', ')}.`;
  let usedModel = false;
  if (hasJob(d, 'chat')) {
    const outline = pages.map((p) => `Page: ${p.title}\nHeadings: ${[...p.body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1]).join(' | ')}\nStarts: ${p.body.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n\n');
    const j: any = await chatJson(d, 'chat', [
      { role: 'system', content: 'You derive a writing guide from example pages of a tabletop campaign wiki. Describe how the pages are written, not what they say. Return JSON: {"instructions": "2-4 sentences on how a new page of this kind is written", "tone": "one sentence on voice and tone"}.' },
      { role: 'user', content: outline.slice(0, 6000) },
    ]).catch(() => null);
    if (j && typeof j === 'object') {
      if (typeof j.instructions === 'string' && j.instructions.trim()) { instructions = j.instructions.trim(); usedModel = true; }
      if (typeof j.tone === 'string' && j.tone.trim()) { tone = j.tone.trim(); usedModel = true; }
    }
  }
  const spec = cleanSpec('guide', { task: `Make a ${noun}`, instructions, steps, sections: st.sections.length ? st.sections : task.sections, tone, folder: st.folder || task.folder, exemplars: pages.map((p) => p.id), always: false });
  return {
    template: { kind: 'guide', name: (name.trim() || task.name || (st.folder.split('/').pop() ?? '') || 'Pages like these').slice(0, 80), description: `How ${noun === 'page' ? 'these pages are' : `${noun} pages are`} written in this world, from ${pages.length} example${pages.length === 1 ? '' : 's'}.`, triggers, enabled: true, spec },
    questions: [], notes, usedModel, skipped,
  };
}
