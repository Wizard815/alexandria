// Sculpting: fill in a few blanks and the agent fills the rest, from templates
// kept per world. Deterministic generators first, then one chat call.
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import type { Feature } from '../types.ts';
import { requireDM } from '../../core/auth.ts';
import { all, one, run } from '../../core/db.ts';
import { only } from '../../core/events.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { ctx, me, memberIds } from '../../routes/_shared.ts';
import { normalizeStatblock, saveStatblockPage } from '../agent/statblock.ts';
import { cleanForPlayer, renderMd, renderParts, sculpt, type Tpl, type Values } from './engine.ts';
import { BUILTINS, FIELD_TYPES, type Field, type Target } from './templates.ts';

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
`;

const audit = (db: any, worldId: string, accountId: string | null, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const bad = (m: string) => new HttpError(422, m);

function seed(db: any, worldId: string) {
  const have = new Set(all<any>(db, 'SELECT builtin_key FROM sculpt_templates WHERE world_id = ? AND builtin_key IS NOT NULL', worldId).map((r) => r.builtin_key));
  for (const b of BUILTINS) {
    if (have.has(b.key)) continue;
    run(db, 'INSERT INTO sculpt_templates (id, world_id, builtin_key, name, description, perspective, fields, body, target, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id('sct_'), worldId, b.key, b.name, b.description, b.perspective, JSON.stringify(b.fields), b.body, JSON.stringify(b.target), now(), now());
  }
}

const view = (r: any) => ({
  id: r.id, builtin: !!r.builtin_key, key: r.builtin_key ?? null, name: r.name, description: r.description, perspective: r.perspective as 'dm' | 'player',
  fields: parseJson<Field[]>(r.fields, []), body: r.body, target: parseJson<Target>(r.target, { kind: 'none' }), updatedAt: r.updated_at,
});
const asTpl = (r: any): Tpl => { const v = view(r); return { id: v.id, name: v.name, description: v.description, perspective: v.perspective, fields: v.fields, body: v.body, target: v.target }; };

const text = (v: unknown, field: string, max: number, required = false): string => {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${field} is required`); return ''; }
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  if (v.length > max) throw bad(`${field} is too long`);
  return v.trim();
};

function readTemplate(b: any) {
  if (!b || typeof b !== 'object') throw bad('A template is needed');
  const name = text(b.name, 'name', 80, true);
  const perspective = b.perspective === 'player' ? 'player' : 'dm';
  if (!Array.isArray(b.fields) || !b.fields.length || b.fields.length > 40) throw bad('A template needs 1 to 40 fields');
  const seen = new Set<string>();
  const fields: Field[] = b.fields.map((f: any, i: number) => {
    const key = text(f?.key, `fields[${i}].key`, 32, true);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw bad(`Field key "${key}" must be lowercase letters, digits and underscores`);
    if (seen.has(key)) throw bad(`Field key "${key}" is used twice`);
    seen.add(key);
    if (!FIELD_TYPES.includes(f.type)) throw bad(`Field "${key}" has an unknown type`);
    const out: Field = { key, label: text(f.label, `fields[${i}].label`, 80) || key, type: f.type };
    if (f.type === 'select') {
      const o = Array.isArray(f.options) ? f.options.map((x: unknown) => String(x).trim()).filter(Boolean).slice(0, 40) : [];
      if (!o.length) throw bad(`Field "${key}" needs options`);
      out.options = o;
    }
    const hint = text(f.hint, `fields[${i}].hint`, 300);
    if (hint) out.hint = hint;
    if (f.required) out.required = true;
    if (f.dmOnly) out.dmOnly = true;
    if (f.gen === 'clock' || f.gen === 'stock') out.gen = f.gen;
    return out;
  });
  const body = text(b.body, 'body', 20000, true);
  for (const k of [...body.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1])) if (!seen.has(k)) throw bad(`The body uses {{${k}}}, which is not a field`);
  if (perspective === 'player' && (fields.some((f) => f.dmOnly) || /\{\{#dm\}\}/.test(body))) throw bad('A player-perspective template cannot have DM-only fields or {{#dm}} sections');
  const t = b.target && typeof b.target === 'object' ? b.target : { kind: 'none' };
  const vis = t.visibility === 'party' ? 'party' : 'dm';
  const path = text(t.path, 'target.path', 200);
  let target: Target;
  switch (t.kind) {
    case 'page': target = { kind: 'page', path: path || 'Sculpted/{{' + fields[0].key + '}}', visibility: vis }; break;
    case 'person': target = { kind: 'person', path: path || 'People/{{' + fields[0].key + '}}', visibility: vis, alsoPage: t.alsoPage !== false }; break;
    case 'shop': target = { kind: 'shop', path: path || 'Shops/{{' + fields[0].key + '}}', visibility: vis, listField: typeof t.listField === 'string' && seen.has(t.listField) ? t.listField : undefined }; break;
    case 'combat':
      if (!fields.some((f) => f.type === 'statblock')) throw bad('A combat target needs a statblock field');
      target = { kind: 'combat' }; break;
    case 'none': target = { kind: 'none' }; break;
    default: throw bad('The save target must be page, person, combat, shop or none');
  }
  return { name, description: text(b.description, 'description', 400), perspective, fields, body, target };
}

const expand = (pattern: string, values: Values): string => pattern.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, k) => (values[k] ?? '').replace(/\s+/g, ' ').trim());
const cleanPath = (p: string): string => p.split('/').map((s) => s.replace(/[\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()).filter((s) => s && s !== '.' && s !== '..').join('/');

function routes(d: Deps) {
  const r = Router();
  r.use(requireDM);
  const W = (res: any): string => ctx(res).world.id;
  r.use((_req, res, next) => { seed(d.db, W(res)); next(); });

  const rows = (res: any) => all<any>(d.db, 'SELECT * FROM sculpt_templates WHERE world_id = ? ORDER BY builtin_key IS NULL, created_at, name', W(res));
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

  // ---- templates ----
  r.get('/templates', (_req, res) => res.json({ templates: rows(res).map(view) }));
  r.post('/templates', (req, res) => {
    const t = readTemplate(req.body);
    const tid = id('sct_');
    run(d.db, 'INSERT INTO sculpt_templates (id, world_id, builtin_key, name, description, perspective, fields, body, target, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      tid, W(res), null, t.name, t.description, t.perspective, JSON.stringify(t.fields), t.body, JSON.stringify(t.target), now(), now());
    audit(d.db, W(res), me(res), 'sculpt.template', `create ${t.name}`);
    res.status(201).json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', tid)));
  });
  r.put('/templates/:id', (req, res) => {
    const row = find(res, req.params.id);
    const t = readTemplate(req.body);
    run(d.db, 'UPDATE sculpt_templates SET name = ?, description = ?, perspective = ?, fields = ?, body = ?, target = ?, updated_at = ? WHERE id = ?', t.name, t.description, t.perspective, JSON.stringify(t.fields), t.body, JSON.stringify(t.target), now(), row.id);
    audit(d.db, W(res), me(res), 'sculpt.template', `update ${t.name}`);
    res.json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', row.id)));
  });
  r.delete('/templates/:id', (req, res) => {
    const row = find(res, req.params.id);
    if (row.builtin_key) throw new HttpError(409, 'Built-in templates cannot be deleted. Edit them, or use Reset to restore the original.');
    run(d.db, 'DELETE FROM sculpt_templates WHERE id = ?', row.id);
    audit(d.db, W(res), me(res), 'sculpt.template', `delete ${row.name}`);
    res.json({ ok: true });
  });
  r.post('/templates/:id/reset', (req, res) => {
    const row = find(res, req.params.id);
    const b = BUILTINS.find((x) => x.key === row.builtin_key);
    if (!b) throw new HttpError(409, 'Only built-in templates can be reset');
    run(d.db, 'UPDATE sculpt_templates SET name = ?, description = ?, perspective = ?, fields = ?, body = ?, target = ?, updated_at = ? WHERE id = ?', b.name, b.description, b.perspective, JSON.stringify(b.fields), b.body, JSON.stringify(b.target), now(), row.id);
    res.json(view(one(d.db, 'SELECT * FROM sculpt_templates WHERE id = ?', row.id)));
  });

  // ---- saving ----
  const saveTo = async (res: any, tpl: Tpl, values: Values, override: any) => {
    const w = W(res);
    const cleaned = cleanForPlayer(d, w, tpl, values);
    if (cleaned.leaks.length) throw new HttpError(409, `Not saved: ${cleaned.leaks.map((l) => l.key).join(', ')} repeats words from DM-only notes.`);
    const v = cleaned.values;
    const md = renderMd(renderParts(tpl, v));
    const base = tpl.target;
    const o = override && typeof override === 'object' ? override : {};
    const visibility: 'dm' | 'party' = tpl.perspective === 'player' ? (o.visibility === 'party' ? 'party' : 'dm') : o.visibility === 'party' ? 'party' : o.visibility === 'dm' ? 'dm' : (base as any).visibility === 'party' ? 'party' : 'dm';
    const title = (v.title || v.name || v.location || tpl.name).replace(/\s+/g, ' ').trim().slice(0, 120) || tpl.name;
    const pagePath = (pattern: string): string => {
      const p0 = cleanPath(expand(typeof o.path === 'string' && o.path.trim() ? o.path : pattern, v)) || `Sculpted/${title}`;
      const stem = p0.replace(/\.md$/i, '');
      let p = `${stem}.md`;
      for (let n = 2; one(d.db, 'SELECT 1 FROM pages WHERE world_id = ? AND path = ?', w, p); n++) p = `${stem} ${n}.md`;
      return p;
    };
    const savePage = (pattern: string, extra: Record<string, unknown> = {}) => d.library.save(w, { path: pagePath(pattern), title, body: md, frontmatter: { title, tags: ['sculpt', tpl.name.toLowerCase().replace(/\s+/g, '-')], visibility, ...extra }, visibility }, me(res));
    switch (base.kind) {
      case 'page': { const p = savePage(base.path); audit(d.db, w, me(res), 'sculpt.save', `page ${p.path}`); return { kind: 'page', pageId: p.id, path: p.path, title: p.title, visibility }; }
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
        // A person the party may see is announced; the page's DM-only parts never leave the page.
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

  // ---- sculpt ----
  r.post('/run', async (req, res) => {
    const b = req.body ?? {};
    const tpl = asTpl(find(res, b.templateId ?? b.template));
    const lock = Array.isArray(b.lock) ? b.lock.map(String) : [];
    const onlyKeys = Array.isArray(b.only) ? b.only.map(String) : undefined;
    const out: any = await sculpt(d, W(res), ctx(res).world.name, tpl, valuesOf(b.values), { lock, only: onlyKeys });
    if (!onlyKeys?.length) remember(res, tpl, out.values, out.md);
    if (b.save) out.saved = await saveTo(res, tpl, out.values, b.target);
    res.json(out);
  });

  /** The rendered text, with the leak check for player templates. Used by Read aloud and Send. */
  r.post('/check', (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    const c = cleanForPlayer(d, W(res), tpl, valuesOf(req.body?.values));
    const parts = renderParts(tpl, c.values);
    const plain = parts.filter((p) => !p.dm).map((p) => p.md.replace(/[*_#>`]/g, '').replace(/^\s*-\s+/gm, '').trim()).join('\n\n');
    res.json({ ok: !c.leaks.length, leaks: c.leaks, md: renderMd(parts), parts, text: plain });
  });

  r.post('/save', async (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    res.status(201).json(await saveTo(res, tpl, valuesOf(req.body?.values), req.body?.target));
  });

  r.post('/send', (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    if (tpl.perspective !== 'player') throw new HttpError(422, 'Only player-perspective templates can be sent to players');
    const w = W(res);
    const c = cleanForPlayer(d, w, tpl, valuesOf(req.body?.values));
    if (c.leaks.length) throw new HttpError(409, 'Not sent: the text repeats words from DM-only notes.');
    const body = renderParts(tpl, c.values).filter((p) => !p.dm).map((p) => p.md).join('\n\n').trim();
    if (!body) throw new HttpError(422, 'There is nothing to send yet');
    const players = memberIds(d.db, w, ['player']);
    if (!players.length) throw new HttpError(409, 'There are no players in this world to send it to');
    const people = [...new Set([me(res), ...players])];
    const tid = id('thr_');
    const at = now();
    const title = (c.values.location || tpl.name).slice(0, 100);
    run(d.db, 'INSERT INTO threads (id, world_id, starter_id, title, kept, created_at, last_at) VALUES (?, ?, ?, ?, 0, ?, ?)', tid, w, me(res), title, at, at);
    for (const p of people) run(d.db, 'INSERT INTO thread_members (thread_id, account_id) VALUES (?, ?)', tid, p);
    const m = { id: id('msg_'), thread_id: tid, author_id: me(res), body: body.slice(0, 4000), at };
    run(d.db, 'INSERT INTO messages (id, thread_id, author_id, body, at) VALUES (?, ?, ?, ?, ?)', m.id, m.thread_id, m.author_id, m.body, m.at);
    d.hub.emit(w, 'thread', { id: tid, world_id: w, starter_id: me(res), title, kept: false, created_at: at, last_at: at, members: people }, only(...people));
    d.hub.emit(w, 'message', m, only(...people));
    audit(d.db, w, me(res), 'sculpt.send', title);
    res.status(201).json({ ok: true, threadId: tid });
  });

  /** Add a sculpted statblock to the combat tracker (through the live API, with the DM's own token). */
  r.post('/combat', async (req, res) => {
    const tpl = asTpl(find(res, req.body?.templateId));
    const f = tpl.fields.find((x) => x.type === 'statblock');
    if (!f) throw bad('This template has no statblock');
    const values = valuesOf(req.body?.values);
    const sb = normalizeStatblock(parseJson<any>(values[f.key], null), values.name ?? '');
    let pageId = typeof req.body?.pageId === 'string' ? req.body.pageId : '';
    if (!pageId) pageId = String((await saveTo(res, tpl, values, undefined)).pageId ?? '');
    const initiative = Number.isInteger(req.body?.initiative) ? req.body.initiative : Math.max(-20, Math.min(60, 1 + Math.floor(Math.random() * 20) + Math.floor((sb.abilities.dex - 10) / 2)));
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const r2 = await fetch(`http://127.0.0.1:${req.socket.localPort}/api/worlds/${W(res)}/live/combatants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: String(req.headers.cookie ?? '') }) },
      body: JSON.stringify({ name: sb.name, initiative, hp: sb.hp, maxHp: sb.hp, ac: sb.ac, hidden: !!req.body?.hidden, statblockPage: pageId }),
    });
    const j: any = await r2.json().catch(() => ({}));
    if (!r2.ok) throw new HttpError(r2.status >= 400 && r2.status < 600 ? r2.status : 502, `Could not add to combat: ${j?.error ?? r2.status}`);
    res.status(201).json({ combatant: { id: j.id, name: sb.name, initiative, hp: sb.hp, ac: sb.ac }, pageId });
  });

  r.get('/history', (_req, res) => {
    res.json({ history: all<any>(d.db, 'SELECT * FROM sculpt_history WHERE world_id = ? ORDER BY at DESC, rowid DESC LIMIT 50', W(res)).map((h) => ({ id: h.id, templateId: h.template_id, templateName: h.template_name, values: parseJson(h.vals, {}), md: h.md, at: h.at })) });
  });
  return r;
}

const feature: Feature = {
  id: 'sculpt',
  schema: SCHEMA,
  worldMount: 'sculpt',
  worldRoutes: routes,
  mcpTools: [{
    name: 'sculpt', write: true,
    description: 'DM: make something new from a template (an NPC, a shop, a statblock, a scene, a tavern, a quest hook). Give a template name or id (see sculpt_templates) and any values you have; the blanks are filled to fit the world. With save: true it is saved to the template\'s target (a library page, People, a statblock page). DM-only parts become secret blocks.',
    props: {
      template: { type: 'string', description: 'Template name or id, e.g. "NPC for quick RP"' },
      values: { type: 'object', description: 'Field values you already know, by field key' },
      lock: { type: 'array', items: { type: 'string' }, description: 'Field keys to leave exactly as given' },
      only: { type: 'array', items: { type: 'string' }, description: 'Re-roll just these field keys' },
      save: { type: 'boolean', description: 'Also save the result to the template target' },
    },
    required: ['template'],
    call: (a) => ({ method: 'POST', path: '/sculpt/run', body: { template: a.template, values: a.values ?? {}, lock: a.lock, only: a.only, save: !!a.save } }),
  }, {
    name: 'sculpt_templates',
    description: 'DM: the sculpting templates for this world, with their fields.',
    props: {},
    call: () => ({ method: 'GET', path: '/sculpt/templates' }),
  }],
};
export default feature;
