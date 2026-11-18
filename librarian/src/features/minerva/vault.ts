// The memory vault: plain Markdown pages with front matter in the library under
// `Minerva/` (docs/MINERVA.md §2-§3). Everything that reads or writes a vault
// page goes through here.
//
// Levels. Every page has a vault level (front matter `level`): party, broker,
// dm or classified. In the library the page is stored at `dm` (party and dm),
// `broker` or `classified`, never `party`: a party-level vault page would show
// in the players' library with its path. Players read the party-level parts
// through the neutral routes in player.ts instead (secret blocks cut out by the
// library's own copy builder). Fails closed: anything unknown is dm.
import type { Deps } from '../../app.ts';
import { all, one } from '../../core/db.ts';
import { dumpYaml, joinFrontmatter, splitFrontmatter, type FM } from '../../core/frontmatter.ts';
import { pageLevel, type Level } from '../../core/levels.ts';
import { HttpError, parseJson } from '../../core/util.ts';

export const ROOT = 'Minerva';
export const STATUS_PATH = 'dm/state/Campaign Status.md';
export const STATUS_SECTIONS = ['Now', 'Active threads', 'NPC agendas', 'What changed last session', 'Next session', 'Open questions'] as const;
export const HEATS = ['on', 'ongoing', 'simmering', 'sleeping'] as const;
export type Heat = (typeof HEATS)[number];
export const TYPES = ['status', 'revelation', 'prep', 'hook', 'lore', 'arc', 'session', 'timeline', 'codex', 'profile', 'goal', 'journal', 'knowledge', 'bonds', 'note', 'home'] as const;
export const KINDS = ['npc', 'pc', 'place', 'region', 'organization', 'trade-route', 'family', 'creature', 'race', 'item', 'quest', 'map', 'topic'] as const;

/** Where each codex kind lives. */
export const CODEX_DIR: Record<string, string> = {
  npc: 'codex/characters/npc', pc: 'codex/characters/pc', place: 'codex/locations', region: 'codex/locations', organization: 'codex/organizations', 'trade-route': 'codex/organizations',
  family: 'codex/families', creature: 'codex/creatures', race: 'codex/races', item: 'codex/items', quest: 'codex/quests', map: 'codex/maps', topic: 'codex/lore',
};

const TOP: RegExp[] = [
  /^HOME\.md$/,
  /^dm\/state\/[^/]+\.md$/, /^dm\/(revelations|session-prep|hooks|hidden-lore|players)\/[^/]+\.md$/,
  /^chronicle\/(timeline|calendar)\.md$/, /^chronicle\/arcs\/[^/]+\/summary\.md$/, /^chronicle\/arcs\/[^/]+\/sessions\/[^/]+\.md$/,
  /^codex\/characters\/(pc|npc)\/[^/]+\.md$/, /^codex\/(locations|organizations|families|creatures|races|items|quests|maps|lore)\/[^/]+\.md$/,
  /^players\/[^/]+\/(profile|shared|knowledge|bonds)\.md$/, /^players\/[^/]+\/(goals|journal|notes)\/[^/]+\.md$/,
];

/** A vault path, checked: inside the layout, no tricks, no deeper than the layout goes. */
export function safeRel(rel: string): string {
  const parts = String(rel ?? '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter((x) => x && x !== '.');
  if (!parts.length || parts.length > 6 || parts.some((x) => x === '..' || /[\x00-\x1f]/.test(x) || x.startsWith('.') || x.length > 120)) throw new HttpError(400, 'Bad vault path');
  let out = parts.join('/');
  if (!out.toLowerCase().endsWith('.md')) out += '.md';
  if (!TOP.some((re) => re.test(out))) throw new HttpError(400, `Not a place in the vault: ${out}`);
  return out;
}

/** A name that is safe as a file name. */
export const fileName = (s: string): string => String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || 'Untitled';
export const slug = (s: string): string => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'x';
export const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/[’']/g, '').replace(/^(the|a|an)\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const today = (): string => new Date().toISOString().slice(0, 10);

export const libPath = (rel: string): string => `${ROOT}/${rel}`;
export const relOf = (path: string): string => path.slice(ROOT.length + 1);

export interface VaultPage { id: string; rel: string; title: string; fm: FM; body: string; level: Level; updatedAt: string }

const asLevel = (v: unknown): Level => (v === 'party' || v === 'broker' || v === 'dm' || v === 'classified' ? v : 'dm');

/** The vault level of a page: its front matter level, raised by tags. */
export function vaultLevel(fm: FM): Level {
  return pageLevel({ visibility: fm.level ?? 'dm', tags: fm.tags, frontmatter: { ...fm, tags: undefined } as any });
}
/** The level the library stores it at. */
export const storedLevel = (l: Level): 'dm' | 'broker' | 'classified' => (l === 'broker' ? 'broker' : l === 'classified' ? 'classified' : 'dm');

const rowOut = (r: any): VaultPage => {
  const fm = parseJson<FM>(r.frontmatter, {});
  return { id: r.id, rel: relOf(r.path), title: r.title, fm, body: r.body ?? '', level: vaultLevel(fm), updatedAt: r.updated_at };
};

export function readPage(d: Deps, worldId: string, rel: string): VaultPage | null {
  const r = one<any>(d.db, 'SELECT id, path, title, frontmatter, body, updated_at FROM pages WHERE world_id = ? AND path = ?', worldId, libPath(safeRel(rel)));
  return r ? rowOut(r) : null;
}

export function listPages(d: Deps, worldId: string, prefix = ''): VaultPage[] {
  const like = `${ROOT}/${prefix}`.replace(/[%_\\]/g, '\\$&') + '%';
  return all<any>(d.db, `SELECT id, path, title, frontmatter, body, updated_at FROM pages WHERE world_id = ? AND path LIKE ? ESCAPE '\\' ORDER BY path`, worldId, like).map(rowOut);
}

export interface WriteArgs { title?: string; fm?: FM; body?: string; by?: string | null; batch?: boolean }

/** Create or replace a page. Front matter is merged over what is there; `updated` is stamped; the level decides the stored level. */
export function writePage(d: Deps, worldId: string, rel: string, a: WriteArgs): VaultPage {
  const r = safeRel(rel);
  const cur = readPage(d, worldId, r);
  const fm: FM = { ...(cur?.fm ?? {}), ...(a.fm ?? {}) };
  if (!fm.type) fm.type = defaultType(r);
  if (!fm.level) fm.level = defaultLevel(r, String(fm.type));
  fm.status = 'approved';
  fm.updated = today();
  const heading = /^#\s+(.+)$/m.exec(a.body ?? '')?.[1]?.trim();
  const title = (a.title ?? heading ?? cur?.title ?? r.split('/').pop()!.replace(/\.md$/i, '')).slice(0, 200);
  const body = a.body ?? cur?.body ?? '';
  const level = vaultLevel(fm);
  // Saved in batch mode and rebuilt for this one page: a vault page is never linked from the rest of the library, so no other page's copy changes.
  d.library.save(worldId, { path: libPath(r), title, body, frontmatter: fm, visibility: storedLevel(level) }, a.by ?? null, { batch: true });
  const row = one<any>(d.db, 'SELECT id, path, title, frontmatter, body, updated_at FROM pages WHERE world_id = ? AND path = ?', worldId, libPath(r))!;
  if (!a.batch) d.library.rebuildPlayerCopies(worldId, [row.id]);
  return rowOut(row);
}

export function removePage(d: Deps, worldId: string, rel: string) {
  const row = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND path = ?', worldId, libPath(safeRel(rel)));
  if (row) d.library.remove(worldId, row.id);
}

function defaultType(rel: string): string {
  if (rel === 'HOME.md') return 'home';
  if (rel.startsWith('dm/state/')) return 'status';
  if (rel.startsWith('dm/revelations/')) return 'revelation';
  if (rel.startsWith('dm/session-prep/')) return 'prep';
  if (rel.startsWith('dm/hooks/')) return 'hook';
  if (rel.startsWith('dm/hidden-lore/')) return 'lore';
  if (rel.startsWith('dm/players/')) return 'note';
  if (/\/summary\.md$/.test(rel)) return 'arc';
  if (/\/sessions\//.test(rel)) return 'session';
  if (rel === 'chronicle/timeline.md' || rel === 'chronicle/calendar.md') return 'timeline';
  if (rel.startsWith('codex/')) return 'codex';
  if (rel.endsWith('/profile.md') || rel.endsWith('/shared.md')) return 'profile';
  if (rel.endsWith('/knowledge.md')) return 'knowledge';
  if (rel.endsWith('/bonds.md')) return 'bonds';
  if (rel.includes('/goals/')) return 'goal';
  if (rel.includes('/journal/')) return 'journal';
  return 'note';
}

/** What a new page is at when nobody said: dm/ is dm; a player's own pages and their session records are party; the rest fail closed to dm until the DM opens them. */
function defaultLevel(rel: string, type: string): Level {
  if (rel.startsWith('players/')) return 'party';
  if (rel.startsWith('chronicle/') && (type === 'session' || type === 'arc')) return 'party';
  if (rel.startsWith('codex/characters/pc/')) return 'party';
  return 'dm';
}

// ---- Markdown helpers ---------------------------------------------------------

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `## Heading` section: its start, the end of its text and the text. */
export function sectionOf(body: string, heading: string): { start: number; end: number; text: string } | null {
  const re = new RegExp(`^##[ \\t]+${escRe(heading)}[ \\t]*$`, 'im');
  const m = re.exec(body);
  if (!m) return null;
  const from = m.index + m[0].length;
  const next = /^##[ \t]+\S/m.exec(body.slice(from));
  const end = next ? from + next.index : body.length;
  return { start: m.index, end, text: body.slice(from, end).replace(/^\r?\n/, '').replace(/\s+$/, '') };
}

/** Replace a section's text (or add it at the end). */
export function setSection(body: string, heading: string, text: string): string {
  const s = sectionOf(body, heading);
  const block = `## ${heading}\n${text.trim() ? `${text.trim()}\n` : ''}\n`;
  if (!s) return `${body.replace(/\s+$/, '')}\n\n${block}`;
  return `${body.slice(0, s.start)}${block}${body.slice(s.end)}`.replace(/\n{3,}/g, '\n\n');
}

export const THREADS_SECTION = 'Active threads';

/**
 * Apply heat changes to the "Active threads" lines. Only the `[heat]` token of a
 * line changes; its link and description stay. Threads not listed yet are added.
 */
export function mergeThreads(text: string, items: { title: string; heat: string }[]): string {
  const lines = text.split('\n');
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^(\s*[-*]\s+)(?:\[([a-z]+)\]\s*)?(\[\[([^\]|]+)(?:\|[^\]]*)?\]\])(.*)$/i.exec(line);
    if (!m) return line;
    const it = items.find((i) => norm(i.title) === norm(m[4]!));
    if (!it) return line;
    seen.add(norm(it.title));
    return `${m[1]}[${it.heat}] ${m[3]}${m[5]}`;
  });
  const added = items.filter((i) => !seen.has(norm(i.title))).map((i) => `- [${i.heat}] [[${i.title}]]`);
  const hasThread = out.some((l) => /^\s*[-*]\s/.test(l)) || added.length > 0;
  const kept = hasThread ? out.filter((l) => !/^_.*_$/.test(l.trim())) : out;
  return [...kept, ...added].join('\n').trim();
}

/** Add lines at the end of a section (or add the section). */
export function appendToSection(body: string, heading: string, text: string): string {
  const s = sectionOf(body, heading);
  return setSection(body, heading, s && s.text && !/^_.*_$/.test(s.text.trim()) ? `${s.text}\n${text.trim()}` : text);
}

/** A secret block for a note only the DM may read. */
export const secretBlock = (text: string): string => `> [!secret]\n${text.trim().split('\n').map((l) => `> ${l}`).join('\n')}`;

/** The vault page as an Obsidian file. */
export const toMarkdown = (p: { fm: FM; body: string }): string => joinFrontmatter(p.fm, p.body);
export const fromMarkdown = (md: string): { fm: FM; body: string } => splitFrontmatter(md);
export { dumpYaml };

/** Front matter lists, as plain strings. */
export const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : []);

// ---- the world's people ---------------------------------------------------------

export interface PlayerRef { accountId: string; name: string; character: string }

/** The players of a world: account, display name and the character they play. */
export function players(d: Deps, worldId: string): PlayerRef[] {
  return all<any>(d.db, `SELECT a.id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player' ORDER BY a.display_name`, worldId)
    .map((r) => ({ accountId: r.id as string, name: String(r.display_name ?? ''), character: String(r.character_name ?? '') }));
}
