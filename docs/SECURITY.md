# Security: what is checked, and how

Two promises, checked by tests that run with `npm test`:

1. **DM-only information never reaches a player.** That means responses,
   live events, MCP tools, files, media and the player's own AI.
2. **Classified information never reaches any AI.** That means model
   requests, MCP answers and anything sent to the model gateway.

The levels (`party`, `broker`, `dm`, `classified`) and the four copies of a
page are described in `librarian/README.md` and `librarian/src/core/levels.ts`.
This page is about the tests and the last lines of defence.

## The leak crawler

`librarian/test/security-crawl.test.ts`, with its world in
`security-world.ts` and helpers in `security-kit.ts`.

**One world, a marker at every secret spot.** `seedContent()` gives each
secret its own random token (for example `ZQX-DMPAGE-7f3a21`, new on every
run) and says who may see it. Spots covered include:

- pages at every level, and secret, broker and classified blocks, headings,
  callouts, comments, frontmatter keys, DM aliases and links inside a shared
  page
- imported pages with DM, broker and classified fact groups, secret blocks,
  map pins; imported relations, timelines and map markers that are private
- DM item notes (and alerts after an edit), item pictures, a player's
  proposed item, DM-only people, quotes and notes, the DM's note on a shared
  person, every player's private note and profile block ("only me")
- DM-only map marks, a mark the DM hid, hidden combatants, monster HP
- DM-only clock events, broker notes and spoiler topics, broker offers to
  other players, a player's broker question (and the DM-side evidence), open
  and resolved quick events (DC, success and fail text)
- transcript DM and aside lines, session-log drafts and DM notes, stage cards
  in staging and a card shown to one player, a stage picture, the party chat
  (players only), the table chat, a chat between two players, trades
- quick-gen, Sculpting (templates, history), voice presets, WorldLore broker
  and classified pages, the agent's chats and pending actions, the audit log
- a second world, whose pages must never show up in the first

Look at `mark(id, seen, where)` calls: `seen` lists who may read it
(`dm`, `jess`, `tom`, `guest`; `dm2` means nobody here).

**The crawl.**

- Routes are found by walking the Express router stack of `createApp()`
  (`listRoutes`). A route added tomorrow is crawled with no change.
- Path parameters are filled with real ids from the database (every page id
  and path, every item, person, card, thread...) plus one that does not
  exist. Routes that take a query string are asked several ways (`SPEC` and
  `queries()` in the test).
- **As a player** (session and read key), **as a guest**, and **as the DM**
  (session, read key, write key, and a DM request flagged as a model), every
  GET route is read. Any marker the viewer may not read, found in any
  response, fails the test, naming the marker and the URL.
- Also checked: every live event on each viewer's event stream (open during
  all the seeding), every MCP tool a read key lists, the global search and
  page search (also semantic) for each marker, the offline prefetch routes
  (read from `web/src/lib/prefetch.ts`) and the bulk page fetch, stage and
  item pictures, sound and voice files, media tickets (a player only ever
  gets tickets made for them).
- The DM side: the party chat marker and another player's private markers
  never appear in anything the DM, the DM's keys or the DM's MCP tools read.
- A crawl that finds nothing proves nothing, so two more tests guard it:
  `EverySeededSecretCanBeReadByWhoOwnsIt` (every marker was shown to someone
  allowed to read it) and `TheCrawlerCatchesALeakWhenOneIsMade` (it shares a
  DM page, and lowers a classified page, and the crawl must fail).

**Authorization.**

- `PlayersCannotCallDmRoutes`: every POST, PUT, PATCH and DELETE route, called
  by a player and a guest with real ids and an empty body, must answer 401,
  403 or 404. A 400 or 409 would mean the handler ran before it checked who
  was calling. The routes a player may call are listed by hand in
  `PLAYER_ROUTES`; adding to that list is a review decision.
- Read keys cannot write (all write routes answer 403, and a read key cannot
  call a write tool over MCP). Players cannot make write keys.
- An admin (table session or gateway admin session) is not a DM: world routes
  answer 404 or 403. Push keys read nothing. A key made for one world does
  nothing in another; a person in one world gets nothing from another.
- Media tickets are signed, for one account and one kind of file, expire, and
  are checked again on every use.
- Revoked and signed-out credentials stop working.

## The AI crawler

In the same file. A recording fake stands in for every model job
(`fakeModels` in `security-kit.ts`, installed with `createApp({ fetch })`) and
the test drives every model-using feature: the DM agent (prefetch and tools,
with a classified page on screen and its words selected), a player's
assistant, Sculpting (every built-in template), the session-log draft and
revise, a statblock from a page, quick-gen flavour, read aloud, the broker's
routing, a recorded chunk of audio (the transcription prompt), embeddings
indexing, and every MCP tool with a DM write key (once per page, the
classified ones included).

It then checks that no classified marker appears in **any** recorded model
request body, in any MCP answer, or in any GET answer given to a caller flagged
as a model. It also checks that a player's assistant was sent nothing that
player may not see, and that the DM's was sent no player's private note.

## The last line of defence: `core/ai.ts`

Before any request leaves for a model (`chat`, `chatStream`, `chatJson`,
`embed`, `speak`, a transcription prompt, and the `/v1` gateway) the outgoing
text is checked against an index of every 8-word run of classified text, in
every world.

- Classified text is whatever the DM copy of a page has that no AI copy has
  (a classified page, block, fact group or frontmatter key), minus any run that
  also appears in text a model may read.
- The index (`Library.classifiedGrams()`) is built on first use and again
  after any page changes (`touchClassified()`, called on every write in
  `core/library.ts`). A check is a hash lookup per run of eight words: about
  0.15 ms for a typical prompt, 0.5 ms for a long one, and free when nothing is
  classified (`security-guard.test.ts` times it).
- A hit throws `ClassifiedRefused` (a `ModelUnavailable`, so callers fall back
  as they do with no model; `chatJson` answers `null`), nothing is sent, and an
  audit row `ai.classified_refused` names the world and page, never the text.
- `isModelSafe` and `classifiedMatch` in `core/levels.ts` do the matching.
- The other way out is an *answer* to a caller that says it is a model (the
  MCP server, the agent's tools, any client sending `X-Alexandria-Caller:
  model`). `loadWorld` wraps `res.json` for those callers: an answer that
  repeats classified text is replaced by a 409 and audited as
  `ai.classified_withheld`.
- What it cannot do: a classified fact shorter than 8 words is not caught
  here (the copies keep it out; this is the net). Words typed in a different
  order or paraphrased are not matched.

## What is stored, not just served

`librarian/test/security-state.test.ts`:

- Classified text lives only in the DM columns of `pages` and the DM search
  index (`fts_dm`). No other table, no `player_*`, `broker_*` or `ai_*`
  column, no other search index, and no file outside the DM's `vault/` folder
  holds it.
- Changing a page's level, or deleting it, takes it out of every copy, every
  index, every semantic chunk and every file the new audience must not have
  (including the `party/` and `_api/` files), and cards, item cards and people
  that used it stop showing it.
- A broker-level answer waits for the DM.

## Adding a feature: how it gets covered

1. Your routes are crawled automatically. If a player may call one of your
   write routes, add it to `PLAYER_ROUTES` in `security-crawl.test.ts`.
2. If your feature stores something that not everyone may see, add a marker to
   `seedContent()` in `security-world.ts`:
   ```ts
   await dm('POST', '/myfeature/things', { title: mark('thing_dm', ['dm'], 'a DM-only thing') });
   ```
   Use `mark('id', ['dm', 'jess'], ...)` for something one player owns, and
   `{ ai: false, long: true }` for classified text (a whole sentence). If the
   secret is a number, use `markNum`.
3. If a path parameter of yours is not an id the crawler knows, add its table
   to `SPEC`. Without it the crawl still asks for an id that does not exist.
4. Run `npm test`. A leak fails with the marker's name, where it was seeded and
   the URL (or the live event, MCP tool or model request) that carried it.
5. Never call a model except through `core/ai.ts`, and never import
   `app.ts` at runtime from a feature.

## Known, by design

- The whiteboard is one shared board. Everyone reads every version, so a
  drawing of the DM's is visible to the table (the crawler checks that it is,
  as a control).
- A map mark a player shared and the DM hid later was in a live event when it
  was made (`eventsOk` in the seed). It is gone from every read after the
  hide.
- Another world's text can be in the same embeddings batch (one model for the
  whole server). It is never in an answer to anyone.
