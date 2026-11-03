// The leak guard. Every rule about who may see what lives here, so it can be
// read and tested in one place. Two ideas:
//
// 1. Visibility is checked on the server for every record. Unknown or
//    missing visibility is treated as DM-only (fail closed).
// 2. Player copies of library pages are computed when a page is written,
//    not when it is read. Players are only ever served that copy, and the
//    party search index is built from it, so DM text cannot reach a player
//    through search, lore, relations or an AI answer built on them.
import type { FM, FMValue } from './frontmatter.ts';

export type Role = 'dm' | 'player' | 'guest';
export type Visibility = 'dm' | 'party' | 'me';

export interface Viewer {
  accountId: string;
  role: Role;
}

export function normVisibility(v: unknown): Visibility {
  if (v === 'party' || v === 'players' || v === 'public' || v === 'shared') return 'party';
  if (v === 'me' || v === 'private') return 'me';
  return 'dm';
}

/**
 * dm    - the DMs of the world, plus the record's owner
 * party - every member of the world
 * me    - only the owner (a player's "only me" notes are hidden from the DM too)
 */
export function canSee(viewer: Viewer, visibility: string, ownerId?: string | null): boolean {
  const v = normVisibility(visibility);
  const isOwner = !!ownerId && ownerId === viewer.accountId;
  if (v === 'me') return isOwner;
  if (v === 'party') return true;
  return isOwner || viewer.role === 'dm';
}

const DM_KEY = /^(secret|secrets|dm|dm_.*|gm|gm_.*|private)$/i;

/** Frontmatter with every DM-only key removed (secret:, dm_*, gm_* ...). */
export function playerFrontmatter(fm: FM): FM {
  const out: FM = {};
  for (const [k, v] of Object.entries(fm)) {
    if (DM_KEY.test(k) || k === 'visibility') continue;
    out[k] = stripNested(v);
  }
  return out;
}

function stripNested(v: FMValue): FMValue {
  if (Array.isArray(v)) return v.map(stripNested);
  if (v && typeof v === 'object') {
    const o: { [k: string]: FMValue } = {};
    for (const [k, x] of Object.entries(v)) if (!DM_KEY.test(k)) o[k] = stripNested(x);
    return o;
  }
  return v;
}

const DM_HEADING = /\((dm|gm)( only)?\)|\[(dm|gm)\]|\b(dm|gm) only\b|^(secrets?|dm notes?|gm notes?|dm|gm)$/i;

/**
 * Remove DM-only parts of a Markdown body:
 * - Obsidian comments %% ... %%
 * - <!-- dm --> ... <!-- /dm --> (also gm, secret)
 * - callouts that start with > [!secret], > [!dm] or > [!gm]
 * - any heading marked (DM), [DM], "DM only", or titled Secrets / DM notes,
 *   together with everything under it until the next heading of the same
 *   or a higher level
 */
export function redactMarkdown(body: string): string {
  let s = body.replace(/%%[\s\S]*?%%/g, '');
  s = s.replace(/<!--\s*(dm|gm|secret)\s*-->[\s\S]*?<!--\s*\/\s*(dm|gm|secret)\s*-->/gi, '');
  // An unclosed DM marker hides the rest of the page rather than leaking it.
  s = s.replace(/<!--\s*(dm|gm|secret)\s*-->[\s\S]*$/i, '');

  const out: string[] = [];
  const lines = s.split(/\r?\n/);
  let skipLevel = 0;
  let inSecretCallout = false;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (skipLevel) {
      if (h && h[1].length <= skipLevel) skipLevel = 0;
      else continue;
    }
    if (h && DM_HEADING.test(h[2].trim()) ) {
      skipLevel = h[1].length;
      continue;
    }
    if (inSecretCallout) {
      if (/^\s*>/.test(line)) continue;
      inSecretCallout = false;
    }
    if (/^\s*>\s*\[!(secret|dm|gm)\]/i.test(line)) {
      inSecretCallout = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Replace wiki links to DM-only pages so players don't learn those pages'
 * names: [[Hidden Cult]] -> (hidden), [[Hidden Cult|the cult]] -> the cult.
 */
export function scrubHiddenLinks(text: string, hidden: Set<string>): string {
  if (!hidden.size) return text;
  return text.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, target: string, label?: string) => {
    if (!hidden.has(target.trim().toLowerCase())) return m;
    return label && label.trim().toLowerCase() !== target.trim().toLowerCase() ? label : '(hidden)';
  });
}

export function scrubHiddenValues<T>(v: T, hidden: Set<string>): T {
  if (typeof v === 'string') return scrubHiddenLinks(v, hidden) as T;
  if (Array.isArray(v)) return v.map((x) => scrubHiddenValues(x, hidden)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubHiddenValues(x, hidden)])) as T;
  return v;
}

/**
 * Phrases that suggest DM-only text written as plain prose ("The secret:",
 * "DM note:") rather than in a secret block. The leak guard cannot know such
 * text is secret, so shared pages containing it are listed for the DM.
 */
const SECRET_HINT = /\b(dm|gm)[ -]?(only|notes?|brief)\b|\bthe secret\b|\bsecret(ly)?:|\bplayers? (don't|do not|must not) know\b|\bhidden from (the )?players?\b/i;

export function secretHints(body: string): string[] {
  const out: string[] = [];
  body.split('\n').forEach((line, i) => {
    if (SECRET_HINT.test(line)) out.push(`line ${i + 1}`);
  });
  return out;
}

/** Player copy of a page, or null when the page is not shared with the party. */
export function playerCopy(visibility: string, fm: FM, body: string): { fm: FM; body: string } | null {
  if (normVisibility(visibility) !== 'party') return null;
  return { fm: playerFrontmatter(fm), body: redactMarkdown(body) };
}

export interface WorldSettings {
  trackWeight: boolean;
  coins: 'gsc' | 'all' | 'gold';
  partyPurse: boolean;
  dmEditsInventory: boolean;
  monsterHealth: 'none' | 'words' | 'bar' | 'exact';
  initiativeVisible: boolean;
  mapPins: boolean;
  mapDraw: boolean;
  mapStops: boolean;
  whiteboardWipe: 'dm' | 'all';
  messageDays: number | null;
  captions: boolean;
  rules: string;
  requestDefault: 'dm' | 'party';
  quickEventTimer: number | null;
  themeEffects: boolean;
  calendar: 'builtin' | 'off';
}

export const DEFAULT_SETTINGS: WorldSettings = {
  trackWeight: false,
  coins: 'gsc',
  partyPurse: true,
  dmEditsInventory: true,
  monsterHealth: 'words',
  initiativeVisible: true,
  mapPins: true,
  mapDraw: true,
  mapStops: true,
  whiteboardWipe: 'dm',
  messageDays: 14,
  captions: true,
  rules: 'dnd55',
  requestDefault: 'dm',
  quickEventTimer: 20,
  themeEffects: true,
  calendar: 'builtin',
};

/** Merge a settings patch, keeping only known keys with the right type. */
export function mergeSettings(cur: WorldSettings, patch: Record<string, unknown>): WorldSettings {
  const out: any = { ...cur };
  const enums: Record<string, readonly string[]> = {
    coins: ['gsc', 'all', 'gold'],
    monsterHealth: ['none', 'words', 'bar', 'exact'],
    whiteboardWipe: ['dm', 'all'],
    requestDefault: ['dm', 'party'],
    calendar: ['builtin', 'off'],
  };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${k}`);
    const d = (DEFAULT_SETTINGS as any)[k];
    if (enums[k]) {
      if (typeof v !== 'string' || !enums[k].includes(v)) throw new Error(`${k} must be one of ${enums[k].join(', ')}`);
    } else if (k === 'messageDays' || k === 'quickEventTimer') {
      if (v !== null && !(Number.isInteger(v) && (v as number) > 0 && (v as number) <= 3650)) throw new Error(`${k} must be a positive whole number or null`);
    } else if (typeof d === 'boolean' && typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
    else if (typeof d === 'string' && (typeof v !== 'string' || v.length > 40)) throw new Error(`${k} must be short text`);
    out[k] = v;
  }
  return out;
}

/** What players see of a monster's health, per the world setting. */
export function healthForPlayers(hp: number | null, max: number | null, mode: WorldSettings['monsterHealth']): string | null {
  if (mode === 'none' || hp === null || max === null || max <= 0) return null;
  if (mode === 'exact') return `${hp}/${max}`;
  const pct = Math.max(0, Math.min(1, hp / max));
  if (mode === 'bar') return String(Math.round(pct * 100));
  if (hp <= 0) return 'Down';
  if (pct <= 0.25) return 'Near death';
  if (pct <= 0.5) return 'Bloodied';
  if (pct < 1) return 'Hurt';
  return 'Unhurt';
}
