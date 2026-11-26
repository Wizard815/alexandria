// A Discord bot for a world (docs/DISCORD.md). The DM sets it up on DM →
// Setup → Discord; players link their Discord account with a one-time code
// from Settings & account → Discord, then use /roll, /ask and /recap.
//
//   GET    /discord             DM: settings (the token is never sent back), bot status, invite link, linked players
//   PUT    /discord             DM: change settings
//   GET    /discord/channels    DM: the server's text channels, to pick from
//   POST   /discord/test        DM: a test post in the recap and roll channels
//   POST   /discord/recap/:id   DM: post a published recap (again)
//   DELETE /discord/links/:aid  DM: unlink a player
//   GET    /discord/me          is a bot set up, and am I linked
//   POST   /discord/me/code     a one-time code to type as /link in Discord
//   DELETE /discord/me          unlink myself
import { Router } from 'express';
import type { Deps } from '../../app.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { ctx, me } from '../../routes/_shared.ts';
import type { Feature } from '../types.ts';
import { INVITE_PERMISSIONS, managerOf } from './bot.ts';
import { botToken, CODE_MINUTES, configOf, linksOf, newCode, saveConfig, SCHEMA, snowflake, discordUserOf } from './store.ts';

const audit = (d: Deps, worldId: string, accountId: string, action: string, detail = '') => { run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now()); };
const bool = (v: unknown, field: string) => { if (typeof v !== 'boolean') throw new HttpError(400, `${field} must be true or false`); return v; };

const feature: Feature = {
  id: 'discord',
  schema: SCHEMA,
  worldMount: 'discord',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    const W = (res: any) => ctx(res).world.id as string;

    const view = (worldId: string) => {
      const c = configOf(d.db, worldId);
      const bot = managerOf(d).botFor(worldId);
      const app = bot?.status.applicationId ?? null;
      return {
        enabled: c?.enabled ?? true,
        tokenSet: !!c?.token,
        tokenEnd: c?.token ? c.token.slice(-4) : null,
        guildId: c?.guildId ?? null,
        recapChannel: c?.recapChannel ?? null,
        rollChannel: c?.rollChannel ?? null,
        postRecaps: c?.postRecaps ?? true,
        postRolls: c?.postRolls ?? true,
        brokerDms: c?.brokerDms ?? true,
        brokerText: c?.brokerText ?? true,
        helper: c?.helper ?? true,
        status: bot ? { ...bot.status, inServer: !!c?.guildId && bot.status.guilds.some((g) => g.id === c.guildId) } : null,
        inviteUrl: app ? `https://discord.com/oauth2/authorize?client_id=${app}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}${c?.guildId ? `&guild_id=${c.guildId}` : ''}` : null,
        links: linksOf(d.db, worldId),
      };
    };

    r.get('/', requireDM, (_req, res) => res.json(view(W(res))));

    r.put('/', requireDM, (req, res) => {
      const w = W(res);
      const b = req.body ?? {};
      const patch: Record<string, unknown> = {};
      if (b.token !== undefined && b.token !== '') patch.token = b.token === null ? null : botToken(b.token);
      if (b.guildId !== undefined) patch.guildId = snowflake(b.guildId, 'Server id');
      if (b.recapChannel !== undefined) patch.recapChannel = snowflake(b.recapChannel, 'Recap channel');
      if (b.rollChannel !== undefined) patch.rollChannel = snowflake(b.rollChannel, 'Roll channel');
      for (const k of ['enabled', 'postRecaps', 'postRolls', 'brokerDms', 'brokerText', 'helper'] as const) if (b[k] !== undefined) patch[k] = bool(b[k], k);
      saveConfig(d.db, w, patch);
      audit(d, w, me(res), 'discord.settings', Object.keys(patch).map((k) => (k === 'token' ? 'token' : `${k}=${patch[k]}`)).join(' '));
      managerOf(d).sync();
      res.json(view(w));
    });

    const botOr409 = (res: any) => {
      const bot = managerOf(d).botFor(W(res));
      if (!bot) throw new HttpError(409, 'Set the bot token and the server first');
      return bot;
    };

    r.get('/channels', requireDM, async (_req, res) => {
      const c = configOf(d.db, W(res))!;
      const bot = botOr409(res);
      try {
        const list = await bot.rest('GET', `/guilds/${c.guildId}/channels`);
        // Text and announcement channels, in the server's order.
        res.json((Array.isArray(list) ? list : []).filter((x: any) => x.type === 0 || x.type === 5).sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)).map((x: any) => ({ id: String(x.id), name: String(x.name) })));
      } catch (e: any) { throw new HttpError(502, e?.message ?? 'Discord did not answer'); }
    });

    r.post('/test', requireDM, async (_req, res) => {
      const w = W(res);
      const c = configOf(d.db, w)!;
      const bot = botOr409(res);
      const out: { channel: string; ok: boolean; error?: string }[] = [];
      for (const [what, ch] of [['recaps', c.recapChannel], ['rolls', c.rollChannel]] as const) {
        if (!ch || out.some((o) => o.channel === ch)) continue;
        try { await bot.post(ch, `Alexandria is connected. Session ${what} will appear here.`); out.push({ channel: ch, ok: true }); }
        catch (e: any) { out.push({ channel: ch, ok: false, error: e?.message ?? String(e) }); }
      }
      if (!out.length) throw new HttpError(400, 'Pick a recap or a roll channel first');
      res.json({ results: out });
    });

    r.post('/recap/:id', requireDM, async (req, res) => {
      botOr409(res);
      try { await managerOf(d).postRecap(W(res), String(req.params.id), true); }
      catch (e: any) { throw new HttpError(e?.status ?? 409, e?.message ?? 'Could not post it'); }
      res.json({ ok: true });
    });

    r.delete('/links/:aid', requireDM, (req, res) => {
      run(d.db, 'DELETE FROM discord_links WHERE world_id = ? AND account_id = ?', W(res), String(req.params.aid));
      audit(d, W(res), me(res), 'discord.unlink', String(req.params.aid));
      res.json({ ok: true });
    });

    // ---- a player's own link ----

    r.get('/me', (_req, res) => {
      const w = W(res);
      const c = configOf(d.db, w);
      const bot = managerOf(d).botFor(w);
      const guild = bot?.status.guilds.find((g) => g.id === c?.guildId);
      const link = linksOf(d.db, w).find((l) => l.accountId === me(res));
      res.json({
        available: !!(c?.enabled && c.token && c.guildId),
        serverName: guild?.name ?? null,
        botName: bot?.status.botName ?? null,
        helper: !!c?.helper,
        linked: link ? { discordName: link.discordName, linkedAt: link.linkedAt } : null,
      });
    });

    r.post('/me/code', requirePlayerOrDM, (_req, res) => {
      const w = W(res);
      const c = configOf(d.db, w);
      if (!c?.enabled || !c.token || !c.guildId) throw new HttpError(409, 'The DM has not set up a Discord bot for this world');
      const k = newCode(d.db, w, me(res));
      res.json({ ...k, minutes: CODE_MINUTES, command: `/link code:${k.code}` });
    });

    r.delete('/me', requirePlayerOrDM, (_req, res) => {
      const had = !!discordUserOf(d.db, W(res), me(res));
      run(d.db, 'DELETE FROM discord_links WHERE world_id = ? AND account_id = ?', W(res), me(res));
      res.json({ ok: true, wasLinked: had });
    });
    return r;
  },
  start: (d) => {
    const m = managerOf(d);
    m.start();
    return () => m.stop();
  },
};
export default feature;
