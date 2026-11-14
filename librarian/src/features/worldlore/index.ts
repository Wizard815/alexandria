// WorldLore: one part of a world's source (a LegendKeeper folder or resource,
// a Markdown folder) or of the library is the AI's own wiki. The agent reads,
// writes, moves and deletes there with no confirmation. Everywhere else the
// sources stay read-only and library writes still wait for the DM.
//
// The DM sets it in World settings (PUT /worldlore/config), which also adds
// the lore tools to the world's agentAutoApprove list. Disabling removes them.
// Every write is checked against the workspace root (see service.ts and the
// connectors' write capability), re-synced, and audited.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Auth } from '../../core/auth.ts';
import { one } from '../../core/db.ts';
import { HttpError } from '../../core/util.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import {
  SCHEMA, configOf, deletePage, links, listPages, movePage, options, readPage, searchOptions, setConfig, validateConfig, workspace, worldSettings, writePage, type LoreConfig,
} from './service.ts';

const enc = encodeURIComponent;
const S = (description: string) => ({ type: 'string', description });
const LEVEL = { type: 'string', enum: ['dm', 'broker', 'party', 'classified'], description: "Who may learn it. dm: only the DM (default is the workspace's). broker: DM-only, but the information broker may sell it to players. classified: never sent to any AI, not even you. party: players see it (only allowed when the DM set the workspace to party)." };

const state = (d: any, worldId: string) => {
  const cfg = configOf(worldSettings(d, worldId));
  return { enabled: !!cfg, config: cfg, links: links(d, worldId) };
};

const feature: Feature = {
  id: 'worldlore',
  schema: SCHEMA,
  settings: {
    worldLore: {
      type: 'json', default: null,
      validate: (v) => validateConfig(v),
    },
  },
  worldMount: 'worldlore',
  worldRoutes: (d) => {
    const r = Router({ mergeParams: true });
    // Everything here is for the DM (and the DM's agent, which runs with the DM's own token).
    r.use((_req, res, next) => { if (!isDM(res)) throw new HttpError(403, 'Only the DM can use WorldLore'); next(); });

    r.get('/', (_req, res) => res.json(state(d, ctx(res).world.id)));
    r.get('/options', async (_req, res) => res.json(await options(d, ctx(res).world.id)));
    // Kanka has too many notes to list: search them by name (?source=<source id>&q=<text>).
    r.get('/options/search', async (req, res) => res.json(await searchOptions(d, ctx(res).world.id, String(req.query.source ?? ''), String(req.query.q ?? ''))));
    // Body: { kind, sourceId?, root, defaultLevel, url? }, or null / { enabled: false } to turn it off.
    r.put('/config', (req, res) => {
      const b = req.body ?? {};
      const next: LoreConfig | null = b.enabled === false || b.kind === undefined ? null : { kind: b.kind, sourceId: b.sourceId, root: String(b.root ?? ''), defaultLevel: b.defaultLevel ?? 'dm', ...(b.url ? { url: b.url } : {}) };
      setConfig(d, ctx(res).world.id, next, me(res));
      res.json(state(d, ctx(res).world.id));
    });

    r.get('/pages', (req, res) => res.json(listPages(d, ctx(res).world.id, { forAI: req.query.ai === '1' })));
    r.get('/pages/:id', (req, res) => res.json(readPage(d, ctx(res).world.id, { accountId: me(res), role: 'dm' }, String(req.params.id))));
    r.post('/pages', async (req, res) => {
      const b = req.body ?? {};
      res.status(200).json(await writePage(d, ctx(res).world.id, me(res), { id: b.id, path: b.path, title: b.title, markdown: b.markdown, level: b.level, parent: b.parent, by: b.by }));
    });
    r.post('/pages/:id/move', async (req, res) => res.json(await movePage(d, ctx(res).world.id, me(res), { id: String(req.params.id), to: req.body?.to ?? null, by: req.body?.by })));
    r.delete('/pages/:id', async (req, res) => res.json(await deletePage(d, ctx(res).world.id, me(res), { id: String(req.params.id), by: String(req.query.by ?? '') })));
    return r;
  },
  // Admins can set a world's workspace too.
  adminMount: 'worldlore',
  adminRoutes: (d) => {
    const r = Router();
    const world = (id: string) => { if (!one(d.db, 'SELECT 1 FROM worlds WHERE id = ?', id)) throw new HttpError(404, 'World not found'); return id; };
    r.get('/:world', (req, res) => res.json({ ...state(d, world(String(req.params.world))), options: undefined }));
    r.get('/:world/options', async (req, res) => res.json(await options(d, world(String(req.params.world)))));
    r.put('/:world/config', (req, res) => {
      const w = world(String(req.params.world));
      const b = req.body ?? {};
      const next: LoreConfig | null = b.enabled === false || b.kind === undefined ? null : { kind: b.kind, sourceId: b.sourceId, root: String(b.root ?? ''), defaultLevel: b.defaultLevel ?? 'dm', ...(b.url ? { url: b.url } : {}) };
      setConfig(d, w, next, (res.locals.auth as Auth).account.id);
      res.json(state(d, w));
    });
    return r;
  },
  mcpTools: [
    {
      name: 'lore_list',
      description: "Pages in WorldLore, your own wiki for this world: title, level, who wrote it. Use it to see what you have already written before writing more. Classified pages are not listed.",
      props: {},
      call: () => ({ method: 'GET', path: '/worldlore/pages?ai=1' }),
    },
    {
      name: 'lore_read',
      description: 'Read one WorldLore page by id (from lore_list).',
      props: { id: S('Page id') }, required: ['id'],
      call: (a) => ({ method: 'GET', path: `/worldlore/pages/${enc(a.id)}` }),
    },
    {
      name: 'lore_write', write: true,
      description: 'Write to WorldLore, your own wiki. It runs at once, with no confirmation, and only inside WorldLore. Give an id to change a page, or a path (folders separated by /) or title to make one. Keep facts only the information broker knows at level broker. Never use it to change anything outside WorldLore.',
      props: { id: S('Page id to change (omit to create)'), path: S('Where to create it, e.g. npcs/Odda'), title: S('Page title'), markdown: S('The whole page in Markdown (replaces the old text)'), level: LEVEL, parent: S('LegendKeeper and Kanka: parent page id inside WorldLore (omit for the top)') },
      required: ['markdown'],
      call: (a) => ({ method: 'POST', path: '/worldlore/pages', body: { id: a.id, path: a.path, title: a.title, markdown: a.markdown, level: a.level, parent: a.parent, by: 'agent' } }),
    },
    {
      name: 'lore_move', write: true,
      description: 'Move a WorldLore page. Runs at once, only inside WorldLore. `to` is a new parent page id (LegendKeeper, Kanka), or a new path (Markdown folder or library).',
      props: { id: S('Page id'), to: S('New parent id or new path') }, required: ['id', 'to'],
      call: (a) => ({ method: 'POST', path: `/worldlore/pages/${enc(a.id)}/move`, body: { to: a.to, by: 'agent' } }),
    },
    {
      name: 'lore_delete', write: true,
      description: 'Delete a WorldLore page. Runs at once, only inside WorldLore; LegendKeeper keeps it in its trash; Kanka does not.',
      props: { id: S('Page id') }, required: ['id'],
      call: (a) => ({ method: 'DELETE', path: `/worldlore/pages/${enc(a.id)}?by=agent` }),
    },
  ],
};

void workspace;
export default feature;
