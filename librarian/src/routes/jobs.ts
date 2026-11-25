// Admin > the heavy work the server is doing right now.
//
//   GET  /api/admin/jobs               { busy, warming, phase, jobs: [...], memory }   running jobs first, then the latest finished
//   POST /api/admin/jobs/:id/cancel    stop one
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { HttpError } from '../core/util.ts';

export default function jobRoutes(d: Deps) {
  const r = Router();

  r.get('/', (_req, res) => {
    const m = process.memoryUsage();
    res.json({
      busy: d.jobs.busy(),
      warming: d.startup.warming,
      phase: d.startup.phase,
      jobs: d.jobs.list(),
      memory: { rssMb: Math.round(m.rss / 1048576), heapMb: Math.round(m.heapUsed / 1048576) },
    });
  });

  r.post('/:id/cancel', (req, res) => {
    const id = String(req.params.id);
    if (!d.jobs.get(id)) throw new HttpError(404, 'No such job');
    res.json({ ok: true, cancelled: d.jobs.cancel(id) });
  });

  return r;
}
