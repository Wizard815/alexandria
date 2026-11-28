// Web research for the GM's assistant: off until the GM turns it on for the world. Only the query words leave
// Alexandria, and a query is refused before anything is sent when it holds a word that only GM-only or classified
// text in this world has (fail closed). The GM may allow a GM-only word by hand; a classified word never goes out.
import type { Deps } from '../../app.ts';
import { jobConfig, screenOutgoing, wouldBeRefused } from '../../core/ai.ts';
import { all, one, run } from '../../core/db.ts';
import { HttpError, now, parseJson } from '../../core/util.ts';
import { webConfig, type WebConfig } from './store.ts';

export interface WebResult { title: string; url: string; snippet: string; query: string }
export interface Blocked { query: string; term: string; level: 'gm' | 'classified' }

// Everyday words (and the ones every fantasy world uses) never count as a secret on their own.
const COMMON = new Set(`the and for with from that this these those there their them they then than what when where which while who whom whose why how
are was were been being have has had having does did doing done can could would should will shall may might must not nor but yet also only just very more most
some any all each every both few many much such own same other another into onto upon over under above below about after before during between through
again further once here out off down near far still even ever never always often again new old big small large great little long short high low good bad
first last next one two three four five six seven eight nine ten hundred thousand day days night nights year years time times way ways man men woman women
people person thing things place places town towns village villages city cities river rivers road roads sea coast hill hills mountain mountains forest
lake island bay port harbour harbor castle keep tower temple church market inn tavern shop street house houses hall gate bridge wall walls north south east
west world land lands king queen lord lady city guard guards captain priest merchant farmer fisher fishing boat boats ship ships gold silver copper coin coins
water fire stone wood iron dark light black white red blue green grey gray old young dead living war peace trade food drink ale wine bread fish meat
party players player character characters session sessions page pages note notes secret secrets dm gm npc npcs`.split(/\s+/).filter(Boolean));

const wordsOf = (s: string | null | undefined): string[] => (s ?? '').toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}']+/gu) ?? [];
const capsOf = (s: string | null | undefined): string[] => [...(s ?? '').matchAll(/(?<![\p{L}\p{N}'])\p{Lu}[\p{L}\p{N}']+/gu)].map((m) => m[0].toLowerCase());
const keep = (w: string) => w.length >= 3 && !COMMON.has(w) && !/^\d+$/.test(w);
const flat = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join('\n');
const blockText = (json: string | null | undefined): string => {
  const out: string[] = [];
  const walk = (v: unknown) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(parseJson(json ?? null, null));
  return out.join(' ');
};

export interface SecretTerms { gm: Set<string>; classified: Set<string> }
const cache = new Map<string, { key: string; terms: SecretTerms }>();

/**
 * The words a query may not carry: words of classified text no AI copy has, and the names (capitalised words, page
 * titles and aliases) that GM-only text has and no player copy has. Common words never count.
 */
export function secretTerms(d: Deps, worldId: string): SecretTerms {
  const cols = new Set((d.db.prepare('PRAGMA table_info(pages)').all() as any[]).map((c) => c.name));
  const has = (c: string) => (cols.has(c) ? c : 'NULL');
  const stamp = one<any>(d.db, 'SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM pages WHERE world_id = ?', worldId);
  let lines: { text: string; audience: string }[] = [];
  try { lines = all(d.db, 'SELECT text, audience FROM audio_lines WHERE world_id = ?', worldId); } catch { /* no audio tables */ }
  const key = `${stamp?.n}|${stamp?.u}|${lines.length}`;
  const hit = cache.get(worldId);
  if (hit && hit.key === key) return hit.terms;
  const pub = new Set<string>();
  const ai = new Set<string>();
  const gmAll = new Set<string>();
  const gmNames = new Set<string>();
  const rows = all<any>(d.db, `SELECT title, visibility, aliases, body, blocks, properties, ${has('ai_body')} AS ai_body, ${has('ai_blocks')} AS ai_blocks, ${has('ai_properties')} AS ai_properties, player_body, ${has('player_blocks')} AS player_blocks, ${has('player_properties')} AS player_properties FROM pages WHERE world_id = ?`, worldId);
  for (const p of rows) {
    const aliases = parseJson<string[]>(p.aliases, []).join(' ');
    const gmText = flat(p.title, aliases, p.body, blockText(p.blocks), blockText(p.properties));
    const classifiedPage = p.visibility === 'classified';
    const aiText = classifiedPage ? '' : flat(p.title, aliases, p.ai_body ?? p.body, blockText(p.ai_blocks ?? p.blocks), blockText(p.ai_properties ?? p.properties));
    for (const w of wordsOf(gmText)) gmAll.add(w);
    for (const w of wordsOf(aiText)) ai.add(w);
    if (p.visibility === 'party') for (const w of wordsOf(flat(p.title, p.player_body, blockText(p.player_blocks), blockText(p.player_properties)))) pub.add(w);
    // Names in what the GM's copy holds beyond the players' (a GM-only page's title counts whole).
    for (const w of capsOf(aiText)) gmNames.add(w);
    if (p.visibility !== 'party') for (const w of wordsOf(flat(p.title, aliases))) gmNames.add(w);
  }
  for (const l of lines) {
    if (l.audience === 'players') for (const w of wordsOf(l.text)) pub.add(w);
    else for (const w of capsOf(l.text)) gmNames.add(w);
  }
  const classified = new Set([...gmAll].filter((w) => keep(w) && !ai.has(w) && !pub.has(w)));
  const gm = new Set([...gmNames].filter((w) => keep(w) && !pub.has(w) && !classified.has(w)));
  const terms = { gm, classified };
  cache.set(worldId, { key, terms });
  return terms;
}

/** The first query that may not go out, and why; null when all may. */
export function blockedQuery(d: Deps, worldId: string, queries: string[], cfg: WebConfig = webConfig(d.db, worldId)): Blocked | null {
  const terms = secretTerms(d, worldId);
  const allowed = new Set(cfg.allowTerms);
  for (const q of queries) {
    if (wouldBeRefused(d, q)) return { query: q, term: '', level: 'classified' };
    for (const w of wordsOf(q)) {
      if (terms.classified.has(w)) return { query: q, term: w, level: 'classified' };
      if (terms.gm.has(w) && !allowed.has(w)) return { query: q, term: w, level: 'gm' };
    }
  }
  return null;
}

/** What the GM (and the assistant) is told about a refused query. A classified word is never repeated. */
export const blockedText = (b: Blocked): string => (b.level === 'classified'
  ? 'Not sent: the query repeats classified text from this world, which never leaves Alexandria. Search for the real-world reference only.'
  : `Not sent: "${b.term}" is a GM-only name in this world, so it never goes to an outside service. Search for the real-world reference only, or allow the word under Templates & guides → Web research.`);

export function cleanQueries(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out: string[] = [];
  for (const x of raw) {
    const q = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (q && !out.includes(q)) out.push(q);
  }
  if (!out.length) throw new HttpError(400, 'queries is required: one to three short web searches');
  return out.slice(0, 3);
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const httpUrl = (u: unknown): string => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.toString() : ''; } catch { return ''; } };

/** The OpenRouter provider and model to search with. */
async function openRouterTarget(d: Deps, cfg: WebConfig): Promise<{ baseUrl: string; apiKey?: string; model: string }> {
  const { getProvider, listProviders } = await import('../models/providers.ts');
  const isOR = (u: string) => /^https?:\/\/([^/]*\.)?openrouter\.ai(\/|$)/i.test(u);
  let p: any;
  try { p = cfg.providerId ? getProvider(d.db, cfg.providerId) : listProviders(d.db).find((x) => isOR(x.base_url)); } catch { p = null; }
  const chat = jobConfig(d, 'chat');
  const baseUrl = p?.base_url ?? (chat && isOR(chat.baseUrl) ? chat.baseUrl : '');
  if (!baseUrl) throw new HttpError(409, 'No OpenRouter provider: add one in Admin → Models, or use a SearXNG address for web research.');
  const model = cfg.model || (chat && chat.baseUrl.replace(/\/+$/, '') === String(baseUrl).replace(/\/+$/, '') ? chat.model : '');
  if (!model) throw new HttpError(409, 'Pick the model to search with (Templates & guides → Web research).');
  return { baseUrl: String(baseUrl).replace(/\/+$/, ''), apiKey: p?.api_key || (p ? undefined : chat?.apiKey), model };
}

async function searchOne(d: Deps, cfg: WebConfig, q: string): Promise<WebResult[]> {
  if (cfg.provider === 'searxng') {
    if (!cfg.searxUrl) throw new HttpError(409, 'Set the SearXNG address first (Templates & guides → Web research).');
    const r = await d.fetch(`${cfg.searxUrl}/search?q=${encodeURIComponent(q)}&format=json`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new HttpError(502, `The search service answered ${r.status}`);
    const j: any = await r.json().catch(() => null);
    return (Array.isArray(j?.results) ? j.results : []).map((x: any) => ({ title: stripTags(String(x?.title ?? '')).slice(0, 200), url: httpUrl(x?.url), snippet: stripTags(String(x?.content ?? '')).slice(0, 400), query: q }))
      .filter((x: WebResult) => x.url).slice(0, cfg.maxResults);
  }
  const t = await openRouterTarget(d, cfg);
  // The query is the only world text in the request; the classified guard looks at it once more.
  screenOutgoing(d, 'chat', [q]);
  const r = await d.fetch(`${t.baseUrl}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
    body: JSON.stringify({ model: t.model, messages: [{ role: 'user', content: q }], plugins: [{ id: 'web', max_results: cfg.maxResults }], max_tokens: 800 }),
  });
  if (!r.ok) throw new HttpError(502, `The web search answered ${r.status}`);
  const j: any = await r.json().catch(() => null);
  const msg = j?.choices?.[0]?.message ?? {};
  const out: WebResult[] = [];
  for (const a of Array.isArray(msg.annotations) ? msg.annotations : []) {
    const c = a?.url_citation ?? a;
    const url = httpUrl(c?.url);
    if (url && !out.some((x) => x.url === url)) out.push({ title: stripTags(String(c?.title ?? url)).slice(0, 200), url, snippet: stripTags(String(c?.content ?? '')).slice(0, 400), query: q });
  }
  // No citations: the model's own summary is kept as one unsourced result.
  if (!out.length && typeof msg.content === 'string' && msg.content.trim()) out.push({ title: `Summary for "${q}"`, url: '', snippet: stripTags(msg.content).slice(0, 800), query: q });
  return out.slice(0, cfg.maxResults);
}

/** Run the searches (each checked first). Throws an HttpError the GM can read; nothing is sent for a refused query. */
export async function webSearch(d: Deps, worldId: string, queries: string[], by: string | null): Promise<{ queries: string[]; results: WebResult[]; provider: string }> {
  const cfg = webConfig(d.db, worldId);
  if (!cfg.enabled) throw new HttpError(403, 'Web research is off for this world. The GM can turn it on under Templates & guides → Web research.');
  const b = blockedQuery(d, worldId, queries, cfg);
  if (b) {
    run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, by, 'templates.web_blocked', b.level === 'classified' ? 'a query repeated classified text' : `a query held the GM-only word "${b.term}"`, now());
    throw new HttpError(422, blockedText(b));
  }
  const results: WebResult[] = [];
  for (const q of queries) results.push(...await searchOne(d, cfg, q));
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, by, 'templates.web_search', `${cfg.provider}: ${queries.map((q) => JSON.stringify(q)).join(', ')} -> ${results.length} results`.slice(0, 500), now());
  return { queries, results, provider: cfg.provider };
}

/** Before a web_research call becomes a card: why it would not run (off, no query, a GM-only or classified word), or null. */
export function webPrecheck(d: Deps, worldId: string, args: any): string | null {
  const cfg = webConfig(d.db, worldId);
  if (!cfg.enabled) return 'Not proposed: web research is off for this world (the GM turns it on under Templates & guides → Web research). Work from the library.';
  let queries: string[];
  try { queries = cleanQueries(args?.queries ?? args?.query); } catch (e: any) { return `Not proposed: ${e.message}`; }
  const b = blockedQuery(d, worldId, queries, cfg);
  return b ? `${blockedText(b)} Nothing was sent.` : null;
}

/** The results as the chat shows them after the GM approved a search, and as the assistant reads them next. */
export function researchNote(raw: string): string {
  const j = parseJson<any>(raw, null);
  const list: WebResult[] = Array.isArray(j?.results) ? j.results : [];
  if (!list.length) return `Web research found nothing for ${(j?.queries ?? []).map((q: string) => `"${q}"`).join(', ') || 'that'}.`;
  return `Web research results (${list.length}, for ${(j.queries ?? []).map((q: string) => `"${q}"`).join(', ')}). Cite them as sources:\n${list.map((r, i) => `${i + 1}. ${r.url ? `[${r.title}](${r.url})` : r.title}${r.snippet ? `: ${r.snippet.slice(0, 300)}` : ''}`).join('\n')}`;
}
