// Actions, macros, key bindings and trigger URLs (PLAN §16.1).
//
//   GET  /actions                      the actions you may run, with their arguments
//   POST /actions/run                  run one action
//   CRUD /actions/macros               named sequences of actions (GM); POST /macros/:id/run
//   GET  /actions/bindings?scope=      your key bindings (web | app); POST/DELETE to change them
//   POST /actions/macros/:id/triggers  make a trigger URL (shown once); GET/DELETE /actions/triggers
//   POST /api/trigger/:token           public: runs exactly that macro, as its maker
//
// Every action calls the ordinary world API with the caller's own token, so a
// player can never do more here than anywhere else.
import { Router, type Request } from 'express';
import type { Feature } from '../types.ts';
import { all, one, run } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { HttpError, id, now, secret, sha256 } from '../../core/util.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import type { Deps } from '../../app.ts';
import { ACTIONS, ActionError, actionById, actionView, canRun, validateArgs, type Role, type Runner } from './catalog.ts';
import { SCOPES, normCombo, overlap, scopesFor } from './combo.ts';
import { TEMPLATES } from './templates.ts';
import { cleanMacro, findMacro, macroOut, paramsOf, runMacro, type MacroRow, type RunReport } from './macros.ts';

const schema = `
CREATE TABLE IF NOT EXISTS actions_macros (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]', params TEXT NOT NULL DEFAULT '[]',
  player_run INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_macros_world ON actions_macros(world_id);
CREATE TABLE IF NOT EXISTS actions_bindings (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  combo TEXT NOT NULL, macro_id TEXT NOT NULL REFERENCES actions_macros(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'both' CHECK (scope IN ('web', 'app', 'both')), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_bindings_account ON actions_bindings(world_id, account_id);
CREATE TABLE IF NOT EXISTS actions_triggers (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  macro_id TEXT NOT NULL REFERENCES actions_macros(id) ON DELETE CASCADE, created_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '', prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, per_minute INTEGER NOT NULL DEFAULT 6,
  created_at TEXT NOT NULL, last_used_at TEXT, uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS actions_triggers_macro ON actions_triggers(macro_id);
`;

const audit = (d: Deps, worldId: string, accountId: string | null, action: string, detail = '') => run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());
const bearer = (req: Request): string => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();

/** A runner that calls this librarian's own world API on loopback with a token. */
export function makeRunner(d: Deps, o: { worldId: string; accountId: string; role: Role; token: string; port: number }): Runner {
  return {
    d, worldId: o.worldId, accountId: o.accountId, role: o.role,
    async call(method, path, body, timeoutMs) {
      const res = await fetch(`http://127.0.0.1:${o.port}/api/worlds/${encodeURIComponent(o.worldId)}${path}`, {
        method, headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs ?? 20_000),
      });
      const text = await res.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
      return { ok: res.ok, status: res.status, json };
    },
  };
}

const failure = (e: unknown): HttpError => (e instanceof ActionError ? new HttpError(e.status, e.message) : (e as HttpError));

// ---- trigger URLs: a small per-trigger window ------------------------------------------
const windows = new WeakMap<Deps, Map<string, number[]>>();
/** True and counted if the trigger may run now; false when it has used up its runs in the last minute. */
function allow(d: Deps, triggerId: string, perMinute: number): boolean {
  let m = windows.get(d);
  if (!m) { m = new Map(); windows.set(d, m); }
  const t = Date.now();
  const list = (m.get(triggerId) ?? []).filter((x) => t - x < 60_000);
  if (list.length >= perMinute) { m.set(triggerId, list); return false; }
  list.push(t);
  m.set(triggerId, list);
  return true;
}

const TRIGGER_PREFIX = 'alx_trg_';

function parseArgQuery(q: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of Array.isArray(q) ? q : q === undefined ? [] : [q]) {
    const s = String(raw);
    const i = s.indexOf('=');
    if (i < 1) throw new HttpError(400, 'arg must look like name=value');
    out[s.slice(0, i)] = s.slice(i + 1);
  }
  return out;
}

const feature: Feature = {
  id: 'actions',
  schema,
  worldMount: 'actions',
  worldRoutes: (d) => {
    const r = Router({ mergeParams: true });
    const { db } = d;
    const W = (res: any): string => ctx(res).world.id;
    const role = (res: any): Role => {
      const v = ctx(res).viewer.role;
      if (v !== 'dm' && v !== 'player') throw new HttpError(403, 'Guests cannot run actions');
      return v;
    };
    const runnerFor = (req: Request, res: any): Runner => makeRunner(d, { worldId: W(res), accountId: me(res), role: role(res), token: bearer(req), port: req.socket.localPort ?? 0 });
    const macro = (res: any, ref: string): MacroRow => {
      const m = findMacro(d, W(res), ref);
      // A player never learns that a GM-only macro exists.
      if (!m || (!isDM(res) && !m.player_run)) throw new HttpError(404, 'Macro not found');
      return m;
    };

    // ---- the registry ----
    r.get('/', (_req, res) => {
      const rl = ctx(res).viewer.role;
      res.json({ role: rl, actions: ACTIONS.filter((a) => canRun(a, rl)).map(actionView), serverNow: now() });
    });
    r.post('/run', requirePlayerOrDM, async (req, res) => {
      const a = actionById(String(req.body?.action ?? ''));
      if (!a || !canRun(a, role(res))) throw new HttpError(a ? 403 : 404, a ? 'You may not run that action' : 'Unknown action');
      const t0 = Date.now();
      let out: { ok: boolean; result?: unknown; error?: string; status?: number };
      try { out = { ok: true, result: await a.run(runnerFor(req, res), validateArgs(a.args, req.body?.args)) }; }
      catch (e: any) { out = { ok: false, error: String(e?.message ?? e).slice(0, 300), status: e instanceof ActionError ? e.status : 500 }; }
      audit(d, W(res), me(res), 'action.run', `${a.id} ${out.ok ? 'ok' : `failed: ${out.error}`}`);
      res.status(out.ok ? 200 : out.status === 403 || out.status === 404 ? out.status : 422).json({ action: a.id, ms: Date.now() - t0, ...out });
    });

    // ---- macros ----
    r.get('/macro-templates', requireDM, (_req, res) => res.json(TEMPLATES));
    r.post('/macro-templates/:tid/copy', requireDM, (req, res) => {
      const t = TEMPLATES.find((x) => x.id === String(req.params.tid));
      if (!t) throw new HttpError(404, 'Template not found');
      let name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : t.name;
      for (let n = 2; findMacro(d, W(res), name); n++) name = `${t.name} ${n}`;
      const m = cleanMacro({ name, description: t.description, steps: t.steps, params: t.params });
      const mid = id('mac_');
      run(db, 'INSERT INTO actions_macros (id, world_id, name, description, steps, params, player_run, pinned, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', mid, W(res), m.name, m.description, JSON.stringify(m.steps), JSON.stringify(m.params), 0, 0, me(res), now(), now());
      audit(d, W(res), me(res), 'macro.create', `${m.name} (from template)`);
      res.status(201).json(macroOut(one<MacroRow>(db, 'SELECT * FROM actions_macros WHERE id = ?', mid)!, true));
    });
    r.get('/macros', (_req, res) => {
      const dm = isDM(res);
      res.json(all<MacroRow>(db, 'SELECT * FROM actions_macros WHERE world_id = ? ORDER BY name', W(res)).filter((m) => dm || m.player_run).map((m) => macroOut(m, dm)));
    });
    r.get('/macros/:id', (req, res) => res.json(macroOut(macro(res, String(req.params.id)), isDM(res))));
    r.post('/macros', requireDM, (req, res) => {
      const m = cleanMacro(req.body);
      if (findMacro(d, W(res), m.name)) throw new HttpError(409, 'A macro with that name already exists');
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM actions_macros WHERE world_id = ?', W(res))!.n >= 200) throw new HttpError(409, 'That is plenty of macros: remove one first');
      const mid = id('mac_');
      run(db, 'INSERT INTO actions_macros (id, world_id, name, description, steps, params, player_run, pinned, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', mid, W(res), m.name, m.description, JSON.stringify(m.steps), JSON.stringify(m.params), m.playerRun ? 1 : 0, m.pinned ? 1 : 0, me(res), now(), now());
      audit(d, W(res), me(res), 'macro.create', m.name);
      res.status(201).json(macroOut(one<MacroRow>(db, 'SELECT * FROM actions_macros WHERE id = ?', mid)!, true));
    });
    r.put('/macros/:id', requireDM, (req, res) => {
      const cur = macro(res, String(req.params.id));
      const m = cleanMacro({ ...macroOut(cur, true), ...(req.body ?? {}) });
      const clash = findMacro(d, W(res), m.name);
      if (clash && clash.id !== cur.id) throw new HttpError(409, 'A macro with that name already exists');
      run(db, 'UPDATE actions_macros SET name = ?, description = ?, steps = ?, params = ?, player_run = ?, pinned = ?, updated_at = ? WHERE id = ?', m.name, m.description, JSON.stringify(m.steps), JSON.stringify(m.params), m.playerRun ? 1 : 0, m.pinned ? 1 : 0, now(), cur.id);
      // A macro players could run and now cannot takes its players' bindings with it.
      if (!m.playerRun) run(db, `DELETE FROM actions_bindings WHERE macro_id = ? AND account_id IN (SELECT account_id FROM members WHERE world_id = ? AND role != 'dm')`, cur.id, W(res));
      audit(d, W(res), me(res), 'macro.update', m.name);
      res.json(macroOut(one<MacroRow>(db, 'SELECT * FROM actions_macros WHERE id = ?', cur.id)!, true));
    });
    r.delete('/macros/:id', requireDM, (req, res) => {
      const cur = macro(res, String(req.params.id));
      run(db, 'DELETE FROM actions_macros WHERE id = ?', cur.id);
      audit(d, W(res), me(res), 'macro.delete', cur.name);
      res.json({ ok: true });
    });
    r.post('/macros/:id/run', requirePlayerOrDM, async (req, res) => {
      const m = macro(res, String(req.params.id));
      let report: RunReport;
      try { report = await runMacro(runnerFor(req, res), m, req.body?.args, 'app'); } catch (e) { throw failure(e); }
      res.status(report.ok ? 200 : 207).json(report);
    });

    // ---- bindings ----
    const bindingOut = (b: any) => ({ id: b.id, combo: b.combo, macroId: b.macro_id, macroName: b.macro_name, scope: b.scope });
    r.get('/bindings', (req, res) => {
      const scope = typeof req.query.scope === 'string' && req.query.scope ? req.query.scope : 'all';
      if (scope !== 'all' && !(SCOPES as readonly string[]).includes(scope)) throw new HttpError(400, 'scope must be web, app or both');
      const marks = scopesFor(scope === 'both' ? 'all' : scope);
      const dm = isDM(res);
      const rows = all<any>(db, `SELECT b.*, m.name AS macro_name, m.player_run FROM actions_bindings b JOIN actions_macros m ON m.id = b.macro_id WHERE b.world_id = ? AND b.account_id = ? ORDER BY b.combo`, W(res), me(res))
        .filter((b) => marks.includes(b.scope) && (dm || b.player_run));
      res.json({ scope, bindings: rows.map(bindingOut) });
    });
    r.post('/bindings', requirePlayerOrDM, (req, res) => {
      const combo = normCombo(req.body?.combo);
      const scope = req.body?.scope === undefined ? 'both' : String(req.body.scope);
      if (!(SCOPES as readonly string[]).includes(scope)) throw new HttpError(400, 'scope must be web, app or both');
      const m = macro(res, String(req.body?.macroId ?? ''));
      const same = all<any>(db, 'SELECT * FROM actions_bindings WHERE world_id = ? AND account_id = ? AND combo = ?', W(res), me(res), combo).find((b) => overlap(b.scope, scope));
      if (same) throw new HttpError(409, `${combo} is already bound for ${same.scope === 'both' ? 'every app' : same.scope}; remove that binding first`);
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM actions_bindings WHERE world_id = ? AND account_id = ?', W(res), me(res))!.n >= 100) throw new HttpError(409, 'That is plenty of bindings: remove one first');
      const bid = id('bnd_');
      run(db, 'INSERT INTO actions_bindings (id, world_id, account_id, combo, macro_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', bid, W(res), me(res), combo, m.id, scope, now());
      res.status(201).json(bindingOut({ id: bid, combo, macro_id: m.id, macro_name: m.name, scope }));
    });
    r.delete('/bindings/:id', requirePlayerOrDM, (req, res) => {
      if (!run(db, 'DELETE FROM actions_bindings WHERE id = ? AND world_id = ? AND account_id = ?', String(req.params.id), W(res), me(res))) throw new HttpError(404, 'Binding not found');
      res.json({ ok: true });
    });

    // ---- trigger URLs (GM) ----
    const triggerOut = (t: any) => ({ id: t.id, macroId: t.macro_id, macroName: t.macro_name, label: t.label, prefix: t.prefix, perMinute: t.per_minute, createdAt: t.created_at, lastUsedAt: t.last_used_at, uses: t.uses, revoked: !!t.revoked });
    r.get('/triggers', requireDM, (_req, res) => {
      res.json(all<any>(db, 'SELECT t.*, m.name AS macro_name FROM actions_triggers t JOIN actions_macros m ON m.id = t.macro_id WHERE t.world_id = ? ORDER BY t.created_at DESC', W(res)).map(triggerOut));
    });
    r.post('/macros/:id/triggers', requireDM, (req, res) => {
      const m = macro(res, String(req.params.id));
      const perMinute = req.body?.perMinute === undefined ? 6 : Number(req.body.perMinute);
      if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 60) throw new HttpError(400, 'perMinute must be 1 to 60');
      const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 60) : '';
      if (one<any>(db, 'SELECT COUNT(*) AS n FROM actions_triggers WHERE world_id = ? AND revoked = 0', W(res))!.n >= 50) throw new HttpError(409, 'That is plenty of trigger URLs: revoke some first');
      const token = secret(TRIGGER_PREFIX);
      const tid = id('trg_');
      run(db, 'INSERT INTO actions_triggers (id, world_id, macro_id, created_by, label, prefix, token_hash, per_minute, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', tid, W(res), m.id, me(res), label, token.slice(0, 14), sha256(token), perMinute, now());
      audit(d, W(res), me(res), 'macro.trigger.create', `${m.name} ${label}`);
      const url = `${req.protocol}://${req.get('host')}/api/trigger/${token}`;
      // The only time the token is ever shown.
      res.status(201).json({ ...triggerOut({ id: tid, macro_id: m.id, macro_name: m.name, label, prefix: token.slice(0, 14), per_minute: perMinute, created_at: now(), last_used_at: null, uses: 0, revoked: 0 }), token, url, shownOnce: true });
    });
    r.delete('/triggers/:id', requireDM, (req, res) => {
      if (!run(db, 'UPDATE actions_triggers SET revoked = 1 WHERE id = ? AND world_id = ?', String(req.params.id), W(res))) throw new HttpError(404, 'Trigger not found');
      audit(d, W(res), me(res), 'macro.trigger.revoke', String(req.params.id));
      res.json({ ok: true });
    });

    // ---- what ran lately (GM) ----
    r.get('/runs', requireDM, (_req, res) => {
      res.json(all<any>(db, `SELECT a.action, a.detail, a.at, a.account_id AS accountId FROM audit a WHERE a.world_id = ? AND a.action IN ('macro.run', 'macro.trigger', 'action.run') ORDER BY a.at DESC, a.rowid DESC LIMIT 100`, W(res)));
    });

    return r;
  },

  // The public trigger URL. The token is the whole credential: it names one macro and nothing else.
  appRoutes: (app, d) => {
    app.post('/api/trigger/:token', async (req, res) => {
      const miss = () => res.status(404).json({ error: 'Not found' });
      const token = String(req.params.token);
      if (!token.startsWith(TRIGGER_PREFIX) || token.length > 100) return miss();
      const t = one<any>(d.db, 'SELECT * FROM actions_triggers WHERE token_hash = ? AND revoked = 0', sha256(token));
      if (!t) return miss();
      const m = one<MacroRow>(d.db, 'SELECT * FROM actions_macros WHERE id = ?', t.macro_id);
      const mem = one<{ role: string }>(d.db, 'SELECT role FROM members WHERE world_id = ? AND account_id = ?', t.world_id, t.created_by);
      // The maker must still be in the world, with rights for this macro.
      if (!m || !mem || (mem.role !== 'dm' && !(mem.role === 'player' && m.player_run))) return miss();
      // Overrides: ?arg=name=value (repeatable) or a JSON body { args: {...} }. Only the macro's own parameters are accepted.
      let overrides: Record<string, unknown>;
      try {
        overrides = { ...(req.body?.args && typeof req.body.args === 'object' ? req.body.args : {}), ...parseArgQuery(req.query.arg) };
        const known = new Set(paramsOf(m).map((p) => p.name));
        for (const k of Object.keys(overrides)) if (!known.has(k)) throw new HttpError(400, `"${k}" is not an argument this trigger takes`);
      } catch (e: any) { return res.status(e.status ?? 400).json({ error: e.message }); }
      if (!allow(d, t.id, t.per_minute)) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: `This trigger may run ${t.per_minute} times a minute. Wait a moment.` }); }
      run(d.db, 'UPDATE actions_triggers SET last_used_at = ?, uses = uses + 1 WHERE id = ?', now(), t.id);
      // A short-lived session for the maker, used only on loopback by this run and dropped after it.
      const session = secret('alx_ses_');
      run(d.db, 'INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(session), t.created_by, now(), new Date(Date.now() + 10 * 60_000).toISOString());
      const rc = makeRunner(d, { worldId: t.world_id, accountId: t.created_by, role: mem.role as Role, token: session, port: req.socket.localPort ?? 0 });
      try {
        const report = await runMacro(rc, m, overrides, `trigger ${t.prefix}`);
        audit(d, t.world_id, t.created_by, 'macro.trigger', `${m.name} (${t.label || t.prefix}) ${report.ok ? 'ok' : 'failed'}`);
        // The caller learns what ran, not what the actions returned.
        res.status(report.ok ? 200 : 424).json({ ok: report.ok, macro: m.name, steps: report.steps.map((s) => ({ index: s.index, action: s.action, status: s.status, error: s.error })) });
      } catch (e: any) {
        res.status(e.status ?? 500).json({ error: String(e.message ?? e).slice(0, 200) });
      } finally {
        run(d.db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(session));
      }
    });
  },

  mcpTools: [
    { name: 'list_macros', description: 'Macros: named sequences of actions (lights, sound, combat, clock...). A player sees only the macros players may run.', props: {}, call: () => ({ method: 'GET', path: '/actions/macros' }) },
    {
      name: 'run_macro', write: true, description: 'Run a macro by name or id. Optional arguments are the macro\'s own parameters. Every run is audited.',
      props: { macro: { type: 'string', description: 'Macro name or id' }, args: { type: 'object', description: 'Values for the macro parameters' } }, required: ['macro'],
      call: (a) => ({ method: 'POST', path: `/actions/macros/${encodeURIComponent(a.macro)}/run`, body: { args: a.args ?? {} } }),
    },
  ],
};
export default feature;
