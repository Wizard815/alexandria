// Game modules: rules and term glossaries (spells, conditions, monsters,
// rules...). Two come with the app (SRD 5.2 and SRD 5.1); a GM can import
// more. See docs/MODULES.md.
import express, { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { run } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { HttpError, now, str } from '../../core/util.ts';
import { ctx, isDM, me, settings } from '../../routes/_shared.ts';
import { playerCard } from './hide.ts';
import { summarize, preview } from './format.ts';
import { readModule } from './importers.ts';
import { findMatches } from './match.ts';
import { feedModule, readFeed } from './feed.ts';
import { DND5EAPI_BASE, open5eDocuments } from './sources.ts';
import { OPEN5E_BASE, OPEN5E_ENDPOINTS } from './open5e.ts';
import { searchRules, searchTerms } from './search.ts';
import { SCHEMA, available, leftOut, moduleDoc, setLeftOut, removeImported, saveImported, setEnabled, worldModules } from './store.ts';
import { featureSetting } from '../../core/policy.ts';

// (app.ts imports the feature registry, so features write the audit row themselves.)
const audit = (db: any, worldId: string, accountId: string, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const intQ = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

// Open5e and the 5e SRD API are a house rule (features/open5e): off, the world cannot pull from them.
const OPEN5E_OFF = 'Open5e is off in this world: the GM turns it on under House rules';
const open5eOn = (res: any) => featureSetting<boolean>(settings(res), 'open5e') === true;
const needOpen5e = (req: any, res: any, next: any) => (open5eOn(res) ? next() : next(new HttpError(403, OPEN5E_OFF)));

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
    // A player's monster summaries have no AC, HP or CR (unless the world shows monster health exactly).
    if (!isDM(res)) { const s = settings(res); res.json({ ...out, ...(Array.isArray((out as any).terms) ? { terms: (out as any).terms.map((t: any) => playerCard(t, s)) } : {}), ...(Array.isArray((out as any).results) ? { results: (out as any).results.map((t: any) => playerCard(t, s)) } : {}) }); return; }
    res.json(out);
  });

  r.get('/terms/:id', (req, res) => {
    const t = worldModules(d.db, W(res)).byRef.get(String(req.params.id));
    if (!t) throw new HttpError(404, 'Term not found');
    const m = worldModules(d.db, W(res)).enabled.find((x) => x.id === t.moduleId);
    const full = { id: t.ref, moduleId: t.moduleId, module: t.moduleName, term: t.term, aliases: t.aliases, kind: t.kind, summary: t.summary, text: t.text, data: t.data ?? null, license: m?.license ?? '', attribution: m?.attribution ?? '' };
    res.json(isDM(res) ? full : playerCard(full, settings(res)));
  });

  r.get('/rules/search', (req, res) => {
    const q = str(req.query.q, 'q', { max: 300 });
    const results = searchRules(d.db, W(res), q, intQ(req.query.limit, 5));
    const ps = settings(res);
    res.json({ query: q, results: isDM(res) ? results : results.map((h) => ({ ...h, passage: playerCard({ kind: h.kind, text: h.passage }, ps).text, summary: playerCard({ kind: h.kind, summary: h.summary }, ps).summary })) });
  });

  // The highlighting contract: text in, matches out. Library titles are
  // matched only for pages this viewer can open.
  r.post('/match', (req, res) => {
    const text = str(req.body?.text, 'text', { max: 200_000, optional: true });
    res.json(findMatches(d.db, W(res), ctx(res).viewer, text, { spoken: req.body?.spoken === true }));
  });

  r.get('/card/:source/:id', (req, res) => {
    const source = String(req.params.source);
    const id = String(req.params.id);
    if (source === 'module') {
      const w = worldModules(d.db, W(res));
      const t = w.byRef.get(id);
      if (!t) throw new HttpError(404, 'Term not found');
      const m = w.enabled.find((x) => x.id === t.moduleId);
      const card = { source, id: t.ref, title: t.term, kind: t.kind, summary: t.summary, text: t.text, data: t.data ?? null, module: t.moduleName, attribution: m?.attribution ?? '' };
      return res.json(isDM(res) ? card : playerCard(card, settings(res)));
    }
    if (source === 'library') {
      // L.get serves players only the player copy, and 404s on anything else.
      const pg: any = d.library.get(W(res), id, ctx(res).viewer);
      const body = String(pg.body ?? '');
      return res.json({ source, id: pg.id, title: pg.title, kind: pg.kind, summary: summarize(body, 300), text: body.length > 3000 ? body.slice(0, 3000) + '…' : body, tags: pg.tags ?? [], icon: pg.icon ?? null });
    }
    throw new HttpError(404, 'Unknown card source');
  });

  // ---- free content sources (GM): what can be pulled in one step ----
  r.get('/sources', requireDM, needOpen5e, async (req, res) => {
    const kinds = [...new Set(OPEN5E_ENDPOINTS.map((e) => e.kind))];
    let open5e: any;
    try { open5e = await open5eDocuments(d, { base: typeof req.query.open5e === 'string' ? req.query.open5e : undefined }); }
    catch (e: any) { open5e = { base: OPEN5E_BASE, documents: [], error: String(e?.message ?? e).slice(0, 200) }; }
    res.json({
      open5e: { ...open5e, kinds, lists: OPEN5E_ENDPOINTS.map((e) => ({ kind: e.kind, label: e.label })) },
      dnd5eapi: { base: DND5EAPI_BASE, editions: [{ id: '2024', name: 'SRD 5.2 (5e 2024)' }, { id: '2014', name: 'SRD 5.1 (5e 2014)' }], kinds: ['spell', 'monster', 'item', 'condition', 'rule', 'class', 'other'] },
    });
  });

  // ---- browse one module and leave single entries out of this world (GM) ----
  r.get('/browse/:id', requireDM, (req, res) => {
    const id = String(req.params.id);
    if (!available(d.db, W(res)).some((m) => m.id === id)) throw new HttpError(404, 'Module not found');
    const m = moduleDoc(d.db, W(res), id)!;
    const out = leftOut(d.db, W(res), id);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 100) : '';
    const kind = typeof req.query.kind === 'string' ? req.query.kind : '';
    const only = req.query.left === '1';
    const counts: Record<string, number> = {};
    for (const t of m.doc.terms) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    const list = m.doc.terms.filter((t) => (!kind || t.kind === kind) && (!only || out.has(t.id)) && (!q || t.term.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q))))
      .sort((a, b) => a.term.localeCompare(b.term));
    const offset = Math.max(0, intQ(req.query.offset, 0));
    const limit = Math.min(200, Math.max(1, intQ(req.query.limit, 50)));
    res.json({
      module: { id: m.doc.id, name: m.doc.name, builtin: m.builtin, server: !!m.server },
      counts, leftOut: out.size, total: list.length,
      terms: list.slice(offset, offset + limit).map((t) => ({ id: t.id, term: t.term, kind: t.kind, summary: t.summary, leftOut: out.has(t.id) })),
    });
  });

  r.get('/browse/:id/:termId', requireDM, (req, res) => {
    const id = String(req.params.id);
    if (!available(d.db, W(res)).some((m) => m.id === id)) throw new HttpError(404, 'Module not found');
    const t = moduleDoc(d.db, W(res), id)!.doc.terms.find((x) => x.id === String(req.params.termId));
    if (!t) throw new HttpError(404, 'Term not found');
    res.json({ id: t.id, term: t.term, kind: t.kind, aliases: t.aliases, summary: t.summary, text: t.text, data: t.data ?? null, leftOut: leftOut(d.db, W(res), id).has(t.id) });
  });

  r.put('/left-out', requireDM, (req, res) => {
    const id = str(req.body?.module, 'module', { max: 120 });
    const m = available(d.db, W(res)).some((x) => x.id === id) ? moduleDoc(d.db, W(res), id) : null;
    if (!m) throw new HttpError(404, 'Module not found');
    const ids: unknown = req.body?.terms;
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000) throw new HttpError(400, 'terms must be a list of term ids');
    const known = new Set(m.doc.terms.map((t) => t.id));
    const clean = [...new Set(ids.map(String))].filter((x) => known.has(x));
    if (!clean.length) throw new HttpError(400, 'None of those terms are in the module');
    const out = req.body?.out !== false;
    setLeftOut(d.db, W(res), id, clean, out);
    audit(d.db, W(res), me(res), out ? 'modules.leave-out' : 'modules.put-back', `${id}: ${clean.slice(0, 20).join(', ')}${clean.length > 20 ? ` +${clean.length - 20}` : ''}`);
    d.hub.emit(W(res), 'modules', {}, () => true);
    res.json({ ok: true, leftOut: leftOut(d.db, W(res), id).size });
  });

  // A module the world already has (the server library's or an import): its spells into the Codex, its items into the shop.
  r.post('/feed', requireDM, (req, res) => {
    const id = str(req.body?.id, 'id', { max: 120 });
    if (!available(d.db, W(res)).some((m) => m.id === id)) throw new HttpError(404, 'Module not found');
    const feed = readFeed({ spells: req.body?.spells !== false, items: req.body?.items !== false, replace: req.body?.replace === true })!;
    const fed = feedModule(d, W(res), id, feed, me(res));
    audit(d.db, W(res), me(res), 'modules.feed', `${id}${fed.spells ? ` spells +${fed.spells.added} =${fed.spells.skipped}` : ''}${fed.items ? ` items +${fed.items.added} =${fed.items.skipped}` : ''}`);
    res.json({ fed });
  });

  // ---- import (GM): always preview, then save ----
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
    if (!zip && (b?.type === 'open5e' || b?.type === 'dnd5eapi') && !open5eOn(res)) throw new HttpError(403, OPEN5E_OFF);
    const m = await readModule(b, d, zip);
    const p = preview(m.module, m.warnings);
    const exists = available(d.db, W(res)).some((x) => x.id === m.module.id && !x.builtin && !x.server);
    const reserved = available(d.db, W(res)).some((x) => x.id === m.module.id && (x.builtin || x.server));
    res.json({ ...p, exists, reserved });
  });

  r.post('/import', requireDM, raw, async (req, res) => {
    const { b, zip } = body(req);
    if (!zip && (b?.type === 'open5e' || b?.type === 'dnd5eapi') && !open5eOn(res)) throw new HttpError(403, OPEN5E_OFF);
    const m = await readModule(b, d, zip);
    saveImported(d.db, W(res), m.module, m.source, b.replace === true, b.enable !== false);
    audit(d.db, W(res), me(res), 'modules.import', `${m.module.id} ${m.module.terms.length} terms`);
    d.hub.emit(W(res), 'modules', {}, () => true);
    // Optionally, spells into the Codex and items into the shop's item database, in the same step.
    const feed = readFeed(b.feed);
    const fed = feed ? feedModule(d, W(res), m.module.id, { ...feed, replace: feed.replace || b.replace === true }, me(res)) : null;
    if (fed) audit(d.db, W(res), me(res), 'modules.feed', `${m.module.id}${fed.spells ? ` spells +${fed.spells.added} ~${fed.spells.replaced} =${fed.spells.skipped}` : ''}${fed.items ? ` items +${fed.items.added} ~${fed.items.updated} =${fed.items.skipped}` : ''}`);
    res.json({ ...preview(m.module, m.warnings), saved: true, modules: worldModules(d.db, W(res)).enabled, ...(fed ? { fed } : {}) });
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
