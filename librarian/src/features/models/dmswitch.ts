// The DM's model switcher: the DM, not only the admin, picks the model behind each AI role from the table, and a
// backup for when one goes down mid-session. The admin decides how far a DM may go (Admin → Models → GMs and models):
//
//   off     the DM sees which model each role is on and its health, and changes nothing
//   switch  the DM picks a provider the admin saved and any model it lists, for the main model and the backup
//   setup   switch, and the DM may add a provider (an address and a key) and let a local role fall back to a cloud one
//
// Settings are the server's (one set for every world, the same rows Admin → Models edits): a model that went down is
// down for every table. Each change is audited with the DM's world. Admins always have setup.
//
// The Historian (the embeddings job, `extra`) is special: vectors from two models do not mix, so a new embeddings model
// (or a backup that is another model) needs { confirmReindex: true }; then every world is embedded again (reindexAll), the
// story bible keeping its facts.
//
//   GET  /api/worlds/:world/models/switch            { access, roles, providers }
//   GET  /api/worlds/:world/models/health            { jobs: JobHealth[] }: roles on their backup or not answering
//   POST /api/worlds/:world/models/switch/discover   { providerId } -> the models that provider lists
//   PUT  /api/worlds/:world/models/switch            { job, providerId, model, fallback?: { providerId, model, allowCloud? } | null, follow?: true, confirmReindex? }
//   POST /api/worlds/:world/models/switch/test       { job, which?: 'primary' | 'fallback' }
//   POST /api/worlds/:world/models/switch/providers  setup only: { name, kind, baseUrl, apiKey, location }
//   GET  /api/admin/models/dm-access                 { level }
//   PUT  /api/admin/models/dm-access                 { level: 'off' | 'switch' | 'setup' }
import type { Router } from 'express';
import type { Deps } from '../../app.ts';
import type { Auth, WorldCtx } from '../../core/auth.ts';
import { dmOnly } from '../../core/events.ts';
import { HttpError } from '../../core/util.ts';
import { ALL_JOBS, chainFor, inferLocation, jobConfig, jobHealth as rawHealth, ownJobConfig, pinned, setHealthListener, type Job, type JobConfig } from '../../core/ai.ts';
import { listModels } from './argos.ts';
import { startBulkBuild } from '../search/bulkbuild.ts';
import { vectorStore } from '../search/vectorstore.ts';
import { testJob } from './probe.ts';
import { KINDS, MASK, createProvider, getProvider, listProviders, metaGet, metaSet, normalizeBase, type Kind, type ProviderRow } from './providers.ts';

export type DmAccess = 'off' | 'switch' | 'setup';
export const DM_ACCESS_LEVELS: DmAccess[] = ['off', 'switch', 'setup'];
/** Wizard's ask: the DM sets up and changes models. An admin with several DMs can lower it. */
export const DM_ACCESS_DEFAULT: DmAccess = 'setup';

export function getDmAccess(d: Deps): DmAccess {
  const v = metaGet(d.db, 'dm_access');
  return (DM_ACCESS_LEVELS as string[]).includes(v ?? '') ? (v as DmAccess) : DM_ACCESS_DEFAULT;
}
export function setDmAccess(d: Deps, level: unknown): DmAccess {
  if (!(DM_ACCESS_LEVELS as unknown[]).includes(level)) throw new HttpError(400, 'level must be "off", "switch" or "setup"');
  metaSet(d.db, 'dm_access', String(level));
  return level as DmAccess;
}

/**
 * Which of the admin's providers (Admin → Models) a DM may pick: the cloud ones, the local ones, or both. A provider the
 * DM brought themselves (DM → Setup → Models, setup level) is always theirs to use, local or cloud.
 */
export interface DmProviders { cloud: boolean; local: boolean }
export function getDmProviders(d: Deps): DmProviders {
  try { const v = JSON.parse(metaGet(d.db, 'dm_providers') ?? 'null'); return { cloud: v?.cloud !== false, local: v?.local !== false }; } catch { return { cloud: true, local: true }; }
}
function setDmProviders(d: Deps, b: any): DmProviders {
  const cur = getDmProviders(d);
  for (const k of ['cloud', 'local'] as const) if (b?.[k] !== undefined && typeof b[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`);
  const next = { cloud: b?.cloud ?? cur.cloud, local: b?.local ?? cur.local };
  metaSet(d.db, 'dm_providers', JSON.stringify(next));
  return next;
}
/** May this DM pick this provider? Admins: any. A DM: their own, or an admin's one of a kind the admin allows. */
function usable(d: Deps, res: any, p: ProviderRow | undefined): boolean {
  if (!p) return false;
  const auth = res.locals.auth as Auth;
  if (auth.account.is_admin) return true;
  if (p.added_by) return p.added_by === auth.account.id;
  return getDmProviders(d)[p.location];
}
const whyNot = (d: Deps, p: ProviderRow) => (p.added_by ? 'That provider belongs to another GM.' : `The admin does not let GMs use the ${p.location} providers set up in Admin → Models. Add your own (Add a provider).`);
function needUsable(d: Deps, res: any, pid: string, what: string): ProviderRow {
  const p = getProvider(d.db, pid);
  if (!p) throw new HttpError(400, `Pick a provider${what}`);
  if (!usable(d, res, p)) throw new HttpError(403, whyNot(d, p));
  return p;
}

/** The roles the DM picks a model for, in the order shown. Speech and voice stay in Admin → Models (they rarely go down mid-game and need options). */
export const DM_ROLES: Job[] = ['dm', 'chat', 'player', 'helper', 'audit', 'bible', 'extra', 'rerank', ...(ALL_JOBS.includes('vision' as Job) ? ['vision' as Job] : [])];
/** Roles that may follow another one instead of having a model of their own. */
const FOLLOWS: Partial<Record<Job, Job>> = { dm: 'chat', player: 'chat', bible: 'chat', helper: 'player' };

/** Health with the providers' names, so "qwen3 on Spare box" and "qwen3 on Argos" are told apart. */
const healthOf = (d: Deps) => rawHealth().map((h) => ({ ...h, provider: h.providerId ? getProvider(d.db, h.providerId)?.name ?? null : null, usingProvider: h.usingProviderId ? getProvider(d.db, h.usingProviderId)?.name ?? null : null }));

const where = (c: JobConfig | null) => (c ? c.location ?? inferLocation(c.baseUrl) : null);

function roleView(d: Deps, job: Job) {
  const own = ownJobConfig(d, job);
  const eff = jobConfig(d, job);
  const p = own?.providerId ? getProvider(d.db, own.providerId) : undefined;
  const fp = own?.fallback?.providerId ? getProvider(d.db, own.fallback.providerId) : undefined;
  const chain = chainFor(d, job);
  return {
    job,
    follows: !own && FOLLOWS[job] ? FOLLOWS[job] : null,
    canFollow: FOLLOWS[job] ?? null,
    // Set from the environment (no saved row): the DM may still pick one, which then wins.
    fromEnv: !!own && !own.providerId,
    providerId: p?.id ?? '',
    model: own?.model ?? '',
    effective: eff ? { model: eff.model, provider: eff.providerId ? getProvider(d.db, eff.providerId)?.name ?? null : null, location: where(eff) } : null,
    fallback: own?.fallback ? { providerId: fp?.id ?? '', model: own.fallback.model, location: where(own.fallback), provider: fp?.name ?? null } : null,
    // A local main with a cloud backup stays local until someone allowed text to leave (setup, or the admin).
    fallbackBlocked: !!(own?.fallback && chain.length < 2),
    health: healthOf(d).find((h) => h.job === job) ?? null,
  };
}

const accessFor = (d: Deps, res: any): DmAccess => ((res.locals.auth as Auth | undefined)?.account.is_admin ? 'setup' : getDmAccess(d));
/** Changes come from the DM's own sign-in, never from an API key or a model calling the world's tools. */
function mayChange(d: Deps, res: any, need: DmAccess) {
  const auth = res.locals.auth as Auth;
  const w = res.locals.w as WorldCtx;
  if (auth.via !== 'session' && auth.via !== 'admin_session') throw new HttpError(403, 'Models are changed from the GM’s own sign-in, not with a key');
  if (w.viewer.audience === 'ai') throw new HttpError(403, 'An AI cannot change the models');
  const have = accessFor(d, res);
  if (DM_ACCESS_LEVELS.indexOf(have) < DM_ACCESS_LEVELS.indexOf(need)) {
    throw new HttpError(403, need === 'setup' ? 'Only the admin can add providers here (Admin → Models → GMs and models)' : 'The admin has not let GMs change models (Admin → Models → GMs and models)');
  }
}

/** The providers this DM may pick (see usable), with which are their own. */
const providersView = (d: Deps, res: any) => listProviders(d.db).filter((p) => usable(d, res, p)).map((p) => ({ id: p.id, name: p.name, kind: p.kind, location: p.location, hasKey: !!p.api_key, mine: !!p.added_by && p.added_by === (res.locals.auth as Auth).account.id }));
const viewFor = (d: Deps, res: any) => ({ access: accessFor(d, res), providerRules: getDmProviders(d), roles: DM_ROLES.map((j) => roleView(d, j)), providers: providersView(d, res) });

export interface SwitchHooks {
  /** applyJobs from the models feature (one code path with Admin → Models). */
  apply: (d: Deps, jobs: unknown, accountId: string | null, worldId: string | null, opts?: { confirmReindex?: boolean }) => Job[];
  audit: (d: Deps, worldId: string | null, accountId: string | null, action: string, detail: string) => void;
}

export function dmSwitchRoutes(d: Deps, r: Router, hooks: SwitchHooks, requireDM: any) {
  const worldOf = (res: any) => (res.locals.w as WorldCtx).world.id;
  const accountOf = (res: any) => (res.locals.auth as Auth).account.id;

  r.get('/health', requireDM, (_req, res) => res.json({ jobs: healthOf(d) }));

  r.get('/switch', requireDM, (_req, res) => {
    res.json(viewFor(d, res));
  });

  r.post('/switch/discover', requireDM, async (req, res) => {
    mayChange(d, res, 'switch');
    const p = needUsable(d, res, String(req.body?.providerId ?? ''), '');
    try {
      const models = await listModels(d, { baseUrl: p.base_url, apiKey: p.api_key || undefined });
      res.json({ ok: true, models: models.map((m) => ({ id: m.id, status: m.status, tools: m.tools, vision: m.vision, reranker: m.reranker, contextLength: m.contextLength, role: m.role })) });
    } catch (err: any) {
      res.json({ ok: false, error: String(err?.message ?? err).slice(0, 300), models: [] });
    }
  });

  r.put('/switch', requireDM, (req, res) => {
    const b = req.body ?? {};
    const job = String(b.job ?? '') as Job;
    if (!DM_ROLES.includes(job)) throw new HttpError(400, `Unknown role "${String(b.job).slice(0, 20)}"`);
    const level = accessFor(d, res);
    mayChange(d, res, 'switch');
    let set: Record<string, unknown>;
    let detail: string;
    if (b.follow === true) {
      if (!FOLLOWS[job]) throw new HttpError(400, 'This role always needs a model of its own');
      set = { enabled: false };
      detail = `${job}: follows ${FOLLOWS[job]}`;
    } else {
      const providerId = String(b.providerId ?? '');
      const model = String(b.model ?? '').trim();
      needUsable(d, res, providerId, '');
      if (!model) throw new HttpError(400, 'Pick a model');
      set = { providerId, model, enabled: true };
      if (b.fallback !== undefined) {
        const f = b.fallback;
        if (f === null || f === '' || f?.providerId === '') set.fallback = null;
        else {
          if (typeof f !== 'object') throw new HttpError(400, 'Pick a provider for the backup');
          needUsable(d, res, String(f.providerId ?? ''), ' for the backup');
          const fb: Record<string, unknown> = { providerId: String(f.providerId), model: String(f.model ?? '').trim() || model };
          if (f.allowCloud !== undefined) {
            if (f.allowCloud === true && level !== 'setup') throw new HttpError(403, 'Only the admin can let a local role fall back to a cloud provider');
            fb.allowCloud = f.allowCloud === true;
          }
          set.fallback = fb;
        }
      }
      // The Historian: a new model means the stored vectors no longer match. Say so before anything changes.
      if (job === 'extra' && b.confirmReindex !== true) {
        const cur = ownJobConfig(d, 'extra');
        const fbModel = (set.fallback as any)?.model as string | undefined;
        const reasons: string[] = [];
        if (cur && cur.model !== model) reasons.push(`The search index and the story bible's vectors were made with ${cur.model}. Vectors from ${model} do not match them, so every world is embedded again (the story bible keeps its facts; only their vectors are made again).`);
        if (fbModel && fbModel !== model) reasons.push(`The backup ${fbModel} is another model: anything it embeds while the main one is down will not match the rest.`);
        if (reasons.length) return res.status(409).json({ error: reasons.join(' '), code: 'reindex' });
      }
      detail = `${job}: ${model}${set.fallback ? `, backup ${(set.fallback as any).model}` : set.fallback === null ? ', no backup' : ''}`;
    }
    hooks.apply(d, { [job]: set }, accountOf(res), worldOf(res), { confirmReindex: b.confirmReindex === true });
    hooks.audit(d, worldOf(res), accountOf(res), 'models.dm_switch', detail);
    const reembed = job === 'extra' && b.confirmReindex === true;
    res.json({ ...viewFor(d, res), ...(reembed ? { reembed: true } : {}) });
  });

  // A fixed prompt, no world text: any DM may test, whatever the access level.
  r.post('/switch/test', requireDM, async (req, res) => {
    const job = String(req.body?.job ?? '') as Job;
    if (!DM_ROLES.includes(job)) throw new HttpError(400, 'Unknown role');
    const which = req.body?.which === 'fallback' ? 'fallback' : 'primary';
    const dd = pinned(d, which);
    if (!chainFor(dd, job).length) return res.json({ ok: false, job, ms: 0, error: which === 'fallback' ? 'No backup is set for this role.' : 'No model is set for this role.' });
    res.json(await testJob(dd, job));
  });

  r.post('/switch/providers', requireDM, (req, res) => {
    mayChange(d, res, 'setup');
    const b = req.body ?? {};
    const kind = String(b.kind ?? 'openai-compatible') as Kind;
    if (!(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of: ${KINDS.join(', ')}`);
    if (b.location !== undefined && b.location !== 'local' && b.location !== 'cloud') throw new HttpError(400, 'location must be "local" or "cloud"');
    const p = createProvider(d.db, { name: b.name, kind, baseUrl: normalizeBase(kind, b.baseUrl), apiKey: b.apiKey && b.apiKey !== MASK ? String(b.apiKey).trim().slice(0, 500) : '', location: b.location, addedBy: (res.locals.auth as Auth).account.id });
    hooks.audit(d, worldOf(res), accountOf(res), 'models.provider.create', `${p.name} (${p.kind}, ${p.location}) by the GM`);
    tellChanged(d);
    res.status(201).json({ provider: { id: p.id, name: p.name, kind: p.kind, location: p.location, hasKey: !!p.api_key, mine: true }, providers: providersView(d, res) });
  });
}

/** Admin → Models → GMs and models. */
export function dmAccessAdminRoutes(d: Deps, r: Router, audit: (accountId: string, detail: string) => void, who: (res: any) => string) {
  r.get('/dm-access', (_req, res) => res.json({ level: getDmAccess(d), ...getDmProviders(d) }));
  // { level?, cloud?, local? }: cloud / local say whether DMs may pick the admin's providers of that kind.
  r.put('/dm-access', (req, res) => {
    const b = req.body ?? {};
    const level = b.level === undefined ? getDmAccess(d) : setDmAccess(d, b.level);
    const rules = setDmProviders(d, b);
    audit(who(res), JSON.stringify({ level, ...rules }));
    tellChanged(d);
    res.json({ level, ...rules });
  });
}

/**
 * The embeddings model changed (someone said yes): every world's search vectors are dropped and made again, and the story
 * bible's facts get new vectors. Pages are not read again by the chat model, so no fact is lost. One job per world.
 */
export function reindexAll(d: Deps) {
  for (const w of d.db.prepare('SELECT id FROM worlds').all() as { id: string }[]) {
    vectorStore(d.db).deleteWorld(w.id);
    d.library.changed(w.id);
    startBulkBuild(d, w.id, { embeddings: true, bibleVectors: true });
  }
}

/** Model settings changed (here, or in Admin → Models): every DM page showing them loads them again. */
export function tellChanged(d: Deps) {
  for (const w of d.hub.worlds()) d.hub.emit(w, 'models-changed', {}, dmOnly);
}

// A role moved to its backup, has nothing that answers, or is back: every DM who has a world open hears it.
const told = new WeakSet<object>();
export function attachHealthNotices(d: Deps) {
  if (told.has(d.hub)) return;
  told.add(d.hub);
  setHealthListener((dd, change) => {
    const hub = (dd as Deps).hub ?? d.hub;
    const jobs = healthOf(dd as Deps);
    for (const w of hub.worlds()) hub.emit(w, 'models-health', { ...change, jobs }, dmOnly);
  });
}

