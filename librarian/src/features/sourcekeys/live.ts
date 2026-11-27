// Talking to a source with a person's key: check it belongs to this world,
// probe what it sees, list what it can see, and search live. The key replaces
// the connection's secret in a copy of the source's settings; it is only ever
// sent to the host the GM already set up for the source (the connectors build
// the requests, and Kanka's refuses any URL outside the API base).
import type { Deps } from '../../app.ts';
import { effectiveConfig } from '../../intake/connections.ts';
import { isRecord, type Connector } from '../../intake/connector.ts';
import { connectorFor } from '../../intake/registry.ts';
import { connectorContext } from '../../intake/sync.ts';
import { kankaBase, kankaHttp } from '../../intake/connectors/kanka.ts';
import { restTransport } from '../../intake/connectors/legendkeeper.ts';

/** Which setting holds the secret, for the sources that can be read with a person's own key. */
const SECRET_FIELD: Record<string, string> = { 'kanka-api': 'token', 'legendkeeper-api': 'apiKey', api: 'token' };

export interface SourceRow { id: string; world_id: string; kind: string; name: string; config: string; connection_id: string | null; default_visibility: string; audience?: string | null; enabled?: number }

export class KeyRefused extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** The connector, when this source can be read with a person's own key. */
export function keyConnector(d: Deps, src: SourceRow): { c: Connector; field: string; cfg: Record<string, any> } {
  const cfg = effectiveConfig(d.db, src);
  const c = connectorFor(src.kind, cfg);
  const field = c ? SECRET_FIELD[c.id] : undefined;
  if (!c || !field) throw new KeyRefused('This kind of source has no per-person keys. Keys work with Kanka (API), LegendKeeper (API key) and a generic HTTP API.');
  if (c.id === 'api' && (cfg.transport ?? 'http') !== 'http') throw new KeyRefused('Keys work with a generic API only over HTTP, not through an MCP tool.');
  return { c, field, cfg };
}

/** Run something against the source with this key, with a time limit. */
async function withKey<T>(d: Deps, src: SourceRow, secret: string, fn: (x: { c: Connector; cfg: Record<string, any>; ctx: ReturnType<typeof connectorContext>['ctx']; dmCfg: Record<string, any> }) => Promise<T>, ms = 30_000): Promise<T> {
  const { c, field, cfg: dmCfg } = keyConnector(d, src);
  const cfg = { ...dmCfg, [field]: secret };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const made = connectorContext({ db: d.db, library: d.library, dataDir: d.dataDir, vaultsDir: d.vaultsDir, fetch: d.fetch, env: d.env, mcp: d.testMcp }, { ...src, default_visibility: 'dm' }, cfg, ctl.signal, () => {});
  try { return await fn({ c, cfg, ctx: made.ctx, dmCfg }); } finally { clearTimeout(timer); made.close(); }
}

const say = (e: any) => String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);

/**
 * Does this key belong to this world? Kanka: it can read the source's
 * campaign. LegendKeeper: it can read the source's project. Generic API: one
 * list call with the source's world settings works. Never throws: a plain
 * reason says what is wrong.
 */
export async function verifyKey(d: Deps, src: SourceRow, secret: string): Promise<{ ok: boolean; reason: string }> {
  try {
    return await withKey(d, src, secret, async ({ c, cfg, ctx }) => {
      if (c.id === 'kanka-api') {
        const r = await kankaHttp(ctx, cfg, 'GET', `${kankaBase(cfg)}/campaigns/${encodeURIComponent(String(cfg.campaignId))}`);
        if (r.status === 401) return { ok: false, reason: 'Kanka did not accept that key.' };
        if (r.status === 403 || r.status === 404) return { ok: false, reason: `That key cannot read this world's Kanka campaign (${cfg.campaignId}). It may belong to another campaign.` };
        if (r.status !== 200) return { ok: false, reason: `Kanka answered ${r.status} when checking the key.` };
        const got = String(r.body?.data?.id ?? '');
        return got === String(cfg.campaignId) ? { ok: true, reason: `The key can read campaign ${got}.` } : { ok: false, reason: `That key read campaign ${got || 'unknown'}, not this world's campaign ${cfg.campaignId}.` };
      }
      if (c.id === 'legendkeeper-api') {
        const t = restTransport(ctx, cfg.apiUrl, cfg.apiKey);
        try {
          const j = await t.get('/resources', { limit: 1 });
          const first = (Array.isArray(j?.data) ? j.data : [])[0];
          if (first?.id !== undefined) await t.get(`/resources/${encodeURIComponent(String(first.id))}`);
          return { ok: true, reason: 'The key can read this world\'s LegendKeeper project.' };
        } catch (e: any) { return { ok: false, reason: `That key cannot read this world's LegendKeeper project (${say(e)}).` }; }
      }
      try {
        const t = await c.test(cfg, ctx);
        return t.ok ? { ok: true, reason: 'The key can read this world\'s list in the source.' } : { ok: false, reason: `The key did not work with this world's source: ${t.message}` };
      } catch (e: any) { return { ok: false, reason: `The key did not work with this world's source (${say(e)}).` }; }
    });
  } catch (e: any) {
    if (e instanceof KeyRefused) throw e;
    return { ok: false, reason: `Could not check the key: ${say(e)}` };
  }
}

export interface Probe { verdict: 'sees-everything' | 'sees-less' | 'unknown'; keyCount: number | null; dmCount: number | null; note: string }

/**
 * Help the GM decide the trust question. Kanka: the number of entities the key
 * can list against the number the GM's own connection lists. Equal looks like
 * a blanket key; fewer looks like per-user permissions. Not a proof, so it only
 * ever informs: it never changes trust. Other sources: unknown.
 */
export async function probeKey(d: Deps, src: SourceRow, secret: string): Promise<Probe> {
  const unknown = (note: string): Probe => ({ verdict: 'unknown', keyCount: null, dmCount: null, note });
  try {
    const { c } = keyConnector(d, src);
    if (c.id !== 'kanka-api') return unknown('Alexandria cannot compare this kind of source. Treated as a blanket key until the GM says otherwise.');
    const count = (tok: string) => withKey(d, src, tok, async ({ cfg, ctx }) => {
      const r = await kankaHttp(ctx, cfg, 'GET', `${kankaBase(cfg)}/campaigns/${encodeURIComponent(String(cfg.campaignId))}/entities?page=1`);
      if (r.status !== 200) return null;
      const n = Number(r.body?.meta?.total ?? (Array.isArray(r.body?.data) ? r.body.data.length : NaN));
      return Number.isFinite(n) ? n : null;
    });
    const dmToken = String(effectiveConfig(d.db, src).token ?? '');
    const [keyCount, dmCount] = [await count(secret), dmToken ? await count(dmToken) : null];
    if (keyCount === null || dmCount === null) return unknown('Could not count what the key and the GM connection can see.');
    if (keyCount >= dmCount) return { verdict: 'sees-everything', keyCount, dmCount, note: `This key lists ${keyCount} entities, as many as the GM connection (${dmCount}): it looks like a blanket key.` };
    return { verdict: 'sees-less', keyCount, dmCount, note: `This key lists ${keyCount} of the ${dmCount} entities the GM connection lists: it looks like per-user permissions.` };
  } catch (e: any) {
    return unknown(`The probe failed: ${say(e)}`);
  }
}

/** The external ids of every page this key can see in the source (a full listing; nothing is stored from it but the ids). */
export async function listVisible(d: Deps, src: SourceRow, secret: string): Promise<Set<string>> {
  return withKey(d, src, secret, async ({ c, cfg, ctx }) => {
    const ids = new Set<string>();
    for await (const e of c.sync(cfg, ctx)) { if (!isRecord(e) && e?.externalId) ids.add(String(e.externalId)); }
    return ids;
  }, 5 * 60_000);
}

export interface LiveHit { externalId: string; title: string }

const terms = (q: string) => (q.toLowerCase().match(/[\p{L}\p{N}']{2,}/gu) ?? []).slice(0, 8);

/**
 * Search the source live with this key. Only ids and titles come back: what a
 * player is shown is always a stored copy of the page (see lookup.ts), never
 * text the source sent now, which carries no secrecy markers we have checked.
 */
export async function searchLive(d: Deps, src: SourceRow, secret: string, q: string, limit = 12): Promise<LiveHit[]> {
  return withKey(d, src, secret, async ({ c, cfg, ctx }) => {
    const want = terms(q);
    if (c.id === 'kanka-api') {
      const r = await kankaHttp(ctx, cfg, 'GET', `${kankaBase(cfg)}/campaigns/${encodeURIComponent(String(cfg.campaignId))}/search/${encodeURIComponent(q.slice(0, 100))}`);
      if (r.status !== 200) throw new Error(`Kanka answered ${r.status}`);
      return (Array.isArray(r.body?.data) ? r.body.data : []).slice(0, limit).filter((x: any) => (x?.entity_id ?? x?.id) != null).map((x: any) => ({ externalId: `kanka:${x.entity_id ?? x.id}`, title: String(x.name ?? '') }));
    }
    if (c.id === 'legendkeeper-api') {
      const t = restTransport(ctx, cfg.apiUrl, cfg.apiKey);
      const out: LiveHit[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10 && out.length < limit; i++) {
        const j = await t.get('/resources', { limit: 100, ...(cursor ? { cursor } : {}) });
        for (const r of Array.isArray(j?.data) ? j.data : []) if (want.some((w) => String(r.name ?? '').toLowerCase().includes(w))) out.push({ externalId: String(r.id), title: String(r.name ?? '') });
        if (!j?.hasMore || !j?.nextCursor) break;
        cursor = String(j.nextCursor);
      }
      return out.slice(0, limit);
    }
    const out: LiveHit[] = [];
    let seen = 0;
    for await (const e of c.sync(cfg, ctx)) {
      if (isRecord(e) || !e?.externalId) continue;
      if (want.some((w) => String(e.title ?? '').toLowerCase().includes(w))) out.push({ externalId: String(e.externalId), title: String(e.title ?? '') });
      if (out.length >= limit || ++seen > 2000) break;
    }
    return out;
  });
}
