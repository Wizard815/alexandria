// context_for(who): everything Minerva knows about a player, an NPC, a place or
// an arc, in the retrieval order of docs/MINERVA.md §6. Text is the library's
// AI copy: classified pages and blocks are never in it.
import type { Deps } from '../../app.ts';
import type { Viewer } from '../../core/policy.ts';
import { whoIs, findCodex } from './codex.ts';
import { findMystery } from './revelations.ts';
import { one } from '../../core/db.ts';
import { findArc, openArc, listArcs, currentSession, stateOf } from './store.ts';
import { STATUS_PATH, listPages, readPage, sectionOf, type VaultPage } from './vault.ts';

const AI: Viewer = { accountId: '', role: 'dm', audience: 'ai' } as Viewer;

/** A vault page as a model may read it (null when it is classified or gone). */
export function forAi(d: Deps, worldId: string, p: VaultPage | null): string | null {
  if (!p) return null;
  try { return String((d.library.get(worldId, p.id, AI) as any).body ?? '').trim(); } catch { return null; }
}

export interface Section { title: string; text: string }
export interface Context { who: string; kind: string; title: string; sections: Section[]; found: boolean }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

export function contextFor(d: Deps, worldId: string, who: string): Context {
  const q = String(who ?? '').trim();
  const sections: Section[] = [];
  const add = (title: string, text: string | null, max = 3000) => { if (text && text.trim()) sections.push({ title, text: clip(text.trim(), max) }); };
  const status = readPage(d, worldId, STATUS_PATH);
  const arc = (q && findArc(d.db, worldId, q)) || null;

  // A person at the table.
  const match = q ? whoIs(d, worldId, q, { partial: false }) : [];
  const player = match.find((m) => m.type === 'player');
  if (player?.accountId) {
    const root = `players/${player.accountId}/`;
    const pg = (rel: string) => readPage(d, worldId, `${root}${rel}`);
    add('Profile', forAi(d, worldId, pg('profile.md')));
    add('Knowledge', forAi(d, worldId, pg('knowledge.md')));
    add('Goals', listPages(d, worldId, `${root}goals/`).map((g) => `### ${g.title} (${g.fm.heat ?? 'ongoing'})\n${forAi(d, worldId, g) ?? ''}`).join('\n\n'));
    add('Bonds', forAi(d, worldId, pg('bonds.md')));
    add('Shared with the party', forAi(d, worldId, pg('shared.md')), 1200);
    add('Recent journal', listPages(d, worldId, `${root}journal/`).sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true })).slice(-2).map((j) => forAi(d, worldId, j) ?? '').join('\n\n'), 2500);
    add('The DM\'s notes on them', forAi(d, worldId, readPage(d, worldId, `dm/players/${player.accountId}.md`)));
    if (player.codex) add('Codex', forAi(d, worldId, readPage(d, worldId, player.codex)), 2000);
    return { who: q, kind: 'player', title: player.character || player.name, sections, found: true };
  }
  // An arc.
  if (arc) {
    add('Arc summary', forAi(d, worldId, readPage(d, worldId, `chronicle/arcs/${arc.slug}/summary.md`)));
    add('Sessions', listPages(d, worldId, `chronicle/arcs/${arc.slug}/sessions/`).map((s) => `- ${s.title}`).join('\n'));
    return { who: q, kind: 'arc', title: arc.title, sections, found: true };
  }
  // A codex page, or a mystery.
  const codex = q ? findCodex(d, worldId, { name: q }) : null;
  if (codex) {
    add('Codex', forAi(d, worldId, codex));
    const lib = match.find((m) => m.type === 'library');
    if (lib) add('In the library', `${lib.name} (${lib.path}); page id ${lib.entity}. Read it with read_page.`, 300);
    return { who: q, kind: String(codex.fm.kind ?? 'codex'), title: codex.title, sections, found: true };
  }
  try {
    const m = findMystery(d, worldId, q);
    add('Revelation', forAi(d, worldId, readPage(d, worldId, `dm/revelations/${m.slug}.md`)));
    return { who: q, kind: 'revelation', title: m.title, sections, found: true };
  } catch { /* not a mystery */ }
  const lib = match.find((m) => m.type === 'library');
  if (lib) { add('In the library', `${lib.name} (${lib.path}); page id ${lib.entity}. No codex page yet; promote them if they matter.`, 400); return { who: q, kind: 'library', title: lib.name, sections, found: true }; }

  // Nothing named (or nothing found): the campaign now, in retrieval order.
  const open = openArc(d.db, worldId);
  add('Campaign Status', status ? forAi(d, worldId, status) : null, 5000);
  if (open) {
    add('Active arc', `${open.n}. ${open.title}`, 200);
    add('Arc summary', forAi(d, worldId, readPage(d, worldId, `chronicle/arcs/${open.slug}/summary.md`)));
    const last = listPages(d, worldId, `chronicle/arcs/${open.slug}/sessions/`).sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true })).at(-1);
    add('Last session', forAi(d, worldId, last ?? null), 2500);
  } else if (listArcs(d.db, worldId).length) add('Arcs', listArcs(d.db, worldId).map((a) => `- ${a.n}. ${a.title} (${a.status})`).join('\n'), 800);
  add('Session in progress', `Session ${currentSession(d.db, worldId)}`, 100);
  return { who: q, kind: 'campaign', title: 'The campaign now', sections, found: !q || sections.length > 0 };
}

export const threadsOf = (d: Deps, worldId: string): { title: string; rel: string; heat: string; kind: 'hook' | 'goal'; owner?: string }[] => {
  const out: { title: string; rel: string; heat: string; kind: 'hook' | 'goal'; owner?: string }[] = [];
  for (const h of listPages(d, worldId, 'dm/hooks/')) out.push({ title: h.title, rel: h.rel, heat: String(h.fm.heat ?? 'ongoing'), kind: 'hook' });
  for (const g of listPages(d, worldId, 'players/').filter((p) => p.fm.type === 'goal')) out.push({ title: g.title, rel: g.rel, heat: String(g.fm.heat ?? 'ongoing'), kind: 'goal', owner: String(g.fm.player ?? '') });
  const rank: Record<string, number> = { on: 0, ongoing: 1, simmering: 2, sleeping: 3 };
  return out.sort((a, b) => (rank[a.heat] ?? 9) - (rank[b.heat] ?? 9) || a.title.localeCompare(b.title));
};

/** A short block for the DM harness's per-message context: the status doc's top, so the campaign is read before anything else. Empty when Minerva is off. */
export function minervaBrief(d: Deps, worldId: string): string {
  try { if (!stateOf(d.db, worldId).enabled) return ''; } catch { return ''; }
  const status = readPage(d, worldId, STATUS_PATH);
  const body = forAi(d, worldId, status);
  if (!body) return '';
  const pick = (h: string) => { const t = sectionOf(body, h)?.text ?? ''; return /^_.*_$/.test(t.trim()) ? '' : t; };
  const arc = openArc(d.db, worldId);
  const pending = one<any>(d.db, `SELECT COUNT(*) AS n FROM minerva_drafts WHERE world_id = ? AND status = 'pending'`, worldId)?.n ?? 0;
  const parts = [`Campaign status (the living doc; context_for has all of it)${arc ? `, arc: ${arc.title}` : ''}:`, pick('Now') && `Now: ${pick('Now')}`, pick('Active threads') && `Active threads:\n${pick('Active threads')}`, pick('Next session') && `Next session:\n${pick('Next session').slice(0, 600)}`, pick('Last session') && `Last session (approved hand-off):\n${pick('Last session').slice(0, 2600)}`, pending ? `${pending} drafts wait on the DM's review page.` : ''].filter(Boolean);
  return parts.length > 1 ? parts.join('\n').slice(0, 4200) : '';
}

/**
 * For a prep request: the whole Campaign Status, the active arc's summary and the last session page, as the model may read them,
 * so the first model round has what it would otherwise search for.
 */
export function minervaPrep(d: Deps, worldId: string): string {
  try { if (!stateOf(d.db, worldId).enabled) return ''; } catch { return ''; }
  try {
    const c = contextFor(d, worldId, '');
    const parts = c.sections.filter((x) => ['Campaign Status', 'Active arc', 'Arc summary', 'Last session'].includes(x.title)).map((x) => `## ${x.title}\n${x.text}`);
    return parts.length ? `Prefetched for prep (the campaign status, the active arc and the last session; no need to search for them):\n${parts.join('\n\n')}`.slice(0, 9000) : '';
  } catch { return ''; }
}
