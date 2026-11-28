// Tool calls from local models are often nearly right: arguments wrapped in a code fence or with a trailing comma,
// a number sent as "5", "True" for true, an enum in the wrong case, a list sent as a JSON string, or a tool name
// that is close to a real one ("search" for search_library). Each is put right here when it can be done safely;
// otherwise the model is told exactly what is wrong, before a write ever becomes a card the GM approves and that
// then fails.
import type { McpTool } from '../types.ts';

export type Parsed = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

/** The model's arguments text as an object. Empty means no arguments. A near-miss (fences, trailing commas, text around it) is repaired. */
export function parseToolArgs(raw: unknown): Parsed {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ok: true, args: raw as Record<string, unknown> };
  const s0 = typeof raw === 'string' ? raw.trim() : '';
  if (!s0) return { ok: true, args: {} };
  const tryOne = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      // Some servers send the arguments JSON as a JSON string.
      if (typeof v === 'string') return tryOne(v);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const direct = tryOne(s0);
  if (direct) return { ok: true, args: direct };
  let s = s0.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  s = s.replace(/,\s*([}\]])/g, '$1');
  const fixed = tryOne(s);
  if (fixed) return { ok: true, args: fixed };
  return { ok: false, error: `The arguments were not valid JSON (${s0.slice(0, 120)}${s0.length > 120 ? '…' : ''}). Send one JSON object, for example {"name": "value"}.` };
}

const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** One value against its schema: the value put right, or why it cannot be. */
function fit(key: string, spec: any, v: unknown): { v: unknown; problem?: string } {
  if (!spec || typeof spec !== 'object') return { v };
  const want = spec.type as string | undefined;
  let x = v;
  if (want === 'integer' || want === 'number') {
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x.trim()))) x = Number(x.trim());
    if (typeof x !== 'number' || !Number.isFinite(x)) return { v, problem: `${key} must be a number, got ${typeOf(v)} ${JSON.stringify(v)?.slice(0, 40)}` };
    if (want === 'integer' && !Number.isInteger(x)) {
      if (Math.abs(x - Math.round(x)) < 1e-9) x = Math.round(x);
      else return { v, problem: `${key} must be a whole number, got ${x}` };
    }
  } else if (want === 'boolean') {
    if (typeof x === 'string' && /^(true|false|yes|no)$/i.test(x.trim())) x = /^(true|yes)$/i.test(x.trim());
    if (typeof x !== 'boolean') return { v, problem: `${key} must be true or false, got ${JSON.stringify(v)?.slice(0, 40)}` };
  } else if (want === 'string') {
    if (typeof x === 'number' || typeof x === 'boolean') x = String(x);
  } else if (want === 'array') {
    // Some schemas are looser than their routes (a route may also take one value), so only a list sent as JSON text is put right.
    if (typeof x === 'string' && x.trim().startsWith('[')) { try { x = JSON.parse(x); } catch { /* left for the route */ } }
    if (Array.isArray(x) && spec.items && typeof spec.items === 'object') {
      const out: unknown[] = [];
      for (const [i, el] of x.entries()) {
        const r = fit(`${key}[${i}]`, spec.items, el);
        if (r.problem) return { v, problem: r.problem };
        out.push(r.v);
      }
      x = out;
    }
  } else if (want === 'object') {
    // A date may be an object or minutes, and so on: only an object sent as JSON text is put right.
    if (typeof x === 'string' && x.trim().startsWith('{')) { try { x = JSON.parse(x); } catch { /* left for the route */ } }
  }
  if (Array.isArray(spec.enum) && spec.enum.length) {
    if (!spec.enum.includes(x)) {
      const hit = typeof x === 'string' ? spec.enum.find((e: unknown) => typeof e === 'string' && e.toLowerCase() === (x as string).trim().toLowerCase()) : undefined;
      if (hit === undefined) return { v, problem: `${key} must be one of ${spec.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(v)?.slice(0, 40)}` };
      x = hit;
    }
  }
  return { v: x };
}

export interface Checked { args: Record<string, unknown>; problems: string[] }

/**
 * The arguments checked against the tool's own schema: missing required fields, numbers and booleans that are not,
 * and enum values. Safe repairs are made (numbers sent as text, booleans as "true", an enum in the wrong case, a
 * list or object sent as JSON text, null for an optional field); anything else wrong is a problem to send back to
 * the model. Text, list and object fields are not refused for their type (some routes take more than one shape),
 * and fields the schema does not name are left alone.
 */
export function checkArgs(tool: Pick<McpTool, 'props' | 'required'>, args0: Record<string, unknown>): Checked {
  const args: Record<string, unknown> = { ...(args0 ?? {}) };
  const problems: string[] = [];
  const req = new Set(tool.required ?? []);
  for (const [k, spec] of Object.entries(tool.props ?? {})) {
    if (!(k in args)) continue;
    if (args[k] === null || args[k] === undefined) { if (!req.has(k)) delete args[k]; continue; }
    const r = fit(k, spec, args[k]);
    if (r.problem) problems.push(r.problem);
    else args[k] = r.v;
  }
  for (const k of req) if (args[k] === undefined || args[k] === null || args[k] === '') problems.push(`${k} is required`);
  return { args, problems };
}

/** Real tool names nearest a name the model made up, best first (at most `k`). */
export function nearestToolNames(name: string, names: string[], k = 3): string[] {
  const want = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!want) return [];
  const parts = want.split('_').filter((p) => p.length >= 3);
  const scored = names.map((n) => {
    const low = n.toLowerCase();
    let score = 0;
    if (low === want) score = 100;
    else if (low.includes(want) || want.includes(low)) score = 50;
    const np = low.split('_');
    for (const p of parts) if (np.includes(p)) score += 10; else if (np.some((q) => q.startsWith(p) || p.startsWith(q))) score += 5;
    score -= Math.abs(low.length - want.length) / 10;
    return { n, score };
  }).filter((x) => x.score >= 5);
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.n);
}
