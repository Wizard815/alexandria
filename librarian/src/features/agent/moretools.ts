// The `more_tools` meta tool and the check for replies that claim a change that
// no tool call made. Both are the harness's own: they touch no world data.
import type { ChatTool } from '../../core/ai.ts';
import type { McpTool } from '../types.ts';

export const MORE_TOOLS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'more_tools',
    description: 'Look up tools you were not offered. Give a few words for what you want to do (for example "initiative", "play music", "create template", "give item"). It returns the matching tools with their arguments, and you can call them on your next step. Call this before ever saying you have no tool for something.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do' } }, required: ['query'] },
  },
};

const STOP = new Set('a an the and or of to in on at for with from by is are do does my me i it this that how what can you'.split(' '));
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);

/** Tools matching a few words, best first (name hits count most). `my_*` tools are for players, never listed for the DM. */
export function matchTools(tools: McpTool[], query: string, dm: boolean, max = 6): McpTool[] {
  const q = tokens(query);
  if (!q.length) return [];
  const scored = tools
    .filter((t) => !(dm && t.name.startsWith('my_')))
    .map((t) => {
      const name = new Set(tokens(t.name.replace(/_/g, ' ')));
      const desc = new Set(tokens(t.description));
      let score = 0;
      for (const w of q) { if (name.has(w)) score += 3; else if (desc.has(w)) score += 1; }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.t);
}

export function describeTools(list: McpTool[]): string {
  if (!list.length) return 'No tool matches that. If nothing fits, say plainly what you cannot do.';
  return JSON.stringify(list.map((t) => ({ name: t.name, write: !!t.write, description: t.description, parameters: { type: 'object', properties: t.props, required: t.required ?? [] } })));
}

/** A reply that says it proposed or changed something. */
const CLAIM = /(?:\bproposed\b|\bi['’]?ve (?:added|set|noted|updated|saved|logged|created|removed|queued|dealt|applied)\b|\bi (?:added|set|noted|updated|saved|logged|created|removed|queued|dealt|applied)\b|\b(?:was|has been|have been|is now) (?:added|set|updated|saved|logged|removed|applied)\b|\bset to \d+|\bnoted[.!:,]|\bhas been noted\b)/i;
const NEGATED = /\b(?:not|never|n['’]t|no|nothing|without|unless|if)\b[^.!?\n]{0,30}$/i;

const flat = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * Sentences of the reply that claim a change was proposed or made. `quoted` is what this turn's tools returned:
 * a sentence copied from there (a draft shown in full, a page read back) is data, not a claim; so are quoted
 * blocks, tables and code.
 */
export function claimSentences(reply: string, quoted = ''): string[] {
  const own = reply.split('\n').filter((l) => !/^\s*(?:>|\||```|    )/.test(l)).join('\n').replace(/```[\s\S]*?```/g, ' ');
  const src = quoted ? flat(quoted) : '';
  return (own.match(/[^.!?\n]+[.!?]*/g) ?? []).filter((s) => {
    const m = CLAIM.exec(s);
    if (!m) return false;
    const f = flat(s);
    if (src && f.length >= 20 && src.includes(f)) return false;
    return !NEGATED.test(s.slice(0, m.index));
  });
}
export const claimsChange = (reply: string, quoted = ''): boolean => claimSentences(reply, quoted).length > 0;

export const COULD_NOT = "I couldn't make that change — here's what I'd do:";

/** The reply with its claim sentences taken out and the honest line in front. */
export function rewriteClaim(reply: string, quoted = ''): string {
  let rest = reply;
  for (const s of claimSentences(reply, quoted)) rest = rest.replace(s, '');
  rest = rest.replace(/\n{3,}/g, '\n\n').replace(/^[\s:-]+/, '').trim();
  return rest ? `${COULD_NOT}\n\n${rest}` : COULD_NOT;
}
