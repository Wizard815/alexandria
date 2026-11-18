# Minerva: the DM's agent and her campaign memory

Minerva (goddess of wisdom) is the DM's assistant. She prepares sessions, keeps the
campaign's long-term state, remembers every player's goals, ideas and history, and helps at
the table. **Players never meet her.** To them she is the information broker: the player
harness, the broker's name and voice. She never says or hints that she is Minerva, that she
serves the DM, or what she remembers about them.

Her memory is an LLMWIKI for the campaign: plain Markdown pages with front matter, readable
in Obsidian (the `dnd` branch of LLM-will-remember-this uses the same layout), stored in
Alexandria's library under `Minerva/` like any other page, with the same levels, search,
embeddings, story bible, offline copies and leak checks.

## 1. What she keeps, and what she doesn't

Alexandria already holds most of a campaign. Minerva links to it and never copies it:

| Already in Alexandria | Minerva's page for it |
|---|---|
| Source pages (LegendKeeper, Kanka): characters, places, organisations, families, creatures, races, items, quests, maps, notes | one **codex** page per entity that matters, holding only what the source doesn't: appearances, what changed, ties to players, secrets. It links to the library page (the truth for the entity itself) |
| Relations, family trees | linked, not copied |
| Sessions calendar, world clock, source timelines | `chronicle/` indexes them |
| Session logs (from transcripts) | filed under their arc; the raw log is the session page |
| Story bible (facts from pages), smart connections, embeddings | her reference shelf and retrieval |
| Generators, sculpting templates | how she makes new NPCs, places, encounters |
| Dice log, combat, broker deals, approvals | read for context; facts worth keeping go to the status doc or codex |

## 2. Layout

```
Minerva/
├── HOME.md                          dashboard: status, active arc, open threads, review queue
├── dm/                              level dm (whole tree)
│   ├── state/Campaign Status.md     THE living doc. Read before every session. Everything feeds it;
│   │                                nothing replaces it. Sections: Now · Active threads (with heat) ·
│   │                                NPC agendas · What changed last session · Next session · Open questions
│   ├── revelations/<mystery>.md     conclusion → clues (at least 3) → which PC found which, when
│   ├── session-prep/<date>.md       strong start, scenes, secrets & clues to drop, NPCs, places, rewards
│   ├── hooks/<hook>.md              planted / waiting / sprung / dropped
│   ├── hidden-lore/<topic>.md       the truth behind things (dm or classified)
│   └── players/<id>.md              Minerva's notes on each player: what they enjoy, what they're
│                                    after, hooks aimed at them, table notes. Never shown to players.
├── chronicle/                       level party unless marked
│   ├── arcs/<NN-slug>/summary.md    one page per arc (about 8-12 sessions): what mattered, what changed.
│   │                                This is what gets read. A "> [!secret]" block holds the DM's view.
│   ├── arcs/<NN-slug>/sessions/session-<n>.md
│   │                                the session's log and recap (from the session log feature);
│   │                                archived and linked, rarely opened directly
│   ├── timeline.md                  in-world history: eras and events, linked to source timelines
│   └── calendar.md                  index of the sessions calendar and the world date
├── codex/                           one page per entity, then it ACCRETES; never re-created
│   ├── characters/pc/<name>.md      level party; "> [!secret]" for the DM's notes
│   ├── characters/npc/<name>.md     promoted once recurring or plot-relevant (§4)
│   ├── locations/<name>.md          regions are pages too (kind: region); places link up with `region:`
│   ├── organizations/<name>.md      trade routes are pages (kind: trade-route), linked from both ends
│   ├── families/  creatures/  races/  items/  quests/  maps/
│   └── lore/<topic>.md              world lore, rules notes, art reference, other settings
└── players/<id>/                    one root per player
    ├── profile.md                   the player and their PC; "## Shared with the party" section
    ├── goals/<goal>.md              their character's goals; heat: on · ongoing · simmering · sleeping
    ├── journal/session-<n>.md       their own notes per session (written by them or the broker for them)
    ├── knowledge.md                 what this PC knows: clues found, revelations reached, wrong theories
    ├── bonds.md                     people, places and factions their PC cares about (links to codex)
    └── notes/                       anything else they keep
```

No deeper nesting than shown. Grouping beyond folders is by front matter and **tags**, which
carry more retrieval weight than folders once a campaign is long (60+ sessions).

## 3. Front matter (every page)

```yaml
type: status | revelation | prep | hook | lore | arc | session | timeline | codex | profile | goal | journal | knowledge | bonds | note
kind: npc | pc | place | region | organization | trade-route | family | creature | race | item | quest | map | topic   # codex only
level: party | broker | dm | classified      # who may read it; "> [!secret]" blocks inside are always dm
entity: <library page id>                     # codex: the source page this remembers (stable key)
aliases: []                                   # other names, used to find the page again
player: <account id>                          # players/ pages and player-specific notes
arc: <NN-slug>                                # sessions, summaries, hooks, revelations
heat: on | ongoing | simmering | sleeping     # goals, hooks, threads
status: draft | approved                      # Minerva writes drafts; the DM approves
tags: []
updated: YYYY-MM-DD
sources: []                                   # library page ids / session ids it came from
```

## 4. Rules Minerva follows

1. **Accrete, never re-create.** Before writing about an entity, find its page: by `entity`
   (library page id), then by name and `aliases` (`who_is`). Add to it: a dated line under
   `## Appearances` (with the session link), changes under `## What changed`, secrets in a
   `> [!secret]` block. A new page only when none exists.
2. **Promote NPCs (and places, items) when they matter:** seen in 3+ sessions, tied to an
   active thread, hook or revelation, or bonded to a PC. Until then they live as mentions in
   session pages and the status doc. Promotion is a draft the DM approves.
3. **The status doc first.** After every session, propose an update to `Campaign Status.md`
   (a diff for the DM to approve). Never let it go stale; never replace it with the archive.
4. **Revelations:** every mystery has a conclusion, at least three clues, and for each clue
   who found it and when. A PC's `knowledge.md` is built from these (party level for them).
   The broker only ever uses what that PC's `knowledge.md` and party pages say.
5. **Arcs keep volume readable:** sessions file under the current arc; at the end of an arc
   write its one-page summary. Read summaries, not logs, unless asked.
6. **Whose is it?** About one player → their root (or `dm/players/<id>.md` if it's the DM's
   view of them). Shared world → `codex/` or `chronicle/`. The DM's plans → `dm/`. Something one
   player says about another goes in the teller's root. Can't tell → ask the DM.
7. **Two tiers.** Short-term: session transcripts, the session's log, the broker's
   conversations, quick captures. Long-term: everything above, written as drafts and approved.
8. **Never** put classified text in any model request (Alexandria refuses it anyway), never
   copy a source page's body (link it), never write to a source except through WorldLore when
   the DM has set it up.

## 5. Who sees what

| Path | DM | That player | Other players | Broker answers |
|---|---|---|---|---|
| `dm/**` | yes | never | never | never |
| `chronicle/**` | yes | party-level parts | party-level parts | party-level parts |
| `codex/**` | yes | party-level parts | party-level parts | broker-level and below |
| `players/<id>/**` | yes | yes (party level) | only `profile.md` "Shared with the party" | that player only |
| `> [!secret]` blocks anywhere | yes | never | never | never |
| `level: classified` | yes | never | never | never, and never sent to any model |

Per-player visibility uses Alexandria's existing rules (levels, player copies, source keys,
shares). Leak checks cover every path above.

## 6. Retrieval order (long campaigns)

1. `dm/state/Campaign Status.md` (DM) or the player's `knowledge.md` + `goals/` (player)
2. The active arc's `summary.md` and the last session page
3. Codex pages for the entities in play (by `entity`, aliases, tags)
4. Story bible facts and smart connections (permission-filtered)
5. Raw session logs and source pages, only when the above don't answer

## 7. Tools (same shape as the LLMWIKI bridge)

| Tool | DM harness (Minerva) | Player harness (the broker) |
|---|---|---|
| `context_for(who)` | player, NPC, place or arc: everything | the asking player only, their view |
| `who_is(name)` | name, alias, character or mic speaker → player id or codex page | players and party-level entities |
| `memory_log(text, about?)` | append to the session page / status inbox | append to that player's journal |
| `memory_capture(text, about?)` | quick capture to the right inbox | to their own notes |
| `conversation_log(lines)` | file a transcript by speaker into each player's journal and the session page | — |
| `status_update(diff)` | draft a Campaign Status change | — |
| `revelation_mark(mystery, clue, player)` | record who found which clue | — |
| `codex_upsert(entity, section, text)` | accrete to a codex page (create only if missing) | — |
| `promote(name, kind)` | draft a new codex page from mentions | — |
| `arc_close(arc)` | draft the arc summary | — |
| `goal_update(player, goal, heat?, text?)` | any player | their own goals |

Writes are drafts (`status: draft`) on the DM's approval list unless the DM turned on
auto-approve for that tool.

## 8. After each session

1. The session log (existing feature) becomes `chronicle/arcs/<arc>/sessions/session-<n>.md`.
2. Minerva drafts: the status doc diff, codex accretions and promotions, revelation marks,
   each player's journal entry and knowledge update, hook and goal heat changes.
3. The DM approves, edits or rejects each on one review page.

## 9. Obsidian and the `dnd` branch

The `dnd` branch of LLM-will-remember-this is the same layout as an Obsidian vault with
dashboards (Dataview), templates and this constitution as `schema/agents.md`. Alexandria can
export `Minerva/` to such a folder and import it back (a private copy: the public branch holds
only a made-up example world, never real campaign content).

## 10. Decisions made while building

- **Decision: the vault is always in the library under `Minerva/`.** If WorldLore points at a source (LegendKeeper, Kanka, Markdown), Minerva still keeps her vault in the library: a source root cannot hold per-player levels or this layout. WorldLore is not touched.
- **Decision: vault pages are stored DM-only (or broker, classified) in the library, never party.** The vault level in front matter (`level`) says who may read; a party-level vault page in the library would show its path (`Minerva/...`) to players. Players read the party-level parts through neutral routes (`/minerva/me`, shown as "My journal"), which serve the library's own player copy (secret blocks cut out). No share rows are used.
- **Decision: "Shared with the party" is its own page** (`players/<id>/shared.md`, level party), because one page cannot have two reader sets. Players add to it through the journal page; it waits for the DM like every player write.
- **Decision: new codex pages start at `dm` level** (PCs at party); the DM opens them with `PUT /minerva/page {level}`. Session and arc pages are party, with the DM's notes and log in `> [!secret]` blocks.
- **Decision: player tool names** are `my_context`, `my_who_is`, `my_memory_log`, `my_memory_capture`, `my_goal_update` (a tool cannot be both a write and a read). They are not write tools, so they never become agent pending actions; they create drafts on the review page, applied at once when the tool is on the auto-approve list. Extras: `revelation_create`, `arc_start`.
- **Decision: a mystery's title is shown to a player who found one of its clues**; name mysteries as questions. A conclusion reaches a player only when the DM marks them `reached`.
- **Decision: the leak checks count party-level vault text as party text** (`features/minerva/partyText.ts`), so the broker may repeat it and the session log check does not flag it.
- **Decision: the status doc has an extra `Inbox` section** for `memory_capture`.
