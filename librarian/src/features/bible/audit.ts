// The story bible checked against the pages it was made from. No model is asked: these are the things that can be known for sure.
import type { Deps } from '../../app.ts';
import { all } from '../../core/db.ts';
import { SCOPE_COLS } from '../search/scopes.ts';
import { bibleFailed, normSubject } from './extract.ts';

export interface BibleFinding { kind: 'failed' | 'empty' | 'unsupported' | 'copies'; pageId: string; title: string; scope: string; note: string }

/** Does the page name this? Every longer word of the subject must be somewhere in the page (accents, case and punctuation aside). */
function named(subject: string, hay: string): boolean {
  const words = normSubject(subject).split(' ').filter((w) => w.length > 2);
  return !words.length || words.some((w) => hay.includes(w));
}

export function auditBible(d: Deps, worldId: string) {
  const out: BibleFinding[] = [];
  const titles = new Map(all<any>(d.db, 'SELECT id, title FROM pages WHERE world_id = ?', worldId).map((p) => [p.id, p.title as string]));
  for (const f of bibleFailed()) if (titles.has(f.pageId)) out.push({ kind: 'failed', pageId: f.pageId, title: titles.get(f.pageId)!, scope: f.scope, note: `the model gave no usable answer ${f.tries} time${f.tries === 1 ? '' : 's'}` });
  let facts = 0;
  for (const scope of ['gm', 'broker', 'party'] as const) {
    const c = SCOPE_COLS[scope];
    // Read, but nothing came of a page that has something to say.
    for (const r of all<any>(d.db, `SELECT p.id, p.title, length(${c.body}) AS len FROM bible_state s JOIN pages p ON p.id = s.page_id WHERE s.world_id = ? AND s.scope = ? AND s.facts = 0 AND length(${c.body}) > 400`, worldId, scope)) {
      out.push({ kind: 'empty', pageId: r.id, title: r.title, scope, note: `read, but no facts from ${r.len} characters` });
    }
    const by = new Map<string, string[]>();
    for (const r of all<any>(d.db, 'SELECT page_id, subject FROM bible_facts WHERE world_id = ? AND scope = ?', worldId, scope)) { facts++; by.set(r.page_id, [...(by.get(r.page_id) ?? []), r.subject]); }
    if (!by.size) continue;
    for (const p of all<any>(d.db, `SELECT p.id, p.title, p.aliases, ${c.body} AS body, ${c.props} AS props FROM pages p WHERE p.world_id = ?`, worldId)) {
      const subjects = by.get(p.id);
      if (!subjects) continue;
      const hay = normSubject(`${p.title} ${p.aliases ?? ''} ${p.body ?? ''} ${p.props ?? ''}`);
      const odd = [...new Set(subjects.filter((s) => !named(s, hay)))];
      if (odd.length) out.push({ kind: 'unsupported', pageId: p.id, title: p.title, scope, note: `the page never names: ${odd.slice(0, 4).join(', ')}${odd.length > 4 ? ` and ${odd.length - 4} more` : ''}` });
    }
  }
  // The same page from several sources is read once per copy.
  const copies = all<any>(d.db, 'SELECT count(*) AS n FROM (SELECT lower(title) AS t, folder FROM pages WHERE world_id = ? GROUP BY 1, 2 HAVING count(*) > 1)', worldId)[0];
  const count = (k: BibleFinding['kind']) => out.filter((f) => f.kind === k).length;
  return { facts, checkedAt: new Date().toISOString(), counts: { failed: count('failed'), empty: count('empty'), unsupported: count('unsupported'), copies: Number(copies?.n ?? 0) }, findings: out.slice(0, 300) };
}
