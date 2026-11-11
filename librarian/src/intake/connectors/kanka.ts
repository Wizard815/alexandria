// Kanka, through its API (token + campaign) or the mcp-kanka server.
// Private entities are DM-only. Posts are added as sections: shared posts
// (visibility all or members) stay visible, every other post becomes a secret
// block. Private attributes go in a DM-only property group.
import type { Connector, ConnectorContext } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, type Inline, markdownToBlocks } from '../model.ts';
import { jsonOf } from '../../core/mcp.ts';
import { htmlToMarkdown } from '../html.ts';

const TYPES: [string, string, string | null][] = [
  // [API module, Alexandria type, parent field]
  ['characters', 'character', null], ['locations', 'location', 'location_id'], ['organisations', 'organisation', 'organisation_id'],
  ['families', 'family', 'family_id'], ['items', 'item', 'item_id'], ['notes', 'note', 'note_id'], ['journals', 'journal', 'journal_id'],
  ['quests', 'quest', 'quest_id'], ['races', 'race', 'race_id'], ['creatures', 'creature', 'creature_id'], ['events', 'event', 'event_id'],
  ['abilities', 'ability', 'ability_id'], ['timelines', 'timeline', null], ['maps', 'map', 'map_id'],
];
const PLAYER_VISIBLE = new Set([1, 5]); // visibility_id: 1 all, 5 members

/** Kanka text (HTML or Markdown, with [entity:ID|label] mentions) to blocks with mention refs. */
export function kankaBlocks(raw: unknown): Block[] {
  let s = String(raw ?? '');
  s = s.replace(/\[entity:(\d+)(?:\|([^\]]+))?\]/g, (_m, id, label) => `[[@kanka:${id}${label ? '|' + label : ''}]]`);
  if (/<\/?(p|br|div|span|strong|em|ul|ol|li|h\d|a|table|blockquote)\b/i.test(s)) s = htmlToMarkdown(s);
  else s = s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  return fixRefs(markdownToBlocks(s));
}

function fixRefs(bs: Block[]): Block[] {
  const il = (c?: Inline[]) => c?.forEach((x) => {
    if (x.mention?.name?.startsWith('@kanka:')) {
      x.mention = { ref: x.mention.name.slice(1), ...(x.mention.text ? { text: x.mention.text } : {}) };
    }
  });
  const walk = (b: Block[]) => b.forEach((x) => { if ('content' in x) il(x.content); if ('title' in x && Array.isArray((x as any).title)) il((x as any).title); if ('children' in x) walk(x.children); });
  walk(bs);
  return bs;
}

const esc = (s: unknown) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

function postBlocks(posts: any[], trust: (p: any) => boolean): Block[] {
  const out: Block[] = [];
  for (const p of posts) {
    const section: Block[] = [{ kind: 'heading', level: 2, content: [{ text: esc(p.name) || 'Post' }] }, ...kankaBlocks(p.entry)];
    if (trust(p)) out.push(...section);
    else out.push({ kind: 'secret', children: section });
  }
  return out;
}

// ---------- API ----------

async function* kankaApiSync(cfg: any, ctx: ConnectorContext): AsyncIterable<Entry> {
  const base = String(cfg.apiUrl || 'https://api.kanka.io/1.0').replace(/\/$/, '');
  const get = async (url: string) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await ctx.fetch(url, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }, signal: ctx.signal });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 15_000 * (attempt + 1))); continue; } // Kanka rate limit
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Kanka answered ${r.status} for ${url.replace(base, '')}`);
      return r.json() as Promise<any>;
    }
    throw new Error('Kanka kept rate-limiting; try again later');
  };
  const rows: { type: string; parentField: string | null; e: any }[] = [];
  for (const [mod, type, parentField] of TYPES) {
    let url: string | null = `${base}/campaigns/${cfg.campaignId}/${mod}?related=1&page=1`;
    for (let n = 0; url && n < 500; n++) {
      const j: any = await get(url);
      if (!j) break;
      for (const e of j.data ?? []) rows.push({ type, parentField, e });
      url = j.links?.next ?? null;
    }
  }
  ctx.log(`Listed ${rows.length} entities`);
  const childToEntity = new Map<string, string>(rows.map(({ type, e }) => [`${type}:${e.id}`, String(e.entity_id ?? e.id)]));
  for (const { type, parentField, e } of rows) {
    const entityId = String(e.entity_id ?? e.id);
    const pid = parentField && e[parentField] ? childToEntity.get(`${type}:${e[parentField]}`) : undefined;
    const attrs = (e.attributes ?? []).filter((a: any) => a?.name && a.type_id !== 4);
    yield {
      externalId: `kanka:${entityId}`,
      parentExternalId: pid ? `kanka:${pid}` : null,
      folder: [type[0].toUpperCase() + type.slice(1) + 's'],
      title: esc(e.name),
      tags: [],
      type,
      icon: null,
      banner: typeof e.image_full === 'string' && /^https?:/.test(e.image_full) && !/default/.test(e.image_full) ? e.image_full : null,
      properties: [
        ...(e.type ? [{ title: 'Facts', rows: [{ key: 'Type', value: [{ text: esc(e.type) }] }] }] : []),
        ...(attrs.some((a: any) => !a.is_private) ? [{ title: 'Attributes', rows: attrs.filter((a: any) => !a.is_private).map((a: any) => ({ key: esc(a.name), value: [{ text: esc(a.value) }] })) }] : []),
        ...(attrs.some((a: any) => a.is_private) ? [{ title: 'Private attributes', dm: true, rows: attrs.filter((a: any) => a.is_private).map((a: any) => ({ key: esc(a.name), value: [{ text: esc(a.value) }] })) }] : []),
      ],
      blocks: [...kankaBlocks(e.entry ?? e.entry_parsed), ...postBlocks(e.posts ?? [], (p) => PLAYER_VISIBLE.has(Number(p.visibility_id)))],
      // Kanka's own private flag always wins; a missing flag counts as private.
      visibility: e.is_private === false && ctx.shareVisible ? 'party' : 'dm',
      url: e.urls?.view ?? null,
      updatedAt: e.updated_at ?? null,
    };
  }
}

export const kankaApi: Connector = {
  id: 'kanka-api',
  label: 'Kanka (API token)',
  description: 'Reads a Kanka campaign with a personal API token. Private entities, private posts and private attributes stay DM-only.',
  aliases: ['kanka'],
  fields: [
    { key: 'campaignId', label: 'Campaign id', type: 'text', required: true, help: 'The number in your campaign’s address.' },
    { key: 'token', label: 'API token', type: 'password', secret: true, required: true, help: 'Kanka → Settings → API.' },
    { key: 'apiUrl', label: 'API URL', type: 'url', placeholder: 'https://api.kanka.io/1.0', help: 'Only change this for a self-hosted Kanka.' },
  ],
  validate(cfg) {
    if (!/^\d+$/.test(String(cfg.campaignId ?? ''))) throw new ConfigError('Campaign id must be a number');
    if (String(cfg.token ?? '').length < 20) throw new ConfigError('API token is required');
  },
  async test(cfg, ctx) {
    const base = String(cfg.apiUrl || 'https://api.kanka.io/1.0').replace(/\/$/, '');
    const r = await ctx.fetch(`${base}/campaigns/${cfg.campaignId}/characters?page=1`, { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' }, signal: ctx.signal });
    if (!r.ok) return { ok: false, message: `Kanka answered ${r.status}. Check the token and campaign id.` };
    const j: any = await r.json();
    return { ok: true, message: `Connected. ${j.meta?.total ?? (j.data ?? []).length} characters.`, sample: (j.data ?? []).slice(0, 5).map((e: any) => e.name) };
  },
  sync: kankaApiSync,
};

// ---------- MCP (mcp-kanka) ----------

const MCP_TYPES = ['character', 'creature', 'family', 'location', 'organization', 'race', 'note', 'journal', 'quest', 'event', 'ability'];

async function* kankaMcpSync(cfg: any, ctx: ConnectorContext): AsyncIterable<Entry> {
  const mcp = ctx.mcp();
  const listed: any[] = [];
  for (const type of MCP_TYPES) {
    for (let page = 1; page <= 200; page++) {
      // Without last_synced, an unfiltered listing times out on big campaigns.
      const res = await mcp.call('find_entities', { entity_type: type, include_full: false, last_synced: '2000-01-01T00:00:00Z', limit: 100, page });
      if (res.isError) { if (page === 1) break; throw new Error(`find_entities ${type}: ${res.text.slice(0, 160)}`); }
      const j = jsonOf(res);
      const list: any[] = Array.isArray(j) ? j : j?.entities ?? [];
      listed.push(...list.filter((e) => e?.entity_id));
      const last = Number(j?.sync_info?.last_page ?? 0);
      if (!list.length || (last ? page >= last : list.length < 100)) break;
    }
  }
  ctx.log(`Listed ${listed.length} entities`);
  const trust = cfg.trustPostVisibility === true;
  const ids = listed.map((e) => Number(e.entity_id));
  for (let i = 0; i < ids.length; i += 8) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const res = await mcp.call('get_entities', { entity_ids: ids.slice(i, i + 8), include_posts: cfg.includePosts !== false });
    const j = jsonOf(res);
    const got = new Map<number, any>((Array.isArray(j) ? j : j?.entities ?? []).filter((e: any) => e?.success !== false && e?.entity_id).map((e: any) => [Number(e.entity_id), e]));
    for (const id of ids.slice(i, i + 8)) {
      const e = got.get(id);
      const base = listed.find((x) => Number(x.entity_id) === id);
      yield {
        externalId: `kanka:${id}`,
        parentExternalId: e?.parent_id ? `kanka:${e.parent_id}` : null,
        folder: [String(base?.entity_type ?? 'entity').replace(/^./, (c) => c.toUpperCase()) + 's'],
        title: esc(base?.name ?? e?.name ?? `Entity ${id}`),
        tags: Array.isArray(e?.tags) ? e.tags.map((t: any) => esc(typeof t === 'object' ? t.name : t)) : [],
        type: base?.entity_type ?? e?.entity_type ?? 'entity',
        banner: typeof e?.image_full === 'string' && /^https?:/.test(e.image_full) ? e.image_full : null,
        properties: e?.type ? [{ title: 'Facts', rows: [{ key: 'Type', value: [{ text: esc(e.type) }] }] }] : [],
        // Older mcp-kanka builds reported admin-only posts as visible, so posts
        // are secret unless the admin trusts this server's post visibility.
        blocks: e ? [...kankaBlocks(e.entry), ...postBlocks(e.posts ?? [], (p) => trust && p.is_hidden === false)] : [],
        // Not loaded, or no explicit is_hidden=false: DM-only.
        visibility: e && e.is_hidden === false && ctx.shareVisible ? 'party' : 'dm',
        updatedAt: e?.updated_at ?? null,
      };
    }
  }
}

export const kankaMcp: Connector = {
  id: 'kanka-mcp',
  label: 'Kanka (mcp-kanka server)',
  description: 'Reads a Kanka campaign through the mcp-kanka MCP server, read tools only.',
  aliases: ['mcp:kanka'],
  fields: [
    { key: 'transport', label: 'Connection', type: 'select', options: [['stdio', 'Local server (ALX_MCP_STDIO)'], ['http', 'HTTP URL']], default: 'stdio' },
    { key: 'server', label: 'Local server name', type: 'text', showIf: { transport: 'stdio' }, placeholder: 'kanka' },
    { key: 'url', label: 'MCP URL', type: 'url', showIf: { transport: 'http' } },
    { key: 'token', label: 'MCP token', type: 'password', secret: true, showIf: { transport: 'http' } },
    { key: 'trustPostVisibility', label: 'Trust post visibility', type: 'boolean', help: 'Only with mcp-kanka that includes the admin-post fix (a4bbb02). Off: every post is DM-only.' },
  ],
  validate(cfg) {
    if ((cfg.transport ?? (cfg.url ? 'http' : 'stdio')) === 'stdio') { if (!/^[\w-]{1,40}$/.test(String(cfg.server ?? ''))) throw new ConfigError('Pick the local server name from ALX_MCP_STDIO'); }
    else if (!/^https?:\/\/\S+$/.test(String(cfg.url ?? ''))) throw new ConfigError('MCP URL must start with http:// or https://');
  },
  async test(cfg, ctx) {
    const res = await ctx.mcp().call('find_entities', { entity_type: 'character', include_full: false, last_synced: '2000-01-01T00:00:00Z', limit: 5, page: 1 });
    const j = jsonOf(res);
    if (res.isError) return { ok: false, message: res.text.slice(0, 200) };
    return { ok: true, message: `Connected. ${j?.sync_info?.total_count ?? '?'} characters.`, sample: (j?.entities ?? []).map((e: any) => e.name) };
  },
  sync: kankaMcpSync,
  readTools: () => ['find_entities', 'get_entities'],
};
