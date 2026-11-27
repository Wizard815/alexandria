# Shops

Shops players can browse and buy from, stocked from an item database the GM
owns. GM menu: **Shops** (Players group) and **Items** (World group).
Players: **Shop** (in the phone's More menu under World). Code:
`librarian/src/features/shop/`, `web/src/features/shop/`.

## The item database

One per world. Each item has a name, type (weapon, armor, shield,
ammunition, gear, tool, potion, scroll, ring, rod, staff, wand, wondrous
item, mount, food, other), category, rarity (mundane, common, uncommon,
rare, very rare, legendary, artifact, varies), cost in copper (shown in the
world's coin setting), weight in pounds, description, properties,
attunement, tags, GM notes (GM only), and its source with that source's
attribution.

- **Seed.** The first time the GM opens Items (or generates a shop) the
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
  "rarity varies" items have no price; the GM can set one.
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
  export is the GM's and includes GM notes.
- **Custom items**: New item, edit, Duplicate (a custom copy), Delete
  (shops lose the line).

## Shops

A shop has a name, a kind (general store, blacksmith, weaponsmith, armorer,
alchemist for potions, enchanter, magic shop, trinkets and curios, tavern
shop, fence), a **town** (see below), the **keeper's purse** and how far
the keeper **haggles**, a description, a **shopkeeper** card (name,
race, trade, look, voice, personality, and a GM-only secret; "Save keeper as
NPC page" writes a GM-only library page and links it), a **location** (a
library page; players see it only if they can open that page), a
**markup** (negative for a discount), a **haggle note** and **GM notes**
(GM only), a **restock rule** (by hand, or every N game days on the world
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
line until the GM unhides it). Stocking an item a shop already has adds to
its line.

**Show on players' TV** sends the stock as a stage card (shown), **Stage it**
stages it; the card holds only what players could see, and is refused if it
repeats GM-only words.

## Towns and their price level

Shops → Towns. A town has a name, a size, a **price level** in percent
(+25 for a town under siege, -10 for a cheap market town), a description
players can read and GM notes. Every shop in a town follows its level at
once, on top of its own markup: price = cost × (100 + town %) × (100 +
markup %). A stock line's own price is final and ignores both. Players see
the town's name, its description and the prices in words (cheap, a little
cheap, fair, a little dear, dear, steep), never the number or the GM notes.
Generating a shop in a town takes the town's size. Deleting a town leaves
its shops at their own prices.

## What a keeper remembers

Each shop remembers every player who dealt there: **reputation** (-100 to
100), coin spent and sold, purchases, haggles won and lost, a GM note, and
**deals**. All of it is GM-only (the shop's "What … remembers" panel, or the
`shop_memory` tool), except what a player reads about themselves: a
standing (Unwelcome, Distrusted, Stranger, Customer, Regular, Friend,
Trusted friend), their percentage off and their deals.

- **Reputation moves prices.** At +100 a player pays `shopRepEffect`% less
  (default 10), at -100 that much more, in a straight line (+10 rep is 1%).
  A good reputation also raises what the shop pays for things they sell.
- It **rises** by 1 per purchase, plus 1 for every 50 gp spent in it (at
  most +5). It **falls** with failed haggles (-1, -2, or -5 for an insulting
  offer). The GM can set it to anything.
- **Deals** are a percentage off one line, or the whole shop, for one
  player. They come from haggling (one game day), a keeper's counter-offer
  (one game day) or the GM (any number of game days, or until used). The
  best deal on a line is used up by the next purchase of it; a purchase the
  GM rejects or the player takes back gives it back. A player's price is
  never more than 90% off.

## Haggling

On an open shop, a player taps **Haggle** on a line and asks for a
percentage off. The keeper's **barter %** (0: never haggles; generated
keepers: fences and curio sellers haggle most, magic shops and taverns
least) plus their reputation / 10 is how far they will go:

| Ask | What happens |
|---|---|
| up to half of that | agreed |
| up to all of it | agreed by chance, from 100% down to 30% at the limit; otherwise refused (-1 rep) with a counter-offer of half the limit |
| up to twice it | refused (-2 rep) with the counter-offer |
| more | insulted (-5 rep), nothing |

A player gets one haggle per line per game day (the keeper remembers), and
cannot haggle over a line they already have a deal on. The world setting
`shopHaggle` turns haggling off. The haggle note stays the GM's own flavour
text for haggling at the table.

## The keeper's purse

A shop's purse (blank: it never runs out) grows with every purchase and
pays for what players sell. A sale offer worth more than the purse is
refused at once ("cannot afford that right now"), and the GM cannot approve
a sale for more than the purse holds. Generated shops get a purse by
settlement and kind (a city magic shop is rich; a hamlet tavern is not).

## Sending a shop to a player

**Send to players** on a shop (or `present_shop`, or `presentShop()` from
code, which NPC encounters use) pops the shop up on chosen players' screens
(or everyone's) with the keeper's name and an optional line: "Fine wares,
friend!". **Browse** opens it. A hidden or closed shop is opened by sending
it (the API needs `open: true`, so nothing opens by accident). Only the
players it was sent to get it.

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
- Each kind stocks its own things: a weaponsmith weapons and ammunition, an
  armorer armor and shields, an enchanter rings, wands, staffs, scrolls and
  magic arms, a curio shop trinkets, instruments, games and common wondrous
  items. "armourer", "potions", "enchantment", "trinkets" and the like are
  read as the nearest kind.
- The keeper gets a purse (settlement size × kind) and a barter percent.
- The shopkeeper comes from the NPC generator (a shopkeeper, dwarf, wizard,
  tavern-keeper or rogue preset by kind); its want, secret and world tie go
  in the keeper's GM-only secret.
- Same seed, same shop. No model is needed; with a chat model and "improve
  the wording" the model rewrites the description and the keeper's look,
  voice and personality only, never stock or prices.
- **`guide`** (optional text, e.g. a GM template) steers it. Offline its
  words weigh the draw like a theme, and plain directives are read:
  `12 items`, `markup 20%`, `discount 10%`, `no magic`,
  `max rarity rare`. With a model the guide is also the model's brief.
- A draft is not saved. Saving regenerates from the same seed, hidden from
  players unless "Open it to players when saved" is ticked.

## Buying and selling

Players buy from an open shop with **their own coin or the party pouch**,
under the same rules as the broker:

- The server prices it (never the browser) and checks `spendable()`: coin
  promised to debits still waiting for the GM is not available.
- Coin, stock and the item move in **one database transaction**, so two
  players can never both buy the last one, and two purchases can never
  overdraw a purse. Too little coin is a 402; too little stock a 409.
- The item goes to the buyer's pack or the party stash (their choice); a
  line with the same name stacks. GM notes on the item never go with it.
- A party-pouch payment reads **"Shop purchase (paid by X from the party
  pouch)"** in the log everyone (guests too) can read: it never names what
  was bought. The buyer's own log reads "Shop: item at shop".
- Coin, inventory, stock and prices update live on every screen.

World settings (Shops → Settings):

| Setting | Default | Effect |
|---|---|---|
| `shopApproval` | off | "GM approves shop purchases": a purchase waits (202). The coin is held as a pending debit and the stock reserved; the GM approves or rejects it under Shops → Orders. A player can take back their own. |
| `shopPartyPay` | on | The party pouch may pay shops (needs the party pouch on). |
| `shopSellBack` | off | Players may offer an item to an open shop. |
| `shopHaggle` | on | Players may haggle (see Haggling). |
| `shopRepEffect` | 10 | How far reputation moves prices, in percent at the best and worst reputation (0 turns it off). |
| `shopSellBackPct` | 50 | What a shop offers, as a percentage of the item's price in the database (a shop can override it; good reputation adds to it). The GM approves, and may change the price; the coin goes to the seller (or the pouch for a party item) and the item onto the shop's shelves. |

Coin held for a shop purchase does not appear in the Inbox's coin
approvals; it is decided with the purchase.

## What players never get

Hidden shops (listed or by id), hidden stock lines, the item database, GM
notes on items, lines, shops and towns, a town's exact price level, the
keeper's purse and barter percent, other players' reputation and deals, the
GM's note on a reputation, the haggle note, the keeper's secret, the
location when its page is not shared with them, and other players' orders.
Everything a player receives is built by `playerShop()` from an allow-list.
Guests get 403 from the whole Shop API. The leak crawler seeds all of these
(`librarian/test/security-world.ts`) and `web/e2e/leaks.mjs` checks the Shop
page.

## Agent tools

`search_items`, `list_shops`, `read_shop` (reads), and `create_item`,
`edit_item`, `generate_shop`, `create_shopkeeper`, `stock_shop` (add lines or
restock), `set_shop_status`, `list_towns` (read), `set_town`, `shop_memory`
(read), `give_shop_deal`, `present_shop` (writes: proposed to the GM like every
write tool; `set_shop_status` and `present_shop` always ask, even in Auto
mode). Players' agents only
get `list_shops` and `read_shop`, with the player view.

## Encounters

An NPC encounter can end with "show me your wares" and open a shop for the
player: see [ENCOUNTERS.md](ENCOUNTERS.md#shops).

## API

See [API.md](API.md#shop-apiworldsworldshop).
