# Game modules

A game module is a named set of **terms**: spells, conditions, monsters,
rules, items and so on. Alexandria uses them to answer rules questions (the
broker's free "Other" questions, the `lookup_rule` tool), to highlight
keywords in recaps and notes, and to show a card when you hover a word.

Two modules come with the app. Both are published under CC-BY-4.0 and their
credit lines are shown in World settings → Game module and on the Rules page.

| id | Name | Source |
|----|------|--------|
| `dnd-2024` (default for new worlds) | D&D 2024 (SRD 5.2) | System Reference Document 5.2 |
| `dnd-2014` | D&D 5e 2014 (SRD 5.1) | System Reference Document 5.1 |

Each world turns on one or more modules **in an order**. When two enabled
modules define the same term (same name and kind), the earlier module wins.
A DM changes this under World settings → Game module, or with
`PUT /api/worlds/:world/modules/enabled { "ids": ["house", "dnd-2024"] }`.

## The module format

A JSON file:

```json
{
  "id": "my-module",
  "name": "My module",
  "version": "1.0",
  "license": "CC-BY-4.0",
  "attribution": "Credit line shown in the app.",
  "terms": [
    {
      "id": "fireball",
      "term": "Fireball",
      "aliases": ["Ball of Fire"],
      "kind": "spell",
      "summary": "Level 3 evocation, 150 feet. 8d6 fire in a 20-foot sphere.",
      "text": "Markdown: the full text of the term.",
      "data": { "level": 3, "school": "Evocation" }
    }
  ]
}
```

- `id`, `name` are required. `id` is lower-case letters, digits and hyphens
  (made from the name if missing). `dnd-2024` and `dnd-2014` are reserved.
- Each term needs `term`. Everything else is optional:
  - `kind` is one of `spell`, `condition`, `monster`, `rule`, `item`,
    `action`, `class`, `other`. Anything else becomes `other`. Rules sections
    are terms of kind `rule`.
  - `summary` is at most 300 characters (longer is cut). If missing it is
    taken from the start of `text`.
  - `text` is Markdown, up to 60,000 characters.
  - `aliases` are other names that should find the term and be highlighted.
  - `id` is unique inside the module (made from kind and name if missing).
  - `data` is structured data, up to 40,000 characters of JSON. Monsters
    carry a statblock: `size`, `type`, `alignment`, `cr`, `xp`, `ac`, `hp`,
    `hitDice`, `speed{}`, `abilities{str,dex,con,int,wis,cha}`,
    `savingThrows{}`, `skills{}`, `resistances[]`, `immunities[]`,
    `conditionImmunities[]`, `senses{}`, `languages`, and `traits[]`,
    `actions[]`, `bonusActions[]`, `reactions[]`, `legendaryActions[]` (each
    `{ name, text }`). Spells carry `level`, `school`, `castingTime`, `range`,
    `components[]`, `duration`, `concentration`, `ritual`, `classes[]`.
- Limits: 20,000 terms per module and about 24 MB in all.

## Importing (DM only, always preview first)

World settings → Game module → **Import**, or the API:

- `POST /api/worlds/:world/modules/import/preview` returns the module's id
  and name, the count per kind, five sample terms and any warnings. It saves
  nothing.
- `POST /api/worlds/:world/modules/import` takes the same request and saves
  it. If the module id is already imported, send `"replace": true`. The new
  module is turned on at the end of the order (`"enable": false` to skip).
- `DELETE /api/worlds/:world/modules/imported/:id` removes an imported module.

Request bodies (`module` carries optional `id`, `name`, `version`, `license`,
`attribution`, which override what the source says):

| `type` | Body | Notes |
|--------|------|-------|
| `json` | `{ "type": "json", "json": <object or string> }` | The format above. |
| `zip` | `{ "type": "zip", "zip": "<base64>", "module": { "name": "…" } }` | Or send the raw `.zip` with `Content-Type: application/zip` and `?name=…&id=…&replace=1` in the query (up to 16 MB). |
| `folder` | `{ "type": "folder", "files": [{ "path": "spells/Fireball.md", "text": "…" }], "module": { … } }` | What the browser's folder picker sends. |
| `git` | `{ "type": "git", "url": "https://…", "ref": "main", "path": "rules/", "module": { … } }` | `git clone --depth 1` into a temporary folder under the data directory, read as a folder, then deleted. https and http only; private addresses are refused. |
| `api` | `{ "type": "api", "url": "https://…", "itemsPath": "results", "paging": "page", "mapping": { … }, "module": { … } }` | See below. |
| `open5e` | `{ "type": "open5e", "documents": ["tob", "deepm"], "kinds": ["monster", "spell"] }` | Books from Open5e. See below. |
| `dnd5eapi` | `{ "type": "dnd5eapi", "edition": "2024", "kinds": ["spell"] }` | A fresh SRD copy. See below. |

`POST …/modules/import` also takes `"feed": { "spells": true, "items": true }`
(any source): after saving, the module's spells are imported into the Codex
(so the spell list, study and the spell tree have them) and its items into
the shop's item database. Same name and source is skipped, or updated with
`"replace": true`. The answer then carries `fed: { spells, items }` counts.
Monsters and conditions need no extra step: the encounter builder,
initiative and rules cards read every enabled module.

### Markdown files (zip, folder, git)

One term per `.md` file. Frontmatter:

```markdown
---
kind: spell
aliases: [Ball of Fire, Fire Ball]
summary: A bright streak that blossoms into flame.
---
# Fireball

The full text, in Markdown.
```

- The term's name comes from `title:` / `term:` / `name:`, else the first
  `# Heading` (which is then removed from the text), else the file name.
- `kind` comes from the frontmatter, else a folder named like a kind
  (`spells/`, `conditions/`, `monsters/`, `rules/`, `items/`, `actions/`,
  `classes/`), else `other`.
- A `module.json` at the top of the zip or folder may give `name`, `version`,
  `license` and `attribution`. `README`, `LICENSE` and files starting with `_`
  or `.` are skipped. A single top-level folder (as in a zipped repository)
  is ignored.
- Limits: 20,000 files, 200,000 characters per file, 2 MB per file inside a
  zip and 24 MB unpacked in all.

### JSON API

Same idea as the world-source API connector. `mapping` names a dotted path
for each part: `term` (default `name`), `text` (default `description`; several
paths separated by commas are joined), `kind`, `summary`, `aliases`, `id`,
`data`. `itemsPath` says where the list is (blank: the answer is the list).
`paging` is `none`, `page` (with `pageParam`, `pageStart`), `link` or `cursor`
(with `nextPath`). `textFormat` is `markdown` (default), `html` or `text`.
`token` and `authHeader` send a credential. A default kind for every record
can be set with `kind`. `maxItems` (default 5000) bounds the import.

### Open5e and the 5e SRD API (free, no key)

World settings → Game module → Import → **Open5e** or **5e SRD API**.

- `GET …/modules/sources` (DM) lists Open5e's books (`key`, name,
  publisher, game system, licence) and the 5e SRD API editions. The same
  list is the agent tool `list_content_books`; `import_content` imports
  (a write the DM approves).
- **open5e** reads `https://api.open5e.com/v2/` (or `base`): spells,
  creatures, magic items, gear, conditions, feats, backgrounds and species
  of the chosen books (at most 12 per module). Terms get the same `data`
  and card layout as the built-in SRD, so player cards hide a monster's
  numbers the same way. Each spell's source is its book; spells from the
  SRD 5.2 book use `SRD 5.2.1`, so they are not added to the Codex twice.
  Monsters keep Open5e's habitats in `data.environments`; the encounter
  generator uses them for its environment filter (a creature tagged with
  12 or more counts as "anywhere" and goes by type).
- **dnd5eapi** builds the module the same way the built-ins are built
  (`srd5e.ts`), from the database dnd5eapi.co serves
  (`5e-bits/5e-srd-api`, `packages/5e-database/src`, or `base`): one file
  per list instead of one API call per entry, since dnd5eapi.co limits how
  fast a client may call it. Use it to pick up fixes made after this
  release; the module id is `dnd5eapi-2014` / `dnd5eapi-2024`.
- `kinds` narrows either import. A preview and the save after it share one
  download (kept 15 minutes). The credit line names each book, its
  publisher and licence (OGL 1.0a or CC-BY-4.0) and is shown in Credits.

### The server content library (admins)

Admin → Sources → **Content library** pulls a book once onto the server and
keeps it, so every world can turn it on in World settings → Game module
(under Available, marked "server library") with nothing downloaded and
nothing to wait for, offline too. 2024 books are listed first and every book
is labelled 5e 2024 or 5e 2014 (Open5e's Kobold Press and Level Up books are
2014; its 2024 content is the SRD 5.2, which is also built in).

- `GET /api/admin/content` lists the library; `GET /api/admin/content/sources`
  the Open5e books and SRD API editions.
- `POST /api/admin/content/preview` and `POST /api/admin/content` take an
  `open5e`, `dnd5eapi` or `json` request as above (`"replace": true` to
  overwrite). `POST /api/admin/content/:id/refresh` pulls the same request
  again; `DELETE /api/admin/content/:id` removes it from every world.
- A world cannot import its own copy under a library module's id.
- `POST /api/worlds/:world/modules/feed { "id": "open5e-tob" }` (DM) puts a
  module's spells into the Codex and its items into the shop's item
  database, for a library module or an earlier import ("Add spells & items"
  in World settings → Game module).

## Looking things up

All under `/api/worlds/:world/modules`, open to every member (modules hold no
secrets):

- `GET /` the enabled modules in order, and every module that could be on.
- `GET /terms?q=&kind=&module=&limit=&offset=` returns `{ total, terms }`
  found by name or alias.
- `GET /terms/:id` one term in full. A term id is `moduleId:termId`, for
  example `dnd-2024:spell-fireball`.
- `GET /rules/search?q=how does grappling work&limit=5` returns
  `{ results: [{ id, term, kind, summary, passage, citation, score }] }`,
  ranked: a name or alias hit beats a summary hit beats a hit in the text.
  This is free and needs no model. Other server code can call
  `searchRules(db, worldId, q, limit)` from
  `librarian/src/features/modules/search.ts`.
- `POST /match { "text": "…" }` returns an array of
  `{ start, end, text, term, kind, source: 'module' | 'library', id }`:
  the keywords in the text, for highlighting.
  - The longest phrase wins, case-insensitively, on whole words only
    ("Ashes" does not match "Ash").
  - It covers the enabled modules' terms and aliases, and library page titles
    and aliases **the caller can see**. For a player that means pages with a
    player copy only; a DM-only page's title never matches for a player.
  - A world page beats a module term of the same name.
  - Plain actions such as "Dash" or "Help" match only through their longer
    aliases ("Dash action"), so ordinary sentences are not full of
    highlights.
- `GET /card/:source/:id` the hover card. `source` is `module` (id from a
  match) or `library` (a page id; players get only the player copy, and a
  DM-only page is a 404).

MCP tools: `lookup_rule`, `lookup_term`, `read_term`.

A module's spells can also be imported into the world's spell list, the Codex
(with mana costs and spell crafting): see [SPELLS.md](SPELLS.md).

## Rebuilding the built-in modules

`librarian/scripts/build-srd.ts` rebuilds `librarian/src/features/modules/data/srd-2024.json`
and `srd-2014.json` from the 5e SRD API seed database (conditions, spells,
monsters with structured statblocks, rules, magic items, equipment, class
features, feats and more):

```
NODE_USE_ENV_PROXY=1 node --experimental-strip-types librarian/scripts/build-srd.ts
# or from files saved earlier (named 2014-Spells.json, 2024-Monsters.json, …):
node --experimental-strip-types librarian/scripts/build-srd.ts --from <dir>
```

The 2024 seed has no rules sections, so the 2024 module's core rules
(actions in combat, cover, opportunity attacks, grappling, death saves,
resting and so on) come from `data/rules-2024.handwritten.json`, short
paraphrases written for this app under the same attribution. Edit that file
and run the script again to change them.

## Attribution

- SRD 5.2: This work includes material from the System Reference Document 5.2
  ("SRD 5.2") by Wizards of the Coast LLC, available at
  https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative
  Commons Attribution 4.0 International License, available at
  https://creativecommons.org/licenses/by/4.0/legalcode.
- SRD 5.1: This work includes material taken from the System Reference
  Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC and available at
  https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is
  licensed under the Creative Commons Attribution 4.0 International License
  available at https://creativecommons.org/licenses/by/4.0/legalcode.
