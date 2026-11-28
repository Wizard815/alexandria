// Turning Minerva on: the vault's first pages (docs/MINERVA.md §2), and keeping
// one root per player as players join.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import { getClock } from '../clock/api.ts';
import { rebuildKnowledge } from './revelations.ts';
import { audit, listArcs, openArc, setEnabled } from './store.ts';
import { STATUS_PATH, STATUS_SECTIONS, listPages, players, readPage, sectionOf, today, writePage, type PlayerRef } from './vault.ts';

const STATUS_HINTS: Record<string, string> = {
  Now: '_Where the party is, what day it is, what is pressing._',
  'Active threads': '_One line each, with its heat: on, ongoing, simmering or sleeping._',
  'NPC agendas': '_What each important NPC wants this week._',
  'What changed last session': '_Filled in after each session._',
  'Next session': '_Strong start, scenes, secrets and clues to drop._',
  'Open questions': '_Things to decide or ask the table._',
};

export const statusBody = (): string => `# Campaign Status\n\n${STATUS_SECTIONS.map((s) => `## ${s}\n${STATUS_HINTS[s]}\n`).join('\n')}`;

/** A player's root: profile, shared page, bonds, knowledge, and the GM's own note on them. Existing pages are left as they are. */
export function ensurePlayer(d: Deps, worldId: string, p: PlayerRef, by: string | null) {
  const who = p.character || p.name;
  const root = `players/${p.accountId}`;
  const make = (rel: string, title: string, fm: Record<string, any>, body: string) => {
    if (!readPage(d, worldId, rel)) writePage(d, worldId, rel, { title, fm: { player: p.accountId, ...fm }, body, by, batch: true });
  };
  make(`${root}/profile.md`, `${who}: profile`, { type: 'profile', level: 'party', tags: [] }, `# ${who}\n\nPlayed by ${p.name}.\n\n## Who they are\n_The character in a few lines._\n\n## What they want\n_See the goals folder._\n`);
  make(`${root}/shared.md`, 'Shared with the party', { type: 'profile', level: 'party', tags: [] }, `# Shared with the party\n\nWhat ${who} lets the other players know.\n\n## Shared\n`);
  make(`${root}/bonds.md`, `${who}: bonds`, { type: 'bonds', level: 'party', tags: [] }, `# Bonds\n\nPeople, places and factions ${who} cares about.\n`);
  make('gm/players/' + p.accountId + '.md', `${who}: the GM's notes`, { type: 'note', level: 'gm', tags: [] }, `# ${who} (${p.name})\n\n## What they enjoy\n\n## What they are after\n\n## Hooks aimed at them\n\n## Table notes\n`);
  make(`codex/characters/pc/${who.replace(/[\\/:*?"<>|]/g, ' ').trim()}.md`, who, { type: 'codex', kind: 'pc', level: 'party', aliases: p.name && p.name !== who ? [p.name] : [], tags: [], sources: [] }, `# ${who}\n\nPlayed by ${p.name}.\n\n## Appearances\n\n## What changed\n\n## Secrets\n`);
  if (!readPage(d, worldId, `${root}/knowledge.md`)) rebuildKnowledge(d, worldId, p.accountId, by);
}

export function ensurePlayers(d: Deps, worldId: string, by: string | null) {
  const ps = players(d, worldId);
  const ids: string[] = [];
  for (const p of ps) { ensurePlayer(d, worldId, p, by); ids.push(p.accountId); }
  const rows = all<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND path LIKE 'Minerva/%'`, worldId).map((r) => r.id as string);
  d.library.rebuildPlayerCopies(worldId, rows);
}

/** The dashboard: status, active arc, open threads, review queue. Rewritten whenever those change. */
export function refreshHome(d: Deps, worldId: string, by: string | null = null) {
  const arc = openArc(d.db, worldId);
  const pending = one<any>(d.db, `SELECT COUNT(*) AS n FROM minerva_drafts WHERE world_id = ? AND status = 'pending'`, worldId)?.n ?? 0;
  const status = readPage(d, worldId, STATUS_PATH);
  const threads = status ? sectionOf(status.body, 'Active threads')?.text ?? '' : '';
  const hooks = listPages(d, worldId, 'gm/hooks/').filter((h) => String(h.fm.heat ?? 'ongoing') !== 'sleeping');
  const lines = [
    '# Minerva',
    '',
    `Updated ${today()}. World date: ${(() => { try { return getClock(d.db, worldId).label; } catch { return 'unknown'; } })()}.`,
    '',
    '## Status',
    '[[Campaign Status]] is the living doc. Read it before every session.',
    '',
    '## Active arc',
    arc ? `${arc.n}. ${arc.title} (since ${arc.openedAt.slice(0, 10)})` : '_No arc is open. Start one._',
    '',
    '## Open threads',
    threads && !/^_.*_$/.test(threads.trim()) ? threads : hooks.length ? hooks.map((h) => `- [${h.fm.heat ?? 'ongoing'}] [[${h.title}]]`).join('\n') : '_None yet._',
    '',
    '## Review queue',
    pending ? `${pending} change${pending === 1 ? '' : 's'} waiting for the GM.` : 'Nothing waiting.',
    '',
    '## Arcs',
    listArcs(d.db, worldId).map((a) => `- ${a.n}. ${a.title} (${a.status})`).join('\n') || '_None._',
    '',
  ];
  writePage(d, worldId, 'HOME.md', { title: 'Minerva', fm: { type: 'home', level: 'gm', tags: [] }, body: lines.join('\n'), by });
}

/** Seed the vault (idempotent) and switch her on. */
export function enable(d: Deps, worldId: string, by: string | null) {
  setEnabled(d.db, worldId, true);
  if (!readPage(d, worldId, STATUS_PATH)) writePage(d, worldId, STATUS_PATH, { title: 'Campaign Status', fm: { type: 'status', level: 'gm', tags: ['status'] }, body: statusBody(), by, batch: true });
  if (!readPage(d, worldId, 'chronicle/timeline.md')) writePage(d, worldId, 'chronicle/timeline.md', { title: 'Timeline', fm: { type: 'timeline', level: 'party', tags: [] }, body: '# Timeline\n\nIn-world history: eras and events. The world clock and the library\'s timelines hold the dates; this page links to them.\n', by, batch: true });
  refreshCalendar(d, worldId, by);
  ensurePlayers(d, worldId, by);
  refreshHome(d, worldId, by);
  audit(d, worldId, by, 'minerva.enable', 'vault seeded');
}

/** chronicle/calendar.md: an index of the sessions calendar and the world date (links, not copies). */
export function refreshCalendar(d: Deps, worldId: string, by: string | null) {
  const sessions = all<any>(d.db, `SELECT title, starts_at FROM cal_sessions WHERE world_id = ? AND status = 'scheduled' ORDER BY starts_at DESC LIMIT 12`, worldId);
  let date = 'unknown';
  try { date = getClock(d.db, worldId).label; } catch { /* no clock */ }
  writePage(d, worldId, 'chronicle/calendar.md', {
    title: 'Calendar', fm: { type: 'timeline', level: 'party', tags: [] },
    body: `# Calendar\n\nWorld date: ${date}.\n\n## Game nights\n${sessions.length ? sessions.map((s) => `- ${s.starts_at.slice(0, 10)}: ${s.title}`).join('\n') : '_None scheduled._'}\n`, by, batch: true,
  });
}
