// What a sculpt does with its result: save a page, show it on the stage, add it
// to combat, send it to players, turn it into a broker note. Each is separate,
// so one failing never loses the others. Anything players or the broker may
// see goes through the leak check first.
import type { Request } from 'express';
import type { Deps } from '../../app.ts';
import { HttpError } from '../../core/util.ts';
import { firstLeak, type RenderCtx } from './ctx.ts';
import { monstersOf } from './gens.ts';
import { publicText, renderParts, type Part, type SculptResult, type Tpl, type Values } from './engine.ts';
import { listItems, makeRng, rollDice } from './lang.ts';

export const OUTPUT_KEYS = ['page', 'stage', 'combat', 'send', 'broker'] as const;
export type OutputKey = (typeof OUTPUT_KEYS)[number];

/** Call another route of this same server as the DM making the request. */
export async function selfCall(req: Request, worldId: string, method: string, path: string, body: unknown): Promise<any> {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const r = await fetch(`http://127.0.0.1:${req.socket.localPort}/api/worlds/${worldId}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: String(req.headers.cookie ?? '') }) },
    body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status >= 400 && r.status < 600 ? r.status : 502, String(j?.error ?? r.status));
  return j;
}

/** The text players may see of a result; throws if it repeats DM-only notes or is empty. */
export function publicOf(tpl: Tpl, results: SculptResult[], values: Values[], rc: RenderCtx): { text: string; parts: Part[][] } {
  const parts = values.map((v) => renderParts(tpl, v, rc));
  const text = parts.map(publicText).filter(Boolean).join('\n\n---\n\n');
  if (!text.trim()) throw new HttpError(422, 'There is nothing in this result that players may see');
  const hit = firstLeak(rc, text);
  if (hit) throw new HttpError(409, 'Blocked: the text repeats words from DM-only notes.');
  void results;
  return { text, parts };
}

export const plain = (md: string): string => md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1').replace(/^\s*\|?\s*-{3,}[\s|-]*$/gm, '').replace(/[*_#>`|]/g, ' ').replace(/^\s*-\s+/gm, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

export interface Combatant { name: string; hp: number | null; ac: number | null; initiative: number }

/** Lines like "3× Goblin (CR 1/4, AC 15, HP 7)" become combatants, with initiative rolled. */
export function combatantsFromList(d: Deps, worldId: string, rc: RenderCtx, list: string): Combatant[] {
  const known = new Map(monstersOf(rc).map((m) => [m.name.toLowerCase(), m]));
  const out: Combatant[] = [];
  const r = makeRng(`${Date.now()}|${Math.random()}`);
  for (const line of listItems(list)) {
    const m = /^(?:(\d+)\s*[×x]\s*)?(.+?)(?:\s*\(([^)]*)\))?\s*$/i.exec(line);
    if (!m) continue;
    const n = Math.max(1, Math.min(20, Number(m[1] ?? 1)));
    const name = m[2].trim().slice(0, 70);
    const info = m[3] ?? '';
    const mon = known.get(name.toLowerCase());
    const ac = Number(/AC\s*(\d+)/i.exec(info)?.[1]) || mon?.ac || null;
    const hp = Number(/HP\s*(\d+)/i.exec(info)?.[1]) || mon?.hp || null;
    for (let i = 1; i <= n; i++) out.push({ name: n > 1 ? `${name} ${i}` : name, hp, ac, initiative: rollDice('1d20', r).total + Math.floor(((mon?.dex ?? 10) - 10) / 2) });
  }
  void d; void worldId;
  return out.slice(0, 40);
}
