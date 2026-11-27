// Obsidian Portal (obsidianportal.com) as a world source, through its API v1 (help.obsidianportal.com, "API Overview", "Wiki Pages",
// "Characters"). Read-only.
//
//   Auth      OAuth 1.0a, HMAC-SHA1: a consumer key and secret (register an app at www.obsidianportal.com/oauth/clients/new), plus an access
//             token and secret for the GM's account (scripts/obsidian-portal-login.ts walks the PIN flow once).
//   Campaign  GET /v1/users/me.json                                   the GM's campaigns
//   Listing   GET /v1/campaigns/{id}/wikis.json                       wiki pages and adventure-log posts, without their text
//             GET /v1/campaigns/{id}/characters.json                  characters, without their text
//   Pages     GET /v1/campaigns/{id}/wikis/{page}.json                body_html, game_master_info(_html|_markup), is_game_master_only
//             GET /v1/campaigns/{id}/characters/{character}.json      description_html, bio_html, game master info, visibility
//
// Who may read what (fails closed): a page or character is the players' only when Obsidian Portal says is_game_master_only is false
// (and, for a character, its visibility is public or friends). The GM-only info of a shared page is a secret block.
import { createHmac, randomBytes } from 'node:crypto';
import type { Connector, ConnectorContext, SyncItem } from '../connector.ts';
import { ConfigError } from '../connector.ts';
import { type Block, type Entry, type Inline, type PropertyRow, indexBlocks, markdownToBlocks } from '../model.ts';
import { htmlToMarkdown } from '../html.ts';

export const OP_API = 'https://api.obsidianportal.com/v1';
export const OP_SITE = 'https://www.obsidianportal.com';
const OK_ID = /^[\w-]{1,64}$/;

// ---------- OAuth 1.0a ----------

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
export const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * The Authorization header for one request (OAuth 1.0a, HMAC-SHA1, RFC 5849 §3.4): the signature base string is the method, the URL
 * without its query, and every query and oauth_ parameter sorted. `extra` adds oauth_ parameters (oauth_callback, oauth_verifier).
 */
export function oauthHeader(method: string, url: string, keys: { consumerKey: string; consumerSecret: string; token?: string; tokenSecret?: string }, extra: Record<string, string> = {}, nonce = randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: timestamp, oauth_version: '1.0',
    ...(keys.token ? { oauth_token: keys.token } : {}), ...extra,
  };
  const params: [string, string][] = [...u.searchParams.entries(), ...Object.entries(oauth)].map(([k, v]) => [pct(k), pct(v)]);
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), pct(`${u.protocol}//${u.host}${u.pathname}`), pct(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const sig = createHmac('sha1', `${pct(keys.consumerSecret)}&${pct(keys.tokenSecret ?? '')}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: sig }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}

/** The app's consumer key and secret: the connection's, else the server's (ALX_OBSIDIANPORTAL_KEY / ALX_OBSIDIANPORTAL_SECRET). */
export function opKeys(cfg: Record<string, any>, env: Record<string, string | undefined>) {
  return {
    consumerKey: String(cfg.consumerKey || env.ALX_OBSIDIANPORTAL_KEY || ''),
    consumerSecret: String(cfg.consumerSecret || env.ALX_OBSIDIANPORTAL_SECRET || ''),
    token: String(cfg.accessToken ?? ''), tokenSecret: String(cfg.accessSecret ?? ''),
  };
}

/** One signed GET to the API (never another host). Retries 429 and 503 after a short wait. */
async function opGet(ctx: ConnectorContext, cfg: Record<string, any>, path: string, query: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const u = new URL(OP_API + path);
  if (u.origin + u.pathname !== OP_API + path || !u.pathname.startsWith('/v1/')) throw new Error('Refusing a request outside the Obsidian Portal API');
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    await ctx.calls?.take();
    const r = await ctx.fetch(u.toString(), { headers: { Authorization: oauthHeader('GET', u.toString(), opKeys(cfg, ctx.env)), Accept: 'application/json' }, signal: ctx.signal });
    if ((r.status === 429 || r.status === 503) && attempt < 3) {
      const wait = Math.min(30, Math.max(1, Number(r.headers.get('retry-after')) || 2 ** (attempt + 1)));
      ctx.log(`Obsidian Portal asked to slow down; waiting ${wait}s`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    const text = await r.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: r.status, body };
  }
}

async function opCall(ctx: ConnectorContext, cfg: Record<string, any>, path: string): Promise<any> {
  const r = await opGet(ctx, cfg, path);
  if (r.status === 401) throw new Error('Obsidian Portal refused the keys (401): check the consumer key and secret and the access token');
  if (r.status === 403) throw new Error('Obsidian Portal said this account may not read that campaign (403)');
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw new Error(`Obsidian Portal answered ${r.status} for ${path}`);
  return r.body;
}

// ---------- pages ----------

const abs = (u: unknown) => {
  const s = String(u ?? '');
  if (/^https?:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  return s.startsWith('/') ? OP_SITE + s : null;
};
const slugOf = (u: unknown) => /\/(?:wikis|characters)\/([^/?#]+)/.exec(String(u ?? ''))?.[1]?.toLowerCase() ?? null;

/** What a sync knows about the campaign: page slugs to ids (for links between pages), and which ids are characters. */
export interface OpLookups { bySlug: Record<string, string> }

/** Rendered HTML to blocks. Links to other pages of the campaign become links to those pages here. */
export function opBlocks(html: unknown, lk: OpLookups): Block[] {
  const s = String(html ?? '').replace(/<a\b[^>]*href="([^"]*\/(?:wikis|characters)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
    const id = lk.bySlug[slugOf(href) ?? ''];
    return id ? `[[@op:${id}|${String(label).replace(/<[^>]+>/g, '').replace(/[[\]|]/g, ' ').trim()}]]` : m;
  });
  const blocks = markdownToBlocks(htmlToMarkdown(s));
  const il = (c?: Inline[]) => c?.forEach((x) => { if (x.mention?.name?.startsWith('@op:')) x.mention = { ref: x.mention.name.slice(1), ...(x.mention.text ? { text: x.mention.text } : {}) }; });
  const walk = (b: Block[]) => b.forEach((x) => { if ('content' in x) il(x.content); if ('title' in x && Array.isArray((x as any).title)) il((x as any).title); if ('children' in x) walk(x.children); });
  walk(blocks);
  return blocks;
}

/** The players may read it: Obsidian Portal says it is not GM-only (and a character is public or for friends). Anything unsure is the GM's. */
export function opShared(x: any, character: boolean): boolean {
  if (x?.is_game_master_only !== false) return false;
  if (character) return x.visibility === 'public' || x.visibility === 'friends';
  return true;
}

const tagList = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 40);
const gmHtml = (x: any) => x?.game_master_info_html ?? x?.game_master_info_markup ?? (x?.game_master_info ? `<p>${String(x.game_master_info).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</p>` : '');

/** A wiki page or adventure-log post read in full. */
export function opWikiEntry(x: any, lk: OpLookups, shareVisible: boolean): Entry {
  const post = String(x.type ?? '') === 'Post';
  const shared = opShared(x, false);
  const facts: PropertyRow[] = [];
  if (post && x.post_title) facts.push({ key: 'Title', value: [{ text: String(x.post_title) }] });
  if (post && x.post_tagline) facts.push({ key: 'Tagline', value: [{ text: String(x.post_tagline) }] });
  if (post && x.post_time) facts.push({ key: 'Date', value: [{ text: String(x.post_time).slice(0, 10) }] });
  const blocks: Block[] = opBlocks(x.body_html ?? (x.body ? `<p>${x.body}</p>` : ''), lk);
  const gm = gmHtml(x);
  if (String(gm).trim()) blocks.push({ kind: 'secret', children: [{ kind: 'heading', level: 2, content: [{ text: 'GM info' }] }, ...opBlocks(gm, lk)] });
  return {
    externalId: `op:${x.id}`, folder: [post ? 'Adventure Log' : 'Wiki'], title: String(x.name ?? x.post_title ?? 'Untitled'), tags: tagList(x.tags), type: post ? 'post' : 'page',
    properties: facts.length ? [{ title: 'Post', rows: facts }] : [], blocks,
    visibility: shared && shareVisible ? 'party' : 'dm', sourceShared: shared, url: abs(x.wiki_page_url),
    updatedAt: x.updated_at ?? null, sourceUpdatedAt: x.updated_at ?? null, depth: 'full',
  };
}

/** A character read in full: tagline and player facts, description, bio, and the GM-only info as a secret. */
export function opCharacterEntry(x: any, lk: OpLookups, shareVisible: boolean): Entry {
  const shared = opShared(x, true);
  const facts: PropertyRow[] = [];
  if (x.tagline) facts.push({ key: 'Tagline', value: [{ text: String(x.tagline) }] });
  if (typeof x.is_player_character === 'boolean') facts.push({ key: 'Player character', value: [{ text: x.is_player_character ? 'Yes' : 'No' }] });
  if (x.author?.username) facts.push({ key: 'Player', value: [{ text: String(x.author.username) }] });
  const blocks: Block[] = [];
  for (const [title, html] of [['Description', x.description_html ?? x.description], ['Bio', x.bio_html ?? x.bio]] as const) {
    if (!String(html ?? '').trim()) continue;
    blocks.push({ kind: 'heading', level: 2, content: [{ text: title }] }, ...opBlocks(html, lk));
  }
  const gm = gmHtml(x);
  if (String(gm).trim()) blocks.push({ kind: 'secret', children: [{ kind: 'heading', level: 2, content: [{ text: 'GM info' }] }, ...opBlocks(gm, lk)] });
  return {
    externalId: `op:${x.id}`, folder: ['Characters'], title: String(x.name ?? 'Unnamed'), tags: tagList(x.tags), type: 'character',
    banner: abs(x.avatar_url), properties: facts.length ? [{ title: 'Character', rows: facts }] : [], blocks,
    visibility: shared && shareVisible ? 'party' : 'dm', sourceShared: shared, url: abs(x.character_url),
    updatedAt: x.updated_at ?? null, sourceUpdatedAt: x.updated_at ?? null, depth: 'full',
  };
}

// ---------- listing ----------

interface OpCache { c: string; k: Record<string, 'w' | 'c'>; s: Record<string, string> }

/** The campaign id: the source's, or found by name, slug or address among the account's campaigns. */
async function campaignOf(cfg: Record<string, any>, ctx: ConnectorContext): Promise<string> {
  const want = String(cfg.campaign ?? '').trim();
  const me = await opCall(ctx, cfg, '/users/me.json');
  const list: any[] = Array.isArray(me?.campaigns) ? me.campaigns : [];
  const slug = (/\/campaigns\/([^/?#]+)/.exec(want)?.[1] ?? want).toLowerCase();
  const hit = list.find((c) => [c.id, c.slug, c.name].map((v) => String(v ?? '').toLowerCase()).includes(slug) || String(c.campaign_url ?? '').toLowerCase().includes(`/campaigns/${slug}`));
  if (hit && OK_ID.test(String(hit.id))) return String(hit.id);
  if (OK_ID.test(want) && !list.length) return want; // the account list said nothing: take the id as given
  throw new Error(`No campaign "${want}" among this account's campaigns: ${list.map((c) => c.name).join(', ') || 'none'}`);
}

async function* opIndex(cfg: Record<string, any>, ctx: ConnectorContext, state: { prev: OpCache | null; next?: OpCache }): AsyncIterable<SyncItem> {
  const cid = state.prev?.c && state.prev.c === String(cfg.campaign ?? '') ? state.prev.c : await campaignOf(cfg, ctx);
  const wikis: any[] = (await opCall(ctx, cfg, `/campaigns/${cid}/wikis.json`)) ?? [];
  let chars: any[] = [];
  if (cfg.importCharacters !== false) chars = (await opCall(ctx, cfg, `/campaigns/${cid}/characters.json`).catch((err) => { if (ctx.signal.aborted) throw err; ctx.log(`Could not list characters: ${err.message}`); return []; })) ?? [];
  const cache: OpCache = { c: cid, k: {}, s: {} };
  const rows = [...(Array.isArray(wikis) ? wikis : []).map((x) => ['w', x] as const), ...(Array.isArray(chars) ? chars : []).map((x) => ['c', x] as const)].filter(([, x]) => OK_ID.test(String(x?.id ?? '')));
  for (const [k, x] of rows) { cache.k[String(x.id)] = k; const s = String(x.slug ?? slugOf(x.wiki_page_url ?? x.character_url) ?? '').toLowerCase(); if (s) cache.s[s] = String(x.id); }
  state.next = cache;
  ctx.log(`Listed ${wikis.length} wiki pages and posts and ${chars.length} characters`);
  for (const [k, x] of rows) {
    const post = k === 'w' && String(x.type ?? '') === 'Post';
    const type = k === 'c' ? 'character' : post ? 'post' : 'page';
    const title = String(x.name ?? 'Untitled');
    const tags = tagList(x.tags);
    yield {
      externalId: `op:${x.id}`, folder: [k === 'c' ? 'Characters' : post ? 'Adventure Log' : 'Wiki'], title, tags, type, blocks: indexBlocks({ title, type, tags }),
      url: abs(k === 'c' ? x.character_url : x.wiki_page_url),
      // The list may leave is_game_master_only out; only an explicit GM-only (or private character) is restricted at once.
      visibility: 'dm', restricted: x.is_game_master_only === true || (k === 'c' && x.visibility === 'private'), updatedAt: x.updated_at ?? null, sourceUpdatedAt: x.updated_at ?? null, depth: 'index',
    } satisfies Entry;
  }
}

async function* opDetail(cfg: Record<string, any>, ctx: ConnectorContext, ids: string[], cache: OpCache | null): AsyncIterable<SyncItem> {
  if (!cache?.c) return;
  const lk: OpLookups = { bySlug: cache.s };
  for (const e of ids) {
    if (ctx.signal.aborted) throw new Error('Sync stopped');
    const id = e.replace(/^op:/, '');
    if (!OK_ID.test(id)) continue;
    const character = cache.k[id] === 'c';
    const x = await opCall(ctx, cfg, `/campaigns/${cache.c}/${character ? 'characters' : 'wikis'}/${id}.json`);
    if (x) yield character ? opCharacterEntry(x, lk, ctx.shareVisible) : opWikiEntry(x, lk, ctx.shareVisible);
  }
}

export const obsidianPortal: Connector = {
  id: 'obsidian-portal',
  label: 'Obsidian Portal',
  description: 'Reads an Obsidian Portal campaign: wiki pages, the adventure log and characters. GM-only pages and GM info stay GM-only.',
  capabilities: ['pages', 'properties', 'tags', 'images', 'characters', 'relations'],
  fields: [
    { key: 'campaign', label: 'Campaign', type: 'text', required: true, help: 'Its name, slug or address (https://<campaign>.obsidianportal.com or …/campaigns/<slug>).' },
    { key: 'accessToken', label: 'Access token', type: 'password', secret: true, required: true, help: 'From the one-time sign-in: npm run --prefix librarian op-login (it prints the token and secret).' },
    { key: 'accessSecret', label: 'Access token secret', type: 'password', secret: true, required: true },
    { key: 'consumerKey', label: 'App consumer key', type: 'password', secret: true, help: 'From www.obsidianportal.com/oauth/clients/new. Leave empty if the server sets ALX_OBSIDIANPORTAL_KEY.' },
    { key: 'consumerSecret', label: 'App consumer secret', type: 'password', secret: true, help: 'Leave empty if the server sets ALX_OBSIDIANPORTAL_SECRET.' },
    { key: 'importCharacters', label: 'Import characters', type: 'boolean', default: true },
  ],
  validate(cfg, ctx) {
    if (!String(cfg.campaign ?? '').trim()) throw new ConfigError('Campaign is required');
    const k = opKeys(cfg, ctx.env);
    if (!k.consumerKey || !k.consumerSecret) throw new ConfigError('The app consumer key and secret are required (or set ALX_OBSIDIANPORTAL_KEY and ALX_OBSIDIANPORTAL_SECRET on the server)');
    if (!k.token || !k.tokenSecret) throw new ConfigError('The access token and its secret are required: run the one-time sign-in (op-login)');
  },
  async test(cfg, ctx) {
    const me = await opGet(ctx, cfg, '/users/me.json');
    if (me.status === 401) return { ok: false, message: 'Obsidian Portal refused the keys. Check the consumer key and secret, and run the sign-in again for a new access token.' };
    if (me.status !== 200) return { ok: false, message: `Obsidian Portal answered ${me.status}.` };
    const camps: any[] = Array.isArray(me.body?.campaigns) ? me.body.campaigns : [];
    try { await campaignOf(cfg, ctx); } catch (err: any) { return { ok: false, message: `Signed in as ${me.body?.username ?? 'you'}, but ${err.message}.`, sample: camps.map((c) => c.name) }; }
    return { ok: true, message: `Signed in as ${me.body?.username ?? 'you'}.`, sample: camps.map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}`).slice(0, 10) };
  },
  async *sync(cfg, ctx) {
    const state: { prev: OpCache | null; next?: OpCache } = { prev: null };
    const ids: string[] = [];
    for await (const x of opIndex(cfg, ctx, state)) ids.push((x as Entry).externalId);
    const prev = ctx.calls?.phase;
    if (ctx.calls) ctx.calls.phase = 'detail';
    try { yield* opDetail(cfg, ctx, ids, state.next ?? null); } finally { if (ctx.calls && prev) ctx.calls.phase = prev; }
  },
  // Obsidian Portal publishes no limit: stay gentle (see DEFAULT_LIMITS).
  tiered: () => ({
    budgetPerMinute: 24,
    index: async function* (cfg, ctx) {
      const state: { prev: OpCache | null; next?: OpCache } = { prev: (ctx.tier?.cache ?? null) as OpCache | null };
      yield* opIndex(cfg, ctx, state);
      if (ctx.tier) { ctx.tier.complete = true; ctx.tier.next = { token: null, cache: (state.next ?? null) as unknown as Record<string, any> }; }
    },
    detail: (cfg, ctx, ids) => opDetail(cfg, ctx, ids, (ctx.tier?.cache ?? null) as OpCache | null),
  }),
};
