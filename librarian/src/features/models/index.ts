// Admin → Models: where each of the five model jobs (core/ai.ts) points.
// Saved settings win; a job with nothing saved (or switched off) falls back
// to the environment (ALX_MODEL_<JOB>_URL ...). API keys are write-only.
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts'; // type only: a runtime import would deadlock the registry's top-level await
import { one, run } from '../../core/db.ts';
import type { Auth } from '../../core/auth.ts';
import { HttpError, now } from '../../core/util.ts';
import { JOBS, chat, embed, jobConfig, setJobResolver, speak, transcribe, ModelUnavailable, type Job, type JobConfig } from '../../core/ai.ts';

export const MASK = '••••';

interface Row { job: string; base_url: string; model: string; api_key: string; options: string; enabled: number; updated_at: string }

const USES: Record<Job, string> = {
  chat: 'DM agent, player Ask, broker answers, summaries',
  audit: 'Question routing and spoiler checks (small model)',
  audio: 'Speech to text',
  voice: 'Text to speech',
  extra: 'Embeddings for search and matching',
};

const saved = (d: Deps, job: Job) => one<Row>(d.db, 'SELECT * FROM models_jobs WHERE job = ?', job);
const audit = (d: Deps, accountId: string, action: string, detail: string) =>
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (NULL, ?, ?, ?, ?)', accountId, action, detail, now());
const who = (res: any) => (res.locals.auth as Auth).account.id;

function parseOptions(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

function fromSaved(d: Deps, job: Job): JobConfig | null {
  const r = saved(d, job);
  if (!r || !r.enabled || !r.base_url) return null;
  const opts = parseOptions(r.options);
  return { baseUrl: r.base_url.replace(/\/$/, ''), apiKey: r.api_key || undefined, model: r.model || 'default', options: Object.keys(opts).length ? opts : undefined };
}

// Set when the feature loads. A null answer makes jobConfig() use the environment.
setJobResolver((d, job) => fromSaved(d, job));

function view(d: Deps, job: Job) {
  const r = saved(d, job);
  const effective = jobConfig(d, job);
  const source = r && r.enabled && r.base_url ? 'saved' : effective ? 'env' : 'none';
  return {
    job,
    uses: USES[job],
    baseUrl: r?.base_url ?? '',
    model: r?.model ?? '',
    apiKey: r?.api_key ? MASK : '',
    options: r ? parseOptions(r.options) : {},
    enabled: r ? !!r.enabled : true,
    source,
    effective: effective ? { baseUrl: effective.baseUrl, model: effective.model, hasKey: !!effective.apiKey } : null,
  };
}

function parseUrl(v: unknown): string {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let u: URL;
  try { u = new URL(s); } catch { throw new HttpError(400, `"${s.slice(0, 60)}" is not a URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'The URL must start with http:// or https://');
  return s;
}

function parseOpts(v: unknown): string {
  if (v === undefined || v === null || v === '') return '{}';
  let o: unknown = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { throw new HttpError(400, 'Extra options must be valid JSON'); } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, 'Extra options must be a JSON object');
  return JSON.stringify(o);
}

/** A tiny silent 16 kHz mono WAV for the audio test. */
function silentWav(seconds = 0.5): Uint8Array {
  const n = Math.floor(16000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return new Uint8Array(b);
}

async function testJob(d: Deps, job: Job): Promise<{ ok: boolean; job: Job; ms: number; sample?: string; error?: string }> {
  const t0 = Date.now();
  const done = (sample: string) => ({ ok: true, job, ms: Date.now() - t0, sample: sample.slice(0, 160) });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    if (job === 'chat' || job === 'audit') {
      const r = await chat(d, job, { messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 16, temperature: 0 }, ctl.signal);
      return done(r.content.trim() || '(empty reply)');
    }
    if (job === 'audio') {
      const t = await transcribe(d, silentWav(), 'audio/wav', { filename: 'test.wav' }, ctl.signal);
      return done(t.text || '(no speech heard, which is right for silence)');
    }
    if (job === 'voice') {
      const s = await speak(d, 'Testing, one two three.', { format: 'wav' }, ctl.signal);
      if (!s.audio.length) throw new ModelUnavailable('voice', 'The voice model sent no audio');
      return done(`${s.audio.length} bytes of ${s.mime}`);
    }
    const v = await embed(d, ['a tiny test sentence'], ctl.signal);
    if (!v.length || !Array.isArray(v[0]) || !v[0].length) throw new ModelUnavailable('extra', 'The embeddings model sent no vector');
    return done(`${v[0].length}-dimension vector`);
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'Timed out after 30 seconds' : String(err?.message ?? err);
    return { ok: false, job, ms: Date.now() - t0, error: msg.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

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
  );`,
  adminMount: 'models',
  adminRoutes: (d) => {
    const r = Router();
    r.get('/', (_req, res) => res.json({ jobs: JOBS.map((j) => view(d, j)) }));

    // Body: { jobs: { chat: { baseUrl, model, apiKey, options, enabled }, ... } }.
    // Only the jobs and fields sent change. apiKey "••••" or missing keeps the saved key; "" clears it.
    r.put('/', (req, res) => {
      const body = req.body?.jobs;
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Send { jobs: { chat: {...} } }');
      const entries: [string, any][] = Array.isArray(body) ? body.map((b: any) => [String(b?.job), b]) : Object.entries(body);
      const plan: { job: Job; row: Row }[] = [];
      for (const [name, b] of entries) {
        if (!(JOBS as string[]).includes(name)) throw new HttpError(400, `Unknown job "${name.slice(0, 20)}"`);
        const job = name as Job;
        if (!b || typeof b !== 'object') throw new HttpError(400, `Settings for ${job} must be an object`);
        const cur = saved(d, job);
        const row: Row = cur ? { ...cur } : { job, base_url: '', model: '', api_key: '', options: '{}', enabled: 1, updated_at: '' };
        if (b.baseUrl !== undefined) row.base_url = parseUrl(b.baseUrl);
        if (b.model !== undefined) row.model = String(b.model).trim().slice(0, 200);
        if (b.apiKey !== undefined && b.apiKey !== MASK) row.api_key = String(b.apiKey).trim().slice(0, 500);
        if (b.options !== undefined) row.options = parseOpts(b.options);
        if (b.enabled !== undefined) row.enabled = b.enabled ? 1 : 0;
        row.updated_at = now();
        plan.push({ job, row });
      }
      for (const { job, row } of plan) {
        run(d.db, `INSERT INTO models_jobs (job, base_url, model, api_key, options, enabled, updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(job) DO UPDATE SET base_url=excluded.base_url, model=excluded.model, api_key=excluded.api_key, options=excluded.options, enabled=excluded.enabled, updated_at=excluded.updated_at`,
          job, row.base_url, row.model, row.api_key, row.options, row.enabled, row.updated_at);
        audit(d, who(res), 'models.update', job);
      }
      res.json({ jobs: JOBS.map((j) => view(d, j)) });
    });

    r.post('/:job/test', async (req, res) => {
      const job = String(req.params.job) as Job;
      if (!JOBS.includes(job)) throw new HttpError(404, 'No such job');
      if (!jobConfig(d, job)) return res.json({ ok: false, job, ms: 0, error: `No model is set for "${job}". Fill in a URL and save, or switch it on.` });
      res.json(await testJob(d, job));
    });
    return r;
  },
};
export default feature;
