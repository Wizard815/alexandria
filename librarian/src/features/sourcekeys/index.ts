// Source keys for each player and each world (PLAN §17), and escalation.
//
//   GET    /api/worlds/:w/source-keys                      the keys (DM: all; player: their own) and the sources keys work with
//   POST   /api/worlds/:w/source-keys                      add a key (verified against this world before it is saved)
//   PATCH  /api/worlds/:w/source-keys/:id                  DM: label, trust, users, uses
//   DELETE /api/worlds/:w/source-keys/:id                  revoke (DM: any; player: their own)
//   POST   /api/worlds/:w/source-keys/:id/refresh          read what the key can see ("Refresh my view")
//   POST   /api/worlds/:w/source-keys/:id/probe            DM: compare what the key sees with the DM connection
//   GET    /api/worlds/:w/source-keys/lookup?q=            live lookup through the caller's own keys (MCP: source_lookup)
//   GET    /api/worlds/:w/source-keys/escalations          DM: the queue with hidden context; player: their own questions
//   POST   /api/worlds/:w/source-keys/escalations          a player asks for more than their own view
//   POST   /api/worlds/:w/source-keys/escalations/:eid/{answer,price,refuse}   DM
//   GET/POST/DELETE /api/worlds/:w/library/pages/:id/share  share a page (routes/library.ts mounts share.ts)
//
// World settings: escalation (dm-question | broker-deal), escalationSessions, sourceKeysPlayers.
// See docs/CONNECTORS.md.
import type { Feature } from '../types.ts';
import { all } from '../../core/db.ts';
import { refreshAccess, canFeedLibrary, REFRESH_EVERY_MS } from './access.ts';
import { routes } from './routes.ts';
import { SCHEMA, type KeyRow } from './store.ts';

const enc = encodeURIComponent;

const feature: Feature = {
  id: 'sourcekeys',
  schema: SCHEMA,
  settings: {
    escalation: { type: 'enum', values: ['dm-question', 'broker-deal'], default: 'broker-deal' },
    escalationSessions: { type: 'int', default: 2, min: 0, max: 50 },
    sourceKeysPlayers: { type: 'boolean', default: true },
  },
  worldMount: 'source-keys',
  worldRoutes: (d) => routes(d),
  mcpTools: [
    {
      name: 'source_lookup',
      description: 'Search the world\'s live source (Kanka, LegendKeeper, an API) through YOUR OWN source key. Only pages your key can see are returned, as the copy you may read. If the answer needs more than your view, it is passed to the DM and the reply says so: never guess at it.',
      props: { q: { type: 'string', description: 'What to look for' }, question: { type: 'string', description: 'The full question being answered, for the DM if it has to be escalated' } },
      required: ['q'],
      call: (a) => ({ method: 'GET', path: `/source-keys/lookup?q=${enc(String(a.q ?? ''))}${a.question ? `&question=${enc(String(a.question))}` : ''}` }),
    },
  ],
  // Keys that feed a library view are read again now and then (a refresh is rate limited per key).
  start: (d) => {
    const t = setInterval(() => {
      void (async () => {
        for (const k of all<KeyRow>(d.db, 'SELECT * FROM sourcekeys_keys WHERE revoked = 0 AND verified = 1')) {
          if (!canFeedLibrary(k) || (k.refreshed_at && Date.now() - Date.parse(k.refreshed_at) < 6 * 3600_000 + REFRESH_EVERY_MS)) continue;
          try { await refreshAccess(d, k, 'system'); } catch { /* next time */ }
        }
      })();
    }, 30 * 60_000);
    t.unref();
    return () => clearInterval(t);
  },
};
export default feature;
