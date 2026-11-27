// The gateway admin's read-only summaries (/api/admin/gateway/*, admins only).
//
//   GET /overview      what the Overview page needs on top of /api/admin/overview: people waiting on a GM,
//                      what the guards stopped, devices, recent activity
//   GET /source-keys   every world's source keys and escalated questions, as metadata only
//   GET /guard         the page levels across worlds and what the guards stopped in the last 7 days
//   GET /devices       lights, macros, triggers, microphones and speakers per world (counts and names)
//   GET /leak-check    the runtime leak check's history; POST /leak-check/run starts one (also nightly)
//   GET /worlds        per world: player keys, shares, same-thing suggestions, the source trust setting
//   POST /worlds/:id/links, PUT /worlds/:id/prefs   an admin's decisions for the two last cards
//   GET /search        the admin's search across worlds (party copies unless the admin is that world's GM)
//   GET /mcp           Alexandria's MCP address, tools and the keys that reach it (never a key)
//
// Being an admin does not open a world's secrets. These routes never return a key's secret, the hidden
// context of an escalated question, an answer, page text or the text a guard stopped: only who, when, what
// kind and how many.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import type { DB } from '../../core/db.ts';
import { all, one, run } from '../../core/db.ts';
import { names } from '../../routes/_shared.ts';
import { effectiveStatus, type EscRow } from '../sourcekeys/escalation.ts';
import { keyView, worldKeys } from '../sourcekeys/store.ts';
import type { Auth } from '../../core/auth.ts';
import { HttpError } from '../../core/util.ts';
import { SCHEMA as LEAK_SCHEMA, closeStale, lastFinished, listRuns, startRun } from './leakcheck.ts';
import { SCHEMA as WORLD_SCHEMA, setLink, setPrefs, worldCards } from './worlds.ts';
import { adminSearch, mcpAccess } from './adminview.ts';
import { adminHasDefaultPassword } from './security.ts';

const count = (db: DB, sql: string, ...args: unknown[]): number => {
  try { return one<{ n: number }>(db, sql, ...args)?.n ?? 0; } catch { return 0; } // a table of a feature that is not installed
};
const rows = <T>(db: DB, sql: string, ...args: unknown[]): T[] => { try { return all<T>(db, sql, ...args); } catch { return []; } };
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

/** What the guards stopped. The detail text of these audit rows can hold GM-only words, so only the kind and the job are kept. */
const GUARD_ACTIONS = ['agent.leak_blocked', 'ai.classified_refused'];
function guardEvents(db: DB, since: string, limit: number) {
  return rows<any>(db, `SELECT a.id, a.action, a.detail, a.at, w.name AS world FROM audit a LEFT JOIN worlds w ON w.id = a.world_id
    WHERE a.action IN (${GUARD_ACTIONS.map(() => '?').join(',')}) AND a.at >= ? ORDER BY a.id DESC LIMIT ?`, ...GUARD_ACTIONS, since, limit)
    .map((e) => ({
      id: e.id, at: e.at, world: e.world ?? null, kind: e.action === 'agent.leak_blocked' ? 'player-reply' : 'model-request',
      what: e.action === 'agent.leak_blocked'
        ? 'A player agent reply repeated text only the GM may see; it was replaced.'
        : `A model request (${String(e.detail).split(' ')[0] || 'job'}) carried classified text and was refused before sending.`,
    }));
}

/** Activity worth showing on the overview. Detail text is left out. */
const ACTIVITY: Record<string, string> = {
  'world.create': 'World created', 'world.delete': 'World deleted', 'world.crawl': 'Crawl started', 'world.reindex': 'Search re-indexed',
  'source.sync': 'Source synced', 'source.create': 'Source added', 'source.delete': 'Source removed', 'source.update': 'Source changed',
  'source.audience': 'Source audience changed', 'source.tiers': 'Crawl budget changed', 'sourcekeys.add': 'Source key added', 'sourcekeys.revoke': 'Source key revoked',
  'sourcekeys.escalate': 'A question needed hidden information', 'member.set': 'Member role set', 'member.remove': 'Member removed',
  'agent.leak_blocked': 'Guard replaced a player agent reply', 'ai.classified_refused': 'Guard refused a model request', 'password.reset': 'Password reset', 'gateway.leak_found': 'Leak check found a leak',
};

const feature: Feature = {
  id: 'gateway',
  schema: LEAK_SCHEMA + WORLD_SCHEMA,
  // The leak check, once a day. Not started in tests.
  start: (d: Deps) => {
    closeStale(d.db);
    const t = setInterval(() => {
      const last = one<{ at: string | null }>(d.db, `SELECT MAX(started_at) AS at FROM gateway_leak_runs`)?.at;
      if (!last || Date.now() - Date.parse(last) > 23 * 3600e3) startRun(d, 'nightly');
    }, 30 * 60e3);
    t.unref?.();
    return () => clearInterval(t);
  },
  adminMount: 'gateway',
  adminRoutes: (d: Deps) => {
    const r = Router();
    const { db } = d;

    r.get('/overview', (_req, res) => {
      const roles = rows<{ role: string; n: number }>(db, 'SELECT role, COUNT(DISTINCT account_id) AS n FROM members GROUP BY role');
      const open = rows<EscRow>(db, `SELECT * FROM sourcekeys_escalations WHERE status = 'open'`).filter((e) => effectiveStatus(d, e) === 'open');
      res.json({
        waiting: {
          questions: open.filter((e) => !e.broker_request_id).length,
          brokerDeals: count(db, `SELECT COUNT(*) AS n FROM broker_requests WHERE status = 'pricing'`),
        },
        roles: Object.fromEntries(roles.map((x) => [x.role, x.n])),
        security: { defaultAdminPassword: adminHasDefaultPassword(db) },
        leak: (() => {
          const l = lastFinished(db);
          return l ? { at: l.finishedAt, leaks: l.leaks, status: l.status, pages: l.pages, viewers: l.viewers, error: l.error } : null;
        })(),
        guard: { blocked7d: guardEvents(db, ago(7), 1000).length, last: guardEvents(db, ago(7), 1)[0]?.at ?? null },
        devices: {
          lights: count(db, 'SELECT COUNT(*) AS n FROM lights_drivers WHERE enabled = 1'),
          macros: count(db, 'SELECT COUNT(*) AS n FROM actions_macros'),
          triggers: count(db, 'SELECT COUNT(*) AS n FROM actions_triggers WHERE revoked = 0'),
          mics: count(db, 'SELECT COUNT(*) AS n FROM audio_mics'),
          speakers: count(db, 'SELECT COUNT(*) AS n FROM sound_listeners WHERE music = 1 OR ambience = 1 OR sfx = 1'),
          speakersConnected: count(db, 'SELECT COUNT(*) AS n FROM sound_listeners WHERE (music = 1 OR ambience = 1 OR sfx = 1) AND seen_at >= ?', ago(1)),
        },
        activity: rows<any>(db, `SELECT a.id, a.action, a.at, w.name AS world FROM audit a LEFT JOIN worlds w ON w.id = a.world_id
          WHERE a.action IN (${Object.keys(ACTIVITY).map(() => '?').join(',')}) ORDER BY a.id DESC LIMIT 8`, ...Object.keys(ACTIVITY))
          .map((a) => ({ id: a.id, at: a.at, world: a.world ?? null, what: ACTIVITY[a.action] })),
      });
    });

    r.get('/source-keys', (_req, res) => {
      const worlds = all<{ id: string; name: string; slug: string }>(db, 'SELECT id, name, slug FROM worlds ORDER BY name');
      res.json({
        worlds: worlds.map((w) => {
          const nm = names(db, w.id);
          const keys = worldKeys(db, w.id).filter((k) => !k.revoked).map((k) => {
            const v = keyView(db, k, nm, { dm: false }) as Record<string, any>;
            return { ...v, userNames: (v.users as string[]).map((u) => nm[u] ?? 'Someone') };
          });
          const escalations = rows<EscRow>(db, 'SELECT * FROM sourcekeys_escalations WHERE world_id = ? ORDER BY created_at DESC LIMIT 100', w.id).map((e) => ({
            id: e.id, asker: nm[e.account_id] ?? 'Someone', question: e.question, origin: e.origin, mode: e.mode, status: effectiveStatus(d, e),
            costCp: e.cost_cp, sessions: e.sessions, createdAt: e.created_at, resolvedAt: e.resolved_at,
          }));
          return { ...w, keys, escalations };
        }),
      });
    });

    r.get('/guard', (_req, res) => {
      const levels = { party: 0, broker: 0, dm: 0, classified: 0 };
      for (const x of rows<{ visibility: string; n: number }>(db, 'SELECT visibility, COUNT(*) AS n FROM pages GROUP BY visibility')) {
        if (x.visibility in levels) (levels as any)[x.visibility] += x.n; else levels.dm += x.n;
      }
      res.json({
        levels,
        blanketKeys: count(db, `SELECT COUNT(*) AS n FROM sourcekeys_keys WHERE revoked = 0 AND trust <> 'per-user'`),
        perUserKeys: count(db, `SELECT COUNT(*) AS n FROM sourcekeys_keys WHERE revoked = 0 AND trust = 'per-user'`),
        events: guardEvents(db, ago(7), 50), since: ago(7),
      });
    });

    r.get('/devices', (_req, res) => {
      res.json({
        worlds: all<{ id: string; name: string }>(db, 'SELECT id, name FROM worlds ORDER BY name').map((w) => ({
          id: w.id, name: w.name,
          lights: rows<any>(db, 'SELECT kind, name, enabled FROM lights_drivers WHERE world_id = ? ORDER BY name', w.id).map((l) => ({ kind: l.kind, name: l.name, enabled: !!l.enabled })),
          macros: count(db, 'SELECT COUNT(*) AS n FROM actions_macros WHERE world_id = ?', w.id),
          triggers: count(db, 'SELECT COUNT(*) AS n FROM actions_triggers WHERE world_id = ? AND revoked = 0', w.id),
          mics: rows<any>(db, 'SELECT label, mode FROM audio_mics WHERE world_id = ? ORDER BY label', w.id).map((m) => ({ label: m.label, mode: m.mode })),
          // A speaker is a browser or app that told the sound board it plays music, ambience or effects. Seen in the last day counts as connected.
          speakers: rows<any>(db, 'SELECT label, seen_at FROM sound_listeners WHERE world_id = ? AND (music = 1 OR ambience = 1 OR sfx = 1) ORDER BY seen_at DESC', w.id)
            .map((s) => ({ label: s.label || 'Unnamed device', seenAt: s.seen_at, connected: s.seen_at >= ago(1) })),
        })),
        // Nothing registers the GM desktop app with the gateway yet, so there is no count to give.
        desktopApps: null,
      });
    });

    r.get('/leak-check', (_req, res) => {
      const runs = listRuns(db, 20);
      res.json({ running: runs[0]?.status === 'running', runs, last: lastFinished(db) });
    });
    r.post('/leak-check/run', (req, res) => {
      const auth = res.locals.auth as Auth;
      const r2 = startRun(d, 'manual');
      if (r2.started) run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (NULL, ?, ?, ?, ?)', auth.account.id, 'gateway.leakcheck', 'run now', new Date().toISOString());
      res.status(202).json(r2);
    });

    r.get('/worlds', (_req, res) => {
      const me = (res.locals.auth as Auth).account.id;
      res.json({ worlds: all<{ id: string }>(db, 'SELECT id FROM worlds ORDER BY name').map((w) => ({ id: w.id, ...worldCards(d, w.id, me) })) });
    });
    const worldOf = (id: unknown) => { if (!one(db, 'SELECT 1 FROM worlds WHERE id = ?', id)) throw new HttpError(404, 'World not found'); return String(id); };
    r.post('/worlds/:id/links', (req, res) => {
      const w = worldOf(req.params.id);
      setLink(d, w, (res.locals.auth as Auth).account.id, req.body?.a, req.body?.b, req.body?.status);
      res.json(worldCards(d, w, (res.locals.auth as Auth).account.id).sameThing);
    });
    r.put('/worlds/:id/prefs', (req, res) => {
      const w = worldOf(req.params.id);
      setPrefs(d, w, (res.locals.auth as Auth).account.id, req.body);
      res.json(worldCards(d, w, (res.locals.auth as Auth).account.id).disagree);
    });

    r.get('/search', (req, res) => res.json(adminSearch(d, (res.locals.auth as Auth).account.id, req.query)));
    r.get('/mcp', async (_req, res) => res.json(await mcpAccess(d)));
    return r;
  },
};
export default feature;
