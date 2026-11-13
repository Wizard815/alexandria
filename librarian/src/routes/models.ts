// OpenAI-compatible model endpoints, passed through to the configured
// provider (OpenAI, Argos, Ollama, LM Studio...). Signed-in callers only, so
// the librarian is never an open proxy for your API key.
import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import type { Deps } from '../app.ts';
import { HttpError } from '../core/util.ts';
import { jobConfig, type Job } from '../core/ai.ts';

export default function modelRoutes(d: Deps) {
  const r = Router();
  async function pass(req: Request, res: Response, path: string, method: 'GET' | 'POST', job: Job = 'chat') {
    const c = jobConfig(d, job);
    if (!c) throw new HttpError(503, `No model endpoint set for "${job}": Admin → Models, or MODEL_BASE_URL (or OPENAI_BASE_URL / LOCAL_LLM_URL)`);
    const url = c.baseUrl;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers.Authorization = `Bearer ${c.apiKey}`;
    let up: globalThis.Response;
    try {
      up = await d.fetch(url + path, { method, headers, body: method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined });
    } catch (err: any) {
      throw new HttpError(502, `Model endpoint did not answer: ${String(err.message).slice(0, 120)}`);
    }
    res.status(up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') ?? 'application/json');
    if (!up.body) return res.end();
    Readable.fromWeb(up.body as any).pipe(res);
  }

  r.get('/models', (req, res) => pass(req, res, '/models', 'GET'));
  r.post('/chat/completions', (req, res) => pass(req, res, '/chat/completions', 'POST'));
  r.post('/embeddings', (req, res) => pass(req, res, '/embeddings', 'POST', 'extra'));
  return r;
}
