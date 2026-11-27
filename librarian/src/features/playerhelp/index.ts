// Helpers for a player's assistant (the broker's voice), built only from what
// that player may see: the players' transcript (lines the whole table heard,
// never a DM aside) and the published session log. No model is needed.
//
//   GET /helper/journal-draft   a draft of this player's journal for a session, from the table transcript
//   GET /helper/recap           what happened last session: the published log entries, newest first
//
// Squire, the quick helper (quick.ts), is the one part that uses a model: a small second one, the 'helper' job.
//   GET  /helper/quick          is it on, which model answers, and this player's Squire (name, trait)
//   PUT  /helper/squire         { name?, trait? } this player names their Squire and gives it a personality trait
//   GET  /helper/quick/brief    what the small model is given for a task (?task=&q=; the DM: &account=)
//   POST /helper/quick          { task: ask|rules|turn|sheet|suggest, question? } -> an answer or a handoff
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { all } from '../../core/db.ts';
import { requirePlayerOrDM } from '../../core/auth.ts';
import { HttpError } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from '../../routes/_shared.ts';
import { listSessions, sessionLines } from '../audio/api.ts';
import { featureSetting } from '../../core/policy.ts';
import { QUICK_TASKS, SQUIRE_NAME_MAX, SQUIRE_SCHEMA, SQUIRE_TRAIT_MAX, askQuick, getSquire, quickBrief, quickStatus, setSquire, type QuickTask } from './quick.ts';

const taskOf = (v: unknown): QuickTask => {
  const t = typeof v === 'string' && v ? v : 'ask';
  if (!(QUICK_TASKS as readonly string[]).includes(t)) throw new HttpError(400, `task must be one of ${QUICK_TASKS.join(', ')}`);
  return t as QuickTask;
};
const questionOf = (v: unknown): string => {
  const q = typeof v === 'string' ? v.trim() : '';
  if (q.length > 2000) throw new HttpError(400, 'question must be at most 2000 characters');
  return q;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

const feature: Feature = {
  id: 'playerhelp',
  schema: SQUIRE_SCHEMA,
  settings: {
    // Squire, the players' quick helper (a small second model). Off: players only have the table helper and the broker.
    quickHelper: { type: 'boolean', default: true },
  },
  worldMount: 'helper',
  worldRoutes: (d) => {
    const r = Router({ mergeParams: true });
    r.use(requirePlayerOrDM);

    r.get('/journal-draft', (req, res) => {
      if (isDM(res)) throw new HttpError(403, 'This helper is for players');
      const w = ctx(res).world.id;
      const sessions = listSessions(d.db, w);
      const s = (typeof req.query.session === 'string' && sessions.find((x) => x.id === req.query.session)) || sessions[0];
      if (!s) return res.json({ session: null, markdown: '', note: 'No session has been recorded yet.' });
      // Only lines the whole table heard.
      const lines = sessionLines(d.db, w, s.id, { includeDm: false });
      const mine = lines.filter((l) => l.speakerId === me(res)).map((l) => clip(l.text.replace(/\s+/g, ' ').trim(), 200)).filter((t) => t.split(' ').length >= 4);
      const others = lines.filter((l) => l.speakerId !== me(res)).map((l) => ({ who: l.speaker, text: clip(l.text.replace(/\s+/g, ' ').trim(), 200) })).filter((x) => x.text.split(' ').length >= 8).sort((a, b) => b.text.length - a.text.length).slice(0, 8);
      const md = [
        `# ${s.name}: my journal (draft)`,
        '', '## What I said and did', ...(mine.length ? mine.slice(0, 15).map((t) => `- ${t}`) : ['- (nothing of mine was recorded)']),
        '', '## What the table heard', ...(others.length ? others.map((x) => `- ${x.who}: ${x.text}`) : ['- (nothing recorded)']),
        '', '_Drafted from the table transcript. Edit it, then save it to your journal._',
      ].join('\n');
      res.json({ session: { id: s.id, name: s.name }, markdown: md, lines: lines.length });
    });

    r.get('/recap', (_req, res) => {
      const w = ctx(res).world.id;
      const rows = all<any>(d.db, 'SELECT number, title, summary, session_at FROM sessionlog_entries WHERE world_id = ? AND unpublished_at IS NULL ORDER BY number DESC LIMIT 3', w);
      res.json({ entries: rows.map((x) => ({ number: x.number, title: x.title, summary: x.summary, at: x.session_at })) });
    });

    const quickOn = (res: any) => featureSetting<boolean>(settings(res), 'quickHelper') !== false;
    r.get('/quick', (_req, res) => {
      const st = quickStatus(d);
      res.json({ on: quickOn(res), ...st, squire: isDM(res) ? null : getSquire(d.db, ctx(res).world.id, me(res)) });
    });

    r.put('/squire', (req, res) => {
      if (isDM(res)) throw new HttpError(403, 'Each player names their own Squire');
      const b = req.body ?? {};
      for (const [k, max] of [['name', SQUIRE_NAME_MAX], ['trait', SQUIRE_TRAIT_MAX]] as const) {
        if (b[k] !== undefined && typeof b[k] !== 'string') throw new HttpError(400, `${k} must be text`);
        if (typeof b[k] === 'string' && b[k].trim().length > max) throw new HttpError(400, `${k} must be at most ${max} characters`);
      }
      res.json(setSquire(d.db, ctx(res).world.id, me(res), { name: b.name, trait: b.trait }));
    });

    r.get('/quick/brief', async (req, res) => {
      const c = ctx(res);
      let aid = me(res);
      if (isDM(res)) {
        aid = typeof req.query.account === 'string' ? req.query.account : '';
        if (!memberIds(d.db, c.world.id, ['player']).includes(aid)) throw new HttpError(400, 'Pick a player (account)');
      }
      const task = taskOf(req.query.task);
      const b = await quickBrief(d, c.world.id, aid, settings(res), task, questionOf(req.query.q));
      res.json({ task, chars: b.chars, sections: b.sections, lore: b.lore });
    });

    r.post('/quick', async (req, res) => {
      if (isDM(res)) throw new HttpError(403, 'The Squire is for players');
      if (!quickOn(res)) throw new HttpError(403, 'The DM has turned the Squire off');
      const c = ctx(res);
      try {
        res.json(await askQuick(d, { worldId: c.world.id, worldName: c.world.name, accountId: me(res), settings: settings(res), task: taskOf(req.body?.task), question: questionOf(req.body?.question) }));
      } catch (e: any) {
        if (e?.status === 429) throw new HttpError(429, e.message);
        throw e;
      }
    });
    return r;
  },
  mcpTools: [
    { name: 'my_journal_draft', playerOnly: true, description: "Draft this player's journal for a session from the table transcript (what they said, what the table heard). Show it to them; to keep it, save it with my_memory_log.", props: { session: { type: 'string', description: 'Audio session id (default: the latest)' } }, call: (a) => ({ method: 'GET', path: `/helper/journal-draft${a.session ? `?session=${encodeURIComponent(String(a.session))}` : ''}` }) },
    { name: 'my_recap', playerOnly: true, description: 'What happened in the last sessions, from the published session log (party-level only). Use it for "what happened last time" and "catch me up".', props: {}, call: () => ({ method: 'GET', path: '/helper/recap' }) },
  ],
};
export default feature;
