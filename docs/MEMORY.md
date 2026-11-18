# Memory: semantic search, related pages and the story bible

Three things read the library through the optional models, and all three are
built per reader: what you get back is made from the copy of each page you
may read, never from a copy above your level.

- **Semantic search** (the `extra` embeddings job): pages are cut into chunks
  of about 500 characters, embedded in the background and stored in SQLite
  (`search_chunks`). Keyword results and nearest chunks are merged.
- **Smart connections** (related pages with a percent):
  `GET /api/worlds/:w/library/pages/:id/related?limit=8`, MCP `related_pages`,
  the "Connections" panel on a library page.
- **Story bible** (the `chat` job): facts (subject, kind, one sentence, the
  page it came from) read out of each page copy. `GET /api/worlds/:w/bible`
  (`?subject=`, `?kind=`, `?q=`), MCP `story_bible`, the "Story bible" page for
  the DM and for players.

Nothing here runs without its model. Without embeddings, search is keyword
only and Connections stays hidden. Without a chat model the bible is empty.
A model that is down is skipped quietly and tried again later.

## Scopes: who reads which rows

Every row (chunk or fact) belongs to one scope, cut from one copy of the page.

| scope    | cut from                                  | read by                                         |
|----------|-------------------------------------------|-------------------------------------------------|
| `dm`     | the AI copy (everything but classified)   | the DM, and every model on the DM's behalf      |
| `broker` | the broker copy (party + broker content)  | the information broker                          |
| `party`  | the player copy of a party-level page     | every player and guest                          |
| `lifted` | the player copy of a page that is not party-level but that some account may open now | players, one page at a time |

`lifted` is for pages a player may open although the page is DM-level: their
own per-user source key sees it, the DM granted it, or another player shared
it (see `features/sourcekeys`). The text is the same for everyone who may see
it, so it is embedded once. Who may see it is decided live, on every read:
`Library.liftedPages` (access sets, shares, the sharer still seeing the page).

A reader gets `base` plus (players only) the lifted rows of the pages they
may open right now (`features/search/scopes.ts`, `reachOf`):

- DM or model: `dm`. Broker: `broker`. Player: `party` + their lifted pages.
  Guest: `party` only.
- Classified text is never embedded, never extracted and never sent to a
  model (`core/ai.ts` also refuses it). DM-only text is never in `party`,
  `lifted` or `broker`.
- A related percent is the cosine of two page vectors (the normalized mean of
  a page's chunk vectors), both taken from the reader's own scope, mapped to
  0 to 100. It cannot carry hidden text or reveal a hidden link. The reason
  shown is the best matching passage of the related page in the same scope.
- Only pages the reader may open are returned; the source page must be
  openable too (a 404 otherwise).

## Permission changes delete at once

`Library.changed(worldId, ids?)` runs `reconcile` (`scopes.ts`) in the same
step as the change, before any read: it deletes every chunk, fact and state
row whose page has no copy for that scope any more (level changed, hidden at
the source, classified, removed, source audience changed, source or world
deleted), whose text is older than the page's current copy, or whose `lifted`
page no player may open (share removed, key revoked or changed, member
removed). Re-embedding and re-extraction happen later in the background.

Called from: `Library.save`, `setLevel`, `saveEntry`, `applyAudience`
(through `rebuildPlayerCopies`), `removeMissing`, `remove`, share and unshare,
key revoke, refresh and change, and removing a member.

Every read checks again (belt and braces): hits, related pages and facts are
filtered against the `pages` table and the live lifted set. A stale row that
somehow survives is never returned.

## Background jobs and the admin page

- `search` feature: embeds stale pages every 20 s (`ALX_SEARCH_EMBED_MS`),
  in the order party, lifted, broker, dm; budgeted per tick.
- `bible` feature: extracts facts for pages whose copy changed, every 30 s
  (`ALX_BIBLE_MS`), 10 pages per tick. A crawl (Library pull all) triggers
  both after fetching.
- Admin > Models shows the embeddings job state and, per world and scope,
  pages read, chunks and facts, with a "Re-embed world" action
  (`GET /api/admin/embeddings`, `POST /api/admin/embeddings/:world/reembed`).
  DMs have `POST /worlds/:w/search/reembed`, `/bible/rebuild`, `/bible/refresh`.

## Vector store

Chunks go through a small `VectorStore` interface (`features/search/vectorstore.ts`):
`rows(world, scope)`, `replacePage`, `deletePage`, `deleteWorld`, `counts`.
The only backend is SQLite with brute-force cosine in memory. Another backend
could be added behind the same interface; callers pick scopes and check hits
against `pages`, so the permission model does not depend on the store.

## Tests

`librarian/test/memory.test.ts` (scopes, related, bible, immediate deletion
on each change, classified never sent, model down). The leak crawler seeds a
DM-only page, a page shared with jess and then unshared, and a page hidden at
its source, all embedded and extracted first (`security-world.ts`).
