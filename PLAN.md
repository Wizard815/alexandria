# Alexandria plan

The working plan for what comes next. It replaces `docs/PLANNED.md`, most of
which is now built: the Library, the broker, approvals, giving, offline mode.
Each section says what to build, how, and what "done" means.

**Rules that apply to everything below:**
- **Players never see DM-only content.**
  - Every new feature that can show text to players runs the leak check: no
    DM-only line may appear in anything a player receives.
  - Every feature gets a test that proves it.
  - When unsure, it stays DM-only.
- **The gateway owns the data.** Pages, audio, transcripts, uploads, settings
  and logs live in the Alexandria gateway's storage, and the backup covers
  all of it.
- **Sources are pluggable.** Nothing assumes LegendKeeper or Kanka. A feature
  uses what the connected sources provide and quietly does without what they
  don't.

---

## 0. Order of work

| Phase | What | Why first |
|---|---|---|
| 1 | Broker rules: auto-delivery, world-only scope, "Other", source link (§1) | Small, finishes the broker |
| 2 | Item cards linked to library pages (§2) | Small, high value at the table |
| 3 | Intake capabilities: relations, timelines, maps, calendars, push API (§9) | Later features read from it |
| 4 | DM agent with MCP tools, statblocks, combat (§6) | Needed by §7 and §8 |
| 5 | Audio capture, live transcript, storage (§3) | Biggest piece; needs the gateway services |
| 6 | Floating transcript island and game modules (§4) | Uses §3 |
| 7 | Session log: summary, DM review, publish (§8) | Uses §3 and §6 |
| 8 | Soundboard, music board, Spotify (§5) | Independent; can run in parallel with 5–7 |
| 9 | Text to speech with presets (§7) | Small once §3's audio output exists |

---

## 1. Information broker: finishing touches

### 1.1 Auto-delivery per tier
Today every answer waits until its in-game time is up and the DM can step in.
Add a delivery mode per tier in **World settings → Broker**:

| Tier | Modes | Default |
|---|---|---|
| Common knowledge | Auto / DM reviews | Auto |
| Local lore | Auto / DM reviews | Auto |
| Deep lore | Auto / DM reviews | DM reviews |
| Other (rules, items) | Auto / DM reviews | Auto |
| Guarded secrets | **Always DM**; cannot be changed | DM |

- **Auto:** the answer is delivered when its wait is over, with no DM step.
  The DM still sees it in Questions and can correct or refund it afterwards.
- **DM reviews:** it waits in Questions until the DM approves, edits or refuses.
- **"Auto for all tiers"** sets every tier except Guarded secrets to Auto.
- **Done:** tests for both modes; a guarded question is never auto-delivered,
  whatever the settings.

### 1.2 Lock the broker to the world
The broker answers only questions about **the world**. It treats as in scope:
- the world's places, people, history, factions, items and events
- the real-world culture and history the world is built on, which the DM lists
  in settings, for example "Feudal Japan: history, folklore, customs"

Anything else (homework, other games, real-world news) gets an in-character
refusal ("That's not something I deal in.") and costs nothing.

### 1.3 "Other": free questions
A category for questions that are about the game rather than the world:
- **Rules:** "How does grappling work?" Answered from the game module (§4.3),
  such as the D&D 5e SRD, never from memory.
- **Items:** "What does my lantern do?" Answered from the item's own card and
  its linked library page (§2), for items the player can see.

These are free and delivered at once. If there is no rules source for a rules
question, it says so; it does not guess.

### 1.4 Link to the world's site
- **World settings → Broker:** an optional "World site" link and label, e.g.
  the campaign's LegendKeeper or Kanka page.
- When set, the broker page shows it as a small link spot with no comment
  about it.
- When it's empty, nothing shows.

### 1.5 How questions are judged (the "small decision model")
The goal is that "Who is the BBEG?" never gets an answer. Layers, from the
strongest:

1. **The answering model never sees DM content.**
   - Player answers are built only from player copies and DM-written broker
     notes.
   - A model can't leak what it was never given. This is the real protection,
     and it already holds.
2. **The rule-based check that exists today** compares the question with the
   DM copy.
   - It flags questions whose best match is DM-only text, a DM-only page, or a
     "never sell" page.
   - Flagged questions go to the DM.
3. **New: a small routing model** (a local 3–8B model through Ollama, or a
   small hosted model) labels each question with:
   - `scope`: world / real-world-allowed / rules / item / off-topic
   - `intent`: fact / spoiler-seeking / meta-gaming (e.g. "who is the
     villain", "what's the twist", "what's behind the door", "how many HP
     does it have")
   - `type`: who / where / when / why / how / price
   - its confidence

   The model only routes:
   - spoiler-seeking or meta-gaming questions go to Guarded secrets (the DM
     decides)
   - off-topic questions are refused
   - when it isn't sure, the question goes to the DM

   It never decides to reveal anything, and it has no access to DM text.
4. **DM spoiler tags.**
   - The DM marks pages or topics as spoilers, e.g. the villain's page, or
     "the Heart's true owner".
   - Questions that name them are always Guarded, whatever the model says.
5. **A final output check.** Before any answer is delivered, it is compared
   with all DM-only text. Any overlap blocks it and sends it to the DM. This
   leak check exists today; it stays on every path.

**Why this way:** a model told "don't reveal secrets" while holding the
secrets can be talked into revealing them. Keeping DM text out of its input
means there's nothing to talk it out of. The small model is cheap and fast,
and it only chooses between "answer", "ask the DM" and "refuse".

**Done:** a test set of at least 40 questions, including villain, twist,
stats and off-topic questions, where no player-facing output contains DM-only
text and every spoiler question goes to the DM.

---

## 2. Item cards linked to library pages

- **Linking:** an item can link to a library page from any source. The
  item's edit form searches pages by title. Links to LegendKeeper or Kanka
  pages resolve to the synced copy.
- **The card shows:**
  - name, picture, quantity, weight, owner and notes
  - from the linked page: its sidebar facts and opening section, with
    "Open page"
- **Players see only the player copy.**
  - If the linked page is DM-only, players see the item's own notes and
    nothing from the page.
  - The DM sees everything, with secrets marked.
- **Opening it:**
  - **Mouse:** hover over the item for 3 seconds and the card pops out next
    to it. The pointer can move into the card, and the card scrolls when it
    is long. It closes when the pointer leaves both the item and the card,
    or with Esc.
  - **Touch:** an ⓘ button on each item opens the same card as a bottom sheet.
  - **Keyboard:** focus the item and press Enter.
- **Delay:** 3 seconds, a per-user setting from 0.5 to 5 seconds.
- **Updates:** when the source page changes on sync, the card shows the new
  text. Nothing is copied into the item.
- **Done:**
  - works on the inventory, party, approvals and broker screens
  - a test that a link to a DM-only page shows no page text to players

---

## 3. Audio capture and live transcript

### 3.1 Who records what
- **DM:**
  - one or more microphones, e.g. a table mic and a headset, each with a name
  - one or more outputs: table speakers for music, the DM's headphones for
    previews
- **Players:** one microphone each, from their browser or phone.
- **Every mic is its own track.** That tells the transcript who is speaking
  without guessing. The DM can label a shared table mic "Table".
- **How it connects:**
  - Browsers record with `MediaRecorder` and send Opus chunks (5–10 s) to the
    gateway over HTTPS.
  - The DM's extra mics are chosen in **Audio setup**, which lists each input
    device.
  - Later, a desktop scribe app can capture more devices at once.

### 3.2 Consent and privacy (required)
- **Each player agrees to recording once per world,** and can stop at any
  time. Without consent, their mic is never captured.
- **A clear "Recording" indicator** shows on every screen while a session
  records.
- **DM aside:** a hold-to-talk switch that keeps a stretch of DM speech out of
  the players' transcript, for spoken secrets.
  - Aside segments are DM-only, like a secret block.
  - The session summary (§8) treats them as DM-only.
- **Retention:** the DM sets how long raw audio is kept (e.g. 30 days).
  Transcripts are kept until deleted.
- Recording laws differ by place. The consent step exists so everyone at the
  table agrees.

### 3.3 Speech to text
- **A transcription service runs next to the gateway** as its own container.
  Two options:
  - local: faster-whisper or whisper.cpp
  - hosted: any OpenAI-compatible `/v1/audio/transcriptions` endpoint
- **Live:** each chunk is transcribed as it arrives and shown within a few
  seconds.
- **After the session:** a second, more accurate pass over the whole
  recording replaces the live text in the session record.
- **Word lists:** names from the library (titles and aliases) and from the
  game module are sent as hints, so "Velmira" and "Saltmarsh" come out right.

### 3.4 Storage
- **Audio** is stored as files under `ALX_DATA_DIR/audio/<world>/<session>/`.
  Large files don't belong in SQLite.
- **Transcript segments** are stored in the database: session, speaker, mic,
  start and end, text, aside flag and revision.
- **Backups cover everything:**
  - the admin backup downloads one archive: the database plus `audio/` and
    `uploads/`
  - `deploy/backup.sh` keeps the archives
- **Done:**
  - two-tab test: DM and player mics produce one transcript with the right
    speakers
  - aside segments never reach a player
  - backup and restore round-trip

---

## 4. Floating transcript island

### 4.1 The island
- **A small floating window that follows every page,** for the DM and the
  players. It shows the live transcript as word bubbles, newest at the
  bottom, with the speaker's name or colour.
- **Its controls are per person and remembered on that device:**
  - drag it anywhere, or lock it to a corner
  - resize it
  - opacity from 20% to 100%, where 100% is fully solid
  - bubble colour and text size
  - minimise it to a pill showing the last line
- **Players see only the player transcript.** The DM sees everything, with
  asides marked.

### 4.2 Highlighted key words
Words from the game module and the world are highlighted in the bubbles:
- spells, conditions, monsters and rules terms
- library page titles

Hovering over a highlighted word shows the same card as §2, for library pages
or the module's entry. That uses the same rules: players see only player
copies.

### 4.3 Game modules
- **The DM picks one per world in World settings,** e.g. **D&D 5e SRD (5.1 or
  5.2)**. Those are available under CC-BY-4.0.
- **A module is a package:**
  - a glossary: term, kind and short text
  - optional rules sections for the broker's "Other" answers (§1.3)
  - an optional statblock format for the DM agent (§6)
- **Modules are imported like sources:** a folder, a git repo or a JSON API.
  Other systems can be added the same way.

---

## 5. Soundboard and music board (DM)

### 5.1 Soundboard
- A grid of effect pads: door creak, thunder, sword clash. Each pad has its
  own volume, loop option and optional key shortcut.
- Sounds are uploaded to the gateway and grouped into banks.
- Each pad can play on:
  - the DM's chosen output (the table)
  - each player's device, for remote players
  - both

### 5.2 Music board: local files
The music library is a **folder tree on the gateway**:

```
music/
  village/            ← area or setting (top-level folder = type)
    market/           ← sub-genre for finer themes
  dungeon/
  demon/
  combat/
```

**The mood map:**
- **A square with four corners:** Combat, Tense, Sneaky and Calm.
  - Each track has a spot on it.
  - The DM drags a marker. The board plays the nearest tracks from the
    chosen area and crossfades when the marker moves to a new region.
- **A track's spot comes from one of:**
  - its folder name (e.g. `combat/` sits in the Combat corner)
  - a `moods.yaml` next to the files
  - the DM dragging tracks onto the map
- **Area chips** (village, dungeon, demon…) narrow which tracks it picks.
- **A simple picker** (folders, then tracks, then play) sits next to the
  map, for when you just want a song.
- **Where the music plays:** on the DM's table output, and optionally
  streamed to remote players through the gateway.

### 5.3 Spotify (simple)
- The DM connects a Spotify account in settings, using Spotify's own sign-in.
- The DM maps **events to playlists**, e.g. Combat → "Boss Fights" and
  Tavern → "Folk".
- Picking an event plays a matching playlist on the DM's Spotify device.
- **Limits:**
  - It needs Spotify Premium, and only plays on the DM's own Spotify devices.
  - Spotify doesn't allow streaming its music to players.
  - So remote players hear only local-file music.

**Done:**
- the mood map moves between tracks with crossfades
- the soundboard plays on the table output
- Spotify event mapping starts the right playlist

---

## 6. DM agent (LLM)

A chat panel for the DM, available on every DM page, connected to everything
the DM can see and do.

### 6.1 What it can use
- **Alexandria's MCP tools with the DM's write key:** library, people,
  calendar, inventory, coin, quick events, broker, approvals. Add new tools
  for:
  - combat: read initiative, turn, HP, effects; add a combatant with a
    statblock; apply damage or conditions
  - the live transcript
  - the session log
  - the soundboard and music
  - text to speech
- **The world's own sources through their MCP servers,** e.g. LegendKeeper
  and Kanka.
  - Read-only by default.
  - Writing back to a source is a separate, off-by-default switch per source.
- **The game module (§4.3),** for rules and statblock formats.

### 6.2 What it does
- **Answers live questions** ("What did Velmira say last session?", "What's
  the DC for this?"), citing the page or transcript it used.
- **Builds statblocks** from a prompt or a library page, in the module's
  format.
  - Statblocks are saved to the library.
  - "Add to combat" puts the creature in initiative with its HP and AC.
- **Reads combat:** whose turn it is, HP, effects and concentration, and
  suggests monster actions.
- **Drafts and revises the session summary** with the DM (§8).

### 6.3 Safety
- Any action that changes something shows what it will do, and the DM
  confirms it. A DM setting can auto-approve read-only actions.
- Every tool call is in the world's audit log.
- **Models:**
  - one configured for the DM agent (a strong model, hosted or local)
  - a separate small one for routing (§1.5)
  - both through the existing `/v1` model gateway

**Done:**
- the agent makes a statblock from a page and adds it to combat
- it answers from the transcript with a citation
- every write is confirmed and audited

---

## 7. Text to speech

- **Highlight text anywhere in the DM's view, right-click and choose Speak.**
  This works on library pages, the agent's replies and the transcript.
- **A small menu picks a preset:** narrator, old man, villain…
- **Presets live in World settings → Voice:**
  - voice, speed and pitch
  - an effect: none, echo or radio
  - where it plays: table output, players' devices, or both
- **Speech is made by Kokoro** (open model, runs as a small container with an
  OpenAI-compatible `/v1/audio/speech` endpoint), or any compatible TTS
  endpoint.
- **What it reads:** only the highlighted text. If it contains DM-only text
  and is sent to players' devices, the DM is asked to confirm first.

---

## 8. Session log

- **A Session log page for players and the DM,** one entry per session.
- **After a session the agent drafts a summary** from:
  - the transcript (without asides)
  - combat results, loot and coin changes
  - broker purchases and quick events
- **The DM reviews the draft before anyone else sees it.** The DM can:
  - edit it by hand
  - ask the agent to change it ("Add that they found the map", "Remove the
    part about the door")
  - mix both
- **Approve publishes it to players.**
  - Before publishing, the leak check compares it with DM-only text and with
    asides, and shows any overlap.
  - Versions are kept. The DM can un-publish or revise later.
- **Players see only approved summaries.** The DM sees drafts too.

**Done:**
- a draft is created from a recorded test session
- an aside line in the transcript is caught by the leak check
- a published summary appears for players and offline

---

## 9. Intake: everything is a connector

Alexandria takes whatever a source offers and uses only that.

### 9.1 Capabilities
- **Each connector declares what it provides:**
  - `pages`, `properties`, `tags`, `images`
  - `relations`, `timelines`, `maps`, `calendars`
  - `items`, `characters`, `statblocks`
  - `modules` (glossaries, rules)
- **Features read from the capabilities:**
  - The **Relations** page shows relations from any source that has them
    (Kanka does; LegendKeeper doesn't), plus ones the DM adds by hand.
  - If no source has timelines, the timeline view shows only the DM's own
    events.
  - A missing capability never causes an error. The feature shows what it
    has.
- **To build:**
  - Kanka relations, timelines, calendars and map markers
  - LegendKeeper maps, timelines and boards (as pages with their own block
    kinds)
  - the visibility rules for each, written fail-closed

### 9.2 Push intake API
For tools that can't be polled, a DM or admin creates a **source key**, and
the tool pushes entries to `POST /api/intake/<source>/entries`.
- Entries use the same entry format as connectors (`docs/CONNECTORS.md`).
- They go through the same leak guard.
- The key can only write to that one source.
- Webhooks from apps that send them, such as a git push, trigger a sync.

### 9.3 Modules as sources
Game modules (§4.3), music folders (§5.2) and sound banks (§5.1) are imported
with the same connector system and run log.

---

## 10. Settings this adds

- **World settings:**
  - Broker: per-tier delivery mode, allowed real-world topics, spoiler topics,
    world site link
  - Game module
  - Recording: consent text, raw-audio retention, who can see the live
    transcript
  - Voice presets
  - Music folders and Spotify account
- **Per person, on their device:** transcript island position, size,
  opacity and colour; item card hover delay.
- **Server (admin):**
  - transcription endpoint
  - TTS endpoint
  - routing model and DM agent model
  - storage limits for audio
- New settings that change behaviour get a short guide in `docs/` with a
  working example. Docker examples go in `deploy/examples/`: whisper,
  Kokoro and Ollama next to the gateway.

---

## Open questions for the DM

1. **Live transcript for players:** should players see the live transcript
   during play, or only the approved session summary afterwards?
2. **Remote players and music:** should local-file music stream to remote
   players by default, or only when the DM turns it on?
3. **Rules module:** start with D&D 5e SRD 5.1 or 5.2?
4. **Routing model:** run it locally with Ollama, or use a hosted model?
