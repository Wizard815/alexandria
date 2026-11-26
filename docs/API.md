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
| Library | `GET /library/pages` (tree list), `GET /library/pages/:id` (blocks, properties, links, children; players get the player copy), `GET /library/pages/:id/markdown` (download), `POST /library/pages/bulk` `{ids}` (offline saves), `PUT /library/pages` (DM, Markdown), `DELETE /library/pages/:id` (DM), `GET /library/search?q=[&semantic=1]` (ranked; hits have `id, path, title, snippet` plus `snippetHtml` with `<mark>`, `titleHtml`, `score`, `matchedOn`; quote "phrases", `-exclude`), `GET /library/relations`, `GET /library/lint` (DM) |
| Requests | `GET/POST /requests`, `POST /requests/:id/decide` (DM, can apply to the page) |
| Messages | `GET/POST /messages`, `GET/POST /messages/:tid`, `POST /messages/:tid/members`, `POST /messages/:tid/keep` |
| Quick events | `GET/POST /quick-events`, `POST /quick-events/:id/respond`, `/resolve`, `/cancel` |
| Encounters | `/encounters/*`: an NPC talks to one player in their app; see [ENCOUNTERS.md](ENCOUNTERS.md) |
| Discord | `/discord/*`: the world's Discord bot (DM settings, channels, test post, linked players) and a player's own link (`/discord/me`, `/discord/me/code`); see [DISCORD.md](DISCORD.md) |
| Calendar | `GET/POST /calendar`, `PATCH /calendar/:sid`, `PUT /calendar/:sid/rsvp`, `GET/POST /calendar/:sid/chat`, `POST /calendar/:sid/reschedule`, `POST /calendar/:sid/reschedule/:rid`; feed `GET /dav/worlds/:world/sessions.ics` |
| Live session | `GET /live`, `PUT/DELETE /live/presence`, `GET/POST /live/ledger`, `GET/PUT /live/combat`, `POST /live/combat/next`, `POST/PATCH/DELETE /live/combatants/:id` |
| Inventory | `GET /inventory?owner=me\|party\|<account>`, `POST /inventory`, `PATCH/DELETE /inventory/:id`; giving and pictures: see below |
| Map | `GET/POST /map/:mapId/marks`, `PATCH/DELETE /map/:mapId/marks/:mid` |
| People | `GET/POST /people`, `PATCH /people/:pid`, `POST /people/:pid/quotes`, `POST /people/:pid/recalls`, `PUT /people/:pid/note` |
| Me | `GET /profiles/:aid`, `PUT /profiles/me/blocks`, `DELETE /profiles/me/blocks/:bid` |
| Whiteboard | `GET/PUT /whiteboard` (send `baseVersion`), `POST /whiteboard/wipe`, `GET /whiteboard/history[/:v]` |
| Broker | `/broker/*`: see below |
| Approvals | `/approvals/*`: see below |
| House rules | `/mods/*`: house rules (mods) on and off, options, counters, actions and rerolls, import and export; see [MODS.md](MODS.md) |
| Spells | `/spells/*`: the Codex (search every field), mana, spell crafting; see [SPELLS.md](SPELLS.md) |

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

**Where a question goes** (`features/broker2/routing.ts`). The audit model
(`chatJson(d, 'audit', ...)`) labels each question with `scope` (world,
real-world-allowed, rules, item, off-topic), `intent` (fact, spoiler-seeking,
meta-gaming), `type` and `confidence`. Its input is only the question, the
allowed real-world topics and the titles of pages players can read, never DM
text. With no audit model, or if it fails, keyword rules give the same labels
(villain, BBEG, twist, secret, true identity, behind the door: spoiler; HP, AC,
DC, stats: meta; obvious off-topic patterns). The keyword rules also back the
model up: they can only add caution.

| Labels | What happens |
|---|---|
| `off-topic` (confident) | In-character refusal, free. Recorded for the DM as `noted`. |
| spoiler-seeking, meta-gaming, low confidence (< 0.6), or names a DM spoiler tag | Guarded: status `pricing`, the DM decides. Looks the same to the player as any unknown question. |
| `rules` | "Other": free, answered at once, from `searchRules` with citations (says so if there is no rules source) |
| `item` | "Other": free, answered at once, from the item's player-visible note and the player copy of its linked page, only for items the asker can see |
| `world`, `real-world-allowed` | The library classification above, priced by tier |

"Other" is not a price tier: it never appears in `/config` tiers.

**Delivery mode per tier** (`tiers[].delivery`): `auto` delivers when the
wait is over; `review` holds the answer (`needs_review: true` for the DM)
until the DM approves, edits or refuses it. Defaults: common auto, local auto,
deep review. Guarded secrets is always `review`, whatever is saved.

**Output check** (`features/broker2/guard.ts`): every machine-built answer
(auto delivery, Other) is checked once more for DM-only lines and DM-only names
before it is delivered. A hit holds it for the DM instead.

**Game clock:** the broker has no clock of its own. Game-time waits use the
world clock (`features/clock`). A world whose clock was untouched and whose
broker had game minutes starts the world clock there, once.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/config` | all | Tiers (name, knowledge level, cost in copper, wait, `delivery`), the world clock, `site` (`{url, label}` or null) and allowed `topics` |
| PUT | `/config` | DM | Replace the tiers |
| POST | `/delivery/auto` | DM | Every tier except Guarded delivers automatically |
| POST | `/clock` | DM | Thin wrapper over the world clock (`{addMinutes}` or `{setMinutes}`); game-time waits finish when it passes them |
| GET/POST | `/quote` | player, DM | `{question}` → tier, price, wait, `kind` (`priced`, `secret`, `other`, `offtopic`) and `delivery`. `other` quotes carry the free `answer` and `sources`. Never charges. Read keys may quote. |
| POST | `/ask` | player, DM | `{quoteId, from?}`: pays at once from `from` = `self` (own coin) or `party` (the party pouch); 402 if that purse is short (the quote stays valid), 403 if the DM turned the pouch off for the broker. A question with no match goes to the DM to price. |
| GET | `/pay-options` | player, DM | Both purses (`self.cp`, `party.cp`), whether the party pouch may pay (`party.allowed`, with a `reason` when not) and the preselected `default` |
| GET | `/` | all | Requests: players see only their own |
| POST | `/:id/price` | DM | Offer a price for a question sent to the DM |
| POST | `/:id/accept`, `/:id/decline` | player | Answer the offer; `accept` takes `{from: self \| party}` like `/ask` and can be taken once |
| POST | `/:id/refuse`, `/:id/refund`, `/:id/deliver`, `/:id/approve` | DM | `approve` and `deliver` both release a waiting answer now |
| PATCH | `/:id` | DM | Edit the answer |
| POST | `/:id/note` | DM | Save the answer as a broker note, so later questions on the topic sell it |
| POST | `/classify` | DM | `{question}` → how it would be judged and priced. Nobody is charged. |
| GET/POST | `/notes` | DM | Facts the broker may sell: `{topic, text, knowledge, pageId?}` |
| PATCH/DELETE | `/notes/:nid` | DM | Edit, or `active: false` to stop selling it |
| GET | `/rules` | DM | Per-page rules |
| PUT/DELETE | `/rules/:pageId` | DM | `{knowledge?, multiplier, neverSell, spoiler}`. A `spoiler` page always sends questions that name it to the DM. |
| GET/PUT | `/spoilers` | DM | `{topics: [text]}`: free-text spoiler topics; a question naming one always goes to the DM |
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
- `brokerPayer`: `self` or `party`: the purse preselected for payments (the player chooses when paying).
- `brokerPartyPay` (default on): players may pay the broker from the party pouch. A party payment is logged on the pouch as `Broker purchase (paid by <name> from the party pouch)`, never with what was bought.
- `brokerTopics`: list of allowed real-world topics, e.g.
  `["Feudal Japan: history, folklore, customs"]`.
- `brokerSiteUrl`, `brokerSiteLabel`: an optional link to the world's site,
  shown on the player broker page only when the URL is http(s).
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
| POST | `/coin/transfer` | player, DM | `{from?: "me" \| "party", to: accountId \| "party", amountCp, note?}`. Players give only their own coin or take from the party pouch. |
| POST | `/:id/move` | player, DM | `{to: accountId \| "party" \| "me", qty?}`. Moving part of a stack splits it; matching items stack. |
| GET | `/transfers` | all | Recent gives (players: theirs and the party's) |
| POST | `/transfers/seen` | DM | Mark them seen |
| GET/POST | `/coin-requests` | player | Ask a player or the party for coin: `{to, amountCp, note?, offerId?}` |
| POST | `/coin-requests/:rid/give` | player | `{amountCp?}`, defaults to what's left |
| POST | `/coin-requests/:rid/decline`, `/cancel` | player | |
| POST | `/images` | player, DM | A PNG, JPEG, GIF or WebP, at most 2 MB, as raw bytes (`Content-Type: image/*`) or JSON `{dataBase64}` → `{id}` |
| GET | `/images/:id` | | Only for people who can see an item that uses it |
| GET | `/overview` | DM | The Players page in one answer: `players[]` (`id`, `character`, `player`, `cp`, `items[]`, `waiting`) then `party` (`cp` or null when the pouch is off, `items[]`) |
| GET | `/summary` | player, DM | Mine and Party for the Inventory header: `mine {cp, kinds, qty}` and `party {cp, purse, kinds, qty}` |

Items take `image`: an upload id or an `https://` link.

### Library sharing (`/api/worlds/:world/libshare`)

One answer for every page, file and folder: who can see it. `party` (everyone),
`players` (chosen players only) or `dm`. Per-player page shares use the page
shares of `features/sourcekeys`; a file share is its own row; a folder rule
covers the pages and files in a folder, including ones added or moved in later
(read live, so nothing goes stale). A rule with an empty path covers a whole
source; it is only made when `whole: true` is sent, never from a missing path. Classified items can never be shared, broker
items are refused until their level is changed, and a folder rule skips both.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/overview` | DM | `players[]`, `pages{id: {mode, to, via}}` (pages shared by a share or rule), `files{id: {mode, to, via}}` (every file), `folders[]` (the rules) and `shared[]` (everything players can open now) |
| GET | `/preview` | DM | `?kind=page\|file\|folder&id=` (folder: `&sourceId=&path=`, or `&whole=1` for a whole source): counts, what is skipped, whether the page has classified text or parts players will not see |
| PUT | `/share` | DM | `{kind: page\|file\|folder, id \| sourceId+path (or sourceId+whole: true), mode: party\|players\|dm (folder: also off), players?, notify?, confirm?, withPage?, withFiles?}`. A folder, or an item with classified text, answers 409 `needsConfirm` until `confirm: true`. `notify` records it as new from the DM and sends a `libshare-new` event to the people it is for. |
| GET | `/new` | player, DM | What was sent or shared with this player (checked again on every read), newest first, with `isNew`; the DM gets the send log |
| POST | `/seen` | player | Marks everything seen |

### Shop (`/api/worlds/:world/shop`)

Shops, the item database they stock from, and buying. See
[SHOPS.md](SHOPS.md). Guests get 403 everywhere. Prices are in copper.
Players only ever get the player view: shops that are not hidden, an open
shop's visible lines, the keeper's public card; a hidden shop is a 404.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/config` | player, DM | `{approval, sellBack, sellPct, partyPay, coins, kinds, sizes}` (DM also `model, types, rarities`) |
| GET | `/items` | DM | `?q=&type=&rarity=&source=&tag=&limit=&offset=` → `{total, all, items[], sources[], tags[]}`. The first call seeds the SRD items. |
| GET | `/items/:iid` | DM | One item |
| POST | `/items` | DM | `{name, type?, category?, rarity?, cost? ("15 gp") or costCp?, weight?, description?, properties?, attunement?, tags?, dmNotes?}`; 409 on a name already there |
| PATCH | `/items/:iid` | DM | The fields to change |
| POST | `/items/:iid/duplicate` | DM | `{name?}` → a custom copy |
| DELETE | `/items/:iid` | DM | Also removes its stock lines |
| GET | `/sources` | DM | Game modules with items to import, and their credit lines |
| POST | `/items/import` | DM | `{type: module, module}` \| `{type: json, json}` \| `{type: csv, csv}`, plus `onDuplicate: skip\|update`, `preview`, and for files `source`, `sourceLabel`, `attribution` → `{added, updated, skipped, errors[], sample[], duplicates[]}` |
| GET | `/items/export` | DM | `?format=json\|csv` |
| GET | `/shops` | player, DM | The list (players: open and closed shops only) |
| GET | `/shops/:sid` | player, DM | One shop; the DM's has `keeper.secret`, `haggle`, `dmNotes`, hidden lines and line `dmNote`s |
| POST | `/shops` | DM | `{name, kind, description?, keeper?, locationPageId?, markupPct?, haggle?, dmNotes?, status?, restock?: {rule: manual\|days, days}, sellPct?, townId?, goldCp? (null: never runs out), barterPct? (0-90), stock?: [{itemId, qty? (null: unlimited), priceCp?, hidden?, dmNote?}]}` |
| PATCH | `/shops/:sid` | DM | The fields to change |
| POST | `/shops/:sid/status` | DM | `{status: hidden\|closed\|open}` |
| DELETE | `/shops/:sid` | DM | 409 while purchases wait |
| POST | `/shops/:sid/stock` | DM | One line or `{items: [...]}`; an item already stocked adds to its line |
| PATCH/DELETE | `/shops/:sid/stock/:stid` | DM | `{qty?, baseQty?, priceCp?, hidden?, dmNote?}` |
| POST | `/shops/:sid/restock` | DM | Every line back to its usual quantity |
| POST | `/shops/:sid/stage` | DM | `{show}`: the stock as a stage card (shown on the players' TV with `show: true`) |
| POST | `/shops/:sid/keeper-page` | DM | Save the keeper as a DM-only NPC page and link it |
| POST | `/keeper` | DM | `{shopId?, kind?, seed?, race?, gender?, savePage?}`: a keeper from the NPC generator (given to the shop when `shopId`) |
| POST | `/generate` | DM | `{kind, size, townId? (takes its size), level?, theme?, guide?, seed?, count?, name?, enrich?, save?, status?}` → `{draft}`, or with `save: true` also `{shop}` (hidden unless `status`) |
| GET | `/pay-options` | player, DM | Like the broker's: `self {cp, available}`, `party {cp, available, allowed, reason}` |
| POST | `/shops/:sid/buy` | player, DM | `{stockId, qty?, from?: self\|party, to?: me\|party}` → 201, or 202 `{pending: true}` with `shopApproval`. 402 not enough coin, 409 sold out or closed, 404 hidden. |
| POST | `/shops/:sid/sell` | player | `{itemId, qty?}` (an approved item of yours or the party's) → 202; 403 unless `shopSellBack` |
| POST | `/shops/:sid/haggle` | player | `{stockId, pct}` → `{accepted, mood: agreed\|grudging\|refused\|insulted\|never, pct, counter, message, deal}`. 403 with `shopHaggle` off, 409 with a deal already on that line, 429 after a haggle on that line this game day |
| GET | `/shops/:sid/memory` | DM | The keeper's memory: `{goldCp, barterPct, repEffect, players: [{accountId, name, rep, standing, repPct, spentCp, soldCp, purchases, hagglesWon, hagglesLost, note, lastAt}], deals: [...]}` |
| PUT | `/shops/:sid/memory/:aid` | DM | `{rep? (-100..100), note?}` for one player |
| POST | `/shops/:sid/deals` | DM | `{accountId, stockId? (blank: the whole shop), pct (1-90), days? (blank: until used), note?}` |
| DELETE | `/shops/:sid/deals/:did` | DM | Cancel a deal |
| POST | `/shops/:sid/present` | DM | `{to: [accountId] \| 'all', message?, open?}`: the shop pops up on those players' screens (live event `shop-present`). 409 for a hidden or closed shop unless `open: true`, which opens it |
| GET | `/towns` | DM | Towns with `pricePct`, `prices` (in words), `size`, `description`, `dmNotes`, `shops` |
| POST | `/towns` | DM | `{name, size?, pricePct? (-90..500), description?, dmNotes?, locationPageId?, shopIds?}` |
| PATCH/DELETE | `/towns/:tid` | DM | Change a town (its shops' prices follow live); deleting leaves its shops at their own prices |
| GET | `/orders` | player, DM | Players: their own; DM: all (`?status=pending`) |
| POST | `/orders/:oid` | DM | `{action: approve\|reject, priceCp?}` (`priceCp`: a sale's total) |
| POST | `/orders/:oid/cancel` | player | Take back your own pending purchase or sale |

A player's `GET /shops/:sid` prices are their own: each line has
`listPriceCp` (everyone's price), `priceCp` (theirs, after reputation and
their best deal) and `dealPct`; the shop has `town` (`{name, description,
prices}` in words), `haggles` and `you` (`{standing, repPct, deals}`).

Live events: `shop` `{id}` (to players only for shops they can see or just
lost), `shop-order` (DM and the buyer), `shop-items`, `shop-towns` and
`shop-haggle` (DM), `shop-present` `{shopId, shopName, keeper, role,
message}` (only the players it was sent to), and the usual `coin`, `item`,
`item-removed`, `approval`. Settings: `shopApproval`, `shopPartyPay`,
`shopSellBack`, `shopSellBackPct`, `shopHaggle`, `shopRepEffect`. MCP:
`search_items`, `list_shops`, `read_shop`, `create_item`, `edit_item`,
`generate_shop`, `create_shopkeeper`, `stock_shop`, `set_shop_status`,
`list_towns`, `set_town`, `shop_memory`, `give_shop_deal`, `present_shop`.

From code (another feature), `presentShop(d, worldId, shopId, { to, open?,
message? })` from `features/shop/index.ts` does what `/present` does.

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

## Search

`GET /api/worlds/:world/search?q=&kinds=&limit=` is one ranked list over library pages, people, game module terms, transcript lines, session log entries and items. `kinds` is a comma list of `page,person,term,transcript,log,item`. Each result has `kind, id, title, snippet, snippetHtml, titleHtml, link, score` (`link` is a path under `/w/:world/`). Players only get what they may see: player copies of pages, shared people, published log entries, players' transcript lines, their own and the party's items. With an embeddings model (the `extra` job) page results are merged with nearest-meaning matches; `semantic=0` turns that off. MCP tool: `search_world`.
