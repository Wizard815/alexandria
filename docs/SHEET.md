# Player sheet

A small companion to the paper character sheet (`features/sheet`). Each player
opens **Sheet** (My character) and arranges it with **Arrange**: add, move,
widen, rename, fold or remove modules. Nothing on it replaces the paper sheet.

## Modules

| Module | What it shows | Who edits |
|---|---|---|
| Health | HP, max HP, temporary HP and conditions; Damage / Heal / Temp buttons | the player and the GM |
| Mana | the mana pool from the Codex (only when the world uses mana); Spend / Restore with a reason | the player (within the pool) and the GM |
| Inventory | the player's pack, read from Inventory | in Inventory |
| People I know | allies, enemies and others, each with a note and optionally their library page (LegendKeeper/Kanka imports included); filter by relation; ask the broker about them | the player |
| Quick notes, Text | free notes | the player |
| Recently | people, places and factions named in the last 3 published session summaries; add a person to your people, or ask the broker | automatic |
| Counters | inspiration, hit dice, arrows… with an optional maximum | the player |
| Checklist | goals and errands | the player |

People, notes, text, counters and checklists can be marked **private** (the
lock): then only that player sees them, the GM included. Health, mana,
inventory and Recently are always visible to the GM.

**Recently** reads the published summaries each time it opens: a person the
party knows (People), a library page the player can open that is a place or a
character (by its kind, tags or folder, e.g. `Locations/Bramblegate`), or a
bold name under *People met*. A tap adds a person as an ally or an enemy.

## From the GM

The GM can leave one player secret **notes** and **goals** (Player sheets, that player's tab). They show in that player's **From
the GM** module (movable, not removable) and nowhere else; new ones carry a New tag and a toast. The player can tick a
goal done; only the GM can change or delete them.

## Conditions

The condition picker lists the conditions the world's game modules define (SRD 5.2, 5.1 or an import), plus a few table
states (Concentrating, Blessed…). Hovering a condition shows its rules summary; a tap opens the full text. With no
module that defines conditions, the usual 5e list is used.

## House rule: inspiration as re-rolls

Off by default (World settings → Player sheets, `sheetRerolls`, with `sheetRerollCap`, default 3 of each kind). The GM
rewards good role play with re-roll tokens of three kinds: **personal** (re-roll your own roll), **everyone** (re-roll
anyone's roll at the table) and **GM** (make the GM re-roll). Each sheet gets a Re-rolls module; the player taps Use, the
GM gives or takes back from the sheet or the status bar's quick panel, with a reason. Every change is in the sheet log
(kind `reroll`), and the GM gets a toast when a player spends one.

## Asking the broker

The speech-bubble button on a person, place or faction opens a question with ready-made ideas (who they work for, what
shops a town has, who leads a faction). The player can rewrite it; *Ask the broker* opens the Broker page with the
question filled in, and the broker names its price as usual before anything is spent.

## Health and the combat tracker

The sheet keeps a player's HP between sessions. When the GM adds the player to
the combat tracker without numbers, the tracker starts from the sheet. After
that they stay in step both ways: damage in the tracker shows on the sheet,
and damage or healing on the sheet updates the tracker (death saves and the
Stable/Dead tags follow the same rules).

## The log and the GM's status bar

Every HP, max HP, temporary HP and condition change is written to the sheet
log with who made it and where (sheet, combat tracker, GM). Mana changes stay
in the spells log (`GET /spells/log`); the sheet log view merges both.

The GM sees a status bar across the top of every GM page: each player's name,
HP bar, temporary HP, conditions, death saves when down, and mana. A tap opens a quick
panel to deal damage, heal, add conditions, change mana and give re-rolls, with a link to **Player sheets**, which shows each sheet (without private modules) and the
whole party's change log.

## API

Under `/api/worlds/:world/sheet` (`:aid` is `me`, or for the GM any player's
account id or character name):

- `GET /:aid`: the sheet (vitals, mana, modules).
- `PUT /me/modules { modules }`: the player's own layout.
- `POST /:aid/vitals { damage | heal | hp | maxHp | tempHp | setTempHp | conditions, note? }`.
- `POST /:aid/mana { delta | set | full, note? }` (mana must be on).
- `GET /:aid/recent`: recently seen people and places, as that player sees them.
- `GET /log[?account=]`: HP and mana changes, newest first.
- `GET /party` (GM): every player's health, mana and re-rolls.
- `POST /:aid/rerolls { kind: personal|party|gm, delta, note? }` (re-rolls on; the GM gives or takes back, a player spends their own).
- `POST /:aid/gm-notes { kind: note|goal, text }` (GM), `PATCH /:aid/gm-notes/:id` (GM: text/kind/done; the player: done on a goal), `DELETE /:aid/gm-notes/:id` (GM).

Assistant tools: `party_status` (read), and `change_player_hp` and `give_reroll` (writes the GM approves).
