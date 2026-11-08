# Planned features

Agreed with the DM; not built yet. The player side is shown in the player
demo pages. This file records what the DM side and the librarian need.

## 1. Ask the Librarian (players and DMs)

A chat screen where anyone at the table asks a model questions about the
world.

- **Players** get answers only from their own player copies (the party
  search index, shared pages, people, their own items and notes). The
  model gets no other context, so it can't reveal DM text even by mistake.
  Every answer names its source page.
- **DMs** ask with full access: prep, secrets, statblocks. Same screen,
  role-scoped context.
- Uses the world's "scribe model" for players and the "DM model" for the
  DM (Models settings). The answer check (no DM-only text in a player
  answer) runs before anything is shown.
- Questions the library can't answer from the player's copy are not
  guessed at. They become a request to the DM ("Guarded secrets" below).

## 2. Paying coin for answers

Players pay in-world coin for some answers. The DM sets the prices;
players can see them but never change them.

**Price list (per world, DM only):**

| Knowledge | What it covers | Default short | Default full |
|---|---|---|---|
| Common knowledge | What the party saw or was told | free | free |
| Local lore | Towns, places, rumors, local people | 5 sp | 1 gp |
| Deep lore | Hearts, the Marked, old history | 2 gp | 4 gp |
| Guarded secrets | Not in the player's library | DM decides | DM decides |

- **Toughness** is the tier. Each shared page carries one (frontmatter
  `knowledge: common | local | deep`). The default comes from the folder
  or source, and the DM can override it per page.
- **Length** multiplies the price: short ×1, full ×2. The multipliers are
  DM-set.
- The player sees the price before anything is charged, and nothing is
  charged if they back out.
- **Paying writes to the ledger** (`ledger` table) with the question as
  the note. The DM sees every payment in Party & inventory, and can
  refund or waive it.
- **Guarded secrets** go to the DM as a request (kind `question`). The DM
  answers, names a price (charged when the player accepts), or says it
  can't be learned.
- **Server rules:** price lookup and deduction happen in one transaction.
  Players can't send a price, only a question and a length. If coin is
  too low, nothing happens.
- **DM settings:** turn paid answers on or off per world, edit the price
  list, choose whose coin pays (the asker's or the party purse), and set
  a free-questions allowance per session.

API sketch:
- `GET /api/worlds/:w/librarian/prices` (everyone)
- `PUT /api/worlds/:w/librarian/prices` (DM)
- `POST /api/worlds/:w/librarian/quote` with `{ question, length }`,
  returning `{ tier, cost, quoteId }` (quote valid for 2 minutes)
- `POST /api/worlds/:w/librarian/ask` with `{ quoteId }`, which charges
  and answers in one step
- MCP: `ask_librarian` (read keys, same price rules) and
  `set_librarian_prices` (DM write key)

## 3. Inventory change alerts

When the DM changes anything in a player's inventory, the player is told
and can contest it.

- **What triggers an alert:** an item added, removed or moved, a quantity
  change, or a coin change by the DM.
- **What the alert shows:** the item, before → after, and the DM's reason.
  The reason is required for edits to someone else's items.
- **What the player can do:**
  - "Looks right" marks the alert read.
  - "Ask to change it" opens a dispute with a note. It arrives at the DM
    as a request linked to the change, and the DM can undo the change in
    one click from it.
- **Where alerts appear:** a badge on Inventory, a banner on Home, and
  live through `/events` (`item-alert`). Unread alerts survive reloads.
- **DM view:** Party & inventory lists open disputes and the history of
  every change (already in the audit log).

Data: `item_changes(id, world_id, item_id, owner, before_json, after_json,
reason, by_id, at, status: 'open' | 'ok' | 'disputed' | 'reverted',
note)`.
