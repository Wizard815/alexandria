// Live updates over Server-Sent Events. Every event carries an audience
// check that runs per subscriber on the server, so a GM-only event is never
// written to a player's stream.
import type { Response } from 'express';
import type { Viewer } from './policy.ts';

export type Audience = (v: Viewer) => boolean;

interface Sub {
  worldId: string;
  viewer: Viewer;
  res: Response;
  /** Is this subscriber still who they were when the stream opened (a member with the same role, the session or key still valid)? */
  alive?: () => boolean;
}

export const everyone: Audience = () => true;
export const dmOnly: Audience = (v) => v.role === 'dm';
export const dmAnd = (...ids: string[]): Audience => (v) => v.role === 'dm' || ids.includes(v.accountId);
export const only = (...ids: string[]): Audience => (v) => ids.includes(v.accountId);

export class EventHub {
  private subs = new Set<Sub>();
  private taps = new Set<(worldId: string, type: string, data: unknown) => void>();

  /** Server-side listener for every emit (not per viewer). For features that react to an event type, such as a session starting. Never forward `data` to a viewer. */
  tap(fn: (worldId: string, type: string, data: unknown) => void): () => void {
    this.taps.add(fn);
    return () => { this.taps.delete(fn); };
  }

  subscribe(worldId: string, viewer: Viewer, res: Response, alive?: () => boolean) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const sub: Sub = { worldId, viewer, res, alive };
    this.subs.add(sub);
    const ping = setInterval(() => { if (this.drop(sub)) return; res.write(': ping\n\n'); }, 25_000);
    res.on('close', () => {
      clearInterval(ping);
      this.subs.delete(sub);
    });
  }

  /** A stream stays open long after it was checked: close it when its person left the world, changed role, signed out or lost the key. */
  private drop(s: Sub): boolean {
    let alive = true;
    try { alive = s.alive ? s.alive() : true; } catch { alive = false; }
    if (alive) return false;
    this.subs.delete(s);
    try { s.res.end(); } catch { /* already closed */ }
    return true;
  }

  emit(worldId: string, type: string, data: unknown, audience: Audience) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of [...this.subs]) {
      if (s.worldId === worldId && !this.drop(s) && audience(s.viewer)) s.res.write(payload);
    }
    for (const t of this.taps) { try { t(worldId, type, data); } catch { /* a listener never breaks an emit */ } }
  }

  /** Emit a value computed per viewer (for role-filtered views like combat). */
  emitPer(worldId: string, type: string, view: (v: Viewer) => unknown | null) {
    for (const s of [...this.subs]) {
      if (s.worldId !== worldId || this.drop(s)) continue;
      const data = view(s.viewer);
      if (data !== null && data !== undefined) s.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    // Server-side listeners (taps) see the GM's view: they run inside the
    // librarian and never forward data to a viewer (see tap()).
    if (this.taps.size) {
      let dmView: unknown;
      try { dmView = view({ accountId: '', role: 'dm' } as Viewer); } catch { return; }
      if (dmView === null || dmView === undefined) return;
      for (const t of this.taps) { try { t(worldId, type, dmView); } catch { /* a listener never breaks an emit */ } }
    }
  }

  count(worldId: string) {
    let n = 0;
    for (const s of this.subs) if (s.worldId === worldId) n++;
    return n;
  }
}
