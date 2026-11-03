// OpenAI-compatible model endpoints, passed through to the configured
// provider (OpenAI, Argos, Ollama, LM Studio...). Signed-in callers only, so
// the librarian is never an open proxy for your API key.
import { Router, type Request, type Response } from 'express';
import { Readable } from 'node:stream';
import type { Deps } from '../app.ts';
import { HttpError } from '../core/util.ts';

export default function modelRoutes(d: Deps) {
  const r = Router();
  const base = () => (d.env.MODEL_BASE_URL || d.env.OPENAI_BASE_URL || d.env.LOCAL_LLM_URL && `${d.env.LOCAL_LLM_URL.replace(/\/$/, '')}/v1` || '').replace(/\/$/, '');
  const key = () => d.env.MODEL_API_KEY || d.env.OPENAI_API_KEY || '';

  async function pass(req: Request, res: Response, path: string, method: 'GET' | 'POST') {
    const url = base();
    if (!url) throw new HttpError(503, 'No model endpoint set: MODEL_BASE_URL (or OPENAI_BASE_URL / LOCAL_LLM_URL)');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key()) headers.Authorization = `Bearer ${key()}`;
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
  r.post('/embeddings', (req, res) => pass(req, res, '/embeddings', 'POST'));
  return r;
}
