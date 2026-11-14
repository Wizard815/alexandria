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
| `kanka-mcp` | The mcp-kanka server (`find_entities`, `get_entities`) | `is_hidden`. Posts are DM-only unless "trust post visibility" is on. |
| `markdown-folder` | A vault on the server (Obsidian, Lokus, Otterly) | No `visibility: party`; plus `secret:` frontmatter, `> [!secret]`, `%% %%`, `<!-- dm -->`, DM headings |
| `git` | A repo of Markdown reference files, cloned read-only | Same as Markdown |
| `mcp-files` | Any MCP server that lists and reads files (Obsidian MCP and filesystem MCP presets, or name the tools) | Same as Markdown |
| `api` | Any JSON API over HTTP, or any MCP tool that returns records | A visibility field you name; shared only for the values you list |

| `push` | Nothing: your own tool sends entries (see "Push API") | The entry's `visibility` (shared only when the source is set to share), plus the usual secret blocks and DM facts |

Older source kinds (`vault`, `kanka`, `mcp` + `profile`) still work; they
map to the connectors above.

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
- `parentExternalId`, `folder`: the tree in the Library.
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

## How a sync runs

`librarian/src/intake/sync.ts`:

1. A `sync_runs` row is created. The admin panel shows its status, stats
   and log.
2. The connector yields entries. Each is saved with an empty player copy,
   so a running sync never shows a half-checked page.
3. After a **complete** listing, pages the source no longer has are
   removed. A failed or stopped sync removes nothing.
4. Mentions are resolved:
   - by the source's own ids first, then by title or alias
   - a link to a DM-only page, or to a page that wasn't imported, becomes
     "(hidden)" in the player copy
5. Player copies are rebuilt:
   - `secret` blocks, DM/GM callouts, DM headings with their sections, DM
     fact rows and every block kind the guard doesn't know are dropped
   - the Markdown copy (used for search, AI context and downloads) is made
     from the player blocks and redacted a second time

Sources can sync on a schedule (`schedule_minutes`).

## Records

`sync` may yield records next to entries. They have a `kind` (entries
have none), and each is stored per source in tables of the `intake`
feature. A complete sync replaces a source's records; a kind the
connector could not list (it adds the kind to `ctx.incomplete`) is kept
as it was.

| `kind` | Fields | Stored in | Players see |
|---|---|---|---|
| `relation` | `externalId`, `from`, `to` (entry externalIds), `label`, `attitude?`, `visibility` | `intake_relations`, shown by `GET /library/relations` | shared, and both pages shared |
| `timeline` | `externalId`, `name`, `visibility`, `groups: [{ name, abbreviation?, description?, events: [{ id, name, date?, description?, color?, ref?, visibility }] }]` | `intake_timelines`, `GET /intake/timelines` | shared timeline; events that are themselves shared; text through the block leak guard; a link only to a shared page |
| `calendar` | `externalId`, `name`, `visibility`, `definition`, `current?` | `intake_calendars`, `GET /intake/calendars` | shared calendars |
| `mapMarker` | `externalId`, `mapRef` (the map page's externalId), `name`, `latitude`, `longitude`, `shape?`, `color?`, `ref?`, `visibility` | `intake_markers`, `GET /intake/markers` | shared marker on a shared map, linked to a shared page or none |

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
source, or the `WorldLore/` folder of the library, as the AI's own wiki. The
agent reads, writes, moves and deletes there with no confirmation
(`lore_list`, `lore_read`, `lore_write`, `lore_move`, `lore_delete`; enabling
it adds the write tools to the world's `agentAutoApprove`). Nothing else changes.

A connector opts in with an optional `write` (`ConnectorWrite`: `createPage`,
`updatePage`, `movePage`, `deletePage`, plus `readPage` and `roots`). It must
refuse (`WriteRefused`, 403) anything outside the workspace `root`, checked
against the source itself. Shipped: LegendKeeper API key (REST v3), LegendKeeper
MCP, Markdown folder. The LegendKeeper MCP may call only `create_resource`,
`write_page`, `update_resource`, `move_resource` and `delete_resource`
(`confirm=true`), and only through `workspaceMcpFactory`; `readOnlyMcp` still
refuses every write tool for sync and everything else. Pages carry a level
(`dm`, `broker`, `party`, `classified`); an agent can write `party` only if the
DM made `party` the workspace default, and `classified` pages are never sent to
an AI. Kanka has no write capability yet.

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
