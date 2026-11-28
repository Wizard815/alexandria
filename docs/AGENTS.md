# Agents in Alexandria: the integration plan

Two agents share one chat model and one set of tools (`features/agent`):

- **Minerva**, the GM's assistant. She sees everything the GM sees (never classified text). She has two modes.
- **The broker**, the players' assistant, in the information broker's name and voice. It sees only what that player may see. Players never meet Minerva: the word does not appear on any player screen, route, event or reply, and anything Minerva changes at the table shows up as an ordinary table change.

Everything below is built unless it says *planned*.

## 1. Minerva's two modes

| | Assistant (default) | Active |
|---|---|---|
| Acts | only when the GM asks: chat, a voice command, a macro | also by herself, from the live transcript, while a session records |
| Writes | proposed, the GM confirms (or the tool is on auto-approve) | per category: **auto**, **ask**, **off** |

**Chat modes.** The GM's chat has a switch in its header (desktop panel, pop-out window, side screen and the phone's Ask tab): **Ask first** (every change is a card with Approve / Reject) or **Auto** (changes are applied at once and shown as "Applied automatically" cards). It is the world setting `agentAuto`, GM only, shared live between screens and read at every tool call, so it applies to the very next action. Deleting, publishing, recording start/stop, broker deals, page saves and the like (`ALWAYS_ASK` in `features/agent/auto.ts`) always wait for a card, in Auto too. Approving answers at once: a change that needs a model (a statblock, a generator) runs at the GM's priority and answers "running" after 1.5 s, and the card finishes by itself.
| Switch | GM top bar badge (desktop and phone), Active page, per recording, macro action *Minerva: active on/off*, `/active`, `/assistant`, "Minerva, active" | |

**Wake word** (default "Minerva", configurable): "Minerva, play something tense" or "Minerva, run Ambush at the docks", spoken on the **GM's own mic** (a player's mic, a room mic, or a line a player's mic also picked up never counts). It is a direct request in either mode: it runs at once, whatever the category says, except that stage cards still only show party-level pages. Anything the rules cannot do goes to the chat model as a task and comes back as proposals. A line recognised as a wake command is taken out of the players' transcript at once (marked GM-only), so players do not read "Minerva, ..." in it. **Microphones:** Active mode needs to know who spoke, and a room mic ("always on", the default for a GM's table mic) names no speaker, so by default it is not read. Either give the GM a personal mic, or tick *The room mic counts as my voice* on the Active page (then players' words picked up by that mic can set things off too; the wake word never counts from a room mic).

**Typed or spoken commands** (Minerva chat, after the wake word, or the macro action *Minerva: command*):

- `/takeover`: every category to auto (notes stay drafts); again puts the old settings back.
- `/takeover-1` *Mood only*, `/takeover-2` *Combat helper*, `/takeover-3` *Full takeover*; `/takeover-save <n> [name]` saves the current settings as preset *n*.
- `/auto <music|sfx|stage|events|combat|monsters|items|clock> on|off|ask`.

**Approvals.** A waiting card can be **edited** before it is approved (*Edit*: the tool's arguments as JSON, checked against the tool's schema by the server, `PATCH /api/worlds/:w/agent/actions/:id { args }`; the card's words follow the change). Two or more waiting cards get **Approve all / Reject all**, which decide them oldest first, one after another, so "add the ogre" runs before "damage the ogre". **Always allow** on a card approves it and adds that tool to the world's `agentAutoApprove` list, so it runs without a card from then on, in Ask first too; the list shows under the mode switch (*Runs without asking*) with a × to ask first again. Tools that always ask never offer it. The folded assistant's dock button shows how many changes wait.

**Tool calls from local models** (`features/agent/toolargs.ts`). Arguments are repaired when it is safe: a code fence, a trailing comma or text around the JSON object, a number sent as `"5"`, `"true"`, an enum value in the wrong case, a list or object sent as JSON text, `null` for an optional field. Otherwise the model is told exactly what is wrong (*Not proposed: hp must be a number*) before anything runs or becomes a card, so a card the GM approves never fails on a typo. A tool name that does not exist gets the nearest real ones (*Did you mean "search_library"?*). The same change proposed twice in one chat (a model that repeats itself, two parallel calls) stays one card.

## 2. What she does by herself (Active mode)

How a line is read: a rules pass (regex cues, under 50 ms) finds candidate actions with a confidence; the audit model (temperature 0, JSON) confirms the unsure ones and reads narration the rules cannot; the chat model is used only for multi-step requests (wake commands, macros). Lines are processed in batches after about 0.7 s.

| Category | Examples heard | Tool | Default | Reversible | Safety rule |
|---|---|---|---|---|---|
| Music and ambience | "Music: something tense", "rain begins to fall", "the tavern goes quiet" | `play_music`, `play_ambience`, `stop_music` | auto | yes (previous track or layers restored) | table speakers only; never restarts the same mood within 3 minutes; GM asides may set it |
| Sound effects | "a door creaks open", "thunder rolls" | `play_sfx` | auto | no (a played sound), marked as such | only if the sound library has a match |
| Stage | "Show them the map of the docks" | `show_on_stage` | ask | yes (card hidden) | **only pages players can already open (player copy); never GM-only, broker, classified; never from a GM aside**, on auto too |
| Quick events | "make a DC 14 dexterity save", "everyone roll perception" | `send_quick_event` | ask | yes (cancelled) | |
| Combat tracker | "roll initiative", "the ogre takes 12", "Tomas is poisoned", "heal Tomas for 4", "next turn", "the fight is over", a player's "I rolled a 17", "Tomas gains 8 temporary hit points", "Ilsa loses concentration", "Tomas rolls a 14 on his death save", "stunned until the end of his next turn" | `set_combat`, `damage_combatant`, `heal_combatant`, `set_conditions`, `next_turn`, `set_initiative`, `give_temp_hp`, `set_concentration`, `concentration_save`, `death_save` | auto | yes (exact hit points, temp HP, concentration, death saves and conditions put back) | damage comes from the GM's voice only; an ambiguous name ("the goblin" with two goblins) is not guessed |
| Monsters in and out | "two goblins burst out of the reeds", "the ogre dies" | `add_combatant`, `remove_combatant` | ask | yes | player characters are never removed |
| Items and coins | "you find a silver key", "give Tom 50 gold" | `add_item`, `add_coin` | ask | yes | a player saying "I drink the potion" is always a confirm card, never auto |
| Clock and rests | "you take a long rest", "three hours pass" | `advance_world_time` | ask | yes (clock log undo) | |
| Notes, clues, NPCs | a clue found, an NPC named twice, a promise | Review drafts | draft | n/a | never applied by themselves |

**Never from Active mode, in any setting:** deleting anything, ending a session, stopping a recording, publishing, broker deals, writing pages, anything a model suggests that is not in the table above (tool allowlist). **Always:** classified text is never read; a line with any classified text is skipped whole. A GM-aside line may only set the music or the tracker. A player's words can only set off their own initiative roll and their own item use (as a card). An unsure cue with no model to settle it becomes a card, not an action. At most 14 automatic actions a minute; the rest wait for a tap. Repeats from the speech model are de-duplicated per action (the same hit is never applied twice).

## 2b. Minerva's thoughts

A floating window for the GM (the brain button in the dock) that says what the assistant is doing and why, live. It opens by itself when Active mode or Auto is switched on; closed while that mode is on, it stays closed until the mode changes. Like the transcript island it can be dragged by its header, locked to a corner (⌖), resized and folded to its dock button; settings are per device. On a phone it is a bottom drawer.

- **Status line:** listening (with the last line heard), "Active mode is on, but nothing is recording, so I am not listening", Auto, or Assistant mode.
- **Waiting for you:** Active-mode cards (*Do it / Dismiss / Not this*, with the time left) and the chat's proposals (*Approve / Reject*). While the window is open, the old corner cards and undo toasts are not shown; the Undo is on the thought instead.
- **The feed**, grouped by request: what it heard and made of it, what the audit model said, why it acted, asked (*Sound effects is set to Ask*, *I am not sure (60%)*, *a player said it*, the rate limit) or let it go (*set to Off*, *you said "Not this" for that cue*, *already done 4 s ago*, *said in a GM aside*); for the chat, a spoken request or a macro task: what it is working on, the context it read, each look-up, the model's own words before it calls tools, each proposal or change, and how long it took. Filter: all, Active mode, or chat and tasks.

Thoughts are held in memory only (the last 120 per world; `features/active/thoughts.ts`), GM only (`GET /api/worlds/:w/active/thoughts`, the `thought` event). The command log stays the record of what was done.

## 3. The command log (both modes)

Every action Minerva takes or proposes is one row: time, mode, trigger (the transcript line and speaker, the wake phrase, a macro, chat), tool and arguments, result, who sees the effect (GM only, heard at the table, players see it), state (`done`, `undone`, `pending`, `rejected`, `dismissed`, `expired`, `failed`, `blocked`) and how fast it ran. In Assistant mode each proposal is logged when it is made and settled when the GM approves or rejects it. The GM can **undo** (where reversible; actions that cannot be undone say so), **reject** a card, or mark an automatic action **wrong**: it is undone and that cue is never acted on again in this world (listed under *Never again*, removable). Page: GM → Active mode → Log; also on the GM phone. API: `/api/worlds/:w/active/*` (GM only).

## 4. Agent macros

A macro step type **Minerva** (`minerva.run`): a prompt with `{{parameters}}` (or `{param}`), an optional tool allowlist and a mode (do it / propose). Runs from the macro UI, key bindings (web and the desktop app's global hotkeys), trigger URLs, the dock, and by voice ("Minerva, run Ambush at the docks"). It runs in its own chat, so the GM can read what happened, and appears in the command log. In *do* mode only allowlisted write tools run, and never a destructive one. Eleven templates ship (copy and edit): Start combat, End combat & loot, Ambush, Enter tavern, Long rest, Travel montage, Reveal handout, Shop open, Boss entrance, Session start recap, Session end wrap-up.

## 5. Agents for players (the broker's voice)

All read-only for the table, all built from what that player may see; writes are drafts the GM approves.

| Helper | State | How |
|---|---|---|
| Information broker (questions, quotes, deals) | built | `features/broker2` |
| Notebook: journal, goals, what I know | built | `my_context`, `my_memory_log`, `my_goal_update` |
| **Journal draft** from the table transcript (what I said, what the table heard; never a GM aside) | built | `my_journal_draft`, then `my_memory_log` saves it for approval |
| **Recap** ("catch me up") from the published session log | built | `my_recap` |
| **Rules, spell and condition helper** from the world's game module | built | `lookup_rule`, `lookup_term`, `read_term` (offered to players) |
| My inventory and coin help ("what do I carry?", "who owes whom") | planned | read tools exist (`get_inventory`, `list_transfers`); needs a phrasing pass |
| Goal reminders ("what was I trying to do?") | planned | from `my_context` goals, surfaced at the start of a session |
| Trade helper between players (draft an offer, never send one) | planned | on `sessionchat/trade` |
| Level-up helper (what do I gain at level N, from the module) | planned | `lookup_term` kind class, plus the sheet |
| Auto journal on session end (draft pushed to each player) | planned | `my_journal_draft` on `recording` stop, as a notification |

Safety: the broker never says it works for the GM, never names Minerva, and its replies pass the sentence-level leak check against all GM-only text.

## 6. What is next

1. Table chat commands (`/takeover` typed in the table chat as the GM).
2. Per-player mic attribution checks in noisy rooms (a wake word only counts when every source mic is the GM's or a room mic).
3. The planned player helpers above; first the auto journal draft on session end.
4. Active mode for the GM phone only (a phone that listens when the desktop is off).
5. More undo: sound effects (stop a long effect), clock events.

## 7. What helps the agent

See "What helps the GM agent" in MODELS.md. Recommended: set the embeddings job
to a retrieval model such as bge-m3 and leave `ALX_AGENT_OPTS` at its defaults.
Active mode scan examples (`ALX_ACTIVE_EXAMPLES=1`) are implemented and unit
tested with a fake model but were not measured on the real model: off by default.

## 8. Talking to the assistant, and how much it is given

- **Where:** the side panel on every GM page (Ctrl+K), the Ask tab on the GM phone, and a
  pop-out window (the arrow in the panel's header) for a second screen or beside other apps.
  The pop-out is the same conversation as the panel. In the installed
  [desktop app](../desktop/README.md) the pop-out can be kept always on top, and
  Ctrl+Shift+Space (Cmd on macOS) shows it from any program.
- **Voice:** the mic button beside Send records a request (up to a minute) and the world's own
  speech model (the audio job) turns it into text in the box; nothing goes to a browser or cloud
  dictation service. GM only. The wake word ("Minerva, ...") still works from the GM's mic while
  recording.
- **The live transcript:** while a session records, every message carries the newest transcript
  lines and the rules terms said in them (the same terms the transcript highlights, "counter
  spell" included), each with its one-line summary; `lookup_rule` gives the full text.
- **Context size:** set the chat job option `contextTokens` to the model's window (Discover fills
  it in). Unset is 32K, the sizes Alexandria always used: 20 transcript lines, 8 history turns,
  12,000 characters per tool result. Under 16K it gives less; 100K-400K gives 300 lines; a 1M
  model gets the whole night's transcript (3,000 lines). Every request is also fitted to the
  window: old tool results are cut down first, then the oldest history turns go.
- **Honesty:** earlier replies in the history carry a note of which tools really ran, and a reply
  that claims a change with no tool call is asked again with a tool call required.

## 9. Many people at once, and memory across the night and across sessions

- **Who can ask:** the GM and every player, each in their own chats (a player has the broker and
  the table helper). A chat is private to its owner: anyone else gets "not found". One message
  at a time per chat; different people's messages run side by side.
- **The quick helper:** above the table helper, a player has one-tap answers (my turn with their weapons,
  features and spells, sum up my sheet, what next, story so far, a quick rules question) from a small second model, the `helper` job. It keeps
  no chat: each tap is one fresh call with a short brief of what that player may see, and
  anything bigger is handed to the broker (which it can ask in the background) or the table helper. See docs/MODELS.md, "The players'
  quick helper".
- **The queue:** every model call goes through a queue per model (core/ai.ts). A local model takes
  2 at a time, a cloud one 8; the job option `maxConcurrent` changes that. Waiting calls go by
  priority: the live transcript, then the GM and Active mode, then players, then background
  work (the running summary, rules checks, Minerva's suggestions). A GM question that needs
  several model calls in a row queues each one, so players' single calls fit in between.
  Everything a world's GM asks through the API (generators, statblocks, the assistant's own
  tool calls) runs at the GM's priority; tracked jobs (imports, crawls, bulk builds) are
  background work, whoever started them.
- **GM first** (Admin → Models → GPU & queue, `PUT /api/admin/models/gm-first`): how hard the
  GM's calls push in front when players fill a model.
  - *Stop a player's request* (`preempt`, on by default): a GM call that has to wait stops the
    newest player or background call on that model. A call that has shown nothing yet goes
    back to the front of its line and runs again after the GM (at most 3 times); a player
    answer already being written ends with "Paused so the GM could go first". llama.cpp stops
    generating when the connection closes, so the slot frees at once.
  - *Slots kept for the GM* (`reserve`, 0 by default): per local model, slots only the GM may
    use; one is always left for everyone else. Match `maxConcurrent` to the server's slots
    (llama.cpp `-np`) first: with `-np 4` and `maxConcurrent: 4`, a reserve of 1 leaves 3.
  - *Players wait while the GM's request runs* (`holdPlayers`, off by default): while any GM
    call runs or waits on a local model, players and background work do not start on any
    local model. Use it when the GM's model and the players' small helper share one GPU.
- **Context per message:** each message is built fresh from the world as it is now (combat, the
  clock, the library as this person may see it, the live transcript, the session so far), so
  everyone's assistant agrees with everyone else's without sharing a conversation. Nothing a
  player is not allowed to see is ever in a player's context.
- **Auto-compaction:** a chat keeps its last turns word for word (8, more with a large
  `contextTokens`) and folds older ones into a short running summary; every request is also
  fitted to the model's window (old tool results are cut first).
- **Within a session:** the running session summary (the GM's and the players') covers the
  whole night in a few hundred words.
- **Across sessions:** when a recording stops, Minerva drafts a "Last session" update to the
  Campaign Status from the GM's running summary. Approved on her review page, it goes into every
  later message, so the next session starts from it. Publishing a session log also files the
  session under the open arc and drafts status, codex, journal and hook updates, now from the
  players' recap and the GM's running notes together.

## 10. Guides and web research

The GM's **guides** (GM → Prep → Templates & guides) tell the assistant how to do a kind of task: "Towns: research the
real town it is based on, my own lore and the towns around it". A request that matches one (its trigger words in a
request to make something, or "use guide Towns") gets the guide, and its steps run before the model is asked: the
library, neighbouring places, the exemplar pages and, when the GM turned it on for the world, **web research** of a
real-world reference (a card with the exact search words in Ask first; refused before anything is sent when a query
holds a GM-only or classified word). The chat shows "Using guide: Towns" and each step. See [TEMPLATES.md](TEMPLATES.md).

