// Fake outside services for the big-world measurements: a LegendKeeper project,
// an embeddings model and a chat model, each answering after a realistic delay.
// Synthetic data only. Used by bigworld.ts (build) and bigworld-server.ts (serve).

export const LK_BASE = 'https://www.legendkeeper.com/api/v3/projects/bigworld';
export const MODEL_BASE = 'http://models.bigworld.test/v1';
export const LK_CFG = { apiUrl: LK_BASE, apiKey: 'lk_bigworld_key_1234567890' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A small deterministic random generator, so every build is the same world. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const WORDS = 'ancient river stone keep lantern whisper harbor mirror thorn ember crown vale shadow ledger oath wolf marsh bell copper tide spire hollow warden sigil ash gate banner lost salt wind forge tower ruin glass pilgrim cellar moor drum raven candle'.split(' ');
export function sentence(r: () => number, n = 12) {
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(WORDS[Math.floor(r() * WORDS.length)]);
  const s = w.join(' ');
  return s[0].toUpperCase() + s.slice(1) + '.';
}
export const paragraph = (r: () => number, n = 5) => Array.from({ length: n }, () => sentence(r, 8 + Math.floor(r() * 12))).join(' ');

export interface Mock {
  fetch: typeof fetch;
  stats: { lk: number; embed: number; embedInputs: number; chat: number };
  /** The latency of each kind of answer, in ms. */
  latency: { lk: number; embed: number; chat: number };
  lkResources: number;
}

/** `lkResources` resources in the fake LegendKeeper project (a tree: a few roots, the rest below them). */
export function makeMocks(lkResources: number): Mock {
  const lkRes = Array.from({ length: lkResources }, (_, i) => ({
    id: `r${i + 1}`, name: `Lore ${i + 1} ${WORDS[i % WORDS.length]}`, parentId: i < 10 ? null : `r${(i % 9) + 1}`, isHidden: i % 6 === 0, updatedAt: '2026-01-01T00:00:00Z', tags: i % 3 === 0 ? ['npc'] : [],
  }));
  const mock: Mock = { fetch: null as any, stats: { lk: 0, embed: 0, embedInputs: 0, chat: 0 }, latency: { lk: 8, embed: 60, chat: 250 }, lkResources };
  const item = (r: (typeof lkRes)[number]) => ({ id: r.id, name: r.name, parentId: r.parentId, tags: r.tags, aliases: [], rank: `r${r.id.length}${r.id}`, isHidden: r.isHidden, updatedAt: r.updatedAt, documents: [{ id: `d-${r.id}`, name: 'Main', type: 'page' }], hasChildren: false });
  mock.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith(LK_BASE)) {
      mock.stats.lk++;
      await sleep(mock.latency.lk);
      const x = new URL(u);
      const p = x.pathname.slice('/api/v3/projects/bigworld'.length);
      if (p === '/resources') {
        const start = Number(x.searchParams.get('cursor') ?? 0);
        const slice = lkRes.slice(start, start + 100);
        const more = start + 100 < lkRes.length;
        return json({ data: slice.map(item), hasMore: more, nextCursor: more ? String(start + 100) : null });
      }
      if (p === '/calendars' || /\/features$/.test(p)) return json({ data: [] });
      let m = /^\/resources\/([^/]+)\/docs\/([^/]+)\/blocks$/.exec(p);
      if (m) {
        const n = Number(m[1].slice(1));
        const r = rng(n);
        const blocks: any[] = [];
        for (let b = 0; b < 12; b++) blocks.push({ kind: 'paragraph', content: [{ text: paragraph(r, 4) }, ...(b % 3 === 0 ? [{ mention: { resourceId: `r${1 + Math.floor(r() * lkResources)}`, name: 'Elsewhere' } }] : [])] });
        return json({ blocks });
      }
      m = /^\/resources\/([^/]+)$/.exec(p);
      if (m) {
        const r = lkRes.find((q) => q.id === m![1]);
        if (!r) return json({ code: 'NOT_FOUND' }, 404);
        return json({ ...item(r), permissions: { MEMBER: 5, ADMIN: 3, OWNER: 3 }, ancestors: [], properties: [], documents: [{ id: `d-${r.id}`, name: 'Main', type: 'page', isHidden: false, rank: 'a' }] });
      }
      return json({ code: 'NOT_FOUND' }, 404);
    }
    if (u.startsWith(MODEL_BASE)) {
      const path = u.slice(MODEL_BASE.length);
      const body = (() => { try { return JSON.parse(String(init?.body ?? '{}')); } catch { return {}; } })();
      if (path === '/embeddings') {
        const inputs: string[] = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
        mock.stats.embed++;
        mock.stats.embedInputs += inputs.length;
        await sleep(mock.latency.embed + inputs.length * 2);
        // 384 numbers per input, derived from the text so equal texts match.
        return json({ data: inputs.map((t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; const r = rng(h); return { embedding: Array.from({ length: 384 }, () => r() - 0.5) }; }) });
      }
      if (path === '/chat/completions') {
        mock.stats.chat++;
        await sleep(mock.latency.chat);
        const last = String(body.messages?.[body.messages.length - 1]?.content ?? '');
        const content = /Rule:/.test(last) ? '{"ok": true}' : '**So far**\n- the party met a warden\n**Right now**\nAt the gate.\n**Open threads**\n- the oath';
        return json({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
      }
      return json({ error: 'unknown' }, 404);
    }
    return json({ error: 'unexpected ' + u }, 500);
  }) as typeof fetch;
  return mock;
}
