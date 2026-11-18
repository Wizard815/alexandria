// Helpers for a player's assistant (the broker's voice), built only from what
// that player may see: the players' transcript (lines the whole table heard,
// never a DM aside) and the published session log. No model is needed.
//
//   GET /helper/journal-draft   a draft of this player's journal for a session, from the table transcript
//   GET /helper/recap           what happened last session: the published log entries, newest first
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { all } from '../../core/db.ts';
import { requirePlayerOrDM } from '../../core/auth.ts';
import { HttpError } from '../../core/util.ts';
import { ctx, isDM, me } from '../../routes/_shared.ts';
import { listSessions, sessionLines } from '../audio/api.ts';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trim()}…` : s);

const feature: Feature = {
  id: 'playerhelp',
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
    return r;
  },
  mcpTools: [
    { name: 'my_journal_draft', playerOnly: true, description: "Draft this player's journal for a session from the table transcript (what they said, what the table heard). Show it to them; to keep it, save it with my_memory_log.", props: { session: { type: 'string', description: 'Audio session id (default: the latest)' } }, call: (a) => ({ method: 'GET', path: `/helper/journal-draft${a.session ? `?session=${encodeURIComponent(String(a.session))}` : ''}` }) },
    { name: 'my_recap', playerOnly: true, description: 'What happened in the last sessions, from the published session log (party-level only). Use it for "what happened last time" and "catch me up".', props: {}, call: () => ({ method: 'GET', path: '/helper/recap' }) },
  ],
};
export default feature;
