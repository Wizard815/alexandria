// A fake Kanka for the source-key tests and the leak crawler. Every token sees
// its own set of entities (the way a Kanka member sees only what they may), and
// every request is recorded with the token it used, so a test can prove which
// key was used for whom.
export const KANKA_API = 'https://kanka.test/api/1.0';
export const CAMPAIGN = '77';

export interface FakeEntity { id: number; name: string; entry: string; priv: boolean; posts?: { name: string; entry: string; visibility_id: number }[]; tags?: string[] }
export interface KankaCall { token: string; path: string }

export const TOKENS = {
  dm: 'DMTOKEN-aaaaaaaaaaaaaaaaaaaaaaaa',
  jess: 'JESSTOKEN-bbbbbbbbbbbbbbbbbbbbbb',
  tom: 'TOMTOKEN-cccccccccccccccccccccc',
  blanket: 'BLANKETTOKEN-dddddddddddddddddd',
  /** A real key, for a different campaign (99). */
  other: 'OTHERCAMPAIGN-eeeeeeeeeeeeeeeeee',
};

/**
 * `sees`: token -> entity ids it can list ('all' for everything). A token that is not listed is refused (401); a
 * token whose campaign is not 77 is refused for it (403).
 */
export function fakeKanka(real: typeof fetch, o: { entities: FakeEntity[]; sees: Record<string, number[] | 'all'>; elsewhere?: string[] }) {
  const calls: KankaCall[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const shape = (e: FakeEntity) => ({
    id: e.id, entity_id: e.id, name: e.name, entry: `<p>${e.entry}</p>`, is_private: e.priv, tags: [], posts: e.posts ?? [],
    updated_at: '2026-01-01T00:00:00.000000Z', urls: { view: `https://kanka.test/w/${CAMPAIGN}/entities/${e.id}` },
  });
  const fetcher = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.startsWith(KANKA_API)) return real(input, init);
    const token = String(init?.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
    const path = url.slice(KANKA_API.length);
    calls.push({ token, path });
    const allowed = o.sees[token];
    if (!allowed) return json({ message: 'Unauthenticated.' }, 401);
    const camp = /^\/campaigns\/(\d+)(\/.*)?$/.exec(path.split('?')[0]);
    if (!camp) return json({}, 404);
    if (camp[1] !== CAMPAIGN || (o.elsewhere ?? []).includes(token)) return json({ message: 'Forbidden' }, 403);
    const visible = o.entities.filter((e) => allowed === 'all' || allowed.includes(e.id));
    const rest = camp[2] ?? '';
    if (!rest) return json({ data: { id: Number(CAMPAIGN), name: 'Fake campaign' } });
    if (rest === '/characters') return json({ data: visible.map(shape), meta: { last_page: 1, total: visible.length }, links: {} });
    if (rest === '/entities') return json({ data: [], meta: { last_page: 1, total: visible.length }, links: {} });
    const s = /^\/search\/(.+)$/.exec(rest);
    if (s) {
      const words = decodeURIComponent(s[1]).toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
      return json({ data: visible.filter((e) => words.some((w) => e.name.toLowerCase().includes(w))).map((e) => ({ id: e.id, entity_id: e.id, name: e.name, type: 'character' })) });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetch: fetcher, calls };
}
