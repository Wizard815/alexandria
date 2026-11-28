// What the GM agent is given, as switches. The defaults are the configuration
// the real-model ablations (docs/MODELS.md) found best; each switch exists so an
// aid can be turned off to measure it, or by an operator who finds it does not
// help on their model. Set ALX_AGENT_OPTS to a JSON object with any of these
// keys, for example ALX_AGENT_OPTS='{"tools":"keywords"}'.
import type { Deps } from '../../app.ts';

export interface AgentOptions {
  /**
   * Which tools the GM harness offers on each message:
   *  keywords  the fixed core plus the keyword categories (intent.ts)
   *  all       every GM tool, no selection
   *  core      only the fixed core and more_tools
   *  embed     the core plus the tools nearest the request by embeddings
   *  hybrid    the keyword selection plus the nearest tools by embeddings
   * The embedding modes fall back to `keywords` when no embeddings model is set.
   */
  tools: 'keywords' | 'all' | 'core' | 'embed' | 'hybrid';
  /** How many tools the embedding modes add. */
  embedK: number;
  /** current: the descriptions as registered; concise: "use when..." rewrites with an example. */
  desc: 'current' | 'concise';
  /** The prefetched Campaign Status (and, for prep, the arc and last session) in the first message. */
  status: boolean;
  /** Offer story_bible (and related_pages). */
  bible: boolean;
  /**
   * The rules in the GM system prompt: full (the working order and the codex rules), lite (do what is asked with the matching
   * tool, no look-up first, facts only from what you were given) or off (only who the assistant is, and to be brief).
   */
  skills: 'full' | 'lite' | 'off';
  /** Library matches in the first message: keyword search alone, or keyword plus embeddings (reciprocal rank fusion). */
  retrieval: 'keyword' | 'hybrid';
}

export const DEFAULTS: AgentOptions = { tools: 'hybrid', embedK: 10, desc: 'concise', status: true, bible: true, skills: 'lite', retrieval: 'hybrid' };

const cache = new WeakMap<object, { raw: string; opts: AgentOptions }>();

export function agentOptions(d: Pick<Deps, 'env'>): AgentOptions {
  const raw = String(d.env?.ALX_AGENT_OPTS ?? '');
  const hit = cache.get(d.env as object);
  if (hit && hit.raw === raw) return hit.opts;
  let o: Record<string, unknown> = {};
  if (raw) { try { const j = JSON.parse(raw); if (j && typeof j === 'object') o = j; } catch { /* the defaults */ } }
  const pick = <T extends string>(v: unknown, ok: readonly T[], def: T): T => (ok.includes(v as T) ? (v as T) : def);
  const opts: AgentOptions = {
    tools: pick(o.tools, ['keywords', 'all', 'core', 'embed', 'hybrid'] as const, DEFAULTS.tools),
    embedK: Number.isFinite(Number(o.embedK)) && Number(o.embedK) > 0 ? Math.min(40, Math.round(Number(o.embedK))) : DEFAULTS.embedK,
    desc: pick(o.desc, ['current', 'concise'] as const, DEFAULTS.desc),
    status: typeof o.status === 'boolean' ? o.status : DEFAULTS.status,
    bible: typeof o.bible === 'boolean' ? o.bible : DEFAULTS.bible,
    skills: o.skills === true ? 'full' : o.skills === false ? 'off' : pick(o.skills as unknown, ['full', 'lite', 'off'] as const, DEFAULTS.skills),
    retrieval: pick(o.retrieval, ['keyword', 'hybrid'] as const, DEFAULTS.retrieval),
  };
  cache.set(d.env as object, { raw, opts });
  return opts;
}
