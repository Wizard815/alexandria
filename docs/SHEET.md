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
| People I know | allies, enemies and others, each with a note and optionally their library page (LegendKeeper/Kanka imports included); filter by relation; ask the broker about them | the player |
| Quick notes, Text | free notes | the player |
| Recently | people, places and factions named in the last 3 published session summaries; add a person to your people, or ask the broker | automatic |
| Counters | inspiration, hit dice, arrows… with an optional maximum | the player |
| Checklist | goals and errands | the player |

People, notes, text, counters and checklists can be marked **private** (the
lock): then only that player sees them, the DM included. Health, mana,
inventory and Recently are always visible to the DM.

**Recently** reads the published summaries each time it opens: a person the
party knows (People), a library page the player can open that is a place or a
character (by its kind, tags or folder, e.g. `Locations/Bramblegate`), or a
bold name under *People met*. A tap adds a person as an ally or an enemy.

## From the DM

The DM can leave one player secret **notes** and **goals** (Player sheets, that player's tab). They show in that player's **From
the DM** module (movable, not removable) and nowhere else; new ones carry a New tag and a toast. The player can tick a
goal done; only the DM can change or delete them.

## Conditions

The condition picker lists the conditions the world's game modules define (SRD 5.2, 5.1 or an import), plus a few table
states (Concentrating, Blessed…). Hovering a condition shows its rules summary; a tap opens the full text. With no
module that defines conditions, the usual 5e list is used.

## House rule: inspiration as re-rolls

Off by default (World settings → Player sheets, `sheetRerolls`, with `sheetRerollCap`, default 3 of each kind). The DM
rewards good role play with re-roll tokens of three kinds: **personal** (re-roll your own roll), **everyone** (re-roll
anyone's roll at the table) and **DM** (make the DM re-roll). Each sheet gets a Re-rolls module; the player taps Use, the
DM gives or takes back from the sheet or the status bar's quick panel, with a reason. Every change is in the sheet log
(kind `reroll`), and the DM gets a toast when a player spends one.

## Asking the broker

The speech-bubble button on a person, place or faction opens a question with ready-made ideas (who they work for, what
shops a town has, who leads a faction). The player can rewrite it; *Ask the broker* opens the Broker page with the
question filled in, and the broker names its price as usual before anything is spent.

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
HP bar, temporary HP, conditions, death saves when down, and mana. A tap opens a quick
panel to deal damage, heal, add conditions, change mana and give re-rolls, with a link to **Player sheets**, which shows each sheet (without private modules) and the
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
- `GET /party` (DM): every player's health, mana and re-rolls.
- `POST /:aid/rerolls { kind: personal|party|dm, delta, note? }` (re-rolls on; the DM gives or takes back, a player spends their own).
- `POST /:aid/dm-notes { kind: note|goal, text }` (DM), `PATCH /:aid/dm-notes/:id` (DM: text/kind/done; the player: done on a goal), `DELETE /:aid/dm-notes/:id` (DM).

Assistant tools: `party_status` (DM read), `read_sheet` and `sheet_log` (reads for both: a player's helper only ever gets that player's own sheet and log, and the DM's assistant never gets a module the player marked private), and `change_player_hp`, `change_player_mana`, `give_reroll`, `add_sheet_note` and `update_sheet_note` (writes the DM approves). The player helper is also given the goals and notes the DM put on that player's sheet with every question, so it can answer "what does the DM want me to do" without a tool call.

A check against real models (Hy4 Flash for the DM, Ternary Bonsai 9B for a player) is in `web/e2e/features-real.mjs` (`FEATURES_REAL=1`; it costs under a cent).

## Session prep

Before game night the DM can have the assistant write each player a short
note (Session prep card on the DM home page, or "send each player a session
prep"): last time, where their character stands, their open threads, and
one thing to think about. Each draft is written by the Players model from
that player's own brief only (their sheet, items, goals, journal, the
published session log), so a DM-only note or another player's quest never
reaches it; with no model it is built from that brief for the DM to edit.
The DM's own line for everyone is added as written. Drafts are the DM's
alone until sent; a sent prep arrives as a kept private chat in Messages.

API (`/api/worlds/:w/prep`): `GET /` (DM: drafts and the last two weeks
sent; player: theirs), `POST /` `{accountIds?, note?, title?}` (DM),
`PATCH /:id` `{text?, title?}`, `DELETE /:id`, `POST /send` `{ids?}`.
MCP tools: `draft_session_prep`, `list_session_prep` (DM),
`edit_session_prep`, `send_session_prep` (DM write key).
