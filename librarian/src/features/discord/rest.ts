// Discord's REST API for the bot: one function with the token, JSON, and the
// rate limits Discord answers with (429 + retry_after) waited out a few times.
import { API_VERSION } from './gateway.ts';

export const DEFAULT_API = `https://discord.com/api/v${API_VERSION}`;

export class DiscordError extends Error {
  status: number;
  code?: number;
  constructor(status: number, message: string, code?: number) { super(message); this.status = status; this.code = code; }
}

export interface Rest {
  (method: string, path: string, body?: unknown): Promise<any>;
}

export function makeRest(token: string, opts: { base?: string; fetch?: typeof fetch } = {}): Rest {
  const base = (opts.base || DEFAULT_API).replace(/\/+$/, '');
  const f = opts.fetch ?? fetch;
  return async function rest(method: string, path: string, body?: unknown) {
    for (let attempt = 0; ; attempt++) {
      const r = await f(base + path, {
        method,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://github.com/Wizard815/alexandria, 1)' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 429 && attempt < 3) {
        const j: any = await r.json().catch(() => ({}));
        const wait = Math.min(10, Number(j.retry_after ?? r.headers.get('retry-after') ?? 1));
        await new Promise((res) => setTimeout(res, Math.max(0.05, wait) * 1000));
        continue;
      }
      const text = await r.text();
      let j: any = null;
      try { j = text ? JSON.parse(text) : null; } catch { j = null; }
      if (!r.ok) throw new DiscordError(r.status, discordMessage(r.status, j), j?.code);
      return j;
    }
  };
}

/** Plain words for the errors a GM will meet setting a bot up. */
function discordMessage(status: number, j: any): string {
  const code = Number(j?.code ?? 0);
  if (status === 401) return 'Discord did not accept the bot token.';
  if (code === 50001) return 'The bot cannot see that channel. Give it the View Channel permission there.';
  if (code === 50013) return 'The bot is missing a permission there (it needs View Channel and Send Messages).';
  if (code === 50007) return 'Discord would not let the bot message that person (their DMs are closed to server members).';
  if (code === 10003) return 'That channel does not exist, or the bot is not in its server.';
  if (code === 10004) return 'The bot is not in that server yet. Invite it with the link on this page.';
  return `Discord answered ${status}${j?.message ? `: ${String(j.message).slice(0, 200)}` : ''}`;
}

/** Discord's limit for one message's content. */
export const MAX_CONTENT = 2000;

/** Long text as Discord-sized pieces, split on paragraph, then line, then word. */
export function chunks(text: string, max = MAX_CONTENT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Text Discord will not turn into a ping or a link preview of someone's mention. */
export const noPings = { parse: [] as string[] };
