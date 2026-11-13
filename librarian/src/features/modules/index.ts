// Game modules: rules and term glossaries (spells, conditions, monsters,
// rules...). Two come with the app (SRD 5.2 and SRD 5.1); a DM can import
// more. See docs/MODULES.md.
import express, { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { run } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { HttpError, now, str } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import { summarize, preview } from './format.ts';
import { readModule } from './importers.ts';
import { findMatches } from './match.ts';
import { searchRules, searchTerms } from './search.ts';
import { SCHEMA, available, moduleDoc, removeImported, saveImported, setEnabled, worldModules } from './store.ts';

// (app.ts imports the feature registry, so features write the audit row themselves.)
const audit = (db: any, worldId: string, accountId: string, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const intQ = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const W = (res: any): string => ctx(res).world.id;

  // The enabled modules in order (earlier wins on a clash), and every module that could be enabled.
  r.get('/', (_req, res) => {
    const w = worldModules(d.db, W(res));
    res.json({ modules: w.enabled, available: available(d.db, W(res)), termCount: w.terms.length });
  });

  r.put('/enabled', requireDM, (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 50) throw new HttpError(400, 'ids must be a list of module ids, in order');
    setEnabled(d.db, W(res), ids as string[]);
    audit(d.db, W(res), me(res), 'modules.enable', (ids as string[]).join(','));
    d.hub.emit(W(res), 'modules', {}, () => true);
    res.json({ modules: worldModules(d.db, W(res)).enabled });
  });

  r.delete('/imported/:id', requireDM, (req, res) => {
    removeImported(d.db, W(res), String(req.params.id));
    audit(d.db, W(res), me(res), 'modules.remove', String(req.params.id));
    d.hub.emit(W(res), 'modules', {}, () => true);
    res.json({ ok: true });
  });

  // ---- lookups: open to every member of the world ----
  r.get('/terms', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
    const out = searchTerms(d.db, W(res), q, {
      kind: typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined,
      module: typeof req.query.module === 'string' && req.query.module ? req.query.module : undefined,
      limit: intQ(req.query.limit, 50),
      offset: intQ(req.query.offset, 0),
    });
    res.json(out);
  });

  r.get('/terms/:id', (req, res) => {
    const t = worldModules(d.db, W(res)).byRef.get(String(req.params.id));
    if (!t) throw new HttpError(404, 'Term not found');
    const m = worldModules(d.db, W(res)).enabled.find((x) => x.id === t.moduleId);
    res.json({ id: t.ref, moduleId: t.moduleId, module: t.moduleName, term: t.term, aliases: t.aliases, kind: t.kind, summary: t.summary, text: t.text, data: t.data ?? null, license: m?.license ?? '', attribution: m?.attribution ?? '' });
  });

  r.get('/rules/search', (req, res) => {
    const q = str(req.query.q, 'q', { max: 300 });
    res.json({ query: q, results: searchRules(d.db, W(res), q, intQ(req.query.limit, 5)) });
  });

  // The highlighting contract: text in, matches out. Library titles are
  // matched only for pages this viewer can open.
  r.post('/match', (req, res) => {
    const text = str(req.body?.text, 'text', { max: 200_000, optional: true });
    res.json(findMatches(d.db, W(res), ctx(res).viewer, text));
  });

  r.get('/card/:source/:id', (req, res) => {
    const source = String(req.params.source);
    const id = String(req.params.id);
    if (source === 'module') {
      const w = worldModules(d.db, W(res));
      const t = w.byRef.get(id);
      if (!t) throw new HttpError(404, 'Term not found');
      const m = w.enabled.find((x) => x.id === t.moduleId);
      return res.json({ source, id: t.ref, title: t.term, kind: t.kind, summary: t.summary, text: t.text, data: t.data ?? null, module: t.moduleName, attribution: m?.attribution ?? '' });
    }
    if (source === 'library') {
      // L.get serves players only the player copy, and 404s on anything else.
      const pg: any = d.library.get(W(res), id, ctx(res).viewer);
      const body = String(pg.body ?? '');
      return res.json({ source, id: pg.id, title: pg.title, kind: pg.kind, summary: summarize(body, 300), text: body.length > 3000 ? body.slice(0, 3000) + '…' : body, tags: pg.tags ?? [], icon: pg.icon ?? null });
    }
    throw new HttpError(404, 'Unknown card source');
  });

  // ---- import (DM): always preview, then save ----
  const raw = express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: '16mb' });
  const body = (req: any): { b: any; zip?: Buffer } => {
    if (Buffer.isBuffer(req.body)) {
      const q = req.query;
      const module: Record<string, string> = {};
      for (const k of ['id', 'name', 'version', 'license', 'attribution']) if (typeof q[k] === 'string') module[k] = q[k];
      return { b: { module, replace: q.replace === '1', enable: q.enable !== '0' }, zip: req.body };
    }
    return { b: req.body ?? {} };
  };

  r.post('/import/preview', requireDM, raw, async (req, res) => {
    const { b, zip } = body(req);
    const m = await readModule(b, d, zip);
    const p = preview(m.module, m.warnings);
    const exists = available(d.db, W(res)).some((x) => x.id === m.module.id && !x.builtin);
    const reserved = available(d.db, W(res)).some((x) => x.id === m.module.id && x.builtin);
    res.json({ ...p, exists, reserved });
  });

  r.post('/import', requireDM, raw, async (req, res) => {
    const { b, zip } = body(req);
    const m = await readModule(b, d, zip);
    saveImported(d.db, W(res), m.module, m.source, b.replace === true, b.enable !== false);
    audit(d.db, W(res), me(res), 'modules.import', `${m.module.id} ${m.module.terms.length} terms`);
    d.hub.emit(W(res), 'modules', {}, () => true);
    res.json({ ...preview(m.module, m.warnings), saved: true, modules: worldModules(d.db, W(res)).enabled });
  });

  void moduleDoc;
  return r;
}

const feature: Feature = {
  id: 'modules',
  schema: SCHEMA,
  worldMount: 'modules',
  worldRoutes: routes,
  mcpTools: [
    {
      name: 'lookup_rule',
      description: "Look up a rule in the world's game module (e.g. 'how does grappling work', 'cover', 'death saves'). Returns ranked passages with citations. Use this instead of answering rules questions from memory.",
      props: { query: { type: 'string', description: 'The rules question or topic' }, limit: { type: 'number', description: 'How many passages (default 5, at most 20)' } },
      required: ['query'],
      call: (a) => ({ method: 'GET', path: `/modules/rules/search?q=${encodeURIComponent(a.query)}&limit=${encodeURIComponent(String(a.limit ?? 5))}` }),
    },
    {
      name: 'lookup_term',
      description: "Look up a spell, condition, monster, item or other term by name in the world's game module. Returns matches; use the id with read_term for the full text and structured data.",
      props: { term: { type: 'string', description: 'The name to look up' }, kind: { type: 'string', enum: ['spell', 'condition', 'monster', 'rule', 'item', 'action', 'class', 'other'] } },
      required: ['term'],
      call: (a) => ({ method: 'GET', path: `/modules/terms?q=${encodeURIComponent(a.term)}${a.kind ? `&kind=${encodeURIComponent(a.kind)}` : ''}&limit=10` }),
    },
    {
      name: 'read_term',
      description: 'Read one game module term in full (Markdown text and structured data such as a monster statblock) by the id lookup_term returned.',
      props: { id: { type: 'string', description: 'Term id, like dnd-2024:spell-fireball' } },
      required: ['id'],
      call: (a) => ({ method: 'GET', path: `/modules/terms/${encodeURIComponent(a.id)}` }),
    },
  ],
};
export default feature;
