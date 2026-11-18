// Embedding-based tool selection: each tool's name and description is embedded
// once (kept in memory for the life of the process), the request is embedded
// per message, and the tools nearest the request by cosine are offered. Needs
// the embeddings job ("extra"); with none, or on any error, it returns null and
// the caller keeps the keyword selection, so nothing changes without a model.
import type { Deps } from '../../app.ts';
import { embed, hasJob, jobConfig } from '../../core/ai.ts';
import type { McpTool } from '../types.ts';

const BATCH = 64;
const store = new WeakMap<object, Map<string, Float32Array>>();

const unit = (v: number[]): Float32Array => {
  const f = Float32Array.from(v);
  let n = 0;
  for (const x of f) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
};

/** What is embedded for a tool: its name as words, then what it says it does. */
export const toolText = (t: { name: string; description: string }): string => `${t.name.replace(/_/g, ' ')}: ${t.description}`.slice(0, 600);

/** Vectors for the tools, embedding the ones not seen yet (any error: null). */
export async function toolVectors(d: Deps, tools: { name: string; description: string }[]): Promise<Map<string, Float32Array> | null> {
  const model = jobConfig(d, 'extra')?.model;
  if (!model) return null;
  let m = store.get(d.env as object);
  const key = (t: { name: string; description: string }) => `${model}|${toolText(t)}`;
  if (!m) { m = new Map(); store.set(d.env as object, m); }
  const todo = tools.filter((t) => !m!.has(key(t)));
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const part = todo.slice(i, i + BATCH);
      const got = await embed(d, part.map(toolText));
      if (got.length !== part.length || got.some((v) => !Array.isArray(v) || !v.length)) return null;
      part.forEach((t, j) => m!.set(key(t), unit(got[j])));
    }
  } catch { return null; }
  return new Map(tools.map((t) => [t.name, m!.get(key(t))!]));
}

/** The `k` tools nearest the request (best first), or null when no embeddings model answers. */
export async function nearestTools(d: Deps, text: string, tools: McpTool[], k: number): Promise<string[] | null> {
  if (!hasJob(d, 'extra') || !text.trim()) return null;
  const vecs = await toolVectors(d, tools);
  if (!vecs) return null;
  let q: Float32Array;
  try {
    const got = await embed(d, [text.slice(0, 500)]);
    if (!got[0]?.length) return null;
    q = unit(got[0]);
  } catch { return null; }
  const scored: { name: string; sim: number }[] = [];
  for (const [name, v] of vecs) {
    if (v.length !== q.length) return null;
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
    scored.push({ name, sim: dot });
  }
  return scored.sort((a, b) => b.sim - a.sim).slice(0, k).map((x) => x.name);
}
