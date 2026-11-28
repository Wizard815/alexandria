# Mods (house rules)

Every house rule that comes with Alexandria is a rule file in this folder.
The server reads each `*.alxmod.json` here when it starts, and the GM turns
them on under **World → House rules**. See [docs/MODS.md](../docs/MODS.md)
for the format.

| File | Rule | Switches on |
| --- | --- | --- |
| `inspiration-rerolls.alxmod.json` | Inspiration as rerolls | Personal, everyone and GM rerolls, the sheet's Re-rolls module and `/reroll` |
| `spell-points.alxmod.json` | Spell points | The standard spell points variant for every character (spells feature) |
| `mana-pool.alxmod.json` | Simple mana pool | Alexandria's own mana numbers (spells feature) |
| `mana-system.alxmod.json` | MANA spell system | Wizard's MANA rules; needs the MANA engine |
| `spell-crafting.alxmod.json` | Spell crafting (Codex) | Learning spells by combining known ones (spells feature) |
| `downtime.alxmod.json` | DownTime | Downtime activities from common to legendary, the GM's Downtime button and the players' popup (downtime feature); the ready-made activities are data in its `presets.downtimePremade` |
| `potion-bonus-action.alxmod.json` | Potions as a bonus action | Rule text and assistant guidance |
| `flanking-bonus.alxmod.json` | Flanking: +2, not advantage | Rule text, an option for the bonus |
| `skill-check-crits.alxmod.json` | Criticals on ability checks | Rule text and assistant guidance |
| `hidden-death-saves.alxmod.json` | Hidden death saves | Rule text; the assistant keeps saves secret |
| `max-hp-level.alxmod.json` | Hit points: roll, keep the better | Rule text and assistant guidance |
| `gritty-rests.alxmod.json` | Gritty realism rests | Rule text; the assistant advances the clock to match |
| `party-inspiration.alxmod.json` | Party inspiration pool | A shared pool on every sheet (data system) |
| `lingering-injuries.alxmod.json` | Lingering injuries | Injuries per player that heal over long rests (data system) |
| `brutal-crits.alxmod.json` | Brutal critical hits | A crit deals the dice's maximum plus one normal roll. (rule text) |
| `critical-fumbles.alxmod.json` | Critical fumbles | A natural 1 on an attack gives a mild mishap: drop the weapon, an opening, or a stumble. (rule text) |
| `free-feat.alxmod.json` | A free feat at 1st level | Every character starts with one extra feat. (rule text) |
| `full-hit-dice.alxmod.json` | Full hit dice on a long rest | A long rest gives back all spent hit dice. (rule text) |
| `massive-damage.alxmod.json` | Massive damage | Half your HP maximum in one hit: DC 15 Constitution save or a d10 result. (rule text) |
| `morale.alxmod.json` | Morale | Enemies may flee or surrender (DC 10 Wisdom save) when a fight turns against them. (rule text) |
| `cleave.alxmod.json` | Cleaving through creatures | Leftover melee damage carries to another creature in reach. (rule text) |
| `side-initiative.alxmod.json` | Side initiative | Each side rolls one initiative and acts together. (rule text) |
| `slot-encumbrance.alxmod.json` | Slot inventory | Carry items equal to your Strength score; bulky ones take 2 slots. (rule text) |
| `bloodied.alxmod.json` | Bloodied | The GM says when a creature is at half HP or less. (rule text) |
| `potion-max-heal.alxmod.json` | Potions heal fully as an action | Drinking a healing potion with your action heals its maximum. (rule text) |
| `climb-big-creatures.alxmod.json` | Climbing onto big creatures | Climb a creature two sizes larger and attack it with advantage. (rule text) |
| `luck-points.alxmod.json` | Luck points | Reroll a d20 after seeing it; refills each session. Chat word /luck. (counters) |
| `stress.alxmod.json` | Stress | Horror adds stress; at the limit the character breaks for the session. A long rest takes 2 off. (counters) |
| `honor.alxmod.json` | Honor | An Honor score (0 to 20) the GM raises or lowers. (counters) |
| `exhaustion-2024.alxmod.json` | Simple exhaustion | Each level is -2 to d20 rolls and -5 feet of speed; a long rest takes one off. (counters) |
| `crafting-projects.alxmod.json` | Crafting projects | Players start projects; each long rest adds a day of work until the item is done. (data system) |
| `faction-renown.alxmod.json` | Faction renown | The party's renown and rank with each faction. (data system) |
| `training.alxmod.json` | Training | Learn a language or a tool over days of training. (data system) |
| `hirelings.alxmod.json` | Hirelings | The party's hirelings with their job, wage and loyalty. (data system) |
| `dndbeyond-import.alxmod.json` | D&D Beyond import | Import on the player sheet: Character and Stats modules, HP, counters, items (sheet feature; unofficial) |

`examples/` holds rules that are not built in. The assistant reads them as
patterns when it makes a rule for you (`house_rule_file`), and you can paste
one under **House rules → Make or add one** to try it:

| File | Shows |
| --- | --- |
| `examples/hero-points.alxmod.json` | A small counters rule: give, spend, a session-start trigger, a chat word |
| `examples/downtime-lite.alxmod.json` | A whole data system: activities by tier (common 1 day to legendary 90), each player's tasks, a Downtime day popup, a timer to the goal, GM and sheet views |

## A file is a rule or a package

A rule file holds one rule (`{ "kit": 2, "id": ..., "name": ..., ... }`). A
package holds several, and is what **Export** in Alexandria gives you:

```json
{
  "type": "alexandria-house-rules",
  "kit": 2,
  "name": "Saltreach table rules",
  "author": "Wizard",
  "summary": "Inspiration as rerolls, Hero points",
  "exported": "2026-11-26T15:00:00.000Z",
  "alexandria": "0.1.0-alpha.1",
  "mods": [ { "kit": 2, "id": "inspiration-rerolls", "...": "..." } ]
}
```

Both end in `.alxmod.json`, and both import the same way.

## Adding a rule here

1. Drop the file in this folder (one rule or a package). The id must be new.
2. Restart the server. A broken file is skipped with a warning in the log; it
   never stops the server.
3. `npm test` in `librarian/` checks every file in this folder.

A server can read its own folder instead with `ALX_MODS_DIR=/path/to/mods`
(for Docker, mount it and set the variable).

A rule that switches on a feature's settings (spell points, MANA, spell
crafting) is claimed by that feature by id in its `houseRules`, so it shows
the feature it belongs to. A rule that needs new code is built as a feature:
see "For developers" in [docs/MODS.md](../docs/MODS.md).
