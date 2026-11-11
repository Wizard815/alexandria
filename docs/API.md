# Alexandria API

The librarian serves one JSON API to the app, the scribe apps and scripts,
plus an MCP endpoint for AI apps. Base URL: your server, e.g.
`https://alexandria.example.com`.

## Conventions

- **Auth:** `Authorization: Bearer <token>`. The token is one of:

  | Token | Comes from | Can do |
  |---|---|---|
  | Session `alx_ses_…` | `POST /api/auth/login` | Whatever the role allows |
  | Read key `alx_scr_…` | Keys & AI | GET only, one world |
  | DM write key `alx_scr_…` | Keys & AI (DM only) | Changes in one world |
  | Admin key `alx_adm_…` | Keys & AI (admins) | The admin API |

  Calendar apps can send a key as the Basic-auth password.
- **Bodies** are JSON. Field names in requests are camelCase; responses
  mirror the database (snake_case).
- **Errors** are `{"error": "plain sentence"}` with these statuses:

  | Status | Meaning |
  |---|---|
  | 400 | Bad input |
  | 401 | Not signed in |
  | 403 | Not allowed, or a read-only key |
  | 404 | Not found, or not visible to you |
  | 409 | Conflict, e.g. someone else saved first |
  | 413 | Too large |
  | 429 | Rate-limited; see `Retry-After` |
  | 502 | A source or model failed |
- **Visibility** is enforced on the server for every record. A player
  asking for a DM-only record gets 404, not 403, so its existence isn't
  revealed.
- **Live updates:** `GET /api/worlds/:world/events` is a Server-Sent
  Events stream, filtered per viewer. The typed client
  (`packages/client`) wraps it.

## Accounts and keys

| Method | Path | Notes |
|---|---|---|
| GET | `/api/setup` | `{needsSetup}` |
| POST | `/api/setup` | First account, becomes admin |
| POST | `/api/auth/login` | `{username, password}` → `{token, account}` |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/reset` | `{username, code, password}` with an admin's reset code |
| POST | `/api/join` | `{code, username?, password?, characterName?}`. Makes or joins an account and returns `mcp` settings for a read-only key. |
| GET | `/api/me` | Account, theme, worlds with roles |
| PUT | `/api/me/theme` | `{race, mode, effects}` |
| POST | `/api/me/password` | `{current, password}` |
| GET/POST | `/api/keys` | `{scope: scribe\|admin, access: read\|write, label, worldId}` → key once, plus `mcp` settings |
| DELETE | `/api/keys/:id` | Revoke |

## A world (`/api/worlds/:world`, id or slug)

| Area | Endpoints |
|---|---|
| World | `GET /` (name, role, settings), `GET /members`, `GET/PATCH /settings` (DM), `POST /invites` (DM), `GET /audit` (DM), `GET /events` |
| Library | `GET /library/pages` (tree list), `GET /library/pages/:id` (blocks, properties, links, children; players get the player copy), `GET /library/pages/:id/markdown` (download), `POST /library/pages/bulk` `{ids}` (offline saves), `PUT /library/pages` (DM, Markdown), `DELETE /library/pages/:id` (DM), `GET /library/search?q=`, `GET /library/relations`, `GET /library/lint` (DM) |
| Requests | `GET/POST /requests`, `POST /requests/:id/decide` (DM, can apply to the page) |
| Messages | `GET/POST /messages`, `GET/POST /messages/:tid`, `POST /messages/:tid/members`, `POST /messages/:tid/keep` |
| Quick events | `GET/POST /quick-events`, `POST /quick-events/:id/respond`, `/resolve`, `/cancel` |
| Calendar | `GET/POST /calendar`, `PATCH /calendar/:sid`, `PUT /calendar/:sid/rsvp`, `GET/POST /calendar/:sid/chat`, `POST /calendar/:sid/reschedule`, `POST /calendar/:sid/reschedule/:rid`; feed `GET /dav/worlds/:world/sessions.ics` |
| Live session | `GET /live`, `PUT/DELETE /live/presence`, `GET/POST /live/ledger`, `GET/PUT /live/combat`, `POST /live/combat/next`, `POST/PATCH/DELETE /live/combatants/:id` |
| Inventory | `GET /inventory?owner=me\|party\|<account>`, `POST /inventory`, `PATCH/DELETE /inventory/:id`; giving and pictures: see below |
| Map | `GET/POST /map/:mapId/marks`, `PATCH/DELETE /map/:mapId/marks/:mid` |
| People | `GET/POST /people`, `PATCH /people/:pid`, `POST /people/:pid/quotes`, `POST /people/:pid/recalls`, `PUT /people/:pid/note` |
| Me | `GET /profiles/:aid`, `PUT /profiles/me/blocks`, `DELETE /profiles/me/blocks/:bid` |
| Whiteboard | `GET/PUT /whiteboard` (send `baseVersion`), `POST /whiteboard/wipe`, `GET /whiteboard/history[/:v]` |
| Broker | `/broker/*`: see below |
| Approvals | `/approvals/*`: see below |

### Information broker (`/api/worlds/:world/broker`)

Players ask what a piece of information costs, then pay with the money the
DM set. The broker never makes anything up. It sells only:
- lines from player copies of library pages
- notes the DM wrote for it to sell
- answers the DM writes

Every question is classified (`core/brokerClassify.ts`):
- its type (who, where, when, why, how, price, what)
- the pages and people it names
- a verdict:
  - `shared`: player copies answer it
  - `secret`: it names a DM-only page, or DM-only text (secret blocks, DM
    pages, DM facts) fits it better than what players can read
  - `unknown`: nothing fits

Secret and unknown questions get the same reply, so asking never reveals
that a secret exists. Only the DM sees the classification and the DM-only
lines that matched.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/config` | all | Tiers (name, knowledge level, cost in copper, wait in real or game time) and the game clock |
| PUT | `/config` | DM | Replace the tiers |
| POST | `/clock` | DM | Move the game clock; game-time waits finish when it passes them |
| GET/POST | `/quote` | player, DM | `{question}` → tier, price and wait. Never charges. Read keys may quote. |
| POST | `/ask` | player, DM | Pays at once (402 if the purse is short). A question with no match goes to the DM to price. |
| GET | `/` | all | Requests: players see only their own |
| POST | `/:id/price` | DM | Offer a price for a question sent to the DM |
| POST | `/:id/accept`, `/:id/decline` | player | Answer the offer |
| POST | `/:id/refuse`, `/:id/refund`, `/:id/deliver` | DM | |
| PATCH | `/:id` | DM | Edit the answer |
| POST | `/:id/note` | DM | Save the answer as a broker note, so later questions on the topic sell it |
| POST | `/classify` | DM | `{question}` → how it would be judged and priced. Nobody is charged. |
| GET/POST | `/notes` | DM | Facts the broker may sell: `{topic, text, knowledge, pageId?}` |
| PATCH/DELETE | `/notes/:nid` | DM | Edit, or `active: false` to stop selling it |
| GET | `/rules` | DM | Per-page rules |
| PUT/DELETE | `/rules/:pageId` | DM | `{knowledge?, multiplier, neverSell}` |
| GET | `/offers` | all | Special offers. Players see open ones meant for them, and paid ones with the information. |
| POST | `/offers` | DM | `{title, teaser?, info, pageId?, priceCp, targets: "party" \| [accountIds], expiresSessions?, fallbackHours?}` |
| POST | `/offers/:oid/pay` | player | `{from: "me" \| "party"}`; 402 if short |
| POST | `/offers/:oid/decline` | player | Hides it for you; it closes once every target declines |
| POST | `/offers/:oid/withdraw` | DM | |

Notes on special offers:
- An offer runs out at the end of the Nth calendar session after it was
  made. With no such session, it runs out after `fallbackHours`.
- When it runs out it disappears, and any coin requests made for it are
  cancelled.

Settings:
- `brokerEnabled`: off fails closed.
- `brokerPayer`: `self` or `party`.
- In the config, `unknown`: `dm` (the DM prices it) or `refuse` (turned
  away; the DM still sees the question, with status `noted`).

### Approvals (`/api/worlds/:world/approvals`)

Players can't change money or items directly. A player's change is saved as
*pending* and counts only once the DM approves it. Changes the DM makes
alert the player, who can mark them right or dispute them.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/` | DM | Pending coin and items, disputes, alerts, recent decisions, `counts` |
| GET | `/mine` | player | My pending changes and alerts |
| POST | `/:id` | DM | `{action: approve\|edit\|reject\|revert, reason?, …}` |
| POST | `/:id/ack` | player | "Looks right" |
| POST | `/:id/dispute` | player | `{reason}` |

Settings: `playerChangesNeedApproval` and `dmChangeReason` (the DM must
give a reason when changing a player's things). `GET /` also lists recent
`transfers` (free gives; nothing to approve) and `counts.transfers` unseen.

### Giving and pictures (`/api/worlds/:world/inventory`)

Players give coin and items to each other, and move things in and out of
the party stash, without the DM's approval (setting `playerTransfers`,
default on). Every give is checked (you can only give what you have) and
logged for the DM.

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/coin/transfer` | player, DM | `{from?: "me" \| "party", to: accountId \| "party", amountCp, note?}`. Players give only their own coin or take from the party purse. |
| POST | `/:id/move` | player, DM | `{to: accountId \| "party" \| "me", qty?}`. Moving part of a stack splits it; matching items stack. |
| GET | `/transfers` | all | Recent gives (players: theirs and the party's) |
| POST | `/transfers/seen` | DM | Mark them seen |
| GET/POST | `/coin-requests` | player | Ask a player or the party for coin: `{to, amountCp, note?, offerId?}` |
| POST | `/coin-requests/:rid/give` | player | `{amountCp?}`, defaults to what's left |
| POST | `/coin-requests/:rid/decline`, `/cancel` | player | |
| POST | `/images` | player, DM | A PNG, JPEG, GIF or WebP, at most 2 MB, as raw bytes (`Content-Type: image/*`) or JSON `{dataBase64}` → `{id}` |
| GET | `/images/:id` | | Only for people who can see an item that uses it |

Items take `image`: an upload id or an `https://` link.

## Library admin (`/api/admin`, admins only)

| Area | Endpoints |
|---|---|
| Overview | `GET /overview` (counts, sources, recent sync runs, system), `GET /audit`, `GET /backup` (SQLite file) |
| Accounts | `GET/POST /accounts`, `PATCH/DELETE /accounts/:id`, `POST /accounts/:id/reset-code` |
| Worlds | `GET/POST /worlds`, `DELETE /worlds/:id` (`{confirm: true}`), `GET /worlds/:id/members`, `PUT/DELETE /worlds/:id/members/:account` |
| Connectors | `GET /connectors` (id, label, description, form fields) |
| Sources | `GET /sources`, `GET/POST /worlds/:id/sources`, `PATCH /sources/:sid` (secrets come back as `••••`; send them back unchanged to keep them), `DELETE /sources/:sid[?pages=1]` |
| Sync | `POST /sources/test` `{kind, config}`, `POST /sources/:sid/test`, `POST /sources/:sid/sync` (202, background; `?wait=1` waits), `POST /sources/:sid/stop`, `GET /sources/:sid/runs`, `GET /runs/:rid` (log) |

## MCP (`POST /mcp`)

Streamable HTTP, stateless, JSON replies. Use a scribe key as the bearer
token.
- **A read key** lists the read tools: `world_info`, `list_pages`,
  `read_page`, `search_library`, `list_people`, `get_live`,
  `list_calendar`, `ask_broker_quote`, `list_broker_requests`,
  `list_broker_offers`, `list_transfers`, and more.
- **A DM's write key** also lists: `save_page`, `add_person`, `add_quote`,
  `schedule_session`, `send_quick_event`, `add_item`, `add_coin`,
  `decide_request`, `broker_answer`, `send_broker_offer`, `add_broker_note`. `add_item` takes a `reason`.

Each tool calls the API above with the caller's key, so the same
visibility rules apply. Settings to paste into Claude, Cursor or Claude
Code come back from `/api/join` and `/api/keys` (`mcp.config`,
`mcp.claudeCode`).

## Models (`/v1`)

`/v1/models`, `/v1/chat/completions` and `/v1/embeddings` pass through to
`MODEL_BASE_URL`. Signed-in callers only.
