# Adding a feature

New work goes in its own folder, on the server and in the app. You don't
edit the central files (`app.ts`, `db.ts`, `policy.ts`, `mcpServer.ts`,
`App.tsx`, the layouts, World settings, the home pages); the registries
pick features up on their own.

## Server: `librarian/src/features/<id>/index.ts`

Default-export a `Feature` (`librarian/src/features/types.ts`):

```ts
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { ctx, settings, isDM } from '../../routes/_shared.ts';
import { featureSetting } from '../../core/policy.ts';

const feature: Feature = {
  id: 'clock',
  schema: `CREATE TABLE IF NOT EXISTS world_clock (world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE, minutes INTEGER NOT NULL DEFAULT 0);`,
  migrate(db) { /* ALTER TABLE ... ADD COLUMN after a PRAGMA table_info check */ },
  settings: { longRestMode: { type: 'enum', values: ['8h', 'morning'], default: 'morning' } },
  worldMount: 'clock',                      // /api/worlds/:world/clock
  worldRoutes: (d) => { const r = Router(); r.get('/', (_req, res) => res.json({ /* ... */ })); return r; },
  adminMount: 'models',                     // /api/admin/models (admins only)
  adminRoutes: (d) => Router(),
  appRoutes: (app, d) => { /* public routes, e.g. /admin/login API */ },
  mcpTools: [{ name: 'get_world_date', description: '…', props: {}, call: () => ({ method: 'GET', path: '/clock' }) }],
  start: (d) => { const t = setInterval(() => {}, 60_000); return () => clearInterval(t); },
  dataDirs: ['audio'],                      // under ALX_DATA_DIR; included in backups
};
export default feature;
```

- **Tables:**
  - Use `CREATE TABLE IF NOT EXISTS`.
  - Prefix table names with the feature, e.g. `clock_`, `audio_`.
  - Reference `worlds(id) ON DELETE CASCADE`.
- **Settings:** read them with `featureSetting(settings(res), 'key')`. The
  DM changes them through the normal `PATCH /settings`, which validates
  them from your spec.
- **Live updates:** `d.hub.emit(worldId, 'type', payload, filter)`. Use a
  filter for anything not everyone may see.
- **Models:** always go through `librarian/src/core/ai.ts`: `chat`,
  `chatJson`, `transcribe`, `speak`, `embed`. They throw `ModelUnavailable`
  when a job has no model; catch it and fall back.
- **Players never see DM-only content.**
  - Anything you return to a player must be built from player copies
    (`player_blocks`, `player_md`, player properties) or from rows the
    player may see.
  - Add a test that tries to leak DM text and fails to.
- **Import `app.ts` as a type only** (`import type { Deps } from '../../app.ts'`).
  A runtime import of `app.ts` from a feature hangs startup: the registry
  loads features with a top-level `await`. Write audit rows with `run()`
  from `core/db.ts`.
- **Tests:** `librarian/test/<id>.test.ts` (node:test). Use
  `createApp({ noScheduler: true })` and fake models with
  `createApp({ fetch })`.

## App: `web/src/features/<id>/index.tsx`

Default-export a `WebFeature` (`web/src/features/registry.ts`):

```tsx
import type { WebFeature } from '../registry.ts';
const feature: WebFeature = {
  id: 'clock',
  dmRoutes: [{ path: 'clock', element: <ClockPage /> }],        // /w/:world/dm/clock
  playerRoutes: [{ path: 'log', element: <SessionLog /> }],     // /w/:world/log
  dmNav: [{ group: 'At the table', to: 'clock', label: '☾ World clock' }],
  playerNav: [{ to: 'log', label: 'Session log', icon: 'fa-scroll' }],
  settings: { title: 'World clock', component: ClockSettings }, // a tab in World settings
  dmHome: [TodayCard], playerHome: [TodayCard],                 // cards on the home pages
  topbar: WorldDate,                                            // next to the world name
  overlay: TranscriptIsland,                                    // on every DM and player page
};
export default feature;
```

- Call your endpoints with `const { w } = useWorld(); w.call('GET', '/clock')`.
- Use `useLoad(fn, deps, ['event-type'])` so screens update live.
- UI pieces are in `web/src/ui/index.tsx`.
