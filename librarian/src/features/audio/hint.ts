// The vocabulary prompt sent with each chunk to the speech model, and the list
// of DM-only terms a player's transcript must never repeat.
//
// The prompt is built ONLY from what every player may already read: pages
// with a player copy, player and character names, and dice words. A DM-only,
// broker or classified title never goes in it (the prompt also leaves this
// machine when the audio job is a cloud provider). It is short (150 chars):
// a long list of names slowed decoding and cost accuracy, and Whisper reads
// leftovers of it back on crosstalk.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { parseJson } from '../../core/util.ts';
import { token } from './merge.ts';

export const HINT_MAX = 150;
export const DICE_WORDS = 'd4 d6 d8 d10 d12 d20 nat 20 advantage disadvantage';

/** Page titles that are headings of the app's own scaffolding, not names someone says. */
const GENERIC = new Set(['calendar', 'bonds', 'session', 'sessions', 'notes', 'index', 'home', 'overview', 'timeline', 'summary', 'players', 'party', 'quests', 'locations', 'rules', 'recap', 'log', 'readme', 'template', 'untitled', 'new', 'page', 'bible', 'handouts', 'npcs', 'items', 'factions', 'people', 'places', 'campaign', 'world', 'story', 'lore', 'map', 'maps', 'tags', 'inbox']);

const proper = (s: string) => {
  const t = s.trim();
  if (t.length < 3 || t.length > 28) return false;
  if (!/^\p{Lu}/u.test(t)) return false;
  const ws = t.split(/\s+/);
  if (ws.length > 4) return false;
  if (ws.every((w) => /^\d+$/.test(w))) return false;
  if (/\d/.test(t) && ws.length > 1 && ws.some((w) => /^\d+$/.test(w))) return false; // "Session 21"
  if (/[\[\]()#|/\\:<>{}]/.test(t)) return false;
  const k = token(t);
  if (GENERIC.has(k) || GENERIC.has(token(ws[0])) && ws.length === 1) return false;
  return true;
};

interface PageRow { title: string; aliases: string; updated_at: string }

/** Proper nouns from party-visible pages and the table's player and character names, best first, in at most `max` characters. */
export function buildHint(db: DB, worldId: string, max = HINT_MAX): string {
  const score = new Map<string, number>();
  const add = (name: string, w: number) => { const n = name.trim(); if (n) score.set(n, (score.get(n) ?? 0) + w); };
  try {
    for (const m of all<any>(db, "SELECT a.display_name AS d, m.character_name AS c FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId)) {
      if (m.c && proper(String(m.c))) add(String(m.c), 3);
      if (m.d && proper(String(m.d))) add(String(m.d), 1.5);
    }
  } catch { /* no members table */ }
  let rows: PageRow[] = [];
  try {
    // Only pages with a player copy: what a player can open.
    rows = all<PageRow>(db, "SELECT title, aliases, updated_at FROM pages WHERE world_id = ? AND visibility = 'party' AND player_body IS NOT NULL ORDER BY updated_at DESC LIMIT 300", worldId);
  } catch { /* no pages table yet */ }
  // Frequency: how often the table said it lately (players' own transcript lines only).
  let said = '';
  try {
    said = all<any>(db, "SELECT text FROM audio_lines WHERE world_id = ? AND audience = 'players' ORDER BY updated_at DESC LIMIT 300", worldId).map((r) => ` ${r.text.toLowerCase()} `).join('');
  } catch { /* no lines yet */ }
  rows.forEach((p, i) => {
    const recency = 1 - i / Math.max(1, rows.length);
    const names = [p.title, ...parseJson<unknown[]>(p.aliases, []).filter((a): a is string => typeof a === 'string')];
    for (const n of names) {
      if (!proper(n)) continue;
      let freq = 0;
      if (said) { const q = n.toLowerCase(); for (let at = said.indexOf(q); at >= 0 && freq < 6; at = said.indexOf(q, at + q.length)) freq++; }
      add(n, 0.5 + recency + Math.log2(1 + freq) * 1.2);
    }
  });
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([n]) => n);
  const room = max - DICE_WORDS.length - 2;
  let names = '';
  const seen = new Set<string>();
  for (const n of ranked) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    const next = names ? `${names}, ${n}` : n;
    if (next.length > room) continue;
    names = next;
    seen.add(k);
  }
  return names ? `${names}. ${DICE_WORDS}` : DICE_WORDS;
}

/**
 * Titles and aliases of everything a player cannot read (DM-only, broker and
 * classified pages, and pages with no player copy), as token lists. A title
 * that is also a player-visible name is left out. Used to catch a DM-only
 * name turning up in a players' line.
 */
export function dmOnlyTerms(db: DB, worldId: string): string[][] {
  const hidden = new Map<string, string[]>();
  const open = new Set<string>();
  try {
    for (const p of all<any>(db, "SELECT title, aliases, visibility, player_body FROM pages WHERE world_id = ?", worldId)) {
      const visible = p.visibility === 'party' && p.player_body !== null;
      for (const n of [p.title, ...parseJson<unknown[]>(p.aliases, [])]) {
        if (typeof n !== 'string') continue;
        const t = n.split(/\s+/).map(token).filter(Boolean);
        if (!t.length) continue;
        const k = t.join(' ');
        if (visible) open.add(k);
        else if (t.length > 1 || k.length >= 6) hidden.set(k, t);
      }
    }
  } catch { /* no pages table */ }
  // The table's own names are never secret: player and character names (whole and each part), and the titles
  // of Minerva's notes about the player characters. Without this, Minerva filing "Anselm" as a DM-only codex
  // page turned every line naming the PC DM-only on a one-mic table.
  try {
    for (const m of all<any>(db, "SELECT a.display_name AS d, m.character_name AS c FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId)) {
      for (const n of [m.d, m.c]) {
        if (typeof n !== 'string') continue;
        const t = n.split(/\s+/).map(token).filter(Boolean);
        if (t.length) open.add(t.join(' '));
        for (const part of t) if (part.length >= 3) open.add(part);
      }
    }
  } catch { /* no members table */ }
  try {
    for (const p of all<any>(db, "SELECT title FROM pages WHERE world_id = ? AND (path LIKE 'Minerva/codex/characters/pc/%' OR path LIKE 'Minerva/players/%')", worldId)) {
      const t = String(p.title ?? '').split(/\s+/).map(token).filter(Boolean);
      if (t.length) open.add(t.join(' '));
    }
  } catch { /* no pages table */ }
  for (const k of open) hidden.delete(k);
  return [...hidden.values()];
}

/** Does the line contain one of the term token lists as a run of words? */
export function containsTerm(text: string, terms: string[][]): boolean {
  if (!terms.length) return false;
  const t = text.split(/\s+/).map(token).filter(Boolean);
  for (const term of terms) {
    for (let i = 0; i + term.length <= t.length; i++) {
      let k = 0;
      while (k < term.length && t[i + k] === term[k]) k++;
      if (k === term.length) return true;
    }
  }
  return false;
}
