// Active mode (docs/MINERVA.md, docs/AGENTS.md). Everything here is the DM's:
// players never see these routes, the log, the cards or the word Minerva.
//
//   GET  /active                     mode now, settings, presets, waiting cards
//   PUT  /active                     { mode, sessionOnly, wakeWord, cats, listen, askTtlMin, scan }
//   POST /active/command             { text }  /takeover, /takeover-<n>, /takeover-save <n> [name], /auto <cat> on|off|ask
//   GET  /active/log?status=         the command log (both modes), newest first
//   POST /active/log/:id/approve|dismiss|reject|undo|wrong
//   GET/DELETE /active/rules         "don't do this again" rules
//   POST /active/task                { prompt, mode, tools } one task for the assistant (macro Minerva step)
//   GET  /active/thoughts            Minerva's thoughts: the live feed of what she heard, did, asked and let go
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { requireDM } from '../../core/auth.ts';
import { HttpError, int, str } from '../../core/util.ts';
import { ctx, me, settings } from '../../routes/_shared.ts';
import { featureSetting } from '../../core/policy.ts';
import { hasJob } from '../../core/ai.ts';
import { listSessions } from '../audio/api.ts';
import { dmOnly } from '../../core/events.ts';
import { CATEGORIES } from './cues.ts';
import { SCHEMA, cleanCats, dropRule, effectiveMode, expireCards, getState, listLog, listRules, saveState, sessionOverride, setSessionMode, type Cats } from './store.ts';
import { approveCard, dismissCard, flushActive, markWrong, statsOf, undoEntry } from './engine.ts';
import { parseCommand, runCommand } from './commands.ts';
import { setPort, dmAuth } from './exec.ts';
import { runTask } from './task.ts';
import { lastHeard, recentThoughts } from './thoughts.ts';

function routes(d: import('../../app.ts').Deps) {
  const r = Router({ mergeParams: true });
  const W = (res: any): string => ctx(res).world.id;
  r.use((req, _res, next) => { setPort(d, req.socket.localPort); next(); });
  r.use(requireDM);

  const view = (res: any) => {
    const w = W(res);
    const s = getState(d, w);
    const sess = listSessions(d.db, w)[0];
    const recording = !!sess?.active;
    const override = recording ? sessionOverride(d, w, sess.id) : null;
    expireCards(d, w);
    return {
      mode: s.mode, effective: effectiveMode(d, w, recording ? sess.id : null), recording, sessionId: recording ? sess.id : null, sessionOverride: override,
      wakeWord: s.wakeWord, cats: s.cats, presets: s.presets, takeoverOn: !!s.prev, listen: s.listen, askTtlMin: s.askTtlMin, scan: s.scan,
      categories: CATEGORIES, model: { audit: hasJob(d, 'audit'), chat: hasJob(d, 'chat') },
      cards: listLog(d, w, { status: 'pending', limit: 50 }),
    };
  };

  r.get('/', (_req, res) => res.json(view(res)));
  r.put('/', (req, res) => {
    const w = W(res);
    const b = req.body ?? {};
    const patch: any = {};
    if (b.mode !== undefined) {
      if (b.mode !== 'active' && b.mode !== 'assistant') throw new HttpError(400, 'mode must be active or assistant');
      const sess = listSessions(d.db, w)[0];
      if (b.sessionOnly === true) {
        if (!sess?.active) throw new HttpError(409, 'No recording is running, so there is no session to switch');
        setSessionMode(d, w, sess.id, b.mode);
      } else { patch.mode = b.mode; if (sess?.active) setSessionMode(d, w, sess.id, null); }
    }
    if (b.wakeWord !== undefined) { const ww = str(b.wakeWord, 'wakeWord', { max: 30 }).trim(); if (!/^[\p{L}][\p{L}\p{N} '-]{1,29}$/u.test(ww)) throw new HttpError(400, 'The wake word needs 2 to 30 letters'); patch.wakeWord = ww; }
    if (b.cats !== undefined) { if (!b.cats || typeof b.cats !== 'object') throw new HttpError(400, 'cats must be an object'); const cur = getState(d, w).cats; patch.cats = cleanCats(b.cats, cur) as Cats; patch.prev = null; }
    if (b.listen !== undefined) { if (!b.listen || typeof b.listen !== 'object') throw new HttpError(400, 'listen must be an object'); patch.listen = { dm: b.listen.dm !== false, players: b.listen.players !== false, room: b.listen.room === true }; }
    if (b.askTtlMin !== undefined) patch.askTtlMin = int(b.askTtlMin, 'askTtlMin', { min: 1, max: 240 });
    if (b.scan !== undefined) patch.scan = b.scan === true;
    saveState(d, w, patch);
    d.hub.emit(w, 'active', { kind: 'mode' }, dmOnly);
    res.json(view(res));
  });
  r.post('/command', (req, res) => {
    const text = str(req.body?.text, 'text', { max: 200 }).trim();
    const c = parseCommand(text);
    if (!c) throw new HttpError(400, 'Not a command I know. Try /takeover, /takeover-1, /takeover-save 4 Name, /auto music on');
    const message = runCommand(d, W(res), c);
    d.hub.emit(W(res), 'active', { kind: 'mode' }, dmOnly);
    res.json({ message, ...view(res) });
  });

  r.get('/log', (req, res) => {
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    res.json({ log: listLog(d, W(res), { status, limit: int(req.query.limit, 'limit', { min: 1, max: 500, optional: true }) ?? 100 }), stats: { ...statsOf(d), rulesMs: undefined, modelMs: undefined } });
  });
  const wrap = (fn: (id: string) => Promise<unknown> | unknown) => async (req: any, res: any) => {
    try { res.json(await fn(String(req.params.id))); } catch (e: any) { if (e?.status) throw new HttpError(e.status, e.message); throw e; }
  };
  r.post('/log/:id/approve', (req, res, next) => wrap((id) => approveCard(d, W(res), id))(req, res).catch(next));
  r.post('/log/:id/dismiss', (req, res, next) => wrap((id) => dismissCard(d, W(res), id))(req, res).catch(next));
  r.post('/log/:id/reject', (req, res, next) => wrap((id) => dismissCard(d, W(res), id, true))(req, res).catch(next));
  r.post('/log/:id/undo', (req, res, next) => wrap((id) => undoEntry(d, W(res), id))(req, res).catch(next));
  r.post('/log/:id/wrong', (req, res, next) => wrap((id) => markWrong(d, W(res), id))(req, res).catch(next));
  r.get('/rules', (_req, res) => res.json({ rules: listRules(d, W(res)) }));
  r.delete('/rules', (req, res) => { dropRule(d, W(res), str(req.body?.key ?? req.query.key, 'key', { max: 200 })); res.json({ ok: true }); });
  r.get('/thoughts', (req, res) => {
    const w = W(res);
    const sess = listSessions(d.db, w)[0];
    const auto = featureSetting<boolean>(settings(res), 'agentAuto') === true;
    res.json({ thoughts: recentThoughts(d, w, int(req.query.limit, 'limit', { min: 1, max: 500, optional: true }) ?? 120), heard: lastHeard(d, w), recording: !!sess?.active, mode: effectiveMode(d, w, sess?.active ? sess.id : null), auto });
  });
  r.post('/flush', async (_req, res) => { await flushActive(d, W(res)); res.json({ ok: true }); });

  r.post('/task', async (req, res) => {
    if (!hasJob(d, 'chat')) throw new HttpError(503, 'No chat model is set (Admin → Models), so Minerva cannot do that.');
    const prompt = str(req.body?.prompt, 'prompt', { max: 2000 }).trim();
    if (!prompt) throw new HttpError(400, 'prompt is required');
    const mode = req.body?.mode === 'propose' ? 'propose' : 'do';
    const tools = Array.isArray(req.body?.tools) ? req.body.tools.map(String).slice(0, 60) : undefined;
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    void dmAuth;
    const out = await runTask(d, { worldId: W(res), accountId: me(res), token: auth, port: req.socket.localPort ?? 0 }, { prompt, mode, allow: tools, title: str(req.body?.title, 'title', { max: 80, optional: true }) || undefined });
    res.json(out);
  });
  return r;
}

const feature: Feature = { id: 'active', schema: SCHEMA, worldMount: 'active', worldRoutes: routes };
export default feature;
