// The VRAM view: what an Argos provider says about its GPUs and loaded models,
// set against the models Alexandria's jobs use; and the Argos config snippet
// that keeps those models resident.
//
// Argos answers (read only, nothing here sends world text):
//   GET /api/pool   the pool router's plan: cards (cap/used/free GiB), models
//                   (state, size_gib, size_known, cards, persistent) or
//                   { enabled: false } with any other router
//   GET /running    { running: [{ model, state, cmd, proxy, ttl, name, ... }] }
import type { Deps } from '../../app.ts';
import { argosWebUrl } from './argos.ts';

export interface PoolCard { id: string; capGiB: number; usedGiB: number; freeGiB: number; models: string[] }
export interface PoolModel { id: string; state: string; sizeGiB: number; sizeKnown: boolean; cards: string[]; persistent: boolean }
export interface PoolView { enabled: boolean; router: string; cards: PoolCard[]; models: PoolModel[] }
export interface RunningModel { model: string; state: string; ttl?: number }
export interface JobModel { job: string; model: string }

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r1 = (n: number) => Math.round(n * 100) / 100;

/** Argos's /api/pool JSON (snake_case) as a PoolView. Anything that is not an enabled pool reads as { enabled: false }. */
export function normalizePool(j: any): PoolView {
  const router = typeof j?.router === 'string' ? j.router : '';
  if (!j || j.enabled !== true) return { enabled: false, router, cards: [], models: [] };
  const cards: PoolCard[] = (Array.isArray(j.cards) ? j.cards : []).map((c: any) => ({
    id: String(c?.id ?? ''), capGiB: num(c?.cap_gib), usedGiB: num(c?.used_gib), freeGiB: num(c?.free_gib), models: Array.isArray(c?.models) ? c.models.map(String) : [],
  }));
  const models: PoolModel[] = (Array.isArray(j.models) ? j.models : []).map((m: any) => ({
    id: String(m?.id ?? ''), state: String(m?.state ?? ''), sizeGiB: num(m?.size_gib), sizeKnown: m?.size_known === true,
    cards: Array.isArray(m?.cards) ? m.cards.map(String) : [], persistent: m?.persistent === true,
  }));
  return { enabled: true, router: router || 'pool', cards, models };
}

export function normalizeRunning(j: any): RunningModel[] {
  const rows: any[] = Array.isArray(j?.running) ? j.running : [];
  return rows.filter((r) => typeof r?.model === 'string').map((r) => ({ model: r.model, state: String(r.state ?? ''), ...(Number.isFinite(Number(r.ttl)) ? { ttl: Number(r.ttl) } : {}) }));
}

export type Fit = 'ok' | 'undeclared' | 'unknown-to-argos' | 'too-big' | 'wont-fit';
export interface BudgetRow { job: string; model: string; sizeGiB: number | null; loaded: boolean; fit: Fit; note: string }
export interface Budget {
  rows: BudgetRow[];
  /** Sum of the declared sizes of the distinct job models. */
  neededGiB: number;
  /** Free GiB on all cards, plus what the job models already hold (they are not in the way of themselves). */
  availableGiB: number;
  totalGiB: number;
  usedGiB: number;
  freeGiB: number;
  /** Every declared job model can be resident together (placed card by card). */
  allFit: boolean;
  /** At least one job model has no declared size, so the sum is a lower bound. */
  incomplete: boolean;
}

const LOADED = new Set(['ready', 'starting']);
const isLoaded = (m: PoolModel | undefined) => !!m && LOADED.has(m.state.toLowerCase());

/**
 * The job models against the pool. A model fits when, after placing every declared job
 * model (largest first, each on the card with the most room, or split over the cards
 * when it is bigger than any one card), it still has room. An undeclared model (size unknown
 * to the pool) counts for nothing and is flagged; one bigger than every card together
 * is flagged too-big; one that fits alone but not alongside the rest is wont-fit.
 */
export function budgetFor(pool: PoolView, jobModels: JobModel[]): Budget {
  const byId = new Map(pool.models.map((m) => [m.id.toLowerCase(), m]));
  const total = pool.cards.reduce((s, c) => s + c.capGiB, 0);
  const used = pool.cards.reduce((s, c) => s + c.usedGiB, 0);
  const free = pool.cards.reduce((s, c) => s + c.freeGiB, 0);

  const rows: BudgetRow[] = jobModels.map((jm) => {
    const pm = byId.get(jm.model.toLowerCase());
    if (!pm) return { job: jm.job, model: jm.model, sizeGiB: null, loaded: false, fit: 'unknown-to-argos', note: 'Argos does not list this model name.' };
    const loaded = isLoaded(pm);
    if (!pm.sizeKnown || !(pm.sizeGiB > 0)) return { job: jm.job, model: jm.model, sizeGiB: null, loaded, fit: 'undeclared', note: 'No vram declared, so the pool cannot plan for it (it may run alone).' };
    if (pm.sizeGiB > total) return { job: jm.job, model: jm.model, sizeGiB: pm.sizeGiB, loaded, fit: 'too-big', note: `${r1(pm.sizeGiB)} GiB is more than all the cards together (${r1(total)} GiB).` };
    return { job: jm.job, model: jm.model, sizeGiB: pm.sizeGiB, loaded, fit: 'ok', note: '' };
  });

  // Distinct declared models, placed largest first.
  const distinct = new Map<string, BudgetRow>();
  for (const r of rows) if (r.sizeGiB !== null && r.fit === 'ok' && !distinct.has(r.model.toLowerCase())) distinct.set(r.model.toLowerCase(), r);
  const left = pool.cards.map((c) => c.capGiB);
  const needed = [...distinct.values()].reduce((s, r) => s + (r.sizeGiB ?? 0), 0);
  const failed = new Set<string>();
  for (const r of [...distinct.values()].sort((a, b) => (b.sizeGiB ?? 0) - (a.sizeGiB ?? 0))) {
    const size = r.sizeGiB ?? 0;
    let best = -1;
    for (let i = 0; i < left.length; i++) if (left[i] >= size && (best < 0 || left[i] > left[best])) best = i;
    if (best >= 0) { left[best] -= size; continue; }
    // Only a model bigger than any single card is split (over the cards with the most room); one that fits a card but finds none free is fragmented out, as the pool does.
    if (size <= Math.max(0, ...pool.cards.map((c) => c.capGiB))) { failed.add(r.model.toLowerCase()); continue; }
    let rest = size;
    const order = left.map((v, i) => i).sort((a, b) => left[b] - left[a]);
    const take: [number, number][] = [];
    for (const i of order) { if (rest <= 1e-9) break; const t = Math.min(left[i], rest); if (t > 0) { take.push([i, t]); rest -= t; } }
    if (rest > 1e-9) { failed.add(r.model.toLowerCase()); continue; }
    for (const [i, t] of take) left[i] -= t;
  }
  for (const r of rows) if (failed.has(r.model.toLowerCase()) && r.fit === 'ok') { r.fit = 'wont-fit'; r.note = `Does not fit next to the other job models (${r1(needed)} GiB wanted, ${r1(total)} GiB on the cards).`; }

  const held = [...distinct.values()].filter((r) => r.loaded).reduce((s, r) => s + (r.sizeGiB ?? 0), 0);
  const incomplete = rows.some((r) => r.fit === 'undeclared' || r.fit === 'unknown-to-argos');
  return {
    rows, neededGiB: r1(needed), availableGiB: r1(free + held), totalGiB: r1(total), usedGiB: r1(used), freeGiB: r1(free),
    allFit: failed.size === 0 && !rows.some((r) => r.fit === 'too-big'), incomplete,
  };
}

// ---- the Argos config snippet ------------------------------------------------------

const plain = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/;
const key = (s: string) => (plain.test(s) ? s : JSON.stringify(s));

export interface Snippets { group: string; pool: string }

/**
 * YAML to merge into Argos's config so these models stay loaded. The group snippet
 * is for the group router (a persistent, non-swapping, non-exclusive group); the pool
 * snippet is for the pool router (`routing.router.settings.pool.persistent`, with
 * `vram`, which the pool needs to plan). `declared` fills in a vram the pool already knows.
 */
export function argosSnippets(models: string[], declared: Record<string, number> = {}): Snippets {
  const names = [...new Set(models.filter(Boolean))];
  const modelBlock = names.length
    ? names.map((m) => `  ${key(m)}:\n    ttl: 0            # never unload on idle\n    ${declared[m] ? `vram: ${declared[m]}` : '# vram: 0'}${declared[m] ? '' : '        # GiB: weights + KV cache for your context size'}`).join('\n')
    : '  # (no job uses an Argos model yet)';
  const list = `[${names.map(key).join(', ')}]`;
  const group = [
    '# Group router: keep the Alexandria models resident together.',
    '# Merge the ttl lines into your existing model entries; do not repeat a model key.',
    'models:',
    modelBlock,
    '',
    'routing:',
    '  router:',
    '    use: group',
    '    settings:',
    '      groups:',
    '        alexandria:',
    '          persistent: true   # no other group can unload these',
    '          swap: false        # all members stay loaded at once',
    '          exclusive: false   # loading them does not unload other groups',
    `          members: ${list}`,
    '',
  ].join('\n');
  const pool = [
    '# Pool router: keep the Alexandria models resident while they fit.',
    '# Merge into your existing model entries; do not repeat a model key.',
    'models:',
    modelBlock,
    '',
    'routing:',
    '  router:',
    '    use: pool',
    '    settings:',
    '      pool:',
    '        reserveGiB: 2',
    `        persistent: ${list}   # never evicted for another model`,
    '',
  ].join('\n');
  return { group, pool };
}

// ---- reading Argos -------------------------------------------------------------------------

export interface ArgosEndpoint { baseUrl: string; apiKey?: string }

async function getJson(d: Deps, p: ArgosEndpoint, path: string, ms = 6000): Promise<{ status: number; json: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await d.fetch(argosWebUrl(p.baseUrl) + path, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}, signal: ctl.signal });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json };
  } finally { clearTimeout(t); }
}

export interface ArgosVram { ok: boolean; error?: string; pool: PoolView | null; running: RunningModel[] }

/** GET /api/pool and GET /running from one Argos. A server without /api/pool (an older Argos) just has no pool view. */
export async function readArgos(d: Deps, p: ArgosEndpoint): Promise<ArgosVram> {
  try {
    const [pool, running] = await Promise.all([getJson(d, p, '/api/pool').catch(() => null), getJson(d, p, '/running').catch(() => null)]);
    if (!pool && !running) return { ok: false, error: `Could not reach ${argosWebUrl(p.baseUrl)}`, pool: null, running: [] };
    if ([pool?.status, running?.status].includes(401) || [pool?.status, running?.status].includes(403)) return { ok: false, error: 'Argos rejected the API key', pool: null, running: [] };
    return {
      ok: true,
      pool: pool && pool.status === 200 && pool.json ? normalizePool(pool.json) : null,
      running: running && running.status === 200 ? normalizeRunning(running.json) : [],
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 200), pool: null, running: [] };
  }
}
