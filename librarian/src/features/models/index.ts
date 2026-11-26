// Admin → Models: providers (where models live) and the model jobs (core/ai.ts)
// that pick a provider and a model, with an optional fallback.
//
// Saved settings win; a job with nothing saved (or switched off) falls back to
// the environment (ALX_MODEL_<JOB>_URL ...). API keys are write-only.
//
//   GET    /api/admin/models                      { jobs, providers }
//   PUT    /api/admin/models                      { jobs: { chat: { providerId, model, options, enabled, gameNight, fallback } } } (keepWarm: old name for gameNight)
//   GET    /api/admin/models/status               loaded / unloaded per job and provider (asks the servers)
//   POST   /api/admin/models/providers            add a provider
//   PUT    /api/admin/models/providers/:id        change one (apiKey "••••" or missing keeps the key)
//   DELETE /api/admin/models/providers/:id
//   POST   /api/admin/models/discover             list a provider's models and suggest a model per job
//   GET    /api/admin/models/providers/:id/voices preset voices (Argos GET /v1/audio/voices)
//   POST   /api/admin/models/:job/test            ?which=fallback tests the fallback
//   POST   /api/admin/models/:job/warm            a tiny request so the model is loaded
//   GET    /api/admin/models/lifecycle            game night: phase, why it is live, held models, per provider backend (probed once, cached), per job policy
//   PUT    /api/admin/models/lifecycle            { graceMinutes, policies: { chat: 'hold' | 'ondemand' } }
//   POST   /api/admin/models/game-night/start     the DM's "Start game night" (also what the Start test button does)
//   POST   /api/admin/models/game-night/end       { now: true } skips the grace period
//   POST   /api/admin/models/providers/:id/detect probe the backend type again (PUT a provider with { backend } to override)
//   POST   /api/admin/models/unload-all           "Release models now": each job model on a backend that can unload
//   GET    /api/admin/models/vram                 per Argos provider: GET /api/pool + /running, the job-model budget, the config snippets
//   GET    /api/admin/models/queue                running and waiting per model, and the DM-first setting
//   PUT    /api/admin/models/dm-first             { preempt, reserve, holdPlayers }: how hard the DM's requests go first (core/ai.ts)
//   GET    /api/worlds/:world/models/ready        DM only: which local jobs are ready (for the table page card)
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts'; // type only: a runtime import would deadlock the registry's top-level await
import { all, one, run, type DB } from '../../core/db.ts';
import { requireDM, type Auth } from '../../core/auth.ts';
import { HttpError, now } from '../../core/util.ts';
import { ALL_JOBS, CHAT_PARTS, JOBS, activeJobs, ownJobConfig, chat, chainFor, gateStats, embed, normalizeDmFirst, setDmFirstResolver, DM_FIRST_DEFAULTS, type DmFirst, jobConfig, inferLocation, pinned, rerank, setJobResolver, speak, transcribe, ModelUnavailable, type Job, type JobConfig, type Location } from '../../core/ai.ts';
import { argosWebUrl, discover, fetchVoices, listModels, type ModelStatus } from './argos.ts';
import { testJob } from './probe.ts';
import { argosSnippets, budgetFor, readArgos } from './pool.ts';
import { attachSessionEvents, getLifecycleSettings, getPolicy, lifecycleTick, lifecycleView, localJobs, releaseNow, setLifecycleSettings, setManual, setPolicy, startLifecycle, targetsFor, unloadEverything, warmSnapshot, POLICY_DEFAULTS, sessionLive } from './lifecycle.ts';
import { BACKENDS, backendOf, cachedBackend, describeBackend, isHosted, providerSettings, setProviderSettings } from './backends.ts';
import { KINDS, MASK, createProvider, getProvider, guessKind, listProviders, metaGet, metaSet, migrateJobsToProviders, normalizeBase, type Kind, type ProviderRow } from './providers.ts';

export { MASK };
export { argosWebUrl, discover, suggestJobs, normalizeModel } from './argos.ts';

interface Row {
  job: string; base_url: string; model: string; api_key: string; options: string; enabled: number; updated_at: string;
  provider_id: string; fallback_provider_id: string; fallback_model: string; fallback_options: string; allow_cloud_fallback: number; keep_warm: number;
}

const USES: Record<Job, string> = {
  chat: 'DM agent, player Ask, broker answers, summaries',
  audit: 'Question routing and spoiler checks (small model)',
  audio: 'Speech to text',
  voice: 'Text to speech',
  extra: 'Embeddings for search and matching',
  rerank: 'Optional: reorders the top search results (stays out of the way when slow)',
  dm: 'The DM’s assistant. Not set: the Chat model',
  player: 'What players ask: the broker and their helper. Not set: the Chat model',
  bible: 'Reading pages for the story bible. Not set: the Chat model',
  helper: 'The players’ quick helper: a small model (4B or less) for rules, turn options and sheet summaries. Not set: the Players model',
};

const saved = (d: Deps, job: Job) => one<Row>(d.db, 'SELECT * FROM models_jobs WHERE job = ?', job);
const audit = (d: Deps, accountId: string | null, action: string, detail: string) =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (NULL, ?, ?, ?, ?)', accountId, action, detail, now());
const who = (res: any) => (res.locals.auth as Auth).account.id;

function parseOptions(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

function cfgOf(p: ProviderRow, model: string, options: Record<string, unknown>): JobConfig {
  return {
    baseUrl: p.base_url.replace(/\/$/, ''), apiKey: p.api_key || undefined, model: model || 'default',
    options: Object.keys(options).length ? options : undefined, providerId: p.id, location: p.location,
  };
}

function fromSaved(d: Deps, job: Job): JobConfig | null {
  const r = saved(d, job);
  if (!r || !r.enabled) return null;
  if (r.provider_id) {
    const p = getProvider(d.db, r.provider_id);
    if (!p) return null;
    const c = cfgOf(p, r.model, parseOptions(r.options));
    const fp = getProvider(d.db, r.fallback_provider_id);
    if (fp) { c.fallback = cfgOf(fp, r.fallback_model || r.model, parseOptions(r.fallback_options)); c.allowCloudFallback = !!r.allow_cloud_fallback; }
    return c;
  }
  if (!r.base_url) return null;
  const opts = parseOptions(r.options);
  return { baseUrl: r.base_url.replace(/\/$/, ''), apiKey: r.api_key || undefined, model: r.model || 'default', options: Object.keys(opts).length ? opts : undefined };
}

// Set when the feature loads. A null answer makes jobConfig() use the environment.
setJobResolver((d, job) => fromSaved(d, job));
/** How hard the DM's requests go first (core/ai.ts, the queue), saved in Admin → Models → GPU & queue. */
export function getDmFirst(db: DB): DmFirst {
  try { return normalizeDmFirst(JSON.parse(metaGet(db, 'dm_first') ?? 'null')); } catch { return DM_FIRST_DEFAULTS; }
}
// Read on every model call: one small row, and a change takes effect for the next request.
setDmFirstResolver((d) => (d.db ? getDmFirst(d.db) : DM_FIRST_DEFAULTS));

const usedBy = (d: Deps, pid: string): Job[] =>
  all<Row>(d.db, 'SELECT job, provider_id, fallback_provider_id FROM models_jobs WHERE provider_id = ? OR fallback_provider_id = ?', pid, pid).map((r) => r.job as Job);

function providerView(d: Deps, p: ProviderRow) {
  return {
    id: p.id, name: p.name, kind: p.kind, baseUrl: p.base_url, apiKey: p.api_key ? MASK : '', location: p.location,
    ...(p.kind === 'argos' ? { webUrl: argosWebUrl(p.base_url) } : {}),
    usedBy: usedBy(d, p.id),
    backend: { ...describeBackend(cachedBackend(d, p.id, p.base_url)?.backend ?? (p.location === 'cloud' || p.kind === 'openai' ? 'hosted' : 'generic'), providerSettings(d, p.id)), detected: cachedBackend(d, p.id, p.base_url)?.backend ?? null, override: providerSettings(d, p.id).backend, ttl: providerSettings(d, p.id).ttl, pingMinutes: providerSettings(d, p.id).pingMinutes },
  };
}

/** The model last saved for this job on a local and on a cloud provider, so switching back is one click. */
function lastChoices(d: Deps, job: Job): Record<Location, { providerId: string; model: string } | null> {
  const get = (loc: Location) => {
    try {
      const j = JSON.parse(metaGet(d.db, `last:${job}:${loc}`) ?? 'null');
      const p = j?.providerId ? getProvider(d.db, String(j.providerId)) : undefined;
      return p && p.location === loc ? { providerId: p.id, model: String(j.model ?? '') } : null;
    } catch { return null; }
  };
  return { local: get('local'), cloud: get('cloud') };
}

function view(d: Deps, job: Job) {
  const r = saved(d, job);
  const effective = jobConfig(d, job);
  const p = r ? getProvider(d.db, r.provider_id) : undefined;
  const source = r && r.enabled && (p || r.base_url) ? 'saved' : CHAT_PARTS.includes(job) && !ownJobConfig(d, job) ? 'chat' : effective ? 'env' : 'none';
  const fp = r ? getProvider(d.db, r.fallback_provider_id) : undefined;
  const chain = chainFor(d, job);
  // A cloud fallback behind a local provider stays unused until the admin allows text to leave this server.
  const blocked = !!(effective?.fallback && chain.length < 2);
  const key = p ? p.api_key : r?.api_key;
  return {
    job,
    uses: USES[job],
    providerId: p?.id ?? '',
    baseUrl: p?.base_url ?? r?.base_url ?? '',
    model: r?.model ?? '',
    apiKey: key ? MASK : '',
    options: r ? parseOptions(r.options) : {},
    enabled: r ? !!r.enabled : true,
    gameNight: getPolicy(d.db, job),
    fallback: fp ? { providerId: fp.id, model: r!.fallback_model, options: parseOptions(r!.fallback_options), allowCloud: !!r!.allow_cloud_fallback, location: fp.location } : null,
    location: (p?.location ?? (effective ? effective.location ?? inferLocation(effective.baseUrl) : null)) as Location | null,
    lastChoice: lastChoices(d, job),
    fallbackBlocked: blocked,
    source,
    effective: effective ? { baseUrl: effective.baseUrl, model: effective.model, hasKey: !!effective.apiKey, provider: p?.name ?? null, location: effective.location ?? inferLocation(effective.baseUrl), hasFallback: chain.length > 1 } : null,
  };
}

function parseOpts(v: unknown): string {
  if (v === undefined || v === null || v === '') return '{}';
  let o: unknown = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { throw new HttpError(400, 'Extra options must be valid JSON'); } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, 'Extra options must be a JSON object');
  return JSON.stringify(o);
}

const parseKind = (v: unknown): Kind => {
  if (!(KINDS as readonly string[]).includes(String(v))) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
  return v as Kind;
};
const parseLocation = (v: unknown): Location => {
  if (v !== 'local' && v !== 'cloud') throw new HttpError(400, 'location must be "local" or "cloud"');
  return v;
};

// ---- status: is the model loaded? ---------------------------------------------

type Seen = ModelStatus | 'missing' | 'unreachable';

async function statusOf(d: Deps) {
  const rows = all<Row>(d.db, 'SELECT * FROM models_jobs WHERE enabled = 1 AND provider_id <> ?', '');
  const ids = new Set<string>();
  for (const r of rows) { ids.add(r.provider_id); if (r.fallback_provider_id) ids.add(r.fallback_provider_id); }
  const providers: Record<string, { ok: boolean; error?: string; models: { id: string; status: ModelStatus }[] }> = {};
  await Promise.all([...ids].map(async (pid) => {
    const p = getProvider(d.db, pid);
    if (!p) return;
    try { providers[pid] = { ok: true, models: (await listModels(d, { baseUrl: p.base_url, apiKey: p.api_key || undefined })).map((m) => ({ id: m.id, status: m.status })) }; }
    catch (err: any) { providers[pid] = { ok: false, error: String(err?.message ?? err).slice(0, 200), models: [] }; }
  }));
  const seen = (pid: string, model: string): Seen => {
    const s = providers[pid];
    if (!s) return 'unreachable';
    if (!s.ok) return 'unreachable';
    return s.models.find((m) => m.id === model)?.status ?? 'missing';
  };
  const jobs: Record<string, { primary?: Seen; fallback?: Seen }> = {};
  for (const r of rows) {
    jobs[r.job] = { primary: seen(r.provider_id, r.model) };
    if (r.fallback_provider_id) jobs[r.job].fallback = seen(r.fallback_provider_id, r.fallback_model || r.model);
  }
  return { providers, jobs };
}

/** Preset voice names for the voice job from Argos (GET /v1/audio/voices); [] when the voice job is not on an Argos provider or it lists none. */
export async function listVoiceNames(d: Deps): Promise<string[]> {
  const r = saved(d, 'voice');
  const p = r && r.enabled ? getProvider(d.db, r.provider_id) : undefined;
  if (!p || p.kind !== 'argos') return [];
  try { return await fetchVoices(d, { baseUrl: p.base_url, apiKey: p.api_key || undefined }, r!.model || undefined); } catch { return []; }
}

// ---- the feature ------------------------------------------------------------------

const feature: Feature = {
  id: 'models',
  schema: `CREATE TABLE IF NOT EXISTS models_jobs (
    job TEXT PRIMARY KEY,
    base_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  migrate(db) {
    const cols = new Set((db.prepare('PRAGMA table_info(models_jobs)').all() as any[]).map((c) => c.name));
    const add = (name: string, def: string) => { if (!cols.has(name)) db.exec(`ALTER TABLE models_jobs ADD COLUMN ${name} ${def}`); };
    add('provider_id', "TEXT NOT NULL DEFAULT ''");
    add('fallback_provider_id', "TEXT NOT NULL DEFAULT ''");
    add('fallback_model', "TEXT NOT NULL DEFAULT ''");
    add('fallback_options', "TEXT NOT NULL DEFAULT '{}'");
    add('allow_cloud_fallback', 'INTEGER NOT NULL DEFAULT 0');
    add('keep_warm', 'INTEGER NOT NULL DEFAULT 0');
    migrateJobsToProviders(db);
  },
  // Listening for session start and end is the only thing this does (no routes).
  appRoutes: (_app, d) => { attachSessionEvents(d); },
  // The table page card: which local jobs are ready. DM only; job names and states, nothing from the world.
  worldMount: 'models',
  worldRoutes: (d) => {
    const r = Router();
    r.get('/ready', requireDM, (_req, res) => {
      const v = lifecycleView(d);
      res.json({ enabled: v.live || v.phase !== 'off', phase: v.phase, jobs: warmSnapshot(d) });
    });
    return r;
  },
  adminMount: 'models',
  adminRoutes: (d) => {
    const r = Router();
    const all6 = () => ({ jobs: ALL_JOBS.map((j) => view(d, j)), providers: listProviders(d.db).map((p) => providerView(d, p)) });
    r.get('/', (_req, res) => res.json(all6()));

    r.get('/status', async (_req, res) => res.json(await statusOf(d)));
    // The queue in front of each model right now: how many requests run and how many wait (core/ai.ts).
    r.get('/queue', (_req, res) => res.json({ models: gateStats(), dmFirst: getDmFirst(d.db) }));
    r.put('/dm-first', (req, res) => {
      const b = req.body ?? {};
      if (b.preempt !== undefined && typeof b.preempt !== 'boolean') throw new HttpError(400, 'preempt must be true or false');
      if (b.holdPlayers !== undefined && typeof b.holdPlayers !== 'boolean') throw new HttpError(400, 'holdPlayers must be true or false');
      if (b.reserve !== undefined && !(Number.isInteger(b.reserve) && b.reserve >= 0 && b.reserve <= 8)) throw new HttpError(400, 'reserve must be a whole number from 0 to 8');
      const next = normalizeDmFirst(b, getDmFirst(d.db));
      metaSet(d.db, 'dm_first', JSON.stringify(next));
      audit(d, who(res), 'models.dm_first', JSON.stringify(next));
      res.json({ models: gateStats(), dmFirst: next });
    });

    // ---- providers
    r.post('/providers', (req, res) => {
      const b = req.body ?? {};
      const kind = parseKind(b.kind ?? 'openai-compatible');
      const baseUrl = normalizeBase(kind, b.baseUrl ?? b.address);
      const p = createProvider(d.db, { name: b.name, kind, baseUrl, apiKey: b.apiKey && b.apiKey !== MASK ? String(b.apiKey) : '', location: b.location === undefined ? undefined : parseLocation(b.location) });
      audit(d, who(res), 'models.provider.create', `${p.name} (${p.kind}, ${p.location})`);
      res.status(201).json({ provider: providerView(d, p), ...all6() });
    });

    r.put('/providers/:id', (req, res) => {
      const cur = getProvider(d.db, String(req.params.id));
      if (!cur) throw new HttpError(404, 'No such provider');
      const b = req.body ?? {};
      const kind = b.kind !== undefined ? parseKind(b.kind) : cur.kind;
      const next: ProviderRow = { ...cur, kind, updated_at: now() };
      if (b.name !== undefined) next.name = String(b.name).trim().slice(0, 80) || cur.name;
      if (b.baseUrl !== undefined || b.kind !== undefined) next.base_url = normalizeBase(kind, b.baseUrl ?? cur.base_url);
      if (b.apiKey !== undefined && b.apiKey !== MASK) next.api_key = String(b.apiKey).trim().slice(0, 500);
      if (b.location !== undefined) next.location = parseLocation(b.location);
      run(d.db, 'UPDATE models_providers SET name=?, kind=?, base_url=?, api_key=?, location=?, updated_at=? WHERE id=?', next.name, next.kind, next.base_url, next.api_key, next.location, next.updated_at, next.id);
      if (b.backend !== undefined || b.ttl !== undefined || b.pingMinutes !== undefined) setProviderSettings(d, next.id, b);
      audit(d, who(res), 'models.provider.update', `${next.name}${b.apiKey !== undefined && b.apiKey !== MASK ? ' (key changed)' : ''}`);
      res.json({ provider: providerView(d, next), ...all6() });
    });

    r.delete('/providers/:id', (req, res) => {
      const cur = getProvider(d.db, String(req.params.id));
      if (!cur) throw new HttpError(404, 'No such provider');
      const used = usedBy(d, cur.id);
      if (used.length) throw new HttpError(409, `${cur.name} is used by ${used.join(', ')}. Point those jobs somewhere else first.`);
      run(d.db, 'DELETE FROM models_providers WHERE id = ?', cur.id);
      audit(d, who(res), 'models.provider.delete', cur.name);
      res.json(all6());
    });

    r.get('/providers/:id/voices', async (req, res) => {
      const p = getProvider(d.db, String(req.params.id));
      if (!p) throw new HttpError(404, 'No such provider');
      try { res.json({ voices: await fetchVoices(d, { baseUrl: p.base_url, apiKey: p.api_key || undefined }, typeof req.query.model === 'string' ? req.query.model : undefined) }); }
      catch (err: any) { res.json({ voices: [], error: String(err?.message ?? err).slice(0, 200) }); }
    });

    // Discover: { providerId } for a saved provider, or { baseUrl, apiKey?, kind? } for one not saved yet (the Argos preset).
    r.post('/discover', async (req, res) => {
      const b = req.body ?? {};
      let baseUrl: string;
      let apiKey: string | undefined;
      let kind: Kind;
      if (b.providerId) {
        const p = getProvider(d.db, String(b.providerId));
        if (!p) throw new HttpError(404, 'No such provider');
        baseUrl = p.base_url; apiKey = p.api_key || undefined; kind = p.kind;
        if (b.apiKey !== undefined && b.apiKey !== MASK) apiKey = String(b.apiKey).trim() || undefined;
      } else {
        kind = b.kind === undefined ? 'argos' : parseKind(b.kind);
        baseUrl = normalizeBase(kind, b.baseUrl ?? b.address);
        apiKey = b.apiKey && b.apiKey !== MASK ? String(b.apiKey).trim() : undefined;
      }
      try {
        const found = await discover(d, { baseUrl, apiKey });
        res.json({ ok: true, baseUrl, ...(kind === 'argos' ? { webUrl: argosWebUrl(baseUrl) } : {}), ...found });
      } catch (err: any) {
        res.json({ ok: false, baseUrl, error: String(err?.message ?? err).slice(0, 300), models: [], voices: [] });
      }
    });

    // ---- jobs
    // Body: { jobs: { chat: { providerId, model, options, enabled, gameNight: 'hold' | 'ondemand', fallback: { providerId, model, options, allowCloud } | null } } }.
    // The old shape { baseUrl, apiKey } still works: it finds or makes a provider for that URL.
    // Only the jobs and fields sent change. apiKey "••••" or missing keeps the saved key; "" clears it.
    r.put('/', (req, res) => {
      const body = req.body?.jobs;
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Send { jobs: { chat: {...} } }');
      const entries: [string, any][] = Array.isArray(body) ? body.map((b: any) => [String(b?.job), b]) : Object.entries(body);
      const plan: { job: Job; row: Row; setKeyOn?: { id: string; key: string }; cloudOn?: boolean; policy?: 'hold' | 'ondemand' }[] = [];
      for (const [name, b] of entries) {
        if (!(ALL_JOBS as string[]).includes(name)) throw new HttpError(400, `Unknown job "${name.slice(0, 20)}"`);
        const job = name as Job;
        if (!b || typeof b !== 'object') throw new HttpError(400, `Settings for ${job} must be an object`);
        const cur = saved(d, job);
        const row: Row = cur ? { ...cur } : { job, base_url: '', model: '', api_key: '', options: '{}', enabled: 1, updated_at: '', provider_id: '', fallback_provider_id: '', fallback_model: '', fallback_options: '{}', allow_cloud_fallback: 0, keep_warm: 0 };
        const step: (typeof plan)[number] = { job, row };

        if (b.providerId !== undefined) {
          const pid = String(b.providerId);
          if (pid && !getProvider(d.db, pid)) throw new HttpError(400, `No provider "${pid.slice(0, 30)}"`);
          row.provider_id = pid;
          row.base_url = ''; row.api_key = '';
        }
        if (b.baseUrl !== undefined) {
          const raw = String(b.baseUrl ?? '').trim();
          if (!raw) { row.provider_id = ''; row.base_url = ''; row.api_key = ''; }
          else {
            const guess = guessKind(raw.replace(/\/+$/, ''));
            const base = normalizeBase(guess, raw);
            const here = getProvider(d.db, row.provider_id);
            const key = b.apiKey !== undefined && b.apiKey !== MASK ? String(b.apiKey).trim().slice(0, 500) : undefined;
            let p: ProviderRow | undefined;
            if (here && here.base_url === base && (key === undefined || key === here.api_key)) p = here;
            else p = listProviders(d.db).find((x) => x.base_url === base && x.api_key === (key ?? ''));
            if (!p) p = createProvider(d.db, { kind: guess, baseUrl: base, apiKey: key ?? '' });
            row.provider_id = p.id; row.base_url = ''; row.api_key = '';
          }
        } else if (b.apiKey !== undefined && b.apiKey !== MASK) {
          // A key on a job: it belongs to the provider. A provider shared with other jobs is split first, so this job alone changes.
          const here = getProvider(d.db, row.provider_id);
          if (here) {
            const key = String(b.apiKey).trim().slice(0, 500);
            const others = usedBy(d, here.id).filter((j) => j !== job).length;
            if (others) { const copy = createProvider(d.db, { kind: here.kind, baseUrl: here.base_url, apiKey: key, name: `${here.name} (key)`, location: here.location }); row.provider_id = copy.id; }
            else step.setKeyOn = { id: here.id, key };
          } else row.api_key = String(b.apiKey).trim().slice(0, 500);
        }
        if (b.model !== undefined) row.model = String(b.model).trim().slice(0, 200);
        if (b.options !== undefined) row.options = parseOpts(b.options);
        if (b.enabled !== undefined) row.enabled = b.enabled ? 1 : 0;
        if (b.gameNight !== undefined) {
          if (b.gameNight !== 'hold' && b.gameNight !== 'ondemand') throw new HttpError(400, 'gameNight must be "hold" or "ondemand"');
          step.policy = b.gameNight;
        } else if (b.keepWarm !== undefined) step.policy = b.keepWarm ? 'hold' : 'ondemand'; // the old per-job switch
        if (b.fallback !== undefined) {
          const f = b.fallback;
          if (f === null || f === '' || f.providerId === '' ) { row.fallback_provider_id = ''; row.fallback_model = ''; row.fallback_options = '{}'; row.allow_cloud_fallback = 0; }
          else {
            if (typeof f !== 'object') throw new HttpError(400, 'fallback must be an object or null');
            if (f.providerId !== undefined) {
              const fid = String(f.providerId);
              if (!getProvider(d.db, fid)) throw new HttpError(400, `No provider "${fid.slice(0, 30)}"`);
              row.fallback_provider_id = fid;
            }
            if (!row.fallback_provider_id) throw new HttpError(400, 'A fallback needs a providerId');
            if (f.model !== undefined) row.fallback_model = String(f.model).trim().slice(0, 200);
            if (f.options !== undefined) row.fallback_options = parseOpts(f.options);
            if (f.allowCloud !== undefined) {
              const was = !!row.allow_cloud_fallback;
              row.allow_cloud_fallback = f.allowCloud === true ? 1 : 0;
              step.cloudOn = !was && f.allowCloud === true;
            }
          }
        }
        if (row.fallback_provider_id && !row.provider_id) throw new HttpError(400, 'Pick a main provider before a fallback');
        row.updated_at = now();
        plan.push(step);
      }
      for (const { job, row, setKeyOn, cloudOn, policy } of plan) {
        if (policy) setPolicy(d.db, job, policy);
        if (setKeyOn) run(d.db, 'UPDATE models_providers SET api_key = ?, updated_at = ? WHERE id = ?', setKeyOn.key, now(), setKeyOn.id);
        run(d.db, `INSERT INTO models_jobs (job, base_url, model, api_key, options, enabled, updated_at, provider_id, fallback_provider_id, fallback_model, fallback_options, allow_cloud_fallback, keep_warm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(job) DO UPDATE SET base_url=excluded.base_url, model=excluded.model, api_key=excluded.api_key, options=excluded.options, enabled=excluded.enabled, updated_at=excluded.updated_at,
            provider_id=excluded.provider_id, fallback_provider_id=excluded.fallback_provider_id, fallback_model=excluded.fallback_model, fallback_options=excluded.fallback_options, allow_cloud_fallback=excluded.allow_cloud_fallback, keep_warm=excluded.keep_warm`,
          job, row.base_url, row.model, row.api_key, row.options, row.enabled, row.updated_at, row.provider_id, row.fallback_provider_id, row.fallback_model, row.fallback_options, row.allow_cloud_fallback, row.keep_warm);
        const mp = getProvider(d.db, row.provider_id);
        if (mp && row.model) metaSet(d.db, `last:${job}:${mp.location}`, JSON.stringify({ providerId: mp.id, model: row.model }));
        audit(d, who(res), 'models.update', job);
        if (cloudOn) audit(d, who(res), 'models.cloud_fallback_allowed', `${job}: world text may leave this server when the local provider fails`);
      }
      res.json(all6());
    });

    // ---- session mode, load/unload all, the VRAM view
    const providerLife = async (p: ProviderRow, force = false) => {
      const jobs = targetsFor(d).filter((t) => t.providerId === p.id);
      const t = jobs[0] ?? { key: '', providerId: p.id, provider: p.name, baseUrl: p.base_url, apiKey: p.api_key || undefined, location: p.location, kind: p.kind, model: '', jobs: [] };
      const b = await backendOf(d, t, force);
      const set = providerSettings(d, p.id);
      return { id: p.id, ...b, override: set.backend, ttl: set.ttl, pingMinutes: set.pingMinutes, hosted: isHosted(t), ...describeBackend(b.backend, set), probedAt: cachedBackend(d, p.id, p.base_url)?.at ?? null };
    };
    const lifeView = async () => {
      const providers = await Promise.all(listProviders(d.db).map((p) => providerLife(p)));
      return { ...lifecycleView(d), settings: getLifecycleSettings(d.db), providers, defaults: POLICY_DEFAULTS, backends: BACKENDS };
    };
    r.get('/lifecycle', async (_req, res) => res.json(await lifeView()));
    r.put('/lifecycle', async (req, res) => {
      const b = req.body ?? {};
      if (b.graceMinutes !== undefined && !(Number.isFinite(Number(b.graceMinutes)) && Number(b.graceMinutes) >= 0)) throw new HttpError(400, 'graceMinutes must be a number of minutes, 0 or more');
      for (const [j, p] of Object.entries(b.policies ?? {})) {
        if (!(ALL_JOBS as string[]).includes(j)) throw new HttpError(400, `Unknown job "${j.slice(0, 20)}"`);
        if (p !== 'hold' && p !== 'ondemand') throw new HttpError(400, 'A policy is "hold" or "ondemand"');
        setPolicy(d.db, j as Job, p);
      }
      const next = setLifecycleSettings(d.db, b);
      audit(d, who(res), 'models.game_night_settings', JSON.stringify({ ...next, policies: b.policies ?? {} }));
      res.json(await lifeView());
    });
    r.post('/game-night/start', async (_req, res) => {
      setManual(d, true);
      audit(d, who(res), 'models.game_night_start', 'manual');
      const p = lifecycleTick(d);
      p.catch(() => {});
      res.status(202).json(await lifeView());
    });
    r.post('/game-night/end', async (req, res) => {
      setManual(d, false);
      audit(d, who(res), 'models.game_night_end', req.body?.now ? 'now' : 'after the grace period');
      if (req.body?.now) await releaseNow(d); else await lifecycleTick(d);
      res.json(await lifeView());
    });
    r.post('/providers/:id/detect', async (req, res) => {
      const p = getProvider(d.db, String(req.params.id));
      if (!p) throw new HttpError(404, 'No such provider');
      res.json(await providerLife(p, true));
    });
    r.post('/unload-all', async (_req, res) => {
      const results = await unloadEverything(d);
      audit(d, who(res), 'models.unload_all', results.map((x) => `${x.model}:${x.ok ? 'ok' : 'failed'}`).join(', ').slice(0, 400));
      res.json({ results, ...(await lifeView()) });
    });
    r.get('/vram', async (_req, res) => {
      const byProvider = new Map<string, { job: string; model: string }[]>();
      for (const j of activeJobs(d)) {
        const c = jobConfig(d, j);
        const p = c?.providerId ? getProvider(d.db, c.providerId) : undefined;
        if (!c || !p || p.kind !== 'argos') continue;
        byProvider.set(p.id, [...(byProvider.get(p.id) ?? []), { job: j, model: c.model }]);
      }
      const providers = await Promise.all(listProviders(d.db).filter((p) => p.kind === 'argos').map(async (p) => {
        const jobModels = byProvider.get(p.id) ?? [];
        const seen = await readArgos(d, { baseUrl: p.base_url, apiKey: p.api_key || undefined });
        const budget = seen.pool?.enabled ? budgetFor(seen.pool, jobModels) : null;
        const declared: Record<string, number> = {};
        for (const m of seen.pool?.models ?? []) if (m.sizeKnown) declared[m.id] = m.sizeGiB;
        const names = jobModels.map((j) => j.model);
        const running = seen.running.map((m) => ({ ...m, usedByJobs: jobModels.filter((j) => j.model.toLowerCase() === m.model.toLowerCase()).map((j) => j.job) }));
        return {
          id: p.id, name: p.name, location: p.location, ok: seen.ok, error: seen.error, pool: seen.pool, running, budget, jobModels,
          router: seen.pool?.router ?? 'group',
          config: argosSnippets(names, declared),
        };
      }));
      res.json({ providers });
    });

    const jobParam = (req: any): Job => {
      const job = String(req.params.job) as Job;
      if (!ALL_JOBS.includes(job)) throw new HttpError(404, 'No such job');
      return job;
    };
    const pin = (req: any): 'primary' | 'fallback' => (req.query.which === 'fallback' ? 'fallback' : 'primary');

    r.post('/:job/test', async (req, res) => {
      const job = jobParam(req);
      const which = pin(req);
      const dd = pinned(d, which);
      if (!chainFor(dd, job).length) return res.json({ ok: false, job, ms: 0, error: which === 'fallback' ? `No fallback is set for "${job}".` : `No model is set for "${job}". Fill in a URL and save, or switch it on.` });
      res.json(await testJob(dd, job));
    });

    // Warm up: the same tiny request, so an unloaded model starts loading. Sent to the main provider only.
    r.post('/:job/warm', async (req, res) => {
      const job = jobParam(req);
      const which = pin(req);
      const dd = pinned(d, which);
      if (!chainFor(dd, job).length) return res.json({ ok: false, job, ms: 0, error: `No model is set for "${job}".` });
      res.json(await testJob(dd, job, 120_000));
    });
    return r;
  },

  // Game night: holds the models while a session is live, releases them after (lifecycle.ts). Idle: no requests.
  start: (d: Deps) => startLifecycle(d),
};
export default feature;
