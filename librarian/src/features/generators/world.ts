// What a generator may know about the world: the places and factions in the
// library that the GM's AI copy can see (never classified), every title already
// used (so generated names do not repeat them), the party's level, and what the
// party already knows (the party-scope story bible) for rumours. Built from
// the same views the models get, so a generator can never repeat a secret that
// a model could not.
import type { Deps } from '../../app.ts';
import type { Viewer } from '../../core/policy.ts';
import { all, one } from '../../core/db.ts';
import { assembleBible } from '../bible/assemble.ts';
import { makeCtx } from '../sculpt/ctx.ts';

export interface Tie { id: string; title: string; kind: 'place' | 'faction'; partyVisible: boolean; via: 'library' | 'bible' }
export interface WorldInfo {
  worldId: string; coins: string; partyLevel: number;
  places: Tie[]; factions: Tie[];
  /** Every title the AI copy can see, lower-cased. */
  titles: Set<string>;
  /** Short statements the party already knows, for rumours. */
  rumours: string[];
}

export const emptyWorld = (): WorldInfo => ({ worldId: '', coins: 'gsc', partyLevel: 3, places: [], factions: [], titles: new Set(), rumours: [] });

const AI: Viewer = { accountId: 'generators-ai', role: 'gm', audience: 'ai' };
const PARTY: Viewer = { accountId: 'generators-party', role: 'player' };
const PLACE_RE = /\b(places?|locations?|cit(y|ies)|towns?|village|settlements?|regions?|districts?|landmarks?|dungeons?|taverns?|inns?|keeps?|castles?|realms?)\b/i;
const FACTION_RE = /\b(factions?|organi[sz]ations?|guilds?|orders?|houses?|cults?|clans?|compan(y|ies)|brotherhoods?|courts?)\b/i;
const SKIP_RE = /\b(generated|statblock|sculpt|session|file)\b/i;

/** The places and factions of a list of pages, by kind, tags and folder (the title itself never decides). */
export function tiesFrom(rows: { id: string; title: string; path: string; kind?: string | null; tags: string[]; visibility?: string }[]): { places: Tie[]; factions: Tie[] } {
  const places: Tie[] = [], factions: Tie[] = [];
  for (const row of rows) {
    const folder = row.path.split('/').slice(0, -1).join(' ');
    const hay = `${row.kind ?? ''} ${row.tags.join(' ')} ${folder}`;
    if (SKIP_RE.test(`${row.tags.join(' ')} ${folder}`) || SKIP_RE.test(String(row.kind ?? ''))) continue;
    const tie = (kind: Tie['kind']): Tie => ({ id: row.id, title: row.title, kind, partyVisible: row.visibility === 'party', via: 'library' });
    if (FACTION_RE.test(hay)) factions.push(tie('faction'));
    else if (PLACE_RE.test(hay)) places.push(tie('place'));
  }
  return { places, factions };
}

export async function loadWorld(d: Deps, worldId: string, coins = 'gsc'): Promise<WorldInfo> {
  const rows = d.library.list(worldId, AI) as { id: string; title: string; path: string; kind: string | null; tags: string[]; visibility?: string }[];
  const { places, factions } = tiesFrom(rows);
  const titles = new Set(rows.map((r) => r.title.toLowerCase().trim()));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // The story bible's places and factions (GM scope, AI copy), when facts have been read.
  const seenTitle = new Set([...places, ...factions].map((t) => t.title.toLowerCase()));
  try {
    for (const kind of ['place', 'faction'] as const) {
      const bible = await assembleBible(d, worldId, AI, { kind, limit: 40 });
      for (const s of bible.subjects) {
        if (seenTitle.has(s.subject.toLowerCase())) continue;
        const pg = s.facts.flatMap((f) => f.pages).map((p) => byId.get(p.id)).find(Boolean);
        if (!pg) continue;
        seenTitle.add(s.subject.toLowerCase());
        (kind === 'place' ? places : factions).push({ id: pg.id, title: s.subject, kind, partyVisible: pg.visibility === 'party', via: 'bible' });
      }
    }
  } catch { /* no bible yet */ }

  // What the party already knows, as rumours.
  const rumours: string[] = [];
  try {
    const bible = await assembleBible(d, worldId, PARTY, { limit: 60 });
    for (const s of bible.subjects) for (const f of s.facts.slice(0, 1)) { const t = f.text.replace(/\s+/g, ' ').trim(); if (t.length >= 20 && t.length <= 160) rumours.push(t); }
  } catch { /* none */ }

  let level = 3;
  try { level = makeCtx(d, worldId, false, {}).partyLevel(); } catch { /* default */ }
  void all; void one;
  return { worldId, coins, partyLevel: level, places, factions, titles, rumours: rumours.slice(0, 12) };
}

/** A short excerpt of a page as a model may read it (the AI copy), for enrichment. Empty when the page is gone. */
export function excerptOf(d: Deps, worldId: string, id: string, n = 300): string {
  try {
    const pg: any = d.library.get(worldId, id, AI);
    return String(pg.body ?? '').replace(/^#+\s.*$/gm, ' ').replace(/> \[!\w+\][^\n]*/g, ' ').replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
  } catch { return ''; }
}
