# Templates & guides

DM → Prep → **Templates & guides** (`/w/:world/dm/templates`). DM only: players get
403 from every route and never see the page, the tools or what a guide found.

A template is something the DM reuses. A **guide** is a template the assistant
follows by itself. For example, "Towns: for my world always research the real
Japanese town it is based on, my own world lore and the towns around it": every
later request to make a town gets that guide, its research steps and the
structure of the towns already written.

## Kinds

| Kind | What it holds | Using it |
|---|---|---|
| **Agent guide** | task, instructions, steps (below), sections in order, tone, folder, exemplar pages | the assistant uses it when a request matches; **Ask the assistant** fills in "Use guide Towns: " |
| **Generator template** | the generator (town, NPC, tavern, shop…), fields with hints, sections, instructions, folder | read by the assistant like a guide when a request matches |
| **Macro template** | a prompt with `{{blanks}}`, the blanks, mode (propose or do), allowed tools | **Make a macro**: a Minerva macro step (`minerva.run`) the DM fills in when it runs ([MACROS.md](MACROS.md)) |
| **Assist panel** | a workspace layout, its panes and a request for the assistant | **Open**: the workspace with those panes, the request waiting in the assistant's box |
| **Shop generation** | shop type, a guide, typical stock, price notes | **Make a shop**: a draft from the shop generator following the guide (below); the assistant reads it for shop requests |
| **Library page** | folder, title pattern, tags, sections, a page skeleton | **New page from this**: a DM-only page from the skeleton; the assistant reads it like a guide |

Every template is per world, has a name and a short description, and is **on or
off** (off: the assistant never uses it). Saving a change makes a new **version**;
the last 50 are kept and any can be restored (a restore is a new version too).
Turning a template on or off is not a new version. A template that repeats
classified text is refused when it is saved: templates go into model requests.

## Making one with the assistant

- **New with the assistant**: pick the kind and describe it in your own words.
  The assistant drafts it and asks up to three questions (which real place to use
  when a request names none, which sections every page needs, which pages are the
  best examples…). Answer some and **Redraft with my answers**, or edit the draft
  and **Save**. Without a chat model the draft comes from rules (the kind of thing
  you named, the cues "IRL", "real-world", "research", a nationality, "lore",
  "around"), so it still works.
- **From examples**: pick one to eight library pages made the way you like (three
  towns, say). Their common structure becomes a guide: the headings most of them
  share, in their usual order; the folder and tags they share; whether they keep
  DM-only details in `> [!secret]` blocks and link with `[[wikilinks]]`; their
  length. The pages are read as the assistant reads them (the AI copy), so a
  classified page is left out and named in the notes. A chat model, when set, only
  words the instructions and tone; the structure comes from the pages.
- **In the chat**: the assistant has `list_dm_templates`, `get_dm_template`,
  `create_dm_template` and `update_dm_template`. Creating or changing one is a
  card the DM approves (or runs at once in Auto).

## How a guide is used

A request uses a guide when:

1. it names it: "use guide Towns: …", "follow the Towns guide", "using guide Towns"; or
2. it is a request to make something (make, create, write, draft, generate,
   build, design, prep, new, add…) and holds one of the guide's **trigger words**,
   whole word or plural: `town` matches "towns", `city` matches "cities", not
   "downtown". A guide marked *always* matches the word alone.

Not when the message is about guides or templates themselves ("make a guide for
towns"), or says "no guide". At most two guides per message, a named one first.

The chat then shows **Using guide: Towns** above the reply, with each step and
what it did (done, waiting, skipped, blocked). Before the model is asked, the
guide's steps run:

| Step | What it does |
|---|---|
| `library` | searches the world library for the places, names and words in the request |
| `neighbours` | the places the request puts it near ("near Saltmarsh", "between X and Y", "around X"): their pages, the pages they link to and their relations; with none named, the places of this kind the world has (the guide's folder, or pages tagged with a trigger word) |
| `exemplars` | reads the exemplar pages (or two pages of this kind) and passes their headings and opening |
| `web` | web research (below), with the step's search words; `{reference}` is the real-world place the request names ("based on Tomonoura", "inspired by …"), `{name}` the name given ("called Kirihama"). A step that needs a reference the request does not give is skipped and says so |
| `instruction` | a line of instructions |

What they found goes into the assistant's context with the guide (instructions,
sections in order, tone, folder) and the library pages and web sources are the
reply's sources. Everything is read as the assistant may read it: never
classified text, and a guide that would repeat classified text is not used.

New pages go through the normal approval flow: the assistant proposes `save_page`
(a card, also in Auto: `save_page` always asks), DM only unless you say
otherwise, in the guide's folder, ending with a **Sources** section.

## Web research

The `web_research` tool searches the web for a real-world reference. It is the
DM's choice per world and **off by default**: Templates & guides → Web research.

- **Providers**: OpenRouter's web search (a provider added in Admin → Models
  whose address is OpenRouter; the model is the one you name, or the chat job's
  when the chat job is on OpenRouter) or a **SearXNG** instance (its address; the
  JSON output must be on: `search.formats: [html, json]`).
- **Only the query words leave Alexandria.** To OpenRouter the request is the
  query as the only message (with the `web` plugin); to SearXNG, `GET
  /search?q=…&format=json`.
- **Fail closed.** Before anything is sent, every query is checked against this
  world: a query holding a word that only classified text has, or a name
  (capitalised word, page title or alias) that only DM-only text has, is refused
  and nothing is sent, not even the other queries in the same call. A refused
  classified word is never repeated back. The DM may allow a DM-only word under
  *DM-only words you allow in searches*; a classified word can never be allowed.
  The core classified guard also screens the OpenRouter request. Every search and
  every refusal is written to the audit log.
- **Approval.** In Ask first, a search is a card showing the exact words ("Search
  the web for "Tomonoura Japan town history". Only these words leave
  Alexandria"); nothing is sent until it is approved. In Auto it runs at once (it
  is not on the always-ask list). A search that would be refused never becomes a
  card.
- **Results feed the draft.** An approved search puts its sources in the chat
  (titles, links, snippets) and the assistant carries on from them by itself,
  with the same guide, without searching again. Results are cited as sources;
  nothing is published without the DM.

## Shop generator

A shop generation template passes its whole text (type, guide, stock, prices) to
the shop generator, `generateShop(d, worldId, opts, guide)` in
`features/shop/gen.ts`. Without a model the guide weights the item picks and the
generator reads directives in it: "12 items", "markup 20%", "no magic", "max
rarity rare"; with a chat model it is the brief. The shop type picks the
generator's kind ("apothecary" is an alchemist). **Make a shop** shows the draft;
the DM makes and stocks shops on the Shops page.

## API (DM only)

All under `/api/worlds/:world/templates`:

| Route | |
|---|---|
| `GET /?kind=` | the templates, the kinds, whether a chat model is set |
| `POST /` | create `{kind, name, description, triggers, enabled, spec}` |
| `GET /:id` | one (by id or name), with its versions |
| `PUT /:id` | change (a spec with some keys changes only those); a new version |
| `POST /:id/restore` `{version}` | an earlier version back, as a new version |
| `DELETE /:id` | delete it and its versions |
| `POST /draft` `{kind, description, answers?, current?}` | the assistant's draft and questions (nothing saved) |
| `POST /derive` `{pageIds, name?}` | a guide from example pages (nothing saved) |
| `GET/PUT /web` | web research settings |
| `POST /web/check` `{queries}` | would these words be sent? |
| `POST /web/search` `{queries}` | search (1 to 3 queries) |
| `POST /:id/shop` `{options?}` | a shop draft from the shop generator with this template's guide |

MCP (DM only): `list_dm_templates`, `get_dm_template`, `create_dm_template`
(write), `update_dm_template` (write), `web_research` (write).

## Code

`librarian/src/features/templates/`: `spec.ts` (kinds and their specs),
`store.ts` (tables, versions, web settings), `match.ts` (triggers), `draft.ts`
(drafting and deriving), `guides.ts` (running a guide for the assistant),
`web.ts` (query checks and providers), `shop.ts` (the shop adapter). The harness
calls `applyGuides` before the first model call (`features/agent/harness.ts`).
The page is `web/src/features/templates/`. Tests: `librarian/test/templates.test.ts`
and `web/e2e/templates.mjs`.
