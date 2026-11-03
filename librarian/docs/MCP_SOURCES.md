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

A source only calls read tools: `find_entities`, `get_entities`,
`search_entities`, `list_projects`, `browse_tree`, `get_resource`,
`read_document`, `search`, `list_tags`, and `api_request` with `GET` only.
Any other call is refused before it is sent. LegendKeeper keys can be
write-enabled, so use a read-only key where you can.

## How each server marks DM-only content

| Level | Kanka | LegendKeeper |
|---|---|---|
| Whole entry | `is_hidden` (Kanka's `is_private`) | resource `isHidden`, inherited from hidden ancestors |
| Part of an entry | posts: `is_hidden` (from `visibility_id`) | document `isHidden` (only from `GET /resources/<id>/docs/<doc>`) |
| Inline | none | `> [!secret]` callouts in Markdown |
| Sub-records | `visibility_id` on relations, timeline elements, reminders, inventory, markers | none on pins, timeline events or facts |
| Links | `[entity:ID]`, `[entity:ID\|label]` | `[Name](lk://resources/<id>)`; unresolved links print as `\[\[Name\]\]` |

Kanka `visibility_id`: 1 = all, 2 = self, 3 = admin, 4 = self-admin,
5 = members. Only 1 and 5 are visible to players.

## What the importer does

1. **Fails closed.** A missing or unknown hidden flag, an entity it
   couldn't load, an unknown parent, or a document whose metadata it
   couldn't read: each makes the page DM-only.
2. **Kanka**
   - Lists each type with `find_entities` using an old `last_synced`.
     Without it, an unfiltered listing times out. It pages to
     `sync_info.last_page`.
   - Loads full entities and posts with `get_entities`, 8 at a time.
   - Wraps hidden posts in `<!-- dm -->` blocks. All posts get this unless
     the source trusts post visibility.
3. **LegendKeeper**
   - Lists every resource with `api_request GET /resources` and its cursor.
   - Applies `isHidden` from the resource, its ancestors, and each
     document.
   - Reads page documents with `read_document` as Markdown. The leak guard
     removes `> [!secret]` blocks. Never use `format=text` or the JSON
     `text` field: they print secret text with no marker.
4. **Rebuilds player copies after every sync.** Links to DM-only pages
   become `(hidden)`, or keep the link's own label, so players don't learn
   those pages' names.
5. **Keys page paths on source ids**, because names repeat.
6. **Lint:** `GET /api/worlds/:world/library/lint` lists shared pages that
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
- **LegendKeeper MCP**
  - Most tools return text, not JSON. The importer uses `api_request`
    (JSON) for structure and `read_document` (Markdown) for content.
  - `read_document` puts a header (resource, document, path, then `---`)
    above the Markdown. The importer strips it.
  - Fenced `:::secret` blocks are not LegendKeeper secrets. Only
    `> [!secret]` is.
  - `list_members` returns email addresses. The importer never calls it.

## Not imported yet

- Kanka: relations, organisation members, timelines, calendars and
  reminders. These have their own `visibility_id`, which an importer must
  apply.
- LegendKeeper: maps (pins, regions, paths), timelines, boards and
  sidebar facts. None of these has a visibility of its own, so it must
  take its document's visibility, and be dropped when it links to a
  DM-only page.
