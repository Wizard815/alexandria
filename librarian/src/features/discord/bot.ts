// The Discord bot: one gateway connection per bot token (several worlds may
// share one bot, each on its own Discord server), slash commands for linked
// players, and posts that follow what happens in Alexandria.
//
// What goes to Discord, and to whom:
//   recap channel   a session log entry when the GM publishes it (party-level text only)
//   roll channel    dice rolled in the table chat (never the party chat, never a hidden one)
//   a player's DMs  their own broker answers and price offers, and the GM's special offers sent to them
// Nothing GM-only is ever posted: every post is built from what the players
// already see in the app. Commands act as the linked account, with its role
// checked on every call, so a player who left the world can do nothing.
import type { Deps } from '../../app.ts';
import { all, one, run } from '../../core/db.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { parseJson } from '../../core/util.ts';
import { money } from '../../core/coin.ts';
import { Gateway } from './gateway.ts';
import { chunks, DiscordError, makeRest, noPings, type Rest } from './rest.ts';
import { configOf, firstPost, liveConfigs, useCode, whoIs, discordUserOf, roleOf, type Config } from './store.ts';
import { addMessage, currentSession } from '../sessionchat/chat.ts';
import { parseRoll, type Roll } from '../sessionchat/dice.ts';
import { fanoutChat } from '../sessionchat/index.ts';
import { askQuick, QUICK_TASKS, type QuickTask } from '../playerhelp/quick.ts';

const EPHEMERAL = 64;
/** View Channel + Send Messages + Embed Links + Read Message History. */
export const INVITE_PERMISSIONS = 1024 + 2048 + 16384 + 65536;

export const COMMANDS = [
  { name: 'link', description: 'Link your Alexandria character (get a code in the app: Settings & account → Discord)', options: [{ type: 3, name: 'code', description: 'The code the app shows you', required: true, max_length: 20 }] },
  { name: 'unlink', description: 'Stop this Discord account acting as your Alexandria character' },
  { name: 'roll', description: 'Roll dice at the table, e.g. 2d20kh1+5 attack', options: [{ type: 3, name: 'dice', description: 'Dice and a note: 2d6+3 sneak attack', required: true, max_length: 200 }] },
  {
    name: 'ask', description: 'Ask your Squire (only you see the answer unless you share it)', options: [
      { type: 3, name: 'question', description: 'Your question', max_length: 400 },
      { type: 3, name: 'task', description: 'What kind of help', choices: [
        { name: 'Answer a question', value: 'ask' }, { name: 'A rules question', value: 'rules' }, { name: 'My turn: what can I do?', value: 'turn' },
        { name: 'Sum up my character', value: 'sheet' }, { name: 'What should I do next?', value: 'suggest' }, { name: 'The story so far', value: 'recap' },
      ] },
      { type: 5, name: 'share', description: 'Post the answer in the channel for everyone' },
    ],
  },
  { name: 'recap', description: 'The last published session recap', options: [{ type: 5, name: 'share', description: 'Post it in the channel for everyone' }] },
];

export interface BotStatus {
  connected: boolean;
  error: string | null;
  botName: string | null;
  applicationId: string | null;
  guilds: { id: string; name: string }[];
}

const settingsOf = (d: Deps, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(d.db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings, {}) });
const worldName = (d: Deps, worldId: string) => String(one<any>(d.db, 'SELECT name FROM worlds WHERE id = ?', worldId)?.name ?? 'the world');
const appUrl = (d: Deps, path = '') => { const b = d.env.ALX_PUBLIC_URL?.replace(/\/+$/, ''); return b ? `${b}${path}` : null; };
const slugOf = (d: Deps, worldId: string) => String(one<any>(d.db, 'SELECT slug FROM worlds WHERE id = ?', worldId)?.slug ?? worldId);

/** "**Brindle** rolled 2d6+3 sneak attack: **11** (4, 4, +3)". */
export function rollText(name: string, r: Roll): string {
  const parts = r.terms.map((t) => (t.dice.length ? (t.kept && t.kept.length !== t.dice.length ? `${t.term.replace(/^\+/, '')} [${t.dice.join(', ')} → ${t.kept.join(', ')}]` : `${t.term.replace(/^\+/, '')} [${t.dice.join(', ')}]`) : t.term)).join(' ');
  const nat = r.terms.length === 1 && r.terms[0].dice.length === 1 && /d20$/.test(r.terms[0].term) ? (r.terms[0].dice[0] === 20 ? ' · natural 20!' : r.terms[0].dice[0] === 1 ? ' · natural 1' : '') : '';
  return `🎲 **${md(name)}** rolled \`${r.expr}\`${r.note ? ` ${md(r.note)}` : ''}: **${r.total}**  (${parts})${nat}`;
}

/** Discord markdown and mentions out of text that came from a person. */
export const md = (s: string) => s.replace(/([\\*_`~|>])/g, '\\$1').replace(/@(everyone|here)/g, '@\u200b$1').replace(/<([@#&!])/g, '<\u200b$1');

export function recapText(e: { number: number; title: string; summary: string }, worldLabel: string): string[] {
  const head = /^session\b/i.test(e.title.trim()) ? e.title.trim() : `Session ${e.number}: ${e.title.trim()}`;
  return chunks(`📜 **${md(worldLabel)}: ${md(head)}**\n\n${e.summary}`);
}

class Bot {
  rest: Rest;
  gateway: Gateway | null = null;
  status: BotStatus = { connected: false, error: null, botName: null, applicationId: null, guilds: [] };
  private registered = new Map<string, string>(); // guild -> world it was registered for
  private dmChannels = new Map<string, string>();
  private stopped = false;

  private d: Deps;
  private m: Manager;
  readonly token: string;

  constructor(d: Deps, m: Manager, token: string) {
    this.d = d;
    this.m = m;
    this.token = token;
    this.rest = makeRest(token, { base: d.env.ALX_DISCORD_API, fetch: m.fetch });
  }

  async start() {
    try {
      const g = await this.rest('GET', '/gateway/bot');
      if (this.stopped) return;
      this.gateway = new Gateway({
        token: this.token, url: String(g?.url ?? 'wss://gateway.discord.gg'), log: (s) => console.warn(s),
        events: {
          ready: (i) => { this.status.botName = i.username; this.status.applicationId = i.applicationId; this.registered.clear(); void this.registerAll(); },
          status: (s) => { this.status.connected = s.connected; if (s.error !== undefined) this.status.error = s.error; if (s.connected) this.status.error = null; },
          dispatch: (t, data) => this.dispatch(t, data),
        },
      });
      this.gateway.start();
    } catch (e: any) {
      this.status.error = e instanceof DiscordError ? e.message : `Could not reach Discord: ${e?.message ?? e}`;
      if (!(e instanceof DiscordError && e.status === 401) && !this.stopped) setTimeout(() => { if (!this.stopped) void this.start(); }, 60_000).unref();
    }
  }

  stop() { this.stopped = true; this.gateway?.stop(); }

  worlds(): Config[] { return liveConfigs(this.d.db).filter((c) => c.token === this.token); }

  /** Slash commands on each server a world uses; again when a world moves to another server. */
  async registerAll() {
    const app = this.status.applicationId;
    if (!app) return;
    for (const c of this.worlds()) {
      if (!c.guildId || this.registered.get(c.guildId) === c.worldId) continue;
      if (this.status.guilds.length && !this.status.guilds.some((g) => g.id === c.guildId)) continue; // not invited yet: GUILD_CREATE registers it
      try {
        await this.rest('PUT', `/applications/${app}/guilds/${c.guildId}/commands`, COMMANDS);
        this.registered.set(c.guildId, c.worldId);
      } catch (e: any) { this.status.error = `Commands on the server: ${e?.message ?? e}`; }
    }
  }

  private dispatch(t: string, data: any) {
    if (t === 'GUILD_CREATE' && data?.id) {
      if (!this.status.guilds.some((g) => g.id === data.id)) this.status.guilds.push({ id: String(data.id), name: String(data.name ?? '') });
      void this.registerAll();
    } else if (t === 'GUILD_DELETE' && data?.id) {
      this.status.guilds = this.status.guilds.filter((g) => g.id !== data.id);
      this.registered.delete(String(data.id));
    } else if (t === 'INTERACTION_CREATE' && data?.type === 2) {
      void this.interaction(data).catch((e) => console.warn(`discord: /${data?.data?.name} failed: ${e?.message ?? e}`));
    }
  }

  // ---- posting ----

  async post(channel: string, content: string): Promise<string | null> {
    const r = await this.rest('POST', `/channels/${channel}/messages`, { content, allowed_mentions: noPings });
    return r?.id ? String(r.id) : null;
  }

  async gm(user: string, content: string) {
    let ch = this.dmChannels.get(user);
    if (!ch) {
      const r = await this.rest('POST', '/users/@me/channels', { recipient_id: user });
      ch = String(r.id);
      this.dmChannels.set(user, ch);
    }
    for (const part of chunks(content)) await this.post(ch, part);
  }

  // ---- commands ----

  private reply(i: any, content: string, ephemeral = true) {
    return this.rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content: content.slice(0, 2000), flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: noPings } });
  }

  private async interaction(i: any) {
    const name = String(i.data?.name ?? '');
    const opt = (n: string) => (i.data?.options ?? []).find((o: any) => o.name === n)?.value;
    const user = i.member?.user ?? i.user ?? {};
    const userId = String(user.id ?? '');
    const c = this.worlds().find((x) => x.guildId === String(i.guild_id ?? ''));
    if (!c) return this.reply(i, 'This Discord server is not linked to an Alexandria world.');
    const w = c.worldId;

    if (name === 'link') {
      if (!this.m.linkAllowed(userId)) return this.reply(i, 'Too many wrong codes. Wait ten minutes, then get a new code in the app.');
      const got = useCode(this.d.db, w, String(opt('code') ?? ''), userId, String(user.global_name || user.username || ''));
      if (!got) { this.m.linkFailed(userId); return this.reply(i, 'That code did not work. Codes last 10 minutes and work once: get a new one in the app under Settings & account → Discord.'); }
      const who = whoIs(this.d.db, w, userId);
      return this.reply(i, `Linked: on this server you are **${md(who?.name ?? 'your character')}** in ${md(worldName(this.d, w))}. Try /roll d20 or /ask.`);
    }
    if (name === 'unlink') {
      const n = run(this.d.db, 'DELETE FROM discord_links WHERE world_id = ? AND discord_user = ?', w, userId);
      return this.reply(i, n ? 'Unlinked. This Discord account no longer acts for your character.' : 'This Discord account was not linked.');
    }

    const who = whoIs(this.d.db, w, userId);
    if (!who) return this.reply(i, 'Link your character first: in the app open Settings & account → Discord, get a code, then type /link with it here.');
    if (who.role === 'guest') return this.reply(i, 'Guests can only read in this world.');

    if (name === 'roll') {
      const dice = String(opt('dice') ?? '').trim();
      const body = `/roll ${dice}`;
      let roll: Roll;
      let note = '';
      try {
        const s = currentSession(this.d.db, w);
        if (s) {
          const row = addMessage(this.d.db, w, { sessionId: s.id, channel: 'table', authorId: who.accountId, role: who.role, body });
          // Already answered in this channel: the roll mirror skips it there.
          this.m.fromDiscord.set(row.id, String(i.channel_id ?? ''));
          fanoutChat(this.d, w, 'table', 'new', row);
          roll = JSON.parse(String(row.roll));
        } else {
          roll = parseRoll(body);
          note = '\n-# No session is running in Alexandria, so this roll is not in the table chat.';
        }
      } catch (e: any) {
        return this.reply(i, e?.status === 400 ? `${e.message}. Try /roll 2d6+3 or /roll d20.` : 'That roll did not work.');
      }
      return this.reply(i, rollText(who.name, roll) + note, false);
    }

    if (name === 'recap') {
      const e = one<any>(this.d.db, 'SELECT number, title, summary FROM sessionlog_entries WHERE world_id = ? AND unpublished_at IS NULL ORDER BY number DESC LIMIT 1', w);
      if (!e) return this.reply(i, 'The GM has not published a session recap yet.');
      const parts = recapText(e, worldName(this.d, w));
      const share = opt('share') === true;
      await this.reply(i, parts[0], !share);
      for (const p of parts.slice(1)) await this.followUp(i, p, !share);
      return;
    }

    if (name === 'ask') {
      if (who.role !== 'player') return this.reply(i, 'The Squire is for players.');
      const s = settingsOf(this.d, w);
      if (featureSetting<boolean>(s, 'quickHelper') === false) return this.reply(i, 'The GM has turned the Squire off.');
      if (!c.helper) return this.reply(i, 'The GM has turned the Squire off in Discord. It is still in the app.');
      const raw = String(opt('task') ?? 'ask');
      const task: QuickTask = (QUICK_TASKS as readonly string[]).includes(raw) ? (raw as QuickTask) : 'ask';
      const question = String(opt('question') ?? '').slice(0, 400);
      if (task === 'ask' && !question.trim()) return this.reply(i, 'Ask a question, or pick a task (my turn, rules, sum up my character...).');
      const share = opt('share') === true;
      // The model may take longer than Discord's 3 seconds: say "thinking", then edit the answer in.
      await this.rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 5, data: { flags: share ? 0 : EPHEMERAL } });
      let text: string;
      try {
        const a = await askQuick(this.d, { worldId: w, worldName: worldName(this.d, w), accountId: who.accountId, settings: s, task, question });
        text = helperText(this.d, w, question, a);
      } catch (e: any) {
        text = e?.name === 'ModelPreempted' || /preempt|GM first|for the GM/i.test(String(e?.message))
          ? 'The GM needs the model right now (the GM goes first). Ask again in a moment.'
          : e?.status === 429 ? `${e.message}. Ask again in a moment.` : 'Your Squire is not answering right now. Try the app.';
      }
      const parts = chunks(text);
      await this.rest('PATCH', `/webhooks/${i.application_id ?? this.status.applicationId}/${i.token}/messages/@original`, { content: parts[0], allowed_mentions: noPings });
      for (const p of parts.slice(1)) await this.followUp(i, p, !share);
      return;
    }
    return this.reply(i, 'Unknown command.');
  }

  private followUp(i: any, content: string, ephemeral: boolean) {
    return this.rest('POST', `/webhooks/${i.application_id ?? this.status.applicationId}/${i.token}`, { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: noPings });
  }
}

function helperText(d: Deps, worldId: string, question: string, a: { answer: string; handoff: { to: string; reason: string } | null }): string {
  const lines: string[] = [];
  if (question.trim()) lines.push(`> ${md(question.trim().slice(0, 300))}`);
  if (a.answer) lines.push(a.answer);
  if (a.handoff) {
    const where = a.handoff.to === 'broker' ? 'broker' : 'assistant';
    const url = appUrl(d, `/w/${slugOf(d, worldId)}/${where}`);
    lines.push(`-# ${a.handoff.reason}${url ? ` ${url}` : ' Open it in the app.'}`);
  }
  return lines.join('\n') || 'No answer this time.';
}

/** One per app: the bots for every world, and what Alexandria tells them. */
export class Manager {
  bots = new Map<string, Bot>();
  /** Chat message id -> the Discord channel its /roll was already answered in. */
  fromDiscord = new Map<string, string>();
  /** Table-chat message id -> [channel, Discord message id], to take a hidden or deleted roll back down. */
  private mirrored = new Map<string, [string, string]>();
  private seen = new Set<string>();
  private failures = new Map<string, number[]>();
  private untap: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private d: Deps;
  readonly fetch: typeof globalThis.fetch;

  constructor(d: Deps, f?: typeof globalThis.fetch) {
    this.d = d;
    this.fetch = f ?? d.fetch;
  }

  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.untap = this.d.hub.tap((w, type, data) => this.onEvent(w, type, data));
    this.sync();
    this.timer = setInterval(() => this.sync(), 60_000);
    this.timer.unref();
  }

  stop() {
    this.started = false;
    this.untap?.();
    if (this.timer) clearInterval(this.timer);
    for (const b of this.bots.values()) b.stop();
    this.bots.clear();
  }

  /** Start bots for new tokens, stop those no world uses, register commands where servers changed. */
  sync() {
    if (!this.started) return; // tests and noScheduler: no bots until start()
    const want = new Set(liveConfigs(this.d.db).map((c) => c.token!));
    for (const [t, b] of this.bots) if (!want.has(t)) { b.stop(); this.bots.delete(t); }
    for (const t of want) {
      const b = this.bots.get(t);
      if (b) { void b.registerAll(); continue; }
      const nb = new Bot(this.d, this, t);
      this.bots.set(t, nb);
      void nb.start();
    }
  }

  botFor(worldId: string): Bot | null {
    const c = configOf(this.d.db, worldId);
    return c?.enabled && c.token && c.guildId ? this.bots.get(c.token) ?? null : null;
  }

  linkAllowed(user: string) {
    const cut = Date.now() - 10 * 60_000;
    const f = (this.failures.get(user) ?? []).filter((t) => t > cut);
    this.failures.set(user, f);
    return f.length < 5;
  }
  linkFailed(user: string) { this.failures.set(user, [...(this.failures.get(user) ?? []), Date.now()]); }

  /** A ref seen once in this process (taps fire once per viewer for chat). */
  private once(key: string) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  private onEvent(worldId: string, type: string, data: any) {
    if (type !== 'sessionlog' && type !== 'chat' && type !== 'broker' && type !== 'broker-offer') return;
    const c = configOf(this.d.db, worldId);
    if (!c?.enabled || !c.token || !c.guildId) return;
    const bot = this.bots.get(c.token);
    if (!bot) return;
    const fail = (what: string) => (e: any) => { bot.status.error = `${what}: ${e?.message ?? e}`; };
    if (type === 'sessionlog') {
      if (data?.action !== 'published' || !data.entry?.id || !c.postRecaps || !c.recapChannel) return;
      if (!this.once(`recap:${data.entry.id}`)) return;
      void this.postRecap(worldId, String(data.entry.id)).catch(fail('Posting a recap'));
    } else if (type === 'chat') {
      const msg = data?.message;
      if (data?.channel !== 'table' || !msg?.id || msg.kind !== 'roll') return;
      if (data.type === 'new') {
        const via = this.fromDiscord.get(msg.id);
        this.fromDiscord.delete(msg.id);
        if (!c.postRolls || !c.rollChannel || msg.hidden || !msg.roll || !this.once(`roll:${msg.id}`)) return;
        if (via === c.rollChannel) return; // the /roll was answered in this channel already
        const name = String(one<any>(this.d.db, `SELECT COALESCE(NULLIF(m.character_name, ''), a.display_name) AS n FROM accounts a LEFT JOIN members m ON m.account_id = a.id AND m.world_id = ? WHERE a.id = ?`, worldId, msg.authorId)?.n ?? 'Someone');
        const ch = c.rollChannel;
        void bot.post(ch, rollText(name, msg.roll)).then((did) => {
          if (!did) return;
          this.mirrored.set(msg.id, [ch, did]);
          if (this.mirrored.size > 500) this.mirrored.delete(this.mirrored.keys().next().value as string);
        }).catch(fail('Posting a roll'));
      } else if ((data.type === 'hide' && msg.hidden) || data.type === 'delete') {
        const m = this.mirrored.get(msg.id);
        if (!m) return;
        this.mirrored.delete(msg.id);
        void bot.rest('DELETE', `/channels/${m[0]}/messages/${m[1]}`).catch(() => {});
      }
    } else if (type === 'broker') {
      if (!c.brokerDms || (data?.status !== 'answered' && data?.status !== 'offered') || !data.id) return;
      void this.brokerNote(bot, c, String(data.id), data.status).catch(fail('A broker message'));
    } else if (type === 'broker-offer') {
      if (!c.brokerDms || data?.status !== 'open' || !data.id) return;
      void this.offerNote(bot, worldId, String(data.id)).catch(fail('A broker offer'));
    }
  }

  async postRecap(worldId: string, entryId: string, force = false) {
    const c = configOf(this.d.db, worldId);
    const bot = this.botFor(worldId);
    if (!c?.recapChannel || !bot) throw new Error('Set a recap channel first');
    const e = one<any>(this.d.db, 'SELECT id, number, title, summary FROM sessionlog_entries WHERE id = ? AND world_id = ? AND unpublished_at IS NULL', entryId, worldId);
    if (!e) throw new Error('That recap is not published');
    if (!firstPost(this.d.db, worldId, `recap:${e.id}`) && !force) return;
    for (const part of recapText(e, worldName(this.d, worldId))) await bot.post(c.recapChannel, part);
  }

  private async brokerNote(bot: Bot, c: Config, rid: string, status: string) {
    const q = one<any>(this.d.db, 'SELECT * FROM broker_requests WHERE id = ? AND world_id = ?', rid, c.worldId);
    if (!q || q.status !== status) return;
    const user = discordUserOf(this.d.db, c.worldId, q.account_id);
    if (!user || roleOf(this.d.db, c.worldId, q.account_id) !== 'player') return;
    if (!firstPost(this.d.db, c.worldId, `broker:${rid}:${status}`)) return;
    const url = appUrl(this.d, `/w/${slugOf(this.d, c.worldId)}/broker`);
    const asked = `> ${md(String(q.question).slice(0, 300))}`;
    const text = status === 'answered'
      ? `🕯️ **The broker has an answer** for you in ${md(worldName(this.d, c.worldId))}.\n${asked}\n\n${c.brokerText && q.answer ? q.answer : `Read it in the app${url ? `: ${url}` : '.'}`}`
      : `🕯️ **The broker names a price** for your question in ${md(worldName(this.d, c.worldId))}: ${money(Number(q.cost_cp || 0))}.\n${asked}\nPay or decline in the app${url ? `: ${url}` : '.'}`;
    await bot.gm(user, text);
  }

  private async offerNote(bot: Bot, worldId: string, oid: string) {
    const o = one<any>(this.d.db, 'SELECT * FROM broker_offers WHERE id = ? AND world_id = ?', oid, worldId);
    if (!o || o.status !== 'open') return;
    if (!firstPost(this.d.db, worldId, `offer:${oid}`)) return;
    const targets: string[] = parseJson(o.targets, []);
    const players = all<any>(this.d.db, `SELECT account_id FROM members WHERE world_id = ? AND role = 'player'`, worldId).map((m) => m.account_id as string);
    const to = targets.includes('party') ? players : targets.filter((t) => players.includes(t));
    const url = appUrl(this.d, `/w/${slugOf(this.d, worldId)}/broker`);
    // The teaser only: the information itself stays in the app until someone pays.
    const text = `🕯️ **The broker has an offer**: ${md(o.title)} for ${money(Number(o.price_cp))}.${o.teaser ? `\n${o.teaser}` : ''}\nSee it in the app${url ? `: ${url}` : '.'}`;
    for (const aid of to) {
      const user = discordUserOf(this.d.db, worldId, aid);
      if (user) await bot.gm(user, text).catch((e) => { bot.status.error = `A broker offer: ${e?.message ?? e}`; });
    }
  }
}

const managers = new WeakMap<Deps, Manager>();
/** The app's manager. Made on first use; start() runs it (index.ts start, or a test). */
export function managerOf(d: Deps): Manager {
  let m = managers.get(d);
  if (!m) { m = new Manager(d); managers.set(d, m); }
  return m;
}
