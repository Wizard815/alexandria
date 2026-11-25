// OpenAI-compatible model endpoints, passed through to the configured
// provider (OpenAI, Argos, Ollama, LM Studio...).
//
// Who may use them: the admin and a DM, signed in. A player, a guest, and every scribe or MCP key are refused (403) unless the admin lists
// the account or the key (Admin > Models > Gateway access, or PUT /api/admin/models/access). Without a sign-in it is always 401 (see app.ts).
// So a player or a leaked key cannot spend the DM's provider credit. Each caller has a request rate (a minute) and a daily cap on requests
// and tokens, with a 429 that says which; every call is logged (core/modelcalls.ts) for the Model activity view.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { Readable } from 'node:stream';
import type { Deps } from '../app.ts';
import { type Auth, bearer } from '../core/auth.ts';
import { HttpError, sha256 } from '../core/util.ts';
import { one } from '../core/db.ts';
import { ClassifiedRefused, jobConfig, leafStrings, screenOutgoing, type Job } from '../core/ai.ts';
import { allowanceOf, recordCall, secondsToMidnightUtc, tokensOf, usedToday, type Allowance } from '../core/modelcalls.ts';

export default function modelRoutes(d: Deps) {
  const r = Router();
  const hits = new Map<string, number[]>();

  /** The gate: who, how fast, how much today. */
  function gate(req: Request, res: Response, next: NextFunction) {
    const auth = res.locals.auth as Auth | undefined;
    if (!auth) throw new HttpError(401, 'Sign in first');
    const isDm = !!one(d.db, `SELECT 1 FROM members WHERE account_id = ? AND role = 'dm'`, auth.account.id);
    const keyRow = auth.via === 'scribe_key' || auth.via === 'admin_key' ? one<any>(d.db, 'SELECT id FROM api_keys WHERE account_id = ? AND key_hash = ?', auth.account.id, sha256(bearer(req) ?? '')) : undefined;
    const a: Allowance = allowanceOf(d.db, {
      accountId: auth.account.id, keyId: keyRow?.id ?? null, isAdmin: !!auth.account.is_admin && auth.via !== 'scribe_key', isDm: isDm && auth.via === 'session',
      viaSession: auth.via === 'session', viaScribeKey: auth.via === 'scribe_key',
    }, d.env);
    const job: Job = req.path === '/embeddings' ? 'extra' : 'chat';
    const stopped = (outcome: 'refused' | 'limited', status: number) => recordCall(d.db, { job, model: null, feature: 'gateway', reason: req.path, via: 'gateway', accountId: auth.account.id, status, outcome });
    if (!a.allowed) stopped('refused', 403);
    if (!a.allowed) throw new HttpError(403, `The model gateway is for the DM and the admin (${a.why}). Ask the admin to allow this account or key.`);
    // A rate per minute for each account.
    const t = Date.now();
    const recent = (hits.get(auth.account.id) ?? []).filter((x) => t - x < 60_000);
    if (a.ratePerMinute > 0 && recent.length >= a.ratePerMinute) {
      stopped('limited', 429);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((60_000 - (t - recent[0])) / 1000))));
      throw new HttpError(429, `Too many model requests: ${a.ratePerMinute} a minute. Wait a moment.`);
    }
    recent.push(t);
    hits.set(auth.account.id, recent);
    // The daily caps.
    const used = usedToday(d.db, auth.account.id);
    if ((a.dailyRequests > 0 && used.requests >= a.dailyRequests) || (a.dailyTokens > 0 && used.tokens >= a.dailyTokens)) {
      stopped('limited', 429);
      res.setHeader('Retry-After', String(secondsToMidnightUtc()));
      throw new HttpError(429, a.dailyRequests > 0 && used.requests >= a.dailyRequests
        ? `Daily limit reached: ${used.requests} of ${a.dailyRequests} model requests today. It resets at 00:00 UTC; the admin can raise it.`
        : `Daily limit reached: ${used.tokens} of ${a.dailyTokens} tokens today. It resets at 00:00 UTC; the admin can raise it.`);
    }
    next();
  }

  async function pass(req: Request, res: Response, path: string, method: 'GET' | 'POST', job: Job = 'chat') {
    const auth = res.locals.auth as Auth;
    const c = jobConfig(d, job);
    if (!c) throw new HttpError(503, `No model endpoint set for "${job}": Admin → Models, or MODEL_BASE_URL (or OPENAI_BASE_URL / LOCAL_LLM_URL)`);
    // The gateway is a way to a model like any other: classified text never goes through it.
    if (method === 'POST') {
      try { screenOutgoing(d, job, leafStrings(req.body)); } catch (err) { if (err instanceof ClassifiedRefused) throw new HttpError(422, err.message); throw err; }
    }
    const url = c.baseUrl;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
    const t0 = performance.now();
    let up: globalThis.Response;
    try {
      up = await d.fetch(url + path, { method, headers, body: method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined });
    } catch (err: any) {
      recordCall(d.db, { job, model: c.model, feature: 'gateway', reason: path, via: 'gateway', accountId: auth.account.id, status: 0, ms: performance.now() - t0 });
      throw new HttpError(502, `Model endpoint did not answer: ${String(err.message).slice(0, 120)}`);
    }
    res.status(up.status);
    const type = up.headers.get('content-type') ?? 'application/json';
    res.setHeader('Content-Type', type);
    if (!up.body) { recordCall(d.db, { job, model: c.model, feature: 'gateway', reason: path, via: 'gateway', accountId: auth.account.id, status: up.status, ms: performance.now() - t0 }); return res.end(); }
    // An answer that is one JSON document is read whole, to count its tokens; a stream is passed on as it comes.
    if (/json/i.test(type) && !req.body?.stream) {
      const text = await up.text();
      let usage: any;
      try { usage = JSON.parse(text)?.usage; } catch { /* not JSON after all */ }
      recordCall(d.db, { job, model: c.model, feature: 'gateway', reason: path, via: 'gateway', accountId: auth.account.id, status: up.status, ms: performance.now() - t0, ...tokensOf(usage) });
      return res.send(text);
    }
    recordCall(d.db, { job, model: c.model, feature: 'gateway', reason: path, via: 'gateway', accountId: auth.account.id, status: up.status, ms: performance.now() - t0 });
    Readable.fromWeb(up.body as any).pipe(res);
  }

  r.use(gate);
  r.get('/models', (req, res) => pass(req, res, '/models', 'GET'));
  r.post('/chat/completions', (req, res) => pass(req, res, '/chat/completions', 'POST'));
  r.post('/embeddings', (req, res) => pass(req, res, '/embeddings', 'POST', 'extra'));
  return r;
}
