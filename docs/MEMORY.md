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
  the GM and for players.

Nothing here runs without its model. Without embeddings, search is keyword
only and Connections stays hidden. Without a chat model the bible is empty.
A model that is down is skipped quietly and tried again later.

## Scopes: who reads which rows

Every row (chunk or fact) belongs to one scope, cut from one copy of the page.

| scope    | cut from                                  | read by                                         |
|----------|-------------------------------------------|-------------------------------------------------|
| `gm`     | the AI copy (everything but classified)   | the GM, and every model on the GM's behalf      |
| `broker` | the broker copy (party + broker content)  | the information broker                          |
| `party`  | the player copy of a party-level page     | every player and guest                          |
| `lifted` | the player copy of a page that is not party-level but that some account may open now | players, one page at a time |

`lifted` is for pages a player may open although the page is GM-level: their
own per-user source key sees it, the GM granted it, or another player shared
it (see `features/sourcekeys`). The text is the same for everyone who may see
it, so it is embedded once. Who may see it is decided live, on every read:
`Library.liftedPages` (access sets, shares, the sharer still seeing the page).

A reader gets `base` plus (players only) the lifted rows of the pages they
may open right now (`features/search/scopes.ts`, `reachOf`):

- GM or model: `gm`. Broker: `broker`. Player: `party` + their lifted pages.
  Guest: `party` only.
- Classified text is never embedded, never extracted and never sent to a
  model (`core/ai.ts` also refuses it). GM-only text is never in `party`,
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
  in the order party, lifted, broker, gm; budgeted per tick. Small edits are
  handled here: one changed page is one small request.
- `bible` feature: extracts facts for pages whose copy changed, every 30 s
  (`ALX_BIBLE_MS`), a few pages per tick, only when "When it reads" allows.
- Admin > Models shows the embeddings job state and, per world and scope,
  pages read, chunks and facts, with "Index all now" and "Re-embed world"
  (`GET /api/admin/embeddings`, `POST /api/admin/embeddings/:world/build`,
  `POST /api/admin/embeddings/:world/reembed`).
  GMs have `POST /worlds/:w/search/build`, `/search/reembed`, `/bible/rebuild`,
  `/bible/refresh` and `/bible/read-now` (`{ "all": true }` for everything).

## Bulk builds (first import, re-embed, rebuild)

A whole world is not left to the ticks above. A bulk build
(`features/search/bulkbuild.ts`) embeds every waiting page copy, then reads
every waiting copy into the story bible, in one pass. It is a job (`index-build`:
Admin > Jobs shows its progress, it can be stopped, a restart resumes it), and
its model calls go in at background priority so the table's requests still go
first.

It starts on its own after a crawl (Library > pull all; the crawl embeds inline
and starts the bible part), after "Re-embed world", after a story bible
rebuild, and on `POST /worlds/:w/search/build` (body `{ "embeddings": false }`
or `{ "bible": false }` to do only one part) or "Index all now". One per world
at a time; asking again while it runs answers `started: false`.

How wide it goes (`features/search/batching.ts`):

| Setting | Default | What it does |
| --- | --- | --- |
| `ALX_EMBED_BATCH` | 64 | Chunks (or story bible facts) per embeddings request. Chunks of many pages share a request; each request's pages are written in one transaction. |
| `ALX_EMBED_PARALLEL` | the model's `maxConcurrent` | Embeddings requests in flight at once. |
| `ALX_BIBLE_PARALLEL` | the model's `maxConcurrent` | Pages the story bible reads at once. |

The model queue still has the last word: a local model takes 2 calls at a time
unless its job option `maxConcurrent` says more. To go faster on a local server,
raise `maxConcurrent` on the embeddings and story bible models to match the
server's parallel slots (llama.cpp `-np`, for example) and, for embeddings,
make sure the server's batch size takes `ALX_EMBED_BATCH` inputs of about 500
characters each. A page the classified guard refuses is sent on its own, so it
never holds back the pages around it.

## Refresh world and the Knowledge page

GM > Prep > **Knowledge** shows how current everything the assistant knows is:
each source (pages, pictures stored and waiting, last sync), the search index
and story bible (pages read of pages there are), and Minerva's codex links
(codex pages linked to a library page, and ones whose page is gone).

**Refresh world** is one job (`refresh-world`, `features/knowledge/refresh.ts`)
that runs, in order, and shows each step's progress:

1. **Sync sources**: the crawl, sources only (what changed; **Full refresh**
   lists everything again and removes pages a source no longer has).
2. **Store pictures**: every queued portrait and picture in page text,
   downloaded and stored here (`docs/CONNECTORS.md`, "Portraits and pictures in
   page text"). Pictures that failed before get another chance.
3. **Search index and story bible**: one bulk build (above), after any bulk
   build already running for the world.
4. **Minerva's codex links** (`features/minerva/relink.ts`): a codex page whose
   library page was renamed gets its `Library: [[...]]` line fixed; one whose
   page was removed and added again (a new id) is linked again by its title or
   an alias, when exactly one page matches; a codex page with no link is linked
   to a library page of the same name. Ones that cannot be mended are listed,
   never guessed. The home page and calendar index are rewritten.

A step runs even when an earlier one had problems. It is a job: Admin > Jobs
lists it, it can be stopped, a restart starts it again, and one runs per world
at a time (not while a crawl runs). The last run is kept per world.

API (GM): `GET /api/worlds/:w/knowledge`, `POST /api/worlds/:w/knowledge/refresh`
(`{ "full": true }` for a complete listing; 202, or 409 while one runs),
`POST /api/worlds/:w/knowledge/refresh/stop`. MCP: `refresh_world` (GM write key).

Copies with the same text are read once. A page's party, broker and GM copies
are often identical; when one copy's text (its hash) matches another scope's
copy of the same page, the vectors and facts are copied instead of asking the
model again. On a real 825-page world this skipped about 30% of the work.

### Embedding prefixes

Some embeddings models are trained with a prefix that says what a text is.
Set it in the embeddings model's job options (Admin > Models), or with
`ALX_MODEL_EXTRA_OPTIONS`:

```json
{ "docPrefix": "search_document: ", "queryPrefix": "search_query: " }
```

These are the values for nomic-embed-text. `docPrefix` goes before every
stored library chunk and story bible fact, `queryPrefix` before every search.
On an 80-question test over a real world, the top result was right 57.5% of
the time with them and 50% without. The document prefix is part of what the
chunks are recorded as made with, so changing it embeds the world again.
Leave both unset for a model that has no prefixes (most do not).

## Vector store

Chunks go through a small `VectorStore` interface (`features/search/vectorstore.ts`):
`rows(world, scope)`, `replacePage`, `deletePage`, `deleteWorld`, `counts`.
The only backend is SQLite with brute-force cosine in memory. Another backend
could be added behind the same interface; callers pick scopes and check hits
against `pages`, so the permission model does not depend on the store.

## Tests

`librarian/test/memory.test.ts` (scopes, related, bible, immediate deletion
on each change, classified never sent, model down). The leak crawler seeds a
GM-only page, a page shared with jess and then unshared, and a page hidden at
its source, all embedded and extracted first (`security-world.ts`).
