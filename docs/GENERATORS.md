# Generators hub

DM nav: **Generators** (`/w/:world/dm/generators`). NPCs, monsters, maps,
taverns, names, and two libraries (the bestiary and "My generated"). All
original tables and code; everything works with no model. A chat model, when
set, can improve the wording of a result (a checkbox, off by default).

## What each makes

- **NPCs** (tavern keeper, villain, shopkeeper, noble, wizard, rogue, cleric,
  quest giver, town guard, dwarf, elf, random): race-correct name (quickgen),
  look, voice and mannerism, want, secret, hook, a tie to a real place or
  faction of this world, optional quick statblock.
- **Monsters** (dragon, undead, demon/fiend, aberration, beast, construct,
  elemental, fey, boss, low CR, random, homebrew from a concept): a statblock in
  the format Combat reads. Target CR, or party level and size. With a game
  module imported (the built-in SRD counts) a module monster of the type and a
  nearby CR is reskinned and retuned (HP, AC, attack bonus, DCs); otherwise
  the numbers come from `generators/cr.ts`, our own interpolation of the usual
  CR guidance (XP awards are the standard published values). Module monsters
  carry the module's CC-BY attribution on the page. Bosses get legendary
  resistance, legendary actions and lair actions.
- **Maps** (dungeon, cave, castle, tavern, battlemap, city, region, forest):
  procedural, seeded (same seed, same map), under a second, SVG and a pure-JS
  PNG. A keyed list with descriptions from tables. Grid maps use 5 ft squares
  (forest 25 ft). The DM view shows secret doors, traps and hazards; the player
  view never does.
- **Taverns** (common, dwarven, elven, pirate, haunted): name, owner (the
  tavern-keeper NPC), atmosphere, menu with prices in the world's coin setting,
  rooms, patrons, rumours (from the party-level story bible when it has facts,
  else tables) and the floor-plan map.
- **Names**: people (any race; styles default, virtue, **dark**) and places or
  businesses: tavern, inn, town, guild, magic shop, smithy, temple, keep,
  dungeon, in flavours common, dwarven, elven, pirate, haunted, dark. Titles
  already in the library are skipped; the offensive-word filter applies.

## Using a result

Generate (uses the seed shown), Reroll (new seed, locked fields kept), Lock a
field, then **Save**, **Send to table** or **Copy**.

- **Save**: a library page in `Generated/<kind>/`, DM only by default. Level
  `party` publishes the public parts only; secrets, hooks, wants, rumours and the
  key sit in `> [!secret]` blocks and the statblock is left out. A party save is
  refused when the text repeats DM-only words. Maps also save a PNG (kind
  `map`, so the Map page lists it) and an SVG as library files. A DM save has
  the DM marks; a party save has none.
- **Send to table**: a stage card (staged, or shown now) with the public text,
  and for maps the picture without DM marks.
- **Add to combat**: saves the statblock page and uses the existing
  "Add to combat" for statblock pages.
- **Libraries**: the bestiary filters module monsters by CR and type, opens the
  statblock and adds to combat. "My generated" lists saved pages (tag `generated`).

## World awareness

Ties and name avoidance use the DM's AI view of the library (never classified
pages) and the DM-scope story bible. Places and factions are recognised by page
kind, tags and folder. Generated pages are not used as ties. A tie to a page that
is not party level only appears in DM-only text. Model requests go through
`core/ai.ts`, which refuses classified text.

## API (DM only; players get 403)

`GET /generators/options`, `POST /generators/generate`, `/save`, `/stage`,
`GET /generators/library`, `/bestiary`, `/names`. A spec is
`{ kind, preset, seed, options, locks, enrich }`; saving and staging regenerate
from the spec, so the saved page matches what the DM saw.

MCP (DM only): `generate`, `generate_map`, and `save_generated` (write key,
always DM level). They are in the agent's intent list.

## Templates

A **generator template** (DM → Templates & guides) keeps the structure and fields the DM wants for a
generated town, NPC, tavern or shop; the assistant follows it when a request matches. See [TEMPLATES.md](TEMPLATES.md).

## Not done

Maps are not drawn with text in lower case in PNGs (an uppercase bitmap font);
the SVG uses a normal font. No hex grids, no multi-level dungeons.
