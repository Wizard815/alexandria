// Live updates over Server-Sent Events. Every event carries an audience
// check that runs per subscriber on the server, so a DM-only event is never
// written to a player's stream.
import type { Response } from 'express';
import type { Viewer } from './policy.ts';

export type Audience = (v: Viewer) => boolean;

interface Sub {
  worldId: string;
  viewer: Viewer;
  res: Response;
}

export const everyone: Audience = () => true;
export const dmOnly: Audience = (v) => v.role === 'dm';
export const dmAnd = (...ids: string[]): Audience => (v) => v.role === 'dm' || ids.includes(v.accountId);
export const only = (...ids: string[]): Audience => (v) => ids.includes(v.accountId);

export class EventHub {
  private subs = new Set<Sub>();

  subscribe(worldId: string, viewer: Viewer, res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const sub = { worldId, viewer, res };
    this.subs.add(sub);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    res.on('close', () => {
      clearInterval(ping);
      this.subs.delete(sub);
    });
  }

  emit(worldId: string, type: string, data: unknown, audience: Audience) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.subs) {
      if (s.worldId === worldId && audience(s.viewer)) s.res.write(payload);
    }
  }

  /** Emit a value computed per viewer (for role-filtered views like combat). */
  emitPer(worldId: string, type: string, view: (v: Viewer) => unknown | null) {
    for (const s of this.subs) {
      if (s.worldId !== worldId) continue;
      const data = view(s.viewer);
      if (data !== null && data !== undefined) s.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  count(worldId: string) {
    let n = 0;
    for (const s of this.subs) if (s.worldId === worldId) n++;
    return n;
  }
}
