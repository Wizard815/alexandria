// Macros: named sequences of actions with arguments and optional delays; and
// the runner that executes one and reports each step.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { type ArgSpec, ActionError, actionById, canRun, validateArgs, type Runner } from './catalog.ts';

export interface Step { action: string; args: Record<string, any>; delayMs: number; continueOnError: boolean }
export interface MacroRow { id: string; world_id: string; name: string; description: string; steps: string; params: string; player_run: number; pinned: number; created_by: string | null; created_at: string; updated_at: string }

export const MAX_STEPS = 30;
export const MAX_DELAY_MS = 10_000;
export const MAX_TOTAL_DELAY_MS = 60_000;

export const stepsOf = (m: Pick<MacroRow, 'steps'>): Step[] => parseJson<Step[]>(m.steps, []);
export const paramsOf = (m: Pick<MacroRow, 'params'>): ArgSpec[] => parseJson<ArgSpec[]>(m.params, []);

/** A macro as sent out. Players get the name and parameters only, never the steps (their arguments may hold GM text). */
export const macroOut = (m: MacroRow, full: boolean) => ({
  id: m.id, name: m.name, description: m.description, playerRun: !!m.player_run, pinned: !!m.pinned, params: paramsOf(m),
  ...(full ? { steps: stepsOf(m), createdAt: m.created_at, updatedAt: m.updated_at } : {}),
});

const TEMPLATE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Fill {{name}} in the string values of an argument object. A value that is only a template keeps the parameter's type. */
export function fill(args: unknown, vals: Record<string, any>): any {
  if (typeof args === 'string') {
    const whole = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(args);
    if (whole) return vals[whole[1]];
    return args.replace(TEMPLATE, (_m, n) => (vals[n] === undefined ? '' : String(vals[n])));
  }
  if (Array.isArray(args)) return args.map((x) => fill(x, vals));
  if (args && typeof args === 'object') return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, fill(v, vals)]));
  return args;
}

const refs = (v: unknown, out = new Set<string>()): Set<string> => {
  if (typeof v === 'string') for (const m of v.matchAll(TEMPLATE)) out.add(m[1]);
  else if (Array.isArray(v)) v.forEach((x) => refs(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => refs(x, out));
  return out;
};

/** Validate a macro body from a request (create or update). */
export function cleanMacro(input: any): { name: string; description: string; steps: Step[]; params: ArgSpec[]; playerRun: boolean; pinned: boolean } {
  const b = input && typeof input === 'object' ? input : {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) throw new HttpError(400, 'name is required (up to 80 characters)');
  const description = typeof b.description === 'string' ? b.description.slice(0, 300) : '';
  if (!Array.isArray(b.steps) || b.steps.length < 1 || b.steps.length > MAX_STEPS) throw new HttpError(400, `A macro needs 1 to ${MAX_STEPS} steps`);
  const params: ArgSpec[] = [];
  for (const p of Array.isArray(b.params) ? b.params : []) {
    if (!p || typeof p.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(p.name)) throw new HttpError(400, 'Each parameter needs a name of letters, digits and _');
    if (!['string', 'int', 'number', 'bool', 'enum'].includes(p.type)) throw new HttpError(400, `Parameter ${p.name}: type must be string, int, number, bool or enum`);
    if (params.some((x) => x.name === p.name)) throw new HttpError(400, `Parameter ${p.name} is listed twice`);
    params.push({
      name: p.name, type: p.type, label: typeof p.label === 'string' ? p.label.slice(0, 80) : undefined, default: p.default,
      values: p.type === 'enum' && Array.isArray(p.values) ? p.values.map(String).slice(0, 30) : undefined,
      min: typeof p.min === 'number' ? p.min : undefined, max: typeof p.max === 'number' ? p.max : undefined, required: p.required === true, maxLength: 500,
    });
  }
  if (params.length > 10) throw new HttpError(400, 'At most 10 parameters');
  const playerRun = b.playerRun === true;
  let total = 0;
  const steps: Step[] = b.steps.map((s: any, i: number): Step => {
    const a = typeof s?.action === 'string' ? actionById(s.action) : undefined;
    if (!a) throw new HttpError(400, `Step ${i + 1}: unknown action "${s?.action}"`);
    if (playerRun && !a.roles.includes('player')) throw new HttpError(400, `Step ${i + 1}: players may not run "${a.id}", so a macro players can run cannot use it`);
    let args = s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? s.args : {};
    // A Minerva prompt may write {place} for a parameter called place.
    if (a.id === 'minerva.run' && typeof args.prompt === 'string') args = { ...args, prompt: args.prompt.replace(/(?<!\{)\{([a-zA-Z_][a-zA-Z0-9_]*)\}(?!\})/g, (m: string, n: string) => (params.some((p) => p.name === n) ? `{{${n}}}` : m)) };
    for (const n of refs(args)) if (!params.some((p) => p.name === n)) throw new HttpError(400, `Step ${i + 1}: {{${n}}} is not one of the macro's parameters`);
    // Check what can be checked now: every argument that is not a template.
    const literal = Object.fromEntries(Object.entries(args).filter(([, v]) => refs(v).size === 0));
    try { validateArgs(a.args.map((x) => ({ ...x, required: false })), literal); } catch (e: any) { throw new HttpError(400, `Step ${i + 1}: ${e.message}`); }
    const delayMs = s.delayMs === undefined ? 0 : Number(s.delayMs);
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_DELAY_MS) throw new HttpError(400, `Step ${i + 1}: delayMs must be 0 to ${MAX_DELAY_MS}`);
    total += delayMs;
    return { action: a.id, args, delayMs, continueOnError: s.continueOnError === true };
  });
  if (total > MAX_TOTAL_DELAY_MS) throw new HttpError(400, `Delays add up to more than ${MAX_TOTAL_DELAY_MS / 1000} seconds`);
  return { name, description, steps, params, playerRun, pinned: b.pinned === true };
}

export function findMacro(d: Deps, worldId: string, ref: string): MacroRow | undefined {
  const r = String(ref ?? '').trim();
  return one<MacroRow>(d.db, 'SELECT * FROM actions_macros WHERE world_id = ? AND id = ?', worldId, r)
    ?? all<MacroRow>(d.db, 'SELECT * FROM actions_macros WHERE world_id = ?', worldId).find((m) => m.name.toLowerCase() === r.toLowerCase());
}

export interface StepReport { index: number; action: string; status: 'ok' | 'failed' | 'skipped'; ms: number; result?: unknown; error?: string }
export interface RunReport { ok: boolean; macro: { id: string; name: string }; steps: StepReport[] }

const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Run a macro as `rc`. A failed step stops the run unless it says continueOnError; the rest are reported as skipped. */
export async function runMacro(rc: Runner, m: MacroRow, overrides: unknown, via: string): Promise<RunReport> {
  if (rc.role !== 'gm' && !m.player_run) throw new ActionError('Players cannot run that macro', 403);
  const vals = validateArgs(paramsOf(m), overrides);
  const steps = stepsOf(m);
  const report: StepReport[] = [];
  let stopped = false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (stopped) { report.push({ index: i, action: s.action, status: 'skipped', ms: 0 }); continue; }
    if (s.delayMs) await sleep(s.delayMs);
    const t0 = Date.now();
    try {
      const a = actionById(s.action);
      if (!a) throw new ActionError(`The action ${s.action} no longer exists`, 404);
      if (!canRun(a, rc.role)) throw new ActionError(`${rc.role === 'gm' ? 'You' : 'Players'} may not run ${a.id}`, 403);
      const result = await a.run(rc, validateArgs(a.args, fill(s.args, vals)));
      report.push({ index: i, action: s.action, status: 'ok', ms: Date.now() - t0, result });
    } catch (e: any) {
      report.push({ index: i, action: s.action, status: 'failed', ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) });
      if (!s.continueOnError) stopped = true;
    }
  }
  const out: RunReport = { ok: report.every((x) => x.status === 'ok' || (x.status === 'failed' && steps[x.index].continueOnError)), macro: { id: m.id, name: m.name }, steps: report };
  run(rc.d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', rc.worldId, rc.accountId, 'macro.run', `${m.name} via ${via}: ${report.map((x) => `${x.action}=${x.status}`).join(' ')}`.slice(0, 500), now());
  return out;
}
