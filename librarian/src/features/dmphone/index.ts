// DM phone assistant (PLAN §15): one small summary for the phone's "Now" tab
// and its tab badges, so the phone makes one request instead of eight.
// Everything else the phone does uses the existing endpoints.
//
// GET /api/worlds/:world/dmphone/summary?next=2   (DM only)
import { Router } from 'express';
import type { Feature } from '../types.ts';
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { requireDM } from '../../core/auth.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { ModelUnavailable } from '../../core/ai.ts';
import { ctx, settings } from '../../routes/_shared.ts';
import { getClock } from '../clock/api.ts';
import { sessionLines } from '../audio/api.ts';
import { warmSnapshot } from '../models/lifecycle.ts';

const count = (d: Deps, sql: string, ...args: unknown[]): number => {
  try { return one<{ n: number }>(d.db, sql, ...args)?.n ?? 0; } catch { return 0; }
};

/** Turn order from the current combatant: the current one, then the next `n`. */
export function turnWindow(list: any[], turn: number, n: number) {
  if (!list.length) return { current: null, next: [] as any[] };
  const i = turn % list.length;
  const next: any[] = [];
  for (let k = 1; k <= Math.min(n, list.length - 1); k++) next.push(list[(i + k) % list.length]);
  return { current: list[i], next };
}

const feature: Feature = {
  id: 'dmphone',
  worldMount: 'dmphone',
  worldRoutes: (d: Deps) => {
    const r = Router({ mergeParams: true });
    r.get('/summary', requireDM, (req, res) => {
      const c = ctx(res);
      const w = c.world.id;
      const n = Math.max(0, Math.min(10, Number(req.query.next ?? 2) || 2));
      const cv: any = combatViewFor(d.db, w, c.viewer, settings(res));
      const list: any[] = cv.combatants ?? [];
      const win = turnWindow(list, cv.turn, n);
      const clock = getClock(d.db, w);
      const rec = (() => { try { return one<any>(d.db, 'SELECT id, name, started_at FROM audio_sessions WHERE world_id = ? AND stopped_at IS NULL ORDER BY started_at DESC', w); } catch { return null; } })();
      const chat = (() => { try { return one<any>(d.db, 'SELECT id, title, started_at FROM sessionchat_sessions WHERE world_id = ? AND ended_at IS NULL ORDER BY started_at DESC', w); } catch { return null; } })();
      let jobs: Record<string, { state: string }> = {};
      try { jobs = warmSnapshot(d); } catch (e) { if (!(e instanceof ModelUnavailable)) jobs = {}; }
      const states = Object.values(jobs).map((j) => j.state);
      const counts = {
        coin: count(d, `SELECT COUNT(*) AS n FROM ledger WHERE world_id = ? AND status = 'pending' AND id NOT IN (SELECT ledger_id FROM shop_orders WHERE ledger_id IS NOT NULL)`, w),
        items: count(d, `SELECT COUNT(*) AS n FROM item_changes WHERE world_id = ? AND status = 'pending'`, w),
        disputes: count(d, `SELECT COUNT(*) AS n FROM item_changes WHERE world_id = ? AND status = 'disputed'`, w),
        agent: count(d, `SELECT COUNT(*) AS n FROM agent_actions WHERE world_id = ? AND status = 'pending'`, w),
        broker: count(d, `SELECT COUNT(*) AS n FROM broker_requests WHERE world_id = ? AND (status = 'pricing' OR (status = 'waiting' AND needs_review = 1))`, w),
        requests: count(d, `SELECT COUNT(*) AS n FROM requests WHERE world_id = ? AND status = 'open'`, w),
      };
      const approvals = counts.coin + counts.items + counts.disputes + counts.agent;
      res.json({
        date: { label: clock.label, minutes: clock.minutes },
        combat: {
          active: !!cv.active, round: cv.round, turn: cv.turn, total: list.length,
          current: win.current, next: win.next,
        },
        session: {
          recording: !!rec, recordingId: rec?.id ?? null, recordingName: rec?.name ?? null, recordingSince: rec?.started_at ?? null,
          chatSession: chat ? { id: chat.id, title: chat.title } : null,
        },
        models: { ready: states.filter((s) => s === 'ready').length, total: states.length, loading: states.includes('loading'), failed: states.includes('failed') },
        counts: { ...counts, approvals, broker: counts.broker, requests: counts.requests, all: approvals + counts.broker + counts.requests },
        at: new Date().toISOString(),
      });
    });
    // The newest recording session with its last lines, DM view (asides marked by audience 'dm').
    r.get('/transcript', requireDM, (req, res) => {
      const w = ctx(res).world.id;
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 40) || 40));
      const s = one<any>(d.db, 'SELECT id, name, started_at, stopped_at FROM audio_sessions WHERE world_id = ? ORDER BY started_at DESC', w);
      if (!s) return res.json({ session: null, lines: [] });
      const lines = sessionLines(d.db, w, s.id, { includeDm: true }).slice(-limit);
      res.json({ session: { id: s.id, name: s.name, live: !s.stopped_at }, lines: lines.map((l: any) => ({ id: l.id, speaker: l.speaker, text: l.text, audience: l.audience, start: l.start })) });
    });
    return r;
  },
};
export default feature;
