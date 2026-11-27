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
import { chatJson, embed, hasJob, jobBudget, jobConfig } from '../../core/ai.ts';
import { one, run, tx } from '../../core/db.ts';
import { type Pending, isCurrent, pendingCopies } from '../search/copies.ts';
import { noteDone } from '../search/pace.ts';
import type { VecScope } from '../search/scopes.ts';
import { normalize, toBlob } from '../search/vectorstore.ts';
import { embedBatch, parallelFor, pool } from '../search/batching.ts';

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
CREATE INDEX IF NOT EXISTS bible_facts_wsp ON bible_facts (world_id, scope, page_id);
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

// bible2: facts in the caveman voice (github.com/JuliusBrussee/caveman: few words, meaning kept), a JSON schema, and
// small pieces for a small model. A new version reads every page again, in the background.
export const PROMPT_VERSION = 'bible2';
const MAX_TEXT = 6000;
const MAX_FACTS = 30;
/** A small model (0.5 to 2B) reads a page in pieces this long, and gives at most this many facts a piece. */
const SMALL_PIECE = 1800;
const SMALL_FACTS = 10;
/** Scopes are taken in turn, a few pages each (the party's copy, then the DM's, in each turn), so none waits for the others to finish. */
const ORDER: VecScope[] = ['party', 'dm', 'lifted', 'broker'];
const PER_TURN = 3;

// The instructions stay in plain English (making the prompt itself terse makes answers worse); only the facts it writes
// are short. Short facts are fewer tokens for a small model to write, and fewer for Minerva to read later.
const systemFor = (max: number) => `You build the "story bible" of a tabletop role-playing campaign. Read the page and list the lasting facts it states about people, places, factions, items, events and lore.
Answer with JSON only: {"facts":[{"subject":"name","kind":"person|place|faction|item|event|lore","fact":"short fact"}]}
Rules:
- Use only what the page says. Never guess.
- subject: a name from the page, exactly as written.
- fact: caveman style. Few words, no "the" or "a", present tense, under 15 words. Keep names, numbers and every "not", "never", "no" and "only".
- One idea per fact. At most ${max} facts.
Example: {"facts":[{"subject":"Old Brannoc","kind":"person","fact":"Blacksmith. Lost left hand to troll."},{"subject":"Iron Vale","kind":"place","fact":"Mining valley. Not safe after dark."}]}
No facts on the page: {"facts":[]}.`;
const FACTS_SCHEMA = {
  name: 'story_bible_facts',
  schema: {
    type: 'object', additionalProperties: false, required: ['facts'],
    properties: {
      facts: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['subject', 'kind', 'fact'],
          properties: { subject: { type: 'string' }, kind: { type: 'string', enum: [...KINDS] }, fact: { type: 'string' } },
        },
      },
    },
  },
};

/** Is the story bible's model a small one (0.5 to 2B)? The job option `smallModel` says so, else the name does ("qwen3-0.6b", "lfm-3-1.7b"). */
export function isSmallModel(model: string, options?: Record<string, unknown>): boolean {
  if (options?.smallModel === true) return true;
  if (options?.smallModel === false) return false;
  const m = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*b(?:\b|[-_:])/i.exec(model.replace(/a\d+(?:\.\d+)?b/gi, ''));
  return !!m && Number(m[1]) > 0 && Number(m[1]) <= 2;
}

/** A page cut into pieces at paragraph (else sentence) ends, each at most `size` characters. */
export function piecesOf(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const para of text.split(/\n\s*\n/)) {
    const parts = para.length > size ? para.split(/(?<=[.!?])\s+/) : [para];
    for (const part of parts) {
      if (cur && cur.length + part.length + 2 > size) push();
      cur = cur ? `${cur}\n\n${part}` : part;
      while (cur.length > size) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
    }
  }
  push();
  return out;
}

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

export interface BibleSync { pages: number; facts: number; remaining: boolean; skipped?: string; /** Copies whose text another scope of the same page already had: its facts were reused, no model call. */ reused?: number }

const failures = new Map<string, number>();

// ---- what it is doing, for the bible page (this process only) ----
export interface BibleLogRow { at: string; worldId: string; pageId: string; title: string; scope: VecScope; ok: boolean; facts: number; ms: number }
const log: BibleLogRow[] = [];
// The pages being read right now, per world (several at once in a bulk read).
const now = new Map<string, Map<string, { pageId: string; title: string; scope: VecScope; since: string }>>();
export const bibleLog = (worldId: string, n = 40) => log.filter((r) => r.worldId === worldId).slice(-n).reverse();
/** The page read longest right now, and how many are being read at once; null when none. */
export const bibleNow = (worldId: string) => {
  const m = now.get(worldId);
  const first = m?.values().next().value;
  return first ? { ...first, reading: m!.size } : null;
};
export const bibleFailed = (): { pageId: string; scope: string; tries: number }[] => [...failures].map(([k, tries]) => { const [pageId, scope] = k.split('|'); return { pageId, scope, tries }; });
export const forgetFailures = (pageIds?: string[]) => { for (const k of failures.keys()) if (!pageIds || pageIds.includes(k.split('|')[0])) failures.delete(k); };
function noteLog(r: BibleLogRow) { log.push(r); if (log.length > 400) log.splice(0, 100); }


/** Extract facts for pages whose copy changed. Budgeted; quietly stops when the chat model is missing or fails. */
const runningBy = new WeakMap<object, Set<string>>();
export async function syncBible(d: Deps, opts: { maxPages?: number; worldId?: string; signal?: AbortSignal; onPage?: (done: { pages: number; facts: number }) => void } = {}): Promise<BibleSync> {
  let running = runningBy.get(d.db);
  if (!running) { running = new Set(); runningBy.set(d.db, running); }
  const key = opts.worldId ?? '*';
  const res: BibleSync = { pages: 0, facts: 0, remaining: false };
  if (running.has(key)) { res.skipped = 'already running'; res.remaining = true; return res; }
  running.add(key);
  try { return await syncBibleOnce(d, opts, res); } finally { running!.delete(key); }
}

/** Is a story bible pass running for this world (or for every world) now? */
export const bibleRunning = (d: Deps, worldId: string) => { const r = runningBy.get(d.db); return !!r && (r.has(worldId) || r.has('*')); };

/** `twins`: other scopes' copies of the same page with the very same text, given the same facts. */
interface Read { r: Pending; facts: Fact[]; twins: Pending[] }

/**
 * Bulk: several pages are read at once (the model's maxConcurrent, or
 * ALX_BIBLE_PARALLEL), and the facts of the pages read are embedded together,
 * up to ALX_EMBED_BATCH facts a request, and written in one transaction. A
 * single changed page is one chat call and one small write, as before.
 */
async function syncBibleOnce(d: Deps, opts: { maxPages?: number; worldId?: string; signal?: AbortSignal; onPage?: (done: { pages: number; facts: number }) => void }, res: BibleSync): Promise<BibleSync> {
  const cfg = jobConfig(d, 'bible');
  if (!cfg) { res.skipped = 'no chat model'; return res; }
  const model = `${cfg.model}|${PROMPT_VERSION}`;
  const parallel = parallelFor(d, 'bible', 'ALX_BIBLE_PARALLEL');
  const batch = embedBatch(d);
  let budget = opts.maxPages ?? 10;
  // Failures in a row: two and the pass ends (the model is down or answers nonsense); a good page resets it.
  let bad = 0;
  let failed = 0;
  let read = 0;
  const stopped = () => !!opts.signal?.aborted || bad >= 2;

  // Pages in scope turns (a few of the party's copy, then the DM's, ...), each page taken once per pass.
  const taken = new Set<string>();
  let settled = 0;
  const buf: Pending[] = [];
  const twinsOf = new Map<string, Pending[]>();
  const version = model.slice(model.indexOf('|') + 1);
  const writeState = (r: Pending, n: number) => run(d.db, `INSERT INTO bible_state (page_id, scope, world_id, updated_at, sig, model, hash, facts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (page_id, scope) DO UPDATE SET updated_at = excluded.updated_at, sig = excluded.sig, model = excluded.model, world_id = excluded.world_id, hash = excluded.hash, facts = excluded.facts`, r.id, r.scope, r.world_id, r.updated_at, r.sig, model, r.hash, n);
  const counted = (r: Pending, n: number, reused: boolean) => {
    settled++;
    res.pages++;
    res.facts += n;
    if (reused) res.reused = (res.reused ?? 0) + 1;
    noteDone('bible', r.world_id);
  };
  // Another scope of this page already holds facts read from exactly this text (same hash, same prompt version): copy them.
  const copyStored = (r: Pending): boolean => {
    if (!r.hash) return false;
    const src = one<any>(d.db, "SELECT scope, facts FROM bible_state WHERE page_id = ? AND scope <> ? AND hash = ? AND substr(model, instr(model, '|') + 1) = ? LIMIT 1", r.id, r.scope, r.hash, version);
    if (!src) return false;
    return tx(d.db, () => {
      if (!isCurrent(d, r)) return false;
      run(d.db, 'DELETE FROM bible_facts WHERE page_id = ? AND scope = ?', r.id, r.scope);
      run(d.db, `INSERT INTO bible_facts (world_id, page_id, scope, subject, subject_norm, kind, fact, idx, vec)
        SELECT ?, page_id, ?, subject, subject_norm, kind, fact, idx, vec FROM bible_facts WHERE page_id = ? AND scope = ? ORDER BY idx`, r.world_id, r.scope, r.id, src.scope);
      writeState(r, Number(src.facts));
      counted(r, Number(src.facts), true);
      return true;
    });
  };
  let turn = 0;
  let dry = 0;
  const nextPage = (): Pending | null => {
    while (!buf.length && budget > 0 && dry < ORDER.length) {
      const scope = ORDER[turn++ % ORDER.length];
      const rows = pendingCopies(d, scope, 'bible_state', model, PER_TURN + 20 + (taken.size - settled), opts.worldId)
        .filter((r) => !taken.has(`${r.id}|${scope}`) && (failures.get(`${r.id}|${scope}|${r.updated_at}`) ?? 0) < 3)
        .slice(0, Math.min(PER_TURN, budget));
      if (!rows.length) { dry++; continue; }
      dry = 0;
      for (const r of rows) {
        taken.add(`${r.id}|${scope}`);
        budget--;
        // The same text as another scope's copy of this page (the broker copy is often the party copy): read it once.
        const lead = r.hash ? twinsOf.get(`${r.id}|${r.hash}`) : undefined;
        if (lead) { lead.push(r); continue; }
        if (copyStored(r)) continue;
        if (r.hash) twinsOf.set(`${r.id}|${r.hash}`, []);
        buf.push(r);
      }
    }
    return buf.shift() ?? null;
  };

  // Pages read and waiting to be written: their facts are embedded together.
  let done: Read[] = [];
  let doneFacts = 0;
  const flush = async () => {
    const part = done;
    done = [];
    doneFacts = 0;
    if (!part.length) return;
    const vecs = await embedFacts(d, part.flatMap((p) => p.facts), batch, opts.signal);
    let at = 0;
    tx(d.db, () => {
      for (const { r: lead, facts, twins } of part) {
        const base = at;
        at += facts.length;
        // A twin that turns up later copies the stored facts instead (copyStored).
        if (lead.hash) twinsOf.delete(`${lead.id}|${lead.hash}`);
        // The page's own copy, then its twins (the same text in other scopes) with the same facts.
        [lead, ...twins].forEach((r, k) => {
          // Only what still matches the page's copy now is stored.
          if (!isCurrent(d, r)) return;
          run(d.db, 'DELETE FROM bible_facts WHERE page_id = ? AND scope = ?', r.id, r.scope);
          facts.forEach((f, i) => run(d.db, 'INSERT INTO bible_facts (world_id, page_id, scope, subject, subject_norm, kind, fact, idx, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', r.world_id, r.id, r.scope, f.subject, normSubject(f.subject), f.kind, f.fact, i, vecs?.[base + i] ? toBlob(vecs[base + i]) : null));
          writeState(r, facts.length);
          counted(r, facts.length, k > 0);
        });
      }
    });
    opts.onPage?.({ pages: res.pages, facts: res.facts });
  };

  const readOne = async (r: Pending) => {
    const t0 = Date.now();
    const k = `${r.id}|${r.scope}`;
    let m = now.get(r.world_id);
    if (!m) now.set(r.world_id, (m = new Map()));
    m.set(k, { pageId: r.id, title: r.title, scope: r.scope, since: new Date().toISOString() });
    let facts: Fact[] | null;
    try { facts = await extract(d, r, opts.signal); } finally { m.delete(k); if (!m.size) now.delete(r.world_id); }
    if (!opts.signal?.aborted) noteLog({ at: new Date().toISOString(), worldId: r.world_id, pageId: r.id, title: r.title, scope: r.scope, ok: !!facts, facts: facts?.length ?? 0, ms: Date.now() - t0 });
    // Stopped part way (the session ended): not the model's failure, and nothing half-read is stored.
    if (opts.signal?.aborted) return;
    if (!facts) {
      // The model did not answer (or answered with something that is not JSON): try later, and stop this pass after two in a row.
      bad++;
      failed++;
      const fk = `${r.id}|${r.scope}|${r.updated_at}`;
      failures.set(fk, (failures.get(fk) ?? 0) + 1);
      return;
    }
    bad = 0;
    read++;
    done.push({ r, facts, twins: r.hash ? twinsOf.get(`${r.id}|${r.hash}`) ?? [] : [] });
    doneFacts += facts.length;
    if (doneFacts >= batch || done.length >= parallel * 2) await flush();
  };

  try {
    await pool(parallel, () => (stopped() ? null : nextPage()), readOne, stopped);
  } finally {
    // What was read before a stop is kept (unless the stop was an abort: then nothing more is written).
    if (!opts.signal?.aborted) await flush().catch(() => {});
  }
  // Two failures in a row, or nothing the model was asked for came back (one page and its twins): the model did not answer.
  if (bad >= 2 || (failed > 0 && read === 0)) res.skipped = 'the chat model did not answer';
  res.remaining = ORDER.some((s) => pendingCopies(d, s, 'bible_state', model, 1, opts.worldId).length > 0);
  return res;
}

async function extract(d: Deps, r: Pending, signal?: AbortSignal): Promise<Fact[] | null> {
  if (!r.full.trim()) return [];
  const text = r.full.length > MAX_TEXT ? r.full.slice(0, MAX_TEXT) : r.full;
  const cfg = jobConfig(d, 'bible');
  const small = !!cfg && isSmallModel(cfg.model, cfg.options);
  const pieces = small ? piecesOf(text, SMALL_PIECE) : [text];
  const max = small ? SMALL_FACTS : MAX_FACTS;
  const all: Fact[] = [];
  let answered = 0;
  for (const piece of pieces) {
    const j = await chatJson<any>(d, 'bible', [{ role: 'system', content: systemFor(max) }, { role: 'user', content: `Page: ${r.title}\n\n${piece}` }], signal, { maxTokens: jobBudget(d, 'bible', small ? 450 : 900), schema: FACTS_SCHEMA });
    if (!j || !Array.isArray(j.facts)) continue;
    answered++;
    // A small model now and then makes up a name: a fact about a subject the page never names is dropped.
    const page = normSubject(`${r.title} ${piece}`);
    all.push(...(small ? j.facts.filter((f: any) => page.includes(normSubject(String(f?.subject ?? '')))) : j.facts));
  }
  if (!answered) return null;
  return cleanFacts({ facts: all });
}

/** Vectors of the facts for searching by meaning, `batch` facts a request; null when there is no embeddings model or it fails. */
async function embedFacts(d: Deps, facts: Fact[], batch: number, signal?: AbortSignal): Promise<Float32Array[] | null> {
  if (!facts.length || !hasJob(d, 'extra')) return null;
  try {
    const out: Float32Array[] = [];
    for (let i = 0; i < facts.length; i += batch) {
      const part = facts.slice(i, i + batch);
      const got = await embed(d, part.map((f) => `${f.subject}: ${f.fact}`), signal, 'document');
      if (got.length !== part.length || got.some((v) => !Array.isArray(v) || !v.length)) return null;
      for (const v of got) out.push(normalize(v));
    }
    return out;
  } catch { return null; }
}
