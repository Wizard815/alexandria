# Sculpting templates

A template is a list of fields and a Markdown body. Sculpting fills the empty
fields (generators first, then at most one model call) and renders the body.
Everything that needs no model (names, items, coins, encounters, weather, dice,
the clock, the party) is resolved first and is fast.

## The body

| Syntax | Meaning |
| --- | --- |
| `{{key}}` | A field's value. A line whose fields are all empty is dropped. |
| `{{#dm}}...{{/dm}}` | GM-only: becomes a `> [!secret]` block on a page and never reaches players. |
| `{{#if x}}...{{else}}...{{/if}}` | `x` is a field or context variable; `!x` negates. |
| `{{#each list}}{{this}} {{@n}}{{/each}}` | Each line of a list field. `{{this.2}}` is the second `|` column. |
| `{{gen:name race=elf gender=female}}` | An inline generator: `name`, `place`, `item`, `items`, `coins`, `encounter`, `weather`, `trap`, `rumour`, `bark`, `letter`, ... `$field` in a value reads another field. |
| `{{dice:2d6+3}}` | Rolled once: `11 (2d6+3)`. |
| `{{pick:a|b|c}}` | One of the options. |
| `{{world.date}}` `{{world.season}}` `{{world.time}}` `{{party.level}}` `{{party.names}}` `{{location}}` | World context. A field with the same key wins over `{{location}}`. |
| `{{page:Title}}` | An excerpt of a library page: the player copy in a player template; in a GM template the AI copy, kept in a GM-only part. |

Inline results are seeded: the same values (including the hidden `__seed`) always
render the same text, so the preview does not change under your hands.
Sculpt again for fresh rolls.

## Fields

Types: `text longtext number select list name item coins page statblock dice
table image pageLink rollTable`.
`gen` always fills a blank field from an expression (`gen:coins mode=hoard level=$level`,
`dice:1d6+9`, `pick:a|b`, or `clock`/`stock`); `fallback` is used when there is
no model or it left the field blank; `default` is applied first; `optional`
silences the "stays empty" note. A roll table's `dieField` names a select
holding `d6` or `d20`; its rows are generated from `gen`/`fallback`, one per face.

## Outputs

A template declares what a result may do, and the GM can untick each:
`page` (save to the target), `stage` (a text or event card, plus a picture card
if there is an `image` field), `combat` (a statblock field, or a list of
`3× Goblin (CR 1/4, AC 15, HP 7)` lines, rolled into initiative), `send`
(player-perspective templates), `broker` (a broker note). `POST /sculpt/outputs`
runs them; each succeeds or fails on its own.

## Safety

Players, the stage, messages and the broker only ever get the non-GM parts, and
those are checked against GM-only text first (8 shared words blocks them). A
player-perspective template is checked field by field and as rendered text.
Models only see the AI copy of pages, which has no classified text.

## Sharing

`GET /sculpt/templates/:id/export` gives `{ format: "alexandria-sculpt-template", version: 1, template }`.
`POST /sculpt/templates/import { json, preview? }` validates it (unknown generators,
unbalanced blocks and unknown tokens are refused with a reason); `preview: true`
returns a summary and saves nothing. Built-ins can be duplicated and edited.
