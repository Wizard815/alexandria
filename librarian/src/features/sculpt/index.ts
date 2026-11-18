// Sculpting: fill in a few blanks and the rest is filled to fit the world, from
// templates kept per world. Generators and the world's context come first (no
// model); then at most one chat call per sculpt, or per batch.
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import type { Feature } from '../types.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one, run } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { ctx, me, memberIds } from '../../routes/_shared.ts';
import { normalizeStatblock, saveStatblockPage } from '../agent/statblock.ts';
import { bodyHash, firstLeak, makeCtx, type Overrides, type RenderCtx } from './ctx.ts';
import { MAX_BATCH, cleanForPlayer, publicText, renderMd, renderParts, sculptMany, type SculptResult, type Tpl, type Values } from './engine.ts';
import { combatantsFromList, plain, publicOf, selfCall, OUTPUT_KEYS, type OutputKey } from './outputs.ts';
import { CTX_VARS, exportTemplate, readImport, readTemplate } from './schema.ts';
import { BUILTINS, CATEGORIES, type Field, type Outputs, type Target } from './templates.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sculpt_templates (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  builtin_key TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', perspective TEXT NOT NULL DEFAULT 'dm',
  fields TEXT NOT NULL, body TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sculpt_templates_world ON sculpt_templates(world_id);
CREATE TABLE IF NOT EXISTS sculpt_history (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  template_id TEXT, template_name TEXT NOT NULL, vals TEXT NOT NULL, md TEXT NOT NULL, by_account TEXT, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sculpt_history_world ON sculpt_history(world_id, at);
CREATE TABLE IF NOT EXISTS sculpt_player_pages (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, page_id TEXT NOT NULL, body_hash TEXT NOT NULL,
  PRIMARY KEY (world_id, page_id));
CREATE TABLE IF NOT EXISTS sculpt_prefs (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, account_id TEXT NOT NULL, template_id TEXT NOT NULL,
  fav INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, used_at TEXT,
  PRIMARY KEY (world_id, account_id, template_id));
`;

const audit = (db: any, worldId: string, accountId: string | null, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const bad = (m: string) => new HttpError(422, m);

const INSERT = 'INSERT INTO sculpt_templates (id, world_id, builtin_key, name, description, perspective, fields, body, target, category, outputs, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)';
const defaultOutputs = (target: Target): Outputs => ({ page: target.kind !== 'none' });

function seed(db: any, worldId: string) {
  const have = new Set(all<any>(db, 'SELECT builtin_key FROM sculpt_templates WHERE world_id = ? AND builtin_key IS NOT NULL', worldId).map((r) => r.builtin_key));
  for (const b of BUILTINS) {
    if (have.has(b.key)) continue;
    run(db, INSERT, id('sct_'), worldId, b.key, b.name, b.description, b.perspective, JSON.stringify(b.fields), b.body, JSON.stringify(b.target), b.category, JSON.stringify(b.outputs ?? defaultOutputs(b.target)), now(), now());
  }
}

const view = (r: any, prefs?: Map<string, any>) => {
  const b = r.builtin_key ? BUILTINS.find((x) => x.key === r.builtin_key) : undefined;
  const target = parseJson<Target>(r.target, { kind: 'none' });
  const p = prefs?.get(r.id);
  return {
    id: r.id, builtin: !!r.builtin_key, key: r.builtin_key ?? null, name: r.name, description: r.description, perspective: r.perspective as 'dm' | 'player',
    category: (r.category || b?.category || 'Story') as string,
    fields: parseJson<Field[]>(r.fields, []), body: r.body, target, outputs: parseJson<Outputs>(r.outputs, b?.outputs ?? defaultOutputs(target)),
    updatedAt: r.updated_at, favorite: !!p?.fav, uses: p?.uses ?? 0, lastUsedAt: p?.used_at ?? null,
  };
};
const asTpl = (r: any): Tpl => { const v = view(r); return { id: v.id, name: v.name, description: v.description, perspective: v.perspective, category: v.category as Tpl['category'], fields: v.fields, body: v.body, target: v.target, outputs: v.outputs }; };

const expand = (pattern: string, values: Values): string => pattern.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, k) => (values[k] ?? '').replace(/\s+/g, ' ').trim());
const cleanPath = (p: string): string => p.split('/').map((s) => s.replace(/[\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()).filter((s) => s && s !== '.' && s !== '..').join('/');

interface CtxIn extends Overrides { page?: string }
function contextIn(raw: unknown): CtxIn {
  const o = raw && typeof raw === 'object' ? (raw as any) : {};
  const out: CtxIn = {};
  if (typeof o.location === 'string' && o.location.trim()) out.location = o.location.trim().slice(0, 120);
  if (o.partyLevel !== undefined && Number.isFinite(Number(o.partyLevel))) out.partyLevel = Math.max(1, Math.min(20, Math.floor(Number(o.partyLevel))));
  if (typeof o.page === 'string' && o.page.trim()) out.page = o.page.trim().slice(0, 120);
  return out;
}

function routes(d: Deps) {
  const r = Router();
  r.use(requireDM);
  const W = (res: any): string => ctx(res).world.id;
  r.use((_req, res, next) => { seed(d.db, W(res)); next(); });

  const rows = (res: any) => all<any>(d.db, 'SELECT * FROM sculpt_templates WHERE world_id = ? ORDER BY builtin_key IS NULL, created_at, rowid', W(res));
  const prefsOf = (res: any) => new Map(all<any>(d.db, 'SELECT * FROM sculpt_prefs WHERE world_id = ? AND account_id = ?', W(res), me(res)).map((p) => [p.template_id, p]));
  const find = (res: any, ref: unknown): any => {
    const s = String(ref ?? '').trim();
    const row = one<any>(d.db, 'SELECT * FROM sculpt_templates WHERE world_id = ? AND (id = ? OR builtin_key = ? OR name = ? COLLATE NOCASE)', W(res), s, s, s);
    if (!row) throw new HttpError(404, 'Template not found');
    return row;
  };
  const valuesOf = (b: any): Values => {
    const out: Values = {};
    if (b && typeof b === 'object') for (const [k, v] of Object.entries(b)) if (v !== null && v !== undefined) out[k] = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return out;
  };
  const rcFor = (res: any, tpl: Tpl, c: CtxIn = {}): RenderCtx => {
    let location = c.location;
    if (!location && c.page) location = one<any>(d.db, 'SELECT title FROM pages WHERE world_id = ? AND (id = ? OR title = ? COLLATE NOCASE OR path = ?)', W(res), c.page, c.page, c.page)?.title;
    return makeCtx(d, W(res), tpl.perspective === 'player', { location, partyLevel: c.partyLevel });
  };
  /** "Sculpt from this page": the first blank page field gets the page. */
  const withPage = (res: any, tpl: Tpl, values: Values, c: CtxIn): Values => {
    if (!c.page) return values;
    const pg = one<any>(d.db, 'SELECT title FROM pages WHERE world_id = ? AND (id = ? OR title = ? COLLATE NOCASE OR path = ?)', W(res), c.page, c.page, c.page);
    if (!pg) throw new HttpError(404, 'That page was not found');
    const f = tpl.fields.find((x) => (x.type === 'page' || x.type === 'pageLink') && !values[x.key]?.trim());
    return f ? { ...values, [f.key]: pg.title } : values;
  };
  const touchUse = (res: any, tplId: string) => {
    run(d.db, `INSERT INTO sculpt_prefs (world_id, account_id, template_id, uses, used_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (world_id, account_id, template_id) DO UPDATE SET uses = uses + 1, used_at = excluded.used_at`, W(res), me(res), tplId, now());
  };

  // ---- templates ----
  r.get('/templates', (req, res) => {
    const prefs = prefsOf(res);
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const cat = String(req.query.category ?? '').trim().toLowerCase();
    let list = rows(res).map((x) => view(x, prefs));
    if (cat) list = list.filter((t) => t.category.toLowerCase() === cat);
    if (q) list = list.filter((t) => `${t.name} ${t.description} ${t.category} ${t.fields.map((f) => f.label).join(' ')}`.toLowerCase().includes(q));
    if (req.query.favorites === '1') list = list.filter((t) => t.favorite);
    if (req.query.recent === '1') list = list.filter((t) => t.lastUsedAt).sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt))).slice(0, 8);
    if (req.query.compact === '1') {
      res.json({ templates: list.map((t) => ({ name: t.name, category: t.category, description: t.description, perspective: t.perspective, fields: t.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}) })), outputs: t.outputs })), categories: CATEGORIES });
      return;
    }
    res.json({ templates: list, categories: CATEGORIES });
  });
  r.post('/templates', (req, res) => {
    const t = readTemplate(req.body);
    const tid = id('sct_');
    run(d.db, INSERT, tid, W(res), null, t.name, t.description, t.perspective, JSON.stringify(t.fields), t.body, JSON.stringify(t.target), t.category, JSON.stringify(t.outputs), now(), now());
    audit(d.db, W(res), me(res), 'sculpt.template', `create ${t.name}`);
    res.status(201).json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', tid)));
  });

  // Sharing: export, import (with a preview), duplicate.
  r.post('/templates/import', (req, res) => {
    const b = req.body ?? {};
    const { template: t, summary } = readImport(b.json ?? b.data ?? b.template ?? b);
    const clash = !!one(d.db, 'SELECT 1 FROM sculpt_templates WHERE world_id = ? AND name = ? COLLATE NOCASE', W(res), t.name);
    if (b.preview) { res.json({ ok: true, preview: summary, nameTaken: clash }); return; }
    let name = t.name;
    for (let n = 2; one(d.db, 'SELECT 1 FROM sculpt_templates WHERE world_id = ? AND name = ? COLLATE NOCASE', W(res), name); n++) name = `${t.name} (${n})`.slice(0, 80);
    const tid = id('sct_');
    run(d.db, INSERT, tid, W(res), null, name, t.description, t.perspective, JSON.stringify(t.fields), t.body, JSON.stringify(t.target), t.category, JSON.stringify(t.outputs), now(), now());
    audit(d.db, W(res), me(res), 'sculpt.template', `import ${name}`);
    res.status(201).json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', tid)));
  });
  r.get('/templates/:id/export', (req, res) => { res.json(exportTemplate(view(find(res, req.params.id)))); });
  r.post('/templates/:id/duplicate', (req, res) => {
    const v = view(find(res, req.params.id));
    let name = `${v.name} (copy)`.slice(0, 80);
    for (let n = 2; one(d.db, 'SELECT 1 FROM sculpt_templates WHERE world_id = ? AND name = ? COLLATE NOCASE', W(res), name); n++) name = `${v.name} (copy ${n})`.slice(0, 80);
    const tid = id('sct_');
    run(d.db, INSERT, tid, W(res), null, name, v.description, v.perspective, JSON.stringify(v.fields), v.body, JSON.stringify(v.target), v.category, JSON.stringify(v.outputs), now(), now());
    audit(d.db, W(res), me(res), 'sculpt.template', `duplicate ${v.name}`);
    res.status(201).json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', tid)));
  });
  r.post('/templates/:id/favorite', (req, res) => {
    const row = find(res, req.params.id);
    const on = req.body?.on !== false;
    run(d.db, `INSERT INTO sculpt_prefs (world_id, account_id, template_id, fav) VALUES (?, ?, ?, ?)
      ON CONFLICT (world_id, account_id, template_id) DO UPDATE SET fav = excluded.fav`, W(res), me(res), row.id, on ? 1 : 0);
    res.json({ ok: true, favorite: on });
  });
  r.put('/templates/:id', (req, res) => {
    const row = find(res, req.params.id);
    const t = readTemplate(req.body);
    run(d.db, 'UPDATE sculpt_templates SET name = ?, description = ?, perspective = ?, fields = ?, body = ?, target = ?, category = ?, outputs = ?, updated_at = ? WHERE id = ?', t.name, t.description, t.perspective, JSON.stringify(t.fields), t.body, JSON.stringify(t.target), t.category, JSON.stringify(t.outputs), now(), row.id);
    audit(d.db, W(res), me(res), 'sculpt.template', `update ${t.name}`);
    res.json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', row.id)));
  });
  r.delete('/templates/:id', (req, res) => {
    const row = find(res, req.params.id);
    if (row.builtin_key) throw new HttpError(409, 'Built-in templates cannot be deleted. Edit them, use Reset to restore the original, or duplicate one to customise it.');
    run(d.db, 'DELETE FROM sculpt_templates WHERE id = ?', row.id);
    run(d.db, 'DELETE FROM sculpt_prefs WHERE world_id = ? AND template_id = ?', W(res), row.id);
    audit(d.db, W(res), me(res), 'sculpt.template', `delete ${row.name}`);
    res.json({ ok: true });
  });
  r.post('/templates/:id/reset', (req, res) => {
    const row = find(res, req.params.id);
    const b = BUILTINS.find((x) => x.key === row.builtin_key);
    if (!b) throw new HttpError(409, 'Only built-in templates can be reset');
    run(d.db, 'UPDATE sculpt_templates SET name = ?, description = ?, perspective = ?, fields = ?, body = ?, target = ?, category = ?, outputs = ?, updated_at = ? WHERE id = ?', b.name, b.description, b.perspective, JSON.stringify(b.fields), b.body, JSON.stringify(b.target), b.category, JSON.stringify(b.outputs ?? defaultOutputs(b.target)), now(), row.id);
    res.json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', row.id)));
  });

  /** The world context templates can use ({{world.date}}, {{party.level}} ...), resolved without a model. */
  r.get('/context', (req, res) => {
    const rc = makeCtx(d, W(res), false, contextIn({ location: req.query.location, partyLevel: req.query.partyLevel }));
    res.json({ vars: rc.vars(), names: CTX_VARS, partyLevel: rc.partyLevel() });
  });

  // ---- saving ----
  /** Check the text players would see, for a DM template too: a page shared with the party, the stage, a message. */
  const requirePublicClean = (rc: RenderCtx, tpl: Tpl, v: Values) => {
    const hit = firstLeak(rc, publicText(renderParts(tpl, v, rc)));
    if (hit) throw new HttpError(409, 'Not shared: the text repeats words from DM-only notes.');
  };
  const rememberPage = (w: string, pageId: string) => {
    const body = one<any>(d.db, 'SELECT body FROM pages WHERE id = ?', pageId)?.body ?? '';
    run(d.db, 'INSERT OR REPLACE INTO sculpt_player_pages (world_id, page_id, body_hash) VALUES (?, ?, ?)', w, pageId, bodyHash(body));
  };

  const saveTo = async (res: any, tpl: Tpl, values: Values, override: any, rc: RenderCtx, extra: { md?: string; title?: string } = {}) => {
    const w = W(res);
    const cleaned = cleanForPlayer(d, w, tpl, values, rc);
    if (cleaned.leaks.length) throw new HttpError(409, `Not saved: ${cleaned.leaks.map((l) => l.key).join(', ')} repeats words from DM-only notes.`);
    const v = cleaned.values;
    const md = extra.md ?? renderMd(renderParts(tpl, v, rc));
    const base = tpl.target;
    const o = override && typeof override === 'object' ? override : {};
    const visibility: 'dm' | 'party' = tpl.perspective === 'player' ? (o.visibility === 'party' ? 'party' : 'dm') : o.visibility === 'party' ? 'party' : o.visibility === 'dm' ? 'dm' : (base as any).visibility === 'party' ? 'party' : 'dm';
    if (visibility === 'party' && tpl.perspective !== 'player') requirePublicClean(rc, tpl, v);
    const title = (extra.title || v.title || v.name || v.location || tpl.name).replace(/\s+/g, ' ').trim().slice(0, 120) || tpl.name;
    const pagePath = (pattern: string): string => {
      const p0 = cleanPath(expand(typeof o.path === 'string' && o.path.trim() ? o.path : pattern, v)) || `Sculpted/${title}`;
      const stem = p0.replace(/\.md$/i, '');
      let p = `${stem}.md`;
      for (let n = 2; one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', w, p); n++) p = `${stem} ${n}.md`;
      return p;
    };
    const savePage = (pattern: string, ex: Record<string, unknown> = {}) => {
      const p = d.library.save(w, { path: pagePath(pattern), title, body: md, frontmatter: { title, tags: ['sculpt', tpl.name.toLowerCase().replace(/\s+/g, '-')], visibility, ...ex }, visibility }, me(res));
      rememberPage(w, p.id);
      return p;
    };
    switch (base.kind) {
      case 'page': {
        const p = savePage(base.path);
        audit(d.db, w, me(res), 'sculpt.save', `page ${p.path}`);
        return { kind: 'page', pageId: p.id, path: p.path, title: p.title, visibility };
      }
      case 'shop': {
        const items = (base.listField ? v[base.listField] ?? '' : '').split(/\r?\n/).map((l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, '').trim()).filter(Boolean).map((l) => {
          const m = l.match(/^(.*?)\s*[—–-]\s+(\d[\d.,]*\s*(?:pp|gp|ep|sp|cp)\b.*)$/i);
          return m ? { name: m[1].trim(), price: m[2].trim() } : { name: l, price: '' };
        });
        const p = savePage(base.path, { kind: 'shop', items });
        audit(d.db, w, me(res), 'sculpt.save', `shop ${p.path}`);
        return { kind: 'shop', pageId: p.id, path: p.path, title: p.title, visibility, items };
      }
      case 'person': {
        let pageId: string | null = null;
        let path: string | null = null;
        if (base.alsoPage !== false) { const p = savePage(base.path); pageId = p.id; path = p.path; }
        const pid = id('ppl_');
        const person = { id: pid, name: (v.name || title).slice(0, 120), role: (v.role || v.occupation || '').slice(0, 120), visibility };
        run(d.db, 'INSERT INTO people (id, world_id, name, role, attitude, kind, page_id, met, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', pid, w, person.name, person.role, '', 'neutral', pageId, '', visibility);
        if (visibility === 'party') d.hub.emit(w, 'person', { id: pid, world_id: w, name: person.name, role: person.role, attitude: null, kind: 'neutral', page_id: pageId, met: null, visibility }, () => true);
        audit(d.db, w, me(res), 'sculpt.save', `person ${person.name}`);
        return { kind: 'person', personId: pid, pageId, path, title: person.name, visibility };
      }
      case 'combat': {
        const f = tpl.fields.find((x) => x.type === 'statblock');
        const sb = normalizeStatblock(parseJson<any>(f ? v[f.key] : '', null), v.name ?? '');
        const p = saveStatblockPage(d, w, me(res), sb, { kind: 'sculpt', ref: '', title: sb.name });
        audit(d.db, w, me(res), 'sculpt.save', `statblock ${p.path}`);
        return { kind: 'combat', pageId: p.id, path: p.path, title: p.title, visibility: 'dm' };
      }
      default: throw bad('This template has no save target. Pick one in the editor.');
    }
  };

  const remember = (res: any, tpl: Tpl, values: Values, md: string) => {
    run(d.db, 'INSERT INTO sculpt_history (id, world_id, template_id, template_name, vals, md, by_account, at) VALUES (?,?,?,?,?,?,?,?)', id('scu_'), W(res), tpl.id, tpl.name, JSON.stringify(values), md, me(res), now());
    run(d.db, 'DELETE FROM sculpt_history WHERE world_id = ? AND id NOT IN (SELECT id FROM sculpt_history WHERE world_id = ? ORDER BY at DESC, rowid DESC LIMIT 50)', W(res), W(res));
  };

  const sendMessage = (res: any, title: string, body: string) => {
    const w = W(res);
    const players = memberIds(d.db, w, ['player']);
    if (!players.length) throw new HttpError(409, 'There are no players in this world to send it to');
    const people = [...new Set([me(res), ...players])];
    const tid = id('thr_');
    const at = now();
    run(d.db, 'INSERT INTO threads (id, world_id, starter_id, title, kept, created_at, last_at) VALUES (?, ?, ?, ?, 0, ?, ?)', tid, w, me(res), title.slice(0, 100), at, at);
    for (const p of people) run(d.db, 'INSERT INTO thread_members (thread_id, account_id) VALUES (?, ?)', tid, p);
    const m = { id: id('msg_'), thread_id: tid, author_id: me(res), body: body.slice(0, 4000), at };
    run(d.db, 'INSERT INTO messages (id, thread_id, author_id, body, at) VALUES (?, ?, ?, ?, ?)', m.id, m.thread_id, m.author_id, m.body, m.at);
    d.hub.emit(w, 'thread', { id: tid, world_id: w, starter_id: me(res), title: title.slice(0, 100), kept: false, created_at: at, last_at: at, members: people }, only(...people));
    d.hub.emit(w, 'message', m, only(...people));
    audit(d.db, w, me(res), 'sculpt.send', title);
    return tid;
  };

  // ---- the outputs: page, stage, combat, send, broker ----
  const runOutputs = async (req: any, res: any, tpl: Tpl, results: Values[], want: Partial<Record<OutputKey, boolean>>, rc: RenderCtx, opts: { pageId?: string; target?: any; to?: unknown; hidden?: boolean } = {}) => {
    const w = W(res);
    const done: Record<string, any> = {};
    const errors: Record<string, string> = {};
    const attempt = async (k: OutputKey, fn: () => Promise<any>) => {
      if (!want[k]) return;
      try { done[k] = await fn(); } catch (e: any) { errors[k] = e instanceof HttpError ? e.message : String(e?.message ?? e).slice(0, 200); }
    };
    // Everything players or the broker may see is checked BEFORE anything is saved.
    const needPublic = (['stage', 'send', 'broker'] as OutputKey[]).some((k) => want[k]);
    let pub: { text: string } | null = null;
    let pubError = '';
    if (needPublic) {
      try {
        const cleaned = results.map((v) => cleanForPlayer(d, w, tpl, v, rc));
        const bad1 = cleaned.find((c) => c.leaks.length);
        if (bad1) throw new HttpError(409, 'Blocked: the text repeats words from DM-only notes.');
        pub = publicOf(tpl, [], cleaned.map((c) => c.values), rc);
      } catch (e: any) { pubError = e instanceof HttpError ? e.message : String(e?.message ?? e); }
    }
    const needs = (k: OutputKey) => { if (!pub) throw new HttpError(409, pubError || 'Nothing to share'); void k; return pub; };
    const title = (results[0].title || results[0].name || results[0].location || tpl.name).replace(/\s+/g, ' ').trim().slice(0, 120) || tpl.name;
    const o = tpl.outputs ?? {};

    await attempt('combat', async () => {
      const cf = tpl.fields.find((f) => f.key === o.combatField) ?? tpl.fields.find((f) => f.type === 'statblock');
      if (!cf) throw bad('This template has nothing to add to combat');
      const added: any[] = [];
      for (const v of results) {
        if (cf.type === 'statblock') {
          const sb = normalizeStatblock(parseJson<any>(v[cf.key], null), v.name ?? '');
          let pageId = opts.pageId ?? '';
          if (!pageId) pageId = String(saveStatblockPage(d, w, me(res), sb, { kind: 'sculpt', ref: '', title: sb.name }).id);
          const initiative = Math.max(-20, Math.min(60, 1 + Math.floor(Math.random() * 20) + Math.floor((sb.abilities.dex - 10) / 2)));
          const j = await selfCall(req, w, 'POST', '/live/combatants', { name: sb.name, initiative, hp: sb.hp, maxHp: sb.hp, ac: sb.ac, hidden: !!opts.hidden, statblockPage: pageId });
          added.push({ id: j.id, name: sb.name, initiative, hp: sb.hp, ac: sb.ac, pageId });
        } else {
          for (const c of combatantsFromList(d, w, rc, v[cf.key] ?? '')) {
            const j = await selfCall(req, w, 'POST', '/live/combatants', { name: c.name, initiative: Math.max(-20, Math.min(60, c.initiative)), hp: c.hp ?? undefined, maxHp: c.hp ?? undefined, ac: c.ac ?? undefined, hidden: !!opts.hidden });
            added.push({ id: j.id, name: c.name, initiative: c.initiative, hp: c.hp, ac: c.ac });
          }
        }
      }
      if (!added.length) throw bad('There was nothing to add: fill the monsters first');
      audit(d.db, w, me(res), 'sculpt.combat', `${added.length} added`);
      return { added, count: added.length };
    });
    await attempt('stage', async () => {
      const text = needs('stage').text;
      const kind = o.stageKind === 'event' ? 'event' : 'text';
      const show = o.stageShow !== false;
      const imgField = tpl.fields.find((f) => f.type === 'image' && !f.dmOnly);
      const img = imgField ? (results[0][imgField.key] ?? '').trim() : '';
      const card = await selfCall(req, w, 'POST', '/stage/cards', { kind, title, text, show, to: Array.isArray(opts.to) ? opts.to : undefined });
      const out: any = { cardId: card.id, kind, shown: show };
      if (img && (/^https:\/\//.test(img) || /^stg_/.test(img))) {
        const ic = await selfCall(req, w, 'POST', '/stage/cards', { kind: 'image', ref: img, caption: title, show, to: Array.isArray(opts.to) ? opts.to : undefined });
        out.imageCardId = ic.id;
      }
      audit(d.db, w, me(res), 'sculpt.stage', title);
      return out;
    });
    await attempt('send', async () => {
      if (tpl.perspective !== 'player') throw bad('Only player-perspective templates can be sent to players');
      const text = needs('send').text;
      return { threadId: sendMessage(res, title, text) };
    });
    await attempt('broker', async () => {
      const text = plain(needs('broker').text).slice(0, 4900);
      const n = await selfCall(req, w, 'POST', '/broker/notes', { topic: title.slice(0, 190), text, knowledge: 'local' });
      audit(d.db, w, me(res), 'sculpt.broker', title);
      return { noteId: n.id };
    });
    await attempt('page', async () => {
      const t = tpl.target.kind;
      if (results.length > 1 && t === 'page') {
        const md = results.map((v) => renderMd(renderParts(tpl, v, rc)).trim()).join('\n\n---\n\n') + '\n';
        return saveTo(res, tpl, results[0], opts.target, rc, { md, title: `${tpl.name} x${results.length}` });
      }
      const saved: any[] = [];
      for (const v of results) saved.push(await saveTo(res, tpl, v, opts.target, rc));
      return saved.length === 1 ? saved[0] : { kind: tpl.target.kind, saved, count: saved.length };
    });
    return { done, errors };
  };

  const wantOf = (tpl: Tpl, raw: unknown): Partial<Record<OutputKey, boolean>> => {
    const want: Partial<Record<OutputKey, boolean>> = {};
    if (raw === true) for (const k of OUTPUT_KEYS) want[k] = !!tpl.outputs?.[k];
    else if (raw && typeof raw === 'object') for (const k of OUTPUT_KEYS) if ((raw as any)[k] !== undefined) want[k] = !!(raw as any)[k];
    return want;
  };

  // ---- sculpt ----
  r.post('/run', async (req, res) => {
    const b = req.body ?? {};
    const tpl = asTpl(find(res, b.templateId ?? b.template));
    const lock = Array.isArray(b.lock) ? b.lock.map(String) : [];
    const onlyKeys = Array.isArray(b.only) ? b.only.map(String) : undefined;
    const c = contextIn(b.context);
    const count = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(b.count ?? 1)) || 1));
    const rc = rcFor(res, tpl, c);
    const values = withPage(res, tpl, valuesOf(b.values), c);
    const out: any = await sculptMany(d, W(res), ctx(res).world.name, tpl, values, { lock, only: onlyKeys, count, rc });
    if (!onlyKeys?.length) remember(res, tpl, out.values, out.md);
    touchUse(res, tpl.id);
    if (b.save) out.saved = await saveTo(res, tpl, out.values, b.target, rc);
    if (b.outputs) out.outputs = await runOutputs(req, res, tpl, (out.results as SculptResult[]).map((x) => x.values), wantOf(tpl, b.outputs), rc, { target: b.target, to: b.to });
    res.json(out);
  });

  /** The rendered text, with the leak check for player templates. Used by the preview, Read aloud and Send. */
  r.post('/check', (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    const rc = rcFor(res, tpl, contextIn(req.body?.context));
    const c = cleanForPlayer(d, W(res), tpl, valuesOf(req.body?.values), rc);
    const parts = renderParts(tpl, c.values, rc);
    const plainText = parts.filter((p) => !p.dm).map((p) => p.md.replace(/[*_#>`]/g, '').replace(/^\s*-\s+/gm, '').trim()).join('\n\n');
    const out: any = { ok: !c.leaks.length, leaks: c.leaks, md: renderMd(parts), parts, text: plainText };
    // Can the public part be shown on the stage, sent or sold? Only worked out when asked: it reads every page.
    if (req.body?.public) { const hit = firstLeak(rc, publicText(parts)); out.publicOk = !hit; out.publicLeak = hit; }
    res.json(out);
  });

  r.post('/outputs', async (req, res) => {
    const b = req.body ?? {};
    const tpl = asTpl(find(res, b.templateId ?? b.template));
    const c = contextIn(b.context);
    const rc = rcFor(res, tpl, c);
    const list: Values[] = Array.isArray(b.results) && b.results.length ? b.results.slice(0, MAX_BATCH).map(valuesOf) : [valuesOf(b.values)];
    const want = wantOf(tpl, b.outputs ?? true);
    if (!Object.values(want).some(Boolean)) throw bad('Pick at least one output');
    res.status(201).json(await runOutputs(req, res, tpl, list, want, rc, { pageId: typeof b.pageId === 'string' ? b.pageId : undefined, target: b.target, to: b.to, hidden: !!b.hidden }));
  });

  r.post('/save', async (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    const rc = rcFor(res, tpl, contextIn(req.body?.context));
    res.status(201).json(await saveTo(res, tpl, valuesOf(req.body?.values), req.body?.target, rc));
  });

  r.post('/send', (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    if (tpl.perspective !== 'player') throw new HttpError(422, 'Only player-perspective templates can be sent to players');
    const rc = rcFor(res, tpl, contextIn(req.body?.context));
    const c = cleanForPlayer(d, W(res), tpl, valuesOf(req.body?.values), rc);
    if (c.leaks.length) throw new HttpError(409, 'Not sent: the text repeats words from DM-only notes.');
    const body = publicText(renderParts(tpl, c.values, rc));
    if (!body) throw new HttpError(422, 'There is nothing to send yet');
    const title = (c.values.location || tpl.name).slice(0, 100);
    res.status(201).json({ ok: true, threadId: sendMessage(res, title, body) });
  });

  /** Add a sculpted statblock to the combat tracker (through the live API, with the DM's own token). */
  r.post('/combat', async (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    const values = valuesOf(req.body?.values);
    const rc = rcFor(res, tpl, contextIn(req.body?.context));
    const cf = tpl.fields.find((x) => x.key === tpl.outputs?.combatField) ?? tpl.fields.find((x) => x.type === 'statblock');
    if (!cf) throw bad('This template has no statblock');
    if (cf.type === 'list') {
      const o = await runOutputs(req, res, tpl, [values], { combat: true }, rc, { hidden: !!req.body?.hidden });
      if (o.errors.combat) throw new HttpError(422, o.errors.combat);
      res.status(201).json(o.done.combat);
      return;
    }
    const sb = normalizeStatblock(parseJson<any>(values[cf.key], null), values.name ?? '');
    let pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : '';
    if (!pageId) pageId = String((await saveTo(res, tpl, values, undefined, rc)).pageId ?? '');
    const initiative = Number.isInteger(req.body?.initiative) ? req.body.initiative : Math.max(-20, Math.min(60, 1 + Math.floor(Math.random() * 20) + Math.floor((sb.abilities.dex - 10) / 2)));
    const j = await selfCall(req, W(res), 'POST', '/live/combatants', { name: sb.name, initiative, hp: sb.hp, maxHp: sb.hp, ac: sb.ac, hidden: !!req.body?.hidden, statblockPage: pageId }).catch((e) => { throw new HttpError(e.status ?? 502, `Could not add to combat: ${e.message}`); });
    res.status(201).json({ combatant: { id: j.id, name: sb.name, initiative, hp: sb.hp, ac: sb.ac }, pageId });
  });

  r.get('/history', (_req, res) => {
    res.json({ history: all<any>(d.db, 'SELECT * FROM sculpt_history WHERE world_id = ? ORDER BY at DESC, rowid DESC LIMIT 50', W(res)).map((h) => ({ id: h.id, templateId: h.template_id, templateName: h.template_name, values: parseJson(h.vals, {}), md: h.md, at: h.at })) });
  });
  return r;
}

function migrate(db: any) {
  const cols = new Set(all<any>(db, 'PRAGMA table_info(sculpt_templates)').map((c) => c.name));
  if (!cols.has('category')) db.exec(`ALTER TABLE sculpt_templates ADD COLUMN category TEXT NOT NULL DEFAULT ''`);
  if (!cols.has('outputs')) db.exec(`ALTER TABLE sculpt_templates ADD COLUMN outputs TEXT NOT NULL DEFAULT ''`);
}

const feature: Feature = {
  id: 'sculpt',
  schema: SCHEMA,
  migrate,
  worldMount: 'sculpt',
  worldRoutes: routes,
  mcpTools: [{
    name: 'sculpt', write: true,
    description: 'DM: make something from a template (an NPC, a shop, a statblock, an encounter, a rumour table, a trap, loot, a letter ...). Give a template name or id (see list_templates; do not use it for a plain NPC, monster or loot request: use generate, generate_names or generate_coins unless the DM names a template) and any values you have ("make me a rumour table for Saltmarsh": template "Rumour table", values {place: "Saltmarsh"}); the blanks are filled to fit the world. count makes several at once in one go (6 rumours, 10 tavern names). outputs picks what happens with the result: page, stage (shown to players: only the player-safe parts), combat (adds monsters to initiative), send (player templates), broker. DM-only parts become secret blocks and never reach the stage, players or the broker.',
    props: {
      template: { type: 'string', description: 'Template name or id, e.g. "NPC for quick RP"' },
      values: { type: 'object', description: 'Field values you already know, by field key' },
      lock: { type: 'array', items: { type: 'string' }, description: 'Field keys to leave exactly as given' },
      only: { type: 'array', items: { type: 'string' }, description: 'Re-roll just these field keys' },
      count: { type: 'integer', description: 'Make this many results at once (1 to 20)' },
      context: { type: 'object', description: 'Optional: location (text), partyLevel (1-20) or page (a library page title or id to use as context)' },
      outputs: { type: 'object', description: 'Booleans: page, stage, combat, send, broker' },
      save: { type: 'boolean', description: 'Also save the result to the template target' },
    },
    required: ['template'],
    call: (a) => ({ method: 'POST', path: '/sculpt/run', body: { template: a.template, values: a.values ?? {}, lock: a.lock, only: a.only, count: a.count, context: a.context, outputs: a.outputs, save: !!a.save } }),
  }, {
    name: 'send_scene', write: true,
    description: "DM: send a player-perspective scene (template 'Scene, player perspective', with the values sculpt gave back) to every player as a message. Refused if it repeats DM-only notes.",
    props: { template: { type: 'string', description: 'A player-perspective template name or id' }, values: { type: 'object', description: 'The filled fields (location, time, weather, mood, description)' } },
    required: ['template', 'values'],
    call: (a) => ({ method: 'POST', path: '/sculpt/send', body: { templateId: a.template, values: a.values } }),
  }, {
    name: 'sculpt_templates', dmOnly: true,
    description: 'DM: the sculpting templates for this world, with their fields.',
    props: {},
    call: () => ({ method: 'GET', path: '/sculpt/templates' }),
  }, {
    name: 'create_template', write: true,
    description: 'DM: draft a new sculpting template; the DM approves it before it is saved. Give name, description, perspective (dm or player), category (Combat, NPCs, Places, Loot, Story or Prep), fields (each: key lowercase_with_underscores, label, type text|longtext|number|select|list|name|item|coins|page|statblock|dice|table|rollTable, options for select, optional gen like "gen:name.human" or "dice:2d6" or "pick:a|b|c", dmOnly, hint) and body (text using {{field_key}}, {{#if key}}...{{/if}}, {{#each key}}...{{/each}}, {{#dm}}...{{/dm}} for DM-only parts, {{gen:...}}, {{dice:...}}, {{pick:a|b}}). Check list_templates first so you do not duplicate one. For a one-off NPC use generate (kind npc), not a template.',
    props: {
      name: { type: 'string' }, description: { type: 'string' },
      perspective: { type: 'string', enum: ['dm', 'player'] }, category: { type: 'string', enum: [...CATEGORIES] },
      fields: { type: 'array', items: { type: 'object' }, description: 'Field objects: {key, label, type, options?, gen?, dmOnly?, hint?, required?, optional?, default?}' },
      body: { type: 'string', description: 'The template text' },
      target: { type: 'object', description: 'Optional where results are saved, as the template editor has it' },
      outputs: { type: 'object', description: 'Optional booleans: page, stage, combat, send, broker' },
    },
    required: ['name', 'fields', 'body'],
    call: (a) => ({ method: 'POST', path: '/sculpt/templates', body: { name: a.name, description: a.description, perspective: a.perspective, category: a.category, fields: a.fields, body: a.body, target: a.target, outputs: a.outputs } }),
  }, {
    name: 'list_templates', dmOnly: true,
    description: 'DM: find a sculpting template by what you need ("rumour", "trap", "encounter"). Returns a short list: name, category, what it does and its field keys, so you can call sculpt with partial values.',
    props: {
      query: { type: 'string', description: 'Words to look for in the name, description or fields' },
      category: { type: 'string', description: 'Combat, NPCs, Places, Loot, Story or Prep' },
    },
    call: (a) => ({ method: 'GET', path: `/sculpt/templates?compact=1${a.query ? `&q=${encodeURIComponent(String(a.query))}` : ''}${a.category ? `&category=${encodeURIComponent(String(a.category))}` : ''}` }),
  }],
};
export default feature;
