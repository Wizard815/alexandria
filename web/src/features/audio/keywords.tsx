// Highlighted key words in transcript bubbles. The modules feature answers
// POST /modules/match and GET /modules/card/:source/:id (players only ever
// get what the server allows them). A 404 means it is not there: no
// highlights, and we stop asking for a while.
import { useEffect, useState, type ReactNode } from 'react';
import type { WorldClient } from '@alx/client';
import { Markdown } from '../../ui/index.tsx';

export interface Match { start: number; end: number; term: string; kind: string; source: 'module' | 'library'; id: string }

const cache = new Map<string, Match[]>();
const cards = new Map<string, any>();
let offUntil = 0;

export async function matchText(w: WorldClient, key: string, text: string): Promise<Match[]> {
  const hit = cache.get(key);
  if (hit) return hit;
  if (Date.now() < offUntil) return [];
  try {
    const r = await w.call<Match[] | { matches: Match[] }>('POST', '/modules/match', { text });
    const list = (Array.isArray(r) ? r : r?.matches ?? []).filter((m) => m && Number.isInteger(m.start) && Number.isInteger(m.end) && m.end > m.start && m.end <= text.length);
    cache.set(key, list);
    if (cache.size > 800) cache.delete(cache.keys().next().value!);
    return list;
  } catch {
    offUntil = Date.now() + 5 * 60_000;
    return [];
  }
}

export async function loadCard(w: WorldClient, m: Match): Promise<any | null> {
  const k = `${m.source}/${m.id}`;
  if (cards.has(k)) return cards.get(k);
  try {
    const c = await w.call('GET', `/modules/card/${encodeURIComponent(m.source)}/${encodeURIComponent(m.id)}`);
    cards.set(k, c);
    return c;
  } catch { return null; }
}

export function useMatches(w: WorldClient, id: string, rev: number, text: string): Match[] {
  const key = `${id}:${rev}`;
  const [list, setList] = useState<Match[]>(() => cache.get(key) ?? []);
  useEffect(() => {
    let alive = true;
    void matchText(w, key, text).then((m) => { if (alive) setList(m); });
    return () => { alive = false; };
  }, [w, key, text]);
  return list;
}

export function Highlighted({ text, matches, onHover }: { text: string; matches: Match[]; onHover: (m: Match | null, el?: HTMLElement) => void }) {
  if (!matches.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    if (m.start > at) out.push(text.slice(at, m.start));
    out.push(
      <mark key={m.start} className={`au-kw au-kw-${m.kind}`} tabIndex={0}
        onMouseEnter={(e) => onHover(m, e.currentTarget)} onMouseLeave={() => onHover(null)}
        onFocus={(e) => onHover(m, e.currentTarget)} onBlur={() => onHover(null)}>{text.slice(m.start, m.end)}</mark>,
    );
    at = m.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

export function CardView({ card, m }: { card: any; m: Match }) {
  const title = card?.title ?? card?.name ?? m.term;
  const body = card?.markdown ?? card?.text ?? card?.summary ?? card?.body ?? card?.description ?? '';
  return (
    <div className="au-card" role="tooltip">
      <strong>{String(title)}</strong> <span className="tiny faint">{m.kind}</span>
      {typeof body === 'string' && body ? <Markdown text={body.slice(0, 900)} /> : null}
    </div>
  );
}
