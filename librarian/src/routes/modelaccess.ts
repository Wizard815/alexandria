// Admin: who has been calling models, and who may use the /v1 gateway besides the GM and the admin.
//
//   GET    /api/admin/models/activity            { jobs, callers, recent }   per job: last call, calls in the last hour and day, which features
//   GET    /api/admin/models/activity/gateway    { since, calls, users }      the /v1 call log and per-account totals today vs caps (no prompts)
//   GET    /api/admin/models/access              { allowed: [...], defaults }
//   PUT    /api/admin/models/access              { kind: 'account' | 'key', id, dailyRequests?, dailyTokens?, note? }
//   DELETE /api/admin/models/access/:kind/:id
import { Router } from 'express';
import type { Deps } from '../app.ts';
import { all, one, run } from '../core/db.ts';
import { HttpError, int, now, oneOf, str } from '../core/util.ts';
import { activity, gatewayLog } from '../core/modelcalls.ts';
import { audit } from '../app.ts';
import type { Auth } from '../core/auth.ts';

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export function activityRoutes(d: Deps) {
  const r = Router();
  r.get('/', (req, res) => res.json(activity(d.db, { limit: Number(req.query.limit) || 50 })));
  r.get('/gateway', (req, res) => res.json(gatewayLog(d.db, d.env, { limit: Number(req.query.limit) || 100 })));
  return r;
}

export function accessRoutes(d: Deps) {
  const r = Router();
  const me = (res: any) => (res.locals.auth as Auth).account.id;

  r.get('/', (_req, res) => {
    const rows = all<any>(d.db, `SELECT m.subject_kind, m.subject_id, m.daily_requests, m.daily_tokens, m.note, m.at,
        CASE m.subject_kind WHEN 'account' THEN (SELECT username FROM accounts WHERE id = m.subject_id) ELSE (SELECT label FROM api_keys WHERE id = m.subject_id) END AS name
      FROM model_access m ORDER BY m.at DESC`);
    res.json({
      allowed: rows.map((x) => ({ kind: x.subject_kind, id: x.subject_id, name: x.name ?? null, dailyRequests: x.daily_requests, dailyTokens: x.daily_tokens, note: x.note, at: x.at })),
      defaults: {
        listed: { dailyRequests: num(d.env.ALX_V1_DAILY_REQUESTS, 200), dailyTokens: num(d.env.ALX_V1_DAILY_TOKENS, 100_000), ratePerMinute: num(d.env.ALX_V1_RATE_PER_MIN, 20) },
        dm: { dailyRequests: num(d.env.ALX_V1_DAILY_REQUESTS_DM, 5000), dailyTokens: num(d.env.ALX_V1_DAILY_TOKENS_DM, 2_000_000), ratePerMinute: num(d.env.ALX_V1_RATE_PER_MIN_DM, 120) },
      },
    });
  });

  r.put('/', (req, res) => {
    const kind = oneOf(req.body?.kind, 'kind', ['account', 'key'] as const);
    const id = str(req.body?.id, 'id', { max: 80 });
    const exists = kind === 'account' ? one(d.db, 'SELECT 1 FROM accounts WHERE id = ?', id) : one(d.db, 'SELECT 1 FROM api_keys WHERE id = ? AND revoked = 0', id);
    if (!exists) throw new HttpError(404, kind === 'account' ? 'No such account' : 'No such key');
    const reqs = int(req.body?.dailyRequests, 'dailyRequests', { min: 0, max: 1_000_000, optional: true }) ?? null;
    const toks = int(req.body?.dailyTokens, 'dailyTokens', { min: 0, max: 1_000_000_000, optional: true }) ?? null;
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : '';
    run(d.db, `INSERT INTO model_access (subject_kind, subject_id, daily_requests, daily_tokens, note, added_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (subject_kind, subject_id) DO UPDATE SET daily_requests = excluded.daily_requests, daily_tokens = excluded.daily_tokens, note = excluded.note`, kind, id, reqs, toks, note, me(res), now());
    audit(d.db, null, me(res), 'models.gateway_allow', `${kind} ${id}`);
    res.json({ ok: true });
  });

  r.delete('/:kind/:id', (req, res) => {
    const kind = oneOf(req.params.kind, 'kind', ['account', 'key'] as const);
    run(d.db, 'DELETE FROM model_access WHERE subject_kind = ? AND subject_id = ?', kind, String(req.params.id));
    audit(d.db, null, me(res), 'models.gateway_revoke', `${kind} ${req.params.id}`);
    res.json({ ok: true });
  });

  return r;
}
