// Checked drafts: house_rule_check keeps the cleaned file for an hour so house_rule_save can name it instead of the
// model typing the whole file again (a small model drifts when it retypes: a field it made up, a part it dropped).
// Per world, the newest 20. The assistant's harness asks saveProblem before a save becomes a card the DM approves,
// so an approved save never fails on a file that was never checked.
import { unpack, type ModFile } from './format.ts';

const DRAFT_MS = 60 * 60_000;
const drafts = new Map<string, { at: number; mods: ModFile[] }>();

export function keepDraft(worldId: string, mods: ModFile[]): string {
  const t = Date.now();
  for (const [k, v] of drafts) if (t - v.at > DRAFT_MS) drafts.delete(k);
  const mine = [...drafts.keys()].filter((k) => k.startsWith(worldId + ':'));
  for (const k of mine.slice(0, Math.max(0, mine.length - 19))) drafts.delete(k);
  const id = `${mods.length === 1 ? mods[0].id : 'package'}-${Math.random().toString(36).slice(2, 7)}`;
  drafts.set(`${worldId}:${id}`, { at: t, mods });
  return id;
}

export function takeDraft(worldId: string, id: string): ModFile[] | null {
  const d = drafts.get(`${worldId}:${id}`);
  return d && Date.now() - d.at <= DRAFT_MS ? d.mods : null;
}

/** Why a house_rule_save call would fail, said so the model can fix it before the DM sees a card; null when it is fine. */
export function saveProblem(worldId: string, a: { draft?: unknown; mod?: unknown }): string | null {
  if (typeof a.draft === 'string' && a.draft) return takeDraft(worldId, a.draft) ? null : `Not proposed: there is no checked draft ${a.draft.slice(0, 60)}. Check the file with house_rule_check and pass the draft id it gives.`;
  if (a.mod === undefined) return 'Not proposed: pass draft, the id house_rule_check gave for the checked file.';
  const { mods, errors } = unpack(a.mod);
  if (!mods.length) return `Not proposed: the file has problems: ${errors.slice(0, 8).join('; ')}. Fix them, check it with house_rule_check, and save with the draft id it gives instead of the whole file.`;
  return null;
}
