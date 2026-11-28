// The codex: one page per entity that matters, which then ACCRETES and is
// never re-created (docs/MINERVA.md §4.1-§4.2). who_is finds the page again
// (by entity, name, alias, player, mic speaker); codex_upsert adds to it;
// promotion candidates are computed from the session pages, the status doc,
// hooks, revelations and bonds.
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { HttpError } from '../../core/util.ts';
import {
  CODEX_DIR, KINDS, STATUS_PATH, vaultLevel, appendToSection, fileName, listOf, listPages, norm, players, readPage, secretBlock, sectionOf, today, writePage, type VaultPage,
} from './vault.ts';

export interface Match {
  type: 'player' | 'codex' | 'library';
  name: string;
  via: string;
  accountId?: string;
  character?: string;
  /** Codex page (vault path). */
  codex?: string;
  /** Library page id (the source of truth for the entity itself). */
  entity?: string;
  path?: string;
  kind?: string;
}

interface LibRow { id: string; title: string; path: string; aliases: string; kind: string | null; visibility: string }

/** Library pages by name, never the vault's own and never classified. */
export function libraryByName(d: Deps, worldId: string, q: string, partial: boolean): LibRow[] {
  const rows = all<LibRow>(d.db, `SELECT id, title, path, aliases, kind, visibility FROM pages WHERE world_id = ? AND path NOT LIKE 'Minerva/%' AND visibility <> 'classified'`, worldId);
  const n = norm(q);
  if (!n) return [];
  const exact = rows.filter((r) => norm(r.title) === n || listOf(safeJson(r.aliases)).some((a) => norm(a) === n));
  if (exact.length || !partial) return exact;
  return rows.filter((r) => norm(r.title).includes(n) || n.includes(norm(r.title)) && norm(r.title).length >= 4).slice(0, 5);
}
const safeJson = (s: string): unknown => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export function codexPages(d: Deps, worldId: string): VaultPage[] { return listPages(d, worldId, 'codex/'); }

const codexNames = (p: VaultPage): string[] => [p.title, ...listOf(p.fm.aliases)];

/** The codex page for an entity, found by library page id, name or alias. */
export function findCodex(d: Deps, worldId: string, ref: { entity?: string; name?: string }, pages = codexPages(d, worldId)): VaultPage | null {
  if (ref.entity) { const hit = pages.find((p) => String(p.fm.entity ?? '') === ref.entity); if (hit) return hit; }
  const names = [ref.name, ref.entity].filter(Boolean).map((x) => norm(String(x)));
  for (const q of names) { const hit = pages.find((p) => codexNames(p).some((a) => norm(a) === q)); if (hit) return hit; }
  // A library page by that name may already have its codex page under another name.
  for (const nm of [ref.name, ref.entity]) {
    if (!nm) continue;
    for (const row of libraryByName(d, worldId, String(nm), false)) { const hit = pages.find((p) => String(p.fm.entity ?? '') === row.id); if (hit) return hit; }
  }
  return null;
}

/** Name, alias, character, player or mic speaker: where is this? */
export function whoIs(d: Deps, worldId: string, name: string, opts: { partial?: boolean } = {}): Match[] {
  const q = norm(name);
  if (!q) return [];
  const out: Match[] = [];
  const pages = codexPages(d, worldId);
  for (const p of pages) if (codexNames(p).some((a) => norm(a) === q)) out.push({ type: 'codex', name: p.title, via: norm(p.title) === q ? 'title' : 'alias', codex: p.rel, entity: String(p.fm.entity ?? '') || undefined, kind: String(p.fm.kind ?? '') || undefined });
  const ps = players(d, worldId);
  for (const p of ps) {
    const via = norm(p.character) === q ? 'character' : norm(p.name) === q ? 'player' : norm(p.character).split(' ')[0] === q || norm(p.name).split(' ')[0] === q ? 'first name' : '';
    if (via) out.push({ type: 'player', name: p.character || p.name, via, accountId: p.accountId, character: p.character, codex: pages.find((c) => String(c.fm.kind) === 'pc' && (norm(c.title) === norm(p.character) || String(c.fm.player ?? '') === p.accountId))?.rel });
  }
  // A mic named for a person, or a speaker label the transcript carries.
  const mics = all<any>(d.db, 'SELECT account_id, label FROM audio_mics WHERE world_id = ?', worldId);
  for (const m of mics) if (norm(m.label) === q && !out.some((o) => o.accountId === m.account_id)) { const pl = ps.find((x) => x.accountId === m.account_id); if (pl) out.push({ type: 'player', name: pl.character || pl.name, via: 'mic', accountId: pl.accountId, character: pl.character }); }
  const labels = all<any>(d.db, `SELECT DISTINCT speaker_label, speaker_account FROM audio_lines WHERE world_id = ? AND speaker_label <> ''`, worldId);
  for (const l of labels) if (norm(l.speaker_label) === q && l.speaker_account && !out.some((o) => o.accountId === l.speaker_account)) { const pl = ps.find((x) => x.accountId === l.speaker_account); if (pl) out.push({ type: 'player', name: pl.character || pl.name, via: 'speaker', accountId: pl.accountId, character: pl.character }); }
  for (const r of libraryByName(d, worldId, name, opts.partial !== false)) {
    if (out.some((o) => o.entity === r.id)) continue;
    out.push({ type: 'library', name: r.title, via: norm(r.title) === q ? 'title' : 'name', entity: r.id, path: r.path, kind: r.kind ?? undefined });
  }
  // A codex page may also be found through its library page, whatever the name that was asked.
  return out;
}

// ---- codex_upsert -------------------------------------------------------------

const SECTION_NAMES: Record<string, string> = {
  appearances: 'Appearances', appearance: 'Appearances', changed: 'What changed', change: 'What changed', 'what changed': 'What changed', secret: 'Secrets', secrets: 'Secrets',
  ties: 'Ties to players', 'ties to players': 'Ties to players', notes: 'Notes', note: 'Notes', agenda: 'Agenda',
};
export const sectionName = (s: string): string => SECTION_NAMES[String(s ?? '').trim().toLowerCase()] ?? (String(s ?? '').trim().replace(/[#\n]/g, ' ').slice(0, 60) || 'Notes');

const KIND_OF_LIBRARY = (k: string | null): string => {
  const s = String(k ?? '').toLowerCase();
  if (/locat|place|city|town|region/.test(s)) return /region/.test(s) ? 'region' : 'place';
  if (/org|faction|guild/.test(s)) return 'organization';
  if (/family|house/.test(s)) return 'family';
  if (/creature|monster/.test(s)) return 'creature';
  if (/race|species/.test(s)) return 'race';
  if (/item|object/.test(s)) return 'item';
  if (/quest/.test(s)) return 'quest';
  if (/map/.test(s)) return 'map';
  return 'npc';
};

export interface UpsertArgs { entity?: string; name?: string; kind?: string; section: string; text: string; session?: number | null; by?: string | null; level?: string; /** The text is for players to read. Without it, on a page players can open, it is written in a secret block. */ visible?: boolean }
export interface UpsertResult { rel: string; created: boolean; title: string; entity?: string; /** Who can read what was written. */ visibleToPlayers?: boolean; level?: string }

/** Add to an entity's codex page; make the page only when none exists. */
export function codexUpsert(d: Deps, worldId: string, a: UpsertArgs): UpsertResult {
  const text = String(a.text ?? '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  const name = String(a.name ?? '').trim();
  const entityArg = String(a.entity ?? '').trim();
  if (!name && !entityArg) throw new HttpError(400, 'Say which entity: a library page id or a name');
  const pages = codexPages(d, worldId);
  let page = findCodex(d, worldId, { entity: entityArg || undefined, name: name || entityArg }, pages);
  const section = sectionName(a.section || 'notes');
  const linkSession = a.session ? ` ([[session-${a.session}]])` : '';
  const plain = section === 'Appearances' || section === 'What changed' ? `- ${today()}: ${text}${linkSession}` : `- ${text}`;
  // What Minerva writes is her own analysis (hooks, plans, what an NPC wants). On a page players can open it goes in a secret block,
  // which the players' copy of the page leaves out, unless the GM said it is for them to read.
  const lineFor = (level: string) => (section === 'Secrets' || (level === 'party' && a.visible !== true) ? secretBlock(section === 'Secrets' ? text : plain.replace(/^-\s+/, '')) : plain);
  if (page) {
    const level = vaultLevel(page.fm);
    const line = lineFor(level);
    const body = appendToSection(page.body, section, line);
    writePage(d, worldId, page.rel, { body, by: a.by });
    return { rel: page.rel, created: false, title: page.title, entity: String(page.fm.entity ?? '') || undefined, level, visibleToPlayers: level === 'party' && !line.startsWith('> [!secret]') };
  }
  // No page: it is made from what the library knows of the entity, never copying its text.
  const lib = entityArg
    ? all<LibRow>(d.db, `SELECT id, title, path, aliases, kind, visibility FROM pages WHERE world_id = ? AND id = ? AND path NOT LIKE 'Minerva/%' AND visibility <> 'classified'`, worldId, entityArg)[0]
    : libraryByName(d, worldId, name, false)[0];
  const pcs = players(d, worldId).find((p) => norm(p.character) === norm(name || lib?.title || ''));
  const title = (name || lib?.title || entityArg).slice(0, 120);
  const kind = pcs ? 'pc' : (KINDS as readonly string[]).includes(String(a.kind)) ? String(a.kind) : KIND_OF_LIBRARY(lib?.kind ?? null);
  const rel = `${CODEX_DIR[kind]}/${fileName(title)}.md`;
  const existing = readPage(d, worldId, rel);
  if (existing) {
    const level = vaultLevel(existing.fm);
    const line = lineFor(level);
    writePage(d, worldId, rel, { body: appendToSection(existing.body, section, line), by: a.by });
    return { rel, created: false, title: existing.title, level, visibleToPlayers: level === 'party' && !line.startsWith('> [!secret]') };
  }
  const head = lib ? `Library: [[${lib.title}]]\n\n` : '';
  const body = `# ${title}\n\n${head}${['Appearances', 'What changed', 'Ties to players', 'Secrets'].filter((s) => s !== section).map((s) => `## ${s}\n`).join('\n')}\n`;
  const lvl = ['party', 'broker', 'gm', 'classified'].includes(String(a.level)) ? String(a.level) : kind === 'pc' ? 'party' : 'gm';
  const line = lineFor(lvl);
  const withSection = appendToSection(body, section, line);
  writePage(d, worldId, rel, {
    title,
    fm: { type: 'codex', kind, level: lvl, ...(lib ? { entity: lib.id } : {}), ...(pcs ? { player: pcs.accountId } : {}), aliases: [], tags: [], sources: [] },
    body: withSection, by: a.by,
  });
  return { rel, created: true, title, entity: lib?.id, level: lvl, visibleToPlayers: lvl === 'party' && !line.startsWith('> [!secret]') };
}

// ---- promotion ------------------------------------------------------------------

export interface Candidate { name: string; kind: string; sessions: number; reasons: string[]; entity?: string; score: number }

const nameRe = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

/** Names that look like people in a block of bullets: "- Name", "- **Name**: ...", "- Name, the baker". */
export function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*[-*]\s+\**([A-Z][\p{L}'’-]+(?:\s+(?:[A-Z][\p{L}'’-]+|of|the|de|van|von))*)/u.exec(raw);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export function promotionCandidates(d: Deps, worldId: string): Candidate[] {
  const sessions = listPages(d, worldId, 'chronicle/arcs/').filter((p) => p.fm.type === 'session');
  const status = readPage(d, worldId, STATUS_PATH);
  const hooks = listPages(d, worldId, 'gm/hooks/').filter((p) => String(p.fm.heat ?? 'ongoing') !== 'sleeping');
  const revs = listPages(d, worldId, 'gm/revelations/');
  const bonds = listPages(d, worldId, 'players/').filter((p) => p.rel.endsWith('/bonds.md'));
  const names = new Map<string, string>();
  const add = (n: string) => { const k = norm(n); if (k.length >= 3 && !names.has(k)) names.set(k, n.trim()); };
  for (const s of sessions) { const sec = sectionOf(s.body, 'People met'); if (sec) namesIn(sec.text).forEach(add); }
  if (status) { const sec = sectionOf(status.body, 'NPC agendas'); if (sec) namesIn(sec.text).forEach(add); }
  for (const r of all<any>(d.db, 'SELECT name FROM people WHERE world_id = ?', worldId)) add(r.name);
  const pcNames = new Set(players(d, worldId).flatMap((p) => [norm(p.character), norm(p.name)]));
  const pages = codexPages(d, worldId);
  const out: Candidate[] = [];
  for (const [k, nm] of names) {
    if (pcNames.has(k) || findCodex(d, worldId, { name: nm }, pages)) continue;
    const re = nameRe(nm);
    const seen = sessions.filter((s) => re.test(s.body)).length;
    const reasons: string[] = [];
    if (seen >= 3) reasons.push(`seen in ${seen} sessions`);
    if (status && re.test(sectionOf(status.body, 'Active threads')?.text ?? '')) reasons.push('in an active thread');
    else if (hooks.some((h) => re.test(h.body))) reasons.push('tied to a hook');
    if (revs.some((r) => re.test(r.body))) reasons.push('in a revelation');
    if (bonds.some((b) => re.test(b.body))) reasons.push('a player bonded to them');
    if (!reasons.length) continue;
    const lib = libraryByName(d, worldId, nm, false)[0];
    out.push({ name: nm, kind: KIND_OF_LIBRARY(lib?.kind ?? null), sessions: seen, reasons, entity: lib?.id, score: seen + reasons.length * 2 });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** The lines of the session pages that name an entity, for a new codex page. Returns bullets with session links. */
export function mentionsOf(d: Deps, worldId: string, name: string, max = 12): string[] {
  const re = nameRe(name);
  const out: string[] = [];
  const sessions = listPages(d, worldId, 'chronicle/arcs/').filter((p) => p.fm.type === 'session').sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
  for (const s of sessions) {
    const n = /session-(\d+)/.exec(s.rel)?.[1] ?? '';
    for (const l of s.body.split('\n')) {
      if (l.startsWith('>')) continue; // GM notes stay in the session page
      if (re.test(l) && l.trim().length > name.length + 2) out.push(`- ${String(s.fm.updated ?? '')}: ${l.replace(/^\s*[-*]\s+/, '').trim().slice(0, 240)} ([[session-${n}]])`);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export interface PromoteOp { rel: string; title: string; fm: Record<string, any>; body: string }
/** The page a promotion would make: from the mentions, linking the library page (never copying it). */
export function promotionDraft(d: Deps, worldId: string, name: string, kind?: string): PromoteOp {
  const pages = codexPages(d, worldId);
  const have = findCodex(d, worldId, { name }, pages);
  if (have) throw new HttpError(409, `${have.title} already has a codex page (${have.rel}); add to it with codex_upsert`);
  const lib = libraryByName(d, worldId, name, false)[0];
  const k = (KINDS as readonly string[]).includes(String(kind)) ? String(kind) : KIND_OF_LIBRARY(lib?.kind ?? null);
  const title = (lib?.title ?? name).slice(0, 120);
  const m = mentionsOf(d, worldId, name);
  const body = `# ${title}\n\n${lib ? `Library: [[${lib.title}]]\n\n` : ''}## Appearances\n${m.join('\n')}\n\n## What changed\n\n## Ties to players\n\n## Secrets\n`;
  return { rel: `${CODEX_DIR[k]}/${fileName(title)}.md`, title, fm: { type: 'codex', kind: k, level: 'gm', ...(lib ? { entity: lib.id } : {}), aliases: lib && norm(lib.title) !== norm(name) ? [name] : [], tags: [], sources: [] }, body };
}

/** Where a codex_upsert would write and who could read it: the level of the page (or of the one it would make) and whether the text lands in the players' copy. */
export function upsertTarget(d: Deps, worldId: string, a: { entity?: string; name?: string; kind?: string; section?: string; visible?: boolean; level?: string }): { level: string; visible: boolean; exists: boolean } {
  const name = String(a.name ?? '').trim();
  const entityArg = String(a.entity ?? '').trim();
  let level = 'gm';
  let exists = false;
  try {
    const page = name || entityArg ? findCodex(d, worldId, { entity: entityArg || undefined, name: name || entityArg }, codexPages(d, worldId)) : null;
    if (page) { level = vaultLevel(page.fm); exists = true; }
    else {
      const pcs = players(d, worldId).some((p) => norm(p.character) === norm(name));
      level = ['party', 'broker', 'gm', 'classified'].includes(String(a.level)) ? String(a.level) : pcs || String(a.kind) === 'pc' ? 'party' : 'gm';
    }
  } catch { /* unknown: gm */ }
  return { level, exists, visible: level === 'party' && a.visible === true && sectionName(String(a.section ?? 'notes')) !== 'Secrets' };
}
