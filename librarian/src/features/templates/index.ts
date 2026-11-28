// Templates & guides (GM only): the GM's reusable templates, made with the assistant. Six kinds: agent guides (how the
// assistant does a kind of task: research steps, sources, sections, tone, exemplar pages), generator templates, macro
// templates, assist panel templates, shop generation templates and library page templates. Versioned, per world,
// each on or off. Guides are used by the assistant on their own when a request matches (guides.ts), and web research
// (web.ts) is the GM's opt-in, off by default. See docs/TEMPLATES.md.
//
//   GET/POST /templates, GET/PUT/DELETE /templates/:id, POST /templates/:id/restore
//   POST /templates/draft      the assistant drafts a template from the GM's description (and asks a few questions)
//   POST /templates/derive     a guide from example library pages (their common structure)
//   GET/PUT /templates/web, POST /templates/web/check, POST /templates/web/search
//   POST /templates/:id/shop   a shop draft from the shop generator, with this template's guide
//   GET /templates/starters, POST /templates/starters/add { pack, names? }   the starter templates (starters.ts)
//   GET /templates/export?ids=a,b&kind=k   a package (.alxtemplates.json); POST /templates/import { file }  (share.ts)
//   MCP  list_gm_templates, get_gm_template, create_gm_template, update_gm_template, web_research
import { Router } from 'express';
import type { Feature, McpTool } from '../types.ts';
import type { Deps } from '../../app.ts';
import { requireGM } from '../../core/auth.ts';
import { hasJob, wouldBeRefused } from '../../core/ai.ts';
import { run } from '../../core/db.ts';
import { HttpError, now, oneOf, str } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { cleanTemplate, guideText, KIND_LABEL, KINDS, templateText, type Kind, type TemplateInput } from './spec.ts';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, SCHEMA, setWebConfig, templateVersions, updateTemplate, webConfig } from './store.ts';
import { deriveGuide, draftTemplate } from './draft.ts';
import { blockedQuery, blockedText, cleanQueries, webSearch } from './web.ts';
import { generateShopWithTemplate } from './shop.ts';
import { draftSpell } from './spell.ts';
import { importTemplates, makePackage, readPackage } from './share.ts';
import { starterPacks } from './starters.ts';
import { VERSION } from '../../version.ts';

const audit = (d: Deps, worldId: string, accountId: string | null, action: string, detail = '') =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

/** A template's words go into model requests later, so one that repeats classified text is refused here. */
function refuseClassified(d: Deps, worldId: string, t: TemplateInput) {
  for (const s of templateText(t)) if (d.library.containsClassified(worldId, s) || wouldBeRefused(d, s)) throw new HttpError(400, 'This template repeats classified text, which never goes to the assistant. Take it out and save again.');
}

const brief = (t: ReturnType<typeof listTemplates>[number]) => ({ id: t.id, kind: t.kind, name: t.name, description: t.description, triggers: t.triggers, enabled: t.enabled, version: t.version, updatedAt: t.updatedAt });

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  r.use(requireGM);
  const W = (res: any): string => ctx(res).world.id;
  const found = (res: any, tid: string) => { const t = getTemplate(d.db, W(res), tid); if (!t) throw new HttpError(404, 'Template not found'); return t; };

  r.get('/', (req, res) => {
    const kind = typeof req.query.kind === 'string' && (KINDS as readonly string[]).includes(req.query.kind) ? req.query.kind as Kind : undefined;
    res.json({ templates: listTemplates(d.db, W(res), kind), kinds: KINDS.map((k) => ({ id: k, label: KIND_LABEL[k] })), model: hasJob(d, 'chat') });
  });
  // ---- web research (before /:id) ----
  r.get('/web', async (_req, res) => {
    let providers: { id: string; name: string }[] = [];
    try {
      const { listProviders } = await import('../models/providers.ts');
      providers = listProviders(d.db).filter((p) => /openrouter\.ai/i.test(p.base_url)).map((p) => ({ id: p.id, name: p.name }));
    } catch { /* no models feature */ }
    res.json({ config: webConfig(d.db, W(res)), providers, shop: true });
  });
  r.put('/web', (req, res) => {
    const before = webConfig(d.db, W(res));
    const cfg = setWebConfig(d.db, W(res), req.body ?? {});
    if (before.enabled !== cfg.enabled || before.provider !== cfg.provider) audit(d, W(res), me(res), 'templates.web_settings', `web research ${cfg.enabled ? 'on' : 'off'} (${cfg.provider})`);
    res.json({ config: cfg });
  });
  r.post('/web/check', (req, res) => {
    const queries = cleanQueries(req.body?.queries ?? req.body?.query);
    const b = blockedQuery(d, W(res), queries);
    res.json({ ok: !b, ...(b ? { reason: blockedText(b), level: b.level } : {}) });
  });
  r.post('/web/search', async (req, res) => {
    const queries = cleanQueries(req.body?.queries ?? req.body?.query);
    res.json(await webSearch(d, W(res), queries, me(res)));
  });

  // ---- made with the assistant ----
  r.post('/draft', async (req, res) => {
    const kind = oneOf(req.body?.kind, 'kind', KINDS);
    const description = str(req.body?.description, 'description', { max: 6000 }).trim();
    if (!description) throw new HttpError(400, 'Say what the template is for');
    const answers = (Array.isArray(req.body?.answers) ? req.body.answers : []).slice(0, 10)
      .map((a: any) => ({ q: String(a?.q ?? '').slice(0, 300), a: String(a?.a ?? '').slice(0, 1000) })).filter((a: { a: string }) => a.a.trim());
    let current: TemplateInput | null = null;
    if (req.body?.current) { try { current = cleanTemplate({ ...req.body.current, kind }); } catch { current = null; } }
    const draft = await draftTemplate(d, kind, description, answers, current);
    res.json(draft);
  });
  r.post('/derive', async (req, res) => {
    const ids = (Array.isArray(req.body?.pageIds) ? req.body.pageIds : []).filter((x: unknown) => typeof x === 'string').slice(0, 8);
    if (!ids.length) throw new HttpError(400, 'Pick one or more example pages');
    res.json(await deriveGuide(d, W(res), ctx(res).viewer, ids, typeof req.body?.name === 'string' ? req.body.name.slice(0, 80) : ''));
  });

  // ---- starter templates that ship in templates/ (before /:id) ----
  r.get('/starters', (_req, res) => {
    const have = new Set(listTemplates(d.db, W(res)).map((t) => `${t.kind}:${t.name.toLowerCase()}`));
    res.json({ packs: starterPacks().map((p) => ({ id: p.id, name: p.name, templates: p.templates.map((t) => ({ kind: t.kind, name: t.name, description: t.description, added: have.has(`${t.kind}:${t.name.toLowerCase()}`) })) })) });
  });
  r.post('/starters/add', (req, res) => {
    const pack = starterPacks().find((p) => p.id === req.body?.pack);
    if (!pack) throw new HttpError(404, 'No such starter pack');
    const names = Array.isArray(req.body?.names) ? new Set(req.body.names.map((n: unknown) => String(n).toLowerCase())) : null;
    const picked = pack.templates.filter((t) => !names || names.has(t.name.toLowerCase()));
    if (!picked.length) throw new HttpError(404, 'None of those templates are in the pack');
    // One the world already has (perhaps changed by the GM) is left alone.
    const have = new Set(listTemplates(d.db, W(res)).map((t) => `${t.kind}:${t.name.toLowerCase()}`));
    const list = picked.filter((t) => !have.has(`${t.kind}:${t.name.toLowerCase()}`));
    const out = list.length ? importTemplates(d.db, W(res), list, me(res), (t) => refuseClassified(d, W(res), t)) : { created: [], updated: [], unchanged: [] };
    out.unchanged.push(...picked.filter((t) => !list.includes(t)).map((t) => t.name));
    audit(d, W(res), me(res), 'templates.starters', `${pack.id}: ${[...out.created, ...out.updated].join(', ')}`);
    res.json(out);
  });

  // ---- sharing: a package file to take to another world or table (before /:id) ----
  r.get('/export', (req, res) => {
    const ids = typeof req.query.ids === 'string' && req.query.ids ? req.query.ids.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 300) : null;
    const kind = typeof req.query.kind === 'string' && (KINDS as readonly string[]).includes(req.query.kind) ? req.query.kind as Kind : undefined;
    const list = ids ? ids.map((x) => found(res, x)) : listTemplates(d.db, W(res), kind);
    if (!list.length) throw new HttpError(404, 'There are no templates to export');
    res.json(makePackage(list, { alexandria: VERSION, name: typeof req.query.name === 'string' ? req.query.name.slice(0, 80) : '' }));
  });
  r.post('/import', (req, res) => {
    const list = readPackage(req.body?.file ?? req.body);
    if (req.body?.check === true) { for (const t of list) refuseClassified(d, W(res), t); res.json({ ok: true, templates: list.map((t) => ({ kind: t.kind, name: t.name, description: t.description })) }); return; }
    const out = importTemplates(d.db, W(res), list, me(res), (t) => refuseClassified(d, W(res), t));
    audit(d, W(res), me(res), 'templates.import', `${out.created.length} new, ${out.updated.length} updated: ${[...out.created, ...out.updated].join(', ')}`);
    res.json(out);
  });

  // ---- the templates ----
  r.post('/', (req, res) => {
    const t = cleanTemplate(req.body);
    refuseClassified(d, W(res), t);
    const made = createTemplate(d.db, W(res), t, me(res));
    audit(d, W(res), me(res), 'templates.create', `${made.kind} ${made.name}`);
    res.status(201).json(made);
  });
  r.get('/:id', (req, res) => {
    const t = found(res, String(req.params.id));
    res.json({ ...t, versions: templateVersions(d.db, t.id) });
  });
  r.put('/:id', (req, res) => {
    const cur = found(res, String(req.params.id));
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // A spec with only some keys changes only those.
    const t = cleanTemplate({ ...body, kind: cur.kind, spec: body.spec && typeof body.spec === 'object' ? { ...cur.spec, ...body.spec } : cur.spec }, cur);
    refuseClassified(d, W(res), t);
    const next = updateTemplate(d.db, W(res), cur.id, t, me(res));
    audit(d, W(res), me(res), 'templates.update', `${next.kind} ${next.name} v${next.version}`);
    res.json(next);
  });
  r.post('/:id/restore', (req, res) => {
    const cur = found(res, String(req.params.id));
    const v = templateVersions(d.db, cur.id).find((x) => x.version === Number(req.body?.version));
    if (!v) throw new HttpError(404, 'That version is not kept');
    const t = cleanTemplate({ ...v.template, kind: cur.kind, enabled: cur.enabled }, cur);
    refuseClassified(d, W(res), t);
    res.json(updateTemplate(d.db, W(res), cur.id, t, me(res)));
  });
  r.delete('/:id', (req, res) => {
    const cur = found(res, String(req.params.id));
    deleteTemplate(d.db, W(res), cur.id);
    audit(d, W(res), me(res), 'templates.delete', `${cur.kind} ${cur.name}`);
    res.json({ ok: true });
  });
  // A quick event drafted with this template's guide (nothing saved: the GM saves it on the Encounters page).
  r.post('/:id/event', async (req, res) => {
    const cur = found(res, String(req.params.id));
    if (cur.kind !== 'event') throw new HttpError(400, 'Only a quick event template makes quick events');
    const prompt = (typeof req.body?.prompt === 'string' ? req.body.prompt.trim().slice(0, 3000) : '') || (cur.spec as any).theme || cur.name;
    const { draftEncounter } = await import('../encounters/draft.ts');
    const { cleanPlaces } = await import('../encounters/script.ts');
    const draft = await draftEncounter(d, prompt, ctx(res).world.name, { kind: 'event', guide: guideText(cur), places: cleanPlaces((cur.spec as any).places) });
    res.json({ draft });
  });
  // A new spell drafted with this template (nothing saved: the GM saves it to the Codex).
  r.post('/:id/spell', async (req, res) => {
    const cur = found(res, String(req.params.id));
    if (cur.kind !== 'spell') throw new HttpError(400, 'Only a spell template makes spells');
    const prompt = str(req.body?.prompt, 'prompt', { max: 3000 }).trim();
    if (!prompt) throw new HttpError(400, 'Describe the spell first');
    res.json({ draft: await draftSpell(d, cur, prompt, ctx(res).world.name) });
  });
  r.post('/:id/shop', async (req, res) => {
    const cur = found(res, String(req.params.id));
    if (cur.kind !== 'shop') throw new HttpError(400, 'Only a shop generation template makes shops');
    const o = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
    const draft = await generateShopWithTemplate(d, W(res), cur, o);
    audit(d, W(res), me(res), 'templates.shop', `${cur.name}: ${draft.name}`);
    res.json({ draft });
  });
  return r;
}

const S = (description: string) => ({ type: 'string', description });
const enc = encodeURIComponent;

const tools: McpTool[] = [
  {
    name: 'list_gm_templates', gmOnly: true,
    description: "GM: the GM's templates and guides in this world (agent guides for a kind of task such as towns, generator, macro, assist panel, shop, library page, quick event and spell templates): id, kind, name, triggers, on or off, version.",
    props: { kind: { type: 'string', enum: [...KINDS], description: 'Only this kind' } },
    call: (a) => ({ method: 'GET', path: `/templates${a?.kind ? `?kind=${enc(a.kind)}` : ''}` }),
  },
  {
    name: 'get_gm_template', gmOnly: true,
    description: 'GM: one template or guide in full (its steps, sections, tone, exemplar pages, triggers) and its earlier versions. Give its id or its name.',
    props: { id: S('Template id or name') }, required: ['id'],
    call: (a) => ({ method: 'GET', path: `/templates/${enc(String(a.id ?? ''))}` }),
  },
  {
    name: 'create_gm_template', write: true,
    description: 'GM: save a new template or guide. kind guide: spec {task, instructions, steps: [{kind: library|neighbours|exemplars|web|instruction, text, query}], sections: [...], tone, folder, exemplars: [page ids]}; a web step query may use {reference} for the real-world place a request names. kind event (quick events): spec {places: [town|city|village|market|tavern|road|woods|cave|dungeon|ruins|coast|mountains|swamp], theme, instructions, tone, choices: 2-4, checks: true|false, maxRewardCp, consequences}. kind spell: spec {minLevel, maxLevel, schools, classes, lines (spell line names), balance, mana, naming, instructions, higherLevels}. triggers: words in a request that call for it (town, village, city).',
    props: {
      kind: { type: 'string', enum: [...KINDS], description: 'guide, generator, macro, assist, shop, library, event or spell' },
      name: S('Short name, e.g. Towns'), description: S('One sentence: what it is for'),
      triggers: { type: 'array', items: { type: 'string' }, description: 'Words that call for it' },
      spec: { type: 'object', description: 'The kind-specific content (see the description)' },
      enabled: { type: 'boolean' },
    },
    required: ['kind', 'name'],
    call: (a) => ({ method: 'POST', path: '/templates', body: { kind: a.kind, name: a.name, description: a.description, triggers: a.triggers, spec: a.spec, enabled: a.enabled } }),
  },
  {
    name: 'update_gm_template', write: true,
    description: 'GM: change a template or guide (a new version; the old one is kept). Give its id or name and only what changes: name, description, triggers, enabled, spec (the whole spec).',
    props: { id: S('Template id or name'), name: S('New name'), description: S('New description'), triggers: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, spec: { type: 'object' } },
    required: ['id'],
    call: (a) => ({ method: 'PUT', path: `/templates/${enc(String(a.id ?? ''))}`, body: { name: a.name, description: a.description, triggers: a.triggers, enabled: a.enabled, spec: a.spec } }),
  },
  {
    name: 'save_homebrew_spell', write: true,
    description: "GM: save a new spell to the world's Codex as homebrew (GM-only until the GM makes it public). Follow the GM's spell template when one matches. Fields as in read_spell: name, level 0-9, school, classes, castingTime, ritual, range, components (\"V, S, M (a feather)\"), duration, concentration, damageTypes, saves, attack, text (Markdown, ending with higher levels). lines: spell line names it belongs to (noted for the GM).",
    props: {
      name: S('Spell name'), level: { type: 'integer', description: '0 for a cantrip, up to 9' }, school: S('e.g. Evocation'), classes: { type: 'array', items: { type: 'string' } },
      castingTime: S('e.g. 1 action'), ritual: { type: 'boolean' }, range: S('e.g. 60 feet'), components: S('e.g. V, S, M (a pinch of soot)'), duration: S('e.g. Instantaneous'),
      concentration: { type: 'boolean' }, damageTypes: { type: 'array', items: { type: 'string' } }, saves: { type: 'array', items: { type: 'string' } }, attack: { type: 'string', enum: ['', 'melee', 'ranged'] },
      text: S('What the spell does, in Markdown'), lines: { type: 'array', items: { type: 'string' }, description: 'Spell lines (Fire, Frost ...)' }, gmNotes: S('Notes for the GM only'),
    },
    required: ['name', 'level', 'text'],
    call: (a) => {
      const notes = [typeof a.gmNotes === 'string' ? a.gmNotes : '', Array.isArray(a.lines) && a.lines.length ? `Spell lines: ${a.lines.map(String).join(', ')}` : ''].filter(Boolean).join('\n');
      return { method: 'POST', path: '/spells/s', body: { name: a.name, level: a.level, school: a.school, classes: a.classes, castingTime: a.castingTime, ritual: a.ritual, range: a.range, components: a.components, duration: a.duration, concentration: a.concentration, damageTypes: a.damageTypes, saves: a.saves, attack: a.attack, text: a.text, source: 'Homebrew', ...(notes ? { gmNotes: notes } : {}) } };
    },
  },
  {
    name: 'web_research', write: true,
    description: 'GM: search the web for a REAL-WORLD reference (a real town, a historical period, a real craft) to ground a draft. Only the query words leave Alexandria: never put names or facts from this world in a query (such a query is refused). Off unless the GM turned web research on. Results feed the draft; cite them as sources.',
    props: { queries: { type: 'array', items: { type: 'string' }, description: 'One to three short searches' }, purpose: S('What the results are for'), guide: S('The guide id this research is for') },
    required: ['queries'],
    call: (a) => ({ method: 'POST', path: '/templates/web/search', body: { queries: a.queries ?? a.query, purpose: a.purpose, guide: a.guide } }),
  },
];

const feature: Feature = {
  id: 'templates',
  schema: SCHEMA,
  worldMount: 'templates',
  worldRoutes: routes,
  mcpTools: tools,
};
export default feature;
