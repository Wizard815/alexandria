# Shops

Shops players can browse and buy from, stocked from an item database the DM
owns. DM menu: **Shops** (Players group) and **Items** (World group).
Players: **Shop** (in the phone's More menu under World). Code:
`librarian/src/features/shop/`, `web/src/features/shop/`.

## The item database

One per world. Each item has a name, type (weapon, armor, shield,
ammunition, gear, tool, potion, scroll, ring, rod, staff, wand, wondrous
item, mount, food, other), category, rarity (mundane, common, uncommon,
rare, very rare, legendary, artifact, varies), cost in copper (shown in the
world's coin setting), weight in pounds, description, properties,
attunement, tags, DM notes (DM only), and its source with that source's
attribution.

- **Seed.** The first time the DM opens Items (or generates a shop) the
  database is filled from the world's enabled built-in modules: the SRD 5.2
  by default, the SRD 5.1 if that is the one enabled. Only SRD content, under
  CC-BY-4.0; every row carries the module's credit line, and the Items page
  shows the credits. This happens once; deleting items does not bring them
  back.
- **Prices.** Mundane gear keeps its listed SRD cost. The SRD lists no magic
  item prices, so a magic item gets a price inside its rarity's band (our
  own bands, the same as the quick item generator: common 50-100 gp,
  uncommon 101-500, rare 501-5,000, very rare 5,001-50,000, legendary
  50,001-150,000; potions, scrolls and ammunition half). The price is
  derived from the name, so it is the same in every world. Artifacts and
  "rarity varies" items have no price; the DM can set one.
- **Import** (Items → Import…, always previewed first): a game module
  (built-in or imported, see [MODULES.md](MODULES.md)), a JSON file (a list
  or `{ "items": [...] }`) or a CSV file (header row; `name` required;
  `type`, `category`, `rarity`, `cost` like `15 gp` or `cost_cp`, `weight`,
  `attunement`, `description`, `properties`, `source`, `attribution`,
  `tags` separated by `;`, `dm_notes`). Give file imports a source name and
  a credit line if their licence asks for one.
- **Dedupe.** Items are the same when their names match ignoring case and
  punctuation ("Thieves' Tools" = "thieves tools"). An import never adds a
  second one: it skips it, or with "refresh" updates a row that came from
  the same source (a custom item is never overwritten). Duplicates inside
  one file are skipped too.
- **Export** JSON (`format: alexandria-items`, re-importable) or CSV. The
  export is the DM's and includes DM notes.
- **Custom items**: New item, edit, Duplicate (a custom copy), Delete
  (shops lose the line).

## Shops

A shop has a name, a kind (general store, blacksmith, alchemist, magic
shop, tavern shop, fence), a description, a **shopkeeper** card (name,
race, trade, look, voice, personality, and a DM-only secret; "Save keeper as
NPC page" writes a DM-only library page and links it), a **location** (a
library page; players see it only if they can open that page), a
**markup** (negative for a discount), a **haggle note** and **DM notes**
(DM only), a **restock rule** (by hand, or every N game days on the world
clock) and an optional buy-back percentage.

**Status**, changed live from the Shops page:

| Status | Players see |
|---|---|
| Hidden | Nothing. The shop does not exist for them (404). |
| Closed | The shop and its keeper, a closed sign, no stock. |
| Open | The visible stock, and they can buy. |

**Stock lines** point at items: a price override (else the item's cost
plus the markup), a quantity or unlimited (blank), the usual quantity a
restock returns to, and **hidden** (under the counter: players never see the
line until the DM unhides it). Stocking an item a shop already has adds to
its line.

**Show on players' TV** sends the stock as a stage card (shown), **Stage it**
stages it; the card holds only what players could see, and is refused if it
repeats DM-only words.

## The shop generator

Shops → Generate, the `generate_shop` agent tool, or from code:

```ts
import { generateShop } from '../features/shop/gen.ts'; // also re-exported by features/shop/index.ts
const draft = await generateShop(d, worldId, { kind: 'magic', size: 'city', level: 7, theme: 'elven', seed: 'x' }, guide);
```

- Stock comes from the world's item database: items that fit the kind,
  priced, up to a rarity capped by both the settlement (hamlet common,
  village uncommon, town rare, city very rare, metropolis legendary) and
  the party level (1-4 uncommon, 5-10 rare, 11-16 very rare, 17-20
  legendary). The count follows the size (6 to 20). A fence keeps most of
  its better pieces under the counter.
- The shopkeeper comes from the NPC generator (a shopkeeper, dwarf, wizard,
  tavern-keeper or rogue preset by kind); its want, secret and world tie go
  in the keeper's DM-only secret.
- Same seed, same shop. No model is needed; with a chat model and "improve
  the wording" the model rewrites the description and the keeper's look,
  voice and personality only, never stock or prices.
- **`guide`** (optional text, e.g. a DM template) steers it. Offline its
  words weigh the draw like a theme, and plain directives are read:
  `12 items`, `markup 20%`, `discount 10%`, `no magic`,
  `max rarity rare`. With a model the guide is also the model's brief.
- A draft is not saved. Saving regenerates from the same seed, hidden from
  players unless "Open it to players when saved" is ticked.

## Buying and selling

Players buy from an open shop with **their own coin or the party pouch**,
under the same rules as the broker:

- The server prices it (never the browser) and checks `spendable()`: coin
  promised to debits still waiting for the DM is not available.
- Coin, stock and the item move in **one database transaction**, so two
  players can never both buy the last one, and two purchases can never
  overdraw a purse. Too little coin is a 402; too little stock a 409.
- The item goes to the buyer's pack or the party stash (their choice); a
  line with the same name stacks. DM notes on the item never go with it.
- A party-pouch payment reads **"Shop purchase (paid by X from the party
  pouch)"** in the log everyone (guests too) can read: it never names what
  was bought. The buyer's own log reads "Shop: item at shop".
- Coin, inventory, stock and prices update live on every screen.

World settings (Shops → Settings):

| Setting | Default | Effect |
|---|---|---|
| `shopApproval` | off | "DM approves shop purchases": a purchase waits (202). The coin is held as a pending debit and the stock reserved; the DM approves or rejects it under Shops → Orders. A player can take back their own. |
| `shopPartyPay` | on | The party pouch may pay shops (needs the party pouch on). |
| `shopSellBack` | off | Players may offer an item to an open shop. |
| `shopSellBackPct` | 50 | What a shop offers, as a percentage of the item's price in the database (a shop can override it). The DM approves, and may change the price; the coin goes to the seller (or the pouch for a party item) and the item onto the shop's shelves. |

Coin held for a shop purchase does not appear in the Inbox's coin
approvals; it is decided with the purchase.

## What players never get

Hidden shops (listed or by id), hidden stock lines, the item database, DM
notes on items, lines and shops, the haggle note, the keeper's secret, the
location when its page is not shared with them, and other players' orders.
Everything a player receives is built by `playerShop()` from an allow-list.
Guests get 403 from the whole Shop API. The leak crawler seeds all of these
(`librarian/test/security-world.ts`) and `web/e2e/leaks.mjs` checks the Shop
page.

## Agent tools

`search_items`, `list_shops`, `read_shop` (reads), and `create_item`,
`edit_item`, `generate_shop`, `create_shopkeeper`, `stock_shop` (add lines or
restock), `set_shop_status` (writes: proposed to the DM like every write
tool; `set_shop_status` always asks, even in Auto mode). Players' agents only
get `list_shops` and `read_shop`, with the player view.

## Encounters

An NPC encounter can end with "show me your wares" and open a shop for the
player: see [ENCOUNTERS.md](ENCOUNTERS.md#shops).

## API

See [API.md](API.md#shop-apiworldsworldshop).
