# World sources and connectors

Alexandria is meant to manage any D&D world, wherever it lives. Each kind
of source has a **connector**. A connector reads the source (read-only)
and turns what it finds into Alexandria **entries**. Everything after that
is the same for every source:
- storage
- the leak guard
- search
- the Library view
- offline copies
- the information broker
- AI tools

## Connectors that ship

| Connector | Reads | How DM-only content is found |
|---|---|---|
| `legendkeeper-mcp` | LegendKeeper through its MCP server (`api_request` GET only) | Hidden resources, hidden ancestors, hidden documents, "No Access" permissions on a resource or ancestor, `secret` blocks, hidden sidebar and infobox properties |
| `legendkeeper-api` | LegendKeeper REST v3 (`https://www.legendkeeper.com/api/v3/projects/<id>`) with an Admin API key; waits out 429s | Same |
| `kanka-api` | Kanka API with a token (`?related=1` on every page, waits out 429s) | `is_private` entities, posts not "all"/"members" or with a deny permission, private attributes, `is_attributes_private`, hidden personality traits, private races and families, private tags |
| `worldanvil-api` | World Anvil API v2 ("Boromir") with an application key and a user token; waits out 429s (see "World Anvil") | Drafts, `private` articles, categories, maps, markers and events (unless shared with a player subscriber group), `[secret:id]` secrets, `[subcontainer:id]`, `[userstate:…]`, `/* comments */`, storyteller seeds (unless shown) and the scrapbook |
| `notion-api` | Notion's public API with an internal integration token: pages and databases shared with the integration (see "Notion") | No `Visibility` of party on a database row and not published to the web; toggles, toggle headings and callouts titled Secret, DM or GM |
| `obsidian-portal` | Obsidian Portal API v1 (OAuth 1.0a): wiki pages, adventure log and characters (see "Obsidian Portal") | `is_game_master_only` (or not said), `private` characters, GM info |
| `kanka-mcp` | The mcp-kanka server (`find_entities`, `get_entities`) | `is_hidden`. Posts are DM-only unless "trust post visibility" is on. |
| `markdown-folder` | A vault on the server (Obsidian, Lokus, Otterly) | No `visibility: party`; plus `secret:` frontmatter, `> [!secret]`, `%% %%`, `<!-- dm -->`, DM headings |
| `obsidian-sync` | An Obsidian Sync vault (yours or shared with you), brought to the server by Obsidian's official headless client `ob` (see "Obsidian") | Same as Markdown |
| `obsidian-rest` | The vault open in Obsidian, through the Local REST API community plugin | Same as Markdown |
| `obsidian-publish` | A site published with Obsidian Publish (public notes only) | Secret callouts, comments and DM headings; the rest is public (or keep the whole site DM-only) |
| `git` | A repo of Markdown reference files, cloned read-only | Same as Markdown |
| `mcp-files` | Any MCP server that lists and reads files (Obsidian MCP and filesystem MCP presets, or name the tools) | Same as Markdown |
| `api` | Any JSON API over HTTP (pages, tags, calendars, pictures), or any MCP tool that returns records (with an optional per-item read tool) | A visibility field you name; shared only for the values you list |

| `push` | Nothing: your own tool sends entries (see "Push API") | The entry's `visibility` (shared only when the source is set to share), plus the usual secret blocks and DM facts |

Older source kinds (`vault`, `kanka`, `mcp` + `profile`) still work; they
map to the connectors above.

## Connections, sources and audiences

A **connection** is the account-level half of a source, kept once at the
gateway (Admin → Connections) and not tied to a world:

`{ id, name, connector, the connector's account settings and secrets, notes }`

- Kanka: the API token (and a self-hosted API URL).
- LegendKeeper: the API key, or the MCP URL, token or local server.
- MCP file servers: the server and its tools.
- Generic API: the whole mapping: URL pattern, auth, paging, field names.

Secrets are shown as `••••`, never returned by any endpoint, and kept when the
panel sends the mask back. Connections have a **Test**, which asks for a small
sample of the world-specific settings (a campaign id, a project) when the
connector needs one to read anything.

A **source** is `connection + world settings + schedule + audience`. The world
settings are the Kanka campaign id, the LegendKeeper project or a root, a
folder, or (generic API) the values for the `{world}`-style placeholders in the
URL or tool arguments. Each connector field has a `scope`: `connection` or
`source` (`GET /api/admin/connectors`). Markdown folders, git and push sources
have nothing at connection level and stay plain sources.

- **Many worlds can use one connection**, and a world can have many sources
  (from the same or different connections). Deleting a connection that
  sources still use is refused.
- **Existing sources migrate on start**: one connection per connector and
  distinct set of account settings, and the sources point at it. Older kind
  names become the connector id. The old source API still works: a source
  made with everything in `config` gets an identical connection reused or
  made. Changing a connection field through an old `PATCH /sources/:id` is
  refused (409): change it on the connection, which other sources use too.

### Audience of a source

| Audience | Label | Meaning |
|---|---|---|
| `auto` (default) | Follows the source | What the source's own flags and levels say, as before. |
| `dm` | DM only | Everything from this source is DM-only, whatever the source says. Its relations, timelines, calendars and map markers too. |
| `party` | Shared with players | Everything from this source may be shown to players. For a connection that already uses a player-level key (a Kanka member token that only sees public entries). |

- `party` never un-hides what is marked secret: `secret` blocks and callouts,
  DM headings, `broker` and `classified` tags or levels, hidden facts and
  frontmatter keys, and unknown blocks are still cut from the player copy. It
  lifts the *source's own* flag (private, hidden, "No visibility") and nothing else.
- `party` needs explicit confirmation (`confirmParty: true`) when it is set,
  and the change is recorded in the audit log (`source.audience`). `dm` and
  `auto` do not need it, but are logged too.
- Implementation: `Library.saveEntry` stores `pages.source_level` (what the
  source said) and `pages.marker_level` (what marks the page secret on its
  own) and sets `visibility` with `levelForAudience()` (`core/library.ts`):
  `dm` = at least `dm`, never lower than the source; `party` = the marker level;
  `auto` = the source level. Switching the audience (`PATCH /sources/:id
  {audience}`) works every page's level out again and rebuilds all copies, so
  player pages, search and embeddings follow at once. Records are forced
  DM-only at once by `dm`; `party` and `auto` change them at the next sync.
- A page saved before audiences existed has its marker level read again from
  its tags, and any `broker` or `classified` level it had is kept.

### Presets for the generic API

A preset is a saved, reusable field mapping for the `api` connector (paging,
where the list is, the id, title, body, parent, tags and visibility fields,
the shared values, and a URL pattern with placeholders such as `{world}`). It
holds no secret and nothing world-specific (a token, `world` and `params` are
dropped when saving or importing).

- `GET /api/admin/connections/presets`, `POST .../presets` (`{name, config}` or
  `{connectionId, name}`), `GET .../presets/:id/export`, `POST .../presets/import`
  (`{preset}` or `{json}`), `DELETE .../presets/:id`.
- Make a connection from one with `presetId`; apply one to an existing generic
  connection with `POST /api/admin/connections/:id/preset`.
- Export format: `{ "format": "alexandria-api-preset", "version": 1, "name", "description", "config" }`.
- Built in, as examples, **community and unverified** (field names were not
  checked against the live apps): Generic REST list + detail, Generic MCP tool,
  Kanka via generic API, LegendKeeper via generic API. The last two only show how
  a mapping reads an API; the dedicated Kanka and LegendKeeper connectors are
  richer (relations, timelines, maps, hidden content) and are recommended.
- The connector picker lists the dedicated connectors (LegendKeeper, Kanka,
  Markdown/Obsidian, git, MCP files, push) and then "Any JSON API" with its presets.

### World setup, crawl and the agent

Admin → Worlds has a page per world: its sources (connection, audience,
schedule, last sync), page counts by level, embedding coverage (chunks
indexed and pending, and the model that does it), **Sync now** and **Re-index**.
The setup flow is: create a world → pick or create a connection → the
world-specific settings → audience → **Connect and crawl**.

The crawl (`POST /api/admin/worlds/:id/crawl`) lists every source (see "Tiered
crawl" below), then embeds whatever text each page has. Progress (pages listed,
saved, list calls, levels found, chunks embedded, errors) is in `GET /api/admin/worlds/:id/overview`,
in the run log (`GET /api/admin/crawls/:id`) and in `crawl` live events sent to
the DM only. `POST /api/admin/worlds/:id/crawl/stop` cancels it; the world, its
sources and whatever was fetched stay. With no embeddings model set, the
library part finishes and the log says so. `POST .../reindex` embeds every page again.

The agent knows what is connected: the DM's harness context has a one-line
source summary, and the read tool `world_sources` (DM only) lists each source
with its audience, schedule and last sync. Players get nothing from
`GET /api/worlds/:world/world-sources`.

## Source keys: each player's own key

A source is read with the DM's connection. A **source key** adds a second way
in: a player (or the DM) gives the gateway a key for one world's source. Keys
work with **Kanka (API)**, **LegendKeeper (API key)** and a **generic HTTP
API**. Code is in `librarian/src/features/sourcekeys/`.

### Adding a key

- **Players** add their own: World → My keys, or `POST /api/worlds/:w/source-keys`
  with `{ sourceId, secret, label?, trust? }`. The DM can switch this off with the
  world setting `sourceKeysPlayers`.
- **The DM** adds any number of keys, and sets `users` (who may use it), `uses`
  (`library`, `agent`, `broker`) and `trust`. The DM can change them later with
  `PATCH /source-keys/:id` and revoke any key.
- **Verified before it is saved.** A key for another world is refused (400, with a
  reason) and nothing is stored:
  - Kanka: the key can read the source's campaign (`GET /campaigns/{id}`).
  - LegendKeeper: the key can read the source's project (`GET /resources`, then one resource).
  - Generic API: one list call with the source's world settings works.
- **Secrets never come back.** The API shows a mask. The secret is stored on the
  server, only sent to the host the DM set up for the source, and wiped when the key is
  revoked. Every use is in the audit log (`sourcekeys.use`: key id, account, use).
  Secrets are stored like connection secrets are (not encrypted in the database).
- Players see and revoke only their own keys. The DM sees all of them.

### Trust: per-user or blanket

When a key is added the gateway asks: *does this source give each key only what that
user may see (per-user), or does every key see everything (blanket)?* It also runs a
probe where it can and shows the result to the DM. For Kanka it compares the number of
entities the key lists with the number the DM's connection lists. The probe only informs;
it never changes trust.

| Trust | Meaning |
|---|---|
| `per-user` | The key shows its user only what they may see. Only the **DM** can set this. |
| `blanket` | The key sees everything: treated as DM-level. |
| `unsure` | Not known. **Treated as blanket** (fails closed). A player's own key starts here. |

### The per-account view (per-user keys with the `library` use)

"Refresh my view" (`POST /source-keys/:id/refresh`, rate limited to one per key every
5 minutes; the DM may force it) reads what the key can see and stores the page ids:
`sourcekeys_access` (world, page, account, key). It stores ids only, never text.

A player may then open the **player copy** of a page that is DM-only only because the
**source** marks it private, when their own key sees it (their character's own backstory,
for example):

- It lifts `source_level` for that account only (`levelForAccountKey` in `core/levels.ts`,
  `Library.liftedInfo` in `core/library.ts`). It never lifts `marker_level`: a page the
  source marks broker or classified stays out of reach. Secret blocks, DM fact groups and
  private posts are cut from the copy as for any player. A source whose audience is
  `dm` is not lifted either.
- The copy is built when it is asked for and never stored. It shows in the Library list,
  the page, search, offline bulk, MCP and the agent, for that account only.
- Blanket and unsure keys never feed anyone's view. Revoking a key, changing its trust,
  users or uses, or removing the player takes effect at once (it is read live).

### Sharing pages

What a player sees through their own key is theirs alone until they share it.
`POST /api/worlds/:w/library/pages/:id/share` with `{ to: "party" | [accountId, ...] }`,
`DELETE ...?to=party|accountId` to unshare, and `GET` for who it is shared with
(Library → Share…, and a "Shared with me" filter).

- A player can share only a page they can open. The recipient gets the **same player
  copy**; sharing never lifts a page above what the sharer could see, and a share ends when
  the sharer loses sight of the page (their key is revoked).
- The DM can share any page except broker and classified ones, with the party or chosen
  players. It is a grant (`sourcekeys_shares`, kind `dm`); the page's own level is unchanged.
- Unsharing is immediate everywhere the page shows.

### The agent and live lookups

The `source_lookup` tool (MCP and the agent) searches the source live through the
caller's **own** keys with the `agent` use: their own, or one the DM assigned to them. A
player's lookup never uses another person's key or the DM's.

- Per-user key: the source is asked which pages the key sees; what the player gets is the
  **stored player copy** of each page they may open, never text the source sent now.
- Blanket or unsure key, a page the library does not have yet, or a page above the
  player's view: nothing of it is returned. The lookup is **escalated** and the reply says
  "The broker will look into it."
- The DM agent may use any key whose `users` include the DM and whose `uses` include `agent`.
- A reply that is blocked by the leak check is unchanged (it is not escalated).

### Escalation

When a question needs more than the asker's own view, it is not answered. World setting
`escalation`:

- `dm-question`: a DM-only question in the queue (World settings → Source keys → Escalated
  questions). The DM answers or refuses.
- `broker-deal` (default): a broker request the DM prices (`POST /source-keys/escalations/:id/price`
  with a cost, the answer and the wait in sessions, default `escalationSessions` 2).
  The player accepts and pays in the Broker; it is delivered only after the wait and the
  DM's approval. The wait is until the end of the Nth scheduled game session, or a week
  per session if fewer are scheduled. A world with the broker closed asks the DM instead.

The player sees only "The broker will look into it", and later the DM's own answer. The
hidden context (what the blanket key found, the DM-side evidence) is in the DM queue only.
A player can also ask directly (`POST /source-keys/escalations`): the audit model labels
the question; off-topic is turned away, rules and item questions are answered without
secrets, and everything else, and anything it is unsure about, is escalated. A broker
question that goes to the DM to price is in the queue too. Keys with the `broker` use (DM
keys only) add what the source knows to the DM's context.

## Secrecy levels: marking content in every source

Every page and block has one of four levels (`librarian/src/core/levels.ts`). The most secret level wins, and anything unknown or unparseable is `dm`.

| Level | Players | Broker may sell it | Any AI or model (DM agent, Sculpting, session-log drafts, statblocks from pages, MCP clients, embeddings) | The DM in the app |
|---|---|---|---|---|
| `party` | yes | yes | yes | yes |
| `broker` | no | yes (after DM review by default) | yes | yes |
| `dm` | no | no | yes | yes |
| `classified` | no | no | never sent, never embedded | yes, marked "Classified: never shared with any AI" |

How to mark each level, in every source:

| Where | Page level | Block level | Property groups and keys |
|---|---|---|---|
| Markdown, Obsidian, git, MCP files | frontmatter `visibility: broker` or `classified`; tags `broker` / `classified` (frontmatter, or `#classified` in the text) | `> [!broker]` and `> [!classified]` callouts; `<!-- broker --> ... <!-- /broker -->` and `<!-- classified --> ... <!-- /classified -->`; callouts or `> [!expand] Broker` toggles titled Broker or Classified; headings named Broker or Classified (with their section) | nested `broker:` / `classified:` maps; keys `broker_*` / `classified_*` |
| LegendKeeper | resource tags `broker` / `classified` | secret blocks whose first words are `BROKER:` or `CLASSIFIED:`; callouts or toggles titled Broker or Classified; headings named so | property groups titled Broker or Classified |
| Kanka | entity tags `broker` / `classified` (private tags count, and are never shown) | posts named Broker or Classified, or tagged so | attributes named `Broker ...` / `Classified ...` |
| Alexandria's own pages | the Level picker in the Library editor, or `PUT /library/pages/:id/level` | the same callouts as Markdown | the same keys |

A page tagged `classified` is classified even if its source shares it. A source can also hand over `broker` or `classified` as the entry's visibility, and a later sync keeps it. Players only ever get the player copy; the broker gets the broker copy (party plus broker); every model-facing path gets the AI copy (everything except classified). A request from a model (the MCP server, the agent's tools) carries the header `X-Alexandria-Caller: model` and the library then serves the AI copy; a caller who sets it by hand only sees less.

## Capabilities

Each connector declares what it provides in `capabilities`: `pages`,
`properties`, `tags`, `images`, `relations`, `timelines`, `maps`,
`calendars`, `items`, `characters`.
- `GET /api/admin/connectors` returns them for each connector.
- `GET /api/worlds/:world/intake/capabilities` returns the union over the
  world's sources (`{ capabilities, sources }`; `sources` is DM-only), so
  screens can hide what no source has. A missing capability is never an
  error.
- Records of a kind the connector did not declare are ignored.

## The page model

`librarian/src/intake/model.ts` defines it. An entry has:
- `externalId`: stable within the source. Never the title, because
  titles repeat.
- `parentExternalId`, `folder`: the tree in the Library. `position`: where
  the source puts the page among its siblings (see "Order" below). `url`:
  the page in the source's own app.
- `title`, `aliases`, `tags`, `type`, `icon` (Font Awesome glyph and
  colour), `banner`.
- `properties`: sidebar fact groups. Each row is a key with rich text.
  `dm: true` marks a whole group DM-only.
- `blocks`: the body. The kinds follow LegendKeeper's document schema, so
  its pages keep their layout:

  | Kind | What it is |
  |---|---|
  | `heading`, `paragraph` | Text |
  | `bulletList`, `orderedList`, `listItem` | Lists, including tasks |
  | `table`, `tableRow`, `tableCell` | Tables |
  | `secret` | DM-only part |
  | `callout`, `toggle`, `blockquote` | Framed text |
  | `codeBlock`, `divider`, `image` | Other content |
  | `infobox` | Floating fact box with a layout and width |
  | `collection` | List of child pages |
  | `map` | A map: image and pins (LegendKeeper map documents) |
  | `unsupported` | Anything else |

- **Inline text** carries bold, italic, code, strike, underline, links,
  and **mentions** (`ref` = the target's externalId, or `name` for
  `[[wiki links]]`).
- `visibility`: `dm` or `party`. Connectors must fail closed: when unsure,
  `dm`.
- `knowledge`: `common` | `local` | `deep`, for the information broker's
  price tiers.
- Markdown sources set `markdown` and `frontmatter` instead of `blocks`.
  The library then runs the Markdown leak guard before parsing.

## Tiered crawl: the fewest calls for a broad picture

LegendKeeper, Kanka and the generic API crawl in tiers. A crawl makes **list
calls only**; whole pages are read later, on demand and in the background
within a call budget. After the crawl every page is already in the Library
with its title, type, tags, parent and folder, and some text to search and
embed.

| Tier | What | Calls |
| --- | --- | --- |
| 1 Index | the paged list endpoints and the LegendKeeper resource tree | about pages / page size |
| 2 Summary | an opening excerpt, where a list gives one (a mapped `summary` field) | none extra |
| 3 Detail | the whole page | one or a few per page, on demand or in the background |

Each page records `depth` (`index`, `summary`, `full`), `fetched_at`,
`source_updated_at` (what the list last said) and `held_updated_at` (the
source time of what the library holds). A page whose source time moved on is
**stale** and is read again.

- **LegendKeeper**: `GET /resources` at 100 a call (plus the calendars, and
  the timelines, which are lane and event lists). Documents and permissions
  need detail calls, so pages stay at index depth. Detail is one call for the
  resource, one for each document and one for each ancestor whose permissions
  are not known yet. The published limit is 300 calls a minute per key (6,000
  an hour; 12,000 an hour per project), and a real key answered
  `X-RateLimit-Limit: 200`: the connection defaults to 200 calls a minute, 2 a
  second and 6,000 an hour, and the background budget to 40 a minute (see
  "Rate limits").
- **Kanka**: the module lists already carry `entry`, posts and attributes
  (`related=1`), so a listing reaches full depth with about pages / 45 calls
  per module (up to 100 a page for subscribers). Later listings send
  `lastSync` and read only what changed, and refresh the records of what
  changed (see "Incremental re-crawls"). The default limit is 30 calls a
  minute for a user (90 for subscribers; all tokens share it): the connection
  defaults to 30 a minute (no hourly cap: the docs give none) and the
  background budget to 12. Raise "Max calls per
  minute" on the connection (or on the world page) if you are a subscriber.
- **Generic API**: the endpoint list (below). A record with a body in the list
  is full; with only a summary, `summary`; otherwise `index`. An endpoint with
  a `detailPath` (`/articles/{id}`) gives whole pages later. Calendars and
  pictures come from their own lists (below). `sinceParam`
  (`updated_since`, `lastSync`) makes later listings incremental.
- **Generic API through an MCP tool**: the list tool makes the index, and an
  optional **read tool** (one page from its id) gives whole pages later (see
  "MCP tool sources: a detail tier").
- Markdown folders, git, MCP files and push sources have nothing to list
  separately and are read whole, as before.

**Leak guard at every depth.** A page at index depth with no visibility
information is DM-only until it is known (fail closed): LegendKeeper keeps
permissions in the resource detail, so its listed pages are DM-only until read.
Levels, markers and the source's audience are applied as content arrives, and
the player copy is rebuilt before the page is served. A re-crawl whose list says
a page is now hidden takes its player copy away at once, without waiting for
the details.

**Reading pages (tier 3)**

1. *On demand*: opening a page (`GET /library/pages/:id`, for a DM or a player),
   the agent reading it, or a DM's search hitting it (the best three) reads it
   from its source first, then serves it. Opening pages is limited to 30 a
   minute per source.
2. *In the background*: a worker spends each source's **budget** (calls a
   minute, a token bucket) on the pages most worth reading: those people opened
   or searched for, then those linked to by pages already read, then ones that
   changed at the source, then tree order. Without "fetch everything" only
   pages with a reason are read.
3. Per source, on the world page: the budget, **Fetch everything now** (reads
   every page at the budget; can take hours; switches itself off when done) and
   **Pause**. `PATCH /api/admin/connections/tiers/:source` with
   `{budget, paused, fetchAll}`; `GET /api/admin/connections/tiers/world/:world`.
   The DM's Library page shows a badge on pages not yet read in full
   (`GET /api/worlds/:world/world-sources/depths`).
4. *One read per page.* The background reader, a page being opened and a search
   hit share one read of a page: the second caller waits for the first and uses
   what it saved, so a page is never fetched twice at once.

**What the DM is told** (`GET /api/worlds/:world/world-sources/status`, DM only;
the same object is `status` in the admin world overview):

- *Why players see nothing.* When pages exist and none is shared, a banner on
  the world page and at the top of the DM's Library gives the counts and the
  reasons: the source's audience is "DM only"; pages are only listed so far
  (the source has not said who may read them); pages are hidden at the source;
  pages are shared at the source but the default visibility is "DM only"; the
  key is refused for content. It says what to do: set the audience or default
  visibility, wait for the details (or open a page), check the key's role.
- *A refused key.* A source whose key is answered 401 for page content while
  its lists work shows "This key can list pages but can't read their content.
  Check its role: LegendKeeper keys need Admin to read page text and hidden
  pages." on the source (`refused` in the tiers, and in this status).
- *A wait.* While a page somebody opened is held back by the site's limit, the
  DM's Library says "Waiting for the site (N s)" (`waiting`: seconds and
  whether the site asked or our own limit did). A wait that only the reserve
  for opens causes is never shown, because an open does not wait for it.

**Changing a source's default visibility.** The default decides whether a page
the source calls shared is shared here. Pages read in full remember what the
source said about them (`pages.source_shared`), so changing the default (or
the audience) re-levels them at once, without reading them again, and rebuilds
the player copies. Fail closed: a page that is only listed (nothing says who
may read it) and a page hidden at the source stay DM-only; an audience of
"shared with players" does not share pages that were never read.

**Incremental re-crawls.** LegendKeeper re-lists everything (it has no
`since`), notes each page's `updatedAt`, and only the changed pages become
stale. Kanka and generic endpoints with a `sinceParam` list only what changed.
**Kanka records on an incremental run.** Relations, calendars and map
markers used to refresh only on a complete listing. A listing of changes now
also refreshes them for what changed, and for nothing else:

| What changed | Extra calls | Replaced |
|---|---|---|
| an entity | one `GET /entities/{id}/relations` | that entity's relations (as owner), including ones deleted at the source |
| a calendar entity | none (the list has its months, weekdays and date) | that calendar |
| a map entity | one `GET /maps/{id}/map_markers` | that map's markers |

An entity that did not change makes no relation call, and a run with no
changes makes none at all. These calls are index calls and are in the tier
line (`indexCalls`). The relations, markers and calendars of everything else
are refreshed by the next complete listing; timelines too. If a read fails,
what was stored for it stays.

Pages are removed **only after a complete listing**: a listing of changes, or
one that failed part way, removes nothing; a complete one runs on the first
crawl, every sixth, once a day, and on `POST .../sources/:id/sync` with
`{"full": true}`.

**Call accounting.** Every request to a source is counted by tier: the sync
stats have `indexCalls` and `detailCalls`, and the crawl progress shows
"Index: 14 calls, 2,031 pages · Details: 120 of 2,031 · Budget 30/min".

### Rate limits

The numbers below come from the services' own API docs; see [API_VERIFICATION.md](API_VERIFICATION.md).

Sites limit calls: Kanka 30 a minute (90 for subscribers), others a number a
second. Every call to a source goes through **one limiter per connection**
(`intake/ratelimit.ts`), so every world and every source key that uses the
connection shares it: the index, details read in the background, a page opened
on demand, picture and map downloads, and the connection test. A source with
no connection has its own.

| Setting (on the connection) | Default | Meaning |
|---|---|---|
| `maxPerMinute` ("Max calls per minute") | Kanka 30, LegendKeeper 200, World Anvil 60, Notion 150, Obsidian Portal 30, Obsidian Publish 60, Obsidian REST 600, generic API 60 | never more in any 60 seconds |
| `maxPerSecond` ("Max calls per second") | LegendKeeper 2, World Anvil 2, Notion 3, Obsidian Portal 1, Obsidian Publish 2, others 0 (no cap) | never more in any second |
| `maxPerHour` ("Max calls per hour") | LegendKeeper 6,000, others 0 (no cap) | never more in any hour |
| `spreadMinutes` ("Spread the first scan over (minutes)") | 1 | see below; 0: as fast as the limits allow |

Set them in Admin > Connections (the connector's form) or on the world page
under "Reading the sources", where `PATCH /api/admin/connections/tiers/:source`
takes `{ limits: { perMinute, perSecond, perHour }, spread }`. The limits are
written to the connection (every world using it gets them, and the change is
audited); `spread` is this source's own (`null` goes back to the connection's
value).

**The reserve for opens.** A fifth of the per-minute and of the per-hour budget
is kept for pages somebody opens: the index scan and the background reader
(`background` calls) stop at 80% of each, and only an on-demand read (a page
opened, the agent, a search hit) may take the rest. A DM opening a page never
waits for a minute or an hour the background has used up. The background detail
budget (calls a minute) defaults to 40 for LegendKeeper and half of the 80% for
the others (12 for Kanka), is never above the background share of the per-minute
cap, nor of the hourly cap (6,000 an hour is at most 80 a minute), and the DM can
set it from 0 to 600.

**Hourly caps and projects.** Besides the minute window the limiter keeps an
hour window per connection (`maxPerHour`; Kanka documents none, so 0). A
LegendKeeper project also has **12,000 calls an hour across all its keys**: every
connection (and every player's source key, which goes through the same limiter
code) that names the same project (`projectId`, or the id in `apiUrl`, or the
MCP `project`) counts against one shared window, so three keys on one project
cannot reach the project cap without any of them knowing. A blocked hour waits
for the oldest call to leave it; the limiter recovers by itself.

The limiter also listens to the site:

- `Retry-After`, `X-RateLimit-Limit/Remaining/Reset` and `RateLimit-*` headers:
  a `Remaining` of 0 waits for the reset; a published `Limit` below ours is
  followed (a tenth under it), so a free Kanka account that was set to 90 a
  minute settles at 27.
- A `429` (or a `503` with `Retry-After`) waits `Retry-After`, or backs off
  1, 2, 4, 8 seconds plus jitter, and asks again up to four times. After that the
  429 is handed to the connector, which fails the run: it never hammers.
- The site's `X-RateLimit-Limit` is adopted as the per-minute cap whenever it
  is lower than the one configured (a key that reported 200 settles at 180).
- While calls are held back, the world page shows "Waiting 12 s — the site
  asked us to slow down" (`throttle` in `GET /connections/tiers/world/:id`), and
  the DM's Library shows "Waiting for the site (N s)" while a page being opened
  waits (see "What the DM is told").

**Scan pacing.** A complete listing (the first scan, or the periodic one)
paces the index calls evenly across `spreadMinutes`: the gap between two calls
is the window divided by the calls the last complete listing made (30 when
none is known yet), and never below what the limits allow. Details and
picture downloads are not paced. Only calls made through `fetch` or an MCP
tool of the connector are limited: a local stdio MCP server that is shared with
other programs is outside our control.

`ALX_CRAWL_RATE` (calls a minute, `0` = no limit at all, no spreading) overrides
the limits for tests.

### Generic API: automatic setup

On Admin → Connections, a generic API connection has **Find endpoints**
(`POST /api/admin/connections/api-discover`, `{baseUrl, connectionId?, listUrls?}`):

1. looks for an OpenAPI or Swagger JSON spec at `/openapi.json`, `/swagger.json`,
   `/v1/openapi.json`, `/api-docs` and `/.well-known/openapi` (under the base
   URL and its host; at most ten lookups)
2. with a spec: takes its GET list endpoints, guesses each one's **role**
   (pages, people, places, items, organisations, events, calendars, tags,
   images, or not sure) from the words of the path and the spec's tags, and
   guesses the **mapping** (id, title, body, summary, parent, tags, updated,
   type, visibility and which values mean shared, paging style, a "changed
   since" parameter, and the detail endpoint) from the response schemas; one
   sample call (at most eight) only for a list whose schema says too little
3. without a spec: one sample call to the base URL and one to each of up to two
   list URLs given, guessed from the JSON; endpoints named on the base URL are
   listed but not called

The DM gets a table (endpoint, role, mapping, confidence) to accept, change or
mark unused. **Not sure endpoints stay blank and unused until assigned, and
endpoints not marked used are never called.** Calendars and images are
imported (see "Calendars and pictures"); tags endpoints give tag names to
records that list tag ids. The result is saved on the connection (`PUT
/api/admin/connections/:id/endpoints`, setting `endpoints` as JSON) and can be
saved as a preset, which carries the endpoint list and base URL (no token) to
other worlds. A mapping with no visibility field leaves every record DM-only.

### Generic API: calendars and pictures

An endpoint with the role **Calendars** or **Images / files** that the DM has
ticked is imported; one that is not ticked is never called, whatever its role.

**Calendars** become the same world calendar the Kanka and LegendKeeper
connectors give (`GET /intake/calendars`, used by the world clock). Mapping keys
of the endpoint review, guessed from the schema or a sample:

| Key | Holds |
|---|---|
| `idField`, `titleField` | id and name |
| `monthsField` | the array of months; each month's name and length are its `name` and `days` (or `length`), or set `monthNameField` / `monthDaysField`; `intercalary: true` marks one outside the week |
| `weekdaysField` | an array of names (strings, or objects with a `name`) |
| `currentDateField` | today: `"1492-1-5"` or `{year, month, day}` |
| `epochYearField`, `yearSuffixField` | the first year, and a suffix such as "DR" |
| `eventsField` | dated events (`id`, `name`, `date`, `description`), kept as a timeline "<calendar> events" |
| `visibilityField`, `sharedValues` | as for pages |

A calendar with no months is skipped. A calendar is shared only when its
visibility field says so; an event is shared only when it carries that same
field with a shared value (no flag, DM-only).

**Pictures** are downloaded and attached to pages. Keys: `urlField` (the
picture's address, relative to the API host or absolute; without it `detailPath`
is the download path with `{id}`), `pageField` (the id of the page it belongs
to, as in its own list), `updatedField`, `visibilityField`.

- Downloaded in the sync, after the pages, one request each, and counted as
  **detail calls** (the tier line and `connections_source_state`). The lists
  that find them are index calls.
- Limits: 4 MB a picture (`ALX_IMAGE_MAX_BYTES`), 20 downloads a run
  (`ALX_IMAGES_PER_RUN`; the rest follow on later runs) and 2,000 held per source
  (`ALX_IMAGES_MAX`). A picture whose address and update time are unchanged is
  not downloaded again; one the server refused is not asked for again until it
  changes or the next complete listing. A busy server (429, 5xx) is retried.
- Only PNG, JPEG, GIF and WebP: the content type and the file's own first
  bytes must both say so. SVG and anything else is refused.
- The API token goes only to the API's host. An absolute address on another
  host is fetched without the token, only because the DM accepted this
  endpoint; never from a private address (localhost, 10.x, 192.168.x,
  169.254.x, `.local`), and a redirect to another host is not followed.
- Stored in the database (`intake_images`), so backups hold them. The page's
  `banner` is the picture's own media address, a signed ticket made for the
  viewer (`/api/media/intake/<ticket>`) that is checked again on every fetch.
  A player gets it only when the picture itself may follow its page (visibility
  field shared, or none mapped and the source shares) **and** the page has a
  player copy. A DM-only page's pictures, and DM-only pictures of a shared
  page, are the DM's alone. The source's audience applies to them too.
- A page can have **several pictures**. The page response has `banner` (the
  first, by the source's id; or the address the source gave the page) and
  `pictures`: `[{ id, name, url, map, primary }]`, each `url` a signed ticket
  for this viewer, listed only when that viewer may fetch the picture (same
  check as above, once per picture). The library page shows the pictures that
  are not the banner as a small row of links under it.
- Turning the endpoint off removes its pictures at the next sync.

### Maps from sources

A map's own picture is imported next to the page's pictures and kept as a
**map** (`intake_images.kind = 'map'`, `map: true` in `pictures`). It follows
its page like any picture and has its own, larger size cap: `ALX_MAP_MAX_BYTES`
(default 25 MB; pictures stay at `ALX_IMAGE_MAX_BYTES`). Downloads are detail
calls, within the same per-run and held-total limits, and an unchanged map
(same address and update time) is not downloaded again.

- **Kanka**: the image of each map entity (`image_full`), in the module list.
- **LegendKeeper**: the image of a map document (`mapImage`), downloaded when the
  map page is read (opened, or in the background), so it is a detail-tier call.
- **Generic API**: an endpoint with the role **Map images** (`map`), mapped like
  Images: `urlField` or `detailPath`, `pageField` (without it the record's own id
  is taken as the page it belongs to), `updatedField`, `visibilityField`. A plain
  `/maps` list stays a list of places (a map is also a page); only names like
  `battlemaps` or `map-images` are guessed as `map`.

`GET /api/worlds/:world/intake/map-images` lists the imported maps the viewer
may open (the DM all; a player only maps whose picture is shared and whose
page has a player copy), each with a signed `url`, its `name` and `page`. The
Map page (DM and player) offers them under "Imported map"; the choice is
kept in that browser, like the pasted image URL.

### Portraits and pictures in page text

Kanka's and LegendKeeper's pages show pictures by address: an entity's
portrait or a page's banner, pictures in the text, and infobox images. Those
are stored here too, so the apps show them from this server, also when the
source or the internet is out of reach, and a saved offline copy keeps them.
This works for any connector with the `images` capability.

- **Queued, not downloaded in the sync.** Every page read in full queues its
  banner (`kind = 'picture'`, the page's primary picture) and each picture in
  its text (`kind = 'inline'`), at most 40 a page, as `intake_images` rows
  with a `url` and a `want_marker`. A row is waiting while `want_marker`
  differs from `marker`; one never downloaded has no file and is never served.
- **The picture downloader** (`intake/imagequeue.ts`) fetches them, one at a
  time and portraits first: a few at the end of every sync
  (`ALX_IMAGES_PER_RUN`), five per source on each turn of the background
  reader, and all of them in **Refresh world** (see `docs/MEMORY.md`). They
  come from the sources' picture hosts, not their APIs, so they spend no call
  budget and never carry a token. The same rules as above apply: PNG, JPEG, GIF
  and WebP only, no private addresses, `ALX_IMAGE_MAX_BYTES` a picture and
  `ALX_IMAGES_MAX` held per source. A picture that fails 5 times is left alone
  until its address changes (Refresh world gives it another chance).
- **Served in place of the address.** A page is answered with each picture it
  holds here swapped in: `banner`, image blocks and a map block's `image` become
  the viewer's signed `/api/media/intake/<ticket>`. A picture that is not stored
  (yet) keeps the source's address. Pictures in text are not listed in
  `pictures` (the gallery).
- **Visibility.** A picture follows its page like any picture. One inside a
  secret block is the DM's even on a shared page (the player copy leaves its
  block out, and its file is refused to players).
- **Changes.** An unchanged address is not downloaded again; a new portrait is
  queued and the old file is served until the new one arrives. A page read in
  full drops the pictures it no longer shows; a complete listing drops those of
  pages the source no longer has. A listing that only holds pages at index
  depth (LegendKeeper's tier 1) removes none, since it has not read them.
- **Offline copies.** "Save for offline" in the library fetches the page's
  stored pictures and keeps them inside the copy (up to 8 MB a picture, 25 MB
  a page), so it shows them with no connection.

### Opening a page you cannot see

A page held only at index depth is read from its source when someone opens it
(`readOnOpen`). The caller's access is checked **first**, by the library's own
rules (a player copy exists, the level allows it, a per-account lift or a share
applies): only the DM, or a viewer who could be served the page, causes a
call. Index-only pages with no visibility information are DM-only, so a
player opening one gets the usual 404, spends no call and does not even mark
the page as wanted.

### MCP tool sources: a detail tier

A generic source whose transport is an MCP tool crawls in tiers too. **Find
tools** on the connection (`POST /api/admin/connections/mcp-discover`) asks the
server for its tool list (no tool is called) and guesses:

- the **list tool**: `list_*`, `search_*`, `find_*`, `all_*` with no required
  argument
- the **read tool**: `get_*`, `read_*`, `fetch_*`, `retrieve_*`... with an id
  argument (`id`, `uuid`, `slug`, `*_id`), best when its noun matches the list
  tool (`list_articles` and `get_article`). Names that change things (`create_`,
  `update_`, `delete_`...) are never offered and are refused if typed.

The DM picks or types them, or leaves the read tool blank: then the list is all
there is and nothing is read later. Settings: `detailTool`, `detailIdArg`,
`detailIdType` (text or number), `detailArgs` (extra arguments as JSON, with
`{world}`-style placeholders), `detailItemPath` (where the record is in the
answer), `summaryField` (an excerpt in the list).

With a read tool the list makes the index (depth `summary` when the list has an
excerpt, `index` otherwise), and whole pages are read like any tiered source: on
demand (page opened, a DM's top three search hits, the agent), then in the
background within the budget, with "fetch everything" if asked. One call per
page, counted as a detail call; the default budget is 15 a minute. Only the read
and list tools are ever called (the read-only client refuses the rest).

Visibility is the same as ever: a page is shared only when its own record
has the visibility field with a shared value, and a record with no such field
is DM-only. The read tool's answer needs the field too, otherwise the page stays
DM-only after it is read.

## How a sync runs

`librarian/src/intake/sync.ts`:

1. A `sync_runs` row is created. The admin panel shows its status, stats
   and log.
2. The connector yields entries. Each is saved with an empty player copy,
   so a running sync never shows a half-checked page.
3. After a **complete** listing, pages the source no longer has are
   removed. A failed or stopped sync removes nothing.
4. Mentions are resolved:
   - by the source's own ids first, then by title, alias or file name (see
     "Links" below)
   - a link to a DM-only page, or by id to a page that wasn't imported,
     becomes "(hidden)" in the player copy
5. Player copies are rebuilt:
   - `secret` blocks, DM/GM callouts, DM headings with their sections, DM
     fact rows and every block kind the guard doesn't know are dropped
   - the Markdown copy (used for search, AI context and downloads) is made
     from the player blocks and redacted a second time

Sources can sync on a schedule (`schedule_minutes`). The crawl, the schedule
and the admin panel's Sync now run in tiers where the connector supports it;
`runSync(deps, id, by)` without `{ tiered: true }` reads everything with the
connector's own `sync`.

## Order in the Library tree

The tree shows pages in the order their source shows them. Each entry has
a `position` (stored in `pages.position`; lower first). Siblings are
compared by it, a folder sits where its first page sits, and pages with no
position follow, A to Z. "A–Z" and "Recent" in the Library are flat lists
and ignore it.

| Source | Where the order comes from |
|---|---|
| LegendKeeper | `rank` of each resource, compared as plain strings (the SDK guide says not to use a locale comparison). Resources with no rank come last, then by name. The position is the place in a depth-first walk of the tree. Extra tabs (documents) of a resource follow it, in the order of their own `rank`. |
| Kanka | Kanka lists by name within a module, and its menu runs characters, locations, organisations, families, items, notes, journals, quests, races, creatures, events, abilities, timelines, maps, calendars, tags. Position is the place in that list (names compared without case, numbers naturally). |
| Markdown | Like Obsidian's file list: folders first, then files, names in natural order (`a9` before `a10`). A number in the frontmatter `order` (or `position`) puts a file before the files with none, by that number. Disk order never matters. |
| Push / API | `position` in the pushed entry (a number); without it, A to Z. |

Positions come only from the source, so a second sync of an unchanged
source gives the same numbers. Moving a page in the source moves it in the
next sync.

## Links

- **Inside a page.** A mention opens the page it points at when that page
  was imported and the viewer may read it. Resolution order: the source's
  own id (`ref`), then title or alias, then the file name or path (Obsidian
  links by file name). A ref `resource#document` that is not stored falls
  back to the resource's first page. LegendKeeper `lk://resources/<id>`
  link marks and map blocks become mentions too; Markdown
  `[text](Other Note.md)` links become links to that page.
- **Hidden.** For players, a mention of a page above their level shows
  "(hidden)", or the words the author wrote if there were any. So does a
  mention by id that matches nothing imported, because it may be a page the
  API key was not allowed to read. A `[[name]]` that matches no page stays
  plain text.
- **Not imported.** For the DM an unresolved mention is plain text. It is
  never a link, so it never opens a 404.
- **Outside.** Only `http:`, `https:` and `mailto:` links are kept, in the
  import and again when the page is drawn. They open in a new tab with
  `rel="noopener noreferrer"`. `javascript:`, `data:` and anything else
  show as plain text.

## Open the page in its own app

Each page can carry a link back to the page in its source's web app (the
`url` of the entry, stored in `pages.url`; only `http`, `https` and
`obsidian` links are stored). The Library shows it as "Open in
LegendKeeper", "Open in Kanka" or "Open file", with the source name and
when it was last synced beside it.

The link is for the DM. Players get it only when the source setting
**Players may open source pages** (`playersMayOpen`, off by default) is on,
because the page in the source can hold more than the player copy. A
model and the broker never get it. The list endpoint never carries it.

| Source | Link | How sure |
|---|---|---|
| Kanka | `https://app.kanka.io/w/<campaign id>/entities/<entity id>`. The API's own `urls.view` is used when it sends one; a self-hosted Kanka uses its own host. | Documented in the API (`urls.view`). |
| LegendKeeper | `https://www.legendkeeper.com/app/project/{project}/resource/{id}`, from the project id and the resource id. The project id is read from the API URL, or set as **Project id** for the MCP connector. | Not documented: LegendKeeper's API docs give no app address. Treat the default as a best guess and set **Page address in the LegendKeeper app** (`webUrl`, with `{project}`, `{id}`, `{doc}`) if it does not open the page. |
| World Anvil | The article's own `url` from the API (`https://www.worldanvil.com/w/<world>/a/<article>`). | Documented in the API (`url`). |
| Notion | The page's own `url` from the API (`https://www.notion.so/…`). | Documented in the API (`url`). |
| Obsidian Portal | The page's `wiki_page_url` or `character_url`. | Documented in the API. |
| Obsidian Publish | `<site>/<path without .md>`. | How Publish sites address notes. |
| Markdown, Obsidian | `obsidian://open?vault=<vault name>&file=<path without .md>` when **Obsidian vault name** is set; no button otherwise. Git sources have none. | Obsidian URI documentation. It opens the note in Obsidian on the computer where the browser runs. |

## What each source keeps

LegendKeeper keeps titles, aliases, tags, icon and colour, banner, tree
and tab order, sidebar facts, infoboxes (a portrait image becomes an image
block, DM-only when the property is hidden), callouts, toggles, tables,
tasks, columns (flattened), mentions, `lk://` links, hidden pages and
documents, map pins and timelines. Kanka keeps names, type, tags,
image, nesting, facts, attributes, posts (as sections; secret unless
shared), mentions, relations, timelines, calendars and map markers.
World Anvil keeps titles, tags, template type, category tree, cover,
the main text and the sidebar, footer, footnotes and author's notes
(BBCode: headings, bold, lists, tables, quotes, links, `[img:id]`
pictures, `@[Title](type:id)` mentions), template fields as facts (a
linked article becomes a mention), secrets, map pictures and markers,
and timelines. Notion keeps titles, emoji icons, covers, the page tree
(databases are pages holding their rows), database properties as facts
(relations become mentions, a Tags multi-select becomes tags), headings,
lists and to-dos, toggles, callouts, quotes, code, tables, columns
(flattened), synced blocks, page mentions and pictures. Obsidian Portal keeps
names, tags, the wiki, adventure-log posts (title, tagline, date), characters
(tagline, description, bio, portrait), links between pages and the GM info (as
a secret). Markdown keeps frontmatter as facts, tags (also `#tags`), aliases,
wiki and relative links, callouts, tables, lists, secrets and levels.

Still lossy: LegendKeeper columns become one column; `collection` blocks
list all child pages whatever their filter says; sidebar embeds, map and
collection properties, text colour and highlight, and map vector shapes
are not imported; Markdown images and embedded files that are not an
`http(s)` address are dropped; Kanka entity icons and tag colours are not
imported.

## World Anvil

`worldanvil-api` reads one world through World Anvil's public API v2
("Boromir", `https://www.worldanvil.com/api/external/boromir`,
[docs](https://www.worldanvil.com/api/external/boromir/documentation)). It is
read-only.

**What you need.** Every call carries two keys:

1. **An application key** (`x-application-key`). World Anvil gives it to the
   person who runs an app, through the request form linked from the API docs.
   For now only members of the **Grandmaster guild rank and above** may build
   API apps. One key serves the whole server: put it on the connection
   ("Application key") or set `ALX_WORLDANVIL_APP_KEY` for every connection.
   World Anvil's API licence forbids commercial use without its permission.
2. **A user token** (`x-auth-token`), made on the user's own **API Tokens** page
   on World Anvil. It reads what that user can read: the world owner's token
   reads drafts, private pages and every secret, which is what the DM needs.

Then add a source with **World**: the world's id, or its name or address
(`https://www.worldanvil.com/w/<world>`); the connection test lists your worlds.

**Who sees what.** World Anvil hides things with access settings and subscriber
groups, not a GM flag. Alexandria fails closed:
- a draft is DM-only; a `public` article, category, map, marker or event is the
  players' (when the source shares, as for every source);
- a `private` one is the players' only when one of its subscriber groups is
  named in **Player subscriber groups** (names or ids, comma separated);
- a secret (`[secret:id]` in the text, or linked to the article) is a secret
  block unless it is shared with a player group; `[subcontainer:<group>]` is a
  secret block unless the group is a player group; `[userstate:…]` blocks,
  `/* comments */`, the scrapbook and storyteller seeds (unless the article
  shows them) are always secret blocks.

**Tiers and calls.** World Anvil lists 50 items a call and has no "changed since"
filter, so every listing is complete (it may remove pages). Tier 1 lists
categories, articles, maps and images (for `[img:id]`), plus, with the switches
on, one call per changed map, per marker on it and per changed timeline event
(unchanged ones come from the last listing). Tier 3 reads an article
(granularity 3, which adds its parent article; 2 when 3 is refused) and one
call per secret it holds. World Anvil publishes no rate limit: the connection
defaults to 60 calls a minute and 2 a second.

**Maps.** A map's picture is stored as a map of its page; markers are records
with `latitude` = `geoY` and `longitude` = `geoX` (World Anvil's pixel
coordinates on that picture) and a link to the marker's target article.

**Writing back** goes through WorldLore (see "WorldLore: the one writable
part", World Anvil).

**Not yet.** Per-player World Anvil keys, block templates and statblocks, manuscripts, notebooks and
the family tree, diplomacy and chronicle views.

## Notion

`notion-api` reads Notion through its public API (`https://api.notion.com/v1`,
version `2022-06-28`, [reference](https://developers.notion.com/reference)).

**Set up.** At [notion.so/my-integrations](https://www.notion.so/my-integrations)
make an **internal** integration (Read content; add Insert and Update content
for WorldLore) and copy its secret (`ntn_…`). In Notion, open the world's top
page, ••• → **Connections** → add the integration: Notion shows an integration
only the pages shared with it (and their children). **Only under this page**
narrows it to one page's tree.

**Who sees what (fails closed).** A database row's `Visibility` property
(select, status or multi-select; also `Access` or `Audience`) decides first:
`party`, `players`, `public` or `shared` is the players', `broker` and
`classified` are those levels, anything else (`DM`, `GM`, `secret`) the DM's.
Without one, a page published to the web (Share → Publish) is the players'.
Otherwise **Pages without a visibility are shared** decides (off by default).
Inside a page, a toggle, toggle heading or callout whose title starts with
*Secret*, *DM* or *GM* (an emoji in front is fine) is a secret block.

**Tiers and calls.** The index is `POST /search` (100 a call; complete every
time). Details read `GET /pages/{id}` and `GET /blocks/{id}/children` (100 a
call, again below each block with children, 8 levels and 3,000 blocks at most).
Notion allows about three calls a second: the connection defaults to 3 a second
and 150 a minute. Pictures uploaded to Notion have addresses that expire within
the hour; they are stored here when the page is read.

## Obsidian

Besides the vault folder (`markdown-folder`) and the Obsidian MCP preset
(`mcp-files`), three sources read Obsidian. All of them use the Markdown rules
(frontmatter `visibility:`, `> [!secret]`, `%% %%`, DM headings).

- **`obsidian-sync`**: Obsidian's own Sync, through its official headless
  client (`ob`, npm `obsidian-headless`, open beta, Node 22+, needs a Sync
  subscription; set-up in HOSTING.md, "Obsidian Sync"). The remote vault (your
  own or one shared with you) is synced into a folder under `ALX_VAULTS_DIR`,
  then read like a vault. Pull-only unless **Two-way** is on; an end-to-end
  encrypted vault needs its password (kept as a secret, passed to `ob` as an
  argument, never logged).
- **`obsidian-rest`**: the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
  community plugin in the DM's Obsidian (`GET /vault/`, `GET /vault/<path>` as
  note JSON, `PUT`, `DELETE`, bearer API key). Obsidian must be open and
  reachable from the server. Its HTTPS certificate is self-signed: use the
  plugin's non-encrypted server (`http://<computer>:27123`), or trust the
  certificate with `NODE_EXTRA_CA_CERTS`.
- **`obsidian-publish`**: a site published with Obsidian Publish, read the
  way its own pages read it (the `siteInfo` on the page, then
  `https://<host>/cache/<uid>` for the file list and `/access/<uid>/<path>` for
  a note). **These addresses are not a documented API** and may change.
  Everything published is public, so pages are shared when the source shares;
  **Keep it DM-only** keeps the whole site for the DM.

## Obsidian Portal

`obsidian-portal` reads one campaign through Obsidian Portal's API v1
(`https://api.obsidianportal.com/v1`, help.obsidianportal.com "API Overview").

**Set up.** Register an app at `www.obsidianportal.com/oauth/clients/new` for
its consumer key and secret (on the connection, or `ALX_OBSIDIANPORTAL_KEY` and
`ALX_OBSIDIANPORTAL_SECRET` on the server). Then sign in once with the PIN flow:
`ALX_OBSIDIANPORTAL_KEY=… ALX_OBSIDIANPORTAL_SECRET=… npm run --prefix librarian op-login`
prints an address, asks for the PIN and prints the access token and secret.
Every request is signed (OAuth 1.0a, HMAC-SHA1). **Campaign** is its name, slug
or address; the connection test lists your campaigns.

**Who sees what (fails closed).** A wiki page, post or character is the
players' only when Obsidian Portal says `is_game_master_only` is false, and a
character also needs `public` or `friends` visibility. GM info
(`game_master_info`) is always a secret block. Use the GM's own tokens: a
player's token cannot see GM-only pages.

**Tiers and calls.** The index is the wiki and character lists (one call each);
details read each page (`/campaigns/{id}/wikis/{page}.json`,
`/characters/{character}.json`). Obsidian Portal publishes no limit: 30 a minute.
Read-only: WorldLore does not write to Obsidian Portal. **Not tested against
Obsidian Portal itself yet:** built from its help pages only.

## Records

`sync` may yield records next to entries. They have a `kind` (entries
have none), and each is stored per source in tables of the `intake`
feature. A complete sync replaces a source's records; a kind the
connector could not list (it adds the kind to `ctx.incomplete`) is kept
as it was. A listing of changes may also say which relation owners and map
pages it read in full (`ctx.refreshed`): those, and only those, are replaced.

| `kind` | Fields | Stored in | Players see |
|---|---|---|---|
| `relation` | `externalId`, `from`, `to` (entry externalIds), `label`, `attitude?`, `visibility` | `intake_relations`, shown by `GET /library/relations` | shared, and both pages shared |
| `timeline` | `externalId`, `name`, `visibility`, `groups: [{ name, abbreviation?, description?, events: [{ id, name, date?, description?, color?, ref?, visibility }] }]` | `intake_timelines`, `GET /intake/timelines` | shared timeline; events that are themselves shared; text through the block leak guard; a link only to a shared page |
| `calendar` | `externalId`, `name`, `visibility`, `definition`, `current?` | `intake_calendars`, `GET /intake/calendars` | shared calendars |
| `mapMarker` | `externalId`, `mapRef` (the map page's externalId), `name`, `latitude`, `longitude`, `shape?`, `color?`, `ref?`, `visibility` | `intake_markers`, `GET /intake/markers` | shared marker on a shared map, linked to a shared page or none |
| `image` | `externalId`, `pageRef?`, `name`, `marker` (version stored), `data?` (the file, or absent to keep the stored one), `visibility` | `intake_images`, the page's `banner` | the picture of a page they may read, when the picture itself is shared |

`visibility` is `dm` unless the source says players may see it. When
unsure, `dm`.

**Calendar definition** (`intake_calendars.definition`, read by the world
clock):

```
{ name, epochYear: number, yearSuffix?: string,
  months: [{ name, days, intercalary?: boolean }],
  weekdays: string[],
  moons?: [{ name, cycleDays, offsetDays }],
  seasons?: [{ name, month, day }] }   // month is 1-based
```

`current` is JSON `{ year, month, day }` or null. `epochYear` is the
number of the first year (Kanka: 1 when it skips year zero, else 0;
LegendKeeper: 0 when `hasZeroYear`, else 1). Leap rules are not carried
over.

**Maps** from LegendKeeper are pages with a `map` block:
`{ kind: 'map', title?, image?, width?, height?, pins: [{ name, lat, lng, type?, ref?, dm? }] }`.
The player guard drops pins marked `dm`, pins whose `ref` page is hidden
or unknown, and a non-http image.

## Push API

For tools that can't be polled. Add a source of kind `push`, then create
a **source key** (Admin → World sources, or the DM through
`POST /api/worlds/:world/intake/sources/:source/keys {label}`). The key
(`alx_push_...`) is shown once; only its hash is kept. It is not an
account token: it works on the three endpoints below, for that one
source, and reads nothing.

```
POST   /api/intake/<source>/entries           { "entries": [ Entry, ... ] }
DELETE /api/intake/<source>/entries/<externalId>
POST   /api/intake/<source>/sync              (a pull source: starts a sync, like a webhook)
Authorization: Bearer alx_push_...
```

- An `Entry` is the page model above (`externalId` and `title` are
  required). Unknown fields are dropped and shapes are checked; one bad
  entry is reported in `errors` and does not stop the others.
- Entries are saved with `library.saveEntry`, then the player copies are
  rebuilt: the same leak guard as a synced page. `visibility: "party"` is
  honoured only when the source's "share what the source shares" switch
  is on; anything else is DM-only.
- Pushing to a pull source, or syncing a push source, is refused.
- Limits: 100 entries per request, 400 kB per entry, 4 MB per request,
  120 requests and 2000 entries per key per minute
  (`ALX_PUSH_REQUESTS_PER_MIN`, `ALX_PUSH_ENTRIES_PER_MIN`), one webhook
  sync per 10 seconds, 10 keys per source. Over a limit: 429 with
  `Retry-After`.

```
curl -X POST https://alexandria.example/api/intake/src_abc/entries \
  -H "Authorization: Bearer alx_push_..." -H "Content-Type: application/json" \
  -d '{"entries":[{"externalId":"npc-1","title":"Captain Odda","visibility":"party",
       "blocks":[{"kind":"paragraph","content":[{"text":"A harbour captain."}]},
                 {"kind":"secret","children":[{"kind":"paragraph","content":[{"text":"DM only."}]}]}]}]}'
```

## WorldLore: the one writable part

Sources are read-only. The exception is the WorldLore workspace
(`librarian/src/features/worldlore`): the DM sets one folder or resource of a
source (a LegendKeeper resource, a Markdown folder, a Kanka note or journal), or the
`WorldLore/` folder of the library, as the AI's own wiki. The
agent reads, writes, moves and deletes there with no confirmation
(`lore_list`, `lore_read`, `lore_write`, `lore_move`, `lore_delete`; enabling
it adds the write tools to the world's `agentAutoApprove`). Nothing else changes.

A connector opts in with an optional `write` (`ConnectorWrite`: `createPage`,
`updatePage`, `movePage`, `deletePage`, plus `readPage`, `roots` and `search`). It must
refuse (`WriteRefused`, 403) anything outside the workspace `root`, checked
against the source itself. Shipped: LegendKeeper API key (REST v3), LegendKeeper
MCP, Markdown folder, Kanka API token, mcp-kanka, World Anvil API, Notion, Obsidian Sync
(two-way only) and the Obsidian Local REST API plugin. The LegendKeeper MCP may call only `create_resource`,
`write_page`, `update_resource`, `move_resource` and `delete_resource`
(`confirm=true`), and only through `workspaceMcpFactory`; `readOnlyMcp` still
refuses every write tool for sync and everything else. Pages carry a level
(`dm`, `broker`, `party`, `classified`); an agent can write `party` only if the
DM made `party` the workspace default, and `classified` pages are never sent to
an AI.

### World Anvil

The WorldLore home is one World Anvil **category**, saved as `wa:<category id>`
(the picker lists the world's categories). The agent's pages are **articles**:
straight in the home category, or under an article inside it (`articleParent`,
in that article's category). Everything else in the world stays read-only:
categories (the home included), maps, secrets and timelines are never changed.

- **Calls (`worldanvil-write.ts`):** `PUT /article` (title, `templateType:
  article`, world, category, `articleParent`, content, state), `PATCH /article?id=`
  to update or move, `DELETE /article?id=`. World Anvil keeps no trash. Content is
  BBCode made from the Markdown; `[[@wa:<id>|text]]` becomes `@[text](article:<id>)`,
  and any `[tag]` typed in the text is turned into plain brackets, so the agent
  can never write a `[secret]` or `[subcontainer]`.
- **Guard, before every write:** the target and every parent above it (article
  parent, then category, then category parents) are read from World Anvil again,
  and the root must be among them. Refused: the root itself, a category, anything
  outside the root, a move out of it or into the page's own child.
- **Levels:** `party` makes the article `public` (only when the workspace default
  is `party`); `dm`, `broker` and `classified` make it `private`, and `broker` or
  `classified` adds a tag of that name. A `> [!secret]` callout or a heading like
  "Broker notes" keeps the article private even if the level says party.
- **Not tested against World Anvil itself yet:** built from the API v2 schemas
  only. Moving an article back to the top sends `articleParent: null`, which the
  docs do not spell out.

### Notion

The WorldLore home is one Notion **page or database**, saved as
`notion:<id>` (the picker lists what the integration sees). The agent's pages
are pages under it; a database inside the home may hold new rows, but is never
changed itself.

- **Calls (`notion-write.ts`):** `POST /pages` (parent, title, the first 100
  blocks), `PATCH /blocks/{id}/children` for the rest, `PATCH /pages/{id}` to
  rename or archive (Notion's trash, restorable for 30 days), `DELETE
  /blocks/{id}` to clear the old text before an update. A `> [!secret]` callout
  becomes a toggle titled "Secret", which reads back as a secret. Notion's API
  cannot move pages: a move is refused with a message to move it in Notion.
- **Guard, before every write:** the target and every parent (pages,
  databases, and the blocks a page sits in) are read from Notion again, and the
  root must be among them.
- **Levels:** under a database with a `Visibility` select, the level is written
  there and read back. Under a plain page Notion has no field for it, so the
  page stays the DM's in Notion and the library keeps the level the agent gave
  until the next sync.

### Obsidian (Sync and Local REST API)

Path-based like the Markdown folder: the home is a folder of the vault. With
Obsidian Sync, pages are written into the synced folder and `ob sync` sends
them (only when **Two-way** is on; otherwise refused). With the Local REST API,
pages are `PUT` and `DELETE` under the folder; a move writes the new file, then
removes the old one.

### Kanka

The WorldLore home is one Kanka **note or journal**, saved as `kanka:<entity id>`
(the picker lists the top-level ones and has a name search for deeper ones; the
root link is `https://app.kanka.io/w/<campaign>/entities/<entity id>`, or the page
URL from the last sync). The agent's pages are child entities of the **same type**,
nested any depth. Everything else in the campaign stays read-only.

- **Token (`kanka-api`, `kanka-write.ts`):** `POST`, `PATCH`, `DELETE`
  `/campaigns/{id}/notes|journals/{id}`; the parent is `parent_id`, the parent's
  *entity* id (Kanka 3.10+); the row id in the URL comes from
  `GET /entities/{entity id}` (`child_id`). `entry` is HTML made from the Markdown;
  `[entity:ID]`, `[entity:ID|text]` and Alexandria's `[[@kanka:ID|text]]` become
  Kanka mentions. The token must belong to a campaign admin. 429 / `Retry-After`
  use the same handling as sync (`kankaHttp`).
- **mcp-kanka (`kanka-mcp`):** only `create_entities`, `update_entities` and
  `delete_entities` (notes and journals, a handful of ids per call), through
  `workspaceMcpFactory`. Posts, relations, tags, attributes, permissions,
  calendars, migrations and every other write tool stay refused everywhere.
- **Guard, before every write:** the target and its parent chain are read from
  Kanka again (never the library), and the root must be among its ancestors, or
  the target is a new child of a page inside the root. The root must still be a
  note or journal. Kanka not saying where a page sits means refused. Refused: the
  root being moved, renamed or deleted; moving out of the root, into the page
  itself or its child; a page of another type; anything outside the root.
- **Levels:** `party` sets `is_private: false` (only when the workspace default is
  `party`); `dm`, `broker` and `classified` set `is_private: true`. `broker` and
  `classified` add a tag of that name (created, private, when missing; matches
  `core/levels.ts`) and a level change swaps it and keeps the page's other tags.
  A `> [!secret]`, `[!broker]` or `[!classified]` callout, or a heading like
  "Broker notes", makes the Kanka page private even if the level says party.
- **After a write** that one entity is read back and saved to the library with its
  level (no full sync). After a delete, the page's children are read again
  (Kanka may re-parent or delete them) and dropped from WorldLore if they left it.

## Write a connector

Implement `Connector` from `librarian/src/intake/connector.ts` and add it
to `CONNECTORS` in `librarian/src/intake/registry.ts`:

```ts
export const myApp: Connector = {
  id: 'my-app',
  label: 'My App',
  description: 'Reads a My App world with an API token.',
  capabilities: ['pages', 'tags'],   // what it provides
  fields: [   // the admin panel builds the form from these
    { key: 'worldId', label: 'World id', type: 'text', required: true },
    { key: 'token', label: 'API token', type: 'password', secret: true, required: true },
  ],
  validate(cfg) { if (!cfg.token) throw new ConfigError('API token is required'); },
  async test(cfg, ctx) { /* one small read */ return { ok: true, message: 'Connected.' }; },
  async *sync(cfg, ctx) {
    for (const item of await fetchEverything(cfg, ctx)) {
      yield {
        externalId: String(item.id),
        parentExternalId: item.parent ? String(item.parent) : null,
        title: item.name,
        blocks: markdownToBlocks(item.markdown),
        visibility: item.public === true && ctx.shareVisible ? 'party' : 'dm',
      };
    }
  },
  // For MCP-based connectors: the read tools it may call. Everything else is refused.
  readTools: () => ['list_articles', 'get_article'],
};
```

Rules:
- **Read only.** Never call a tool or endpoint that changes the source.
- **Fail closed.**
  - A missing flag, an entry you couldn't load, an unknown parent: `dm`.
  - Only set `party` when the source itself says players may see it
    **and** `ctx.shareVisible` is on.
- **Keep secrets structured.** Put DM-only parts in `secret` blocks or
  `dm` property groups rather than hoping a text marker survives.
- **Use `ctx.fetch` and `ctx.signal`** so syncs can be stopped and
  tested.
- **Use `ctx.log`** for anything the admin should see in the run log.
- **Add a test** in `librarian/test/` with a fake of the source, including
  a case that proves its DM-only content never reaches a player.

For an app with a JSON API, try the `api` connector first: mapping the
fields in the admin panel may be all you need.
