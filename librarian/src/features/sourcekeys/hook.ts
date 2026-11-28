// The broker's hook: a question the broker could not answer from the asker's own
// view (it goes to the GM to price) is also an escalation, so it shows in the
// GM queue with the hidden context, and in gm-question mode the GM can simply
// answer it. The broker request already exists; this links to it.
import type { Deps } from '../../app.ts';
import { addHidden, escalate, gatherContext, type HiddenItem } from './escalation.ts';

export function escalateFromBroker(d: Deps, a: { worldId: string; accountId: string; question: string; brokerRequestId: string; reason: string; evidence: any[]; routing: unknown }): void {
  try {
    const items: HiddenItem[] = (Array.isArray(a.evidence) ? a.evidence : []).slice(0, 8).map((e: any) => ({ title: String(e?.title ?? e?.page ?? 'GM page').slice(0, 120), source: 'library', text: String(e?.text ?? '').slice(0, 400) }));
    const e = escalate(d, { worldId: a.worldId, accountId: a.accountId, question: a.question, origin: 'broker', brokerRequestId: a.brokerRequestId, hidden: { reason: a.reason || 'The broker could not answer this from the asker\'s own view.', items, routing: a.routing as any } });
    // Keys the GM gave the broker may know more: add what they find, in the background.
    void gatherContext(d, a.worldId, a.accountId, a.question).then((more) => { if (more.length) addHidden(d, e.id, more); }).catch(() => {});
  } catch { /* the broker flow must never fail because of this */ }
}
