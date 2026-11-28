# API verification: Kanka and LegendKeeper

Every endpoint the librarian calls, checked against the sources' own published
API documentation (read 2026-11-17). Only the public documentation was read:
no call was made to either service. No campaign content is in this file.

Sources:

- Kanka: <https://app.kanka.io/api-docs/1.0/overview> and the pages it links
  (`setup`, `misc/requests`, `misc/errors`, `misc/pagination`, `misc/last-sync`,
  `misc/visibilities`, `entities`, `entities/entity-assets`, `entities/entity-image`,
  `entities/connections`, `entities/posts`, `campaigns`, `campaigns/images`, `maps`,
  `map_markers`, `calendars`, `timelines`, `notes`, `tags`, `search`).
- LegendKeeper: <https://www.legendkeeper.com/developers/> (quickstart, SDK guide,
  style guide) and the OpenAPI description <https://www.legendkeeper.com/api/v3/openapi.json>
  (v3.0.0, 95 operations). The "API reference" page is a viewer for that file.

Verdicts: **matches** (our request and reading agree with the docs), **fixed**
(was wrong, changed in this pass), **not in docs** (the docs are silent; code left
as it was).

## LegendKeeper images: upload and download

**Upload: yes, but not the way we had it.** The v3 API uploads an image in three
steps, with JSON and a signed storage URL. There is **no multipart upload**:
`POST /assets` only creates a *folder* (body `{ name, folderId? }`).

1. `POST /api/v3/projects/{projectId}/assets/uploads` (`createImageUpload`), JSON
   `{ contentType, contentLength, contentHash? }`. `contentType` is one of
   `image/jpeg`, `image/jpg`, `image/png`, `image/gif`, `image/webp`;
   `contentLength` is the exact byte size (charged against the owner's storage
   quota and a daily upload budget; over quota is `413 STORAGE_QUOTA_EXCEEDED`);
   `contentHash` is an optional lowercase hex SHA-256. Answer:
   `{ uploadKey, uploadUrl, method: "PUT", headers, expiresAt }`.
2. `PUT` the file to `uploadUrl` before `expiresAt`, sending `headers` exactly as
   given. The body must be exactly `contentLength` bytes. This goes to the storage
   host, not the API, so the API key is not sent.
3. `POST /api/v3/projects/{projectId}/assets/images` (`createImageAsset`), JSON
   `{ uploadKey, name (1 to 200), description? (max 10000), folderId? }`. Answer
   `201` with an `Asset` `{ id, name, type: IMAGE, folderId, isHidden, description,
   url, width, height, createdAt }` (width and height read from the stored file).

Any project member may upload and may create a folder. Updating or deleting an
asset (`PATCH` or `DELETE /assets/{assetId}`) needs the ADMIN role. The upload
tier has its own limit (`429 UPLOAD_RATE_EXCEEDED`). Only JPEG, PNG, GIF and WebP;
there is no PDF, text or audio upload (an asset can have `type: AUDIO`, but the
API has no way to create one).

**Map image assignment: yes.** `PATCH .../resources/{resourceId}/docs/{documentId}`
(`updateDocument`) takes `mapImage: { assetId }` (an image asset of the project the
caller can read). A map document reads back `mapImage: { assetId, url, width,
height, bounds, tiles }` (`url` and `assetId` are null for a legacy tiled map).
Other places that take an uploaded image are image blocks and properties,
`banner.url`, a map pin's `pinImage`, a timeline lane's `style.imageUrl` and an
event's `imageUrl`: each takes the `url` of an image asset of the same project and
refuses any other URL (`400 VALIDATION_ERROR`).

**Download: there is no download endpoint.** `GET /assets` (page of one folder:
`folderId`, `limit` 1 to 100, default 50, `cursor`; answer `{ data[], hasMore,
nextCursor }`) and `GET /assets/{assetId}` return the asset record, whose `url` is
"the file URL of an IMAGE asset, always on a LegendKeeper asset host". The file is
fetched by an ordinary `GET` of that URL. The docs do not say whether the asset
host needs a credential; what the real service returned (a public CDN host) is the
only evidence, and our code fetches it with no key (see below).

## Rate limits (both services)

| Service | Documented limit | What we do |
|---|---|---|
| Kanka | 30 requests a minute per user, 90 for subscribers; one limit shared by all of the user's tokens; `/profile` returns the current `rate_limit`; `429` when over (`setup`, `misc/errors`, `troubleshooting`). No rate-limit headers or `Retry-After` are documented. | **Matches.** Default 30 a minute, background budget 12 (the most it may use is 24); subscribers raise "Max calls per minute" to 90 on the connection. `429` waits `Retry-After` when sent, else backs off. Headers are read if the site sends them (not in the docs). |
| LegendKeeper | Per key: 300 a minute, 6,000 an hour, 60,000 a day. Writes (POST, PUT, PATCH, DELETE) per key: 120 a minute, 3,000 an hour. Per project across keys: 12,000 an hour. `X-RateLimit-Limit/Remaining/Reset` (Unix seconds) on every authenticated response for the tightest tier; `429` `RATE_LIMITED` or `UPLOAD_RATE_EXCEEDED` with `Retry-After`. The SDK guide advises writes at least half a second apart. | **Matches, now sourced.** Defaults 200 a minute (a real key answered `X-RateLimit-Limit: 200`, the tightest tier; a lower reported limit is adopted), 6,000 an hour per connection, a shared 12,000 an hour per project across keys, and 2 a second (the half-second advice). The background reader keeps to 80% of each and defaults to 40 a minute. Comments in `intake/ratelimit.ts` and `connectors/legendkeeper.ts` now cite these numbers. |

## Kanka endpoints

Base `https://api.kanka.io/1.0`, headers `Accept: application/json` and
`Authorization: Bearer <token>`; `Content-Type: application/json` only with a JSON
body; multipart boundary left to the HTTP client (`setup`, `misc/requests`).
Matches (`kankaHttp`, `kankaBase`).

| Call | Where | Doc | We send / read | Verdict |
|---|---|---|---|---|
| `GET /campaigns/{id}` | source-key check (`sourcekeys/live.ts`) | `campaigns` (Single Campaign) | read `data.id` | matches |
| `GET /campaigns/{id}/characters?page=1` | connection test | `characters` | read `meta.total`, `data[].name` | matches |
| `GET /campaigns/{id}/{module}?related=1&page=N[&lastSync=]` for characters, locations, organisations, families, items, notes, journals, quests, races, creatures, events, abilities, timelines, maps, calendars, tags | sync (`kanka.ts`) | `entities` (Related Entities), `misc/pagination`, `misc/last-sync`, each module page | `entry`, `posts`, `attributes`, `is_private`, `entity_id`, `tags`, `image_full`, `has_custom_image`, `parent_id`, `updated_at`; `links.next` / `meta.last_page`; `sync` timestamp kept as the next `lastSync` | matches |
| `GET /campaigns/{id}/entities?page=N` | attribute-privacy flag, key probe | `entities` (`is_attributes_private`, `meta.total`) | read the flag and total | matches |
| `GET /campaigns/{id}/entities/{eid}?related=1` | WorldLore guard | `entities` (Single Entity: `entity_type`, `child_id`, ...) | read type, child id, parent | matches |
| `GET /campaigns/{id}/relations` and `/entities/{eid}/relations` | relations | `entities/connections` | `owner_id`, `target_id`, `relation`, `attitude`, `visibility_id` | matches |
| `GET /campaigns/{id}/maps/{map}/map_markers` | map markers | `map_markers` | `latitude`, `longitude`, `shape_id` (1 to 4), `colour`, `entity_id`, `visibility_id`, `is_private` | matches |
| `GET /campaigns/{id}/timelines/{id}` | eras when the list lacks them | `timelines` | `eras[].elements[]`, `position`, `visibility_id` | matches |
| `GET /campaigns/{id}/search/{term}` | live key search | `search` | `entity_id` (falls back to `id`) | matches |
| Calendar fields (`months`, `weekdays`, `moons`, `seasons`, `suffix`, `skip_year_zero`, `date`) | calendars | `calendars` | mapped to the clock | matches |
| `POST /campaigns/{id}/entities/{eid}/entity_assets` | library file write-back | `entities/entity-assets` | multipart `type_id=1`, `visibility_id`, `name`, **`files`** | **fixed**: the file part was named `file`; the docs name it `files`. `name` is limited to 45 characters (a longer one is cut, extension kept). Answer is `200` with `{ data }` |
| `POST/PATCH/DELETE /campaigns/{id}/notes\|journals/{id}`, `POST /campaigns/{id}/tags` | WorldLore write-back (`kanka-write.ts`) | `notes`, `tags` | `name`, `entry`, `parent_id` (entity id), `is_private`, `tags` | matches |
| `GET image_full` of an entity or map | picture and map import | `entities` (`image_full`: "the url to the picture") | plain `GET`, no token sent | matches for the field; whether the image host needs a credential is **not in docs** |
| Entity page URL `{app}/w/{campaign}/entities/{eid}` | "Open in Kanka" | `entities` (`urls.view`, example `https://app.kanka.io/w/1/entities/2`) | `urls.view` when present, else built the same way | matches |

Notes where the Kanka docs disagree with themselves or are silent:

- **Visibility numbers.** `misc/visibilities` lists 1 all, 2 admin, 3 admin-self,
  4 self, 5 members, but the `entity_assets`, `map_markers` and posts pages say
  "1 all, 2 self, 3 admin, 4 self-admin, 5 members". Only 1 and 5 reach players in
  our reading, so every other value stays GM-only. For the file write-back we send
  2 for a non-party file: under either table it is not visible to ordinary members.
- A map marker example shows `shape_id: 5`; the create page lists only 1 to 4.
  Unknown shapes are drawn as a plain marker.
- Relations in the docs carry no `id` or `is_private`; the code accepts both when
  they appear and otherwise derives a stable id.
- `GET /profile` (rate limit and `default_pagination`) is documented but not called.
- `POST /entities/{id}/image` (set an entity's picture; stores it in the campaign
  gallery, `is_header` for premium) and the gallery `campaigns/{id}/images`
  endpoints are documented; Alexandria does not write entity pictures back.
- The mcp-kanka connectors use the MCP server, not this API; there is nothing in
  the Kanka docs to check them against.

## LegendKeeper endpoints

Base `https://www.legendkeeper.com/api/v3/projects/{projectId}`; `Authorization:
Bearer <project API key>`. A key needs the project owner on a paid plan (`402
PAID_PLAN_REQUIRED` otherwise), acts with the lower of its own and its creator's
role, and a request for another project is `403 WRONG_PROJECT`. A list is
`{ data, hasMore, nextCursor }`, a delete is `204`. Matches (`restTransport` sends
`Authorization` and handles `402`, `429` and `Retry-After`).

| Call | Where | Doc operation | We send / read | Verdict |
|---|---|---|---|---|
| `GET /resources?limit=100&cursor=` | sync, key check, key search, test | `listResources` (limit 1 to 100, default 50) | `data[]` with `id`, `name`, `parentId`, `rank`, `isHidden`, `tags`, `aliases`, `documents[]`, `iconGlyph`, `iconColor`, `updatedAt`; `hasMore` / `nextCursor` | matches for paging and fields. **Fixed**: without `parentId` the list also holds templates (top-level ones have `parentId: "templates"`), and the list item has no template flag, so we imported them as pages. They are now left out (a resource under `templates` or under a template) |
| `GET /resources/{id}` | detail, key check | `getResource` | `documents[]` (with `isHidden`, `mapImage`), `properties`, `permissions`, `ancestors`, `banner`, `parentId` | matches |
| `GET /resources/{id}/docs/{doc}/blocks` | page content | `getDocumentBlocks` | `blocks[]` (kinds paragraph, heading, quote, code, rule, lists, tables, callout `tone`, expand, layout, image, embed, keyValue, infobox, meter, resourceCollection, resourceLink, map, secret, textField, unsupported) | matches |
| `GET .../docs/{doc}/features` | map pins | `listFeatures` (not paged) | `pos` `[lat, lng]`, `type`, `uri`, `parentId`, `isHidden`, `iconGlyph` | matches |
| `GET .../docs/{doc}/lanes` | timelines | `listLanes` (**not paged**, no query) | `id`, `name`, `rank` | **fixed**: we sent `limit` and `cursor`; the docs define no query for this list. It is now called bare |
| `GET .../docs/{doc}/events?limit=100&cursor=` | timelines | `listEvents` (paged, limit max 100) | `laneId`, `type`, `start`, `formattedStart`, `isHidden`, `uri`, `color` | matches |
| `GET /calendars` | calendars | `listCalendars` (not paged, no query) | `months`, `weekdays`, `moons` (`phase`, `shift` in minutes), `positiveEras`, `hoursInDay`, `minutesInHour`, `hasZeroYear` | matches |
| Map image | map import (`lkMapBlock`, picture record) | `Document.mapImage` | `mapImage.url`, `width`, `height` (null `url` for a legacy tiled map) | matches |
| Image `GET asset url` | map picture download | `Asset.url` | plain `GET`, no key, public hosts only | matches for the field; credential need **not in docs** |
| `POST /assets` (multipart `name`, `file`) | library file write-back | `createAssetFolder` | n/a | **fixed**: this endpoint only creates a folder; there is no multipart upload. Now the three-step upload above |
| `POST /assets/uploads`, `PUT <uploadUrl>`, `POST /assets/images` | library file write-back | `createImageUpload`, signed storage `PUT`, `createImageAsset` | as in the first section; `Idempotency-Key` on both POSTs | **fixed** (new). Pictures only; PDF and text are no longer offered for LegendKeeper. The signed URL must be public https; the API key is never sent to it |
| `POST /resources`, `PUT .../blocks`, `PATCH /resources/{id}`, `POST .../move`, `DELETE /resources/{id}` | WorldLore write-back (`legendkeeper-write.ts`) | `createResource`, `replaceDocumentBlocks`, `updateResource`, `moveResource`, `deleteResource` | `{ name, parentId, isHidden, documents: [{ type, name, blocks }] }`, `{ blocks }`, `{ parentId }` | matches |
| App page URL `https://www.legendkeeper.com/app/project/{project}/resource/{id}` | "Open in LegendKeeper" | none | best guess, overridable with `webUrl` | **not in docs**: neither the API reference nor the guides give an app address |

Notes where the LegendKeeper docs are silent or add a caveat:

- **Hidden content.** Secret blocks and properties with `isHidden` are admin-only
  and a non-admin key never sees them (`403` on a write that would touch one). We
  already ask for an Admin key; nothing changes.
- **Whole-page replace.** `replaceDocumentBlocks` deletes any block not echoed by
  id, including `unsupported` ones the block model cannot express. WorldLore
  replaces the whole page from Markdown, so it first reads the page's blocks and
  sends every block Markdown cannot express (infobox, image, embed, table,
  collection, unsupported...) back unchanged, by id, in the place it held: under
  the same heading, after the same number of text blocks (never past the end of
  that section); if the heading is gone, after the same number of text blocks from
  the top. Over the MCP it puts an `lk:keep` marker at that place, which the MCP's
  `write_page` preserves. Fixed; tested in
  `TestWorldLore_RewriteKeepsBlocksMarkdownCannotExpress` and
  `TestWorldLore_KeptBlocksStayWhereTheyWere`.
- `GET /search`, `GET /tags` (ADMIN), `GET /projects`, `GET /projects/{id}`, chat
  and member endpoints exist; we do not call them. Key search lists `/resources`
  by name rather than using `/search`.
- A request body over 1 MB is refused by the host before the API runs (plain-text
  `413`); uploads are not affected because the bytes go to storage.
- Whether the asset host needs a credential, the asset URL lifetime, a daily upload
  budget number, and the file size cap per image are not stated.

## Tests

The fakes follow the documented shapes: Kanka answers `entity_assets` with `200`
and `{ data }` and the test checks the `files` part and the 45-character name;
the LegendKeeper fake implements the three upload steps (the test checks the
order, the JSON bodies, the signed headers, no API key to storage, and that no
asset is registered when the storage `PUT` fails) and a resource list that
includes templates and an unpaged lane list (`test/libfiles.test.ts`,
`test/intake-records.test.ts`).
