// Other features may watch the transcript as it is written (Active mode reads
// each line as it settles). A listener must be quick and must never throw.
import type { Deps } from '../../app.ts';

export type LineListener = (d: Deps, worldId: string, lineId: string, removed: boolean) => void;
const listeners: LineListener[] = [];

export const onTranscriptLine = (fn: LineListener): void => { listeners.push(fn); };
export function notifyLine(d: Deps, worldId: string, lineId: string, removed: boolean): void {
  for (const fn of listeners) { try { fn(d, worldId, lineId, removed); } catch (e) { console.error('audio: line listener failed', e); } }
}
