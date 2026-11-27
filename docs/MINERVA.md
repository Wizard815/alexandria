# Minerva: the GM's agent and her campaign memory

Minerva (goddess of wisdom) is the GM's assistant. She prepares sessions, keeps the
campaign's long-term state, remembers every player's goals, ideas and history, and helps at
the table. **Players never meet her.** To them she is the information broker: the player
harness, the broker's name and voice. She never says or hints that she is Minerva, that she
serves the GM, or what she remembers about them.

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
│   │                                This is what gets read. A "> [!secret]" block holds the GM's view.
│   ├── arcs/<NN-slug>/sessions/session-<n>.md
│   │                                the session's log and recap (from the session log feature);
│   │                                archived and linked, rarely opened directly
│   ├── timeline.md                  in-world history: eras and events, linked to source timelines
│   └── calendar.md                  index of the sessions calendar and the world date
├── codex/                           one page per entity, then it ACCRETES; never re-created
│   ├── characters/pc/<name>.md      level party; "> [!secret]" for the GM's notes
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
status: draft | approved                      # Minerva writes drafts; the GM approves
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
   session pages and the status doc. Promotion is a draft the GM approves.
3. **The status doc first.** After every session, propose an update to `Campaign Status.md`
   (a diff for the GM to approve). Never let it go stale; never replace it with the archive.
4. **Revelations:** every mystery has a conclusion, at least three clues, and for each clue
   who found it and when. A PC's `knowledge.md` is built from these (party level for them).
   The broker only ever uses what that PC's `knowledge.md` and party pages say.
5. **Arcs keep volume readable:** sessions file under the current arc; at the end of an arc
   write its one-page summary. Read summaries, not logs, unless asked.
6. **Whose is it?** About one player → their root (or `dm/players/<id>.md` if it's the GM's
   view of them). Shared world → `codex/` or `chronicle/`. The GM's plans → `dm/`. Something one
   player says about another goes in the teller's root. Can't tell → ask the GM.
7. **Two tiers.** Short-term: session transcripts, the session's log, the broker's
   conversations, quick captures. Long-term: everything above, written as drafts and approved.
8. **Never** put classified text in any model request (Alexandria refuses it anyway), never
   copy a source page's body (link it), never write to a source except through WorldLore when
   the GM has set it up.

## 5. Who sees what

| Path | GM | That player | Other players | Broker answers |
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

1. `dm/state/Campaign Status.md` (GM) or the player's `knowledge.md` + `goals/` (player)
2. The active arc's `summary.md` and the last session page
3. Codex pages for the entities in play (by `entity`, aliases, tags)
4. Story bible facts and smart connections (permission-filtered)
5. Raw session logs and source pages, only when the above don't answer

## 7. Tools (same shape as the LLMWIKI bridge)

| Tool | GM harness (Minerva) | Player harness (the broker) |
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

Writes are drafts (`status: draft`) on the GM's approval list unless the GM turned on
auto-approve for that tool.

## 8. After each session

1. The session log (existing feature) becomes `chronicle/arcs/<arc>/sessions/session-<n>.md`.
2. Minerva drafts: the status doc diff, codex accretions and promotions, revelation marks,
   each player's journal entry and knowledge update, hook and goal heat changes.
3. The GM approves, edits or rejects each on one review page.

The drafts follow a few rules: a status section is added to, never replaced; a hook or goal that
came up in the session is never cooled (it is raised to `on`); a promotion is drafted only for
people the session named (the recap, the GM's notes, the log, what was said), including people met
for the first time; and the session number is the session record's number, or the number the table
gave the recording ("Session 22").

### Live help

While a session records, the GM's agent is given the last 20 GM-visible transcript lines (the
player assistant gets the players' lines only; classified text is left out of both). A light
background pass, at most every two minutes or after 30 new lines, reads the new lines and drafts
low-priority **suggestions** into the review queue: a clue the table seems to have found
(`revelation_mark`), a new NPC named twice (a promotion draft), a promise (a goal). They sort
below every other draft and nothing is applied until the GM approves it. The GM's button is
`POST /minerva/live/suggest`.

### Writes never put the GM's analysis in front of the players

`codex_upsert` on a page the players can open (a player character's page is party level) writes in
a `> [!secret]` block, which the players' copy leaves out, unless the GM said the text is for them
(`visible: true`). The approval card says where the text lands: "Visible to players (level party)"
in red, or "GM-only block on a level party page".

## 9. Obsidian and the `dnd` branch

The `dnd` branch of LLM-will-remember-this is the same layout as an Obsidian vault with
dashboards (Dataview), templates and this constitution as `schema/agents.md`. Alexandria can
export `Minerva/` to such a folder and import it back (a private copy: the public branch holds
only a made-up example world, never real campaign content).

## 10. Decisions made while building

- **Decision: the vault is always in the library under `Minerva/`.** If WorldLore points at a source (LegendKeeper, Kanka, Markdown), Minerva still keeps her vault in the library: a source root cannot hold per-player levels or this layout. WorldLore is not touched.
- **Decision: vault pages are stored GM-only (or broker, classified) in the library, never party.** The vault level in front matter (`level`) says who may read; a party-level vault page in the library would show its path (`Minerva/...`) to players. Players read the party-level parts through neutral routes (`/minerva/me`, shown as "My journal"), which serve the library's own player copy (secret blocks cut out). No share rows are used.
- **Decision: "Shared with the party" is its own page** (`players/<id>/shared.md`, level party), because one page cannot have two reader sets. Players add to it through the journal page; it waits for the GM like every player write.
- **Decision: new codex pages start at `dm` level** (PCs at party); the GM opens them with `PUT /minerva/page {level}`. Session and arc pages are party, with the GM's notes and log in `> [!secret]` blocks.
- **Decision: player tool names** are `my_context`, `my_who_is`, `my_memory_log`, `my_memory_capture`, `my_goal_update` (a tool cannot be both a write and a read). They are not write tools, so they never become agent pending actions; they create drafts on the review page, applied at once when the tool is on the auto-approve list. Extras: `revelation_create`, `arc_start`.
- **Decision: a mystery's title is shown to a player who found one of its clues**; name mysteries as questions. A conclusion reaches a player only when the GM marks them `reached`.
- **Decision: the leak checks count party-level vault text as party text** (`features/minerva/partyText.ts`), so the broker may repeat it and the session log check does not flag it.
- **Decision: the status doc has an extra `Inbox` section** for `memory_capture`.

## 11. Two modes: Assistant and Active

Minerva has two modes (full plan in `docs/AGENTS.md`):

- **Assistant** (the default): she acts only when the GM asks, by chat, by voice ("Minerva, ..." on the GM's own mic) or from a macro. The live suggestion pass above still drafts into Review.
- **Active**: while a session records she reads the transcript as it settles and acts on table events by herself: music and ambience, sound effects, the stage, quick events, the combat tracker, monsters in and out, items and coins, the world clock. Each category is **auto** (done at once, with an undo toast), **ask** (a confirm card on the GM's screens, which expires) or **off**. The starting preset is music, sound effects and the tracker on auto, the rest ask. `/takeover` switches everything to auto (again to restore), `/takeover-1` to `-3` apply presets, `/auto <category> on|off|ask` changes one. Notes, clues and NPCs are always drafts.

How a line is read: rules first (regex cues, well under 50 ms), then the audit model for the unsure ones and for narration the rules cannot read (temperature 0, JSON, one batched call), the chat model only for wake-word requests the rules cannot do and for macros. Without an audit model the unsure cues become cards.

Safety (fail closed, on auto too): players only see party-level content, never GM-only, broker or classified pages; a GM aside can only set music or the tracker; a line holding classified text is skipped whole and never sent to a model; a player's words can only set off their own initiative roll or item use (as a card); nothing destructive runs from Active mode; repeats from the speech model are de-duplicated; at most 14 automatic actions a minute.

**Command log.** Every action she takes or proposes, in both modes, is one row (time, mode, trigger, tool, arguments, result, who sees it, state). The GM can undo (where it can be undone), reject a card, or mark an automatic action wrong, which undoes it and stops that cue firing again in this world. Page: GM → Active mode; the same cards and badge are on the GM phone. API: `/api/worlds/:w/active` (GM only).

**Agent macros.** A macro step type **Minerva** takes a prompt with `{{parameters}}`, an optional tool allowlist and a mode (do it / propose). Eleven templates are ready to copy. It runs from the macro page, key bindings, trigger URLs, the dock and by voice ("Minerva, run Ambush at the docks").

**Players** never see any of it. The broker persona stays; what Active mode changes shows as ordinary table changes.
