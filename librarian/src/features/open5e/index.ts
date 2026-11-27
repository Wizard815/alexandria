// Open5e and the 5e SRD API: a house rule each world turns on (mods/open5e.alxmod.json, World → House rules), which
// sets the world setting `open5e`. While it is off the world's Open5e and 5e SRD API imports and GET /modules/sources
// refuse (features/modules), and the Game module settings hide those tabs. The server's content library (Admin →
// Content library) is not a mod: books the admin keeps there are offered to every world under Available.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { run } from '../../core/db.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { preview } from '../modules/format.ts';
import { readModule } from '../modules/importers.ts';
import { DND5EAPI_BASE, clearSourceCache, open5eDocuments } from '../modules/sources.ts';
import { OPEN5E_BASE, OPEN5E_ENDPOINTS } from '../modules/open5e.ts';
import { removeServer, saveServer, serverModules, serverRows } from '../modules/store.ts';

// ---- the server's content library (admins): pull a book once, every world can turn it on ----
function adminRoutes(d: Deps) {
  const r = Router();
  const adminAudit = (accountId: string, action: string, detail: string) => run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (NULL, ?, ?, ?, ?)', accountId, action, detail.slice(0, 500), now());
  const FREE = ['open5e', 'dnd5eapi', 'json'];
  const check = (b: any) => { if (!FREE.includes(String(b?.type))) throw new HttpError(400, `type must be one of: ${FREE.join(', ')}`); return b; };

  r.get('/', (_req, res) => res.json({ modules: serverModules(d.db) }));

  r.get('/sources', async (req, res) => {
    let open5e: any;
    try { open5e = await open5eDocuments(d, { base: typeof req.query.open5e === 'string' ? req.query.open5e : undefined }); }
    catch (e: any) { open5e = { base: OPEN5E_BASE, documents: [], error: String(e?.message ?? e).slice(0, 200) }; }
    const have = new Set(serverModules(d.db).map((m) => m.id));
    res.json({ open5e: { ...open5e, kinds: [...new Set(OPEN5E_ENDPOINTS.map((e) => e.kind))] }, dnd5eapi: { base: DND5EAPI_BASE, editions: [{ id: '2024', name: 'SRD 5.2 (5e 2024)' }, { id: '2014', name: 'SRD 5.1 (5e 2014)' }] }, have: [...have] });
  });

  r.post('/preview', async (req, res) => {
    const m = await readModule(check(req.body ?? {}), d);
    res.json({ ...preview(m.module, m.warnings), edition: m.edition, exists: serverModules(d.db).some((x) => x.id === m.module.id) });
  });

  r.post('/', async (req, res) => {
    const b = check(req.body ?? {});
    const m = await readModule(b, d);
    const { replace: _r, ...request } = b;
    saveServer(d.db, m.module, { source: m.source, request: b.type === 'json' ? undefined : request, edition: m.edition, replace: b.replace === true });
    adminAudit((res.locals.auth as any).account.id, 'content.save', `${m.module.id} ${m.module.terms.length} terms`);
    res.json({ ...preview(m.module, m.warnings), edition: m.edition, saved: true, modules: serverModules(d.db) });
  });

  // Pull the same request again (a book Open5e has fixed, a newer SRD).
  r.post('/:id/refresh', async (req, res) => {
    const row = serverRows(d.db).find((x) => x.id === String(req.params.id));
    if (!row) throw new HttpError(404, 'Not in the content library');
    const request = parseJson<any>(row.request ?? '', null);
    if (!request) throw new HttpError(400, 'This one was uploaded, not pulled; upload it again to change it');
    clearSourceCache();
    const m = await readModule(request, d);
    if (m.module.id !== row.id) m.module.id = row.id;
    saveServer(d.db, m.module, { source: m.source, request, edition: m.edition, replace: true });
    adminAudit((res.locals.auth as any).account.id, 'content.refresh', `${row.id} ${m.module.terms.length} terms`);
    res.json({ ...preview(m.module, m.warnings), refreshed: true, modules: serverModules(d.db) });
  });

  r.delete('/:id', (req, res) => {
    removeServer(d.db, String(req.params.id));
    adminAudit((res.locals.auth as any).account.id, 'content.remove', String(req.params.id));
    res.json({ ok: true, modules: serverModules(d.db) });
  });
  return r;
}

const feature: Feature = {
  id: 'open5e',
  settings: { open5e: { type: 'boolean', default: false } },
  houseRules: ['open5e'],
  adminMount: 'content',
  adminRoutes,
  mcpTools: [
    {
      name: 'list_content_books', dmOnly: true,
      description: "GM: the free books Alexandria can pull spells, monsters, magic items, gear, conditions, feats, backgrounds and species from: Open5e's books (Tome of Beasts 1-3, Creature Codex, Deep Magic, Vault of Magic, Tome of Heroes, Level Up A5e, Black Flag, the SRDs ...) with their keys, publisher and licence, and the 5e SRD API editions. Use the keys with import_content.",
      props: {},
      call: () => ({ method: 'GET', path: '/modules/sources' }),
    },
    {
      name: 'import_content', write: true,
      description: "GM: add a game module from Open5e books (source open5e, books = keys from list_content_books, e.g. tob, deepm, vom) or a fresh copy of the SRD from the 5e SRD API (source dnd5eapi, edition 2014 or 2024). Its monsters go straight into the encounter builder and initiative; its spells into the Codex and its items into the shop's item database unless told not to. Optionally only some kinds.",
      props: {
        source: { type: 'string', enum: ['open5e', 'dnd5eapi'] },
        books: { type: 'array', items: { type: 'string' }, description: 'Open5e book keys (open5e only), at most 12' },
        edition: { type: 'string', enum: ['2024', '2014'], description: 'dnd5eapi only' },
        kinds: { type: 'array', items: { type: 'string', enum: ['spell', 'monster', 'item', 'condition', 'rule', 'class', 'other'] }, description: 'Only these kinds (default: all)' },
        addSpellsToCodex: { type: 'boolean', description: 'Default true' },
        addItemsToShop: { type: 'boolean', description: 'Default true' },
      },
      required: ['source'],
      call: (a) => ({ method: 'POST', path: '/modules/import', body: { type: a.source === 'dnd5eapi' ? 'dnd5eapi' : 'open5e', ...(a.source === 'dnd5eapi' ? { edition: a.edition === '2014' ? '2014' : '2024' } : { documents: Array.isArray(a.books) ? a.books : typeof a.books === 'string' ? String(a.books).split(/[\s,]+/).filter(Boolean) : [] }), ...(Array.isArray(a.kinds) && a.kinds.length ? { kinds: a.kinds } : {}), replace: true, feed: { spells: a.addSpellsToCodex !== false, items: a.addItemsToShop !== false } } }),
    },
  ],
};
export default feature;
