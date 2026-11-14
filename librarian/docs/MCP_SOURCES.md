# Kanka and LegendKeeper MCP sources

This covers what the librarian needs to know to import a world from the
Kanka MCP (`mcp-kanka`) and the LegendKeeper MCP. It comes from a read-only
test against live servers in November 2026. No campaign content is
included.

## Set up a source

```bash
curl -X POST localhost:8090/api/admin/worlds/$WORLD/sources \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{
  "kind": "mcp", "name": "LegendKeeper", "defaultVisibility": "party",
  "config": { "profile": "legendkeeper", "url": "http://legendkeeper-mcp:8000/mcp", "token": "…" }
}'
curl -X POST localhost:8090/api/admin/sources/$SOURCE/sync -H "Authorization: Bearer $ADMIN"
```

- `profile` is `kanka` or `legendkeeper`.
- `transport: "stdio"` with `server: "<name>"` starts a local server.
  Only commands the operator listed in `ALX_MCP_STDIO` can be started, for
  example `{"kanka": {"command": ["uvx", "mcp-kanka"], "env": {"KANKA_TOKEN": "…", "KANKA_CAMPAIGN_ID": "…"}}}`.
- `defaultVisibility` applies only to things the source itself shows to
  players. Anything hidden there is always DM-only.
- Kanka only: set `trustPostVisibility: true` once the server runs
  mcp-kanka with the post-visibility fix described below. Until then, every
  post is imported as DM-only.

## Read-only

A source only calls read tools (the one exception is the WorldLore workspace, which
may also call `create_entities`, `update_entities` and `delete_entities` on a Kanka
note or journal tree; see docs/CONNECTORS.md): `find_entities`, `get_entities`,
`search_entities`, `list_projects`, `browse_tree`, `get_resource`,
`read_document`, `search`, `list_tags`, and `api_request` with `GET` only.
Any other call is refused before it is sent. LegendKeeper keys can be
write-enabled, so use a read-only key where you can.

## How each server marks DM-only content

Checked against the official docs in November 2026: LegendKeeper's
[developer guide](https://www.legendkeeper.com/developers/guide/) and
[v3 OpenAPI spec](https://www.legendkeeper.com/api/v3/openapi.json), and
[Kanka's API docs](https://app.kanka.io/api-docs/1.0/overview).

| Level | Kanka | LegendKeeper |
|---|---|---|
| Whole entry | `is_private` (mcp-kanka: `is_hidden`); templates (`is_template`) are skipped | resource `isHidden`, inherited from hidden ancestors; resource `permissions` with level 0 (No Access) for `MEMBER` or any user, on the resource or an ancestor |
| Part of an entry | posts: `visibility_id` and post `permissions` (2 = deny); character traits: `is_personality_visible`, trait `is_private` | document `isHidden` (from `GET /resources/<id>`) |
| Inline | none | `secret` blocks |
| Facts | attribute `is_private`; entity `is_attributes_private` hides all of them; `private_races`, `private_families`; tag `is_private` | property `isHidden` on sidebar properties and infobox rows |
| Sub-records | `visibility_id` on relations, timeline elements, reminders, inventory, markers | `isHidden` on map features, timeline events and assets |
| Links | `[entity:ID]`, `[character:ID]`, `[location:ID\|label]`... (ID is the entity id); `entry_parsed` has `<a class="entity-mention" data-id=…>` | runs `{ mention: { resourceId, documentId?, text? } }` |

Kanka `visibility_id`: 1 = all, 5 = members, which players see. 2, 3 and
4 are admin, admin-self and self (the
[visibilities page](https://app.kanka.io/api-docs/1.0/misc/visibilities);
the posts page numbers them 2 self, 3 admin, 4 self-admin). Either way
only 1 and 5 are shared; any other or missing value is DM-only.

## What the importer does

1. **Fails closed.** A missing or unknown hidden flag, an entity it
   couldn't load, an unknown parent, a property without `isHidden: false`,
   or a resource whose permissions it couldn't read: each makes the page,
   or that part of it, DM-only.
2. **Kanka API**
   - Lists each module with `?related=1&page=N` (45 to 100 per page, set
     by the account) until `links.next` is null. It builds each page URL
     itself: `links.next` can drop `related=1`.
   - Parents come from `parent_id` (the parent's entity id, Kanka 3.10+),
     else the older `location_id`-style field.
   - Tags are names from the `tags` module; private and hidden tags are
     left out.
   - 30 requests a minute (90 for subscribers). On 429 it waits for
     `Retry-After`, else 15, 30 and 45 seconds.
   - `is_attributes_private` is read from `/entities` when a module
     listing leaves it out.
3. **Kanka MCP**
   - Lists each type with `find_entities` using an old `last_synced`.
     Without it, an unfiltered listing times out. It pages to
     `sync_info.last_page`.
   - Loads full entities and posts with `get_entities`, 8 at a time.
   - Puts hidden posts in `secret` blocks. All posts get this unless the
     source trusts post visibility.
4. **LegendKeeper**
   - Lists every resource with `GET /resources?limit=100` and its cursor
     (`hasMore`, `nextCursor`).
   - Reads each resource (`GET /resources/<id>`) for documents, sidebar
     properties and permissions, and each page document's block tree
     (`GET /resources/<id>/docs/<doc>/blocks`, JSON).
   - Maps every block kind of schema 1. Layout columns and text fields are
     flattened; `map` and `unsupported` blocks are dropped for players.
   - Use an Admin key. A Member key never receives hidden resources,
     documents, properties or secret blocks, so nothing leaks, but the DM
     doesn't see them either.
   - REST: 429 `RATE_LIMITED` is retried after `Retry-After` (up to a
     minute). 402 means the project owner's plan doesn't allow API keys.
5. **Rebuilds player copies after every sync.** Links to DM-only pages
   become `(hidden)`, or keep the link's own label, so players don't learn
   those pages' names.
6. **Keys page paths on source ids**, because names repeat.
7. **Lint:** `GET /api/worlds/:world/library/lint` lists shared pages that
   still read like DM notes ("The secret:", "DM note:", "GM only"). Those
   are secrets written as plain text, which no format marks.

## Known server quirks

- **mcp-kanka**
  - Before the fix, posts with `visibility_id` 3 (admin) or 4
    (self-admin) were reported as `is_hidden: false`. Fixed on mcp-kanka
    branch `ccr-7ddc138f-xfrjxs` (commit `a4bbb02`).
  - `check_entity_updates` can report live entities as deleted. Detect
    deletions by a full listing instead.
  - Timeline and calendar rows can come back with `id` and `entity_id`
    swapped.
  - `search_entities` and organisation member lists return the raw
    `is_private` field.
  - `entry` is usually Markdown but is sometimes still HTML, and names can
    be HTML-escaped. The importer normalises both.
  - It reports `is_hidden: false` when Kanka sends no `is_private`, and a
    post with no `visibility_id` as not hidden. The importer can't tell
    these from real values, so keep "trust post visibility" off unless
    you need it.
  - It returns no attributes, traits or post permissions, so those are
    only imported by the Kanka API connector.
- **LegendKeeper MCP**
  - Most tools return text, not JSON. The importer only uses
    `api_request` (JSON), which passes REST v3 paths through.
  - `read_document` Markdown, `format=text` and the blocks `text` field
    print secret text with no marker. The importer never uses them.
  - `list_members` returns email addresses. The importer never calls it.

## Imported as records (not pages)

Besides pages, a sync can yield records (`docs/CONNECTORS.md`, "Records"),
kept in the `intake_*` tables and shown only to players when shared.

- **Kanka API** (not the mcp-kanka server, which has no read tool for these):
  - Relations (`GET relations`), with attitude. Shared only for
    `visibility_id` 1 or 5, not `is_private`, **and** when both pages are
    shared.
  - Timelines (eras and elements). Private timeline: all DM-only. An
    element is shared only for `visibility_id` 1 or 5 in a shared timeline.
  - Calendars, with the current date, in the world clock's shape.
  - Map markers (`maps/<id>/map_markers`). Shared only on a shared map, not
    private, `visibility_id` 1 or 5, and not linked to a private entity.
- **LegendKeeper** (MCP `api_request` or API key):
  - Calendars (`GET calendars`). No hidden flag exists, so they are DM-only.
  - Timelines (`time` documents): lanes become groups. An event is shared
    only when its own `isHidden` is false inside a shared timeline.
  - Maps (`map` documents) become pages with a `map` block (image and
    pins). A pin is DM-only when hidden, under a hidden folder pin, or for
    a hidden page; the player guard also drops pins for pages players
    can't open.

A listing that can't be read (a 403, a timeout) never removes what was
stored: those records are kept until the next complete sync.

## Not imported yet

- Kanka: organisation members, calendar reminders, inventory and custom
  modules. These have their own `visibility_id`, which an importer must
  apply.
- LegendKeeper: boards and `map` blocks inside pages (links to a map
  document). Map features other than pins (regions, paths, labels). Image
  and embed properties are not shown as facts.
