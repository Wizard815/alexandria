# Spells: the Codex, mana and spell crafting

Three parts, all in `librarian/src/features/spells` and `web/src/features/spells`:

1. **The Codex**: every spell of the world, searchable by every field. It ships
   the 339 spells of the SRD 5.2.1 (2024 rules) and holds each world's own
   spells: homebrew and imports.
2. **Mana** (off by default): a mana pool per character instead of spell slots.
3. **Spell crafting** (off by default): a character learns a new spell by
   combining spells they already know.

The DM finds it under World → Codex (and World settings → Spells & mana);
players under My character → Codex, and both from the Codex button on the
Library page. The DM assistant has tools for it (below).

## The spell list

### What ships

`librarian/src/features/spells/data/srd-5.2.1-spells.json` holds the spells of
the System Reference Document 5.2.1, built from the official PDF by
`librarian/scripts/build-spells.ts`:

```
NODE_USE_ENV_PROXY=1 node --experimental-strip-types librarian/scripts/build-spells.ts
# or from a PDF saved earlier:
node --experimental-strip-types librarian/scripts/build-spells.ts --pdf SRD_CC_v5.2.1.pdf
```

It needs `pdftotext` (poppler-utils). The script reads the "Spell
Descriptions" chapter with word coordinates, puts each page's two columns in
reading order and splits it into spells; tables inside a spell become Markdown
tables. It refuses to write a file with fewer than 300 spells.

Only the SRD is in the repository. Spells from other books (the 2024 Player's
Handbook beyond the SRD, Unearthed Arcana and so on) are not: a DM imports what
they may use into their own world (below), where it stays on their server.

**Attribution.** This work includes material from the System Reference
Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at
https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative
Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode. The credit line is shown
on every SRD spell card and under the DM's Codex.

### The spell format

Every spell, bundled or not, has: `name`, `level` (0 is a cantrip), `school`,
`classes[]`, `castingTime`, `ritual`, `range`, `components {v, s, m}`,
`material`, `materialCost` (the material has a gold value), `materialConsumed`,
`duration`, `concentration`, `damageTypes[]`, `saves[]`, `attack` (`melee`,
`ranged` or empty), `text` (Markdown, including "Using a Higher-Level Spell
Slot"), `source` and optionally `manaCost`. Damage types, saves, the attack, a
costly or consumed material, a ritual and concentration are read from the text
when a source does not give them ("3d6 Fire damage", "a Dexterity saving
throw", "worth 50 GP", "which the spell consumes", "Concentration, up to 1
minute", "1 minute or Ritual").

### Searching

`GET /api/worlds/:w/spells/list` takes any of: `q` (name; `text=1` also searches
the description), `level` (`3`, `1,2` or `1-3`), `school`, `class`, `v`, `s`,
`m` (1 or 0), `material` (words in the material), `costly`, `consumed`,
`castingTime` (`action`, `bonus`, `reaction`, `long` for minutes or hours, or
any words), `range` (`self`, `touch` or words), `duration`, `concentration`,
`ritual`, `damage`, `save`, `attack`, `source`, `limit`, `offset`, `full=1`
(with the text). Players add `known=1` for their own spells. Every spell carries
its `manaCost` (see Mana). `GET /spells/facets` lists the values of the menus.

### Who reads what

- The DM reads every spell, with its DM notes.
- A player reads a spell only when their character knows it or the DM made it
  public (per spell, or every SRD spell with the setting `spellsPublicSrd`).
  Anything else is a 404, as if it did not exist.
- DM notes on spells never reach a player.

### Homebrew, imports and export (DM)

| Method | Path | Notes |
|---|---|---|
| POST | `/spells/s` | A homebrew spell (the format above; source defaults to `Homebrew`). Also `public`, `manaOverride`, `dmNotes`. |
| PUT | `/spells/s/:id` | Edit a homebrew or imported spell. SRD spells are not edited. |
| DELETE | `/spells/s/:id` | Not while a recipe uses it. |
| PUT | `/spells/s/:id/meta` | Any spell: `public`, `manaOverride` (null for the table), `dmNotes`. |
| POST | `/spells/public` | `{ids, public}` for many at once. |
| POST | `/spells/import/preview`, `/spells/import` | See below; preview saves nothing. |
| GET | `/spells/export` | The world's own spells as JSON, or `?format=csv`. |

Import bodies (each may carry `source`, `attribution`, `replace: true`,
`public: true`):

| `type` | Body | Notes |
|---|---|---|
| `json` | `{json}` | A list of spells, `{spells: [...]}`, a game module (`{terms: [...]}`, its spells) or the 5e SRD API shape (`casting_time`, `desc[]`, `higher_level[]`). |
| `csv` | `{csv}` | A header row; columns named like the fields (`casting time`, `mana cost`, `higher level` work too). Commas or semicolons. |
| `module` | `{moduleId}` | The spells of a game module the world has (docs/MODULES.md), with its attribution. |
| `library` | `{folder}` or `{pageIds}` | Library pages with a `level` in their frontmatter, `kind: spell` or a `spell` tag; the frontmatter gives the fields and the page text the description. Classified pages are never read, and DM-only parts of a page (secret blocks, DM comments) are left out. |

Every imported spell keeps its source. **Dedupe:** a spell with the same name
(case, accents and apostrophes aside) and the same source as one already in the
world is skipped, or replaced with `replace: true`; the same name from another
source is a second spell. A spell named like an SRD spell with the source
`SRD 5.2.1` is always skipped.

## Mana

World settings → Spells & mana → **Use mana** (`spellMana`). Then:

- **Pool.** Each character's maximum comes from `spellManaPool`: a formula
  (default `level * 4 + mod`, where `mod` is the spellcasting modifier: the
  sheet's spellcasting ability, else the best of INT, WIS and CHA) or a table of
  20 numbers by level. Names in a formula: `level`, `mod`, `str` ... `cha` (the
  scores), `strMod` ... `chaMod`, and `min`, `max`, `floor`, `ceil`, `round`,
  `abs`. The DM can set a maximum by hand per character.
- **Cost.** `spellManaCosts`: ten numbers, cantrip then levels 1 to 9. The
  default is Spell_Plan.md's table, `0, 2, 3, 5, 6, 7, 9, 11, 13, 15` (what 5e
  spell slots are worth); change it to taste. A spell can have its own cost (Codex → the spell → Mana
  cost, or `manaCost` in an import); casting it higher adds the table's step.
- **Casting.** A player casts a spell they know from the Codex (My spells →
  Cast, or the spell card with a level to cast at); the DM can cast for anyone.
  Not enough mana is refused unless `spellManaOverdraw` is on (mana then goes
  below zero). With `spellManaMaxLevel.on`, a table of 20 numbers limits the
  spell level mana can cast at each character level.
- **Rests.** `spellManaRest {long, short}`: `none`, `quarter`, `half` or
  `full` of the maximum back, never above it (defaults: a long rest fills the
  pool, a short rest gives nothing). The rest presets of the world clock (Clock
  page, Minerva's `advance_world_time`, the macro actions) give it back by
  themselves; the Codex's Characters tab has its own rest buttons.
- **Changing mana.** `POST /spells/characters/:aid/mana {delta | set | full, note}`.
  The DM can set anything. A player changes their own mana (a potion, a
  feature) with a note saying why, never above their maximum; the world can
  turn that off with `spellManaPlayerEdit`. Every change is logged with who made
  it, and the DM sees each character's mana in `GET /spells/characters`.

Everything is logged per character (`GET /spells/log`: casts, rests,
adjustments, spells learned). Changes reach the player and the DM live
(`spells-char`).

## Spell crafting

World settings → Spells & mana → **Learn spells by combining known ones**
(`spellCrafting`). Off, players see no recipes and cannot ask.

A **recipe** says: the result spell; 1 to 5 prerequisite spells the character
must know; optionally items (by name, matched case-insensitively against the
character's own approved items; the party stash does not count; each item
optionally used up; an `itemId` may be stored for the shop's item database
later), minimum ability scores, a minimum character level and a mana cost to
learn (only when mana is on). A recipe is **visible** to players or **hidden**;
hidden ones show as "???" or not at all (`spellCraftHidden`: `mystery` or
`hide`), never with their name, spells or notes, and cannot be asked for. A
**draft** (from the assistant) is never shown to players until the DM approves
it. DM notes on recipes never reach players.

**Tiers.** A spell no recipe makes is tier 0; a recipe's tier is one more than
the highest tier among its prerequisites. The DM's recipe editor shows recipes
by tier (and as a list).

**School paths and class lists.** With the rules engine on, a spell no recipe
teaches is taught by its school (`spellSchoolPaths`, on by default). Any class
may study any spell. A spell on the character's own class list earns
`learning.classBonus` more study points a day (1 by default; 0 turns it off),
and there is no penalty for the rest. A multiclass character ("Wizard 6 /
Paladin 4") gets the bonus on both lists.

**The player's Codex** shows the spells they know (cast them), the recipes they
can learn now (all met, highlighted), the next ones with what is missing (a
spell, an item and how many they have, an ability score and their score, a
level, mana), the "???" entries, and their requests.

**Ability scores and level** live on the character's spell sheet (Codex → My
spell sheet; the DM edits any). Players may fill in their own unless
`spellPlayerStats` is off. When the sheet has no value, the player's Me page is
read: a block titled `Level`, a block titled `Intelligence` (or `INT`, ...)
holding the number, or a block titled `Abilities` / `Ability scores` / `Stats`
with `STR 10, INT 13, ...`. Only blocks the DM may read count (never "only me").

**Learning.** The player asks (`POST /spells/learn {recipeId}`); with
`spellCraftApproval: dm` (default) the DM approves or rejects it on the Codex's
Requests tab, with `auto` it happens at once. On approval everything is checked
again; then the consumed items are taken from the character's pack (the owner
gets the usual "the DM changed your things" alert), the mana is paid, the spell
is added (`how: crafted`) and it is logged. The DM may "Approve anyway" when
something is missing.

**Import and export.** `GET /spells/recipes/export` gives recipes by spell name
(`{result, prereqs, items, stats, minLevel, manaCost, visibility, dmNotes,
draft}`); `POST /spells/recipes/import {recipes, replace?}` takes the same and
skips one that is already there (same result and prerequisites).

### API (`/api/worlds/:world/spells`)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/` | all | Settings in short, the SRD credit, sources |
| GET | `/list`, `/facets`, `/s/:id` | all | See above; players only what they may read |
| GET | `/characters` | DM | Every player's sheet and mana |
| GET/PUT | `/characters/:aid` (`me`) | DM, the player | Sheet: `class`, `level`, `abilities {int: 13}`, `castingAbility`; `manaMax` is the DM's |
| POST/DELETE | `/characters/:aid/known[/:sid]` | DM | Give or take a known spell |
| POST | `/characters/:aid/mana` | DM | Adjust mana |
| POST | `/cast` | player, DM | `{spellId, level?, accountId? (DM)}` |
| POST | `/rest` | DM | `{kind: long \| short}` |
| GET | `/log` | all | Players: their own |
| GET | `/recipes` | all | DM: all with notes; players: visible, live ones and a count of "???" |
| POST, PUT, DELETE | `/recipes[/:rid]` | DM | `draft: true` for a draft |
| POST | `/recipes/:rid/approve` | DM | A draft goes live |
| GET, POST | `/recipes/export`, `/recipes/import` | DM | |
| GET | `/codex` | player, DM (`?account=`) | Learned, ready, next, mystery, requests |
| GET, POST | `/learn` | player, DM | Requests; ask to learn |
| POST | `/learn/:lid/approve`, `/reject`, `/cancel` | DM; the player cancels their own | `approve {force?}`, `reject {reason}` |

Live events: `spells` (the list changed), `spells-recipes`, `spells-char`
(`{accountId}`, to that player and the DM), `spells-learn` (likewise). None
carries content.

## The assistant

| Tool | Who | What |
|---|---|---|
| `list_spells` | everyone (players: what they may read) | Search the Codex |
| `read_spell` | everyone | One spell in full |
| `list_spell_recipes` | DM | Recipes with tiers and notes |
| `draft_spell_recipe` | DM (write) | Suggest a recipe: a card to approve, and even then it lands as a draft the DM approves in the editor |
| `my_spell_codex` | players | Their spells, mana and what they can learn |
| `my_spell_tree` | players | Their spell tree as a flat list (`GET /tree?compact=1`), filtered by status, school or element, or name |
| `my_study_plan` | players | Days, gold, checks and scroll points to study a spell, without starting |
| `my_studies` | players | Their studies: points, days left, waiting for a check or a long rest |
| `my_start_study`, `my_study_days`, `my_study_check` | players | Start a study, log downtime days, roll the final check (their own character only) |
| `my_cast_quote` | players | What a cast costs now and whether it is allowed |

The player tools are not marked write: the player harness only offers tools
without it, and each route keeps a player to their own character. Messages
like "what spells can I learn", "how long to study Fireball" or "how much mana
to cast it at 5th" offer them.

## The spell rules engine

`librarian/src/features/spells/rules.ts` holds the rest of
[Spell_Plan.md](../Spell_Plan.md) as pure formulas with the plan's numbers as
defaults: pools and highest spell level per caster type (full, half, third,
none) and for multiclass characters, upcasting with a surcharge, the casting
limits (one leveled spell per turn, surge cast, echo strain, the high-level
limit, overchannel, low mana), dual cast (empower, fuse, the Arcana check,
the fuse insight), learning (tier gates, ability minimums, study points,
progress per day, materials, the graded final check, level-up insight, memory
a memory of learning, scroll) and spell line mastery.

A world changes any part of it with the setting `spellRules`: a partial object
laid over the defaults, so `{"dualCast": {"unlock": "level"}}` changes only
that. Unknown keys and wrong kinds of value are refused. Lists (the pool
tables, the DC table) are replaced whole; `learning.gates` merges per spell
level. `GET /api/worlds/:w/spells/rules` returns the merged rules and the
preview tables (pool and highest level per character level and caster type;
complexity, study points, days per source, materials and DC per spell level).

The plan's open questions, answered as settings:

| Question | Default | Setting |
|---|---|---|
| Third-caster pool | the plan's table; every pool table is editable per world | `pools.full`, `pools.half`, `pools.third`, `pools.none` |
| Dual cast at level 5 or by a feat | an ability the DM grants; nothing in play gives it yet | `dualCast.unlock` (`ability` or `level`), `dualCast.level` |
| Failed final checks cost coin | no | `learning.failCoinLoss`, `learning.setbackCoinLoss` (share of the materials) |
| Gifted spells count toward line mastery | yes | `lines.giftsCountForMastery` |
| Scrolls and memories | a scroll is a study aid (adds study points; the spell is still studied and checked); a full memory of learning a spell (e.g. taken by a memory spell) teaches it at once | `learning.scroll`, `learning.memory` (`save: true` adds a WIS save) |

### Spell lines

The DM defines lines (World → Codex, or the API): a name (unique, up to 40
characters), a colour (`#e25822`) and a short theme. A spell can be in more
than one line; one in two or more is a hybrid. Line mastery (how many known
spells a character has in a line) comes from `lineMastery` in `rules.ts`.

| Method | Path | Notes |
|---|---|---|
| GET | `/spells/lines` | Every line with its spell ids; a player gets only the spells they may read |
| POST | `/spells/lines` | DM: `{name, color, theme, spells: [names or ids]}` |
| PUT | `/spells/lines/:lid` | DM: change any of those; `spells` replaces the list |
| DELETE | `/spells/lines/:lid` | DM |
| PUT | `/spells/s/:id/lines` | DM: `{lines: [line ids or names]}` replaces a spell's lines |

### The spell rules profile

Everything a world's spell rules are made of, by spell name so it moves
between worlds: the mana settings (`spellManaCosts`, `spellManaPool`,
`spellManaRest`, `spellManaMaxLevel`, `spellManaOverdraw`), `spellRules` (only
what the world changed), the lines with their spells, and the recipes.

- `GET /spells/profile/export` (DM): `{format: "alexandria-spell-rules", version: 1, settings, lines, recipes}`.
- `POST /spells/profile/import/preview` (DM), body `{profile, replace?}`:
  which settings would change, the lines added and updated, the spells this
  world lacks (skipped), the tags and the recipes added and skipped. Nothing is
  written.
- `POST /spells/profile/import` (DM): the same, done. A bad setting, a setting
  a profile does not carry or a bad line refuses the whole import. Lines merge
  by name; `replace: true` clears the world's lines and recipes first.

### The engine in play

World setting `spellRulesOn` (off by default, needs `spellMana`) puts the
engine into casting:

- **Caster levels.** `PUT /spells/characters/:aid/caster {casterLevels: {full, half, third}}`
  (the player too when `spellPlayerStats` is on). With caster levels set, the
  pool and the highest spell level come from the engine's tables (multiclass:
  the full table at the combined caster level); a mana maximum set by hand
  still wins. Without them the old formula or table applies.
- **Abilities.** `PUT .../caster {dualAbility: true, silentAbility: true}`, the
  DM only. Silent casting (`POST /spells/cast {silent: true}`) costs no extra
  mana; the log marks the cast as silent.
- **Casting.** `POST /spells/cast` applies every limit: upcast surcharge, echo
  strain, one leveled spell per turn with the surge cast, the high-level
  limit, overchannel and low mana. It answers with the cost breakdown and the
  saves to roll (the DM applies fatigue on a failure). `POST /spells/cast/quote`
  shows the same without casting.
- **Turns.** `POST /spells/characters/:aid/turn` starts a new turn.
- **Dual cast.** `POST /spells/dual/quote {spellA, spellB}` (the same spell
  twice is empower), then `POST /spells/dual {..., arcana: total}`. The mana is
  spent either way; a failure gives the next Arcana check its penalty.
- **Rests.** A short rest resets the turn, echo strain, the surge cast and the
  dual cast; a long rest also the high-level spells.

### Studying a spell

With `spellRulesOn`, a character learns a spell taught by a recipe by studying
it on downtime days. Downtime is time between adventures, not a rest: one day
is 8 hours of study. Each day earns 1 to 3 study points: 1 alone, 2 with a
text, 3 with a mentor (a lab adds 1). For a 3rd-level spell (13 points):

| How | Days | Gold |
|---|---|---|
| Alone | 13 | 250 |
| With a text | 7 | 250 |
| With a mentor | 5 | 500 |

- **Plan.** `POST /spells/study/plan {spellId, source, lab}` shows what is
  missing (the recipe's spells, the tier gate, ability, level, pool, the source
  the tier allows), the points, days by source, gold, the final check's DC and
  the character's bonus (casting modifier + proficiency).
- **Start.** `POST /spells/study {spellId, source, scroll, arcana}`. A tier with
  an Arcana check needs its total to start. Starting again picks up a stopped
  study with its points.
- **Days.** `POST /spells/study/:sid/days {days}`. The DM's days count at once,
  a player's wait for `POST /spells/study/:sid/approve` unless
  `spellCraftApproval` is `auto`. The DM can set points with `PUT /spells/study/:sid`.
- **Final check.** When the points are complete, `POST /spells/study/:sid/check
  {d20}` (or leave d20 out to roll on the server). A failure keeps the points
  and waits for a long rest; then try again. A natural 1 or failing by 10 sets
  the points back.
- **Scrolls.** A scroll is used once. Studying with it (`scroll: true`) adds a
  quarter of the points and keeps the scroll, so it can still be cast after
  the spell is learned. Casting it first (`POST /spells/study/:sid/scroll-cast`)
  spends it and takes its points back off the study.
- **Stop.** `POST /spells/study/:sid/stop` keeps the points.

`GET /spells/study` lists the character's studies (the DM sees all). Changes
go out live as `spells-study`.

### The spell tree

`GET /spells/tree` lists every spell in the world (all SRD spells, and homebrew
a player may see), grouped by school of magic, with hybrid spells (in two or
more lines) in `hybrids` between the schools and spells without a school
under Others. Each spell has a status: `known`, `gift`, `studying`, `stopped`,
`learn` (its requirements are met: it can be started), `locked` (a recipe
teaches it but something is missing, listed in `missing`), `hidden` (a hidden
recipe, DM only; a player sees it as dark) or `dark` (no recipe yet).

In the app: Codex → **Spell tree** (players see their own; the DM picks a
character). Picking a spell opens its panel: what is missing, the study table,
Start learning, days of study, the final check and the scroll. The view lives
in `web/src/features/spells/tree/` and is copied from the standalone Spell
Tree app ([Wizard815/DND-Spell-Tree](https://github.com/Wizard815/DND-Spell-Tree),
`scripts/sync-alexandria.sh`): change it there. On the web each spell shows
an icon for its element (or its school), and `dark` and `hidden` spells show
no icon or name. To change which spells teach a spell, the DM edits its
recipe in Codex → Recipes; a spell with no recipe is taught by its school.
That app can also sign in to
a world and show its tree; the server must list the app's address in
`ALX_CORS_ORIGINS`.

Not yet: the fuse insight toward recipes, and the cast panel.

## Settings

| Key | Default | |
|---|---|---|
| `spellsPublicSrd` | false | Players may read every SRD spell |
| `spellPlayerStats` | true | Players fill in their own spell sheet |
| `spellMana` | false | Mana instead of spell slots |
| `spellManaCosts` | `[0,2,3,5,6,7,9,11,13,15]` | Cost per spell level |
| `spellManaPool` | formula `level * 4 + mod` | `{mode: formula \| table, formula, table[20]}` |
| `spellManaRest` | `{long: full, short: none}` | |
| `spellManaMaxLevel` | off | `{on, table[20]}` |
| `spellManaOverdraw` | false | |
| `spellManaPlayerEdit` | true | Players may change their own mana, with a note |
| `spellRules` | `{}` (all defaults) | The spell rules engine, below; only what the world changes |
| `spellCrafting` | false | |
| `spellCraftApproval` | `dm` | or `auto` |
| `spellCraftHidden` | `mystery` | or `hide` |

## Tests

`librarian/test/spells.test.ts` (the list, filters, imports and dedupe, mana,
crafting, approval, items used up, visibility, the assistant tools), the
security seeds in `librarian/test/security-world.ts` (crawled by
`security-crawl.test.ts` and `web/e2e/leaks.mjs`), and `web/e2e/spells.mjs`
(the DM turns everything on and makes Fire Bolt + Burning Hands → Scorching
Ray with INT 13; a player on a phone sees it locked, meets it, asks; the DM
approves; the player casts it with mana).
