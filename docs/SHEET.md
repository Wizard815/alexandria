# Player sheet

A small companion to the paper character sheet (`features/sheet`). Each player
opens **Sheet** (My character) and arranges it with **Arrange**: add, move,
widen, rename, fold or remove modules. Nothing on it replaces the paper sheet.

## Modules

| Module | What it shows | Who edits |
|---|---|---|
| Health | HP, max HP, temporary HP and conditions; Damage / Heal / Temp buttons | the player and the DM |
| Mana | the mana pool from the Codex (only when the world uses mana); Spend / Restore with a reason | the player (within the pool) and the DM |
| Inventory | the player's pack, read from Inventory | in Inventory |
| People | allies, enemies and others, each with a note | the player |
| Quick notes, Text | free notes | the player |
| Recently | people and places named in the last 3 published session summaries | automatic |
| Counters | inspiration, hit dice, arrows… with an optional maximum | the player |
| Checklist | goals and errands | the player |

People, notes, text, counters and checklists can be marked **private** (the
lock): then only that player sees them, the DM included. Health, mana,
inventory and Recently are always visible to the DM.

**Recently** reads the published summaries each time it opens: a person the
party knows (People), a library page the player can open that is a place or a
character (by its kind, tags or folder, e.g. `Locations/Bramblegate`), or a
bold name under *People met*. A tap adds a person as an ally or an enemy.

## Health and the combat tracker

The sheet keeps a player's HP between sessions. When the DM adds the player to
the combat tracker without numbers, the tracker starts from the sheet. After
that they stay in step both ways: damage in the tracker shows on the sheet,
and damage or healing on the sheet updates the tracker (death saves and the
Stable/Dead tags follow the same rules).

## The log and the DM's status bar

Every HP, max HP, temporary HP and condition change is written to the sheet
log with who made it and where (sheet, combat tracker, DM). Mana changes stay
in the spells log (`GET /spells/log`); the sheet log view merges both.

The DM sees a status bar across the top of every DM page: each player's name,
HP bar, temporary HP, conditions, death saves when down, and mana. A tap opens
**Player sheets**, which shows each sheet (without private modules) and the
whole party's change log.

## API

Under `/api/worlds/:world/sheet` (`:aid` is `me`, or for the DM any player's
account id or character name):

- `GET /:aid`: the sheet (vitals, mana, modules).
- `PUT /me/modules { modules }`: the player's own layout.
- `POST /:aid/vitals { damage | heal | hp | maxHp | tempHp | setTempHp | conditions, note? }`.
- `POST /:aid/mana { delta | set | full, note? }` (mana must be on).
- `GET /:aid/recent`: recently seen people and places, as that player sees them.
- `GET /log[?account=]`: HP and mana changes, newest first.
- `GET /party` (DM): every player's health and mana.

Assistant tools: `party_status` (read) and `change_player_hp` (a write the DM approves).
