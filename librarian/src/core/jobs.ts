// The background job runner's book-keeping: what heavy work is running right now
// (a crawl, a source sync, a re-index, a rebuild of the player copies, the warm-up
// after a start), how far it is and how to stop it. The admin page lists it, /health
// says how many are running, and a job that was running when the server stopped is
// started again where it left off (resumeJobs, below).
//
// A job is ordinary async code that gives the event loop back often (core/yield.ts):
// the registry does not run anything on another thread, it only knows about it.
import type { DB } from './db.ts';
import { all, one, run } from './db.ts';
import { id, now } from './util.ts';
import { withPriority } from './ai.ts';

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface JobProgress { done: number; total: number; message: string }

export interface JobInfo {
  id: string;
  kind: string;
  title: string;
  worldId: string | null;
  status: JobStatus;
  progress: JobProgress;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  cancellable: boolean;
}

export interface JobCtx {
  id: string;
  signal: AbortSignal;
  progress(done: number, total: number, message?: string): void;
}

interface Live { info: JobInfo; ctl: AbortController; cancel?: () => void; params: unknown; persist: boolean; lastSave: number }

export const JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  world_id TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  progress TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, started_at);
`;

const KEEP_FINISHED = 25;

export class Jobs {
  private live = new Map<string, Live>();
  private recent: JobInfo[] = [];
  private listeners = new Set<(j: JobInfo) => void>();
  db: DB | null;
  /** Memory is short (core/memguard.ts): background work waits until it is not. */
  pressure = false;

  constructor(db: DB | null = null) {
    this.db = db;
    try { db?.exec(JOBS_SCHEMA); } catch { /* an in-memory test database without the table: the registry still works */ }
  }

  /** Told of every change of a job (the admin page's live stream). */
  onChange(fn: (j: JobInfo) => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  /** How many jobs are running now. */
  busy(): number { return this.live.size; }

  /** Running jobs first, then the latest finished ones. */
  list(): JobInfo[] { return [...[...this.live.values()].map((l) => l.info), ...this.recent]; }

  get(jobId: string): JobInfo | undefined { return this.live.get(jobId)?.info ?? this.recent.find((j) => j.id === jobId); }

  /** Is a job of this kind (for this world) running? */
  running(kind: string, worldId?: string | null): boolean {
    for (const l of this.live.values()) if (l.info.kind === kind && (worldId === undefined || l.info.worldId === worldId)) return true;
    return false;
  }

  /**
   * Run `fn` as a tracked job. Resolves with what `fn` resolves with; a failure is recorded and thrown again.
   * `resume`: the parameters a restart needs to start the same work again (set it for work that can safely run twice).
   * `cancel`: how to stop the work early (it also aborts the signal given to `fn`).
   */
  async track<T>(spec: { kind: string; title: string; worldId?: string | null; resume?: unknown; cancel?: () => void; id?: string; cancellable?: boolean }, fn: (ctx: JobCtx) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    const info: JobInfo = {
      id: spec.id ?? id('job_'), kind: spec.kind, title: spec.title, worldId: spec.worldId ?? null, status: 'running', progress: { done: 0, total: 0, message: '' },
      startedAt: now(), finishedAt: null, error: null, cancellable: spec.cancellable !== false,
    };
    const l: Live = { info, ctl, cancel: spec.cancel, params: spec.resume ?? null, persist: spec.resume !== undefined, lastSave: 0 };
    this.live.set(info.id, l);
    this.save(l, true);
    this.emit(info);
    const ctx: JobCtx = {
      id: info.id, signal: ctl.signal,
      progress: (done, total, message) => {
        info.progress = { done, total, message: message ?? info.progress.message };
        this.save(l, false);
        this.emit(info);
      },
    };
    try {
      // A tracked job is background work: its model calls wait behind the DM and the players, whoever started it.
      const out = await withPriority(0, () => fn(ctx));
      info.status = ctl.signal.aborted ? 'cancelled' : 'done';
      return out;
    } catch (err: any) {
      info.status = ctl.signal.aborted ? 'cancelled' : 'error';
      info.error = String(err?.message ?? err).slice(0, 300);
      throw err;
    } finally {
      info.finishedAt = now();
      this.live.delete(info.id);
      this.recent.unshift(info);
      if (this.recent.length > KEEP_FINISHED) this.recent.length = KEEP_FINISHED;
      this.save(l, true);
      this.emit(info);
    }
  }

  /** Stop a running job. False when it is not running. */
  cancel(jobId: string): boolean {
    const l = this.live.get(jobId);
    if (!l || !l.info.cancellable) return false;
    l.ctl.abort();
    try { l.cancel?.(); } catch { /* the work stops on its own signal */ }
    return true;
  }

  private emit(j: JobInfo) { for (const fn of this.listeners) { try { fn(j); } catch { /* a listener's problem */ } } }

  private save(l: Live, force: boolean) {
    if (!this.db || !l.persist) return;
    const t = Date.now();
    if (!force && t - l.lastSave < 1000) return;
    l.lastSave = t;
    try {
      const i = l.info;
      run(this.db, `INSERT INTO jobs (id, kind, title, world_id, params, status, progress, error, started_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, progress = excluded.progress, error = excluded.error, updated_at = excluded.updated_at, finished_at = excluded.finished_at`,
      i.id, i.kind, i.title, i.worldId, JSON.stringify(l.params ?? {}), i.status, JSON.stringify(i.progress), i.error, i.startedAt, now(), i.finishedAt);
      if (i.finishedAt) run(this.db, `DELETE FROM jobs WHERE status IN ('done', 'cancelled') AND finished_at < ?`, new Date(Date.now() - 86_400_000).toISOString());
    } catch { /* the registry is a view; losing a row costs only the resume */ }
  }
}

const registries = new WeakMap<DB, Jobs>();
/** The job registry of a database (one per server). */
export function jobsOf(db: DB): Jobs {
  let j = registries.get(db);
  if (!j) { j = new Jobs(db); registries.set(db, j); }
  return j;
}

/** Jobs that were running when the server stopped: marked interrupted, and returned so each kind can start its work again. */
export function takeInterrupted(db: DB): { id: string; kind: string; title: string; worldId: string | null; params: any }[] {
  try {
    db.exec(JOBS_SCHEMA);
    const rows = all<any>(db, `SELECT id, kind, title, world_id, params FROM jobs WHERE status = 'running' ORDER BY started_at`);
    for (const r of rows) run(db, `UPDATE jobs SET status = 'interrupted', finished_at = ?, error = 'The server restarted while this was running' WHERE id = ?`, now(), r.id);
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, worldId: r.world_id, params: (() => { try { return JSON.parse(r.params); } catch { return {}; } })() }));
  } catch { return []; }
}

export const hasJobRow = (db: DB, jobId: string) => !!one(db, 'SELECT 1 FROM jobs WHERE id = ?', jobId);
