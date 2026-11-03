# Alexandria Librarian

The librarian is the one server behind every Alexandria screen: accounts and
keys, worlds, each world's library (the mirror), and everything at the table
(live session, combat, quick events, messages, calendar, map marks,
inventory, people, whiteboard). Admin, DM, player and phone screens all talk
to it over the same JSON API.

- One SQLite file (Node's built-in `node:sqlite`, nothing native to build)
- Live updates over Server-Sent Events, filtered per viewer on the server
- A Markdown mirror per world on disk that Obsidian-style editors can open

## Run it

Needs Node 22.13 or newer.

```bash
cd librarian
cp .env.example .env
npm install
npm start            # or: npm run dev (restarts on change)
```

First run: create the admin (the first account is always the admin):

```bash
curl -X POST localhost:8090/api/setup -H 'Content-Type: application/json' \
  -d '{"username":"wizard","password":"at least ten characters"}'
```

Docker: `docker compose up -d --build` (data in `./data`, vaults mounted
read-only from `./vaults`).

Checks: `npm run check` (types) and `npm test` (end-to-end API tests,
mostly about leaks).

## How nothing DM-only reaches a player

All rules live in `src/core/policy.ts`.

1. **Every record has a visibility**: `dm` (DMs and the owner), `party`
   (everyone in the world) or `me` (only the owner, so a player's "only me"
   notes are hidden from the DM too). Anything missing or unknown counts as
   `dm`.
2. **Library pages are DM-only unless marked** `visibility: party`.
3. **Player copies are made when a page is saved**, not when it is read.
   The copy drops:
   - frontmatter keys `secret:`, `dm_*` and `gm_*`
   - `> [!secret]`, `> [!dm]` and `> [!gm]` callouts
   - `%% comments %%`
   - `<!-- dm -->…<!-- /dm -->` blocks (an unclosed one hides the rest of
     the page)
   - headings marked `(DM)`, `[DM]` or "DM only", or titled Secrets or
     DM notes, along with everything under them

   Players are only ever served this copy. The party search index is built
   from it, and the `party/` folder of the on-disk mirror holds only these
   copies.
4. **Relations** from frontmatter (`parents`, `children`, `spouse`,
   `siblings`, `member_of`, `relations:`…) are DM-only when they are under
   `secret:`, or when they point at a DM-only page.
5. **Role-filtered views are computed on the server.** In the combat view
   for players:
   - hidden combatants are left out
   - the party has no health
   - monster health appears only as World settings allows (hidden, words
     like "Bloodied", a bar, or numbers)

   Quick events never show a player the DC, or the success or fail text,
   before the DM resolves them, and afterwards a player sees only their own
   outcome.
6. **Live events** carry an audience check that runs for each connected
   viewer, so a DM-only event is never written to a player's stream.
7. **Admin is not DM.** The admin flag manages accounts, worlds and sources
   but opens no world's content. **Scribe keys** (`alx_scr_`) work only for
   their own world and never carry admin rights. Keys cannot mint keys.
   Keys and sessions are stored only as hashes.

## Screens → API

All world routes are under `/api/worlds/:world` (id or slug). Send
`Authorization: Bearer <session or key>`.

| Screen (canvas board) | Endpoints |
|---|---|
| Sign in, player sign-in | `POST /api/setup`, `POST /api/auth/login`, `POST /api/join` (invite code), `POST /api/auth/reset` |
| Accounts & roles | `/api/admin/accounts` (create gives a one-time reset code), `PATCH …/:id`, `POST …/:id/reset-code` |
| Worlds | `/api/admin/worlds`, `PUT /api/admin/worlds/:id/members/:account` |
| World sources | `POST /api/admin/worlds/:id/sources` (vault, git, kanka), `POST /api/admin/sources/:sid/sync` |
| MCP keys | `GET/POST /api/keys`, `DELETE /api/keys/:id` |
| World mirror, Lore | `GET /library/pages`, `GET /library/pages/:id`, `PUT /library/pages` (DM), `GET /library/search?q=` |
| Relations & family | `GET /library/relations` |
| Change requests, My requests | `GET/POST /requests`, `POST /requests/:id/decide` (can apply to the page) |
| Messages (DM and player) | `GET/POST /messages`, `GET/POST /messages/:tid`, `POST /messages/:tid/keep`, `POST /messages/:tid/members` |
| Quick events, player prompt | `GET/POST /quick-events`, `POST …/:id/respond`, `POST …/:id/resolve`, `POST …/:id/cancel` |
| Session calendar | `GET/POST /calendar`, `PATCH /calendar/:sid`, `PUT …/rsvp`, `GET/POST …/chat`, `POST …/reschedule`, `POST …/reschedule/:rid`; feed at `/dav/worlds/:world/sessions.ics` |
| Live session (player) | `GET /live`, `PUT/DELETE /live/presence`, `GET/POST /live/ledger` |
| Combat | `GET/PUT /live/combat`, `POST /live/combat/next`, `POST/PATCH/DELETE /live/combatants/:id` (`damage`, `heal` for the wheel/numpad) |
| Party & inventory, Inventory | `GET /inventory?owner=me\|party\|<account>`, `POST /inventory`, `PATCH/DELETE /inventory/:id` |
| Map (player tools) | `GET/POST /map/:mapId/marks` (pin, note, route, stop, icon), `PATCH/DELETE …/:mid` |
| Me | `GET /profiles/:aid` (`me` works), `PUT /profiles/me/blocks`, `DELETE /profiles/me/blocks/:bid` |
| People | `GET/POST /people`, `PATCH /people/:pid`, `POST …/quotes`, `POST …/recalls`, `PUT …/note` |
| Whiteboard | `GET/PUT /whiteboard` (with `baseVersion`), `POST /whiteboard/wipe`, `GET /whiteboard/history[/:v]` |
| World settings | `GET/PATCH /settings` (DM), `POST /invites` (DM) |
| Appearance | `PUT /api/me/theme` |
| Live updates | `GET /events` (Server-Sent Events) |
| Models | `/v1/models`, `/v1/chat/completions`, `/v1/embeddings` (signed in only), passed to `MODEL_BASE_URL` |

## Sources

A source belongs to exactly one world. Its pages are DM-only unless the
source's `defaultVisibility` is `party` or a page says `visibility: party`.

- **vault**: a folder of Markdown under `ALX_VAULTS_DIR`, for example an
  Obsidian, Lokus or Otterly vault. Config: `{"folder": "bloodearth"}`.
- **git**: a repo of reference files, such as your DND ref repo. It is
  cloned read-only into the data folder and pulled again on each sync.
  Config: `{"url": "https://github.com/you/dnd-ref", "subdir": "families"}`.
- **kanka**: a Kanka campaign. Config: `{"campaignId": "123", "token": "…"}`.
  Entities Kanka marks private are always DM-only. The token is never sent
  back by the API.
- **mcp**: an MCP server, either the LegendKeeper MCP or mcp-kanka, over
  HTTP or a local server the operator listed in `ALX_MCP_STDIO`. Only read
  tools are called. See [docs/MCP_SOURCES.md](docs/MCP_SOURCES.md) for
  setup and how each server marks DM-only content.

After every sync, player copies are rebuilt:
- links to DM-only pages become `(hidden)`, so players don't learn those
  pages' names
- `GET /library/lint` (DM) lists shared pages that still read like DM
  notes, such as "The secret:" or "DM note:"

## Not built yet

- The old MCP module gateway in `src/mcp/` isn't wired in. It doesn't
  compile, and it shells out to `git` with unescaped input. A world's
  Kanka, git and vault data now come in through sources instead.
- Importing Kanka relations, timelines and reminders, and LegendKeeper
  maps and timelines (see docs/MCP_SOURCES.md).
- Writing to the calendar from a calendar app (CalDAV write-back). The
  feed is a read-only iCalendar subscription, which Apple Calendar,
  Thunderbird, DAVx⁵ and Google can all subscribe to.
- Vector search (sqlite-vec), memory engines (Mem0, Graphiti), the answer
  check for AI replies, and Spotify, WLED and Home Assistant.
