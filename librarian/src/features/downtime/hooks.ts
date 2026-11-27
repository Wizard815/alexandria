// How other features tie into downtime. A feature registers a link kind:
// it may offer per-character activities (the Codex offers "Craft <spell>"
// for each recipe a character can learn) and act when a task with that link
// finishes (file the learn request). Every downtime day worked is also
// emitted as the server event `downtime-day` { accountId, taskId, minutes,
// link, activityId }, which a feature can `hub.tap` (MANA study: each
// 8-hour day earns study points).
import type { DB } from '../../core/db.ts';
import type { EventHub } from '../../core/events.ts';
import type { Activity, Link } from './catalog.ts';

export interface LinkHandler {
  kind: string;
  /** Activities this link offers one character (ids must be unique, e.g. "craft-<recipe>"). */
  activities?: (db: DB, worldId: string, accountId: string) => Activity[];
  /** A task with this link just finished. Return a line for the log, if any. Runs inside the downtime transaction. */
  onComplete?: (d: { db: DB; hub: EventHub }, worldId: string, task: any, link: Link) => string | void;
}

const handlers = new Map<string, LinkHandler>();
export function addDowntimeLink(h: LinkHandler) { handlers.set(h.kind, h); }
export const linkFor = (kind: string) => handlers.get(kind) ?? null;
export const linkHandlers = () => [...handlers.values()];
