// Sharing the library with players, made quick for the DM (routes under /api/worlds/:world/libshare).
//
// One answer for every library page, file and folder: who can see it.
//   party    everyone in the party
//   players  only the players picked (the per-player shares of features/sourcekeys for a page, libshare_files for a file)
//   dm       nobody but the DM
// A folder gets a rule that covers its pages and files, also ones added or moved
// in later (grants.ts reads it live, so nothing goes stale). Broker and classified
// pages and files are never shared this way: classified can never be shared at all,
// and a rule skips them. Sharing a page or file that holds classified blocks needs
// an explicit `confirm`; so does every folder. "Send to players" also records the item
// so players see it as new from the DM, and sends a live event to the people it is for.
// A recipient only ever gets what they can open: the same player copy of a page,
// secret blocks and DM facts already cut.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { all, one, run, tx } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { normLevel } from '../../core/levels.ts';
import { HttpError, id as newId, now } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, names } from '../../routes/_shared.ts';
import { mintTicket } from '../sound/ticket.ts';
import { mayRead } from '../libfiles/index.ts';
import { SCHEMA, type FolderRule, inRule, liftable, rulesOf } from './grants.ts';
import type { McpTool } from '../types.ts';

type Mode = 'party' | 'players' | 'dm';
interface Aud { mode: Mode | 'broker' | 'classified'; to: string[]; via: string[] }

const enc = encodeURIComponent;

export default {
  id: 'libshare',
  schema: SCHEMA,
  worldMount: 'libshare',
  worldRoutes: (d: Deps) => routes(d),
  mcpTools: [
    {
      name: 'library_sharing', dmOnly: true,
      description: 'DM: who can see what in the library: pages, files and folder rules shared with the whole party or chosen players, and who each is shared with.',
      props: {}, call: () => ({ method: 'GET', path: '/libshare/overview' }),
    },
    {
      name: 'share_library_item', write: true, dmOnly: true,
      description: "DM: share a library page, file or folder with everyone ('party'), only chosen players (list of player account ids), or nobody ('dm'). A folder rule also covers pages and files added later. Classified items can never be shared. notify=true also tells the players ('new from the DM').",
      props: {
        kind: { type: 'string', enum: ['page', 'file', 'folder'] }, id: { type: 'string', description: 'Page id or path, or file id (not for a folder)' },
        sourceId: { type: 'string', description: "Folder: the source id ('' for pages written in Alexandria)" }, path: { type: 'string', description: "Folder: its names joined with '/'" }, whole: { type: 'boolean', description: 'Folder: share the whole source (leave path empty)' },
        to: { type: 'string', enum: ['party', 'players', 'dm'] }, players: { type: 'array', items: { type: 'string' } },
        notify: { type: 'boolean' }, confirm: { type: 'boolean', description: 'Needed for a folder, or an item that holds classified text players never see' },
      },
      required: ['kind', 'to'],
      call: (a: any) => ({ method: 'PUT', path: '/libshare/share', body: { kind: a.kind, id: a.id, sourceId: a.sourceId, path: a.path, whole: a.whole, mode: a.to, players: a.players, notify: a.notify, confirm: a.confirm } }),
    },
  ] as McpTool[],
} satisfies Feature;

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const audit = (_db: unknown, world: string, who: string | null, action: string, detail: string) =>
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', world, who, action, detail.slice(0, 500), now());
  const L = d.library;
  const W = (res: any): string => ctx(res).world.id;
  const PAGE_COLS = 'id, path, title, visibility, marker_level, source_id, folder';

  const players = (w: string) => memberIds(db, w, ['player']);
  const cleanPlayers = (w: string, v: unknown): string[] => {
    if (!Array.isArray(v) || !v.length || v.length > 50 || v.some((x) => typeof x !== 'string')) throw new HttpError(400, 'Pick at least one player');
    const have = new Set(players(w));
    const out = [...new Set(v as string[])];
    if (out.some((x) => !have.has(x))) throw new HttpError(400, 'players must be players in this world');
    return out;
  };
  const modeOf = (v: unknown, allowed: string[]): string => {
    if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `mode must be one of: ${allowed.join(', ')}`);
    return v;
  };

  const pageRow = (w: string, ref: unknown) => {
    const pg = one<any>(db, `SELECT ${PAGE_COLS} FROM pages WHERE world_id = ? AND (id = ? OR path = ?)`, w, String(ref ?? ''), String(ref ?? ''));
    if (!pg) throw new HttpError(404, 'Page not found');
    return pg;
  };
  const fileRow = (w: string, ref: unknown) => {
    const f = one<any>(db, 'SELECT * FROM libfiles_files WHERE world_id = ? AND id = ?', w, String(ref ?? ''));
    if (!f) throw new HttpError(404, 'File not found');
    return f;
  };
  const blocked = (what: string, pageLike: { visibility?: unknown; marker_level?: unknown }) => {
    const l = normLevel(pageLike.visibility);
    if (l === 'classified' || pageLike.marker_level === 'classified') throw new HttpError(409, `${what} is classified and can never be shared. Classified content stays with the DM.`);
    if (l === 'broker' || pageLike.marker_level === 'broker') throw new HttpError(409, `${what} is at the broker level. Change its level to DM only or Party first.`);
  };

  // ---- Who can see what ----

  /** The DM's own shares of pages: page id -> { star, ids }. */
  const dmShares = (w: string) => {
    const map = new Map<string, { star: boolean; ids: Set<string> }>();
    try {
      for (const s of all<any>(db, `SELECT s.page_id, s.to_id FROM sourcekeys_shares s WHERE s.world_id = ? AND s.kind = 'dm'`, w)) {
        const e = map.get(s.page_id) ?? { star: false, ids: new Set<string>() };
        if (s.to_id === '*') e.star = true; else e.ids.add(s.to_id);
        map.set(s.page_id, e);
      }
    } catch { /* sharing not installed */ }
    return map;
  };
  const fileShares = (w: string) => {
    const map = new Map<string, { star: boolean; ids: Set<string> }>();
    for (const s of all<any>(db, 'SELECT file_id, to_id FROM libshare_files WHERE world_id = ?', w)) {
      const e = map.get(s.file_id) ?? { star: false, ids: new Set<string>() };
      if (s.to_id === '*') e.star = true; else e.ids.add(s.to_id);
      map.set(s.file_id, e);
    }
    return map;
  };

  function pageAud(pg: any, shares: ReturnType<typeof dmShares>, rules: FolderRule[], valid: Set<string>): Aud {
    const lvl = normLevel(pg.visibility);
    if (lvl === 'classified' || pg.marker_level === 'classified') return { mode: 'classified', to: [], via: [] };
    if (lvl === 'broker' || pg.marker_level === 'broker') return { mode: 'broker', to: [], via: [] };
    if (lvl === 'party') return { mode: 'party', to: [], via: ['level'] };
    if (!liftable(pg)) return { mode: 'dm', to: [], via: [] };
    const via: string[] = [];
    let star = false;
    const ids = new Set<string>();
    const sh = shares.get(pg.id);
    if (sh) { via.push('share'); if (sh.star) star = true; for (const x of sh.ids) ids.add(x); }
    for (const rule of rules) {
      if (!inRule(rule, pg.source_id, pg.folder)) continue;
      via.push('folder');
      if (rule.mode === 'party') star = true; else for (const x of rule.players) ids.add(x);
    }
    const to = [...ids].filter((x) => valid.has(x));
    return star ? { mode: 'party', to: [], via } : to.length ? { mode: 'players', to, via } : { mode: 'dm', to: [], via: [] };
  }

  function fileAud(f: any, pg: any, page: Aud, fshares: ReturnType<typeof fileShares>, rules: FolderRule[], valid: Set<string>): Aud {
    const lvl = normLevel(f.level);
    if (lvl === 'classified') return { mode: 'classified', to: [], via: [] };
    if (lvl === 'broker') return { mode: 'broker', to: [], via: [] };
    if (page.mode === 'classified' || page.mode === 'broker') return { mode: 'dm', to: [], via: [] };
    const via: string[] = [];
    let star = false;
    const ids = new Set<string>();
    // The file's own level party follows whoever can open its page.
    if (lvl === 'party') {
      if (page.mode === 'party') { star = true; via.push('level'); }
      else if (page.mode === 'players') { for (const x of page.to) ids.add(x); via.push('level'); }
    }
    const sh = fshares.get(f.id);
    if (sh) { via.push('share'); if (sh.star) star = true; for (const x of sh.ids) ids.add(x); }
    for (const rule of rules) {
      if (!inRule(rule, pg.source_id, pg.folder)) continue;
      via.push('folder');
      if (rule.mode === 'party') star = true; else for (const x of rule.players) ids.add(x);
    }
    const to = [...ids].filter((x) => valid.has(x));
    return star ? { mode: 'party', to: [], via } : to.length ? { mode: 'players', to, via } : { mode: 'dm', to: [], via: [] };
  }

  function overview(w: string) {
    const rules = rulesOf(db, w);
    const valid = new Set(players(w));
    const shares = dmShares(w);
    const fshares = fileShares(w);
    const nm = names(db, w);
    const srcName = new Map(all<any>(db, 'SELECT id, name FROM sources WHERE world_id = ?', w).map((s) => [s.id, s.name]));
    const pages: Record<string, { mode: string; to: string[]; via: string[] }> = {};
    const files: Record<string, { mode: string; to: string[]; via: string[] }> = {};
    const shared: any[] = [];
    const audOf = new Map<string, Aud>();
    const rows = all<any>(db, `SELECT ${PAGE_COLS} FROM pages WHERE world_id = ? ORDER BY path`, w);
    const byId = new Map(rows.map((p) => [p.id, p]));
    for (const p of rows) {
      const a = pageAud(p, shares, rules, valid);
      audOf.set(p.id, a);
      // A page that is party by its own level needs no entry: the list already says so.
      if ((a.mode === 'party' || a.mode === 'players') && !(a.mode === 'party' && a.via.length === 1 && a.via[0] === 'level')) pages[p.id] = { mode: a.mode, to: a.to, via: a.via };
      if (a.mode === 'party' || a.mode === 'players') shared.push({ kind: 'page', id: p.id, pageId: p.id, title: p.title, mode: a.mode, to: a.to, via: a.via, where: [srcName.get(p.source_id) ?? 'Written in Alexandria', ...JSON.parse(p.folder || '[]')].join(' / ') });
    }
    for (const f of all<any>(db, 'SELECT * FROM libfiles_files WHERE world_id = ? ORDER BY at DESC', w)) {
      const pg = byId.get(f.page_id);
      if (!pg) continue;
      const a = fileAud(f, pg, audOf.get(pg.id)!, fshares, rules, valid);
      files[f.id] = { mode: a.mode, to: a.to, via: a.via };
      if (a.mode === 'party' || a.mode === 'players') shared.push({ kind: 'file', id: f.id, pageId: pg.id, title: f.name, mode: a.mode, to: a.to, via: a.via, where: pg.title });
    }
    return {
      players: [...valid].map((id) => ({ id, name: nm[id] ?? 'Player' })),
      pages, files, shared: shared.slice(0, 3000),
      folders: rules.map((x) => ({ sourceId: x.sourceId, path: x.path, whole: !x.path, mode: x.mode, to: x.mode === 'players' ? x.players.filter((p) => valid.has(p)) : [], source: x.sourceId ? srcName.get(x.sourceId) ?? 'Source' : 'Written in Alexandria', at: x.at })),
    };
  }

  r.get('/overview', requireDM, (_req, res) => res.json(overview(W(res))));

  // What a share would do, so the DM can confirm: how many pages and files, what is skipped, whether text stays hidden.
  r.get('/preview', requireDM, (req, res) => {
    const w = W(res);
    const kind = modeOf(req.query.kind, ['page', 'file', 'folder']);
    if (kind === 'folder') {
      const rule: FolderRule = { sourceId: String(req.query.sourceId ?? ''), path: String(req.query.path ?? '').replace(/^\/+|\/+$/g, ''), mode: 'party', players: [], by: null, at: '' };
      // An empty path is the whole source, and only when asked for by name.
      if (!rule.path && req.query.whole !== '1') throw new HttpError(400, 'path is required: the folder names joined with / (or whole=1 for the whole source)');
      const pages = folderPages(w, rule);
      const files = all<any>(db, 'SELECT id, page_id, level FROM libfiles_files WHERE world_id = ?', w).filter((f) => pages.some((p) => p.id === f.page_id));
      const lv = (p: any) => (p.marker_level === 'classified' ? 'classified' : p.marker_level === 'broker' ? 'broker' : normLevel(p.visibility));
      return res.json({
        kind, pages: pages.length, files: files.length,
        shareable: pages.filter((p) => lv(p) === 'dm' || lv(p) === 'party').length,
        skippedClassified: pages.filter((p) => lv(p) === 'classified').length + files.filter((f) => normLevel(f.level) === 'classified').length,
        skippedBroker: pages.filter((p) => lv(p) === 'broker').length + files.filter((f) => normLevel(f.level) === 'broker').length,
      });
    }
    if (kind === 'page') {
      const pg = pageRow(w, req.query.id);
      return res.json(previewPage(w, pg));
    }
    const f = fileRow(w, req.query.id);
    const pg = pageRow(w, f.page_id);
    return res.json({ kind, name: f.name, level: normLevel(f.level), page: { ...previewPage(w, pg), id: pg.id } });
  });

  function previewPage(w: string, pg: any) {
    const lvl = normLevel(pg.visibility);
    const classifiedText = L.hasClassified(w, pg.path);
    let hiddenParts = false;
    try {
      const dm = L.get(w, pg.id, { accountId: '', role: 'dm' } as any) as any;
      const pl = L.liftedCopy(w, pg.id);
      hiddenParts = !!pl && String(dm.body ?? '').trim().length > String(pl.body ?? '').trim().length;
    } catch { /* unreadable: say nothing */ }
    return { kind: 'page', title: pg.title, level: pg.marker_level === 'classified' ? 'classified' : lvl, classifiedText, hiddenParts, files: one<any>(db, 'SELECT COUNT(*) AS n FROM libfiles_files WHERE world_id = ? AND page_id = ?', w, pg.id)!.n };
  }

  const folderPages = (w: string, rule: FolderRule) =>
    all<any>(db, `SELECT ${PAGE_COLS} FROM pages WHERE world_id = ?`, w).filter((p) => inRule(rule, p.source_id, p.folder));

  // ---- Changing who can see something ----

  const touch = (w: string, pageIds: string[]) => {
    const both = (v: any) => v.role === 'dm' || v.role === 'player';
    for (const id of pageIds) {
      d.hub.emit(w, 'page', { id }, both);
      d.hub.emit(w, 'libfile', { pageId: id }, both);
    }
    d.hub.emit(w, 'libshare', {}, both);
  };

  function setPage(w: string, by: string, pg: any, mode: Mode, to: string[]) {
    blocked(`“${pg.title}”`, pg);
    const lvl = normLevel(pg.visibility);
    tx(db, () => {
      try { run(db, `DELETE FROM sourcekeys_shares WHERE world_id = ? AND page_id = ? AND kind = 'dm'`, w, pg.id); } catch { /* sharing not installed */ }
      if (mode === 'dm') { if (lvl === 'party') L.setLevel(w, pg.id, 'dm', by); return; }
      if (mode === 'party') { if (lvl !== 'party') insertShares(w, by, pg.id, ['*']); return; }
      if (lvl === 'party') L.setLevel(w, pg.id, 'dm', by);
      insertShares(w, by, pg.id, to);
    });
    L.touchClassified();
    L.changed(w, [pg.id]);
  }
  const insertShares = (w: string, by: string, pageId: string, to: string[]) => {
    for (const t of to) run(db, `INSERT OR REPLACE INTO sourcekeys_shares (world_id, page_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, 'dm', ?)`, w, pageId, by, t, now());
  };

  function setFile(w: string, by: string, f: any, mode: Mode, to: string[]) {
    const lvl = normLevel(f.level);
    if (lvl === 'classified') throw new HttpError(409, `“${f.name}” is classified and can never be shared. Classified content stays with the DM.`);
    if (lvl === 'broker') throw new HttpError(409, `“${f.name}” is at the broker level. Change its level to DM only or Party first.`);
    const pg = pageRow(w, f.page_id);
    if (mode !== 'dm') blocked(`The page “${pg.title}”`, pg);
    tx(db, () => {
      run(db, 'DELETE FROM libshare_files WHERE world_id = ? AND file_id = ?', w, f.id);
      if (mode === 'party') {
        run(db, `UPDATE libfiles_files SET level = 'party' WHERE id = ?`, f.id);
        run(db, `INSERT INTO libshare_files (world_id, file_id, to_id, by_id, at) VALUES (?, ?, '*', ?, ?)`, w, f.id, by, now());
      } else if (mode === 'players') {
        run(db, `UPDATE libfiles_files SET level = 'dm' WHERE id = ?`, f.id);
        for (const t of to) run(db, 'INSERT INTO libshare_files (world_id, file_id, to_id, by_id, at) VALUES (?, ?, ?, ?, ?)', w, f.id, t, by, now());
      } else run(db, `UPDATE libfiles_files SET level = 'dm' WHERE id = ?`, f.id);
    });
    audit(db, w, by, 'libfile.update', `${f.name} share ${mode}`);
  }

  function recordSent(w: string, by: string, kind: string, itemId: string, title: string, mode: Mode, to: string[], pageIds: string[]) {
    const sid = newId('lsn_');
    const toIds = mode === 'party' ? ['*'] : to;
    run(db, 'INSERT INTO libshare_sent (id, world_id, kind, item_id, title, to_ids, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sid, w, kind, itemId, title.slice(0, 200), JSON.stringify(toIds), by, now());
    d.hub.emit(w, 'libshare-new', { id: sid, kind, itemId, title: title.slice(0, 200) }, (v) => v.role === 'dm' || (v.role === 'player' && (toIds.includes('*') || toIds.includes(v.accountId))));
    void pageIds;
    return sid;
  }

  const needConfirm = (res: any, message: string) => res.status(409).json({ error: message, needsConfirm: true });

  r.put('/share', requireDM, (req, res) => {
    const w = W(res);
    const by = me(res);
    const b = req.body ?? {};
    const kind = modeOf(b.kind, ['page', 'file', 'folder']);
    const mode = modeOf(b.mode ?? b.to, kind === 'folder' ? ['party', 'players', 'dm', 'off'] : ['party', 'players', 'dm']);
    const mm: Mode = mode === 'off' ? 'dm' : (mode as Mode);
    const to = mm === 'players' ? cleanPlayers(w, b.players) : [];
    const notify = b.notify === true && mm !== 'dm';
    let title = '';
    let itemId = '';
    const touched: string[] = [];
    let sent: string | null = null;

    if (kind === 'page') {
      const pg = pageRow(w, b.id);
      if (mm !== 'dm' && L.hasClassified(w, pg.path) && normLevel(pg.visibility) !== 'classified' && b.confirm !== true) return needConfirm(res, `“${pg.title}” has classified text. Players never see it, only the party parts of the page. Share anyway?`);
      setPage(w, by, pg, mm, to);
      if (b.withFiles === true) for (const f of all<any>(db, 'SELECT * FROM libfiles_files WHERE world_id = ? AND page_id = ?', w, pg.id)) {
        if (['party', 'dm'].includes(normLevel(f.level))) setFile(w, by, f, mm, to);
      }
      title = pg.title; itemId = pg.id; touched.push(pg.id);
      audit(db, w, by, 'libshare.page', `${pg.path} ${mm}${to.length ? ` ${to.length} players` : ''}`);
    } else if (kind === 'file') {
      const f = fileRow(w, b.id);
      const pg = pageRow(w, f.page_id);
      if (mm !== 'dm' && b.withPage === true && L.hasClassified(w, pg.path) && b.confirm !== true) return needConfirm(res, `The page “${pg.title}” has classified text. Players never see it, only the party parts of the page. Share the page anyway?`);
      setFile(w, by, f, mm, to);
      if (b.withPage === true && mm !== 'dm') setPage(w, by, pg, mm, to);
      title = f.name; itemId = f.id; touched.push(pg.id);
      audit(db, w, by, 'libshare.file', `${f.name} ${mm}${to.length ? ` ${to.length} players` : ''}`);
    } else {
      const sourceId = String(b.sourceId ?? '');
      const path = String(b.path ?? '').replace(/^\/+|\/+$/g, '');
      // An empty path is the whole source (every folder in it), and only when asked for by name: never by a missing field.
      if (!path && b.whole !== true) throw new HttpError(400, 'path is required: the folder names joined with / (or whole: true for the whole source)');
      if (sourceId && !one(db, 'SELECT 1 FROM sources WHERE id = ? AND world_id = ?', sourceId, w)) throw new HttpError(404, 'Source not found');
      const srcLabel = sourceId ? one<any>(db, 'SELECT name FROM sources WHERE id = ?', sourceId)?.name ?? 'Source' : 'Written in Alexandria';
      const label = path || srcLabel;
      const rule: FolderRule = { sourceId, path, mode: 'party', players: [], by, at: now() };
      const inside = folderPages(w, rule);
      if (!inside.length && mode !== 'off') throw new HttpError(404, 'There is nothing in that folder');
      if (mode !== 'off' && mm !== 'dm' && b.confirm !== true) return needConfirm(res, `Share everything in “${label}”${path ? '' : ' (the whole source)'}, including pages and files added later? Classified and broker pages are skipped.`);
      tx(db, () => {
        run(db, 'DELETE FROM libshare_folders WHERE world_id = ? AND source_id = ? AND path = ?', w, sourceId, path);
        if (mm !== 'dm') run(db, 'INSERT INTO libshare_folders (world_id, source_id, path, mode, players, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', w, sourceId, path, mm, JSON.stringify(to), by, now());
      });
      title = path ? path.split('/').pop() || path : srcLabel; itemId = `${sourceId}|${path}`;
      for (const p of inside) touched.push(p.id);
      audit(db, w, by, 'libshare.folder', `${path || `${srcLabel} (whole source)`} ${mode}${to.length ? ` ${to.length} players` : ''}`);
      L.touchClassified();
      L.changed(w, touched.slice(0, 500));
    }
    if (notify) sent = recordSent(w, by, kind, itemId, title, mm, to, touched);
    touch(w, touched.slice(0, 200));
    res.json({ ok: true, sent, ...overview(w) });
  });

  // ---- Players: what is new from the DM ----

  const seenAt = (w: string, acc: string): string => one<any>(db, 'SELECT at FROM libshare_seen WHERE world_id = ? AND account_id = ?', w, acc)?.at ?? '';

  r.get('/new', (req, res) => {
    const c = ctx(res);
    const w = W(res);
    const v = c.viewer;
    if (v.role !== 'dm' && v.role !== 'player') return res.json({ items: [], newCount: 0 });
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const rows = all<any>(db, 'SELECT * FROM libshare_sent WHERE world_id = ? AND at > ? ORDER BY at DESC LIMIT 200', w, since);
    const seen = isDM(res) ? now() : seenAt(w, me(res));
    const lifted = isDM(res) ? new Set<string>() : d.library.liftedPages(w, me(res));
    const nm = names(db, w);
    const items: any[] = [];
    for (const s of rows) {
      const ids: string[] = JSON.parse(s.to_ids || '[]');
      if (!isDM(res) && !ids.includes('*') && !ids.includes(me(res))) continue;
      const base: any = { id: s.id, kind: s.kind, itemId: s.item_id, title: s.title, at: s.at, isNew: s.at > seen, from: nm[s.by_id] ?? 'The DM' };
      if (isDM(res)) { items.push({ ...base, to: ids, toNames: ids.map((x) => (x === '*' ? 'Everyone' : nm[x] ?? 'Someone')) }); continue; }
      // Checked again now: it is shown only while this player can still open it.
      const openPage = (pid: string) => {
        const p = one<any>(db, 'SELECT id, title, visibility FROM pages WHERE world_id = ? AND id = ?', w, pid);
        return p && (normLevel(p.visibility) === 'party' || lifted.has(p.id)) ? p : null;
      };
      if (s.kind === 'page') {
        const p = openPage(s.item_id);
        if (p) items.push({ ...base, title: p.title, pageId: p.id });
      } else if (s.kind === 'file') {
        const f = one<any>(db, 'SELECT * FROM libfiles_files WHERE world_id = ? AND id = ?', w, s.item_id);
        if (f && mayRead(d, f, v)) {
          const p = openPage(f.page_id);
          items.push({ ...base, title: f.name, name: f.name, family: f.family, mime: f.mime, pageId: p?.id ?? null, url: `/api/media/libfile/${mintTicket({ w, k: 'libfile', f: f.id, a: me(res) })}` });
        }
      } else {
        const [sourceId, ...rest] = String(s.item_id).split('|');
        const rule: FolderRule = { sourceId, path: rest.join('|'), mode: 'party', players: [], by: null, at: '' };
        const pages = folderPages(w, rule).filter((p) => openPage(p.id)).slice(0, 12).map((p) => ({ id: p.id, title: p.title }));
        if (pages.length) items.push({ ...base, pages });
      }
    }
    res.json({ items, newCount: items.filter((x) => x.isNew).length });
  });

  r.post('/seen', (req, res) => {
    const c = ctx(res);
    if (c.viewer.role !== 'player') return res.json({ ok: true });
    run(db, 'INSERT INTO libshare_seen (world_id, account_id, at) VALUES (?, ?, ?) ON CONFLICT (world_id, account_id) DO UPDATE SET at = excluded.at', W(res), me(res), now());
    res.json({ ok: true });
  });

  return r;
}
