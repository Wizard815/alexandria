// Story bible extraction: facts (subject, kind, one sentence) read out of each
// page copy by the chat model, stored per page per scope in bible_facts.
//
// Each scope is extracted from the same copy text the semantic index uses
// (search/copies.ts): 'dm' from the AI copy (never classified), 'broker',
// 'party' and 'lifted' from the player-side copies, so a fact never holds text
// its scope's readers may not have. Incremental: a page is read again only
// when its copy changed (state row per page and scope). Without a chat model,
// or when it fails, nothing happens and the job tries again later.
import type { Deps } from '../../app.ts';
import { chatJson, embed, hasJob, jobConfig } from '../../core/ai.ts';
import { run, tx } from '../../core/db.ts';
import { type Pending, isCurrent, pendingCopies } from '../search/copies.ts';
import { noteDone } from '../search/pace.ts';
import type { VecScope } from '../search/scopes.ts';
import { normalize, toBlob } from '../search/vectorstore.ts';

export const KINDS = ['person', 'place', 'faction', 'item', 'event', 'lore'] as const;
export type FactKind = (typeof KINDS)[number];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS bible_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('dm', 'party', 'broker', 'lifted')),
  subject TEXT NOT NULL,
  subject_norm TEXT NOT NULL,
  kind TEXT NOT NULL,
  fact TEXT NOT NULL,
  idx INTEGER NOT NULL,
  vec BLOB
);
CREATE INDEX IF NOT EXISTS bible_facts_world ON bible_facts (world_id, scope);
CREATE INDEX IF NOT EXISTS bible_facts_page ON bible_facts (page_id, scope);
CREATE TABLE IF NOT EXISTS bible_state (
  page_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('dm', 'party', 'broker', 'lifted')),
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL,
  sig INTEGER NOT NULL,
  model TEXT NOT NULL,
  hash TEXT,
  facts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, scope)
);
`;

const PROMPT_VERSION = 'bible1';
const MAX_TEXT = 6000;
const MAX_FACTS = 30;
/** Scopes are taken in turn, a few pages each (the party's copy, then the DM's, in each turn), so none waits for the others to finish. */
const ORDER: VecScope[] = ['party', 'dm', 'lifted', 'broker'];
const PER_TURN = 3;

const SYSTEM = `You build the "story bible" of a tabletop role-playing campaign. Read the page and list the durable facts it states about people, places, factions, items, events and lore.
Answer with JSON only: {"facts":[{"subject":"the name the fact is about","kind":"person|place|faction|item|event|lore","fact":"one short sentence"}]}
Use only what the page says. One fact per sentence, at most ${MAX_FACTS} facts, the subject always a proper name or a clear noun phrase. If the page holds no facts, answer {"facts":[]}.`;

/** A subject name made comparable: no case, accents, punctuation or leading article. */
export function normSubject(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/^(the|a|an)\s+/, '').replace(/\s+/g, ' ').trim();
}

export interface Fact { subject: string; kind: FactKind; fact: string }

/** The facts out of the model's answer, cleaned. Anything malformed is dropped. */
export function cleanFacts(j: any): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(j?.facts) ? j.facts : []) {
    const subject = String(f?.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const fact = String(f?.fact ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const kind = (KINDS as readonly string[]).includes(String(f?.kind)) ? (f.kind as FactKind) : 'lore';
    if (!subject || fact.length < 3 || !normSubject(subject)) continue;
    const key = `${normSubject(subject)}|${fact.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subject, kind, fact });
    if (out.length >= MAX_FACTS) break;
  }
  return out;
}

export interface BibleSync { pages: number; facts: number; remaining: boolean; skipped?: string }

const failures = new Map<string, number>();

/** Extract facts for pages whose copy changed. Budgeted; quietly stops when the chat model is missing or fails. */
const runningBy = new WeakMap<object, Set<string>>();
export async function syncBible(d: Deps, opts: { maxPages?: number; worldId?: string; signal?: AbortSignal } = {}): Promise<BibleSync> {
  let running = runningBy.get(d.db);
  if (!running) { running = new Set(); runningBy.set(d.db, running); }
  const key = opts.worldId ?? '*';
  const res: BibleSync = { pages: 0, facts: 0, remaining: false };
  if (running.has(key)) { res.skipped = 'already running'; res.remaining = true; return res; }
  running.add(key);
  try { return await syncBibleOnce(d, opts, res); } finally { running!.delete(key); }
}

async function syncBibleOnce(d: Deps, opts: { maxPages?: number; worldId?: string; signal?: AbortSignal }, res: BibleSync): Promise<BibleSync> {
  const cfg = jobConfig(d, 'chat');
  if (!cfg) { res.skipped = 'no chat model'; return res; }
  const model = `${cfg.model}|${PROMPT_VERSION}`;
  let budget = opts.maxPages ?? 10;
  let bad = 0;
  for (let more = true; more && budget > 0 && !opts.signal?.aborted && bad < 2;) {
    more = false;
    for (const scope of ORDER) {
      if (budget <= 0 || opts.signal?.aborted || bad >= 2) break;
      const rows = pendingCopies(d, scope, 'bible_state', model, PER_TURN + 20, opts.worldId).filter((r) => (failures.get(`${r.id}|${scope}|${r.updated_at}`) ?? 0) < 3).slice(0, PER_TURN);
      if (!rows.length) continue;
      more = true;
      for (const r of rows) {
        if (budget <= 0 || opts.signal?.aborted || bad >= 2) break;
        const facts = await extract(d, r, opts.signal);
        if (!facts) {
          // The model did not answer (or answered with something that is not JSON): try later, and stop this round after two in a row.
          bad++;
          const k = `${r.id}|${scope}|${r.updated_at}`;
          failures.set(k, (failures.get(k) ?? 0) + 1);
          continue;
        }
        bad = 0;
        const vecs = await embedFacts(d, facts, opts.signal);
        // Only what still matches the page's copy now is stored.
        if (!isCurrent(d, r)) continue;
        tx(d.db, () => {
          run(d.db, 'DELETE FROM bible_facts WHERE page_id = ? AND scope = ?', r.id, scope);
          facts.forEach((f, i) => run(d.db, 'INSERT INTO bible_facts (world_id, page_id, scope, subject, subject_norm, kind, fact, idx, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.world_id, r.id, scope, f.subject, normSubject(f.subject), f.kind, f.fact, i, vecs?.[i] ? toBlob(vecs[i]) : null));
          run(d.db, `INSERT INTO bible_state (page_id, scope, world_id, updated_at, sig, model, hash, facts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (page_id, scope) DO UPDATE SET updated_at = excluded.updated_at, sig = excluded.sig, model = excluded.model, world_id = excluded.world_id, hash = excluded.hash, facts = excluded.facts`, r.id, scope, r.world_id, r.updated_at, r.sig, model, r.hash, facts.length);
        });
        res.pages++;
        noteDone('bible', r.world_id);
        res.facts += facts.length;
        budget--;
      }
    }
  }
  if (bad >= 2) res.skipped = 'the chat model did not answer';
  res.remaining = ORDER.some((s) => pendingCopies(d, s, 'bible_state', model, 1, opts.worldId).length > 0);
  return res;
}

async function extract(d: Deps, r: Pending, signal?: AbortSignal): Promise<Fact[] | null> {
  if (!r.full.trim()) return [];
  const text = r.full.length > MAX_TEXT ? r.full.slice(0, MAX_TEXT) : r.full;
  const j = await chatJson<any>(d, 'chat', [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Page: ${r.title}\n\n${text}` }], signal, { maxTokens: 900 });
  if (!j || !Array.isArray(j.facts)) return null;
  return cleanFacts(j);
}

/** Vectors of the facts for searching by meaning; null when there is no embeddings model or it fails. */
async function embedFacts(d: Deps, facts: Fact[], signal?: AbortSignal): Promise<Float32Array[] | null> {
  if (!facts.length || !hasJob(d, 'extra')) return null;
  try {
    const got = await embed(d, facts.map((f) => `${f.subject}: ${f.fact}`), signal);
    if (got.length !== facts.length || got.some((v) => !Array.isArray(v) || !v.length)) return null;
    return got.map(normalize);
  } catch { return null; }
}
