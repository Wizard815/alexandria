// What a player sees of the vault, and the player forms of the tools
// (docs/MINERVA.md §5, §7). Players never meet Minerva: everything here is the
// player's own journal, goals, knowledge and bonds, the party-level pages, and
// nothing carries her name. Text is the library's own player copy (secret
// blocks cut out), and a player's writes only ever touch their own root.
import type { Deps } from '../../app.ts';
import { one } from '../../core/db.ts';
import { HttpError } from '../../core/util.ts';
import { searchTerms } from '../agent/intent.ts';
import { autoApproved, currentSession, openArc } from './store.ts';
import { applyOp, createDraft, type Op } from './ops.ts';
import { HEATS, fileName, listOf, listPages, norm, players, readPage, vaultLevel, type VaultPage } from './vault.ts';

// ---- the persona check ------------------------------------------------------------

const GIVEAWAYS: RegExp[] = [
  /\bminerva\b/i,
  /\b(the )?(dm|dungeon master|game master|gm)['’]?s?\s+(ai|assistant|helper|aide|agent|memory|notes?)\b/i,
  /\bassistant\s+(to|of|for)\s+the\s+(dm|dungeon master|game master|gm)\b/i,
  /\bi\s+(work|am working|serve|answer)\s+(for|to)\s+the\s+(dm|dungeon master|game master|gm)\b/i,
  /\bmemory vault\b/i,
];

/** Is the match inside a denial ("I'm not Minerva", "I don't have any DM notes")? A negation earlier in the same sentence makes it one. */
function denied(text: string, index: number): boolean {
  const start = Math.max(text.lastIndexOf('.', index - 1), text.lastIndexOf('!', index - 1), text.lastIndexOf('?', index - 1), text.lastIndexOf('\n', index - 1)) + 1;
  return /\b(not|never|no|none|nothing|nobody|neither|nor|cannot|without)\b|n['’]t\b/i.test(text.slice(start, index));
}

/**
 * A phrase in a reply to a player that gives the DM's assistant away (her name, or that the broker works for the DM), or null.
 * A denial is not a giveaway: "I'm not Minerva" and "I don't work for the DM" pass. Only a reply that affirms or names her is held.
 */
export function personaGiveaway(text: string, name = 'Minerva'): string | null {
  const t = String(text ?? '');
  const firstAffirmed = (re: RegExp): string | null => {
    for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) if (!denied(t, m.index ?? 0)) return m[0];
    return null;
  };
  for (const re of GIVEAWAYS) { const m = firstAffirmed(re); if (m) return m; }
  const n = name.trim();
  if (n.length >= 3 && n.toLowerCase() !== 'minerva') { const m = firstAffirmed(new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu')); if (m) return m; }
  return null;
}

/** The broker's own name and title (the persona the players know), or the default. */
export function brokerPersona(d: Deps, worldId: string): { name: string; title: string } {
  const c = (() => { try { return JSON.parse(one<any>(d.db, 'SELECT config FROM broker_config WHERE world_id = ?', worldId)?.config ?? '{}'); } catch { return {}; } })();
  return { name: String(c?.persona?.name || 'The Broker'), title: String(c?.persona?.title || '') };
}

// ---- reading ------------------------------------------------------------------------

export interface View { key: string; title: string; body: string; heat?: string; updatedAt: string; by?: string }

/** The player copy of a vault page: its text with every secret block cut out, or null. */
function playerText(d: Deps, worldId: string, p: VaultPage): string | null {
  if (vaultLevel(p.fm) !== 'party') return null;
  try { return d.library.liftedCopy(worldId, p.id)?.body ?? null; } catch { return null; }
}

const ownRoot = (accountId: string) => `players/${accountId}/`;
const strip = (rel: string, accountId: string) => rel.slice(ownRoot(accountId).length);

export interface PlayerViewOut {
  profile: View | null; shared: View | null; bonds: View | null; knowledge: View | null;
  goals: View[]; journal: View[]; notes: View[];
  /** Party-level pages: what the whole table may know. */
  party: View[];
  /** The other players' "shared with the party" pages. */
  others: View[];
  session: number;
}

export function playerView(d: Deps, worldId: string, accountId: string): PlayerViewOut {
  const root = ownRoot(accountId);
  const mine = listPages(d, worldId, root);
  const view = (p: VaultPage, key = strip(p.rel, accountId)): View | null => {
    const body = playerText(d, worldId, p);
    return body === null ? null : { key, title: p.title, body, heat: typeof p.fm.heat === 'string' ? p.fm.heat : undefined, updatedAt: p.updatedAt };
  };
  const one_ = (name: string) => { const p = mine.find((x) => x.rel === `${root}${name}`); return p ? view(p) : null; };
  const group = (dir: string) => mine.filter((p) => p.rel.startsWith(`${root}${dir}/`)).map((p) => view(p)).filter((v): v is View => !!v);
  const ps = players(d, worldId);
  const others: View[] = [];
  for (const o of ps.filter((x) => x.accountId !== accountId)) {
    const p = readPage(d, worldId, `players/${o.accountId}/shared.md`);
    const v = p && playerText(d, worldId, p);
    if (p && v && /^\s*-\s+\S/m.test(v)) others.push({ key: o.accountId, title: o.character || o.name, body: v, updatedAt: p.updatedAt });
  }
  const party: View[] = [];
  for (const p of [...listPages(d, worldId, 'chronicle/'), ...listPages(d, worldId, 'codex/')]) {
    const body = playerText(d, worldId, p);
    if (body !== null) party.push({ key: p.rel, title: p.title, body, updatedAt: p.updatedAt });
  }
  return {
    profile: one_('profile.md'), shared: one_('shared.md'), bonds: one_('bonds.md'), knowledge: one_('knowledge.md'),
    goals: group('goals'), journal: group('journal').sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })), notes: group('notes'),
    party, others, session: currentSession(d.db, worldId),
  };
}

/** Everything this player's reads may carry, for the broker's reply check: it is theirs (or the party's), so repeating it is fine. */
export function playerTexts(d: Deps, worldId: string, accountId: string): string[] {
  const v = playerView(d, worldId, accountId);
  return [v.profile, v.shared, v.bonds, v.knowledge, ...v.goals, ...v.journal, ...v.notes, ...v.party, ...v.others].filter((x): x is View => !!x).map((x) => x.body);
}

/** The block the broker is given for one player's message: what they know, nothing else. */
export function brokerContext(d: Deps, worldId: string, accountId: string, question: string): string {
  let v: PlayerViewOut;
  try { v = playerView(d, worldId, accountId); } catch { return ''; }
  const clip = (s: string, n: number) => s.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, n);
  const L: string[] = [];
  if (v.knowledge && clip(v.knowledge.body, 1000)) L.push(`What this player knows (clues they found, what they worked out). Answer only from this, the party's shared pages and the library pages shown:\n${v.knowledge.body.slice(0, 2500)}`);
  if (v.goals.length) L.push(`This player's goals:\n${v.goals.map((g) => `- ${g.title} (${g.heat ?? 'ongoing'}): ${clip(g.body, 200)}`).join('\n').slice(0, 1500)}`);
  if (v.journal.length) L.push(`This player's recent journal:\n${v.journal.slice(-2).map((j) => `${j.title}: ${clip(j.body, 500)}`).join('\n').slice(0, 1500)}`);
  const terms = searchTerms(question);
  const score = (x: View) => terms.reduce((n, t) => n + (norm(`${x.title} ${x.body}`).includes(t) ? 1 : 0), 0);
  const relevant = [...v.party, ...v.others].map((x) => ({ x, s: score(x) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
  if (relevant.length) L.push(`Known to the whole party:\n${relevant.map((r) => `- ${r.x.title}: ${clip(r.x.body, 500)}`).join('\n')}`);
  return L.join('\n\n');
}

/** who_is for a player: the other players' characters and the party-level pages, by name. Never account ids. */
export function playerWhoIs(d: Deps, worldId: string, accountId: string, name: string) {
  const q = norm(name);
  const out: { type: string; name: string; page?: string }[] = [];
  if (!q) return out;
  for (const p of players(d, worldId)) if ([p.character, p.name].some((n) => n && norm(n) === q)) out.push({ type: p.accountId === accountId ? 'you' : 'player', name: p.character || p.name });
  for (const p of [...listPages(d, worldId, 'codex/'), ...listPages(d, worldId, 'chronicle/')]) {
    if (vaultLevel(p.fm) !== 'party') continue;
    if ([p.title, ...listOf(p.fm.aliases)].some((a) => norm(a) === q)) out.push({ type: 'known to the party', name: p.title, page: p.title });
  }
  return out;
}

// ---- writing (the caller's own root only) ------------------------------------------------

export interface Wrote { queued: boolean; draft?: string; note: string }

/** A player's write: a draft on the DM's list, or applied at once when the DM turned auto-approve on for that tool. */
function playerWrite(d: Deps, worldId: string, accountId: string, tool: string, kind: string, title: string, op: Op): Wrote {
  if (autoApproved(d, worldId, tool)) { applyOp(d, worldId, op, accountId); return { queued: false, note: 'Saved to your notes.' }; }
  const dr = createDraft(d, worldId, { kind, title, op, byAccount: accountId, tool });
  return { queued: true, draft: dr.id, note: 'Noted. It will be in your journal once the DM has looked it over.' };
}

const clip = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const needText = (s: unknown) => { const t = clip(s, 2000); if (!t) throw new HttpError(400, 'text is required'); return t; };
const about = (a: unknown) => { const t = clip(a, 80); return t ? ` (about ${t})` : ''; };

export function playerLog(d: Deps, worldId: string, accountId: string, a: { text: string; about?: string }): Wrote {
  const text = needText(a.text);
  const n = currentSession(d.db, worldId);
  const arc = openArc(d.db, worldId);
  return playerWrite(d, worldId, accountId, 'my_memory_log', 'journal', `Journal, session ${n}`, {
    op: 'section', rel: `${ownRoot(accountId)}journal/session-${n}.md`, section: 'Notes', mode: 'append', text: `- ${text}${about(a.about)}`, title: `Session ${n}`,
    fm: { type: 'journal', level: 'party', player: accountId, ...(arc ? { arc: arc.slug } : {}), tags: [] },
  });
}

export function playerCapture(d: Deps, worldId: string, accountId: string, a: { text: string; about?: string }): Wrote {
  const text = needText(a.text);
  return playerWrite(d, worldId, accountId, 'my_memory_capture', 'note', 'Quick note', {
    op: 'section', rel: `${ownRoot(accountId)}notes/inbox.md`, section: 'Inbox', mode: 'append', text: `- ${text}${about(a.about)}`, title: 'Inbox',
    fm: { type: 'note', level: 'party', player: accountId, tags: [] },
  });
}

/** A line the player lets the other players read ("Shared with the party"). Waits for the DM like every player write. */
export function playerShare(d: Deps, worldId: string, accountId: string, a: { text: string }): Wrote {
  const text = needText(a.text);
  return playerWrite(d, worldId, accountId, 'my_memory_capture', 'share', 'Shared with the party', {
    op: 'section', rel: `${ownRoot(accountId)}shared.md`, section: 'Shared', mode: 'append', text: `- ${text}`, title: 'Shared with the party',
    fm: { type: 'profile', level: 'party', player: accountId, tags: [] },
  });
}

export function goalOp(accountId: string, a: { goal: string; heat?: string; text?: string }, exists: boolean): Op {
  const name = fileName(clip(a.goal, 80));
  if (!clip(a.goal, 80)) throw new HttpError(400, 'goal is required');
  const rel = `${ownRoot(accountId)}goals/${name}.md`;
  const heat = a.heat === undefined || a.heat === '' ? undefined : String(a.heat);
  if (heat && !(HEATS as readonly string[]).includes(heat)) throw new HttpError(400, `heat must be one of ${HEATS.join(', ')}`);
  const text = clip(a.text, 2000);
  if (exists && !text && heat) return { op: 'heat', rel, heat: heat as any };
  if (!text && !heat && exists) throw new HttpError(400, 'Give a heat or some text');
  return {
    op: 'section', rel, section: 'Notes', mode: 'append', text: text ? `- ${new Date().toISOString().slice(0, 10)}: ${text}` : '', title: name,
    fm: { type: 'goal', level: 'party', player: accountId, heat: heat ?? 'ongoing', tags: [] },
  };
}

export function playerGoal(d: Deps, worldId: string, accountId: string, a: { goal: string; heat?: string; text?: string }): Wrote {
  const rel = `${ownRoot(accountId)}goals/${fileName(clip(a.goal, 80))}.md`;
  const op = goalOp(accountId, a, !!readPage(d, worldId, rel));
  return playerWrite(d, worldId, accountId, 'my_goal_update', 'goal', `Goal: ${clip(a.goal, 80)}`, op);
}

