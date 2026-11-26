# Mods (house rules)

Every house rule that comes with Alexandria is a rule file in this folder.
The server reads each `*.alxmod.json` here when it starts, and the DM turns
them on under **World → House rules**. See [docs/MODS.md](../docs/MODS.md)
for the format.

| File | Rule | Switches on |
| --- | --- | --- |
| `inspiration-rerolls.alxmod.json` | Inspiration as rerolls | Personal, everyone and DM rerolls, the sheet's Re-rolls module and `/reroll` |
| `spell-points.alxmod.json` | Spell points | The standard spell points variant for every character (spells feature) |
| `mana-pool.alxmod.json` | Simple mana pool | Alexandria's own mana numbers (spells feature) |
| `mana-system.alxmod.json` | MANA spell system | Wizard's MANA rules; needs the MANA engine |
| `spell-crafting.alxmod.json` | Spell crafting (Codex) | Learning spells by combining known ones (spells feature) |
| `dndbeyond-import.alxmod.json` | D&D Beyond import | Import on the player sheet: Character and Stats modules, HP, counters, items (sheet feature; unofficial) |

`examples/` holds rules that are not built in. The assistant reads them as
patterns when it makes a rule for you (`house_rule_file`), and you can paste
one under **House rules → Make or add one** to try it:

| File | Shows |
| --- | --- |
| `examples/hero-points.alxmod.json` | A small counters rule: give, spend, a session-start trigger, a chat word |
| `examples/downtime-lite.alxmod.json` | A whole data system: activities by tier (common 1 day to legendary 90), each player's tasks, a Downtime day popup, a timer to the goal, DM and sheet views |

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
