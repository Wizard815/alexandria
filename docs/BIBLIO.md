# Biblio: the world library Alexandria hosts itself

Biblio is a wiki for your world that lives inside Alexandria. Use it when you
don't keep your lore in LegendKeeper, Kanka, World Anvil, Notion or Obsidian,
or when you want to leave one of them. Players read the articles you share,
and every assistant (Minerva, Squire, the broker, outside AI apps over MCP)
reads Biblio and can write to it through tools.

- **The Game Master** opens **`/biblio`** (also `/Biblio`), which goes to
  *World → Biblio* (`/w/<world>/gm/biblio`). There you write, arrange and
  manage articles.
- **Players** find it under *More → Biblio* (`/w/<world>/biblio`), and
  `/biblio` takes them there too.

## What it does

| | |
|---|---|
| **Articles and templates** | Each article has a template: page, character, location, organisation, item, creature, people, deity, event, quest, lore or session notes, plus any you make. A template gives the article its infobox fields. They use the same type names as the LegendKeeper, Kanka and World Anvil imports, so filters and assistants treat a Biblio character like an imported one. |
| **GM-only fields** | A field marked *GM only* (for example a character's *Secret*) goes into a separate infobox group that players never receive. |
| **Levels** | Each article is *players can read*, *GM only (broker may sell)*, *GM only* or *classified*. New articles start as GM only. Classified articles never reach any AI. |
| **Secrets in the text** | `> [!secret]` callouts, `> [!broker]`, `> [!classified]` and the other markers in [the library guide](../librarian/README.md) work as they do on library pages. |
| **Tree** | Articles sit inside other articles, as deep as you like, with an order. Moving one moves everything under it. |
| **Links** | `[[Article]]` or `[[Article\|words]]` links an article by its title or one of its other names. Every article lists the articles and library pages that link to it (*Mentioned in*). A link to an article that doesn't exist yet shows under *Not written yet*, and one click starts it. |
| **Relations** | Link fields such as *Member of*, *Allies*, *Enemies*, *Parents* and *Spouse* become relations on the Relations page and in the assistants' `who_is` answers. A GM-only link field makes a GM-only relation. |
| **Timeline** | Every date field (*When*, *Born*, *Founded*…) puts the article on the timeline. The first whole number in the date sorts it, and *BC*, *BCE* or *BR* makes it negative, so "3 Frostfall 1042 AR" sorts as 1042 and "212 BR" as -212. Players see only the dates in their own copy. |
| **History** | Every save keeps a version (the last 200). *History* shows what changed and brings an old version back as a new one. Versions made by an assistant are marked. Two people (or you and the assistant) saving the same article at once get "changed since you opened it" instead of one overwriting the other. |
| **Trash** | Trashing an article takes everything under it. *Restore* brings them all back on the same library pages, so links, shares and People entries still find them. *Delete for good* empties it from the trash. |
| **Suggestions** | Players press *Suggest an edit* on an article, or suggest a new one. The GM accepts (the text is added to the article under the player's name, or becomes a new GM-only article) or turns it down. Ordinary change requests on a Biblio article are applied through Biblio too. |
| **Move in & out** | *Copy all into Biblio* copies every page of a LegendKeeper, Kanka, World Anvil, Notion, Obsidian or other source, keeping their places in the tree, levels, tags, other names and secrets. Infobox rows that match the template's fields fill them, and the rest go into the text (GM-only rows inside a `> [!secret]` callout). The originals stay until you switch the source off. *Download Biblio* saves everything as one JSON file that *Load a Biblio file* reads into any world. |

## How it fits in

Biblio keeps each article (and its versions) in its own tables, and every save
publishes the article into the library as a page of the world's **Biblio**
source. So everything that works on library pages works on Biblio too, with
nothing to sync:

- the leak guard and the player, broker and AI copies
- search, the Historian's embeddings, the story bible and the knowledge refresh
- sharing a page with one player, offline saves, and the library's own tools
  (`list_pages`, `read_page`, `search_library`)

The Biblio source can't be deleted from the sources list. The library won't
save over or delete a Biblio page (`PUT /library/pages` and
`DELETE /library/pages/:id` answer 409); change it in Biblio. If the pages were ever lost, the server publishes the articles again
on its next start.

**Who gets what.** Players never read the stored article. Everything they get
(text, infobox, children, *Mentioned in*, timeline) comes from their own
library copy, so a GM-only field, a secret callout or a link to a hidden page
can't reach them. A model working for the GM gets the AI copy: no classified
article or classified part, no old versions, and it may not write an article
that holds classified parts (it never saw them) or make anything classified.

## With the rest of Alexandria

| Part | How it works with Biblio |
|---|---|
| **People and organisations** | Characters, organisations (factions, guilds, militias) and peoples are templates. *Member of*, *Allies*, *Enemies*, *Parents* and *Spouse* become relations on the Relations page and in `who_is`. A *People* entry the party met can point at a Biblio page (`pageId`), and each player keeps their own private note on it. |
| **Regions and places** | A location's *Kind* says region, town, inn and so on, and *Located in* plus the tree say what sits inside what. |
| **Maps, pictures and markers** | A map picture is uploaded to Files with the article as its page (`POST /files?kind=map&page=<pageId>&level=…`). It shows on the Map page for whoever may read it, and pins, notes and icon markers go on it there, with GM-only markers. A picture can be the article's cover. Pins don't link back to articles yet. |
| **Items and creatures** | Items have rarity, attunement, owner and a GM-only true nature. Creatures have challenge rating, armour class, hit points, speed, ability scores and actions, so Minerva can put one into combat with the right numbers. |
| **Spells, skills, health and mana** | These live on the character sheet and the Spells page, not in Biblio. A *Lore* article can describe a spell's history. Minerva reads both. |
| **Search and embeddings** | Each article is a library page, so keyword search, semantic search (the Historian's embeddings), Related pages and the knowledge refresh index it, each viewer from their own copy. |
| **Story bible** | The story bible reads Biblio pages like any other. Players get facts only from their own copy. |
| **Permissions** | The level sets who can read it (party, GM only with broker, GM only, classified). *Share with one player* (Library → Sharing) works on a Biblio page and survives edits. Guests read party articles but can't suggest. Player and read-only MCP keys can't write. An admin who isn't in the world gets nothing. |
| **Assistants** | Minerva reads and writes through the `biblio_*` tools (writes become approval cards). The players' assistant reads their copy only, and an article that tells an AI to print secrets gets nowhere because the secrets aren't in its copy. |

`librarian/scripts/biblio-real.ts` checks all of this (about 150 checks) against a fresh server, with real models from OpenRouter or with `--no-models`:
`BIBLIO_REAL=1 NODE_USE_ENV_PROXY=1 node --experimental-strip-types scripts/biblio-real.ts`.

## Assistant tools

| Tool | Who | What |
|---|---|---|
| `biblio_list` | everyone | the article tree they may read |
| `biblio_read` | everyone | one article: text, infobox, parent, children, *Mentioned in* |
| `biblio_find` | everyone | search articles by words |
| `biblio_timeline` | everyone | dated articles in world order |
| `biblio_templates` | GM | the templates and their fields |
| `biblio_write` | GM (write) | create, or change only the fields given; `append` adds to the end |
| `biblio_move`, `biblio_trash` | GM (write) | move under another article, or to the trash |
| `biblio_suggest` | player (in the app) | suggest a change or a new article to the GM |

In the app, Minerva's writes become cards the GM approves (or run at once
when the tool is set to *Always allow*). A GM's write key over MCP writes
directly. Player keys are read-only.

## API

All under `/api/worlds/:world/biblio`. The GM writes; anyone in the world
reads their own view.

| Endpoint | |
|---|---|
| `GET /` | `{ articles, templates, canEdit, gm, sourceId, trash }` |
| `GET /articles/:id` | `{ id, pageId, title, template, page, parent, children, backlinks }`, plus `article` (as stored) for the GM in the app. `:id` may be the page id. |
| `POST /articles` | `{ title, template?, parentId?, position?, level?, summary?, body?, fields?, tags?, aliases?, icon?, cover?, knowledge? }` |
| `PATCH /articles/:id` | the same fields, only those given change; `append` adds to the body; `rev` refuses a stale edit (409); `note` labels the version |
| `POST /articles/:id/move` | `{ parentId, position? }` |
| `DELETE /articles/:id` | to the trash with everything under it; `POST /articles/:id/restore` brings it back |
| `GET /trash`, `DELETE /trash/:id` | the trash, and deleting for good (GM in the app) |
| `GET /articles/:id/revisions`, `GET …/revisions/:rev`, `POST …/revisions/:rev/restore` | history (a whole old version: GM in the app only) |
| `GET /search?q=` | search hits with `articleId` |
| `GET /timeline` | `[{ articleId, title, label, when, sort }]`, oldest first |
| `GET/POST /templates`, `PUT/DELETE /templates/:id` | built-in and your own templates (a template still in use can't be deleted) |
| `GET/POST /suggestions`, `POST /suggestions/:id/accept`, `POST /suggestions/:id/reject` | players suggest; the GM decides |
| `POST /import` | `{ sourceId }` or `{ pageIds, parentId? }`: copy pages in (GM in the app) |
| `GET /export`, `POST /export` | download everything, or load a download (GM in the app) |
| `POST /republish` | publish every article to the library again |

Field values are text. A link field holds names (`Old Kesh, Brother Tamsin`)
or `[[links]]`, and a yes-or-no field holds `yes` or `no`.

## Where the ideas came from

Biblio is Alexandria's own code. No code was copied from anywhere, and it adds
no new dependency. Its shape follows what world-building and wiki tools have in
common: article templates with infoboxes and secrets (World Anvil,
LegendKeeper, Kanka), nested pages and revision history (BookStack, a wiki),
`[[links]]` with backlinks (SilverBullet, Obsidian), and a review queue for
machine-written changes (SwarmVault). We looked at embedding BookStack,
SilverBullet, Payload CMS and SwarmVault, which are all MIT licensed. Each would
have been a second server with its own logins and its own database, and none of
them knows about Alexandria's player copies or classified text.
