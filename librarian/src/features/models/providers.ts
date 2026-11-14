// Providers: the places models live (an Argos gateway, OpenAI, Ollama...).
// A job (chat, audit...) picks a provider and a model name. Keys are
// write-only: nothing here is ever sent to the browser with a key in it.
import { all, one, run, type DB } from '../../core/db.ts';
import { inferLocation, type Location } from '../../core/ai.ts';
import { HttpError, id, now } from '../../core/util.ts';
import { normalizeArgosUrl } from './argos.ts';

export const MASK = '••••';
export const KINDS = ['argos', 'openai', 'ollama', 'lmstudio', 'openai-compatible'] as const;
export type Kind = (typeof KINDS)[number];

export interface ProviderRow { id: string; name: string; kind: Kind; base_url: string; api_key: string; location: Location; created_at: string; updated_at: string }

export const listProviders = (db: DB) => all<ProviderRow>(db, 'SELECT * FROM models_providers ORDER BY created_at, name');
export const getProvider = (db: DB, pid: string) => (pid ? one<ProviderRow>(db, 'SELECT * FROM models_providers WHERE id = ?', pid) : undefined);

/** A URL the way a person pastes it: Argos, Ollama, LM Studio and OpenAI all serve under /v1, so a bare address gets it. */
export function normalizeBase(kind: Kind, input: unknown): string {
  const s = String(input ?? '').trim().replace(/\/+$/, '');
  if (!s) throw new HttpError(400, 'A base URL is required');
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, `"${s.slice(0, 60)}" is not a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'The URL must start with http:// or https://');
  if (kind === 'argos') return normalizeArgosUrl(s);
  if (kind !== 'openai-compatible' && (u.pathname === '' || u.pathname === '/')) return `${s}/v1`;
  return s;
}

export const defaultLocation = (kind: Kind, baseUrl: string): Location => (kind === 'openai' ? 'cloud' : kind === 'openai-compatible' ? inferLocation(baseUrl) : 'local');

/** What a URL probably is: used for providers made out of old per-job settings and for the one-URL-per-job API. */
export function guessKind(baseUrl: string): Kind {
  let u: URL | null = null;
  try { u = new URL(baseUrl); } catch { /* not a URL */ }
  if (!u) return 'openai-compatible';
  if (/(^|\.)api\.openai\.com$/i.test(u.hostname)) return 'openai';
  if (u.port === '11434') return 'ollama';
  if (u.port === '1234') return 'lmstudio';
  return 'openai-compatible';
}

const nameFor = (baseUrl: string) => { try { const u = new URL(baseUrl); return u.host; } catch { return baseUrl.slice(0, 40); } };

export function createProvider(db: DB, p: { name?: string; kind: Kind; baseUrl: string; apiKey?: string; location?: Location }): ProviderRow {
  const t = now();
  const kind = p.kind;
  const row: ProviderRow = {
    id: id('prov_'), name: (p.name ?? '').trim().slice(0, 80) || nameFor(p.baseUrl), kind, base_url: p.baseUrl, api_key: (p.apiKey ?? '').trim().slice(0, 500),
    location: p.location ?? defaultLocation(kind, p.baseUrl), created_at: t, updated_at: t,
  };
  run(db, 'INSERT INTO models_providers (id, name, kind, base_url, api_key, location, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', row.id, row.name, row.kind, row.base_url, row.api_key, row.location, row.created_at, row.updated_at);
  return row;
}

const metaGet = (db: DB, k: string) => one<{ value: string }>(db, 'SELECT value FROM models_meta WHERE key = ?', k)?.value;
const metaSet = (db: DB, k: string, v: string) => run(db, 'INSERT INTO models_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);

/**
 * Old settings kept a base URL and key on every job. Turn them into providers:
 * one per distinct base URL (a second only when two jobs used different keys
 * for the same URL), link the jobs to them and clear the copies on the job
 * rows. Runs once (a flag in models_meta); `force` is for tests.
 */
export function migrateJobsToProviders(db: DB, force = false): number {
  if (!force && metaGet(db, 'providers_migrated')) return 0;
  const rows = all<any>(db, "SELECT job, base_url, api_key FROM models_jobs WHERE provider_id = '' AND base_url <> '' ORDER BY (api_key = ''), job");
  const made = new Map<string, ProviderRow[]>();
  let n = 0;
  for (const r of rows) {
    const base = String(r.base_url).replace(/\/+$/, '');
    const list = made.get(base) ?? [];
    // A job without a key joins the first provider for its URL; a job with a key joins the one that has the same key.
    let p = r.api_key ? list.find((x) => x.api_key === r.api_key) : list[0];
    if (!p) {
      const kind = guessKind(base);
      p = createProvider(db, { kind, baseUrl: base, apiKey: r.api_key, name: list.length ? `${nameFor(base)} (${list.length + 1})` : undefined });
      list.push(p);
      made.set(base, list);
      n++;
    }
    run(db, "UPDATE models_jobs SET provider_id = ?, base_url = '', api_key = '' WHERE job = ?", p.id, r.job);
  }
  metaSet(db, 'providers_migrated', now());
  return n;
}
